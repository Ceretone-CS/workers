import time
import requests
from app.config import (
    ZENDESK_SUBDOMAIN,
    ZENDESK_OAUTH_ACCESS_TOKEN,
    REQUEST_SLEEP_SECONDS,
)

BASE_URL = f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2"


def _headers():
    return {
        "Authorization": f"Bearer {ZENDESK_OAUTH_ACCESS_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }



def _get(url, params=None):
    while True:
        r = requests.get(url, headers=_headers(), params=params, timeout=120)

        if r.status_code == 429:
            retry_after = int(r.headers.get("Retry-After", "10"))
            print(f"Rate limited. Sleeping for {retry_after + 1}s")
            time.sleep(retry_after + 1)
            continue

        if r.status_code == 401:
            try:
                detail = r.text
            except Exception:
                detail = "<no response body>"
            raise RuntimeError(
                f"Zendesk OAuth token unauthorized or expired. Response: {detail}"
            )

        r.raise_for_status()
        time.sleep(REQUEST_SLEEP_SECONDS)
        return r.json()



def iter_incremental_tickets(start_time):
    url = f"{BASE_URL}/incremental/tickets/cursor"
    params = {"start_time": start_time}
    page_num = 0
    total_fetched = 0
    max_generated_timestamp = None

    while url:
        page_num += 1
        print(f"Fetching Zendesk page {page_num}...", flush=True)
        data = _get(url, params=params)
        params = None

        tickets = data.get("tickets", [])
        total_fetched += len(tickets)
        print(
            f"Fetched {len(tickets)} tickets from page {page_num}. "
            f"Running total fetched: {total_fetched}", flush=True
        )

        for ticket in tickets:
            generated_timestamp = ticket.get("generated_timestamp")
            if generated_timestamp is not None:
                if max_generated_timestamp is None or generated_timestamp > max_generated_timestamp:
                    max_generated_timestamp = generated_timestamp
            yield ticket

        if data.get("end_of_stream"):
            print("Reached end of Zendesk incremental stream.")
            break

        after_cursor = data.get("after_cursor")
        if not after_cursor:
            print("No after_cursor returned; stopping stream.")
            break

        url = f"{BASE_URL}/incremental/tickets/cursor?cursor={after_cursor}"

    return max_generated_timestamp



def collect_incremental_tickets(start_time):
    tickets = []
    max_generated_timestamp = None

    for ticket in iter_incremental_tickets(start_time):
        tickets.append(ticket)
        generated_timestamp = ticket.get("generated_timestamp")
        if generated_timestamp is not None:
            if max_generated_timestamp is None or generated_timestamp > max_generated_timestamp:
                max_generated_timestamp = generated_timestamp

    return tickets, max_generated_timestamp



def get_user(user_id):
    url = f"{BASE_URL}/users/{user_id}.json"
    data = _get(url)
    return data.get("user", {})



def list_ticket_fields():
    url = f"{BASE_URL}/ticket_fields"
    data = _get(url)
    return data.get("ticket_fields", [])
