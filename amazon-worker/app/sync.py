import json
import os
import time
from datetime import datetime, timezone, timedelta

import requests

from app import amazon_api, zendesk_api
from app.config import STATE_FILE, POLL_INTERVAL_SECONDS, DISCORD_WEBHOOK_URL, SQS_QUEUE_URL, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY


def _load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {
        'last_order_poll': week_ago,
        'processed_ids': [],
        'sent_comment_ids': [],
    }


def _save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def _discord(msg):
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        requests.post(DISCORD_WEBHOOK_URL, json={'content': msg}, timeout=10)
    except Exception:
        pass


def _now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _format_address(ship):
    parts = [
        ship.get('AddressLine1', ''),
        ship.get('AddressLine2', ''),
        ship.get('City', ''),
        ship.get('StateOrRegion', ''),
        ship.get('PostalCode', ''),
        ship.get('CountryCode', ''),
    ]
    return '\n'.join(p for p in parts if p)


def _format_items(order_id):
    try:
        items = amazon_api.get_order_items(order_id)
        lines = [
            f"- {i.get('Title', 'Item')} (SKU: {i.get('SellerSKU', 'N/A')}, Qty: {i.get('QuantityOrdered', 1)})"
            for i in items
        ]
        return '\n'.join(lines)
    except Exception:
        return ''


def _sync_orders(state):
    """Create Zendesk users and order tickets from new Amazon orders."""
    start = state['last_order_poll']
    now_iso = _now_iso()
    processed = set(state.get('processed_ids', []))
    new_count = 0

    print(f'Polling Amazon orders since {start}...', flush=True)
    try:
        orders = amazon_api.get_orders(start)
    except Exception as e:
        print(f'  Error fetching orders: {e}', flush=True)
        return

    for order in orders:
        order_id = order.get('AmazonOrderId', '')
        key = f'order_{order_id}'
        if not order_id or key in processed:
            continue

        buyer_info  = order.get('BuyerInfo', {})
        email       = buyer_info.get('BuyerEmail', '')
        name        = buyer_info.get('BuyerName', '') or 'Amazon Customer'
        ship        = order.get('ShippingAddress', {})
        phone       = ship.get('Phone', '') or None
        order_date  = order.get('PurchaseDate', '')
        status      = order.get('OrderStatus', '')
        total_info  = order.get('OrderTotal', {})
        total_str   = f"{total_info.get('Amount', '?')} {total_info.get('CurrencyCode', 'USD')}" if total_info else 'N/A'

        if not email:
            processed.add(key)
            continue

        try:
            zd_user = zendesk_api.create_or_update_user(
                name=name,
                email=email,
                external_id=f'amazon_buyer_{email}',
                phone=phone,
                notes=f'Amazon buyer | Order: {order_id} | Date: {order_date}',
            )
        except Exception as e:
            print(f'  Error creating Zendesk user for order {order_id}: {e}', flush=True)
            continue

        external_id = f'amazon_order_{order_id}'
        if zendesk_api.ticket_exists(external_id):
            processed.add(key)
            continue

        items_text = _format_items(order_id)
        body = (
            f'Amazon Order ID: {order_id}\n'
            f'Customer: {name}\n'
            f'Email: {email}\n'
            f'Order Date: {order_date}\n'
            f'Status: {status}\n'
            f'Total: {total_str}\n'
            f'\nShipping Address:\n{_format_address(ship)}'
        )
        if items_text:
            body += f'\n\nItems:\n{items_text}'

        try:
            ticket = zendesk_api.create_ticket(
                subject=f'Amazon Order -- {name} -- #{order_id}',
                body=body,
                requester_id=zd_user['id'],
                tags=['amazon', 'amazon-order', f'amazon-order-{order_id}'],
                external_id=external_id,
                ticket_type='question',
            )
            processed.add(key)
            new_count += 1
            print(f'  Ticket #{ticket["id"]} created for order {order_id}', flush=True)
        except Exception as e:
            print(f'  Error creating ticket for order {order_id}: {e}', flush=True)

    state['processed_ids'] = list(processed)[-5000:]
    state['last_order_poll'] = now_iso
    if new_count:
        _discord(f'Amazon: {new_count} new order(s) → Zendesk tickets created')


