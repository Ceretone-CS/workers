import time
import threading
import requests
from app.config import (
    ZENDESK_SUBDOMAIN,
    ZENDESK_CLIENT_ID,
    ZENDESK_CLIENT_SECRET,
    REQUEST_SLEEP_SECONDS,
)

BASE_URL = f'https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2'

_token_lock     = threading.Lock()
_cached_token   = None
_token_expires_at = 0

def get_access_token(force_refresh=False):
    global _cached_token, _token_expires_at
    now = time.time()
    with _token_lock:
        if not force_refresh and _cached_token and now < _token_expires_at - 60:
            return _cached_token
        resp = requests.post(
            f'https://{ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens',
            json={
                'grant_type':    'client_credentials',
                'client_id':     ZENDESK_CLIENT_ID,
                'client_secret': ZENDESK_CLIENT_SECRET,
                'scope':         'read write',
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        _cached_token     = data['access_token']
        _token_expires_at = now + data.get('expires_in', 7200)
        return _cached_token

def _headers():
    return {
        'Authorization': f'Bearer {get_access_token()}',
        'Content-Type':  'application/json',
        'Accept':        'application/json',
    }

def _get(url, params=None):
    while True:
        r = requests.get(url, headers=_headers(), params=params, timeout=120)
        if r.status_code == 429:
            retry_after = int(r.headers.get('Retry-After', '10'))
            print(f'Rate limited. Sleeping for {retry_after + 1}s')
            time.sleep(retry_after + 1)
            continue
        if r.status_code == 401:
            # Token may have expired mid-run — refresh once and retry
            get_access_token(force_refresh=True)
            r = requests.get(url, headers=_headers(), params=params, timeout=120)
            if r.status_code == 401:
                raise RuntimeError(f'Zendesk auth failed after token refresh. Response: {r.text}')
        r.raise_for_status()
        time.sleep(REQUEST_SLEEP_SECONDS)
        return r.json()

def iter_incremental_tickets(start_time):
    url = f'{BASE_URL}/incremental/tickets/cursor'
    params = {'start_time': start_time}
    page_num = 0
    total_fetched = 0
    max_generated_timestamp = None

    while url:
        page_num += 1
        print(f'Fetching Zendesk page {page_num}...', flush=True)
        data = _get(url, params=params)
        params = None

        tickets = data.get('tickets', [])
        total_fetched += len(tickets)
        print(
            f'Fetched {len(tickets)} tickets from page {page_num}. '
            f'Running total fetched: {total_fetched}', flush=True
        )

        for ticket in tickets:
            generated_timestamp = ticket.get('generated_timestamp')
            if generated_timestamp is not None:
                if max_generated_timestamp is None or generated_timestamp > max_generated_timestamp:
                    max_generated_timestamp = generated_timestamp
            yield ticket

        if data.get('end_of_stream'):
            print('Reached end of Zendesk incremental stream.')
            break

        after_cursor = data.get('after_cursor')
        if not after_cursor:
            print('No after_cursor returned; stopping stream.')
            break

        url = f'{BASE_URL}/incremental/tickets/cursor?cursor={after_cursor}'

    return max_generated_timestamp

def collect_incremental_tickets(start_time):
    tickets = []
    max_generated_timestamp = None
    for ticket in iter_incremental_tickets(start_time):
        tickets.append(ticket)
        generated_timestamp = ticket.get('generated_timestamp')
        if generated_timestamp is not None:
            if max_generated_timestamp is None or generated_timestamp > max_generated_timestamp:
                max_generated_timestamp = generated_timestamp
    return tickets, max_generated_timestamp

def get_user(user_id):
    return _get(f'{BASE_URL}/users/{user_id}.json').get('user', {})

def list_ticket_fields():
    return _get(f'{BASE_URL}/ticket_fields').get('ticket_fields', [])
