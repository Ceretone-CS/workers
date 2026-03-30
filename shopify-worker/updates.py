#!/usr/bin/env python3
# updates.py
#
# Behavior:
# - 14 days (FIELDS_LOOKBACK_DAYS): ship_date, delivery_date, carrier, custom_serial_number
# - 90 days (REFUND_LOOKBACK_DAYS): financial_status -> refunded
# - If a row is already marked "refunded" in the sheet, ignore it forever (no further updates).
#
# Performance:
# - Scans sheet in chunks from bottom (default) or top.
# - Writes shipping-related updates AFTER EVERY CHUNK (ship/delivery/carrier/serial),
#   so you get shipping info as soon as possible.
# - Writes refunded status updates at the very end.
#
# Timezone:
# - Sheet strings without tz are treated as LOCAL_TZ for comparisons.
# - Values written to the sheet are formatted in LOCAL_TZ.
# - Also supports YYMMDD numeric dates like 260304 -> 2026-03-04.

import os
import time
import re
import requests
from datetime import datetime, timezone, timedelta
from dateutil import parser as dtparser
from zoneinfo import ZoneInfo

from google.oauth2 import service_account
from googleapiclient.discovery import build

# =========================
# TZ
# =========================
LOCAL_TZ = ZoneInfo(os.getenv("LOCAL_TZ", "America/Los_Angeles"))

# =========================
# ENV / CONFIG
# =========================
FIELDS_LOOKBACK_DAYS = int(os.getenv("FIELDS_LOOKBACK_DAYS", "14"))   # ship/delivery/carrier/serial
REFUND_LOOKBACK_DAYS = int(os.getenv("REFUND_LOOKBACK_DAYS", "90"))   # financial_status check
SHEET_READ_CHUNK = int(os.getenv("SHEET_READ_CHUNK", "250"))

# 0 = unlimited
MAX_ELIGIBLE_PER_RUN = int(os.getenv("MAX_ELIGIBLE_PER_RUN", "0"))
UPDATES_MAX_ROWS_READ = int(os.getenv("UPDATES_MAX_ROWS_READ", "0"))

PER_ORDER_SLEEP_S = float(os.getenv("PER_ORDER_SLEEP_S", "0.05"))
PER_FULFILLMENT_SLEEP_S = float(os.getenv("PER_FULFILLMENT_SLEEP_S", "0.08"))
META_SLEEP_S = float(os.getenv("META_SLEEP_S", "0.10"))

DELIVERY_LOOKUP_MIN_HOURS = float(os.getenv("DELIVERY_LOOKUP_MIN_HOURS", "24"))

UPDATES_SCAN_FROM_BOTTOM = int(os.getenv("UPDATES_SCAN_FROM_BOTTOM", "1"))  # 1=on

# Shopify
SHOPIFY_STORE = os.environ["SHOPIFY_STORE"]
SHOPIFY_TOKEN = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2024-10")

# Google Sheets
SHEET_ID = os.environ["SHEET_ID"]
SHEET_NAME = os.environ.get("SHEET_NAME", "Shopify Orders3")
GOOGLE_SA_JSON = os.environ["GOOGLE_SA_JSON"]

# Columns
ORDER_ID_COL = 1       # A
ORDER_NAME_COL = 2     # B
ORDER_DATE_COL = 3     # C
SHIP_DATE_COL = 4      # D
DELIVERY_DATE_COL = 5  # E
CARRIER_COL = 6        # F
FIN_STATUS_COL = 7     # G
FULFILL_STATUS_COL = 8  # H
SERIAL_COL = 12        # L

# =========================
# GOOGLE SHEETS HELPERS
# =========================
def sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_JSON, scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)

def a1(col: int) -> str:
    s = ""
    while col > 0:
        col, r = divmod(col - 1, 26)
        s = chr(65 + r) + s
    return s

def get_last_row(svc) -> int:
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=f"{SHEET_NAME}!A:A",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    return len(resp.get("values", []))

