'use strict';
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { google } = require('googleapis');

const app  = express();
app.use(express.json());

const PORT               = process.env.PORT || 3007;
const SHEET_ID            = process.env.RETURN_LOG_SHEET_ID;
const SHEET_TAB           = process.env.RETURN_LOG_SHEET_TAB || 'Form Responses 1';
const SA_KEY_PATH         = process.env.GOOGLE_SA_KEY_PATH || '/app/credentials/google-sa.json';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DRY_RUN             = process.env.DRY_RUN === 'true';

const ZENDESK_SUBDOMAIN     = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_CLIENT_ID     = process.env.ZENDESK_CLIENT_ID;
const ZENDESK_CLIENT_SECRET = process.env.ZENDESK_CLIENT_SECRET;
const ZD_BASE               = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const ESCALATION_GROUP_ID = 26200919225364; // Audicon TL
const REPEAT_TAG          = 'repeat_incident_flag';
const STATE_FILE          = process.env.STATE_FILE || '/app/data/repeat_flag_state.json';

// Column indices in "Form Responses 1" (0-indexed, verified against live header row)
const COL = {
  ORDER_DATE: 3,
  TYPE: 5,
  ZD_TICKET: 7,
  PRODUCT: 10,
  COP_REPLACEMENT: 20,
  STATUS: 31,
  ORDER_NUM: 2,
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { flagged_ticket_ids: [] }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const DISCORD_MSG_LIMIT = 2000;
async function sendDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  if (msg.length > DISCORD_MSG_LIMIT) {
    msg = msg.slice(0, DISCORD_MSG_LIMIT - 40) + '\n…(truncated — see data/run.log)';
  }
  try { await axios.post(DISCORD_WEBHOOK_URL, { content: msg }); }
  catch (e) { console.error('Discord webhook error:', e.message); }
}

async function zdHeaders() {
  const resp = await axios.post(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`, {
    grant_type: 'client_credentials',
    client_id: ZENDESK_CLIENT_ID,
    client_secret: ZENDESK_CLIENT_SECRET,
    scope: 'read write',
  });
  return { Authorization: `Bearer ${resp.data.access_token}` };
}

function parseSheetDate(v) {
  if (!v) return null;
  v = String(v).trim();
  try {
    if (/^\d{6}$/.test(v)) {
      const yy = parseInt(v.slice(0, 2), 10), mm = parseInt(v.slice(2, 4), 10) - 1, dd = parseInt(v.slice(4, 6), 10);
      return new Date(2000 + yy, mm, dd);
    }
    if (v.includes('/')) {
      const [datePart] = v.split(' ');
      const [m, d, y] = datePart.split('/').map(Number);
      return new Date(y, m - 1, d);
    }
  } catch (e) { /* fall through */ }
  return null;
}

function isCC(orderNum) {
  const o = (orderNum || '').trim().toUpperCase();
  return o.startsWith('#CC') || o.startsWith('CC');
}

function cell(row, idx) {
  return (row[idx] || '').toString();
}

function isQualifying(row) {
  const product = cell(row, COL.PRODUCT).toLowerCase();
  if (!product.includes('core one pro')) return false;
  const type = cell(row, COL.TYPE);
  if (type === 'Return') return true; // any status — flag while still in progress, not just completed refunds
  if (type === 'Replacement' && cell(row, COL.COP_REPLACEMENT).toLowerCase().includes('new kit')) return true;
  return false;
}

async function fetchSheetRows() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A2:AI`, // skip header row
  });
  return res.data.values || [];
}

async function flagTicket(zdTicketId, orderNum, priorEvents, headers) {
  const summaryLines = priorEvents.map(
    e => `  • ${e.date ? e.date.toISOString().slice(0, 10) : 'unknown date'} — Zendesk #${e.zdTicket || 'n/a'} (${e.type})`
  );
  const noteBody =
    `⚠️ Repeat product-health incident detected for order ${orderNum}.\n` +
    `This customer has ${priorEvents.length} prior Return/Replacement event(s) on file:\n` +
    summaryLines.join('\n') +
    `\n\nFlagged for supervisor review before this ticket is solved. (Automated: repeat-failure-worker)`;

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would flag ticket ${zdTicketId} for order ${orderNum}:\n${noteBody}`);
    return { dry_run: true };
  }

  // Fetch current tags so we don't clobber them
  const current = await axios.get(`${ZD_BASE}/tickets/${zdTicketId}.json`, { headers });
  const tags = Array.from(new Set([...(current.data.ticket.tags || []), REPEAT_TAG]));

  try {
    await axios.put(`${ZD_BASE}/tickets/${zdTicketId}.json`, {
      ticket: {
        tags,
        group_id: ESCALATION_GROUP_ID,
        comment: { body: noteBody, public: false },
      },
    }, { headers });
  } catch (e) {
    const details = e.response && e.response.data && e.response.data.details;
    const isRequiredFieldLock = details && JSON.stringify(details).includes('is required when solving');
    if (isRequiredFieldLock) {
      const err = new Error(`LOCKED_TICKET: #${zdTicketId} cannot be updated via API — a required field is blank on this already-solved/closed ticket (same class of issue found in the 60-day field migration). Needs manual escalation.`);
      err.locked = true;
      throw err;
    }
    throw e;
  }

  return { flagged: true };
}

