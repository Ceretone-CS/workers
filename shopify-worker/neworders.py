# worker_append_neworders.py
import json
import os, time, re, requests
from datetime import datetime, timezone, timedelta
from dateutil import parser as dtparser

from google.oauth2 import service_account
from googleapiclient.discovery import build

# ---- ENV ----
SHOPIFY_STORE = os.environ["SHOPIFY_STORE"]
SHOPIFY_TOKEN = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2024-10")

SHEET_ID = os.environ["SHEET_ID"]
SHEET_NAME = os.environ.get("SHEET_NAME", "Shopify Orders3")
GOOGLE_SA_JSON = os.environ["GOOGLE_SA_JSON"]

SHOPIFY_SLEEP = float(os.getenv("SHOPIFY_SLEEP", "0.20"))
WRITE_CHUNK = int(os.getenv("WRITE_CHUNK", "500"))

# Columns
ORDER_ID_COL = 1      # A
ORDER_NAME_COL = 2    # B
ORDER_DATE_COL = 3    # C
SHIP_DATE_COL = 4     # D
DELIVERY_DATE_COL = 5 # E
CARRIER_COL = 6       # F
FIN_STATUS_COL = 7    # G
FULFILL_STATUS_COL = 8# H
CUST_EMAIL_COL = 9    # I
CUST_NAME_COL = 10    # J
LINE_ITEMS_COL = 11   # K
SERIAL_COL = 12       # L

HEADERS = [
    "order_id",
    "order_name",
    "order_date",
    "ship_date",
    "delivery_date",
    "carrier",
    "financial_status",
    "fulfillment_status",
    "customer_email",
    "customer_name",
    "line_items",
    "custom_serial_number",
]

STATE_FILE = "data/state.json"
CURSOR_BUFFER_HOURS = 6
MAX_APPEND_SAFETY = 800  # abort if more than this in one run

def load_state():
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)

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

def safe_str(x) -> str:
    return "" if x is None else str(x)

def sheet_datetime(ts) -> str:
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.strftime("%-m/%-d/%Y %H:%M:%S")
    except Exception:
        return ""

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
        return r.json(), r.headers
    r.raise_for_status()

def parse_next_link(headers):
    link = headers.get("Link") or headers.get("link") or ""
    m = re.search(r'<([^>]+)>;\s*rel="next"', link)
    return m.group(1) if m else ""

def get_page_info(next_url: str):
    if not next_url:
        return ""
    m = re.search(r"[?&]page_info=([^&]+)", next_url)
    return m.group(1) if m else ""

def get_last_row(svc) -> int:
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=f"{SHEET_NAME}!A:A",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    return len(resp.get("values", []))

def get_last_id_and_date(svc):
    last_row = get_last_row(svc)
    if last_row < 2:
        return 0, None, 1  # (last_id, last_dt, last_row)

    rng = f"{SHEET_NAME}!A{last_row}:C{last_row}"
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=rng,
        valueRenderOption="UNFORMATTED_VALUE",
        dateTimeRenderOption="FORMATTED_STRING",
    ).execute()
    vals = resp.get("values", [[]])[0]
    vals = (vals + ["", "", ""])[:3]

    last_id_raw = vals[0]
    last_date_raw = vals[2]

    try:
        last_id = int(float(last_id_raw)) if str(last_id_raw).strip() else 0
    except Exception:
        last_id = 0

    last_dt = to_dt(last_date_raw)
    return last_id, last_dt, last_row

def read_existing_ids_tail(svc, tail_rows: int = 3000) -> set[int]:
    last_row = get_last_row(svc)
    start = max(2, last_row - tail_rows + 1)
    rng = f"{SHEET_NAME}!A{start}:A{last_row}"
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=rng,
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    ids = set()
    for row in resp.get("values", []):
        if not row:
            continue
        try:
            ids.add(int(float(row[0])))
        except Exception:
            pass
    return ids

def append_rows(svc, rows: list[list[str]]):
    if not rows:
        return 0
    resp = svc.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"{SHEET_NAME}!A:A",
        valueInputOption="RAW",
        insertDataOption="INSERT_ROWS",
        body={"values": rows},
    ).execute()
    updates = resp.get("updates", {})
    return updates.get("updatedRows", 0)

