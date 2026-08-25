#!/bin/zsh
# Bulk-upload ROMs to pocket.kodloki.io from a local staging tree laid out as
# <dir>/<platform-folder>/... (e.g. analogue-pocket/roms-staging/Assets).
#
# Usage:
#   1. Log in at https://pocket.kodloki.io in your browser
#   2. Copy the session cookie: DevTools > Application > Cookies > session
#   3. SESSION=<value> ./upload-roms.sh ~/kodloki/analogue-pocket/roms-staging/Assets
set -euo pipefail
BASE="${BASE:-https://pocket.kodloki.io}"
SRC="${1:?usage: SESSION=... ./upload-roms.sh <assets-dir>}"
: "${SESSION:?set SESSION to your browser session cookie value}"

# folder name -> API platform name
typeset -A PLAT=(gb GB gbc GBC gba GBA nes NES snes SNES genesis Genesis
                 pce PCE pcecd PCE-CD segacd "Sega CD" gg GG lynx Lynx
                 ngpc NGPC other Other)

find "$SRC" -type f ! -name '.*' | while read -r f; do
  rel="${f#$SRC/}"
  folder="${rel%%/*}"
  platform="${PLAT[$folder]:-Other}"
  name="$(basename "$f")"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H "Cookie: session=$SESSION" \
    --data-binary "@$f" \
    "$BASE/api/rom?platform=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$platform")&name=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$name")")
  if [[ "$code" == "200" ]]; then
    echo "OK   $platform  $name"
  else
    echo "FAIL($code)  $platform  $name" >&2
  fi
done
