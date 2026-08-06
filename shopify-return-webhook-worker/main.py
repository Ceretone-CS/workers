#!/usr/bin/env python3
"""
shopify-return-webhook-worker
- refunds/create  → set Zendesk user field 'returned' = true
                    (only fires on physical returns: restock_type == "return")
- orders/create   → clear 'returned' field + remove 'customer__returned' user tag
"""

import base64
import hashlib
import hmac
import json
import os
import time

import requests
from flask import Flask, abort, request

app = Flask(__name__)

SHOPIFY_STORE       = os.environ["SHOPIFY_STORE"]
SHOPIFY_TOKEN       = os.environ["SHOPIFY_TOKEN"]
SHOPIFY_API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2026-01")
WEBHOOK_SECRET      = os.environ["WEBHOOK_SECRET"]
ZENDESK_SUBDOMAIN   = os.environ["ZENDESK_SUBDOMAIN"]
ZD_CLIENT_ID        = os.environ["ZENDESK_CLIENT_ID"]
ZD_CLIENT_SECRET    = os.environ["ZENDESK_CLIENT_SECRET"]
PORT                = int(os.environ.get("PORT", 3006))

SHOPIFY_BASE    = f"https://{SHOPIFY_STORE}/admin/api/{SHOPIFY_API_VERSION}"
SHOPIFY_HEADERS = {"X-Shopify-Access-Token": SHOPIFY_TOKEN}
ZD_BASE         = f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2"

RETURNED_TAG = "customer__returned"

_zd_token            = None
_zd_token_expires_at = 0


def get_zd_token():
    global _zd_token, _zd_token_expires_at
    now = time.time()
    if _zd_token and now < _zd_token_expires_at - 60:
        return _zd_token
    resp = requests.post(
        f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens",
        json={
            "grant_type":    "client_credentials",
            "client_id":     ZD_CLIENT_ID,
            "client_secret": ZD_CLIENT_SECRET,
            "scope":         "read write",
        },
        timeout=30,
    )
    resp.raise_for_status()
    data                 = resp.json()
    _zd_token            = data["access_token"]
    _zd_token_expires_at = now + data.get("expires_in", 7200)
    return _zd_token


def zd_headers():
    return {"Authorization": f"Bearer {get_zd_token()}", "Content-Type": "application/json"}


def verify_hmac(body: bytes, hmac_header: str) -> bool:
    digest   = hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, hmac_header or "")


def is_physical_return(payload: dict) -> bool:
    """True only if at least one refund line item was physically returned to stock."""
    for item in payload.get("refund_line_items", []):
        if item.get("restock_type") == "return":
            return True
    return False


def get_shopify_order(order_id):
    resp = requests.get(
        f"{SHOPIFY_BASE}/orders/{order_id}.json",
        headers=SHOPIFY_HEADERS,
        params={"fields": "id,email,customer"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("order", {})


def find_zd_user(email: str):
    resp = requests.get(
        f"{ZD_BASE}/users/search.json",
        headers=zd_headers(),
        params={"query": f"email:{email}"},
        timeout=30,
    )
    resp.raise_for_status()
    users = resp.json().get("users", [])
    return users[0] if users else None


def set_returned(user_id: int, value: bool):
    resp = requests.put(
        f"{ZD_BASE}/users/{user_id}.json",
        headers=zd_headers(),
        json={"user": {"user_fields": {"returned": value}}},
        timeout=30,
    )
    resp.raise_for_status()


def remove_returned_tag(user_id: int):
    resp = requests.delete(
        f"{ZD_BASE}/users/{user_id}/tags.json",
        headers=zd_headers(),
        json={"tags": [RETURNED_TAG]},
        timeout=30,
    )
    if resp.status_code not in (200, 404):
        resp.raise_for_status()


@app.route("/webhooks/refund", methods=["POST"])
def handle_refund():
    body = request.get_data()
    if not verify_hmac(body, request.headers.get("X-Shopify-Hmac-Sha256", "")):
        abort(401)

    payload = json.loads(body)

    if not is_physical_return(payload):
        print(f"[Refund] Skipped — no physical return line items (order_id={payload.get('order_id')})")
        return "ok", 200

    order_id = payload.get("order_id")
    if not order_id:
        return "ok", 200

    order = get_shopify_order(order_id)
    email = (order.get("customer") or {}).get("email") or order.get("email")
    if not email:
        print(f"[Refund] No email for order {order_id}")
        return "ok", 200

    user = find_zd_user(email)
    if not user:
        print(f"[Refund] No Zendesk user found for {email}")
        return "ok", 200

    set_returned(user["id"], True)
    print(f"[Refund] returned=true for {email} (zd_user={user['id']}, order={order_id})")
    return "ok", 200


@app.route("/webhooks/order", methods=["POST"])
def handle_order():
    body = request.get_data()
    if not verify_hmac(body, request.headers.get("X-Shopify-Hmac-Sha256", "")):
        abort(401)

    payload = json.loads(body)
    email   = (payload.get("customer") or {}).get("email") or payload.get("email")
    if not email:
        return "ok", 200

    user = find_zd_user(email)
    if not user:
        print(f"[Order] No Zendesk user found for {email}")
        return "ok", 200

    if not (user.get("user_fields") or {}).get("returned"):
        print(f"[Order] {email} not marked returned — nothing to clear")
        return "ok", 200

    set_returned(user["id"], False)
    remove_returned_tag(user["id"])
    print(f"[Order] Cleared returned + tag for {email} (zd_user={user['id']})")
    return "ok", 200


@app.route("/health", methods=["GET"])
def health():
    return "ok", 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
