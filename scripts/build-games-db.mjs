// Build data/games.json from libretro-database DAT files (No-Intro derived).
// Run: npm run build-db
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/';
const PLATFORMS = {
  'GB':      'no-intro/Nintendo - Game Boy.dat',
  'GBC':     'no-intro/Nintendo - Game Boy Color.dat',
  'GBA':     'no-intro/Nintendo - Game Boy Advance.dat',
  'NES':     'no-intro/Nintendo - Nintendo Entertainment System.dat',
  'SNES':    'no-intro/Nintendo - Super Nintendo Entertainment System.dat',
  'Genesis': 'no-intro/Sega - Mega Drive - Genesis.dat',
  'PCE':     'no-intro/NEC - PC Engine - TurboGrafx 16.dat',
  'PCE-CD':  'redump/NEC - PC Engine CD - TurboGrafx-CD.dat',
  'Sega CD': 'redump/Sega - Mega-CD - Sega CD.dat',
  'GG':      'no-intro/Sega - Game Gear.dat',
  'Lynx':    'no-intro/Atari - Lynx.dat',
  'NGPC':    'no-intro/SNK - Neo Geo Pocket Color.dat',
};

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const clean = s => s.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

// metadat/{releaseyear,genre,developer}/<system>.dat: game blocks keyed by
// comment "<full no-intro name>" with a single field.
async function fetchMeta(kind, field, datName) {
  const map = new Map(); // cleaned title -> value
  try {
    const text = await fetchText(BASE + `${kind}/` + encodeURIComponent(datName));
    const re = new RegExp(`game \\(\\s*\\n\\s*comment "([^"]+)"\\s*\\n\\s*${field} "([^"]+)"`, 'g');
    for (const m of text.matchAll(re)) {
      const key = clean(m[1]).toLowerCase();
      if (!map.has(key)) map.set(key, m[2]);
    }
  } catch { /* metadata is best-effort */ }
  return map;
}

const out = [];
for (const [platform, file] of Object.entries(PLATFORMS)) {
  let text;
  try {
    text = await fetchText(BASE + file.split('/').map(encodeURIComponent).join('/'));
  } catch (e) {
    console.error(`SKIP ${platform}: ${e.message}`);
    continue;
  }
  const datName = file.split('/')[1];
  const [years, genres, devs] = await Promise.all([
    fetchMeta('releaseyear', 'releaseyear', datName),
    fetchMeta('genre', 'genre', datName),
    fetchMeta('developer', 'developer', datName),
  ]);
  const seen = new Set();
  let count = 0;
  // game blocks look like: game (\n\tname "Title (Region) (Rev 1)"\n ...
  for (const m of text.matchAll(/game \(\s*\n\s*name "([^"]+)"/g)) {
    const raw = m[1];
    if (raw.includes('[BIOS]')) continue;
    // Strip No-Intro parenthetical tags (region, rev, etc.)
    const title = clean(raw);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { t: title, p: platform };
    if (years.get(key)) entry.y = years.get(key);
    if (genres.get(key)) entry.g = genres.get(key);
    if (devs.get(key)) entry.d = devs.get(key);
    out.push(entry);
    count++;
  }
  console.log(`${platform}: ${count} titles (${[...seen].filter(k => years.has(k)).length} with year)`);
}

out.sort((a, b) => a.t.localeCompare(b.t) || a.p.localeCompare(b.p));
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'games.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${out.length} total titles to ${dest}`);