def ensure_header(svc):
    resp = svc.spreadsheets().values().get(
        spreadsheetId=SHEET_ID, range=f"{SHEET_NAME}!A1:L1",
        valueRenderOption="UNFORMATTED_VALUE"
    ).execute()
    vals = resp.get("values", [])
    if not vals or not any(vals[0]):
        svc.spreadsheets().values().update(
            spreadsheetId=SHEET_ID,
            range=f"{SHEET_NAME}!A1:L1",
            valueInputOption="RAW",
            body={"values": [HEADERS]},
        ).execute()

def main():
    svc = sheets_service()
    ensure_header(svc)
    max_created_at_seen = None

    last_id, last_dt, last_row = get_last_id_and_date(svc)

    state = load_state()
    cursor_dt = None

    if state.get("last_created_at"):
        cursor_dt = to_dt(state["last_created_at"])

    if cursor_dt:
        created_at_min = (cursor_dt - timedelta(hours=CURSOR_BUFFER_HOURS)).isoformat()
    else:
        # first ever run
        created_at_min = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()

    tail = 5000 if state.get("last_created_at") else 30000
    existing_ids = read_existing_ids_tail(svc, tail_rows=tail)
    seen_this_run = set()

    page_info = None
    fetched = 0
    new_rows = []

    last_order_name = ""
    last_order_id = ""
    last_order_date = ""
    added = 0

    while True:
        if page_info:
            params = {"limit": 250, "page_info": page_info}
        else:
            params = {
                "limit": 250,
                "status": "any",
                "order": "created_at asc",
                "created_at_min": created_at_min,
            }

        data, hdrs = shopify_get("/orders.json", params=params)
        orders = data.get("orders", [])

        for o in orders:
            fetched += 1
            created_raw = o.get("created_at")
            created_dt = to_dt(created_raw)
            if created_dt:
                if not max_created_at_seen or created_dt > max_created_at_seen:
                    max_created_at_seen = created_dt

            oid = o.get("id")
            try:
                oid_int = int(oid)
            except Exception:
                continue

            if oid_int in existing_ids or oid_int in seen_this_run:
                continue

            # Track last order that will actually be appended
            last_order_name = safe_str(o.get("name", ""))
            last_order_id = safe_str(oid_int)
            last_order_date = sheet_datetime(o.get("created_at", ""))

            cust = o.get("customer") or {}
            cust_name = (f"{cust.get('first_name','')} {cust.get('last_name','')}".strip()
                         or safe_str((o.get("billing_address") or {}).get("name",""))).strip()

            items = o.get("line_items") or []
            line_items_str = "; ".join([f"{it.get('title','')} x{it.get('quantity',1)}" for it in items if it])[:50000]

            new_rows.append([
                safe_str(oid_int),
                safe_str(o.get("name","")),
                sheet_datetime(o.get("created_at","")),
                "", "", "",  # ship_date, delivery_date, carrier
                safe_str(o.get("financial_status","")),
                safe_str(o.get("fulfillment_status","")),
                safe_str(o.get("email","")),
                safe_str(cust_name),
                safe_str(line_items_str),
                "",  # serial
            ])

            existing_ids.add(oid_int)
            seen_this_run.add(oid_int)
            added += 1

        next_url = parse_next_link(hdrs)
        page_info = get_page_info(next_url)
        if not page_info:
            break

        time.sleep(SHOPIFY_SLEEP)

    if len(new_rows) > MAX_APPEND_SAFETY:
        print(f"ABORT: Attempting to append {len(new_rows)} rows (exceeds safety threshold).")
        return
    
    appended = 0
    for i in range(0, len(new_rows), WRITE_CHUNK):
        chunk = new_rows[i:i+WRITE_CHUNK]
        appended += append_rows(svc, chunk)
        time.sleep(0.15)

    last_row_written = last_row + appended if appended else last_row

    if max_created_at_seen:
        state["last_created_at"] = max_created_at_seen.isoformat()
        save_state(state)

    print(
        f"New Orders Complete\n"
        f"Orders Added        : {appended}\n"
        f"Last Written Order  : {last_order_name}\n"
        f"Last Order ID       : {last_order_id}\n"
        f"Last Order Date     : {last_order_date}\n"
        f"Last Row Written    : {last_row_written}\n"
        f"Fetched Shopify     : {fetched}\n"
        f"Last Row Written    : {last_row_written}"
    )
    
if __name__ == "__main__":
    main()
