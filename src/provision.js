// Card provisioning: openFPGA core mirror + Analogue firmware mirror.
// Cores come from the community inventory (openfpga-cores-inventory), get
// extracted server-side, and are served file-by-file so the browser can write
// them straight onto the SD card. Firmware comes from analogue.co.
import { unzipSync } from 'fflate';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DATA_DIR = process.env.DATA_DIR || './data-state';
const CACHE = path.join(DATA_DIR, 'provision');
const INVENTORY_URL = 'https://openfpga-cores-inventory.github.io/analogue-pocket/api/v2/cores.json';
const FIRMWARE_BASE = 'https://www.analogue.co/support/pocket/firmware';

const DAY = 86400_000;

// ---------- core inventory ----------
let inventory = null; // { at, byId: Map }
export async function getInventory() {
  if (inventory && Date.now() - inventory.at < DAY / 4) return inventory.byId;
  const file = path.join(CACHE, 'inventory.json');
  let data = null;
  try {
    const res = await fetch(INVENTORY_URL);
    if (res.ok) {
      data = (await res.json()).data;
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    }
  } catch { /* fall back to disk */ }
  if (!data) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return inventory?.byId ?? new Map(); }
  }
  const byId = new Map();
  for (const c of data) byId.set(c.identifier, c);
  inventory = { at: Date.now(), byId };
  return byId;
}

export async function listCores() {
  const byId = await getInventory();
  return [...byId.values()].map(c => ({
    id: c.identifier,
    name: c.platform?.name ?? c.platform_id ?? c.identifier,
    category: c.platform?.category ?? 'Other',
    manufacturer: c.platform?.manufacturer,
    year: c.platform?.year,
    author: c.repository?.owner ?? c.identifier.split('.')[0],
    version: c.version ?? '',
    requiresLicense: !!c.requires_license,
  }));
}

// Best core per platform folder, for auto-selection from sync sets
const PREFERRED_CORES = {
  gb: ['Spiritualized.GB'], gbc: ['Spiritualized.GBC'], gba: ['Spiritualized.GBA'],
  nes: ['agg23.NES', 'Spiritualized.NES'], snes: ['agg23.SNES'],
  genesis: ['ericlewis.Genesis', 'Spiritualized.Genesis'],
  pce: ['agg23.PC Engine'], pcecd: ['Mazamars312.PC Engine CD'],
  gg: ['Spiritualized.GG'], lynx: ['budude2.Lynx'],
};

export async function coresForFolders(folders) {
  const byId = await getInventory();
  const out = new Set();
  for (const f of folders) {
    let pick = PREFERRED_CORES[f]?.find(id => byId.has(id));
    if (!pick) {
      pick = [...byId.values()]
        .find(c => c.platform_id === f && !/analogizer/i.test(c.identifier))?.identifier;
    }
    if (pick) out.add(pick);
  }
  return [...out];
}

// ---------- core files ----------
const badSeg = seg => !seg || seg === '.' || seg === '..' || seg.startsWith('._');

// Download + extract a core release; returns {version, files:[{path,size}]}.
export async function ensureCore(id) {
  const byId = await getInventory();
  const core = byId.get(id);
  if (!core) throw new Error(`unknown core ${id}`);
  const dir = path.join(CACHE, 'cores', id, core.version);
  const manifestFile = path.join(dir, '.manifest.json');
  if (fs.existsSync(manifestFile)) {
    return { version: core.version, files: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
  }
  const res = await fetch(core.download_url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${id}`);
  const entries = unzipSync(Buffer.from(await res.arrayBuffer()));
  const files = [];
  for (const [name, buf] of Object.entries(entries)) {
    if (!buf.length || name.endsWith('/') || name.includes('__MACOSX')) continue;
    const segs = name.split('/').filter(Boolean);
    if (segs.some(badSeg)) continue;
    const rel = segs.join('/');
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    files.push({ path: rel, size: buf.length });
  }
  fs.writeFileSync(manifestFile, JSON.stringify(files));
  return { version: core.version, files };
}

export function coreFilePath(id, version, rel) {
  const dir = path.join(CACHE, 'cores', id, version);
  const full = path.normalize(path.join(dir, rel));
  if (!full.startsWith(dir + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

// ---------- firmware ----------
let firmware = null; // { at, version, file, size, path }
export async function getFirmware() {
  if (firmware && Date.now() - firmware.at < DAY) return firmware;
  const meta = path.join(CACHE, 'firmware.json');
  try {
    const latest = await fetch(`${FIRMWARE_BASE}/latest`, { redirect: 'manual' });
    const version = (latest.headers.get('location') ?? '').split('/').pop();
    if (!version) throw new Error('no version in redirect');
    const cached = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : null;
    if (cached?.version === version && fs.existsSync(path.join(CACHE, cached.file))) {
      firmware = { at: Date.now(), ...cached, path: path.join(CACHE, cached.file) };
      return firmware;
    }
    const res = await fetch(`${FIRMWARE_BASE}/${version}/download`);
    if (!res.ok) throw new Error(`firmware download ${res.status}`);
    const file = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || `pocket_firmware_${version}.bin`);
    fs.mkdirSync(CACHE, { recursive: true });
    // stream to disk — the bin is ~55MB and must not be buffered in memory
    const tmp = path.join(CACHE, file + '.tmp');
    const hash = crypto.createHash('sha1');
    let size = 0;
    const src = Readable.fromWeb(res.body);
    src.on('data', c => { hash.update(c); size += c.length; });
    await pipeline(src, fs.createWriteStream(tmp));
    fs.renameSync(tmp, path.join(CACHE, file));
    const info = { version, file, size, sha1: hash.digest('hex') };
    fs.writeFileSync(meta, JSON.stringify(info));
    firmware = { at: Date.now(), ...info, path: path.join(CACHE, file) };
    return firmware;
  } catch (e) {
    // offline fallback: whatever we have on disk
    try {
      const cached = JSON.parse(fs.readFileSync(meta, 'utf8'));
      firmware = { at: Date.now(), ...cached, path: path.join(CACHE, cached.file) };
      return firmware;
    } catch {
      throw e;
    }
  }
}
