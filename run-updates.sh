#!/usr/bin/env bash
SDIR=/home/pwrdbyadobo/docker/workers/summaries
DISCORD=/home/pwrdbyadobo/docker/workers/shopify-worker/discord.sh
cd /home/pwrdbyadobo/docker/workers/shopify-worker

OUT=$(/usr/bin/docker compose run --rm shopify-worker updates | tee -a data/updates.log)
RC=${PIPESTATUS[0]}

if [ $RC -eq 0 ]; then
    SHIP=$(echo "$OUT" | grep -oP "Shipping\s+:\s+\K\d+"      | tail -1)
    CARR=$(echo "$OUT" | grep -oP "Carrier\s+:\s+\K\d+"       | tail -1)
    SER=$(echo "$OUT"  | grep -oP "Serial Number\s+:\s+\K\d+" | tail -1)
    echo "✅ Updates      ${SHIP:-0} ship · ${CARR:-0} carrier · ${SER:-0} serial" > "$SDIR/updates.txt"
else
    echo "❌ Updates      FAILED" > "$SDIR/updates.txt"
    "$DISCORD" "❌ Shopify Updates FAILED\n$(tail -5 data/updates.log)"
fi
