# pocket-librarian

Private family game library for Analogue Pockets: Discord bot + web app.
Runs on tow-c1 at <https://pocket.kodloki.io> (guild-member login only).

## What it does

**Web app** (`web/app.html`, served by `src/web.js`):
- **Library** — boxart grid (libretro-thumbnails, proxied + cached) with
  year/genre/developer metadata, hover quick-add to sync set, discovery
  shelves (popular / recently added / unsynced), grouping by
  platform/series/genre, detail modal with download and admin delete.
- **Wishlist** — catalog search (16k No-Intro/Redump titles) with one-click
  request; requested grid with remove; auto-checks-off when a matching ROM
  is uploaded.
- **Sync to SD** — browser writes the card via the File System Access API
  (Chrome/Edge): latest Analogue firmware (mirrored from analogue.co),
  cores (auto-selected from the games in your sync set; manual picker for
  arcade), BIOS/support files (auto-attached per platform), games, and
  save restores — one pass, per-file progress and retries. **Deep verify**
  hashes everything on the card against known-good copies and repairs
  mismatches. **Save backups**: Saves/ + Memories/ auto-backed-up on scan
  (per-user toggle), 10-version history, restore any version, share to
  another member, delete.
- **Help** — full user docs, BIOS table, Pocket troubleshooting.

**Discord bot** (`src/index.js`): `/request` (autocomplete), `/got`,
`/remove`, `/list`, `/help`; static pinned link card to the site.

**Uploads**: drag-drop files or zips (auto-extracted, shelved by inner
extension; `platform=Arcade` keeps romset zips intact). BIOS files are
recognized by name, canonicalized to what core `data.json`s require
(e.g. `gb_bios.bin` → `dmg_bios.bin`), hidden from the library, and
always synced for their platform. Extensions are lowercased (the Pocket's
browser is case-sensitive).

## Storage

- `/data` (PVC): checklist state (`library.json`), ROM index + sync sets +
  core sets + users + prefs (`roms-index.json`), core/firmware/boxart
  caches under `provision/` and `art-cache/`.
- `/roms` (80Gi PVC): ROM files by platform folder; save backups under
  `.saves/<discord-user-id>/` with `.history/` versions.

## Config (K8s secret `pocket-librarian-secrets`)

| var | what |
|---|---|
| `DISCORD_TOKEN` | bot token (also used to verify guild membership + owner) |
| `DISCORD_APP_ID` | application/client id |
| `DISCORD_CLIENT_SECRET` | OAuth2 secret for web login |
| `DISCORD_GUILD_ID` | the family server — members may log in; owner is admin |
| `DISCORD_CHANNEL_ID` | channel for the pinned link card |
| `SESSION_SECRET` | cookie signing; rotate to force-logout everyone |
| `ALLOWED_USER_IDS` | optional login allowlist override |
| `ADMIN_USER_IDS` | optional admin override (default: guild owner) |

OAuth redirect `https://pocket.kodloki.io/auth/callback` must be registered
in the Discord app. Bot invite permissions `76800`, **plus enable the
"Pin Messages" permission on the bot's role** (newer granular permission,
not covered by the invite integer).

## Deploy

```bash
scripts/deploy.sh     # buildx amd64 → Docker Hub → kubectl apply + rollout
```

Manifests in `K8s/app.yaml` (namespace `pocket-librarian`, ingress with
2g body size for uploads, 512Mi memory limit — firmware/core processing
needs the headroom).

## Data pipelines

- `npm run build-db` — rebuilds `data/games.json` from libretro-database
  DATs (titles + year/genre/developer, 12 platforms).
- Core inventory: openfpga-cores-inventory API, cached 6h; core zips
  downloaded/extracted on demand with per-file sha1 manifests.
- Firmware: version discovered via analogue.co redirect chain, streamed to
  disk (do not buffer — OOM), cached until version changes.
- Boxart: libretro-thumbnails, matched by normalized title (Roman-numeral
  aware, region-preferring, fuzzy fallback), cached on disk.

## Bulk ROM upload

`SESSION=<browser session cookie> scripts/upload-roms.sh <assets-dir>`
