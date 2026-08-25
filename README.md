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
  every change) and serves the same list at **pocket.kodloki.io** with a
  30s auto-refresh.

State lives in `/data/library.json` on a retained PVC.

## Config (K8s secret `pocket-librarian-secrets`)

| var | required | what |
|---|---|---|
| `DISCORD_TOKEN` | yes | bot token |
| `DISCORD_APP_ID` | yes | application ID |
| `DISCORD_GUILD_ID` | recommended | server ID — makes slash commands register instantly |
| `DISCORD_CHANNEL_ID` | recommended | channel for the pinned checklist message |

```bash
kubectl -n pocket-librarian create secret generic pocket-librarian-secrets \
  --from-literal=DISCORD_TOKEN=... \
  --from-literal=DISCORD_APP_ID=... \
  --from-literal=DISCORD_GUILD_ID=... \
  --from-literal=DISCORD_CHANNEL_ID=...
```

## Discord app setup (one-time)

1. <https://discord.com/developers/applications> → **New Application** → name it.
2. Copy the **Application ID** (General Information).
3. **Bot** tab → **Reset Token** → copy the token. No privileged intents needed.
4. Invite it: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=76800`
   (76800 = view channel, send messages, manage messages for pinning).
5. Right-click the server → Copy Server ID, and the channel → Copy Channel ID
   (enable Developer Mode in Discord settings if those aren't shown).

## Deploy

```bash
scripts/deploy.sh          # buildx amd64 → Docker Hub → kubectl apply + rollout
```

## Rebuild the game catalog

```bash
npm run build-db           # refetches libretro-database DATs → data/games.json
```
