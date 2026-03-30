from app.zendesk_api import iter_incremental_tickets, get_user
from app.mappings.fields import (
    ORDER_NUMBER,
    SERIAL_NUMBER,
    PURCHASED_FROM,
    PRODUCT_TYPE,
    NOTES,
)
from app.mappings.channels import classify_channel
from app.mappings.products import classify_product
from app.sheets import (
    get_spreadsheet,
    ensure_headers,
    append_rows,
    get_existing_ticket_ids,
    sort_sheet_by_column,
)
from app.config import (
    BACKFILL_START_TIME,
    BATCH_WRITE_SIZE,
    IGNORED_TICKET_FORMS,
    TICKETS_WORKSHEET,
    INCREMENTAL_LOOKBACK_SECONDS,
)
from app.utils.state import get_resume_state, start_run, checkpoint_run, complete_run


def get_custom_fields_map(ticket):
    return {
        field["id"]: field.get("value")
        for field in ticket.get("custom_fields", [])
        if "id" in field
    }



def get_user_serial_number(requester_id):
    if not requester_id:
        return None

    try:
        user = get_user(requester_id)
    except Exception:
        return None

    user_fields = user.get("user_fields", {}) or {}

    for key in ("serial_number", "serial", "device_serial_number"):
        value = user_fields.get(key)
        if value:
            return str(value).strip()

    return None



def format_zendesk_datetime(value):
    if not value:
        return ""
    return str(value).replace("T", " ").replace("Z", "")


def build_ticket_row(ticket):
    if ticket.get("ticket_form_id") in IGNORED_TICKET_FORMS:
        return None

    custom_fields = get_custom_fields_map(ticket)

    tags = [str(t).lower() for t in ticket.get("tags", [])]
    if "closed_by_merge" in tags:
        return None

    status = (ticket.get("status") or "").strip().lower()
    if status == "new":
        return None

    order = custom_fields.get(ORDER_NUMBER) or "N/A"
    purchased_from = custom_fields.get(PURCHASED_FROM) or ""
    product_type = custom_fields.get(PRODUCT_TYPE) or ""
    notes = custom_fields.get(NOTES) or "N/A"

    serial = custom_fields.get(SERIAL_NUMBER)
    if not serial:
        serial = get_user_serial_number(ticket.get("requester_id"))
    serial = serial or "N/A"

    product = classify_product(tags, product_type)
    channel = classify_channel(tags, order, purchased_from)

    created_at = format_zendesk_datetime(ticket.get("created_at"))
    solved_at = format_zendesk_datetime(ticket.get("solved_at"))
    status_value = ticket.get("status") or "N/A"
    tags_csv = ", ".join(tags) if tags else "N/A"

    return [
        str(ticket.get("id", "")),
        created_at,
        solved_at,
        channel,
        str(order),
        product,
        str(serial),
        str(notes),
        tags_csv,
        str(status_value),
    ]



def _get_start_time(mode: str):
    if mode == "incremental":
        resume = get_resume_state("incremental")
        if resume and resume.get("last_ticket_generated_timestamp"):
            checkpoint = int(resume["last_ticket_generated_timestamp"])
            start_time = max(0, checkpoint - INCREMENTAL_LOOKBACK_SECONDS)
            print(
                f"Resuming unfinished incremental run from checkpoint {checkpoint} with overlap; start_time={start_time}",
                flush=True,
            )
            return str(start_time)

        from app.utils.state import load_state

        state = load_state()
        checkpoint = int(state.get("last_ticket_generated_timestamp", BACKFILL_START_TIME))
        start_time = max(0, checkpoint - INCREMENTAL_LOOKBACK_SECONDS)
        print(
            f"Incremental start_time={start_time} (checkpoint={checkpoint}, overlap={INCREMENTAL_LOOKBACK_SECONDS}s)",
            flush=True,
        )
        return str(start_time)

    resume = get_resume_state("backfill")
    if resume and resume.get("last_ticket_generated_timestamp"):
        checkpoint = int(resume["last_ticket_generated_timestamp"])
        start_time = max(int(BACKFILL_START_TIME), checkpoint - INCREMENTAL_LOOKBACK_SECONDS)
        print(
            f"Resuming unfinished backfill from checkpoint {checkpoint} with overlap; start_time={start_time}",
            flush=True,
        )
        return str(start_time)

    return str(BACKFILL_START_TIME)



