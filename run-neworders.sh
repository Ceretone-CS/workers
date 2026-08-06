#!/usr/bin/env bash
SDIR=/home/pwrdbyadobo/docker/workers/summaries
DISCORD=/home/pwrdbyadobo/docker/workers/shopify-worker/discord.sh
cd /home/pwrdbyadobo/docker/workers/shopify-worker

OUT=$(/usr/bin/docker compose run --rm shopify-worker neworders | tee -a data/neworders.log)
RC=${PIPESTATUS[0]}

if [ $RC -eq 0 ]; then
    ADDED=$(echo "$OUT" | grep -oP "Orders Added\s+:\s+\K\d+" | tail -1)
    LAST=$(echo "$OUT"  | grep -oP "Last Written Order\s+:\s+\K\S+" | tail -1)
    echo "✅ Orders       +${ADDED:-?} new · last ${LAST:-?}" > "$SDIR/neworders.txt"
else
    echo "❌ Orders       FAILED" > "$SDIR/neworders.txt"
    "$DISCORD" "❌ Shopify Orders FAILED\n$(tail -5 data/neworders.log)"
fi
