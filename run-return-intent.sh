#!/usr/bin/env bash
SDIR=/home/pwrdbyadobo/docker/workers/summaries
DISCORD=/home/pwrdbyadobo/docker/workers/shopify-worker/discord.sh
cd /home/pwrdbyadobo/docker/workers/return-intent-worker

OUT=$(/usr/bin/docker compose run --rm return-intent-worker 2>&1 | tee -a data/run.log)
RC=${PIPESTATUS[0]}

if [ $RC -eq 0 ]; then
    MATCHES=$(echo "$OUT" | grep -oP "Checked \d+ tickets, \K\d+(?= trigger matches)" | tail -1)
    APPENDED=$(echo "$OUT" | grep -oP "Appended \K\d+(?= rows)" | tail -1)
    echo "✅ Return        ${MATCHES:-0} matches · ${APPENDED:-0} appended" > "$SDIR/return-intent.txt"
else
    echo "❌ Return        FAILED" > "$SDIR/return-intent.txt"
    "$DISCORD" "❌ Return Intent FAILED\n$(tail -5 data/run.log)"
fi
