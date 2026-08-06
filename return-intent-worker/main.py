#!/usr/bin/env python3
"""
Return Intent Worker - runs daily at 3am
Finds Zendesk tickets where a customer mentions return intent in their first 2
inbound messages, cross-references with Shopify Core One Pro orders, and writes
results to the "Return Intent" sheet in Google Sheets.
"""

import json, os, re, time
from datetime import datetime, timezone, timedelta

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build

# ─── Config ───────────────────────────────────────────────────────────────────

ZENDESK_SUBDOMAIN     = os.environ["ZENDESK_SUBDOMAIN"]
ZENDESK_CLIENT_ID     = os.environ["ZENDESK_CLIENT_ID"]
ZENDESK_CLIENT_SECRET = os.environ["ZENDESK_CLIENT_SECRET"]

_zd_cached_token     = None
_zd_token_expires_at = 0

def get_access_token(force_refresh=False):
    global _zd_cached_token, _zd_token_expires_at
    now = time.time()
    if not force_refresh and _zd_cached_token and now < _zd_token_expires_at - 60:
        return _zd_cached_token
    resp = requests.post(
        f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens",
        json={
            "grant_type":    "client_credentials",
            "client_id":     ZENDESK_CLIENT_ID,
            "client_secret": ZENDESK_CLIENT_SECRET,
            "scope":         "read write",
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    _zd_cached_token     = data["access_token"]
    _zd_token_expires_at = now + data.get("expires_in", 7200)
    return _zd_cached_token

SHOPIFY_STORE       = os.environ["SHOPIFY_STORE"]
SHOPIFY_TOKEN       = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2026-01")
GOOGLE_SA_JSON      = os.environ["GOOGLE_SA_JSON"]
SPREADSHEET_ID      = os.environ["SPREADSHEET_ID"]
SPREADSHEET_ID_2    = os.environ.get("SPREADSHEET_ID_2", "")
WORKSHEET_NAME      = os.environ.get("WORKSHEET_NAME", "Return Intent")
STATE_FILE          = os.environ.get("STATE_FILE", "data/state.json")
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")
ZD_SLEEP            = float(os.environ.get("ZD_SLEEP", "0.5"))
SHOPIFY_SLEEP       = float(os.environ.get("SHOPIFY_SLEEP", "0.3"))
LOOKBACK_DAYS       = int(os.environ.get("LOOKBACK_DAYS", "2"))

BACKFILL_START = "2025-08-01T00:00:00Z"

RETURN_RE = re.compile(
    r'\b(return|refund|exchange|send\s+back|sending\s+back|sent\s+back|ship\s+back|shipping\s+back)\b',
    re.IGNORECASE,
)
CORE_ONE_PRO_RE = re.compile(r'core[\s\-]*one[\s\-]*pro', re.IGNORECASE)

HEADERS = [
    "Ticket ID", "Ticket Created (UTC)", "Customer Email",
    "Order Number", "Purchase Date (UTC)", "Days Since Purchase",
    "Trigger Keyword", "Trigger Message",
]

# ─── Discord ──────────────────────────────────────────────────────────────────

def send_discord(msg):
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        requests.post(DISCORD_WEBHOOK_URL, json={"content": msg}, timeout=10)
    except Exception as e:
        print(f"[Discord] Webhook error: {e}")

# ─── State ────────────────────────────────────────────────────────────────────

def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)

# ─── Google Sheets ────────────────────────────────────────────────────────────

def sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)

def ensure_worksheet(svc, sheet_id=None):
    sid = sheet_id or SPREADSHEET_ID
    meta = svc.spreadsheets().get(spreadsheetId=sid).execute()
    for s in meta.get("sheets", []):
        if s["properties"]["title"] == WORKSHEET_NAME:
            return
    body = {"requests": [{"addSheet": {"properties": {"title": WORKSHEET_NAME}}}]}
    svc.spreadsheets().batchUpdate(spreadsheetId=sid, body=body).execute()
    print(f"[Sheets] Created worksheet '{WORKSHEET_NAME}' in {sid}.")

def ensure_headers(svc, sheet_id=None):
    sid = sheet_id or SPREADSHEET_ID
    rng = f"{WORKSHEET_NAME}!A1:H1"
    result = svc.spreadsheets().values().get(
        spreadsheetId=sid, range=rng
    ).execute()
    if result.get("values", [[]])[0] != HEADERS:
        svc.spreadsheets().values().update(
            spreadsheetId=sid, range=rng,
            valueInputOption="RAW", body={"values": [HEADERS]},
        ).execute()

def get_existing_ticket_ids(svc, sheet_id=None):
    sid = sheet_id or SPREADSHEET_ID
    result = svc.spreadsheets().values().get(
        spreadsheetId=sid, range=f"{WORKSHEET_NAME}!A2:A",
    ).execute()
    return {str(r[0]) for r in result.get("values", []) if r}

