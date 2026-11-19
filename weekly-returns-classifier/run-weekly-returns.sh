#!/usr/bin/env bash
# Weekly Core One Pro returns job. Cron: Saturday 11pm Pacific (already past 00:00 UTC Sunday, so the
# Sun-Sat window computed by job.py's default is unchanged). Runs evidence-gathering ONLY (--no-llm --skip-apply,
# always - no ANTHROPIC_API_KEY is configured; classification is done manually, in a conversation with Claude,
# reading the dossiers this writes to state/dossiers/). Extra args are appended after those two, e.g. --only CCxxxx
# for an ad hoc single-order re-gather.
# Wrapped in `timeout` as a safety net: a repeat-caller with a large ticket/call history can otherwise run for
# hours (seen 2026-09-28: one order alone pulled ~64 min of call audio from 24 historical tickets before a
# per-order audio cap was added to job.py) - if it still runs long, the job is killed rather than run forever
# unattended and collide with next Sunday's run.
set -u
cd /home/pwrdbyadobo/docker/workers/weekly-returns-classifier
LOG="logs/run-$(date +%F-%H%M).log"
mkdir -p logs state work
rm -f state/last_run_discord.txt
timeout --kill-after=1m 3h \
  nice -n 10 docker run --rm --name weekly-returns-job --cpus=3 --memory=3g --user "$(id -u):$(id -g)" -e HOME=/app/work -e HF_HOME=/app/work/hf \
  -v "$PWD/job:/app/job:ro" -v "$PWD/work:/app/work" -v "$PWD/state:/app/state" \
  -v "$PWD/gsa-key.json:/run/gsa-key.json:ro" -v /home/pwrdbyadobo/docker/workers/.env.common:/run/zd.env:ro \
  --env-file .env weekly-returns-classifier python /app/job/job.py --no-llm --skip-apply "$@" > "$LOG" 2>&1
rc=$?
# If `timeout` had to SIGKILL the docker-run client (--kill-after), the container itself can be left running
# orphaned (--rm only removes it on the container's own exit). Stop it by its fixed name - never by pattern.
docker stop weekly-returns-job >/dev/null 2>&1 || true
NOTIFY=/home/pwrdbyadobo/docker/workers/shopify-worker/discord.sh
if [ -n "${NO_NOTIFY:-}" ]; then
  echo "NO_NOTIFY set: skipping Discord (exit $rc)"
elif [ $rc -ne 0 ]; then
  "$NOTIFY" "WEEKLY RETURNS JOB FAILED (exit $rc). Log: $PWD/$LOG" || true
elif [ -s state/last_run_discord.txt ]; then
  "$NOTIFY" "$(cat state/last_run_discord.txt)" || true
fi
find logs -name 'run-*.log' -mtime +60 -delete 2>/dev/null
exit $rc
