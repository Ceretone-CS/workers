import os, time, math
import requests

from google.oauth2 import service_account
from googleapiclient.discovery import build

SHOPIFY_STORE = os.environ["SHOPIFY_STORE"]
SHOPIFY_TOKEN = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2026-01")

SHEET_ID = os.environ["SHEET_ID"]
SHEET_NAME = os.environ.get("SHEET_NAME", "Shopify Orders3")
GOOGLE_SA_JSON = os.environ["GOOGLE_SA_JSON"]

WRITE_CHUNK = 800  # rows per write call
SHOPIFY_SLEEP = 0.35

from datetime import datetime

def sheet_datetime(ts):
    """Convert Shopify timestamp to Sheets datetime format."""
    if not ts:
        return ""

    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%-m/%-d/%Y %H:%M:%S")
    except Exception:
        return ""

def get_sheet_properties(svc):
    meta = svc.spreadsheets().get(
        spreadsheetId=SHEET_ID,
        fields="sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))"
    ).execute()
    for sh in meta.get("sheets", []):
        props = sh.get("properties", {})
        if props.get("title") == SHEET_NAME:
            return props
    raise RuntimeError(f"Sheet not found: {SHEET_NAME}")

def ensure_rows(svc, needed_rows: int):
    props = get_sheet_properties(svc)
    sheet_id = props["sheetId"]
    current_rows = props["gridProperties"]["rowCount"]
    if current_rows >= needed_rows:
        return

    # Add a bit of headroom
    target_rows = max(needed_rows, current_rows + 5000)

    svc.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={
            "requests": [{
                "updateSheetProperties": {
                    "properties": {
                        "sheetId": sheet_id,
                        "gridProperties": {"rowCount": target_rows}
                    },
                    "fields": "gridProperties.rowCount"
                }
            }]
        }
    ).execute()
    print(f"Expanded sheet rows: {current_rows} -> {target_rows}")

def sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)

def shopify_get(path, params=None):
    url = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}/{path.lstrip('/')}"
    headers = {"X-Shopify-Access-Token": SHOPIFY_TOKEN}
    backoff = 1.0
    for _ in range(6):
        r = requests.get(url, headers=headers, params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(float(r.headers.get("Retry-After","2")))
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
    link = headers.get("Link","")
    for part in link.split(","):
        part = part.strip()
        if 'rel="next"' in part:
            start = part.find("<")+1
            end = part.find(">")
            return part[start:end]
    return None

def get_page_info(next_url):
    if not next_url:
        return None
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(next_url).query)
    return q.get("page_info", [None])[0]

def clear_a2_l(svc):
    svc.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=f"{SHEET_NAME}!A2:L"
    ).execute()

def write_chunk(svc, start_row, values):
    end_row = start_row + len(values) - 1
    rng = f"{SHEET_NAME}!A{start_row}:L{end_row}"
    svc.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=rng,
        valueInputOption="RAW",
        body={"values": values},
    ).execute()

def safe_str(x):
    return "" if x is None else str(x)

def main():
    svc = sheets_service()

    # A:L headers (match your structure)
    headers = [
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

    rows = [headers]

    page_info = None
    fetched = 0

    while True:
        params = {"limit": 250, "status": "any", "order": "created_at asc"}
        if page_info:
            params = {"limit": 250, "page_info": page_info}

        data, hdrs = shopify_get("/orders.json", params=params)
        orders = data.get("orders", [])

        for o in orders:
            fetched += 1
            cust = o.get("customer") or {}
            cust_name = (f"{cust.get('first_name','')} {cust.get('last_name','')}".strip() or safe_str(o.get("billing_address",{}).get("name",""))).strip()

            # Basic line_items string (simple for now; we can refine)
            items = o.get("line_items") or []
            line_items_str = "; ".join([f"{it.get('title','')} x{it.get('quantity',1)}" for it in items if it])[:50000]

            rows.append([
                safe_str(o.get("id","")),
                safe_str(o.get("name","")),
                sheet_datetime(o.get("created_at","")),
                "",  # ship_date (backfill worker fills)
                "",  # delivery_date
                "",  # carrier
                safe_str(o.get("financial_status","")),
                safe_str(o.get("fulfillment_status","")),
                safe_str(o.get("email","")),
                safe_str(cust_name),
                safe_str(line_items_str),
                "",  # serial (backfill worker fills)
            ])

        next_url = parse_next_link(hdrs)
        page_info = get_page_info(next_url)
        if not page_info:
            break
        time.sleep(SHOPIFY_SLEEP)

    print(f"Fetched orders: {fetched}  Rows to write: {len(rows)-1}")

    # Ensure the tab has enough rows before we write chunks
    total_rows_needed = len(rows) + 50  # header + data + padding
    ensure_rows(svc, total_rows_needed)

    # DEBUG: prove current grid size
    props = get_sheet_properties(svc)
    print(
        "DEBUG sheet:", repr(props["title"]),
        "rowCount:", props["gridProperties"]["rowCount"],
        "needed:", total_rows_needed
    )

    # Clear only A2:L (leave other cols / formulas alone)
    clear_a2_l(svc)

    # Clear A2:L only (leave existing formulas/other cols alone)
    clear_a2_l(svc)

    # Write A1:L... in chunks
    start = 1
    i = 0
    while i < len(rows):
        chunk = rows[i:i+WRITE_CHUNK]
        write_chunk(svc, start, chunk)
        start += len(chunk)
        i += WRITE_CHUNK

    print("Full refresh done.")

if __name__ == "__main__":
    main()