def flush_batch(ws, batch, batch_last_generated_timestamp, batch_last_ticket_id, mode, start_time, written):
    if not batch:
        return written

    append_rows(ws, batch)
    written += len(batch)
    checkpoint_run(
        mode=mode,
        generated_timestamp=batch_last_generated_timestamp,
        ticket_id=batch_last_ticket_id,
        rows_written=written,
        start_time=start_time,
    )
    print(
        f"Wrote batch of {len(batch)} rows. Total written: {written}. Checkpoint saved at generated_timestamp={batch_last_generated_timestamp}, ticket_id={batch_last_ticket_id}",
        flush=True,
    )
    return written


def run_ticket_sync(mode="backfill"):
    start_time = _get_start_time(mode)
    start_run(mode, start_time)

    ss = get_spreadsheet()
    ws = ss.worksheet(TICKETS_WORKSHEET)

    headers = [
        "Ticket Number",
        "Created At",
        "Solved At",
        "Channel",
        "Order Number",
        "Product",
        "Serial Number",
        "Notes",
        "Tags",
        "Status",
    ]
    ensure_headers(ws, headers)

    existing_ids = get_existing_ticket_ids(ws)
    print(f"Loaded {len(existing_ids)} existing ticket ids from worksheet '{TICKETS_WORKSHEET}'", flush=True)

    batch = []
    scanned = 0
    written = 0
    max_generated_timestamp = None
    last_written_ticket_id = None
    batch_last_generated_timestamp = None
    batch_last_ticket_id = None

    for ticket in iter_incremental_tickets(start_time):
        scanned += 1
        ticket_id = str(ticket.get("id", ""))
        generated_timestamp = ticket.get("generated_timestamp")
        if generated_timestamp is not None and (
            max_generated_timestamp is None or generated_timestamp > max_generated_timestamp
        ):
            max_generated_timestamp = generated_timestamp

        if scanned % 100 == 0:
            print(f"Scanned {scanned} tickets so far... last ticket id: {ticket_id}", flush=True)

        if not ticket_id or ticket_id in existing_ids:
            continue

        row = build_ticket_row(ticket)
        if not row:
            continue

        batch.append(row)
        existing_ids.add(ticket_id)
        batch_last_generated_timestamp = generated_timestamp
        batch_last_ticket_id = ticket_id
        last_written_ticket_id = ticket_id

        if len(batch) >= BATCH_WRITE_SIZE:
            written = flush_batch(
                ws,
                batch,
                batch_last_generated_timestamp,
                batch_last_ticket_id,
                mode,
                start_time,
                written,
            )
            batch = []
            batch_last_generated_timestamp = None
            batch_last_ticket_id = None

    if batch:
        written = flush_batch(
            ws,
            batch,
            batch_last_generated_timestamp,
            batch_last_ticket_id,
            mode,
            start_time,
            written,
        )

    sort_sheet_by_column(ws, 2, "asc", start_row=2)
    print(f"Sorted {TICKETS_WORKSHEET} by Created At (oldest first, header excluded)")

    print(f"Ticket sync complete. Mode: {mode}. Scanned: {scanned}. Written: {written}")

    complete_run(
        mode=mode,
        generated_timestamp=max_generated_timestamp,
        ticket_id=last_written_ticket_id,
        rows_written=written,
        start_time=start_time,
    )
    if max_generated_timestamp is not None:
        print(f"Saved completion state at generated_timestamp={max_generated_timestamp}")