def _sync_messages(state):
    """Poll SQS for incoming Amazon buyer messages and add as Zendesk ticket comments."""
    if not SQS_QUEUE_URL:
        return

    import boto3
    sqs = boto3.client(
        'sqs',
        region_name=AWS_REGION,
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    )
    sent = set(state.get('sent_comment_ids', []))

    try:
        response = sqs.receive_message(
            QueueUrl=SQS_QUEUE_URL,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=2,
        )
    except Exception as e:
        print(f'  SQS receive error: {e}', flush=True)
        return

    for msg in response.get('Messages', []):
        receipt = msg['ReceiptHandle']
        try:
            outer = json.loads(msg['Body'])
            # SP-API wraps in an SNS envelope; unwrap if needed
            inner_str = outer.get('Message', '') if isinstance(outer.get('Message'), str) else ''
            notification = json.loads(inner_str) if inner_str else outer

            notif_type = notification.get('notificationType', '')
            if 'MESSAGING_NEW_MESSAGE' in notif_type:
                _handle_buyer_message(notification, sent)
        except Exception as e:
            print(f'  Error processing SQS message: {e}', flush=True)

        sqs.delete_message(QueueUrl=SQS_QUEUE_URL, ReceiptHandle=receipt)

    state['sent_comment_ids'] = list(sent)[-5000:]


def _handle_buyer_message(notification, sent):
    payload  = notification.get('payload', notification)
    order_id = payload.get('AmazonOrderId', '') or payload.get('orderId', '')
    msg_text = payload.get('MessageText', '') or payload.get('messageText', '')
    msg_id   = str(payload.get('MessageId', '') or payload.get('messageId', ''))

    if not order_id or not msg_text:
        return
    if msg_id and msg_id in sent:
        return

    try:
        results = zendesk_api.search_tickets(f'type:ticket tags:amazon-order-{order_id}')
        tickets = results.get('results', [])
    except Exception as e:
        print(f'  Error searching tickets for order {order_id}: {e}', flush=True)
        return

    if not tickets:
        print(f'  No Zendesk ticket found for Amazon order {order_id} — skipping message', flush=True)
        return

    ticket_id = tickets[0]['id']
    try:
        zendesk_api.add_comment(ticket_id, f'[Amazon Buyer Message]\n\n{msg_text}', public=True)
        print(f'  Buyer message for order {order_id} added to ticket #{ticket_id}', flush=True)
        if msg_id:
            sent.add(msg_id)
    except Exception as e:
        print(f'  Error adding comment to ticket #{ticket_id}: {e}', flush=True)


def _sync_replies(state):
    """
    Push agent replies on Amazon tickets back to the buyer via Amazon Messaging API.

    Amazon's Messaging API only allows specific message types (not free-form replies).
    We use createUnexpectedProblem as the general-purpose type. If the order state
    doesn't allow it, the send is skipped and logged.
    """
    sent = set(state.get('sent_comment_ids', []))
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).strftime('%Y-%m-%d')

    print('Checking for pending Amazon replies...', flush=True)
    try:
        results = zendesk_api.search_tickets(
            f'type:ticket tags:amazon-order status:open updated>{cutoff}'
        )
        tickets = results.get('results', [])
    except Exception as e:
        print(f'  Error searching tickets: {e}', flush=True)
        return

    for ticket in tickets:
        ticket_id   = ticket['id']
        external_id = ticket.get('external_id', '')
        if not external_id.startswith('amazon_order_'):
            continue
        order_id = external_id.replace('amazon_order_', '')

        try:
            comments = zendesk_api.get_ticket_comments(ticket_id)
        except Exception as e:
            print(f'  Error fetching comments for ticket #{ticket_id}: {e}', flush=True)
            continue

        for comment in comments:
            comment_id  = str(comment['id'])
            if comment_id in sent:
                continue
            if not comment.get('public'):
                sent.add(comment_id)
                continue
            # Only agent-written comments (via web or api, not inbound email/end-user)
            via_channel = comment.get('via', {}).get('channel', '')
            if via_channel not in ('web', 'api'):
                sent.add(comment_id)
                continue

            body = comment.get('body', '').strip()
            if body and not body.startswith('[Amazon Buyer Message]'):
                try:
                    amazon_api.send_message(order_id, body)
                    print(f'  Reply for order {order_id} sent to Amazon buyer', flush=True)
                except Exception as e:
                    print(f'  Could not send reply for order {order_id}: {e}', flush=True)
            sent.add(comment_id)

    state['sent_comment_ids'] = list(sent)[-5000:]


def run_loop():
    state = _load_state()
    print('amazon-worker started.', flush=True)
    if not SQS_QUEUE_URL:
        print('NOTE: SQS_QUEUE_URL not set — buyer message sync disabled until configured.', flush=True)
    while True:
        try:
            _sync_orders(state)
            _sync_messages(state)
            _sync_replies(state)
            _save_state(state)
        except Exception as e:
            print(f'Unhandled error: {e}', flush=True)
            _discord(f'amazon-worker error: {e}')
        print(f'Sleeping {POLL_INTERVAL_SECONDS}s...', flush=True)
        time.sleep(POLL_INTERVAL_SECONDS)
