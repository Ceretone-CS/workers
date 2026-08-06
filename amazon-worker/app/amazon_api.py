from sp_api.api import Orders, Messaging
from sp_api.base import Marketplaces
from app.config import (
    AMAZON_REFRESH_TOKEN, AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET,
    AMAZON_MARKETPLACE_ID,
)

# v2.x: credentials dict; AWS keys come from env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
def _creds():
    return {
        'refresh_token': AMAZON_REFRESH_TOKEN,
        'lwa_app_id': AMAZON_LWA_CLIENT_ID,
        'lwa_client_secret': AMAZON_LWA_CLIENT_SECRET,
    }


def get_orders(created_after):
    """Return list of orders created after the given ISO datetime string."""
    api = Orders(marketplace=Marketplaces.US, credentials=_creds())
    resp = api.get_orders(
        CreatedAfter=created_after,
        MarketplaceIds=[AMAZON_MARKETPLACE_ID],
    )
    return resp.payload.get('Orders', [])


def get_order_items(order_id):
    """Return list of line items for a given Amazon order ID."""
    api = Orders(marketplace=Marketplaces.US, credentials=_creds())
    resp = api.get_order_items(order_id)
    return resp.payload.get('OrderItems', [])


def get_available_message_actions(order_id):
    """Return list of message action names available for this order."""
    api = Messaging(marketplace=Marketplaces.US, credentials=_creds())
    try:
        resp = api.get_messaging_actions_for_order(order_id, marketplaceIds=[AMAZON_MARKETPLACE_ID])
        links = resp.payload.get('_links', {}).get('actions', [])
        return [a.get('name', '') for a in links]
    except Exception:
        return []


def send_message(order_id, body_text):
    """
    Send a seller message to the buyer for the given order.

    Amazon's Messaging API restricts which message types are allowed per order
    state. We attempt createUnexpectedProblem as a general-purpose type.
    If the order state doesn't allow it, this will raise.
    """
    api = Messaging(marketplace=Marketplaces.US, credentials=_creds())
    api.create_unexpected_problem(
        order_id,
        body={'text': body_text},
        marketplaceIds=[AMAZON_MARKETPLACE_ID],
    )
