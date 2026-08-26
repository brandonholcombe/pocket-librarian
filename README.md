# pocket-librarian

Discord bot + web checklist for the family Analogue Pocket game library.
Runs on tow-c1 at <https://pocket.kodloki.io>.

## What it does

- **`/request <game>`** — request a game, with autocomplete over ~16k titles
  (No-Intro/Redump catalogs for GB, GBC, GBA, NES, SNES, Genesis, Sega CD,
  PC Engine (+CD), Game Gear, Lynx, NGPC). Free-typed titles work too
  (platform shows as "Other").
- **`/got <game>`** — mark a requested game as purchased (autocompletes over
  the requested list).
- **`/remove <game>`** — drop an entry entirely.
- **`/list`** — print the checklist on demand.
- Maintains a **pinned checklist message** in the channel (auto-updates on
  every change).
- **pocket.kodloki.io**: Discord-OAuth-gated web app (allowlisted user IDs
  only) with three tabs — **Library** (search the stored ROMs, drag-and-drop
  upload, per-person sync-set checkboxes), **Wishlist** (the checklist), and
  **Sync to SD** (browser writes missing games straight onto the SD card via
  the File System Access API — Chrome/Edge on Mac & Windows).
- Uploading a ROM whose title matches a requested game auto-flips it to
  "in library" on the checklist.

Checklist state lives in `/data/library.json`; the ROM files live on an 80Gi
PVC at `/roms/<platform-folder>/`, indexed in `/data/roms-index.json` (SHA1,
size, uploader). Bulk initial upload: `scripts/upload-roms.sh`.

## Config (K8s secret `pocket-librarian-secrets`)

| var | required | what |
|---|---|---|
| `DISCORD_TOKEN` | yes | bot token |
| `DISCORD_APP_ID` | yes | application ID |
| `DISCORD_GUILD_ID` | recommended | server ID — makes slash commands register instantly |
| `DISCORD_CHANNEL_ID` | recommended | channel for the pinned checklist message |
| `DISCORD_CLIENT_SECRET` | yes (web login) | OAuth2 client secret from the same Discord app |
| `ALLOWED_USER_IDS` | yes (web login) | comma-separated Discord user IDs allowed to log in |
| `SESSION_SECRET` | recommended | any random string; sessions survive restarts |

```bash
kubectl -n pocket-librarian create secret generic pocket-librarian-secrets \
  --from-literal=DISCORD_TOKEN=... \
  --from-literal=DISCORD_APP_ID=... \
  --from-literal=DISCORD_GUILD_ID=... \
  --from-literal=DISCORD_CHANNEL_ID=... \
  --from-literal=DISCORD_CLIENT_SECRET=... \
  --from-literal=ALLOWED_USER_IDS=<yourID>,<brotherID> \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32)
```

## Discord app setup (one-time)

1. <https://discord.com/developers/applications> → **New Application** → name it.
2. Copy the **Application ID** (General Information).
3. **Bot** tab → **Reset Token** → copy the token. No privileged intents needed.
4. Invite it: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=76800`
   (76800 = view channel, send messages, manage messages).
   Then ALSO enable **Pin Messages** on the bot's role (Server Settings →
   Roles → the bot's managed role) — Discord split pinning out of Manage
   Messages into its own permission, and the invite integer predates it.
5. Right-click the server → Copy Server ID, and the channel → Copy Channel ID
   (enable Developer Mode in Discord settings if those aren't shown).
6. For web login: **OAuth2** tab → copy the **Client Secret**, and add
   `https://pocket.kodloki.io/auth/callback` under **Redirects**.
7. Right-click each person's avatar → Copy User ID → these become
   `ALLOWED_USER_IDS`.

## Deploy

```bash
scripts/deploy.sh          # buildx amd64 → Docker Hub → kubectl apply + rollout
```

## Rebuild the game catalog

```bash
npm run build-db           # refetches libretro-database DATs → data/games.json
```
