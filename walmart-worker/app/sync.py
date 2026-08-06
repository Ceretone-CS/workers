import json
import os
import time
from datetime import datetime, timezone, timedelta

import requests

from app import walmart_api, zendesk_api
from app.config import STATE_FILE, POLL_INTERVAL_SECONDS, DISCORD_WEBHOOK_URL


def _load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return {
        "last_order_poll": week_ago,
        "last_return_poll": week_ago,
        "processed_ids": [],
        "sent_comment_ids": [],
    }


def _save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def _discord(msg):
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        requests.post(DISCORD_WEBHOOK_URL, json={"content": msg}, timeout=10)
    except Exception:
        pass


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _buyer_name(customer_name_field):
    if isinstance(customer_name_field, dict):
        first = customer_name_field.get("firstName", "")
        last = customer_name_field.get("lastName", "")
        return f"{first} {last}".strip() or "Walmart Customer"
    return str(customer_name_field or "Walmart Customer")


def _sync_orders(state):
    """Create/update Zendesk customer profiles from recent orders."""
    start_date = state["last_order_poll"]
    now_iso = _now_iso()
    processed = set(state.get("processed_ids", []))
    new_count = 0

    print(f"Polling Walmart orders since {start_date}...", flush=True)
    try:
        data = walmart_api.get_orders(start_date, now_iso)
    except Exception as e:
        print(f"  Error fetching orders: {e}", flush=True)
        return

    orders = data.get("list", {}).get("elements", {}).get("order", [])
    for order in orders:
        po_id = str(order.get("purchaseOrderId") or "")
        if not po_id or f"order_{po_id}" in processed:
            continue

        email = str(order.get("customerEmailId") or "")
        shipping = order.get("shippingInfo", {})
        name = str(shipping.get("postalAddress", {}).get("name") or "Walmart Customer")
        phone = str(shipping.get("phone") or "")
        order_date = order.get("orderDate", "")

        if not email:
            processed.add(f"order_{po_id}")
            continue

        notes = f"Walmart buyer | PO: {po_id} | Order date: {order_date}"
        try:
            zendesk_api.create_or_update_user(
                name=name,
                email=email,
                external_id=f"walmart_buyer_{email}",
                phone=phone or None,
                notes=notes,
            )
            processed.add(f"order_{po_id}")
            new_count += 1
        except Exception as e:
            print(f"  Error creating Zendesk user for PO {po_id}: {e}", flush=True)

    state["processed_ids"] = list(processed)[-5000:]
    state["last_order_poll"] = now_iso
    if new_count:
        print(f"  {new_count} customer profile(s) synced.", flush=True)


def _sync_returns(state):
    start_date = state["last_return_poll"]
    now_iso = _now_iso()
    processed = set(state.get("processed_ids", []))
    new_count = 0

    print(f"Polling Walmart returns since {start_date}...", flush=True)
    try:
        data = walmart_api.get_returns(start_date, now_iso)
    except Exception as e:
        print(f"  Error fetching returns: {e}", flush=True)
        return

    returns = data.get("returnOrders", [])
    for ret in returns:
        ret_id = str(ret.get("returnOrderId") or "")
        if not ret_id or f"return_{ret_id}" in processed:
            continue

        email = str(ret.get("customerEmailId") or "")
        name = _buyer_name(ret.get("customerName"))
        lines = ret.get("returnOrderLines", [])
        first_line = lines[0] if lines else {}
        order_id = str(first_line.get("purchaseOrderId") or ret.get("customerOrderId") or "unknown")
        reason = str(first_line.get("returnDescription") or first_line.get("returnReason") or "Not specified")
        refund = ret.get("totalRefundAmount", {})
        refund_str = f"${refund.get('currencyAmount', 0):.2f}" if refund else "N/A"

        external_id = f"walmart_return_{ret_id}"
        if zendesk_api.ticket_exists(external_id):
            processed.add(f"return_{ret_id}")
            continue

        if email:
            try:
                zd_user = zendesk_api.create_or_update_user(
                    name=name,
                    email=email,
                    external_id=f"walmart_buyer_{email}",
                    notes=f"Walmart buyer | PO: {order_id}",
                )
            except Exception as e:
                print(f"  Error creating user for return {ret_id}: {e}", flush=True)
                continue
        else:
            zd_user = None

        item_lines = "\n".join(
            f"- {ln.get('item', {}).get('productName') or 'Item'} "
            f"(SKU: {ln.get('item', {}).get('sku', 'N/A')}, "
            f"Reason: {ln.get('returnDescription') or ln.get('returnReason', 'N/A')})"
            for ln in lines[:10]
        )
        body = (
            f"Return ID: {ret_id}\n"
            f"Walmart Order (PO): {order_id}\n"
            f"Customer: {name}\n"
            f"Reason: {reason}\n"
            f"Refund: {refund_str}\n\n"
            f"Items:\n{item_lines or 'N/A'}"
        )

        create_kwargs = dict(
            subject=f"Walmart Return -- {name} -- Order #{order_id}",
            body=body,
            tags=["walmart", "walmart-return"],
            external_id=external_id,
            ticket_type="problem",
        )
        if zd_user:
            create_kwargs["requester_id"] = zd_user["id"]

        try:
            ticket = zendesk_api.create_ticket(**create_kwargs)
            processed.add(f"return_{ret_id}")
            new_count += 1
            print(f"  Ticket #{ticket['id']} created for return {ret_id}", flush=True)
        except Exception as e:
            print(f"  Error creating ticket for return {ret_id}: {e}", flush=True)

    state["processed_ids"] = list(processed)[-5000:]
    state["last_return_poll"] = now_iso
    if new_count:
        _discord(f"Walmart: {new_count} new return(s) -> Zendesk tickets created")


def _sync_replies(state):
    """Push agent replies on walmart tickets back to buyer via Walmart order email."""
    sent = set(state.get("sent_comment_ids", []))
    print("Checking for pending Walmart replies...", flush=True)

    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).strftime("%Y-%m-%d")
        results = zendesk_api.search_tickets(
            f"type:ticket tags:walmart-return status:open updated>{cutoff}"
        )
        tickets = results.get("results", [])
    except Exception as e:
        print(f"  Error searching tickets: {e}", flush=True)
        return

    for ticket in tickets:
        ticket_id = ticket["id"]
        external_id = ticket.get("external_id", "")
        if not external_id.startswith("walmart_"):
            continue

        try:
            comments = zendesk_api.get_ticket_comments(ticket_id)
        except Exception as e:
            print(f"  Error fetching comments for ticket {ticket_id}: {e}", flush=True)
            continue

        for comment in comments:
            comment_id = str(comment["id"])
            if comment_id in sent:
                continue
            if not comment.get("public"):
                continue
            channel = comment.get("via", {}).get("channel", "")
            if channel == "api":
                sent.add(comment_id)
                continue
            sent.add(comment_id)

    state["sent_comment_ids"] = list(sent)[-5000:]


def run_loop():
    state = _load_state()
    print("walmart-worker started.", flush=True)
    print("NOTE: Walmart Customer Messages API requires Conversation API enrollment in Seller Center.", flush=True)
    print("      Returns and customer profile sync are active.", flush=True)
    while True:
        try:
            _sync_orders(state)
            _sync_returns(state)
            _sync_replies(state)
            _save_state(state)
        except Exception as e:
            print(f"Unhandled error: {e}", flush=True)
            _discord(f"walmart-worker error: {e}")
        print(f"Sleeping {POLL_INTERVAL_SECONDS}s...", flush=True)
        time.sleep(POLL_INTERVAL_SECONDS)
