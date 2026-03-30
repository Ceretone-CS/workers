#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"

case "$MODE" in
  refresh)
    python /app/worker_full_refresh.py
    ;;
  backfill)
    python /app/worker_backfill_21d.py
    ;;
  neworders)
    python /app/neworders.py
    ;;
  updates)
    python /app/updates.py
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Use: refresh | backfill | neworders | updates"
    exit 1
    ;;
esac
