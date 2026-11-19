#!/usr/bin/env python3
"""Weekly Core One Pro returns classifier.

Runs Sunday morning: finds Core One Pro refunds not yet in the Details sheet, gathers Zendesk evidence
(tickets, Notes field, call recordings transcribed locally), drafts a classification with the Anthropic API
using the taxonomy stored in the Taxonomy Reference sheet, appends rows to the Details sheet, queues
anything uncertain in the Review Queue sheet, and applies decisions made there the previous week.
"""
import os, sys, re, json, time, fcntl, argparse, traceback, datetime as dt, tempfile, shutil
import requests
import pg8000.native as pg
from google.oauth2 import service_account
from google.auth.transport.requests import AuthorizedSession, Request

DETAILS_ID = os.environ.get("DETAILS_ID", "1vZinC3YU_rnoL8DyVh7xOB093CFqKYX2OnWjfBGb4PY")
REVIEW_ID = os.environ.get("REVIEW_ID", "107Dy0vW6OlRxFzKAfx1rLo4yC0B9FxJUi9Rll8S29L0")
TAXONOMY_ID = os.environ.get("TAXONOMY_ID", "1eYVt82joOZFGrjDtbAF-rR4QI2ycs7BMuBlePkK1LFE")
DETAILS_TAB = os.environ.get("DETAILS_TAB", "Untitled")
REVIEW_TAB = "Review Queue"
SUMMARY_TAB = "Weekly Summary"
REVIEW_LINK = f"https://docs.google.com/spreadsheets/d/{REVIEW_ID}/edit"
MODEL = os.environ.get("CLASSIFIER_MODEL", "claude-sonnet-5")
WHISPER = os.environ.get("WHISPER_MODEL", "small.en")
MAX_AUDIO_MIN = float(os.environ.get("MAX_AUDIO_MINUTES", "240"))
MAX_AUDIO_MIN_PER_ORDER = float(os.environ.get("MAX_AUDIO_MINUTES_PER_ORDER", "20"))
MIN_CALL_SEC = int(os.environ.get("MIN_CALL_SECONDS", "60"))
MIN_VOICEMAIL_SEC = 15
SOP_DATE = dt.date(2026, 9, 11)
NOTES_FIELD, SERIAL_FIELD, ORDER_FIELD = 31171878308244, 27305354980500, 28914817987092
WORK = "/app/work"
STATE = "/app/state"

SAFETY_PATTERNS = [
    (r"(stuck|stay(s|ed)?|left|lodged|remain(s|ed)?|come(s)? off|fell off|fall(s)? off)[^.\n]{0,40}(in|inside)[^.\n]{0,12}(my|her|his|the)?[^.\n]{0,8}ear", "possible ear tip left or lodged in the ear"),
    (r"(cone|tip|dome)s?[^.\n]{0,60}(stuck|stay|inside|lodged|come off|came off)", "ear tip stuck, lodged or detached"),
    (r"emergency room|urgent care|\bE\.?R\.? visit|hospital|went to (the|a) doctor|see(ing)? a doctor|ENT ", "medical care mentioned"),
    (r"bleed|blood|rash|swell|infect|allerg|itch(ing|y)? (badly|terribl)|burn(ing)? (in|inside)", "possible skin or ear-canal reaction"),
    (r"dizz|vertigo|off.balance|nausea", "dizziness or balance symptom"),
]


