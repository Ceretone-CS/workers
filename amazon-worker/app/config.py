import os

ZENDESK_SUBDOMAIN     = os.getenv('ZENDESK_SUBDOMAIN', '').strip()
ZENDESK_CLIENT_ID     = os.getenv('ZENDESK_CLIENT_ID', '').strip()
ZENDESK_CLIENT_SECRET = os.getenv('ZENDESK_CLIENT_SECRET', '').strip()

AMAZON_REFRESH_TOKEN     = os.getenv('AMAZON_REFRESH_TOKEN', '').strip()
AMAZON_LWA_CLIENT_ID     = os.getenv('AMAZON_LWA_CLIENT_ID', '').strip()
AMAZON_LWA_CLIENT_SECRET = os.getenv('AMAZON_LWA_CLIENT_SECRET', '').strip()
AWS_ACCESS_KEY_ID        = os.getenv('AWS_ACCESS_KEY_ID', '').strip()
AWS_SECRET_ACCESS_KEY    = os.getenv('AWS_SECRET_ACCESS_KEY', '').strip()
AWS_REGION               = os.getenv('AWS_REGION', 'us-east-1').strip()
AMAZON_MARKETPLACE_ID    = os.getenv('AMAZON_MARKETPLACE_ID', 'ATVPDKIKX0DER').strip()

SQS_QUEUE_URL         = os.getenv('SQS_QUEUE_URL', '').strip()
STATE_FILE            = os.getenv('STATE_FILE', '/app/data/state.json').strip()
POLL_INTERVAL_SECONDS = int(os.getenv('POLL_INTERVAL_SECONDS', '300'))
DISCORD_WEBHOOK_URL   = os.getenv('DISCORD_WEBHOOK_URL', '').strip()


def validate_config():
    required = [
        'ZENDESK_SUBDOMAIN', 'ZENDESK_CLIENT_ID', 'ZENDESK_CLIENT_SECRET',
        'AMAZON_REFRESH_TOKEN', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET',
        'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    ]
    missing = [v for v in required if not os.getenv(v, '').strip()]
    if missing:
        raise RuntimeError(f'Missing required env vars: {", ".join(missing)}')
