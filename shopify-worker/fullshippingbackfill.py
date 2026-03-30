import os
import time
import re
import requests
from datetime import datetime, timezone, timedelta
from dateutil import parser as dtparser

from google.oauth2 import service_account
from googleapiclient.discovery import build


# =========================
# ENV / CONFIG
# =========================
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "21"))  # used only in non-topdown mode
MAX_ELIGIBLE_PER_RUN = int(os.getenv("MAX_ELIGIBLE_PER_RUN", "500"))
SHEET_READ_CHUNK = int(os.getenv("SHEET_READ_CHUNK", "250"))

PER_ORDER_SLEEP_S = float(os.getenv("PER_ORDER_SLEEP_S", "0.08"))
PER_FULFILLMENT_SLEEP_S = float(os.getenv("PER_FULFILLMENT_SLEEP_S", "0.08"))
META_SLEEP_S = float(os.getenv("META_SLEEP_S", "0.12"))

# TEMP mode: top-down catchup for rows with ship_date blank
TOP_DOWN_SHIP_ONLY = os.getenv("BACKFILL_TOP_DOWN_SHIP_ONLY", "0") == "1"

# Shopify
SHOPIFY_STORE = os.environ["SHOPIFY_STORE"]
SHOPIFY_TOKEN = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2024-10")

# Google Sheets
SHEET_ID = os.environ["SHEET_ID"]
SHEET_NAME = os.environ.get("SHEET_NAME", "Shopify Orders3")
GOOGLE_SA_JSON = os.environ["GOOGLE_SA_JSON"]

# Columns (match your sheet)
ORDER_ID_COL = 1      # A
ORDER_DATE_COL = 3    # C
SHIP_DATE_COL = 4     # D
DELIVERY_DATE_COL = 5 # E
CARRIER_COL = 6       # F
SERIAL_COL = 12       # L


# =========================
# HELPERS
# =========================
def sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def a1(col: int) -> str:
    s = ""
    while col > 0:
        col, r = divmod(col - 1, 26)
        s = chr(65 + r) + s
    return s


def get_last_row(svc) -> int:
    # Count rows based on column A (order_id)
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=f"{SHEET_NAME}!A:A",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    vals = resp.get("values", [])
    return len(vals)


def read_block(svc, start_row: int, end_row: int, start_col: int, end_col: int):
    rng = f"{SHEET_NAME}!{a1(start_col)}{start_row}:{a1(end_col)}{end_row}"
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=rng,
        valueRenderOption="UNFORMATTED_VALUE",
        dateTimeRenderOption="FORMATTED_STRING",
    ).execute()
    return resp.get("values", [])


def write_row_fields_now(svc, row_index: int, ship="", carrier="", serial="", delivery=""):
    # Write only provided fields (single API call via batchUpdate)
    data = []
    if ship:
        data.append({"range": f"{SHEET_NAME}!{a1(SHIP_DATE_COL)}{row_index}", "values": [[ship]]})
    if carrier:
        data.append({"range": f"{SHEET_NAME}!{a1(CARRIER_COL)}{row_index}", "values": [[carrier]]})
    if serial:
        data.append({"range": f"{SHEET_NAME}!{a1(SERIAL_COL)}{row_index}", "values": [[serial]]})
    if delivery:
        data.append({"range": f"{SHEET_NAME}!{a1(DELIVERY_DATE_COL)}{row_index}", "values": [[delivery]]})

    if not data:
        return

    svc.spreadsheets().values().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"valueInputOption": "RAW", "data": data},
    ).execute()


def to_dt(x):
    if not x:
        return None
    try:
        dt = dtparser.parse(str(x))
        if not dt.tzinfo:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def sheet_datetime(ts):
    """Convert datetime / ISO string to Sheets-friendly 'M/D/YYYY HH:MM:SS'."""
    if not ts:
        return ""
    try:
        if isinstance(ts, datetime):
            dt = ts
        else:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        # Linux-friendly (homeserver/pi)
        return dt.strftime("%-m/%-d/%Y %H:%M:%S")
    except Exception:
        return ""


def normalize_serial(s: str) -> str:
    """
    Normalize serial:
    - remove parentheses
    - remove all non-alphanumeric
    - uppercase
    """
    if not s:
        return ""
    s = str(s).strip().upper()
    s = s.replace("(", "").replace(")", "")
    s = re.sub(r"[^A-Z0-9]", "", s)
    return s


