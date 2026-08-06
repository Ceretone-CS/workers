import os

ZENDESK_SUBDOMAIN     = os.getenv('ZENDESK_SUBDOMAIN', '').strip()
ZENDESK_CLIENT_ID     = os.getenv('ZENDESK_CLIENT_ID', '').strip()
ZENDESK_CLIENT_SECRET = os.getenv('ZENDESK_CLIENT_SECRET', '').strip()

WALMART_CLIENT_ID     = os.getenv('WALMART_CLIENT_ID', '').strip()
WALMART_CLIENT_SECRET = os.getenv('WALMART_CLIENT_SECRET', '').strip()

STATE_FILE            = os.getenv('STATE_FILE', '/app/data/state.json').strip()
POLL_INTERVAL_SECONDS = int(os.getenv('POLL_INTERVAL_SECONDS', '300'))
DISCORD_WEBHOOK_URL   = os.getenv('DISCORD_WEBHOOK_URL', '').strip()
ZENDESK_BOT_USER_EMAIL = os.getenv('ZENDESK_BOT_USER_EMAIL', '').strip()


def validate_config():
    missing = [
        v for v in [
            'ZENDESK_SUBDOMAIN', 'ZENDESK_CLIENT_ID', 'ZENDESK_CLIENT_SECRET',
            'WALMART_CLIENT_ID', 'WALMART_CLIENT_SECRET',
        ]
        if not os.getenv(v, '').strip()
    ]
    if missing:
        raise RuntimeError(f'Missing required env vars: {chr(44).join(missing)}')