def read_block(svc, start_row: int, end_row: int, start_col: int, end_col: int):
    rng = f"{SHEET_NAME}!{a1(start_col)}{start_row}:{a1(end_col)}{end_row}"
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=rng,
        valueRenderOption="UNFORMATTED_VALUE",
        dateTimeRenderOption="FORMATTED_STRING",
    ).execute()
    return resp.get("values", [])

def batch_write_single_column(svc, updates, col: int):
    if not updates:
        return
    updates.sort(key=lambda x: x["rowIndex"])

    data = []
    run_start = updates[0]["rowIndex"]
    run_vals = [[updates[0]["value"]]]
    prev = updates[0]["rowIndex"]

    def flush(rs, vals):
        rng = f"{SHEET_NAME}!{a1(col)}{rs}:{a1(col)}{rs + len(vals) - 1}"
        data.append({"range": rng, "values": vals})

    for u in updates[1:]:
        r = u["rowIndex"]
        v = u["value"]
        if r == prev + 1:
            run_vals.append([v])
        else:
            flush(run_start, run_vals)
            run_start = r
            run_vals = [[v]]
        prev = r

    flush(run_start, run_vals)

    svc.spreadsheets().values().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"valueInputOption": "RAW", "data": data},
    ).execute()

def flush_shipping_writes(svc, ship_updates, carrier_updates, fulfill_updates, serial_updates, delivery_updates):
    """Write shipping-related columns ASAP (after every chunk), then clear lists."""
    if ship_updates:
        batch_write_single_column(svc, ship_updates, SHIP_DATE_COL)
        ship_updates.clear()
    if carrier_updates:
        batch_write_single_column(svc, carrier_updates, CARRIER_COL)
        carrier_updates.clear()
    if fulfill_updates:
        batch_write_single_column(svc, fulfill_updates, FULFILL_STATUS_COL)
        fulfill_updates.clear()
    if serial_updates:
        batch_write_single_column(svc, serial_updates, SERIAL_COL)
        serial_updates.clear()
    if delivery_updates:
        batch_write_single_column(svc, delivery_updates, DELIVERY_DATE_COL)
        delivery_updates.clear()

# =========================
# PARSING / NORMALIZATION
# =========================
def to_dt(x):
    if x is None or x == "":
        return None

    s = str(x).strip()

    # Google Sheets sometimes gives "260304.0"
    if re.fullmatch(r"\d+(\.0+)?", s):
        s = s.split(".", 1)[0]

    # YYMMDD (6 digits): 260304 -> 2026-03-04 local midnight
    if re.fullmatch(r"\d{6}", s):
        yy = int(s[0:2])
        mm = int(s[2:4])
        dd = int(s[4:6])
        year = 2000 + yy
        try:
            dt = datetime(year, mm, dd, 0, 0, 0, tzinfo=LOCAL_TZ)
            return dt.astimezone(timezone.utc)
        except Exception:
            return None

    try:
        dt = dtparser.parse(s)
        if not dt.tzinfo:
            # Sheet strings are local time
            dt = dt.replace(tzinfo=LOCAL_TZ)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None

def sheet_datetime(ts) -> str:
    """Format timestamps written to the sheet as local time."""
    if not ts:
        return ""
    try:
        if isinstance(ts, datetime):
            dt = ts
        else:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        dt = dt.astimezone(LOCAL_TZ)
        return dt.strftime("%-m/%-d/%Y %H:%M:%S")
    except Exception:
        return ""

def normalize_serial(s: str) -> str:
    if not s:
        return ""
    s = str(s).strip().upper()
    s = s.replace("(", "").replace(")", "")
    s = re.sub(r"[^A-Z0-9]", "", s)
    return s

def shipped_long_enough_for_delivery_check(ship_dt: datetime, now_utc: datetime) -> bool:
    return ship_dt is not None and (now_utc - ship_dt) >= timedelta(hours=DELIVERY_LOOKUP_MIN_HOURS)