def log(*a):
    print(dt.datetime.utcnow().strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- Google Sheets
class Sheets:
    def __init__(self):
        creds = service_account.Credentials.from_service_account_file(
            "/run/gsa-key.json",
            scopes=["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"])
        self.s = AuthorizedSession(creds)

    def _url(self, sid, rng=None, suffix=""):
        base = f"https://sheets.googleapis.com/v4/spreadsheets/{sid}"
        if rng is None:
            return base + suffix
        return base + "/values/" + requests.utils.quote(rng, safe="!:'") + suffix

    def get(self, sid, rng):
        r = self.s.get(self._url(sid, rng), timeout=60)
        r.raise_for_status()
        return r.json().get("values", [])

    def put(self, sid, rng, values):
        r = self.s.put(self._url(sid, rng, "?valueInputOption=RAW"), json={"values": values}, timeout=60)
        r.raise_for_status()

    def batch_values(self, sid, items):
        if not items:
            return
        r = self.s.post(self._url(sid, None, "/values:batchUpdate"), json={
            "valueInputOption": "RAW", "data": [{"range": a, "values": [[v]]} for a, v in items]}, timeout=60)
        r.raise_for_status()

    def batch(self, sid, requests_):
        r = self.s.post(self._url(sid, None, ":batchUpdate"), json={"requests": requests_}, timeout=60)
        r.raise_for_status()
        return r.json()

    def sheet_id(self, sid, tab):
        r = self.s.get(self._url(sid, None, "?fields=sheets.properties"), timeout=60)
        r.raise_for_status()
        for sh in r.json()["sheets"]:
            if sh["properties"]["title"] == tab:
                return sh["properties"]["sheetId"]
        raise KeyError(tab)


def g(row, i):
    return row[i] if len(row) > i else ""


def col_letter(n):  # 0-based
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


# ---------------------------------------------------------------- taxonomy
TOPS = ["Product Issues", "Salvageable", "Unrecoverable", "Buyers Remorse", "Excluded / Not a Return", "Medical", "Exchanged"]


def load_taxonomy(sh):
    rows = sh.get(TAXONOMY_ID, "'Untitled'!A1:H400")
    subs, splits = [], []
    for r in rows:
        if len(r) == 7 and r[0] in TOPS and g(r, 3).isdigit():
            subs.append((r[0], r[1], r[2]))
        if r and (r[0].startswith("Hidden Product Signal - ") or r[0] == "Pure CS Gap") and g(r, 1).isdigit():
            splits.append((r[0], g(r, 3)))
    if len(subs) < 30 or len(splits) < 8:
        raise RuntimeError(f"taxonomy sheet looks wrong: {len(subs)} sub-categories, {len(splits)} splits")
    return subs, splits


RULES = """DECISION RULES (agreed with the business owner; apply them exactly):
- Evidence quality order: call transcripts (audio) > ticket conversation text > the agent's Notes field. The Notes field is a lossy agent summary and has been wrong about what was said; when a transcript contradicts it, trust the transcript and flag the conflict.
- Salvageable / No diagnostic engagement at all: the agent asked NOTHING about the complaint and gave no advice about it (policy or logistics only). This is rare: nearly every return call opens with an intake question about the reason and fit.
- Salvageable / Generic question asked, no fix followed: at least one question about the complaint (even a form-style intake question) but no fix addressed the stated symptoms. An offered alternative, refund option or policy explanation only counts as an attempt if the agent also worked on the customer's stated symptoms.
- Buyers Remorse / Declined to continue troubleshooting (insisted on return): the customer had already decided and refused any help, OR the agent offered concrete steps or an exchange and the customer declined them or insisted on the return without trying them.
- Unrecoverable / Extensive troubleshooting attempted, still failed: two or more agent-led concrete steps, verified in a transcript or conversation, that did not resolve it, even if the final complaint shifted.
- Unrecoverable / Device design limitation (missing feature): the decisive stated reason is a missing feature (for example case-only volume or program control, no app, no CROS) and the agent otherwise engaged.
- Unrecoverable / Anatomical/physical fit limitation: the ear canal size or shape prevents a stable fit with any available tip, used mainly when an agent tried things live (tip trials, insertion guidance) and it still failed.
- Unrecoverable / Medical/professional determination: a clinician stated the device type will not work.
- Fit failures across every tip where the agent only asked a question stay Salvageable (Hidden Product Signal - Fit/Anatomical), not Unrecoverable.
- A bare symptom complaint with no agent fix stays Salvageable (with a Hidden Product Signal split), not Product Issues. Product Issues is used when the agent documented real troubleshooting that failed, or for defined safety failures.
- Ear tips or cones left inside the ear canal, tips detaching, or any ER/urgent-care visit is a safety signal: classify Product Issues / Ear Tip/Dome Mechanical Failure (Safety) and set safety_flag true.
- Test for close calls: were the customer's stated issues actually addressed by the agent?
- Salvageable rows need a salvageable_split: 'Hidden Product Signal - <symptom>' when a real product symptom was on record, or 'Pure CS Gap' when there was no product symptom at all. Use 'Hidden Product Signal - Other' for symptoms outside the listed ones.
- Excluded / Not a Return: pre-fulfillment cancellations, refunds with no real device return (fraud-blocked, accessory-only, undelivered), and channel-partner or wholesale orders.
- If nothing fits well, choose the closest label, lower your confidence, and describe the mismatch in review_reasons (or propose a new sub-category in proposed_new_subcategory)."""

SCHEMA = """Return ONLY one JSON object with these keys (no prose, no code fences):
{"top_level": "<one of the top-level categories>",
 "sub_category": "<exact sub-category label belonging to that top-level category>",
 "salvageable_split": "<exact split label, or empty string unless top_level is Salvageable>",
 "confidence": <number 0 to 1>,
 "return_intent_contact_date": "<YYYY-MM-DD of the customer's first contact saying they want to return, or empty>",
 "troubleshooting_offers": "<one sentence: what the agent actually asked, suggested or offered before approving the return, or 'none'>",
 "verification_level": "<Audio reviewed | Conversation-verified | Notes only | Phone call with no recording available>",
 "evidence_summary": "<max 70 words, include one or two short verbatim quotes from the customer>",
 "safety_flag": <true or false>,
 "notes_conflict": <true if a transcript contradicts the agent Notes field, else false>,
 "proposed_new_subcategory": "<empty unless nothing fits>",
 "review_reasons": ["<short reasons a human should double-check this row; empty list if none>"]}"""


def build_system_prompt(subs, splits):
    lines = ["You classify Ceretone Core One Pro hearing-aid returns from support evidence. Use only the evidence provided; never invent facts.\n",
             "TAXONOMY (top-level category / sub-category: definition):"]
    for top in TOPS:
        for cat, sub, d in subs:
            if cat == top:
                lines.append(f"- {cat} / {sub}: {d}")
    lines.append("\nSALVAGEABLE SPLIT VALUES:")
    for label, d in splits:
        lines.append(f"- {label}: {d}")
    lines.append("\n" + RULES + "\n\n" + SCHEMA)
    return "\n".join(lines)


# ---------------------------------------------------------------- Zendesk
class Zendesk:
    def __init__(self):
        env = {}
        for l in open("/run/zd.env"):
            l = l.strip()
            if "=" in l and not l.startswith("#"):
                k, v = l.split("=", 1)
                env[k] = v.strip().strip('"').strip("'")
        self.sub = env["ZENDESK_SUBDOMAIN"]
        self.cid, self.sec = env["ZENDESK_CLIENT_ID"], env["ZENDESK_CLIENT_SECRET"]
        self.base = f"https://{self.sub}.zendesk.com"
        self._token()

    def _token(self):
        r = requests.post(f"{self.base}/oauth/tokens", json={
            "grant_type": "client_credentials", "client_id": self.cid, "client_secret": self.sec, "scope": "read write"}, timeout=30)
        r.raise_for_status()
        self.tok = r.json()["access_token"]

    def get(self, url, params=None, raw=False):
        if url.startswith("/"):
            url = self.base + url
        for attempt in range(5):
            r = requests.get(url, params=params, headers={"Authorization": "Bearer " + self.tok}, timeout=120)
            if r.status_code == 401:
                self._token()
                continue
            if r.status_code == 429:
                time.sleep(int(r.headers.get("Retry-After", "10")) + 1)
                continue
            r.raise_for_status()
            return r if raw else r.json()
        raise RuntimeError("Zendesk request kept failing: " + url)

    def paged(self, path, key, params=None):
        out, url = [], path
        while url:
            d = self.get(url, params if url == path else None)
            out += d.get(key, [])
            url = d.get("next_page")
        return out

    def search_tickets(self, query):
        return self.paged("/api/v2/search.json", "results", {"query": query, "per_page": 100, "sort_by": "created_at", "sort_order": "asc"})

    def user_by_email(self, email):
        d = self.get("/api/v2/users/search.json", {"query": f"email:{email}"})
        return (d.get("users") or [None])[0]

    def users(self, ids):
        out = {}
        ids = list({i for i in ids if i and i > 0})
        for i in range(0, len(ids), 100):
            for u in self.get("/api/v2/users/show_many.json", {"ids": ",".join(map(str, ids[i:i + 100]))}).get("users", []):
                out[u["id"]] = u
        return out


def cf(ticket, fid):
    for f in ticket.get("custom_fields", []):
        if f["id"] == fid:
            return f.get("value")
    return None


CALL_URL = re.compile(r"https://[a-z0-9.\-]+/api/v2/channels/voice/calls/(CA[0-9a-f]+)/twilio/((?:call/)?recording|voicemail/recording)")


def call_seconds(text):
    m = re.search(r"Length of phone call:\s*(?:(\d+)\s*minutes?)?[,\s]*(?:(\d+)\s*seconds?)?", text)
    if m and (m.group(1) or m.group(2)):
        return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)
    m = re.search(r"Call length:\s*(\d+):(\d+):(\d+)", text)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return None