def get_existing_emails(svc, sheet_id=None):
    """Return lowercase set of customer emails already recorded in the sheet."""
    sid = sheet_id or SPREADSHEET_ID
    result = svc.spreadsheets().values().get(
        spreadsheetId=sid, range=f"{WORKSHEET_NAME}!C2:C",
    ).execute()
    return {str(r[0]).lower() for r in result.get("values", []) if r}

def append_rows(svc, rows, sheet_id=None):
    if not rows:
        return
    sid = sheet_id or SPREADSHEET_ID
    svc.spreadsheets().values().append(
        spreadsheetId=sid,
        range=f"{WORKSHEET_NAME}!A1",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": rows},
    ).execute()
    print(f"[Sheets] Appended {len(rows)} rows to {sid}.")

# ─── Zendesk ──────────────────────────────────────────────────────────────────

ZD_BASE = f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2"
def zd_headers():
    return {
        "Authorization": f"Bearer {get_access_token()}",
        "Content-Type": "application/json",
    }

def zd_get(url, params=None):
    while True:
        r = requests.get(url, headers=zd_headers(), params=params, timeout=60)
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "10")) + 1
            print(f"[ZD] Rate limited, sleeping {wait}s")
            time.sleep(wait)
            continue
        r.raise_for_status()
        time.sleep(ZD_SLEEP)
        return r.json()

def search_tickets(created_after_str):
    """Yield tickets created after created_after_str using incremental cursor export."""
    start_dt = datetime.fromisoformat(created_after_str.replace("Z", "+00:00"))
    start_ts = int(start_dt.timestamp())
    url = f"{ZD_BASE}/incremental/tickets/cursor.json"
    params = {"start_time": start_ts}
    page = 1
    while url:
        print(f"[ZD] Fetching incremental export page {page}...")
        data = zd_get(url, params=params)
        params = None
        for ticket in data.get("tickets", []):
            if ticket.get("status") != "deleted":
                yield ticket
        if data.get("end_of_stream"):
            break
        url = data.get("after_url")
        page += 1

def get_comments(ticket_id):
    data = zd_get(
        f"{ZD_BASE}/tickets/{ticket_id}/comments.json",
        params={"sort_order": "asc"},
    )
    return data.get("comments", [])

def get_user_email(user_id):
    data = zd_get(f"{ZD_BASE}/users/{user_id}.json")
    return (data.get("user") or {}).get("email") or ""

def first_inbound_comments(ticket, comments, limit=2):
    """Return up to `limit` public comments authored by the ticket requester."""
    requester_id = ticket.get("requester_id")
    result = []
    for c in comments:
        if c.get("author_id") == requester_id and c.get("public"):
            result.append(c)
            if len(result) >= limit:
                break
    return result

def find_return_match(comments):
    """Return (keyword, snippet) for first return-intent hit, else None."""
    for c in comments:
        body = (c.get("body") or c.get("plain_body") or "").strip()
        m = RETURN_RE.search(body)
        if m:
            snippet = body[:500].replace("\n", " ")
            return m.group(0).lower(), snippet
    return None

# ─── Shopify ──────────────────────────────────────────────────────────────────

SHOPIFY_BASE = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}"
SHOPIFY_HEADERS = {"X-Shopify-Access-Token": SHOPIFY_TOKEN}
FIELDS = "id,name,created_at,email,line_items"

def shopify_get(endpoint, params=None):
    while True:
        r = requests.get(
            f"{SHOPIFY_BASE}/{endpoint}",
            headers=SHOPIFY_HEADERS, params=params, timeout=60,
        )
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "2")) + 1
            time.sleep(wait)
            continue
        r.raise_for_status()
        time.sleep(SHOPIFY_SLEEP)
        return r.json()

def is_core_one_pro(order):
    for item in order.get("line_items", []):
        if CORE_ONE_PRO_RE.search(item.get("title") or "") or \
           CORE_ONE_PRO_RE.search(item.get("variant_title") or ""):
            return True
    return False

def order_by_number(order_number):
    clean = str(order_number).lstrip("#").strip()
    data = shopify_get("orders.json", params={
        "name": f"#{clean}", "status": "any", "fields": FIELDS,
    })
    for o in data.get("orders", []):
        if is_core_one_pro(o):
            return o
    return None

def order_by_email(email):
    data = shopify_get("orders.json", params={
        "email": email, "status": "any", "fields": FIELDS, "limit": 50,
    })
    orders = sorted(data.get("orders", []), key=lambda o: o.get("created_at", ""), reverse=True)
    for o in orders:
        if is_core_one_pro(o):
            return o
    return None