def newest_anchor_dt_in_block(block):
    """Used to decide when to stop scanning (bottom-scan)."""
    newest = None
    for r in block:
        rr = (r + [""] * SERIAL_COL)[:SERIAL_COL]
        raw = rr[SHIP_DATE_COL - 1] or rr[ORDER_DATE_COL - 1]
        dt = to_dt(raw)
        if dt and (newest is None or dt > newest):
            newest = dt
    return newest

# =========================
# SHOPIFY API
# =========================
def shopify_get(path: str, params=None):
    url = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}/{path.lstrip('/')}"
    headers = {"X-Shopify-Access-Token": SHOPIFY_TOKEN}

    backoff = 1.0
    last_exc = None
    for _ in range(6):
        try:
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
        except Exception as e:
            last_exc = e
            time.sleep(backoff)
            backoff *= 2
    raise last_exc

def get_ship_date_and_carrier(order_id: int):
    payload = shopify_get(f"orders/{order_id}.json", params={"fields": "fulfillments"})
    order = payload.get("order") or {}
    fulfills = order.get("fulfillments") or []
    if not fulfills:
        return None

    dates = []
    carrier = ""

    for f in fulfills:
        dt_raw = f.get("shipped_at") or f.get("created_at") or ""
        dt = to_dt(dt_raw)  # Shopify timestamps include tz; to_dt returns UTC
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
    return {"shipDate": sheet_datetime(dates[0]), "shipDt": dates[0], "carrier": carrier}

def get_delivered_date(order_id: int):
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
            if str(ev.get("status") or "").lower() == "delivered":
                happened = ev.get("happened_at") or ev.get("created_at") or ""
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
        params={"namespace": namespace, "key": key},
    )
    mfs = payload.get("metafields") or []
    if not mfs:
        return ""
    return mfs[0].get("value") or ""

def get_fulfillment_status(order_id: int) -> str:
    payload = shopify_get(f"orders/{order_id}.json", params={"fields": "fulfillment_status"})
    order = payload.get("order") or {}
    # Shopify returns None/null if unfulfilled
    return (order.get("fulfillment_status") or "").strip().lower()

def get_financial_status(order_id: int) -> str:
    payload = shopify_get(f"orders/{order_id}.json", params={"fields": "financial_status"})
    order = payload.get("order") or {}
    return str(order.get("financial_status") or "").strip().lower()

