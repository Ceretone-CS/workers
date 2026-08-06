#!/usr/bin/env bash
SDIR=/home/pwrdbyadobo/docker/workers/summaries
DISCORD=/home/pwrdbyadobo/docker/workers/shopify-worker/discord.sh
cd /home/pwrdbyadobo/docker/workers/zendesk-worker

date -Iseconds > "$SDIR/zendesk.started"

OUT=$(/usr/bin/docker compose run --rm zendesk-worker 2>&1 | tee -a data/sync.log)
RC=${PIPESTATUS[0]}

rm -f "$SDIR/zendesk.started"

if [ $RC -eq 0 ]; then
    UPDATED=$(echo "$OUT" | grep -oP "Updated \K\d+(?= existing rows)" | awk '{s+=$1} END{print s+0}')
    SCANNED=$(echo "$OUT" | grep -oP "Scanned \K\d+(?= tickets so far)" | tail -1)
    echo "✅ Zendesk      ${SCANNED:-?} scanned · ${UPDATED:-?} updated" > "$SDIR/zendesk.txt"
else
    REASON=$(echo "$OUT" | grep -iE "error|failed|exception" | tail -1 | cut -c1-80)
    echo "❌ Zendesk      FAILED${REASON:+ — $REASON}" > "$SDIR/zendesk.txt"
    "$DISCORD" "❌ Zendesk Sync FAILED\n${REASON}\nSee data/sync.log for details."
fi