def extract_order_number(ticket):
    for field in ticket.get("custom_fields", []):
        val = field.get("value")
        if val and isinstance(val, str) and re.match(r'^#?\d{3,}$', val.strip()):
            return val.strip()
    return None

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    state = load_state()

    if "last_run" in state:
        start_dt = datetime.fromisoformat(state["last_run"].replace("Z", "+00:00"))
        start_dt -= timedelta(days=LOOKBACK_DAYS)
    else:
        start_dt = datetime.fromisoformat(BACKFILL_START.replace("Z", "+00:00"))

    start_str = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[Main] Processing tickets created after {start_str}")

    svc = sheets_service()
    ensure_worksheet(svc)
    ensure_headers(svc)
    existing_ids    = get_existing_ticket_ids(svc)
    existing_emails = get_existing_emails(svc)
    if SPREADSHEET_ID_2:
        ensure_worksheet(svc, SPREADSHEET_ID_2)
        ensure_headers(svc, SPREADSHEET_ID_2)
        existing_ids    |= get_existing_ticket_ids(svc, SPREADSHEET_ID_2)
        existing_emails |= get_existing_emails(svc, SPREADSHEET_ID_2)
    print(f"[Sheets] {len(existing_ids)} existing ticket IDs, {len(existing_emails)} existing customer emails across sheet(s).")

    # candidates[email] = (created_at_str, row) — keeps oldest ticket per customer
    candidates = {}
    checked = matched = 0
    errors  = 0

    for ticket in search_tickets(start_str):
        ticket_id = str(ticket["id"])
        checked += 1

        if ticket_id in existing_ids:
            continue

        requester_id = ticket.get("requester_id")
        if not requester_id:
            continue

        try:
            email = get_user_email(requester_id)
        except Exception as e:
            print(f"[ZD] Email lookup failed for requester {requester_id}: {e}")
            errors += 1
            continue

        if not email:
            continue

        try:
            comments = get_comments(ticket_id)
        except Exception as e:
            print(f"[ZD] Comments failed for ticket {ticket_id}: {e}")
            errors += 1
            continue

        inbound = first_inbound_comments(ticket, comments)
        if not inbound:
            continue

        match = find_return_match(inbound)
        if not match:
            continue

        keyword, snippet = match

        # Find Shopify order (Core One Pro only)
        order = None
        order_num = extract_order_number(ticket)
        if order_num:
            order = order_by_number(order_num)
        if not order:
            order = order_by_email(email)
        if not order:
            continue  # not a Shopify Core One Pro customer

        # Calculate days between purchase and ticket
        try:
            purchase_dt = datetime.fromisoformat(order["created_at"].replace("Z", "+00:00"))
            ticket_dt   = datetime.fromisoformat(ticket["created_at"].replace("Z", "+00:00"))
            days_diff   = max(0, (ticket_dt - purchase_dt).days)
        except Exception:
            days_diff = ""

        # Skip if this customer already has a return intent entry in the sheet
        if email.lower() in existing_emails:
            print(f"[Skip] #{ticket_id} | {email} already has a return intent entry")
            existing_ids.add(ticket_id)
            continue

        row = [
            ticket_id,
            ticket["created_at"][:19].replace("T", " "),
            email,
            order.get("name", ""),
            order["created_at"][:19].replace("T", " "),
            days_diff,
            keyword,
            snippet,
        ]
        key = email.lower()
        ticket_created = ticket["created_at"]
        if key not in candidates or ticket_created < candidates[key][0]:
            if key in candidates:
                print(f"[Dedup] #{ticket_id} replaces later ticket for {email} (keeping oldest)")
            candidates[key] = (ticket_created, row)
        else:
            print(f"[Dedup] #{ticket_id} skipped for {email} (older ticket already queued)")
        existing_ids.add(ticket_id)
        matched += 1
        print(f"[Match] #{ticket_id} | {email} | {order.get('name')} | +{days_diff}d | '{keyword}'")

    new_rows = [v[1] for v in candidates.values()]
    print(f"[Main] Checked {checked} tickets, {matched} trigger matches, {len(new_rows)} unique customers to append.")

    if new_rows:
        svc = sheets_service()  # Reconnect — old connection may have timed out during long scan
        append_rows(svc, new_rows)
        if SPREADSHEET_ID_2:
            append_rows(svc, new_rows, SPREADSHEET_ID_2)

    state["last_run"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_state(state)
    print("[Main] Done.")

    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    icon = "⚠️" if errors > 0 else "📊"
    summary = "\n".join([
        f"{icon} RETURN-INTENT-WORKER DAILY SUMMARY",
        "",
        f"Tickets Scanned : {checked}",
        f"Return Matches  : {matched}",
        f"New Rows Added  : {len(new_rows)}",
        f"Errors          : {errors}",
        f"Date: {date}",
    ])
    send_discord(summary)


if __name__ == "__main__":
    main()
