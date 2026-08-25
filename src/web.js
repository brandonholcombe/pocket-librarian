// Web side of pocket-librarian: Discord OAuth, ROM library storage,
// sync-set API, and the single-page app (served from web/app.html).
import { unzipSync } from 'fflate';
import crypto from 'node:crypto';
import { listCores, ensureCore, getInventory, coreFilePath, getFirmware } from './provision.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ID = process.env.DISCORD_APP_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const BOT_TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const ALLOWED = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// A user may log in if they're on the explicit allowlist, or (default mode)
// simply a member of the family Discord server, checked via the bot.
async function isAllowed(userId) {
  if (ALLOWED.includes(userId)) return true;
  if (!GUILD_ID || !BOT_TOKEN) return false;
  const r = await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${userId}`, {
    headers: { authorization: `Bot ${BOT_TOKEN}` },
  });
  return r.ok;
}
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://pocket.kodloki.io';
const ROMS_DIR = process.env.ROMS_DIR || './roms';
const DATA_DIR = process.env.DATA_DIR || './data-state';
const PORT = Number(process.env.PORT || 8080);

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set — sessions will reset on every restart');
}

// Platform -> folder under Assets/ on the SD card (and under ROMS_DIR here).
export const FOLDERS = {
  GB: 'gb', GBC: 'gbc', GBA: 'gba', NES: 'nes', SNES: 'snes',
  Genesis: 'genesis', PCE: 'pce', 'PCE-CD': 'pcecd', 'Sega CD': 'segacd',
  GG: 'gg', Lynx: 'lynx', NGPC: 'ngpc', Arcade: 'arcade', Other: 'other',
};

// file extension -> platform, for zip extraction
const EXT_PLATFORM = {
  gb: 'GB', gbc: 'GBC', gba: 'GBA', nes: 'NES', fds: 'NES',
  sfc: 'SNES', smc: 'SNES', md: 'Genesis', gen: 'Genesis',
  pce: 'PCE', chd: 'PCE-CD', gg: 'GG', lnx: 'Lynx', ngc: 'NGPC', ngp: 'NGPC',
};

// well-known BIOS/support files, recognized by name (extensions are ambiguous)
const SUPPORT_FILES = [
  [/^gba_bios\.bin$/i, 'GBA'], [/^lynxboot\.img$/i, 'Lynx'],
  [/^disksys\.rom$/i, 'NES'], [/^syscard.*\.pce$/i, 'PCE-CD'],
  [/^bios_cd_.*\.bin$/i, 'Sega CD'],
  [/^(dmg0?|gb|mgb)_?(bios|boot|rom)\.bin$/i, 'GB'],
  [/^(cgb|gbc)_?(bios|boot|rom)\.bin$/i, 'GBC'],
];
const supportPlatform = name => SUPPORT_FILES.find(([re]) => re.test(name))?.[1];
const PLATFORM_BY_FOLDER = Object.fromEntries(Object.entries(FOLDERS).map(([p, f]) => [f, p]));

// libretro-thumbnails system names, for boxart
const THUMB_SYS = {
  gb: 'Nintendo - Game Boy', gbc: 'Nintendo - Game Boy Color',
  gba: 'Nintendo - Game Boy Advance', nes: 'Nintendo - Nintendo Entertainment System',
  snes: 'Nintendo - Super Nintendo Entertainment System',
  genesis: 'Sega - Mega Drive - Genesis', pce: 'NEC - PC Engine - TurboGrafx 16',
  pcecd: 'NEC - PC Engine CD - TurboGrafx-CD', segacd: 'Sega - Mega-CD - Sega CD',
  gg: 'Sega - Game Gear', lynx: 'Atari - Lynx', ngpc: 'SNK - Neo Geo Pocket Color',
  arcade: 'FBNeo - Arcade Games',
};

// ---------- boxart ----------
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };
export const normTitle = s => s.toLowerCase().replace(/\.png$/, '')
  .replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '')
  .replace(/\b(ii|iii|iv|v|vi|vii|viii|ix)\b/g, m => ROMAN[m])
  .replace(/[^a-z0-9]+/g, '');
const artIndexes = new Map();   // folder -> Map(normTitle -> [full png names])
const artMisses = new Set();    // negative cache for this process

async function getArtIndex(folder) {
  if (artIndexes.has(folder)) return artIndexes.get(folder);
  const sys = THUMB_SYS[folder];
  if (!sys) return null;
  const cacheFile = path.join(DATA_DIR, 'art-index', folder + '.json');
  let names = null;
  try {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < 30 * 86400_000) names = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch { /* no cache yet */ }
  if (!names) {
    const html = await fetch(
      `https://thumbnails.libretro.com/${encodeURIComponent(sys)}/Named_Boxarts/`,
    ).then(r => (r.ok ? r.text() : null)).catch(() => null);
    if (!html) return null;
    names = [...html.matchAll(/href="([^"]+\.png)"/g)].map(m => decodeURIComponent(m[1]));
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(names));
  }
  const byNorm = new Map();
  for (const n of names) {
    const k = normTitle(n);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(n);
  }
  artIndexes.set(folder, byNorm);
  return byNorm;
}