async function runCheck() {
  const state = loadState();
  const flaggedSet = new Set(state.flagged_ticket_ids || []);
  const lockedSet = new Set(state.locked_ticket_ids || []);
  const rows = await fetchSheetRows();

  // Build per-order chronological history of qualifying events
  const byOrder = new Map();
  for (const row of rows) {
    if (!isCC(cell(row, COL.ORDER_NUM))) continue;
    if (!isQualifying(row)) continue;
    const orderNum = cell(row, COL.ORDER_NUM).trim();
    const date = parseSheetDate(cell(row, COL.ORDER_DATE));
    const zdTicket = cell(row, COL.ZD_TICKET).trim();
    const type = cell(row, COL.TYPE);
    if (!byOrder.has(orderNum)) byOrder.set(orderNum, []);
    byOrder.get(orderNum).push({ date, zdTicket, type });
  }

  const headers = DRY_RUN ? null : await zdHeaders();
  const newlyFlagged = [];
  const errors = [];

  for (const [orderNum, events] of byOrder) {
    if (events.length < 2) continue;
    events.sort((a, b) => (a.date || 0) - (b.date || 0));
    const latest = events[events.length - 1];
    const priorEvents = events.slice(0, -1);
    if (!latest.zdTicket) continue; // can't act without a ticket id
    if (flaggedSet.has(latest.zdTicket)) continue; // already handled
    if (lockedSet.has(latest.zdTicket)) continue; // known-locked, needs manual handling, don't re-alert every run

    try {
      const result = await flagTicket(latest.zdTicket, orderNum, priorEvents, headers);
      newlyFlagged.push({ orderNum, zdTicket: latest.zdTicket, priorCount: priorEvents.length, dry_run: !!result.dry_run });
      if (!result.dry_run) {
        flaggedSet.add(latest.zdTicket);
      }
    } catch (e) {
      if (e.locked) {
        lockedSet.add(latest.zdTicket);
      }
      errors.push({ orderNum, zdTicket: latest.zdTicket, error: e.response ? JSON.stringify(e.response.data) : e.message, locked: !!e.locked });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  state.flagged_ticket_ids = Array.from(flaggedSet);
  state.locked_ticket_ids = Array.from(lockedSet);
  state.last_run = new Date().toISOString();
  saveState(state);

  const summary = {
    checked_orders: byOrder.size,
    newly_flagged: newlyFlagged.length,
    errors: errors.length,
    newly_flagged_detail: newlyFlagged,
    errors_detail: errors,
  };

  console.log(JSON.stringify(summary));

  if (newlyFlagged.length > 0) {
    const lines = newlyFlagged.map(f => `#${f.zdTicket} (order ${f.orderNum}, ${f.priorCount} prior incident(s))`);
    await sendDiscord(`🔁 Repeat-failure check: ${newlyFlagged.length} ticket(s) escalated to Audicon TL\n${lines.join('\n')}\nHost: ${os.hostname()}`);
  }
  if (errors.length > 0) {
    await sendDiscord(`❌ Repeat-failure check: ${errors.length} error(s)\n${JSON.stringify(errors).slice(0, 1500)}\nHost: ${os.hostname()}`);
  }

  return summary;
}

app.post('/check', async (req, res) => {
  try {
    const summary = await runCheck();
    res.json(summary);
  } catch (e) {
    console.error('Run failed:', e.message);
    await sendDiscord(`❌ REPEAT-FAILURE WORKER RUN FAILED\n${e.message}\nHost: ${os.hostname()}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`repeat-failure-worker listening on ${PORT} (DRY_RUN=${DRY_RUN})`));