# =========================
# ROW PROCESSOR
# =========================
def process_row(now_utc, cutoff_fields, cutoff_refund, row_index, row,
                ship_updates, carrier_updates, fulfill_updates, serial_updates, delivery_updates, fin_status_updates):
    """
    14 days (fields): ship date, delivery date (>=24h since ship), carrier (if shipped), serial (if shipped)
    90 days (refund): financial_status check to mark refunded
    Ignore entries already marked refunded in the sheet (skip all work).
    """
    row = (row + [""] * SERIAL_COL)[:SERIAL_COL]
    order_name = str(row[ORDER_NAME_COL - 1] or "").strip()

    # order_id
    try:
        order_id = int(float(row[ORDER_ID_COL - 1])) if str(row[ORDER_ID_COL - 1]).strip() else 0
    except Exception:
        order_id = 0
    if not order_id:
        return 0, True, ""

    order_date_raw = row[ORDER_DATE_COL - 1]
    ship_date_raw = row[SHIP_DATE_COL - 1]
    delivery_date_raw = row[DELIVERY_DATE_COL - 1]
    carrier_raw = str(row[CARRIER_COL - 1] or "").strip()
    fulfill_raw = str(row[FULFILL_STATUS_COL - 1] or "").strip()
    serial_raw = str(row[SERIAL_COL - 1] or "").strip()
    fin_sheet = str(row[FIN_STATUS_COL - 1] or "").strip().lower()

    # Ignore refunded forever
    if fin_sheet == "refunded":
        return 0, True, order_name

    ship_blank = not ship_date_raw
    delivery_blank = not delivery_date_raw
    carrier_blank = not carrier_raw
    fulfill_blank = not fulfill_raw
    serial_blank = not serial_raw

    # Anchor = ship_date else order_date
    anchor_raw = ship_date_raw or order_date_raw
    anchor_dt = to_dt(anchor_raw)
    if not anchor_dt:
        return 0, True, order_name

    # Outside refund window => do nothing
    if anchor_dt < cutoff_refund:
        return 0, True, order_name

    within_fields_window = (anchor_dt >= cutoff_fields)

    needs_fields = within_fields_window and (ship_blank or delivery_blank or carrier_blank or serial_blank)
    needs_refund_check = True  # within 90 days (anchor_dt >= cutoff_refund), so always check status

    if not needs_fields and not needs_refund_check:
        return 0, True, order_name

    eligible_inc = 1

    ship_known_now = bool(ship_date_raw)
    ship_dt = to_dt(ship_date_raw) if ship_date_raw else None

    # -------------------------
    # 14-day FIELD updates
    # -------------------------
    if within_fields_window:
        info = None

        # Ship + carrier if ship missing
        if ship_blank:
            info = get_ship_date_and_carrier(order_id)
            if info and info.get("shipDate"):
                ship_updates.append({"rowIndex": row_index, "value": info["shipDate"]})
                ship_known_now = True
                ship_dt = info.get("shipDt")

                if info.get("carrier"):
                    carrier_updates.append({"rowIndex": row_index, "value": info["carrier"]})

        if ship_known_now:
            # Carrier if ship date present
            if carrier_blank:
                if info is None:
                    info = get_ship_date_and_carrier(order_id)
                if info and info.get("carrier"):
                    carrier_updates.append({"rowIndex": row_index, "value": info["carrier"]})

            # Fulfillment status if shipped and column H is blank
            if fulfill_blank:
                fs = get_fulfillment_status(order_id)
                if fs:
                    fulfill_updates.append({"rowIndex": row_index, "value": fs})

            # Serial if shipped
            if serial_blank:
                mf = fetch_order_metafield(order_id, "custom", "serial_number") or ""
                sn = normalize_serial(mf)
                time.sleep(META_SLEEP_S)
                if sn:
                    serial_updates.append({"rowIndex": row_index, "value": sn})

            # Delivery if shipped + blank + >=24h since ship
            if delivery_blank and ship_dt and shipped_long_enough_for_delivery_check(ship_dt, now_utc):
                dd = get_delivered_date(order_id)
                if dd:
                    delivery_updates.append({"rowIndex": row_index, "value": dd})

    # -------------------------
    # 90-day REFUND check
    # -------------------------
    shop_fin = get_financial_status(order_id)
    if shop_fin == "refunded" and fin_sheet != "refunded":
        fin_status_updates.append({"rowIndex": row_index, "value": "refunded"})

    time.sleep(PER_ORDER_SLEEP_S)
    return eligible_inc, False, order_name

