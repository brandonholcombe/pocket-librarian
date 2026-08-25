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

const out = [];
for (const [platform, file] of Object.entries(PLATFORMS)) {
  const url = BASE + file.split("/").map(encodeURIComponent).join("/");
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    console.error(`SKIP ${platform}: ${e.message}`);
    continue;
  }
  const seen = new Set();
  let count = 0;
  // game blocks look like: game (\n\tname "Title (Region) (Rev 1)"\n ...
  for (const m of text.matchAll(/game \(\s*\n\s*name "([^"]+)"/g)) {
    const raw = m[1];
    if (raw.includes('[BIOS]')) continue;
    // Strip No-Intro parenthetical tags (region, rev, etc.)
    const title = raw.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ t: title, p: platform });
    count++;
  }
  console.log(`${platform}: ${count} titles`);
}

out.sort((a, b) => a.t.localeCompare(b.t) || a.p.localeCompare(b.p));
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'games.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${out.length} total titles to ${dest}`);