const REGION_RANK = ['(usa', '(world', '(europe', '(japan'];
const regionRank = n => {
  const l = n.toLowerCase();
  const i = REGION_RANK.findIndex(r => l.includes(r));
  return i === -1 ? REGION_RANK.length : i;
};

async function serveArt(res, folder, title) {
  const key = `${folder}/${normTitle(title)}`;
  const cacheFile = path.join(DATA_DIR, 'art-cache', folder, normTitle(title) + '.png');
  const headers = { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' };
  if (fs.existsSync(cacheFile)) {
    res.writeHead(200, headers);
    fs.createReadStream(cacheFile).pipe(res);
    return;
  }
  if (artMisses.has(key)) { res.writeHead(404); res.end(); return; }
  const idx = await getArtIndex(folder);
  const q = normTitle(title);
  let cands = idx?.get(q);
  if (!cands?.length && idx && q.length >= 6) {
    // fuzzy fallback: containment either way, shortest (most base-game) key wins
    const fuzzy = [...idx.keys()]
      .filter(k => k.includes(q) || q.includes(k))
      .sort((a, b) => a.length - b.length)[0];
    if (fuzzy) cands = idx.get(fuzzy);
  }
  if (!cands?.length) { artMisses.add(key); res.writeHead(404); res.end(); return; }
  const name = [...cands].sort((a, b) => regionRank(a) - regionRank(b))[0];
  const img = await fetch(
    `https://thumbnails.libretro.com/${encodeURIComponent(THUMB_SYS[folder])}/Named_Boxarts/${encodeURIComponent(name)}`,
  ).catch(() => null);
  if (!img?.ok) { artMisses.add(key); res.writeHead(404); res.end(); return; }
  const buf = Buffer.from(await img.arrayBuffer());
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, buf);
  res.writeHead(200, headers);
  res.end(buf);
}

const APP_HTML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app.html'), 'utf8');

// ---------- rom index ----------
const INDEX_FILE = path.join(DATA_DIR, 'roms-index.json');
let index = { roms: {}, syncSets: {} };   // roms[id] = {platform,file,size,sha1,title,by,at}
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { /* first boot */ }

function saveIndex() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, INDEX_FILE);
}

const romId = (platform, file) => `${FOLDERS[platform] ?? 'other'}/${file}`;
const cleanTitle = f => f.replace(/\.[^.]+$/, '').replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();

async function sha1File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Pick up files added out-of-band (bulk copy into the PVC) on boot.
async function reconcile() {
  fs.mkdirSync(ROMS_DIR, { recursive: true });
  let changed = false;
  for (const folder of await fsp.readdir(ROMS_DIR).catch(() => [])) {
    const dir = path.join(ROMS_DIR, folder);
    if (!(await fsp.stat(dir)).isDirectory()) continue;
    const platform = PLATFORM_BY_FOLDER[folder] ?? 'Other';
    for (const file of await fsp.readdir(dir)) {
      const id = `${folder}/${file}`;
      if (file.endsWith('.uploading')) {
        // a completed upload renames synchronously, so any .uploading file
        // found at boot is a dead partial transfer
        await fsp.rm(path.join(dir, file), { force: true });
        delete index.roms[id];
        changed = true;
        continue;
      }
      if (index.roms[id]) continue;
      const st = await fsp.stat(path.join(dir, file));
      if (!st.isFile()) continue;
      index.roms[id] = {
        platform, file, size: st.size, sha1: null,
        title: cleanTitle(file), at: new Date().toISOString(),
      };
      changed = true;
    }
  }
  // Drop index entries whose file vanished
  for (const [id, r] of Object.entries(index.roms)) {
    if (!fs.existsSync(path.join(ROMS_DIR, id))) { delete index.roms[id]; changed = true; }
  }
  if (changed) saveIndex();
  // Hash anything unhashed, lazily
  for (const [id, r] of Object.entries(index.roms)) {
    if (r.sha1) continue;
    try { r.sha1 = await sha1File(path.join(ROMS_DIR, id)); saveIndex(); } catch { /* next boot */ }
  }
}

