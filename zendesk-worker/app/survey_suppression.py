from datetime import date, timedelta

from app.config import (
    SURVEY_TRIGGER_TAGS,
    SURVEY_LAST_SENT_FIELD_KEY,
    SURVEY_SUPPRESSION_DAYS,
    SURVEY_AUTOMATION_IDS,
)
from app.zendesk_api import (
    get_user,
    update_user_fields,
    get_automation,
    update_automation_conditions,
)


def _today():
    return date.today().isoformat()


def record_survey_if_tagged(ticket):
    tags = {str(t).lower() for t in ticket.get('tags', [])}
    if not tags & SURVEY_TRIGGER_TAGS:
        return

    requester_id = ticket.get('requester_id')
    if not requester_id:
        return

    user = get_user(requester_id)
    current = (user.get('user_fields') or {}).get(SURVEY_LAST_SENT_FIELD_KEY)
    today = _today()

    # Only advance the date forward - never overwrite with an older value,
    # and skip entirely if today's date is already recorded (keeps this
    # idempotent across the overlapping nightly incremental scan windows).
    if current and current >= today:
        return

    update_user_fields(requester_id, {SURVEY_LAST_SENT_FIELD_KEY: today})
    print(
        f'Recorded survey suppression for requester {requester_id} '
        f'(last_survey_sent={today})',
        flush=True,
    )


def refresh_survey_cutoff_conditions():
    """Keep each watched automation's cooldown cutoff date current.

    Each automation has an "any" condition pair on
    requester.custom_fields.last_survey_sent: not_present (never surveyed)
    OR less_than_equal <cutoff> (surveyed long enough ago). The cutoff has
    to be an absolute date, so it's refreshed here daily rather than using
    a relative operator Zendesk doesn't offer for this comparison.
    """
    cutoff = (date.today() - timedelta(days=SURVEY_SUPPRESSION_DAYS)).isoformat()
    field = f'requester.custom_fields.{SURVEY_LAST_SENT_FIELD_KEY}'

    for automation_id in SURVEY_AUTOMATION_IDS:
        automation = get_automation(automation_id)
        if not automation:
            print(f'Automation {automation_id} not found, skipping cutoff refresh.', flush=True)
            continue

        any_conditions = list(automation['conditions'].get('any', []))
        changed = False
        for c in any_conditions:
            if c.get('field') == field and c.get('operator') == 'less_than_equal':
                if c.get('value') != cutoff:
                    c['value'] = cutoff
                    changed = True

        if changed:
            update_automation_conditions(
                automation_id,
                {'all': automation['conditions']['all'], 'any': any_conditions},
                automation['actions'],
            )
            print(f'Refreshed survey cutoff for automation {automation_id} to {cutoff}.', flush=True)
