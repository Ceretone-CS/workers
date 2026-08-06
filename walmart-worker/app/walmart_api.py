import base64
import time
import uuid
import requests
from app.config import WALMART_CLIENT_ID, WALMART_CLIENT_SECRET

BASE_URL = "https://marketplace.walmartapis.com"

_token = None
_token_expires_at = 0
_creds_b64 = base64.b64encode(f"{WALMART_CLIENT_ID}:{WALMART_CLIENT_SECRET}".encode()).decode()


def _get_token():
    global _token, _token_expires_at
    now = time.time()
    if _token and now < _token_expires_at - 60:
        return _token
    resp = requests.post(
        f"{BASE_URL}/v3/token",
        headers={
            "Authorization": f"Basic {_creds_b64}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "WM_SVC.NAME": "Walmart Marketplace",
            "WM_QOS.CORRELATION_ID": str(uuid.uuid4()),
        },
        data={"grant_type": "client_credentials"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    _token = data["access_token"]
    _token_expires_at = now + data.get("expires_in", 900)
    return _token


def _headers():
    # Walmart requires both Basic auth + access token on every API call
    return {
        "Authorization": f"Basic {_creds_b64}",
        "WM_SEC.ACCESS_TOKEN": _get_token(),
        "Accept": "application/json",
        "WM_SVC.NAME": "Walmart Marketplace",
        "WM_QOS.CORRELATION_ID": str(uuid.uuid4()),
    }


def _get(path, params=None):
    resp = requests.get(f"{BASE_URL}{path}", headers=_headers(), params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _post(path, payload):
    resp = requests.post(
        f"{BASE_URL}{path}",
        headers={**_headers(), "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_orders(start_date, end_date, limit=200):
    return _get("/v3/orders", params={
        "createdStartDate": start_date,
        "createdEndDate": end_date,
        "limit": limit,
    })


def get_returns(start_date, end_date, limit=200):
    return _get("/v3/returns", params={
        "returnCreationStartDate": start_date,
        "returnCreationEndDate": end_date,
        "limit": limit,
    })