// ---------- sessions ----------
const b64u = b => Buffer.from(b).toString('base64url');
const sign = data => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');

function makeCookie(user) {
  const payload = b64u(JSON.stringify({ ...user, exp: Date.now() + 30 * 86400_000 }));
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  try {
    const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('session='))?.slice(8);
    if (!raw) return null;
    const [payload, sig] = raw.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(sign(payload));
    const got = Buffer.from(sig);
    if (got.length !== expected.length || !crypto.timingSafeEqual(expected, got)) return null;
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (user.exp < Date.now()) return null;
    return user;
  } catch {
    return null;
  }
}

// ---------- helpers ----------
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  let len = 0;
  req.on('data', c => { len += c.length; if (len > 1e6) reject(new Error('too big')); else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});
const safeName = s => {
  const n = path.basename(String(s || ''));
  return n && !n.startsWith('.') && !n.includes('..') ? n : null;
};

// ---------- server ----------
export function startWeb({ state, GAMES = [], onLibraryChange, onRequest }) {
  // After reconciling files on disk, re-announce every stored ROM so wishlist
  // flips missed at upload time (bulk copies, matcher fixes) heal on boot.
  reconcile()
    .then(() => { for (const r of Object.values(index.roms)) onLibraryChange?.(r); })
    .catch(e => console.error('reconcile failed:', e));

  // catalog lookup for enriching stored ROMs with year/genre/developer
  const catalog = new Map(); // "<folder>|<normTitle>" -> {y,g,d}
  for (const g of GAMES) {
    const k = `${FOLDERS[g.p] ?? 'other'}|${normTitle(g.t)}`;
    if (!catalog.has(k)) catalog.set(k, g);
  }
  const enrich = (id, r) => {
    const meta = catalog.get(`${id.split('/')[0]}|${normTitle(r.title)}`) ?? {};
    const region = r.file.match(/\(([^)]+)\)/)?.[1];
    return { id, ...r, year: meta.y, genre: meta.g, developer: meta.d, region };
  };

  const pending = new Map(); // oauth state -> ts

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, PUBLIC_URL);
    const p = url.pathname;
    const user = readSession(req);
    const needAuth = () => { json(res, 401, { error: 'login required' }); return false; };
    const authed = () => (user ? true : needAuth());

    try {
      // ----- pages / health -----
      if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
      if (p === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(APP_HTML); return;
      }

      // ----- oauth -----
      if (p === '/auth/login') {
        const st = crypto.randomBytes(16).toString('hex');
        pending.set(st, Date.now());
        for (const [k, t] of pending) if (Date.now() - t > 600_000) pending.delete(k);
        const q = new URLSearchParams({
          client_id: CLIENT_ID, response_type: 'code', scope: 'identify',
          redirect_uri: `${PUBLIC_URL}/auth/callback`, state: st,
        });
        res.writeHead(302, { location: `https://discord.com/oauth2/authorize?${q}` });
        res.end(); return;
      }
      if (p === '/auth/callback') {
        const st = url.searchParams.get('state');
        if (!st || !pending.delete(st)) { res.writeHead(400); res.end('bad state'); return; }
        const tr = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code', code: url.searchParams.get('code'),
            redirect_uri: `${PUBLIC_URL}/auth/callback`,
          }),
        }).then(r => r.json());
        if (!tr.access_token) { res.writeHead(403); res.end('oauth failed'); return; }
        const me = await fetch('https://discord.com/api/users/@me', {
          headers: { authorization: `Bearer ${tr.access_token}` },
        }).then(r => r.json());
        if (!(await isAllowed(me.id))) { res.writeHead(403); res.end('not a member of the family server'); return; }
        const cookie = makeCookie({ id: me.id, name: me.global_name || me.username });
        res.writeHead(302, {
          'set-cookie': `session=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`,
          location: '/',
        });
        res.end(); return;
      }
      if (p === '/auth/logout') {
        res.writeHead(302, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/' });
        res.end(); return;
      }

      // ----- public checklist + boxart -----
      if (p === '/api/me') { json(res, 200, { user: user ?? null }); return; }
      if (p === '/api/state') { json(res, 200, { entries: state.entries }); return; }
      const artReq = p.match(/^\/api\/art\/([a-z]+)\/(.+)$/);
      if (artReq) { await serveArt(res, artReq[1], decodeURIComponent(artReq[2])); return; }

      // ----- catalog search + web requests -----
      if (p === '/api/catalog') {
        if (!authed()) return;
        const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
        if (q.length < 2) { json(res, 200, { results: [] }); return; }
        const starts = [], contains = [];
        for (const g of GAMES) {
          const t = g.t.toLowerCase();
          if (t.startsWith(q)) starts.push(g);
          else if (t.includes(q)) contains.push(g);
          if (starts.length >= 50) break;
        }
        json(res, 200, { results: starts.concat(contains).slice(0, 50) });
        return;
      }
      if (p === '/api/request' && req.method === 'POST') {
        if (!authed()) return;
        if (!onRequest) { json(res, 500, { error: 'requests unavailable' }); return; }
        const body = JSON.parse(await readBody(req));
        const title = String(body.title ?? '').trim().slice(0, 200);
        const platform = FOLDERS[body.platform] !== undefined ? body.platform : 'Other';
        if (!title) { json(res, 400, { error: 'title required' }); return; }
        json(res, 200, onRequest(title, platform, user.name));
        return;
      }

      // ----- library -----
      if (p === '/api/roms' && req.method === 'GET') {
        if (!authed()) return;
        json(res, 200, { roms: Object.entries(index.roms).map(([id, r]) => enrich(id, r)) });
        return;
      }
      if (p === '/api/rom' && req.method === 'PUT') {
        if (!authed()) return;
        const platform = FOLDERS[url.searchParams.get('platform')] !== undefined
          ? url.searchParams.get('platform') : 'Other';
        const file = safeName(url.searchParams.get('name'));
        if (!file) { json(res, 400, { error: 'bad name' }); return; }
        const folder = FOLDERS[platform];
        const dir = path.join(ROMS_DIR, folder);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, file);
        const tmp = dest + '.uploading';
        const hash = crypto.createHash('sha1');
        let size = 0;
        const addRom = (plat, name, buf) => {
          const f = FOLDERS[plat];
          fs.mkdirSync(path.join(ROMS_DIR, f), { recursive: true });
          fs.writeFileSync(path.join(ROMS_DIR, f, name), buf);
          const id = `${f}/${name}`;
          index.roms[id] = {
            platform: plat, file: name, size: buf.length,
            sha1: crypto.createHash('sha1').update(buf).digest('hex'),
            title: cleanTitle(name), by: user.name, at: new Date().toISOString(),
          };
          onLibraryChange?.(index.roms[id]);
          return id;
        };
        const out = fs.createWriteStream(tmp);
        req.on('data', c => { hash.update(c); size += c.length; });
        req.pipe(out);
        out.on('finish', () => {
          try {
            // Zips are extracted and shelved by inner extension — except for
            // Arcade, where the zip itself is the romset format.
            if (/\.zip$/i.test(file) && platform !== 'Arcade') {
              const entries = unzipSync(fs.readFileSync(tmp));
              fs.rmSync(tmp, { force: true });
              const added = [], skipped = [];
              for (const [entry, data] of Object.entries(entries)) {
                const base = safeName(entry.split('/').pop());
                if (!base || !data.length || entry.includes('__MACOSX')) continue;
                const plat = supportPlatform(base) ?? EXT_PLATFORM[base.split('.').pop().toLowerCase()];
                if (!plat) { skipped.push(base); continue; }
                const id = addRom(plat, base, Buffer.from(data));
                added.push({ id, title: index.roms[id].title, platform: plat });
              }
              saveIndex();
              json(res, 200, { extracted: added, skipped });
              return;
            }
            fs.renameSync(tmp, dest);
            const id = romId(platform, file);
            index.roms[id] = {
              platform, file, size, sha1: hash.digest('hex'),
              title: cleanTitle(file), by: user.name, at: new Date().toISOString(),
            };
            saveIndex();
            onLibraryChange?.(index.roms[id]);
            json(res, 200, { id, ...index.roms[id] });
          } catch (e) {
            fs.rmSync(tmp, { force: true });
            json(res, 400, { error: `couldn't process upload: ${e.message}` });
          }
        });
        out.on('error', e => { fs.rmSync(tmp, { force: true }); json(res, 500, { error: e.message }); });
        return;
      }
      const romMatch = p.match(/^\/api\/rom\/([a-z]+)\/(.+)$/);
      if (romMatch) {
        if (!authed()) return;
        const file = safeName(decodeURIComponent(romMatch[2]));
        const id = file && `${romMatch[1]}/${file}`;
        const entry = id && index.roms[id];
        if (!entry) { json(res, 404, { error: 'not found' }); return; }
        const full = path.join(ROMS_DIR, id);
        if (req.method === 'DELETE') {
          fs.rmSync(full, { force: true });
          delete index.roms[id];
          for (const set of Object.values(index.syncSets)) {
            const i = set.indexOf(id); if (i >= 0) set.splice(i, 1);
          }
          saveIndex();
          json(res, 200, { ok: true }); return;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': entry.size,
          'content-disposition': `attachment; filename="${entry.file}"`,
        });
        fs.createReadStream(full).pipe(res);
        return;
      }

      // ----- sync sets -----
      if (p === '/api/syncset') {
        if (!authed()) return;
        if (req.method === 'PUT') {
          const ids = JSON.parse(await readBody(req));
          if (!Array.isArray(ids)) { json(res, 400, { error: 'array expected' }); return; }
          index.syncSets[user.id] = ids.filter(id => index.roms[id]);
          saveIndex();
        }
        json(res, 200, { ids: index.syncSets[user.id] ?? [] });
        return;
      }
      // ----- provisioning: cores + firmware -----
      if (p === '/api/cores') {
        if (!authed()) return;
        json(res, 200, { cores: await listCores(), selected: index.coreSets?.[user.id] ?? [] });
        return;
      }
      if (p === '/api/coreset' && req.method === 'PUT') {
        if (!authed()) return;
        const ids = JSON.parse(await readBody(req));
        if (!Array.isArray(ids)) { json(res, 400, { error: 'array expected' }); return; }
        const inv = await getInventory();
        index.coreSets = index.coreSets ?? {};
        index.coreSets[user.id] = ids.filter(id => inv.has(id));
        saveIndex();
        json(res, 200, { ids: index.coreSets[user.id] });
        return;
      }
      if (p === '/api/provision/manifest') {
        if (!authed()) return;
        const out = { cores: [], failures: [] };
        try {
          const fw = await getFirmware();
          out.firmware = { version: fw.version, file: fw.file, size: fw.size, url: '/api/firmware/bin' };
        } catch (e) { out.failures.push(`firmware: ${e.message}`); }
        for (const id of index.coreSets?.[user.id] ?? []) {
          try {
            const { version, files } = await ensureCore(id);
            out.cores.push({
              id, version,
              files: files.map(f => ({
                path: f.path, size: f.size,
                url: `/api/corefile/${encodeURIComponent(id)}/${f.path.split('/').map(encodeURIComponent).join('/')}`,
              })),
            });
          } catch (e) { out.failures.push(`${id}: ${e.message}`); }
        }
        json(res, 200, out);
        return;
      }
      const coreFileReq = p.match(/^\/api\/corefile\/([^/]+)\/(.+)$/);
      if (coreFileReq) {
        if (!authed()) return;
        const id = decodeURIComponent(coreFileReq[1]);
        const rel = coreFileReq[2].split('/').map(decodeURIComponent).join('/');
        const core = (await getInventory()).get(id);
        const full = core && coreFilePath(id, core.version, rel);
        if (!full) { json(res, 404, { error: 'not found' }); return; }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': fs.statSync(full).size,
        });
        fs.createReadStream(full).pipe(res);
        return;
      }
      if (p === '/api/firmware/bin') {
        if (!authed()) return;
        const fw = await getFirmware();
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': fw.size,
          'content-disposition': `attachment; filename="${fw.file}"`,
        });
        fs.createReadStream(fw.path).pipe(res);
        return;
      }

      if (p === '/api/sync/manifest') {
        if (!authed()) return;
        // BIOS/support files always sync, regardless of anyone's sync set
        const chosen = (index.syncSets[user.id] ?? []).filter(id => index.roms[id]);
        const bios = Object.keys(index.roms)
          .filter(id => /bios|lynxboot|disksys|syscard/i.test(index.roms[id].file) && !chosen.includes(id));
        const items = [...chosen, ...bios]
          .map(id => {
            const r = index.roms[id];
            return { id, folder: FOLDERS[r.platform] ?? 'other', file: r.file, size: r.size, sha1: r.sha1 };
          });
        json(res, 200, { items });
        return;
      }

      res.writeHead(404); res.end('not found');
    } catch (e) {
      console.error(`${req.method} ${p} failed:`, e);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  server.listen(PORT, () => console.log(`web on :${PORT}`));
  return server;
}
