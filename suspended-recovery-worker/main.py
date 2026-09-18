import os
import sys
import time
import requests

ZENDESK_SUBDOMAIN = os.environ["ZENDESK_SUBDOMAIN"]
ZENDESK_CLIENT_ID = os.environ["ZENDESK_CLIENT_ID"]
ZENDESK_CLIENT_SECRET = os.environ["ZENDESK_CLIENT_SECRET"]
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

# The recurring offender: info@ceretone.com's Zendesk end-user record periodically
# gets marked `suspended` by Zendesk's spam heuristic (it's a real Exchange mailbox
# with an auto-forward rule that relays everything to Zendesk's raw address, which
# generates bursts of near-identical mail). See memory: project_zendesk_suspended_ceretone.md
SUPPORT_USER_ID = 28996127680020
SUPPORT_EMAIL = "info@ceretone.com"

BASE_URL = f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2"
RECOVER_CHUNK_SIZE = 40  # recover_many has been observed to time out around ~90 ids in one call


def get_token():
    resp = requests.post(
        f"https://{ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens",
        json={
            "grant_type": "client_credentials",
            "client_id": ZENDESK_CLIENT_ID,
            "client_secret": ZENDESK_CLIENT_SECRET,
            "scope": "read write",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def notify_discord(msg):
    if not DISCORD_WEBHOOK_URL:
        return
    try:
        requests.post(DISCORD_WEBHOOK_URL, json={"content": msg}, timeout=10)
    except Exception as e:
        print(f"[Discord] Webhook error: {e}")


def is_order_or_registration(subject):
    subject = (subject or "").strip()
    if "[Ceretone Hearing Aids] Order" in subject:
        return True
    if "Registration" in subject and "form has a new submission" in subject:
        return True
    return False


def fetch_all_suspended(headers):
    all_tickets = []
    url = f"{BASE_URL}/suspended_tickets.json"
    params = {"per_page": 100}
    while url:
        r = requests.get(url, headers=headers, params=params, timeout=60)
        r.raise_for_status()
        data = r.json()
        all_tickets.extend(data.get("suspended_tickets", []))
        url = data.get("next_page")
        params = None
        time.sleep(0.3)
    return all_tickets


def recover_ids(headers, ids):
    recovered, failed = [], []
    for i in range(0, len(ids), RECOVER_CHUNK_SIZE):
        chunk = ids[i : i + RECOVER_CHUNK_SIZE]
        url = f"{BASE_URL}/suspended_tickets/recover_many.json?ids={','.join(str(x) for x in chunk)}"
        try:
            r = requests.put(url, headers=headers, timeout=90)
            r.raise_for_status()
            body = r.json()
            recovered.extend(body.get("tickets", []))
            failed.extend(body.get("suspended_tickets", []))
        except requests.exceptions.RequestException as e:
            # Per memory gotcha: recover_many can time out server-side while still
            # succeeding — don't assume failure, just note it and let the next run's
            # fresh fetch reconcile whatever actually went through.
            print(f"[recover_many] request error on chunk {chunk}: {e}")
        time.sleep(0.5)
    return recovered, failed


def main():
    headers_base = None
    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    headers_write = {**headers, "Content-Type": "application/json"}

    # Step 1: fix the user-level suspension if present (independent of the tickets queue)
    r = requests.get(f"{BASE_URL}/users/{SUPPORT_USER_ID}.json", headers=headers, timeout=30)
    r.raise_for_status()
    was_suspended = r.json()["user"]["suspended"]
    if was_suspended:
        r2 = requests.put(
            f"{BASE_URL}/users/{SUPPORT_USER_ID}.json",
            headers=headers_write,
            json={"user": {"suspended": False}},
            timeout=30,
        )
        r2.raise_for_status()
        print(f"Unsuspended {SUPPORT_EMAIL} (user id {SUPPORT_USER_ID})")

    # Step 2: pull the suspended-tickets queue and scope to this sender only.
    # (Other senders' spam is out of scope for this worker — don't touch it.)
    all_suspended = fetch_all_suspended(headers)
    from_support = [
        t for t in all_suspended
        if (t.get("author", {}).get("email") or "").lower() == SUPPORT_EMAIL
    ]

    safe = [t for t in from_support if is_order_or_registration(t.get("subject"))]
    ambiguous = [t for t in from_support if not is_order_or_registration(t.get("subject"))]

    recovered, failed = ([], [])
    if safe:
        recovered, failed = recover_ids(headers_write, [t["id"] for t in safe])

    print(f"Scanned {len(all_suspended)} suspended tickets so far")
    print(f"Recovered {len(recovered)} tickets")
    if failed:
        print(f"Failed to recover {len(failed)} tickets: {[t.get('id') for t in failed]}")
    if ambiguous:
        print(f"Flagged {len(ambiguous)} tickets for manual review")

    # Only make noise when something actually happened — this runs every 15 minutes
    # and is a no-op the overwhelming majority of the time.
    if was_suspended or recovered:
        notify_discord(
            f"🔓 Ceretone suspended-ticket recovery ran\n"
            f"info@ceretone.com suspended: {was_suspended}\n"
            f"Recovered: {len(recovered)} (Order/Registration pattern, incl. FW: duplicates)\n"
            + (f"Failed to recover: {len(failed)}\n" if failed else "")
        )

    if ambiguous:
        lines = []
        for t in ambiguous[:15]:  # cap the message length
            snippet = (t.get("content") or "").strip().replace("\n", " ")[:120]
            lines.append(f"• [{t['id']}] \"{t.get('subject') or '(no subject)'}\" — {snippet}")
        more = f"\n…and {len(ambiguous) - 15} more" if len(ambiguous) > 15 else ""
        notify_discord(
            f"⚠️ {len(ambiguous)} suspended ticket(s) from {SUPPORT_EMAIL} don't match a known "
            f"safe pattern (Order/Registration) and were left suspended for manual review:\n"
            + "\n".join(lines) + more +
            "\n\nCheck Zendesk Admin Center → Suspended tickets. Recover manually if genuine "
            "customer content (past examples: refund complaints, return requests, name-change "
            "requests, in other languages), or leave to expire if it's spam/back-office noise "
            "(payouts, chargebacks, marketing)."
        )

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
