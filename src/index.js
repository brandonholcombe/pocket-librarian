import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags,
} from 'discord.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const DATA_DIR = process.env.DATA_DIR || './data-state';
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://pocket.kodloki.io';

if (!TOKEN || !APP_ID) {
  console.error('DISCORD_TOKEN and DISCORD_APP_ID are required');
  process.exit(1);
}

const GAMES = JSON.parse(
  fs.readFileSync(new URL('../data/games.json', import.meta.url), 'utf8'),
);

// ---------- state ----------
const STATE_FILE = path.join(DATA_DIR, 'library.json');
let state = { entries: [], pinnedMessageId: null };
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch { /* first boot */ }

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const entryId = (title, platform) =>
  `${platform}:${title}`.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- commands ----------
const commands = [
  new SlashCommandBuilder().setName('request')
    .setDescription('Request a game for the Pocket library')
    .addStringOption(o => o.setName('game').setDescription('Game title')
      .setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('got')
    .setDescription('Mark a requested game as purchased / in library')
    .addStringOption(o => o.setName('game').setDescription('Requested game')
      .setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('remove')
    .setDescription('Remove a game from the list entirely')
    .addStringOption(o => o.setName('game').setDescription('Game on the list')
      .setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('list')
    .setDescription('Show the current library checklist'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log('Registered guild commands');
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log('Registered global commands (may take up to an hour to appear)');
  }
}

// ---------- autocomplete ----------
function searchCatalog(query) {
  const q = query.toLowerCase().trim();
  if (!q) return GAMES.slice(0, 25).map((g, _, __) => ({ g, i: GAMES.indexOf(g) }));
  const starts = [];
  const contains = [];
  for (let i = 0; i < GAMES.length; i++) {
    const t = GAMES[i].t.toLowerCase();
    if (t.startsWith(q)) starts.push({ g: GAMES[i], i });
    else if (t.includes(q)) contains.push({ g: GAMES[i], i });
    if (starts.length >= 25) break;
  }
  return starts.concat(contains).slice(0, 25);
}

function choiceName(title, platform) {
  const name = `${title} — ${platform}`;
  return name.length > 100 ? name.slice(0, 99) + '…' : name;
}

async function handleAutocomplete(interaction) {
  const cmd = interaction.commandName;
  const query = interaction.options.getFocused().toLowerCase().trim();
  let choices;
  if (cmd === 'request') {
    choices = searchCatalog(query).map(({ g, i }) => ({
      name: choiceName(g.t, g.p),
      value: `#${i}`,
    }));
  } else {
    const pool = cmd === 'got'
      ? state.entries.filter(e => e.status === 'requested')
      : state.entries;
    choices = pool
      .filter(e => !query || e.title.toLowerCase().includes(query))
      .slice(0, 25)
      .map(e => ({ name: choiceName(e.title, e.platform), value: e.id.slice(0, 100) }));
  }
  await interaction.respond(choices);
}

// ---------- resolve a /request value into {title, platform} ----------
function resolveRequested(value) {
  const m = value.match(/^#(\d+)$/);
  if (m && GAMES[Number(m[1])]) {
    const g = GAMES[Number(m[1])];
    return { title: g.t, platform: g.p };
  }
  // Free-typed title not in the catalog
  return { title: value.trim().slice(0, 200), platform: 'Other' };
}

// ---------- checklist rendering ----------
function renderLines(entries) {
  return entries.map(e => {
    const who = e.requestedBy ? ` — ${e.requestedBy}` : '';
    return `• **${e.title}** (${e.platform})${who}`;
  });
}

function buildEmbed() {
  const owned = state.entries.filter(e => e.status === 'owned');
  const requested = state.entries.filter(e => e.status === 'requested');
  const section = (title, entries) => {
    const lines = renderLines(entries);
    let text = lines.join('\n') || '_none yet_';
    if (text.length > 1000) {
      const kept = [];
      let len = 0;
      for (const l of lines) {
        if (len + l.length > 900) break;
        kept.push(l); len += l.length + 1;
      }
      text = kept.join('\n') + `\n…and ${lines.length - kept.length} more`;
    }
    return { name: `${title} (${entries.length})`, value: text };
  };
  return new EmbedBuilder()
    .setTitle('🎮 Pocket Library Checklist')
    .setColor(0x8c52ff)
    .addFields(
      section('🎯 Requested', requested),
      section('☑ In library', owned),
    )
    .setFooter({ text: `Full list: ${PUBLIC_URL}` })
    .setTimestamp();
}

async function updatePinnedMessage(client) {
  if (!CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const embed = buildEmbed();
    let msg = null;
    if (state.pinnedMessageId) {
      msg = await channel.messages.fetch(state.pinnedMessageId).catch(() => null);
    }
    if (msg) {
      await msg.edit({ embeds: [embed] });
    } else {
      msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      state.pinnedMessageId = msg.id;
      saveState();
    }
  } catch (e) {
    console.error('pinned message update failed:', e.message);
  }
}

// ---------- command handling ----------
async function handleCommand(interaction) {
  const name = interaction.commandName;

  if (name === 'list') {
    await interaction.reply({ embeds: [buildEmbed()] });
    return;
  }

  const value = interaction.options.getString('game');

  if (name === 'request') {
    const { title, platform } = resolveRequested(value);
    const id = entryId(title, platform);
    const existing = state.entries.find(e => e.id === id);
    if (existing) {
      await interaction.reply({
        content: existing.status === 'owned'
          ? `**${title}** is already in the library ☑`
          : `**${title}** is already requested (by ${existing.requestedBy})`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    state.entries.push({
      id, title, platform,
      status: 'requested',
      requestedBy: interaction.user.displayName ?? interaction.user.username,
      requestedAt: new Date().toISOString(),
    });
    saveState();
    await interaction.reply(`🎯 Requested: **${title}** (${platform})`);
  } else if (name === 'got' || name === 'remove') {
    const entry = state.entries.find(e => e.id === value)
      ?? state.entries.find(e => e.title.toLowerCase() === value.toLowerCase().trim());
    if (!entry) {
      await interaction.reply({ content: `Couldn't find that on the list.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (name === 'got') {
      entry.status = 'owned';
      entry.gotAt = new Date().toISOString();
      saveState();
      await interaction.reply(`☑ In library: **${entry.title}** (${entry.platform})`);
    } else {
      state.entries = state.entries.filter(e => e !== entry);
      saveState();
      await interaction.reply(`🗑 Removed: **${entry.title}**`);
    }
  }
  await updatePinnedMessage(interaction.client);
}

// ---------- web ----------
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket Library</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif;
         background: #131217; color: #e8e6f0; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 1.2rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin: 1.4rem 0 .4rem;
       color: #b9aaff; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .55rem .7rem; border-radius: 8px; background: #1e1c26;
       margin-bottom: .35rem; display: flex; justify-content: space-between;
       gap: .6rem; align-items: baseline; }
  li .meta { color: #8b879c; font-size: .8rem; white-space: nowrap; }
  li.owned { opacity: .65; } li.owned .title { text-decoration: line-through; }
  .empty { color: #8b879c; padding: .4rem .7rem; }
  footer { margin-top: 2rem; color: #8b879c; font-size: .75rem; }
</style></head><body><div class="wrap">
<h1>🎮 Pocket Library</h1>
<h2>🎯 Requested</h2><ul id="requested"></ul>
<h2>☑ In library</h2><ul id="owned"></ul>
<footer>Updates live from Discord · refreshes every 30s</footer>
</div><script>
async function refresh() {
  const s = await (await fetch('/api/state')).json();
  for (const status of ['requested', 'owned']) {
    const ul = document.getElementById(status);
    const items = s.entries.filter(e => e.status === status);
    ul.innerHTML = items.length ? items.map(e =>
      '<li class="' + status + '"><span class="title">' + esc(e.title) +
      ' <span class="meta">(' + esc(e.platform) + ')</span></span>' +
      '<span class="meta">' + esc(e.requestedBy || '') + '</span></li>'
    ).join('') : '<div class="empty">none yet</div>';
  }
}
const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
refresh(); setInterval(refresh, 30000);
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ entries: state.entries }));
  } else if (req.url === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  }
}).listen(PORT, () => console.log(`web on :${PORT}`));

// ---------- boot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) await handleAutocomplete(interaction);
    else if (interaction.isChatInputCommand()) await handleCommand(interaction);
  } catch (e) {
    console.error('interaction error:', e);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}, ${GAMES.length} games in catalog`);
  await updatePinnedMessage(client);
});

await registerCommands();
await client.login(TOKEN);
