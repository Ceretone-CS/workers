import time
import gspread
from google.oauth2.service_account import Credentials
from gspread.utils import rowcol_to_a1
from app.config import (
    GOOGLE_SERVICE_ACCOUNT_FILE,
    SPREADSHEET_ID,
    SHEETS_WRITE_CHUNK_SIZE,
    SHEETS_RETRY_COUNT,
    SHEETS_RETRY_SLEEP_SECONDS,
)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def get_spreadsheet():
    creds = Credentials.from_service_account_file(
        GOOGLE_SERVICE_ACCOUNT_FILE,
        scopes=SCOPES,
    )
    client = gspread.authorize(creds)
    return client.open_by_key(SPREADSHEET_ID)



def ensure_headers(ws, headers):
    existing = ws.row_values(1)
    if existing[: len(headers)] != headers:
        ws.update("A1", [headers])



def _ensure_grid_capacity(ws, needed_last_row: int, needed_last_col: int):
    add_rows = max(0, int(needed_last_row) - int(ws.row_count))
    add_cols = max(0, int(needed_last_col) - int(ws.col_count))

    if add_rows:
        ws.add_rows(add_rows)
        print(
            f"Expanded worksheet '{ws.title}' by {add_rows} rows (new max rows: {ws.row_count})",
            flush=True,
        )

    if add_cols:
        ws.add_cols(add_cols)
        print(
            f"Expanded worksheet '{ws.title}' by {add_cols} columns (new max cols: {ws.col_count})",
            flush=True,
        )



def _write_rows_with_update(ws, rows):
    if not rows:
        return

    start_row = len(ws.col_values(1)) + 1
    end_row = start_row + len(rows) - 1
    end_col = len(rows[0])
    _ensure_grid_capacity(ws, end_row, end_col)
    target_range = f"A{start_row}:{rowcol_to_a1(end_row, end_col)}"
    ws.update(target_range, rows, value_input_option="USER_ENTERED")



def append_rows(ws, rows):
    if not rows:
        return

    chunk_size = max(1, SHEETS_WRITE_CHUNK_SIZE)
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        success = False

        for attempt in range(1, SHEETS_RETRY_COUNT + 1):
            try:
                _write_rows_with_update(ws, chunk)
                success = True
                break
            except Exception as e:
                print(
                    f"Sheets write failed on worksheet '{ws.title}' "
                    f"chunk {i + 1}-{i + len(chunk)} attempt {attempt}/{SHEETS_RETRY_COUNT}: {e}",
                    flush=True,
                )
                if attempt < SHEETS_RETRY_COUNT:
                    time.sleep(SHEETS_RETRY_SLEEP_SECONDS * attempt)

        if not success:
            raise RuntimeError(
                f"Failed to write rows to worksheet '{ws.title}' after {SHEETS_RETRY_COUNT} attempts"
            )



def get_existing_ticket_ids(ws):
    values = ws.col_values(1)
    return set(v.strip() for v in values[1:] if v.strip())



def get_existing_tags(ws):
    values = ws.col_values(1)
    return set(v.strip().lower() for v in values[1:] if v.strip())



def sort_sheet_by_column(ws, column_index, direction="asc", start_row=2):
    direction = (direction or "asc").lower()
    if direction not in {"asc", "des"}:
        direction = "asc"

    sort_order = "ASCENDING" if direction == "asc" else "DESCENDING"
    start_row_index = max(0, int(start_row) - 1)

    ws.spreadsheet.batch_update(
        {
            "requests": [
                {
                    "sortRange": {
                        "range": {
                            "sheetId": ws.id,
                            "startRowIndex": start_row_index,
                        },
                        "sortSpecs": [
                            {
                                "dimensionIndex": max(0, int(column_index) - 1),
                                "sortOrder": sort_order,
                            }
                        ],
                    }
                }
            ]
        }
    )


def sort_sheet_by_col_a(ws):
    sort_sheet_by_column(ws, 1, "asc", start_row=2)
