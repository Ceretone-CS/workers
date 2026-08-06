#!/usr/bin/env python3
"""
Sheets Metrics Exporter
Reads Shopify Orders + Return Log from Google Sheets every 30 min,
exposes Core One Pro monthly sales and returns as Prometheus gauges.
"""

import os, re, time, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timedelta
from google.oauth2 import service_account
from googleapiclient.discovery import build

GOOGLE_SA_JSON = os.environ["GOOGLE_SA_JSON"]
SPREADSHEET_ID = os.environ["SPREADSHEET_ID"]
ORDERS_SHEET   = os.environ.get("ORDERS_SHEET", "Shopify Orders")
RETURNS_SHEET  = os.environ.get("RETURNS_SHEET", "Return Log")
PORT           = int(os.environ.get("PORT", "9200"))
REFRESH_SECS   = int(os.environ.get("REFRESH_SECS", "1800"))

# Core One Pro device line item (excludes accessories that mention "Core One Pro Exclusive")
COP_ITEM_RE    = re.compile(r'core one pro \(invisible-in-canal\)\s+x(\d+)', re.IGNORECASE)
COP_RETURN_RE  = re.compile(r'core one pro', re.IGNORECASE)

# Google Sheets/Excel date serial epoch (serial 0 = Dec 30 1899)
SHEETS_EPOCH = datetime(1899, 12, 30)

_metrics_text = "# initializing\n"
_json_text = "[]"
_lock = threading.Lock()


def sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_JSON,
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def parse_sheet_date(val):
    """Parse a Sheets UNFORMATTED_VALUE cell into a datetime with date+time
    preserved (date-only formats come back at midnight)."""
    if isinstance(val, (int, float)):
        try:
            return SHEETS_EPOCH + timedelta(days=float(val))
        except (OverflowError, ValueError):
            return None
    s = str(val).strip()
    if len(s) == 6 and s.isdigit():
        yy, mm, dd = int(s[0:2]), int(s[2:4]), int(s[4:6])
        if 1 <= mm <= 12:
            try:
                return datetime(2000 + yy, mm, dd)
            except ValueError:
                return None
    for fmt in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def get_all(svc, sheet, col_range):
    return svc.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range=f"{sheet}!{col_range}",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute().get("values", [])


def compute_metrics():
    svc = sheets_service()

    # ── Sales ─────────────────────────────────────────────────────────
    sales_by_month = {}
    for row in get_all(svc, ORDERS_SHEET, "A:K")[1:]:
        if len(row) < 11:
            continue
        dt = parse_sheet_date(row[2])
        if not dt:
            continue
        for m in COP_ITEM_RE.finditer(str(row[10])):
            key = f"{dt.year}-{dt.month:02d}"
            sales_by_month[key] = sales_by_month.get(key, 0) + int(m.group(1))

    # ── Returns ───────────────────────────────────────────────────────
    returns_by_month = {}
    for row in get_all(svc, RETURNS_SHEET, "A:K")[1:]:
        if len(row) < 11:
            continue
        row_type = str(row[5]).strip().lower() if len(row) > 5 else ""
        if row_type not in ("return", "exchange"):
            continue
        product = str(row[10]) if len(row) > 10 else ""
        if not COP_RETURN_RE.search(product):
            continue
        dt = parse_sheet_date(row[0])
        if not dt:
            continue
        key = f"{dt.year}-{dt.month:02d}"
        returns_by_month[key] = returns_by_month.get(key, 0) + 1

    # ── JSON for Infinity datasource ─────────────────────────────────
    all_months = sorted(set(list(sales_by_month.keys()) + list(returns_by_month.keys())))
    json_rows = [
        {"month": m, "sales": sales_by_month.get(m, 0), "returns": returns_by_month.get(m, 0)}
        for m in all_months
    ]
    import json as _json
    json_out = _json.dumps(json_rows)

    # ── Prometheus text ───────────────────────────────────────────────
    lines = [
        "# HELP ceretone_monthly_sales_units Core One Pro units sold per calendar month",
        "# TYPE ceretone_monthly_sales_units gauge",
    ]
    for k, v in sorted(sales_by_month.items()):
        lines.append(f'ceretone_monthly_sales_units{{month="{k}"}} {v}')

    lines += [
        "# HELP ceretone_monthly_returns Core One Pro returns (return+exchange) per calendar month",
        "# TYPE ceretone_monthly_returns gauge",
    ]
    for k, v in sorted(returns_by_month.items()):
        lines.append(f'ceretone_monthly_returns{{month="{k}"}} {v}')

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    lines += [
        f'# HELP ceretone_metrics_last_refresh_timestamp_seconds Unix timestamp of last successful refresh',
        f'# TYPE ceretone_metrics_last_refresh_timestamp_seconds gauge',
        f'ceretone_metrics_last_refresh_timestamp_seconds {int(time.time())}',
        f'# last refresh: {ts}',
    ]
    return "\n".join(lines) + "\n", json_out


def refresh_loop():
    global _metrics_text, _json_text
    while True:
        try:
            print(f"[{datetime.utcnow().isoformat()}Z] Refreshing...", flush=True)
            text, json_out = compute_metrics()
            with _lock:
                _metrics_text = text
                _json_text = json_out
            print(f"[{datetime.utcnow().isoformat()}Z] Done.", flush=True)
        except Exception as e:
            print(f"[ERROR] {e}", flush=True)
        time.sleep(REFRESH_SECS)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics":
            with _lock:
                body = _metrics_text.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/data":
            with _lock:
                body = _json_text.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/", "/health"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    try:
        text, json_out = compute_metrics()
        with _lock:
            _metrics_text = text
            _json_text = json_out
        print("Initial metrics computed.", flush=True)
    except Exception as e:
        print(f"Initial compute failed: {e}", flush=True)

    threading.Thread(target=refresh_loop, daemon=True).start()
    print(f"Listening on :{PORT}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
