zendesk-worker backfill v5

Changes in this build:
- Added resume-safe checkpointing for ticket sync.
- Worker now writes checkpoints to /app/data/state.json only AFTER each successful Sheets batch write.
- Auto-resume for unfinished backfill runs.
- Auto-resume for unfinished incremental runs.
- Resume uses an overlap window based on INCREMENTAL_LOOKBACK_SECONDS and dedupes against existing ticket IDs already in the Tickets sheet.
- Ticket sync now streams Zendesk tickets directly instead of loading the full export into memory before writing.
- No worker-side tag scan or AllTags writes.

New state fields include:
- mode
- status
- started_at_epoch
- completed_at_epoch
- resume_start_time
- last_ticket_generated_timestamp
- last_ticket_id
- rows_written
- last_successful_sheet_write_at_epoch

Behavior:
- If a backfill is interrupted, rerunning the worker will automatically resume from the last successful checkpoint with overlap.
- Sorting still happens only after the full ticket run completes.