class Transcriber:
    def __init__(self):
        self.model = None
        self.audio_seconds = 0.0
        self.calls = 0

    def budget_left(self):
        return MAX_AUDIO_MIN * 60 - self.audio_seconds

    def transcribe(self, zd, url):
        r = zd.get(url, raw=True)
        if "audio" not in (r.headers.get("Content-Type") or ""):
            return None, 0
        os.makedirs(WORK, exist_ok=True)
        fd, path = tempfile.mkstemp(suffix=".mp3", dir=WORK)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(r.content)
            if self.model is None:
                from faster_whisper import WhisperModel
                self.model = WhisperModel(WHISPER, device="cpu", compute_type="int8", cpu_threads=3, download_root=f"{WORK}/models")
            segs, info = self.model.transcribe(path, vad_filter=True, beam_size=5)
            lines = [f"[{int(s.start) // 60}:{int(s.start) % 60:02d}] {s.text.strip()}" for s in segs]
            self.audio_seconds += info.duration
            self.calls += 1
            return "\n".join(lines), info.duration
        finally:
            try:
                os.remove(path)
            except OSError:
                pass


# ---------------------------------------------------------------- evidence

NOISE_SUBJECT = re.compile(r"placed by|A shipment from order", re.I)


def sanitize(text):
    """Minimize personal data and noise before text goes into a dossier."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[image]", text)
    text = re.sub(r"\[([^\]]+)\]\((?:https?://)[^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", "[url]", text)
    text = re.sub(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", "[email]", text)
    text = re.sub(r"\+?1?[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b", "[phone]", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def gather(order, zd, tr, use_audio=True):
    """Return (dossier_text, meta) for one order row from Postgres."""
    name = order["name"].lstrip("#")
    created = order["created_at"]
    tickets = {}
    uid = None
    for email in {order.get("email"), order.get("customer_email")} - {None, ""}:
        u = zd.user_by_email(email)
        if u:
            uid = uid or u["id"]
            for t in zd.search_tickets(f"type:ticket requester:{u['id']}"):
                tickets[t["id"]] = t
    for t in zd.search_tickets(f'type:ticket "{name}"'):
        tickets.setdefault(t["id"], t)
    lo = (created - dt.timedelta(days=2)).isoformat()
    tickets = {i: t for i, t in tickets.items() if t["created_at"] >= lo}
    ordered = sorted(tickets.values(), key=lambda t: t["created_at"])[:30]
    parts, meta = [], {"tickets": [], "calls": [], "audio_reviewed": 0, "calls_skipped": 0, "return_ticket": None,
                       "notes_field": "", "serial": "", "requester_name": "", "text_blob": ""}
    refund_dt = order["first_refund"]
    order_audio_budget = MAX_AUDIO_MIN_PER_ORDER * 60  # separate from the run-wide budget: caps how much of a
    # single order's evidence-gathering can go to audio, so one chatty repeat-caller can't eat the whole run
    # (found 2026-09-28: a customer with 24 historical tickets and ~64 min of eligible call audio, all still
    # "in window" because the date filter anchors on order creation, not the return event)
    if len(ordered) > 8:
        log(f"  {name}: {len(ordered)} tickets in window (repeat contact) - capping audio at {MAX_AUDIO_MIN_PER_ORDER:.0f} min for this order")
    for t in ordered:
        full = zd.get(f"/api/v2/tickets/{t['id']}.json")["ticket"]
        comments = zd.paged(f"/api/v2/tickets/{t['id']}/comments.json", "comments")
        users = zd.users([c.get("author_id") for c in comments] + [full.get("requester_id")])
        log(f"  {name}: ticket {t['id']} ({full.get('created_at', '')[:10]}), {len(comments)} comments")
        tags = full.get("tags", [])
        if NOISE_SUBJECT.search(full.get("subject") or ""):
            parts.append(f"=== TICKET {t['id']} | automatic order or shipment notification, omitted | created {full['created_at'][:10]}\n")
            continue
        is_return = "return__a90" in tags or "return" in (full.get("subject") or "").lower()
        notes = cf(full, NOTES_FIELD) or ""
        head = f"=== TICKET {t['id']} | {full.get('subject')} | created {full['created_at'][:10]} | via {full.get('via', {}).get('channel')} | status {full.get('status')} | return-tagged: {'return__a90' in tags}"
        parts.append(head)
        if notes:
            parts.append(f"NOTES FIELD (agent summary, may be inaccurate): {sanitize(notes)}")
        req = users.get(full.get("requester_id"))
        if req and not meta["requester_name"] and req.get("role") == "end-user" and not re.search(r"Web User|deleted", req.get("name", "")):
            meta["requester_name"] = req["name"]
        if "return__a90" in tags and meta["return_ticket"] is None:
            meta["return_ticket"] = {"id": t["id"], "created": full["created_at"][:10]}
            meta["notes_field"] = notes
            meta["serial"] = cf(full, SERIAL_FIELD) or ""
        elif is_return and meta.get("return_fallback") is None:
            meta["return_fallback"] = {"id": t["id"], "created": full["created_at"][:10]}
        for c in comments:
            body = (c.get("body") or "").strip()
            if not body:
                continue
            u = users.get(c.get("author_id"))
            role = "system" if not u else ("agent" if u.get("role") in ("agent", "admin") else "customer")
            vis = "public" if c.get("public") else "private note"
            m = CALL_URL.search(body)
            clean = sanitize(body)
            meta["text_blob"] += "\n" + clean
            parts.append(f"[{c['created_at'][:16].replace('T', ' ')}] {role}{' ' + u['name'] if u and role == 'agent' else ''} ({vis}): {clean[:3500]}")
            if m:
                secs = call_seconds(body)
                is_vm = "voicemail" in m.group(2)
                info = {"ticket": t["id"], "sid": m.group(1), "secs": secs, "voicemail": is_vm, "url": m.group(0)}
                meta["calls"].append(info)
                wanted = secs is not None and secs >= (MIN_VOICEMAIL_SEC if is_vm else MIN_CALL_SEC)
                if wanted and use_audio and order_audio_budget > (secs or 0) and tr.budget_left() > (secs or 0) * 2:
                    try:
                        text, dur = tr.transcribe(zd, m.group(0))
                    except Exception as e:  # keep going without this call
                        text, dur = None, 0
                        log("transcription failed for", m.group(1), repr(e)[:120])
                    if text:
                        meta["audio_reviewed"] += 1
                        meta["text_blob"] += "\n" + text
                        order_audio_budget -= dur
                        parts.append(f"--- CALL TRANSCRIPT ({'voicemail' if is_vm else 'call'} on ticket {t['id']}, logged length {secs}s; automatic transcript, names may be garbled, no speaker labels) ---\n{text}\n--- END TRANSCRIPT ---")
                    else:
                        meta["calls_skipped"] += 1
                elif wanted:
                    meta["calls_skipped"] += 1
                    reason = "per-order audio cap reached" if order_audio_budget <= 0 else "audio time budget or audio disabled"
                    parts.append(f"--- CALL on ticket {t['id']} ({secs}s) NOT transcribed ({reason}) ---")
        parts.append("")
    if meta["return_ticket"] is None:
        meta["return_ticket"] = meta.pop("return_fallback", None) or ({"id": ordered[0]["id"], "created": ordered[0]["created_at"][:10]} if ordered else None)
    header = (f"ORDER {name} | placed {created.date()} | delivered {order['delivered'].date() if order['delivered'] else 'unknown'} | "
              f"first refund {refund_dt.date()} ({order['refund_rows']} refund record(s)) | Shopify status {order['financial_status']}"
              f"{' | CANCELLED ' + str(order['cancelled_at'].date()) if order['cancelled_at'] else ''} | fulfillment {order['fulfillment_status']}")
    dossier = header + "\n\n" + "\n".join(parts)
    return dossier[:110000], meta


# ---------------------------------------------------------------- classification
def classify(client, system_prompt, dossier, subs, splits):
    valid = {(c, s) for c, s, _ in subs}
    valid_splits = {s for s, _ in splits}
    last = None
    for attempt in range(2):
        msg = client.messages.create(model=MODEL, max_tokens=1600, system=system_prompt,
                                     messages=[{"role": "user", "content": "EVIDENCE FOR ONE RETURN:\n\n" + dossier}])
        text = "".join(b.text for b in msg.content if b.type == "text").strip()
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
        try:
            out = json.loads(text)
        except Exception as e:
            last = f"unparseable JSON: {text[:120]}"
            continue
        if (out.get("top_level"), out.get("sub_category")) not in valid:
            last = f"invalid label {out.get('top_level')} / {out.get('sub_category')}"
            out.setdefault("review_reasons", []).append("Label not in taxonomy: " + last)
            if attempt == 1:
                return out, last
            continue
        if out["top_level"] == "Salvageable" and out.get("salvageable_split") not in valid_splits:
            out.setdefault("review_reasons", []).append(f"Split not in vocabulary: {out.get('salvageable_split')}")
        if out["top_level"] != "Salvageable":
            out["salvageable_split"] = ""
        return out, None
    return None, last


def compute_flags(result, order, meta):
    flags = list(result.get("review_reasons") or []) if result else []
    if not result:
        flags.append("Classifier failed")
        return flags
    if float(result.get("confidence") or 0) < 0.75:
        flags.append(f"Low confidence ({result.get('confidence')})")
    if result.get("notes_conflict"):
        flags.append("Agent Notes contradict the call transcript")
    if result.get("proposed_new_subcategory"):
        flags.append("Nothing fits: proposed new sub-category: " + result["proposed_new_subcategory"])
    blob = meta["text_blob"]
    hits = []
    for pat, why in SAFETY_PATTERNS:
        m = re.search(pat, blob, re.I)
        if m:
            hits.append(f"{why} (\"{blob[max(0, m.start() - 30):m.end() + 30].strip()[:110]}\")".replace("\n", " "))
    if result.get("safety_flag") or hits:
        flags.append("SAFETY: " + ("; ".join(hits[:2]) or "classifier marked a safety signal"))
    if not meta["return_ticket"]:
        flags.append("No Zendesk ticket found")
    if order["refund_rows"] > 1:
        flags.append(f"{order['refund_rows']} refund records")
    if order["financial_status"] not in ("refunded",):
        flags.append(f"Shopify status is {order['financial_status']} (not fully refunded)")
    if order["cancelled_at"] or order["fulfillment_status"] in (None, "unfulfilled"):
        flags.append("Order cancelled or never fulfilled")
    tags = (order.get("tags") or "").lower()
    if "amazon" in tags or "hsn" in tags or "wholesale" in tags:
        flags.append("Channel-partner style order tags")
    if meta["calls_skipped"]:
        flags.append(f"{meta['calls_skipped']} call(s) not transcribed")
    if any(c["secs"] is None for c in meta["calls"]) and meta["audio_reviewed"] == 0 and meta["calls"]:
        flags.append("Call recordings found but none reviewed")
    seen, out = set(), []
    for f in flags:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


# ---------------------------------------------------------------- orders
def find_orders(db, floor, wend, only=None):
    sql = """
      select * from (
        select o.id, o.name, o.email, o.customer_email, o.created_at, o.financial_status, o.cancelled_at, o.fulfillment_status, o.tags,
               o.customer_first_name, o.customer_last_name,
               (select min(r.created_at) from order_refunds r where r.order_id = o.id) as first_refund,
               (select count(*) from order_refunds r where r.order_id = o.id) as refund_rows,
               (select min(f.delivered_at) from order_fulfillments f where f.order_id = o.id) as delivered
        from orders o
        where o.test is not true
          and exists (select 1 from order_line_items l where l.order_id = o.id and l.title ilike '%Core One Pro%')
      ) x
      where first_refund is not null and first_refund >= :floor and first_refund < :wend
      order by first_refund"""
    cols = ["id", "name", "email", "customer_email", "created_at", "financial_status", "cancelled_at", "fulfillment_status", "tags",
            "customer_first_name", "customer_last_name", "first_refund", "refund_rows", "delivered"]
    rows = [dict(zip(cols, r)) for r in db.run(sql, floor=floor, wend=wend)]
    if only:
        rows = [r for r in rows if r["name"].lstrip("#") in only]
    return rows


def sunday_of(d):
    return d - dt.timedelta(days=(d.weekday() + 1) % 7)


# ---------------------------------------------------------------- apply review decisions
def apply_decisions(sh):
    q = sh.get(REVIEW_ID, f"'{REVIEW_TAB}'!A1:Q3000")
    if not q:
        return 0
    details = sh.get(DETAILS_ID, f"'{DETAILS_TAB}'!A1:R5000")
    hdr = details[0]
    iD, iE, iJ, iK, iL = (hdr.index(x) for x in ("Top-Level Category", "Sub-Category", "Salvageable Split", "Standardization Note", "Review Flag"))
    pos = {g(r, 0): i + 1 for i, r in enumerate(details) if i > 0 and g(r, 0)}
    updates_d, updates_q, n = [], [], 0
    for i, r in enumerate(q[1:], start=2):
        if g(r, 16).strip().lower() != "decided":
            continue
        order = g(r, 1)
        top, sub, spl = g(r, 12), g(r, 13), g(r, 14)
        if order not in pos or not top or not sub:
            updates_q.append((f"'{REVIEW_TAB}'!Q{i}", "Needs attention: order not found or Final columns incomplete"))
            continue
        row = pos[order]
        note = f"Reviewed {dt.date.today()}" + (f": {g(r, 15)}" if g(r, 15) else "")
        prev = g(details[row - 1], iK)
        updates_d += [(f"'{DETAILS_TAB}'!{col_letter(iD)}{row}", top), (f"'{DETAILS_TAB}'!{col_letter(iE)}{row}", sub),
                      (f"'{DETAILS_TAB}'!{col_letter(iJ)}{row}", spl if top == "Salvageable" else ""),
                      (f"'{DETAILS_TAB}'!{col_letter(iK)}{row}", (prev + " | " if prev else "") + note),
                      (f"'{DETAILS_TAB}'!{col_letter(iL)}{row}", "")]
        updates_q.append((f"'{REVIEW_TAB}'!Q{i}", "Applied"))
        n += 1
    sh.batch_values(DETAILS_ID, updates_d)
    sh.batch_values(REVIEW_ID, updates_q)
    return n


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-end", help="YYYY-MM-DD (a Sunday, exclusive). Default: most recent Sunday 00:00 UTC")
    ap.add_argument("--floor", default="2026-06-01")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="comma-separated order numbers (testing)")
    ap.add_argument("--ignore-sheet-dedupe", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="do not write to any sheet; save rows to state/dry_run.json")
    ap.add_argument("--no-llm", action="store_true", help="gather evidence only; save dossiers to state/dossiers")
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--skip-apply", action="store_true")
    a = ap.parse_args()

    os.makedirs(STATE, exist_ok=True)
    lock = open(f"{STATE}/job.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another run holds the lock; exiting")
        return 3

    today = dt.datetime.utcnow().date()
    wend_d = dt.date.fromisoformat(a.window_end) if a.window_end else sunday_of(today)
    wstart_d = wend_d - dt.timedelta(days=7)
    week_label = f"{wstart_d} to {wend_d - dt.timedelta(days=1)}"
    wend = dt.datetime.combine(wend_d, dt.time.min)
    log("run start | window", week_label, "| dry-run" if a.dry_run else "")

    sh = Sheets()
    subs, splits = load_taxonomy(sh)
    log("taxonomy:", len(subs), "sub-categories,", len(splits), "splits")

    applied = 0
    if not a.skip_apply and not a.dry_run:
        applied = apply_decisions(sh)
        log("applied review decisions:", applied)

    details = sh.get(DETAILS_ID, f"'{DETAILS_TAB}'!A1:R5000")
    hdr = details[0]
    ncols = 18
    existing = {g(r, 0) for r in details[1:] if g(r, 0)}
    last_row = max((i + 1 for i, r in enumerate(details) if g(r, 0)), default=1)
    rq = sh.get(REVIEW_ID, f"'{REVIEW_TAB}'!A1:Q3000")
    queued = {g(r, 1) for r in rq[1:] if g(r, 1)}

    db = pg.Connection(user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"], host=os.environ["PGHOST"],
                       port=int(os.environ["PGPORT"]), database=os.environ["PGDATABASE"])
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    orders = find_orders(db, dt.datetime.fromisoformat(a.floor), wend, only or None)
    db.close()
    if not a.ignore_sheet_dedupe:
        orders = [o for o in orders if o["name"].lstrip("#") not in existing]
    if a.limit:
        orders = orders[:a.limit]
    log("new returns to process:", len(orders), [o["name"] for o in orders])

    zd = Zendesk()
    tr = Transcriber()
    client = None
    system_prompt = build_system_prompt(subs, splits)
    if not a.no_llm:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    if a.no_llm and orders:
        # Retention policy: dossiers persist until the next run that actually finds something new to
        # gather (so a Saturday run with zero new returns leaves last week's dossiers untouched for
        # review). Classification is manual, so this is the only cleanup point in the pipeline.
        shutil.rmtree(f"{STATE}/dossiers", ignore_errors=True)

    detail_rows, review_rows, results, raw_rows = [], [], [], []
    for o in orders:
        name = o["name"].lstrip("#")
        try:
            log("gathering", name)
            dossier, meta = gather(o, zd, tr, use_audio=not a.no_audio)
            if a.no_llm:
                os.makedirs(f"{STATE}/dossiers", exist_ok=True)
                open(f"{STATE}/dossiers/{name}.txt", "w").write(dossier)
                log(name, "dossier chars:", len(dossier), "| tickets:", dossier.count("=== TICKET"), "| calls found:", len(meta["calls"]), "| transcribed:", meta["audio_reviewed"])
                # Raw placeholder row: only mechanical facts we already have pre-classification
                # (order/ticket/dates/customer/days-owned). Category, evidence summary, etc. are left
                # blank for Monday's manual classification conversation to fill in via a targeted
                # cell update (looked up by Order Number) rather than a fresh appended row.
                refund_d = o["first_refund"].date()
                rt = meta["return_ticket"] or {}
                cname = meta["requester_name"] or f"{o.get('customer_first_name') or ''} {o.get('customer_last_name') or ''}".strip()
                days_owned = (refund_d - o["delivered"].date()).days if o["delivered"] else ""
                note = f"Auto-gathered {today} by weekly job; awaiting manual classification"
                evidence = (f"Dossier gathered {today}; {dossier.count('=== TICKET')} ticket(s) in window, "
                            f"{meta['audio_reviewed']} call(s) transcribed. Awaiting manual classification - see state/dossiers/{name}.txt.")
                row = [name, str(rt.get("id", "")), cname, "", "", str(o["created_at"].date()), str(refund_d), str(o["refund_rows"]),
                       rt.get("created", ""), "", note, "NEEDS REVIEW", str(days_owned), "", "", "", "", evidence]
                raw_rows.append((row + [""] * ncols)[:ncols])
                continue
            result, err = classify(client, system_prompt, dossier, subs, splits)
        except Exception as e:
            log("ERROR", name, repr(e)[:200])
            traceback.print_exc()
            result, meta, err = None, {"tickets": [], "calls": [], "audio_reviewed": 0, "calls_skipped": 0, "return_ticket": None, "notes_field": "", "serial": "", "requester_name": "", "text_blob": ""}, f"processing error: {repr(e)[:150]}"
        flags = compute_flags(result, o, meta)
        if err:
            flags.append(err)
        refund_d = o["first_refund"].date()
        rt = meta["return_ticket"] or {}
        cname = meta["requester_name"] or f"{o.get('customer_first_name') or ''} {o.get('customer_last_name') or ''}".strip()
        contact = (result or {}).get("return_intent_contact_date") or ""
        if contact:
            try:
                cpart = "Pre-SOP (contact before Sep 11)" if dt.date.fromisoformat(contact) < SOP_DATE else "Post-SOP (contact on or after Sep 11)"
            except ValueError:
                cpart = "Unknown"
        else:
            cpart = "Unknown"
        days_owned = (refund_d - o["delivered"].date()).days if o["delivered"] else ""
        top = (result or {}).get("top_level", "")
        sub = (result or {}).get("sub_category", "")
        flagged = bool(flags)
        note = f"Auto-classified {today} by weekly job (confidence {(result or {}).get('confidence', 'n/a')}); unreviewed"
        row = [name, str(rt.get("id", "")), cname, top, sub, str(o["created_at"].date()), str(refund_d), str(o["refund_rows"]),
               rt.get("created", ""), (result or {}).get("salvageable_split", ""), note, "NEEDS REVIEW" if flagged else "",
               str(days_owned), contact, cpart, (result or {}).get("troubleshooting_offers", ""),
               (result or {}).get("verification_level", ""), (result or {}).get("evidence_summary", "")]
        row = (row + [""] * ncols)[:ncols]
        detail_rows.append((row, flagged))
        results.append((row, flagged))
        if flagged:
            audio = f"Yes ({meta['audio_reviewed']} call(s))" if meta["audio_reviewed"] else ("No" if not meta["calls"] else "Calls found, none reviewed")
            review_rows.append([f"{sunday_of(refund_d)} to {sunday_of(refund_d) + dt.timedelta(days=6)}", name, str(rt.get("id", "")), cname,
                                str(refund_d), top, sub, (result or {}).get("salvageable_split", ""), str((result or {}).get("confidence", "")),
                                "; ".join(flags), (result or {}).get("evidence_summary", ""), audio, "", "", "", "", "Pending review"])

    if a.no_llm:
        if raw_rows and not a.dry_run:
            start = last_row + 1
            sh.put(DETAILS_ID, f"'{DETAILS_TAB}'!A{start}:R{start + len(raw_rows) - 1}", raw_rows)
            sid = sh.sheet_id(DETAILS_ID, DETAILS_TAB)
            sh.batch(DETAILS_ID, [{"repeatCell": {"range": {"sheetId": sid, "startRowIndex": start - 1 + k, "endRowIndex": start + k, "startColumnIndex": 0, "endColumnIndex": ncols},
                                    "cell": {"userEnteredFormat": {"backgroundColor": {"red": 1, "green": 0.96, "blue": 0.75}}}, "fields": "userEnteredFormat.backgroundColor"}}
                                   for k in range(len(raw_rows))])
            log(f"wrote {len(raw_rows)} raw placeholder row(s) to Details sheet, rows {start}-{start + len(raw_rows) - 1}")
        elif raw_rows:
            log(f"dry run: would write {len(raw_rows)} raw placeholder row(s) to Details sheet")
        return 0

    counts = {t: 0 for t in TOPS}
    for row, _ in detail_rows:
        if row[3] in counts:
            counts[row[3]] += 1
    nflag = sum(1 for _, f in detail_rows if f)

    if a.dry_run:
        json.dump({"detail_rows": [r for r, _ in detail_rows], "review_rows": review_rows}, open(f"{STATE}/dry_run.json", "w"), indent=1)
        log("dry run: wrote state/dry_run.json;", len(detail_rows), "rows,", nflag, "flagged")
    else:
        # Review Queue first, so a crash between the two writes cannot lose a flagged row
        new_review = [r for r in review_rows if r[1] not in queued]
        if new_review:
            rq_last = max((i + 1 for i, r in enumerate(rq) if g(r, 1) or g(r, 0)), default=1)
            sh.put(REVIEW_ID, f"'{REVIEW_TAB}'!A{rq_last + 1}:Q{rq_last + len(new_review)}", new_review)
        rows_only = [r for r, _ in detail_rows]
        if rows_only:
            start = last_row + 1
            sh.put(DETAILS_ID, f"'{DETAILS_TAB}'!A{start}:R{start + len(rows_only) - 1}", rows_only)
            sid = sh.sheet_id(DETAILS_ID, DETAILS_TAB)
            reqs = []
            for k, (_, fl) in enumerate(detail_rows):
                if fl:
                    reqs.append({"repeatCell": {"range": {"sheetId": sid, "startRowIndex": start - 1 + k, "endRowIndex": start + k, "startColumnIndex": 0, "endColumnIndex": ncols},
                                                "cell": {"userEnteredFormat": {"backgroundColor": {"red": 1, "green": 0.96, "blue": 0.75}}}, "fields": "userEnteredFormat.backgroundColor"}})
            if reqs:
                sh.batch(DETAILS_ID, reqs)
        srows = sh.get(REVIEW_ID, f"'{SUMMARY_TAB}'!A1:A500")
        sl = max((i + 1 for i, r in enumerate(srows) if g(r, 0)), default=1)
        sh.put(REVIEW_ID, f"'{SUMMARY_TAB}'!A{sl + 1}:M{sl + 1}", [[week_label, dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M"), len(detail_rows)] +
                [counts[t] for t in TOPS] + [nflag, tr.calls, f"model {MODEL}; whisper {WHISPER}; applied {applied} decision(s)"]])

    msg = (f"Weekly Core One Pro returns job finished for {week_label}: {len(detail_rows)} new return(s), {nflag} flagged for Monday review, "
           f"{applied} earlier decision(s) applied. Review queue: {REVIEW_LINK}")
    if a.dry_run:
        msg = "(dry run) " + msg
    open(f"{STATE}/last_run_discord.txt", "w").write(msg)
    log(msg)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
