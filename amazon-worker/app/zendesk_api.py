import time
import threading
import requests
from app.config import ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET

BASE_URL = f'https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2'

_token_lock = threading.Lock()
_cached_token = None
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
                'grant_type': 'client_credentials',
                'client_id': ZENDESK_CLIENT_ID,
                'client_secret': ZENDESK_CLIENT_SECRET,
                'scope': 'read write',
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        _cached_token = data['access_token']
        _token_expires_at = now + data.get('expires_in', 7200)
        return _cached_token


def _headers():
    return {
        'Authorization': f'Bearer {get_access_token()}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }


def _get(url, params=None):
    while True:
        r = requests.get(url, headers=_headers(), params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(int(r.headers.get('Retry-After', '10')) + 1)
            continue
        if r.status_code == 401:
            get_access_token(force_refresh=True)
            r = requests.get(url, headers=_headers(), params=params, timeout=60)
        r.raise_for_status()
        return r.json()


def _post(url, payload):
    r = requests.post(url, headers=_headers(), json=payload, timeout=60)
    r.raise_for_status()
    return r.json()


def _put(url, payload):
    r = requests.put(url, headers=_headers(), json=payload, timeout=60)
    r.raise_for_status()
    return r.json()


def create_or_update_user(name, email, external_id, phone=None, notes=None):
    data = _get(f'{BASE_URL}/users/search.json', params={'external_id': external_id})
    users = data.get('users', [])
    payload = {
        'name': name,
        'email': email,
        'external_id': external_id,
        'role': 'end-user',
    }
    if phone:
        payload['phone'] = phone
    if notes:
        payload['notes'] = notes
    if users:
        result = _put(f'{BASE_URL}/users/{users[0]["id"]}.json', {'user': payload})
    else:
        result = _post(f'{BASE_URL}/users.json', {'user': payload})
    return result['user']


def ticket_exists(external_id):
    data = _get(f'{BASE_URL}/search.json', params={'query': f'type:ticket external_id:{external_id}'})
    return len(data.get('results', [])) > 0


def create_ticket(subject, body, requester_id=None, tags=None, external_id=None, ticket_type=None):
    payload = {
        'ticket': {
            'subject': subject,
            'comment': {'body': body},
            'tags': tags or [],
        }
    }
    if requester_id:
        payload['ticket']['requester_id'] = requester_id
    if external_id:
        payload['ticket']['external_id'] = external_id
    if ticket_type:
        payload['ticket']['type'] = ticket_type
    return _post(f'{BASE_URL}/tickets.json', payload)['ticket']


def add_comment(ticket_id, body, public=True):
    payload = {
        'ticket': {
            'comment': {
                'body': body,
                'public': public,
            }
        }
    }
    return _put(f'{BASE_URL}/tickets/{ticket_id}.json', payload)['ticket']


def search_tickets(query, per_page=100):
    return _get(f'{BASE_URL}/search.json', params={'query': query, 'per_page': per_page})


def get_ticket_comments(ticket_id):
    return _get(f'{BASE_URL}/tickets/{ticket_id}/comments.json').get('comments', [])