# =========================
# MAIN
# =========================
def main():
    svc = sheets_service()
    last_row = get_last_row(svc)
    if last_row < 2:
        print("No rows to process.")
        return

    now_utc = datetime.now(timezone.utc)
    cutoff_fields = now_utc - timedelta(days=FIELDS_LOOKBACK_DAYS)
    cutoff_refund = now_utc - timedelta(days=REFUND_LOOKBACK_DAYS)

    checked = 0
    eligible = 0
    rows_read = 0
    last_order_name = ""

    ship_updates = []
    carrier_updates = []
    fulfill_updates = []
    serial_updates = []
    delivery_updates = []
    fin_status_updates = []

    ship_total = 0
    carrier_total = 0
    fulfill_total = 0
    serial_total = 0
    delivery_total = 0
    refunded_total = 0

    if UPDATES_SCAN_FROM_BOTTOM:
        end_row = last_row

        while end_row >= 2 and (UPDATES_MAX_ROWS_READ == 0 or rows_read < UPDATES_MAX_ROWS_READ):
            start_row = max(2, end_row - SHEET_READ_CHUNK + 1)

            block = read_block(svc, start_row, end_row, 1, SERIAL_COL)
            rows_read += len(block)
            checked += len(block)

            if not block:
                end_row = start_row - 1
                continue

            newest_anchor = newest_anchor_dt_in_block(block)
            if newest_anchor and newest_anchor < cutoff_refund:
                break

            for i, row in enumerate(block):
                row_index = start_row + i

                inc, _, name = process_row(
                    now_utc, cutoff_fields, cutoff_refund, row_index, row,
                    ship_updates, carrier_updates, fulfill_updates, serial_updates, delivery_updates, fin_status_updates
                )
                eligible += inc
                if inc and name:
                    last_order_name = name

                if MAX_ELIGIBLE_PER_RUN and eligible >= MAX_ELIGIBLE_PER_RUN:
                    break

            ship_total += len(ship_updates)
            carrier_total += len(carrier_updates)
            fulfill_total += len(fulfill_updates)
            serial_total += len(serial_updates)
            delivery_total += len(delivery_updates)
            # ✅ Write shipping updates immediately after each chunk
            flush_shipping_writes(svc, ship_updates, carrier_updates, fulfill_updates, serial_updates, delivery_updates)

            if MAX_ELIGIBLE_PER_RUN and eligible >= MAX_ELIGIBLE_PER_RUN:
                break

            end_row = start_row - 1

    else:
        for start_row in range(2, last_row + 1, SHEET_READ_CHUNK):
            end_row = min(start_row + SHEET_READ_CHUNK - 1, last_row)

            block = read_block(svc, start_row, end_row, 1, SERIAL_COL)
            rows_read += len(block)
            checked += len(block)

            if not block:
                continue

            # Optional break for top-down scan (saves time)
            newest_anchor = newest_anchor_dt_in_block(block)
            if newest_anchor and newest_anchor < cutoff_refund:
                # In top-down, this would mean we're in old territory; but since top-down starts newest? it starts oldest.
                # So we won't break here; keep scanning.
                pass

            for i, row in enumerate(block):
                row_index = start_row + i

                inc, _, name = process_row(
                    now_utc, cutoff_fields, cutoff_refund, row_index, row,
                    ship_updates, carrier_updates, fulfill_updates, serial_updates, delivery_updates, fin_status_updates
                )
                eligible += inc
                if inc and name:
                    last_order_name = name

                if MAX_ELIGIBLE_PER_RUN and eligible >= MAX_ELIGIBLE_PER_RUN:
                    break

            ship_total += len(ship_updates)
            carrier_total += len(carrier_updates)
            fulfill_total += len(fulfill_updates)
            serial_total += len(serial_updates)
            delivery_total += len(delivery_updates)
            # ✅ Write shipping updates immediately after each chunk
            flush_shipping_writes(svc, ship_updates, carrier_updates, fulfill_updates, serial_updates, delivery_updates)

            if MAX_ELIGIBLE_PER_RUN and eligible >= MAX_ELIGIBLE_PER_RUN:
                break

    ship_total += len(ship_updates)
    carrier_total += len(carrier_updates)
    fulfill_total += len(fulfill_updates)
    serial_total += len(serial_updates)
    delivery_total += len(delivery_updates)

    # Final: write any remaining shipping updates
    flush_shipping_writes(
        svc,
        ship_updates,
        carrier_updates,
        fulfill_updates,
        serial_updates,
        delivery_updates,
    )

    refunded_total = len(fin_status_updates)

    # Final: write refunded status updates
    batch_write_single_column(svc, fin_status_updates, FIN_STATUS_COL)

    print(
        f"Updates Complete\n"
        f"Eligible      : {eligible}\n"
        f"Checked       : {checked}\n"
        f"Rows Read     : {rows_read}\n"
        f"Shipping      : {ship_total}\n"
        f"Delivery      : {delivery_total}\n"
        f"Carrier       : {carrier_total}\n"
        f"Fulfillment   : {fulfill_total}\n"
        f"Serial Number : {serial_total}\n"
        f"Refunded      : {refunded_total}\n"
        f"Last Order    : {last_order_name}"
    )

if __name__ == "__main__":
    main()
