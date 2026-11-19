import os
import re
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


# Shopify storefront contact form ("Have a question?" section, /contact page).
# Shopify mails these to info@ceretone.com, whose Exchange rule forwards them into
# Zendesk as "FW: New customer message on ..." — so the ticket's requester is the
# shared Support user, and agent replies would never reach the customer.
CONTACT_FORM_SUBJECT = "New customer message on"
CONTACT_FORM_MARKER = "You received a new message from your online store's contact form"
CONTACT_FORM_TAG = "shopify__contactform"
CONTACT_FORM_LOOKBACK_DAYS = 3  # only touch fresh tickets; older ones were handled by hand
EMAIL_RE = re.compile(r"^[^@\s<>]+@[^@\s<>]+\.[A-Za-z]{2,}$")
FW_PREFIX_RE = re.compile(r"^\s*((FW|FWD|Fw|Fwd|RE)\s*:\s*)+", re.I)


def strip_fw(subject):
    return FW_PREFIX_RE.sub("", subject or "").strip()


def is_contact_form(subject, content):
    return CONTACT_FORM_SUBJECT in (subject or "") and CONTACT_FORM_MARKER in (content or "")


def parse_contact_form(text):
    """Pull the customer's name/email out of the forwarded Shopify email body.

    Two layouts are in use: "Name / Email / Body" (product-page section) and
    "Name / Email / Phone Number / Message" (/contact page)."""
    body = (text or "").split(CONTACT_FORM_MARKER, 1)[-1]
    email_m = re.search(r"Email:\s*([^\s<>]+)", body)
    email = email_m.group(1).strip().rstrip(".,;") if email_m else ""
    if not EMAIL_RE.match(email):
        return None, None
    name_m = re.search(r"Name:\s*(.*?)\s*Email:", body, re.S)
    name = " ".join(name_m.group(1).split()) if name_m else ""
    return (name or email.split("@")[0]), email.lower()


def find_or_create_user(headers, name, email):
    r = requests.get(
        f"{BASE_URL}/users/search.json", headers=headers, params={"query": f"email:{email}"}, timeout=30
    )
    r.raise_for_status()
    for u in r.json().get("users", []):
        if (u.get("email") or "").lower() == email:
            return u["id"]
    r = requests.post(
        f"{BASE_URL}/users.json", headers=headers,
        json={"user": {"name": name, "email": email, "role": "end-user"}}, timeout=30,
    )
    r.raise_for_status()
    return r.json()["user"]["id"]


def reassign_contact_form_tickets(headers, extra_ids=()):
    """Point recent contact-form tickets at the actual customer instead of Support."""
    since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - CONTACT_FORM_LOOKBACK_DAYS * 86400))
    r = requests.get(
        f"{BASE_URL}/search.json", headers=headers, timeout=60,
        params={"query": f'type:ticket requester:{SUPPORT_USER_ID} created>{since} '
                         f'subject:"{CONTACT_FORM_SUBJECT}" -tags:{CONTACT_FORM_TAG}'},
    )
    r.raise_for_status()
    ids = {t["id"] for t in r.json().get("results", [])} | set(extra_ids)

    reassigned, unparsed = [], []
    for tid in sorted(ids):
        t = requests.get(f"{BASE_URL}/tickets/{tid}.json", headers=headers, timeout=30).json()["ticket"]
        # Re-check against the live ticket — search can lag, and someone may have fixed it by hand.
        if t["requester_id"] != SUPPORT_USER_ID or CONTACT_FORM_TAG in t["tags"]:
            continue
        if not is_contact_form(t.get("subject"), t.get("description")) or t["status"] in ("solved", "closed"):
            continue
        name, email = parse_contact_form(t.get("description"))
        if not email or email == SUPPORT_EMAIL:
            unparsed.append(tid)
            continue
        user_id = find_or_create_user(headers, name, email)
        requests.put(
            f"{BASE_URL}/tickets/{tid}.json", headers=headers, timeout=30,
            json={"ticket": {
                "requester_id": user_id,
                "subject": strip_fw(t.get("subject")),
                "comment": {"public": False, "body":
                    f"Shopify contact form submission — requester changed from {SUPPORT_EMAIL} "
                    f"to {name} <{email}> (parsed from the message) so replies reach the customer."},
            }},
        ).raise_for_status()
        # Tags endpoint, not the ticket PUT: single-ticket updates silently ignore
        # `additional_tags` (that's an update_many-only field).
        requests.put(
            f"{BASE_URL}/tickets/{tid}/tags.json", headers=headers, timeout=30,
            json={"tags": [CONTACT_FORM_TAG]},
        ).raise_for_status()
        reassigned.append((tid, email))
        time.sleep(0.3)
    return reassigned, unparsed


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

    def is_safe(t):
        return is_order_or_registration(t.get("subject")) or is_contact_form(t.get("subject"), t.get("content"))

    safe = [t for t in from_support if is_safe(t)]
    ambiguous = [t for t in from_support if not is_safe(t)]

    recovered, failed = ([], [])
    if safe:
        recovered, failed = recover_ids(headers_write, [t["id"] for t in safe])

    # Order FW: copies keep their prefix — it's what marks them as the duplicate of the
    # direct Shopify notification. Registrations have no direct copy, so clean those up.
    for t in recovered:
        if "form has a new submission" in (t.get("subject") or "") and strip_fw(t["subject"]) != t["subject"]:
            requests.put(f"{BASE_URL}/tickets/{t['id']}.json", headers=headers_write, timeout=30,
                         json={"ticket": {"subject": strip_fw(t["subject"])}})

    # Step 3: contact-form tickets (freshly recovered or arrived normally) → real customer as requester
    reassigned, unparsed = reassign_contact_form_tickets(
        headers_write, [t["id"] for t in recovered if CONTACT_FORM_SUBJECT in (t.get("subject") or "")]
    )

    print(f"Scanned {len(all_suspended)} suspended tickets so far")
    print(f"Recovered {len(recovered)} tickets")
    print(f"Reassigned {len(reassigned)} contact-form tickets")
    if unparsed:
        print(f"Could not parse a customer email on contact-form tickets: {unparsed}")
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
            f"Recovered: {len(recovered)} (Order/Registration/contact-form pattern, incl. FW: duplicates)\n"
            + (f"Failed to recover: {len(failed)}\n" if failed else "")
        )

    if reassigned or unparsed:
        notify_discord(
            f"📨 Shopify contact-form tickets: requester set to customer on {len(reassigned)}\n"
            + "\n".join(f"• #{tid} → {email}" for tid, email in reassigned[:15])
            + (f"\n⚠️ No customer email found, left on Support for manual review: {unparsed}" if unparsed else "")
        )

    if ambiguous:
        lines = []
        for t in ambiguous[:15]:  # cap the message length
            snippet = (t.get("content") or "").strip().replace("\n", " ")[:120]
            lines.append(f"• [{t['id']}] \"{t.get('subject') or '(no subject)'}\" — {snippet}")
        more = f"\n…and {len(ambiguous) - 15} more" if len(ambiguous) > 15 else ""
        notify_discord(
            f"⚠️ {len(ambiguous)} suspended ticket(s) from {SUPPORT_EMAIL} don't match a known "
            f"safe pattern (Order/Registration/contact form) and were left suspended for manual review:\n"
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
