from datetime import datetime, timedelta, date

from app.config import (
    SURVEY_TRIGGER_TAGS,
    SURVEY_SUPPRESSION_TAG,
    SURVEY_LAST_SENT_FIELD_KEY,
    SURVEY_SUPPRESSION_DAYS,
)
from app.zendesk_api import (
    get_user,
    update_user_fields,
    add_user_tags,
    remove_user_tags,
    search_users_by_tag,
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
    if SURVEY_SUPPRESSION_TAG not in (user.get('tags') or []):
        add_user_tags(requester_id, [SURVEY_SUPPRESSION_TAG])
    print(
        f'Recorded survey suppression for requester {requester_id} '
        f'(last_survey_sent={today})',
        flush=True,
    )


def sweep_expired_suppressions():
    cutoff = (datetime.utcnow().date() - timedelta(days=SURVEY_SUPPRESSION_DAYS)).isoformat()
    expired = 0
    for user in search_users_by_tag(SURVEY_SUPPRESSION_TAG):
        last_sent = (user.get('user_fields') or {}).get(SURVEY_LAST_SENT_FIELD_KEY)
        if not last_sent or last_sent <= cutoff:
            remove_user_tags(user['id'], [SURVEY_SUPPRESSION_TAG])
            expired += 1
    if expired:
        print(f'Swept {expired} expired survey suppression tag(s).', flush=True)
