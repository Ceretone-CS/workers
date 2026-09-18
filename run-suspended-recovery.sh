#!/usr/bin/env bash
SDIR=/home/pwrdbyadobo/docker/workers/summaries
DISCORD=/home/pwrdbyadobo/docker/workers/shopify-worker/discord.sh
cd /home/pwrdbyadobo/docker/workers/suspended-recovery-worker

OUT=$(/usr/bin/docker compose run --rm suspended-recovery-worker 2>&1 | tee -a data/run.log)
RC=${PIPESTATUS[0]}

if [ $RC -eq 0 ]; then
    RECOVERED=$(echo "$OUT" | grep -oP "Recovered \K\d+(?= tickets)" | tail -1)
    FLAGGED=$(echo "$OUT" | grep -oP "Flagged \K\d+(?= tickets)" | tail -1)
    echo "✅ Suspended     ${RECOVERED:-0} recovered · ${FLAGGED:-0} flagged" > "$SDIR/suspended-recovery.txt"
else
    echo "❌ Suspended     FAILED" > "$SDIR/suspended-recovery.txt"
    "$DISCORD" "❌ Suspended Recovery FAILED\n$(tail -5 data/run.log)"
fi
