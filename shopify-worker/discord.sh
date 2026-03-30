#!/usr/bin/env bash
set -euo pipefail

# Load env
set -a
source /home/pwrdbyadobo/docker/workers/shopify-worker/.env
set +a

MSG="$(printf '%b' "${1:-"(no message)"}")"
TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"
HOST="$(hostname)"

export MSG TS HOST

payload="$(python3 - <<'PY'
import json, os
content = f"{os.environ['MSG']}\nHost: {os.environ['HOST']}\nTime: {os.environ['TS']}"
print(json.dumps({"content": content}))
PY
)"

curl -sS -H "Content-Type: application/json" -d "$payload" "$DISCORD_WEBHOOK_URL" >/dev/null
