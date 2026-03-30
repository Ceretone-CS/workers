from app.zendesk_api import collect_incremental_tickets
from app.sheets import (
    get_spreadsheet,
    ensure_headers,
    append_rows,
    get_existing_tags,
    sort_sheet_by_col_a,
)
from app.config import (
    BACKFILL_START_TIME,
    IGNORED_TICKET_FORMS,
    TAGS_WORKSHEET,
    INCREMENTAL_LOOKBACK_SECONDS,
)
from app.utils.state import get_last_ticket_timestamp, set_last_ticket_timestamp



def _get_start_time(mode: str):
    if mode == "incremental":
        last_ts = int(get_last_ticket_timestamp(BACKFILL_START_TIME))
        return str(max(0, last_ts - INCREMENTAL_LOOKBACK_SECONDS))
    return BACKFILL_START_TIME



def run_tag_sync(mode="backfill"):
    start_time = _get_start_time(mode)
    ss = get_spreadsheet()
    ws = ss.worksheet(TAGS_WORKSHEET)

    ensure_headers(ws, ["Tag"])

    existing_tags = get_existing_tags(ws)
    new_tags = set()
    scanned = 0
    skipped = 0
    last_ticket_id = None

    tickets, max_generated_timestamp = collect_incremental_tickets(start_time)

    for ticket in tickets:
        scanned += 1
        last_ticket_id = ticket.get("id")

        if ticket.get("ticket_form_id") in IGNORED_TICKET_FORMS:
            skipped += 1
            if skipped % 100 == 0:
                print(f"Skipped {skipped} tag-scan tickets by form filter")
            continue

        if scanned % 100 == 0:
            print(
                f"Scanning tags... processed {scanned} tickets "
                f"(last ticket id: {last_ticket_id})",
                flush=True,
            )

        for tag in ticket.get("tags", []):
            t = str(tag).strip().lower()
            if t and t not in existing_tags:
                new_tags.add(t)

    if new_tags:
        rows = [[tag] for tag in sorted(new_tags)]
        append_rows(ws, rows)
        print(f"Added {len(new_tags)} new tags to {TAGS_WORKSHEET}")
    else:
        print("No new tags found.")

    sort_sheet_by_col_a(ws)
    print(f"{TAGS_WORKSHEET} sorted by column A")

    if max_generated_timestamp is not None:
        set_last_ticket_timestamp(max_generated_timestamp)
        print(f"Saved incremental state at generated_timestamp={max_generated_timestamp}")