# =========================
# SHOPIFY API
# =========================
def shopify_get(path: str, params=None):
    url = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}/{path.lstrip('/')}"
    headers = {"X-Shopify-Access-Token": SHOPIFY_TOKEN}

    backoff = 1.0
    for _ in range(6):
        r = requests.get(url, headers=headers, params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(float(r.headers.get("Retry-After", "2")))
            backoff *= 2
            continue
        if r.status_code >= 500:
            time.sleep(backoff)
            backoff *= 2
            continue
        r.raise_for_status()
        return r.json()

    r.raise_for_status()


def get_ship_date_and_carrier_from_fulfillments(order_id: int):
    payload = shopify_get(f"orders/{order_id}.json", params={"fields": "fulfillments"})
    order = payload.get("order") or {}
    fulfills = order.get("fulfillments") or []
    if not fulfills:
        return None

    dates = []
    carrier = ""

    for f in fulfills:
        dt_raw = f.get("shipped_at") or f.get("created_at") or ""
        dt = to_dt(dt_raw)
        if dt:
            dates.append(dt)

        if not carrier:
            tc = (f.get("tracking_company") or "").strip()
            if tc:
                carrier = tc
            ti = f.get("tracking_info")
            if not carrier and isinstance(ti, dict) and ti.get("company"):
                carrier = str(ti["company"]).strip()
            if not carrier and isinstance(ti, list) and len(ti) > 0 and ti[0].get("company"):
                carrier = str(ti[0]["company"]).strip()

    if not dates:
        return None

    dates.sort()
    return {
        "shipDate": sheet_datetime(dates[0]),
        "carrier": carrier
    }


def get_delivered_date_from_fulfillment_events(order_id: int):
    fulfills_payload = shopify_get(f"orders/{order_id}/fulfillments.json")
    fulfillments = fulfills_payload.get("fulfillments") or []
    if not fulfillments:
        return ""

    delivered = []
    for f in fulfillments:
        fid = f.get("id")
        if not fid:
            continue

        events_payload = shopify_get(f"orders/{order_id}/fulfillments/{fid}/events.json")
        events = events_payload.get("fulfillment_events") or []

        for ev in events:
            status = str(ev.get("status") or "").lower()
            happened = ev.get("happened_at") or ev.get("created_at") or ""
            if status == "delivered":
                dt = to_dt(happened)
                if dt:
                    delivered.append(dt)

        time.sleep(PER_FULFILLMENT_SLEEP_S)

    if not delivered:
        return ""

    delivered.sort()
    return sheet_datetime(delivered[0])


def fetch_order_metafield(order_id: int, namespace: str, key: str):
    payload = shopify_get(
        f"orders/{order_id}/metafields.json",
        params={"namespace": namespace, "key": key}
    )
    mfs = payload.get("metafields") or []
    if not mfs:
        return ""
    return mfs[0].get("value") or ""


# =========================
# MAIN
# =========================
def main():
    svc = sheets_service()
    last_row = get_last_row(svc)
    if last_row < 2:
        print("No rows to process.")
        return

    # Used only in normal mode
    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)

    checked = 0
    eligible = 0
    updated_rows = 0

    start_row = 2

    print(f"Mode: {'TOP_DOWN_SHIP_ONLY' if TOP_DOWN_SHIP_ONLY else 'NORMAL'}")
    print(f"Sheet: {SHEET_NAME}  LastRow: {last_row}")

    while start_row <= last_row:
        end_row = min(start_row + SHEET_READ_CHUNK - 1, last_row)
        block = read_block(svc, start_row, end_row, 1, SERIAL_COL)

        # pad short rows
        for i, row in enumerate(block):
            checked += 1
            row_index = start_row + i
            row = (row + [""] * SERIAL_COL)[:SERIAL_COL]

            # order_id
            order_id_raw = row[ORDER_ID_COL - 1]
            try:
                order_id = int(float(order_id_raw)) if str(order_id_raw).strip() else 0
            except Exception:
                order_id = 0
            if not order_id:
                continue

            order_date_raw = row[ORDER_DATE_COL - 1]
            ship_date_raw = row[SHIP_DATE_COL - 1]
            delivery_date_raw = row[DELIVERY_DATE_COL - 1]
            carrier_raw = str(row[CARRIER_COL - 1] or "").strip()
            serial_raw_sheet = str(row[SERIAL_COL - 1] or "").strip()

            ship_blank = not ship_date_raw
            delivery_blank = not delivery_date_raw
            carrier_blank = not carrier_raw
            serial_blank = not serial_raw_sheet

            # ------------------------------
            # TEMP MODE: start from top, ONLY rows where ship_date is blank
            # but still pulls ship + carrier + serial + delivery (when ship is found)
            # ------------------------------
            if TOP_DOWN_SHIP_ONLY:
                if not ship_blank:
                    continue

                eligible += 1
                if MAX_ELIGIBLE_PER_RUN and eligible > MAX_ELIGIBLE_PER_RUN:
                    print("Hit MAX_ELIGIBLE_PER_RUN. Stopping this run.")
                    print(f"Done. Checked={checked}, Eligible={eligible-1}, UpdatedRows={updated_rows}")
                    return

                ship_info = get_ship_date_and_carrier_from_fulfillments(order_id)
                ship_str = ship_info.get("shipDate", "") if ship_info else ""
                carrier_str = ship_info.get("carrier", "") if ship_info else ""

                # If still no ship date, likely unfulfilled/unshipped -> skip
                if not ship_str:
                    time.sleep(PER_ORDER_SLEEP_S)
                    continue

                # serial (only if missing)
                serial_str = ""
                if serial_blank:
                    mf = fetch_order_metafield(order_id, "custom", "serial_number") or ""
                    serial_str = normalize_serial(mf)
                    time.sleep(META_SLEEP_S)

                # delivery (only if missing)
                delivery_str = ""
                if delivery_blank:
                    delivery_str = get_delivered_date_from_fulfillment_events(order_id)

                # Write immediately (watch in realtime)
                write_row_fields_now(
                    svc,
                    row_index=row_index,
                    ship=ship_str,
                    carrier=(carrier_str if carrier_blank else ""),
                    serial=serial_str,
                    delivery=delivery_str,
                )

                updated_rows += 1
                print(
                    f"Row {row_index} updated: "
                    f"ship={ship_str} "
                    f"delivery={delivery_str or '-'} "
                    f"carrier={(carrier_str or '-') if carrier_blank else '(kept)'} "
                    f"serial={(serial_str or '-')}"
                )

                time.sleep(PER_ORDER_SLEEP_S)
                continue

            # ------------------------------
            # NORMAL MODE (original behavior):
            # respects LOOKBACK window and fills ship/delivery/serial/carrier if needed
            # (kept here so you can switch modes later without losing functionality)
            # ------------------------------
            # If nothing to do, skip
            if (not ship_blank and not delivery_blank and not (serial_blank and bool(ship_date_raw)) and not (carrier_blank and bool(ship_date_raw))):
                continue

            anchor_raw = ship_date_raw or order_date_raw
            anchor_dt = to_dt(anchor_raw)
            if not anchor_dt:
                continue
            if anchor_dt < cutoff:
                continue

            eligible += 1
            if MAX_ELIGIBLE_PER_RUN and eligible > MAX_ELIGIBLE_PER_RUN:
                print("Hit MAX_ELIGIBLE_PER_RUN. Stopping this run.")
                break

            ship_found = ""
            carrier_found = ""

            if ship_blank:
                info = get_ship_date_and_carrier_from_fulfillments(order_id)
                if info and info.get("shipDate"):
                    ship_found = info["shipDate"]
                    carrier_found = info.get("carrier", "")

                    write_row_fields_now(
                        svc,
                        row_index=row_index,
                        ship=ship_found,
                        carrier=(carrier_found if carrier_blank else ""),
                    )
                    updated_rows += 1

            ship_known_now = (not ship_blank and bool(ship_date_raw)) or bool(ship_found)

            if ship_known_now and serial_blank:
                mf = fetch_order_metafield(order_id, "custom", "serial_number") or ""
                serial_norm = normalize_serial(mf)
                time.sleep(META_SLEEP_S)
                if serial_norm:
                    write_row_fields_now(svc, row_index=row_index, serial=serial_norm)
                    updated_rows += 1

            if ship_known_now and delivery_blank:
                delivered_str = get_delivered_date_from_fulfillment_events(order_id)
                if delivered_str:
                    write_row_fields_now(svc, row_index=row_index, delivery=delivered_str)
                    updated_rows += 1

            time.sleep(PER_ORDER_SLEEP_S)

        start_row += SHEET_READ_CHUNK

    print(f"Done. Checked={checked}, Eligible={eligible}, UpdatedRows={updated_rows}")


if __name__ == "__main__":
    main()
