import os

ZENDESK_SUBDOMAIN  = os.getenv('ZENDESK_SUBDOMAIN', '').strip()
ZENDESK_CLIENT_ID  = os.getenv('ZENDESK_CLIENT_ID', '').strip()
ZENDESK_CLIENT_SECRET = os.getenv('ZENDESK_CLIENT_SECRET', '').strip()

GOOGLE_SERVICE_ACCOUNT_FILE = os.getenv('GOOGLE_SERVICE_ACCOUNT_FILE', '/app/service_account.json').strip()
SPREADSHEET_ID = os.getenv('SPREADSHEET_ID', '').strip()

BACKFILL_START_TIME = os.getenv('BACKFILL_START_TIME', '1735689600').strip()
REQUEST_SLEEP_SECONDS = float(os.getenv('REQUEST_SLEEP_SECONDS', '7'))
BATCH_WRITE_SIZE = int(os.getenv('BATCH_WRITE_SIZE', '250'))
STATE_FILE = os.getenv('STATE_FILE', '/app/data/state.json').strip()

WORKER_MODE = os.getenv('WORKER_MODE', 'backfill').strip().lower()
TAGS_WORKSHEET = os.getenv('TAGS_WORKSHEET', 'AllTags').strip()
TICKETS_WORKSHEET = os.getenv('TICKETS_WORKSHEET', 'Tickets').strip()
SHEETS_WRITE_CHUNK_SIZE = int(os.getenv('SHEETS_WRITE_CHUNK_SIZE', '200'))
SHEETS_RETRY_COUNT = int(os.getenv('SHEETS_RETRY_COUNT', '5'))
SHEETS_RETRY_SLEEP_SECONDS = float(os.getenv('SHEETS_RETRY_SLEEP_SECONDS', '5'))
INCREMENTAL_LOOKBACK_SECONDS = int(os.getenv('INCREMENTAL_LOOKBACK_SECONDS', str(3 * 24 * 60 * 60)))
UPDATE_LOOKBACK_DAYS = int(os.getenv('UPDATE_LOOKBACK_DAYS', '30'))

IGNORED_TICKET_FORMS = {
    int(x.strip())
    for x in os.getenv('IGNORED_TICKET_FORMS', '').split(',')
    if x.strip().isdigit()
}

VALID_WORKER_MODES = {'backfill', 'incremental', 'tags', 'tickets'}


def validate_config():
    missing = []
    if not ZENDESK_SUBDOMAIN:
        missing.append('ZENDESK_SUBDOMAIN')
    if not ZENDESK_CLIENT_ID:
        missing.append('ZENDESK_CLIENT_ID')
    if not ZENDESK_CLIENT_SECRET:
        missing.append('ZENDESK_CLIENT_SECRET')
    if not GOOGLE_SERVICE_ACCOUNT_FILE:
        missing.append('GOOGLE_SERVICE_ACCOUNT_FILE')
    if not SPREADSHEET_ID:
        missing.append('SPREADSHEET_ID')
    if not BACKFILL_START_TIME.isdigit():
        missing.append('BACKFILL_START_TIME must be Unix epoch seconds')
    if WORKER_MODE not in VALID_WORKER_MODES:
        missing.append(f'WORKER_MODE must be one of: {chr(44).join(sorted(VALID_WORKER_MODES))}')
    if missing:
        raise RuntimeError(f'Missing required env vars: {chr(44).join(missing)}')
SPREADSHEET_ID_2 = os.getenv("SPREADSHEET_ID_2", "").strip()
