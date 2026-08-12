'use strict';
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const { google } = require('googleapis');

const app  = express();
app.use(express.json());

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN       = process.env.SHOPIFY_TOKEN;
const SHOPIFY_VERSION     = process.env.SHOPIFY_API_VERSION || '2026-01';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PORT                = process.env.PORT || 3004;

const ORDERS_SHEET_ID  = process.env.ORDERS_SHEET_ID  || '1I1PGvKr6p_syfzx7jZTC1uo3eEYNBu5wgDeHvTzGE-E';
const ORDERS_SHEET_GID = process.env.ORDERS_SHEET_GID || '48022519';
const SA_KEY_PATH      = process.env.GOOGLE_SA_KEY_PATH || '/app/credentials/google-sa.json';

// ── Delivery-welcome Zendesk ticket config ──────────────────────────────────

const ZENDESK_SUBDOMAIN     = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_CLIENT_ID     = process.env.ZENDESK_CLIENT_ID;
const ZENDESK_CLIENT_SECRET = process.env.ZENDESK_CLIENT_SECRET;
const ZD_BASE               = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

const DELIVERY_AGENT_IDS = (process.env.DELIVERY_AGENT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(Number);

const AGENT_NAMES = {
  26267302486676: 'Cesar',
  30033178580116: 'Johanna',
  40083267885972: 'Martha',
  30032359709332: 'Rissa',
};

const DELIVERY_STATE_FILE  = process.env.DELIVERY_STATE_FILE || '/app/data/delivery_tickets_state.json';
const DRY_RUN              = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
// How long to keep re-checking a shipped-but-undelivered order before giving up
// on it (e.g. genuinely lost packages). Default 180 days is intentionally well
// beyond normal build/ship times for a custom device.
const PENDING_MAX_AGE_DAYS = parseInt(process.env.PENDING_MAX_AGE_DAYS || '180', 10);

const WELCOME_SUBJECT = 'Welcome to Ceretone — A few tips to get started';

function welcomeBody(firstName, agentName) {
  return `Hi ${firstName},

Thank you for choosing Ceretone! We're excited to help you get started with your new hearing aids.

Getting used to hearing aids can take a little time, especially during the first few days. To help make the setup process smoother, here are our top 3 tips:

1. Start in a quiet environment
When you first begin using your hearing aids, try them in a quiet room at home before moving into louder environments. This gives your ears and brain time to adjust more comfortably.

2. Make sure the fit is secure and comfortable
A proper fit is very important for both comfort and sound quality. If the hearing aids feel loose, uncomfortable, or you hear whistling/feedback, try a different ear tip size to improve the seal.

3. Give yourself time to adjust
It's normal for sounds to feel brighter, sharper, or different at first. We recommend wearing your hearing aids consistently each day so your hearing can gradually adapt.

If you don't mind, I can give you a call tomorrow to check in, answer any questions, and make sure everything is going smoothly. If you'd prefer not to be called, simply reply to this message and let me know — I'm happy to assist you here instead.

Thank you again for choosing Ceretone. We're here to help every step of the way!

Best,
${agentName}
Ceretone Customer Support`;
}

// ── Daily stats ─────────────────────────────────────────────────────────────

const dailyStats = { requests: 0, fulfillmentsFound: 0, notFound: 0, errors: 0, deliveryTickets: 0 };

async function sendDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: msg });
  } catch (e) {
    console.error('Discord webhook error:', e.message);
  }
}

function resetDailyStats() {
  dailyStats.requests = 0;
  dailyStats.fulfillmentsFound = 0;
  dailyStats.notFound = 0;
  dailyStats.errors = 0;
  dailyStats.deliveryTickets = 0;
}

async function sendDailySummary() {
  const date = new Date().toISOString().split('T')[0];
  const icon = dailyStats.errors > 0 ? '⚠️' : '📊';
  const msg = [
    `${icon} TRACKING-WORKER DAILY SUMMARY`,
    ``,
    `Requests          : ${dailyStats.requests}`,
    `Fulfillments Found: ${dailyStats.fulfillmentsFound}`,
    `Not Found (404)   : ${dailyStats.notFound}`,
    `Delivery Tickets  : ${dailyStats.deliveryTickets}`,
    `Errors            : ${dailyStats.errors}`,
    `Date: ${date}`,
    `Host: ${os.hostname()}`
  ].join('\n');
  await sendDiscord(msg);
  resetDailyStats();
}

function scheduleDailySummary() {
  const now  = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    sendDailySummary().catch(console.error);
    setInterval(() => sendDailySummary().catch(console.error), 24 * 60 * 60 * 1000);
  }, next - now);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSheetDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d)) return '';
  const pst = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(pst.map(x => [x.type, x.value]));
  return `${parseInt(p.month)}/${parseInt(p.day)}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

async function fetchShopifyOrders(dateFrom, dateTo) {
  const orders = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/orders.json`
    + `?created_at_min=${dateFrom}T00:00:00-07:00`
    + `&created_at_max=${dateTo}T23:59:59-07:00`
    + `&status=any&limit=250`;

  while (url) {
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    orders.push(...(res.data.orders || []));
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return orders;
}

// Re-fetch a single order by id (used for the pending re-check pass, since
// those orders have aged out of any date-range batch fetchShopifyOrders would
// return).
async function fetchShopifyOrderById(orderId) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/orders/${orderId}.json`;
  const res = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  return res.data.order;
}

async function fetchFulfillments(orderId) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/orders/${orderId}/fulfillments.json`;
  const res = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  return res.data.fulfillments || [];
}

// Fetch the actual delivery timestamp from fulfillment events.
// Returns the happened_at ISO string of the "delivered" event, or null if not found.
async function fetchDeliveryDate(orderId, fulfillmentId) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/orders/${orderId}/fulfillments/${fulfillmentId}/events.json`;
  const res = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  const events = res.data.fulfillment_events || [];
  const delivered = events.find(e => e.status === 'delivered');
  return delivered ? delivered.happened_at : null;
}

// Fetch all products once and return Map<product_id_string → product_type>.
async function fetchProductTypeMap() {
  const map = new Map();
  let url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/products.json?limit=250&fields=id,product_type`;
  while (url) {
    const res = await axios.get(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
    for (const p of res.data.products || []) {
      map.set(String(p.id), p.product_type || '');
    }
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return map;
}

function isCoreOnePro(title) {
  const t = (title || '').toLowerCase();
  return t.includes('core one pro')
    && !t.includes('ear tip')
    && !t.includes('eartip')
    && !t.includes('exclusive')
    && !t.includes('upgrade')
    && !t.includes('replacement');
}

// Checks ALL line items for a Core One Pro device, not just the first one —
// an order with an accessory listed before the device would otherwise be
// misclassified and silently skipped (see incident investigation 2026-08-05).
function orderHasCoreOnePro(order) {
  const items = order.line_items || [];
  return items.some(li => isCoreOnePro(li.title));
}

function isCancelledOrRefunded(order) {
  return Boolean(order.cancelled_at) || ['refunded', 'voided'].includes(order.financial_status);
}

// ── Google Sheets helpers ────────────────────────────────────────────────────

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetName(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ORDERS_SHEET_ID });
  const sheet = meta.data.sheets.find(s => String(s.properties.sheetId) === String(ORDERS_SHEET_GID));
  if (!sheet) throw new Error(`Sheet GID ${ORDERS_SHEET_GID} not found in spreadsheet`);
  return sheet.properties.title;
}

async function buildRowMap(sheets, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ORDERS_SHEET_ID,
    range: `${sheetName}!A:A`,
  });
  const rows = res.data.values || [];
  const map = new Map();
  rows.forEach((row, i) => {
    const val = (row[0] || '').toString().trim();
    if (val && i > 0) map.set(val, i + 1);
  });
  return map;
}

async function writeTrackingRows(sheets, sheetName, updates) {
  if (!updates.length) return;
  const data = [];
  for (const u of updates) {
    data.push(
      { range: `${sheetName}!D${u.row}`, values: [[u.ship_date]] },
      { range: `${sheetName}!E${u.row}`, values: [[u.delivery_date]] },
      { range: `${sheetName}!F${u.row}`, values: [[u.carrier]] },
      { range: `${sheetName}!H${u.row}`, values: [[u.fulfillment_status]] },
    );
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ORDERS_SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// ── Zendesk delivery-welcome ticket ──────────────────────────────────────────

let zdToken = null;
let zdTokenExpiresAt = 0;

async function getZendeskToken(forceRefresh = false) {
  const now = Date.now() / 1000;
  if (!forceRefresh && zdToken && now < zdTokenExpiresAt - 60) return zdToken;
  const resp = await axios.post(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`, {
    grant_type:    'client_credentials',
    client_id:     ZENDESK_CLIENT_ID,
    client_secret: ZENDESK_CLIENT_SECRET,
    scope:         'read write',
  });
  zdToken = resp.data.access_token;
  zdTokenExpiresAt = now + (resp.data.expires_in || 7200);
  return zdToken;
}

async function zdHeaders() {
  return {
    Authorization: `Bearer ${await getZendeskToken()}`,
    'Content-Type': 'application/json',
  };
}

// State file shape:
//   { created_order_ids: [...], pending: { "<orderId>": "<ISO first-seen date>", ... } }
// `pending` holds shipped-but-not-yet-delivered orders that are re-checked on
// every run regardless of how old they are, so a slow-to-arrive order can
// never silently fall out of scope the way it could under the old
// rolling-date-window-only design.
function loadDeliveryState() {
  try {
    const s = JSON.parse(fs.readFileSync(DELIVERY_STATE_FILE, 'utf8'));
    if (!Array.isArray(s.created_order_ids)) s.created_order_ids = [];
    if (typeof s.pending !== 'object' || s.pending === null || Array.isArray(s.pending)) s.pending = {};
    if (!Number.isInteger(s.next_agent_index)) s.next_agent_index = 0;
    return s;
  } catch (e) {
    return { created_order_ids: [], pending: {}, next_agent_index: 0 };
  }
}

function saveDeliveryState(state) {
  fs.mkdirSync(path.dirname(DELIVERY_STATE_FILE), { recursive: true });
  fs.writeFileSync(DELIVERY_STATE_FILE, JSON.stringify(state, null, 2));
}

// Cycles through DELIVERY_AGENT_IDS in order, persisting the cursor in the
// state file so distribution stays fair across restarts and across the two
// createDeliveryTicket call sites (main batch pass + pending re-check pass).
function pickNextAgent(state) {
  if (!DELIVERY_AGENT_IDS.length) return undefined;
  const index = state.next_agent_index % DELIVERY_AGENT_IDS.length;
  state.next_agent_index = (index + 1) % DELIVERY_AGENT_IDS.length;
  return DELIVERY_AGENT_IDS[index];
}

// Creates a delivery ticket. If the customer has an email, sends the welcome message.
// If phone-only, creates an internal call reminder for the assigned agent. Skips if neither.
async function createDeliveryTicket(order, fulfillment, deliveryDate, deliveryState) {
  const email = order.email || (order.customer && order.customer.email);
  const phone = order.phone
    || (order.customer && order.customer.phone)
    || (order.shipping_address && order.shipping_address.phone);

  if (!email && !phone) {
    console.warn(`  [#${order.order_number}] no email or phone — skipping delivery ticket`);
    return null;
  }

  const customerName = [order.customer && order.customer.first_name, order.customer && order.customer.last_name]
    .filter(Boolean).join(' ').trim();
  const firstName = (order.customer && order.customer.first_name) || customerName.split(' ')[0] || 'there';
  const assigneeId = pickNextAgent(deliveryState);
  const agentName = AGENT_NAMES[assigneeId] || 'Ceretone Customer Support';
  const copItem = (order.line_items || []).find(li => isCoreOnePro(li.title));
  const productTitle = (copItem || (order.line_items && order.line_items[0]) || {}).title || 'n/a';

  const orderDetails = [
    `Order: ${order.name}`,
    `Product: ${productTitle}`,
    `Carrier: ${fulfillment.tracking_company || 'n/a'}`,
    `Tracking #: ${fulfillment.tracking_number || 'n/a'}`,
    `Shipped: ${toSheetDate(fulfillment.created_at) || 'n/a'}`,
    `Delivered: ${toSheetDate(deliveryDate) || 'n/a'}`,
  ];

  if (email) {
    // Customer has email — send welcome message as public ticket
    const noteLines = [`Order delivered — auto-generated welcome ticket.`, ...orderDetails];
    const ticketPayload = {
      ticket: {
        subject: WELCOME_SUBJECT,
        requester: { name: customerName || email, email },
        comment: { body: welcomeBody(firstName, agentName), public: true },
        assignee_id: assigneeId,
        ticket_form_id: 50435782665492,
        tags: ['post_delivery_welcome'],
        status: 'open',
      },
    };

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would create welcome ticket for ${order.name} <${email}> assignee_id=${assigneeId}`);
      console.log(`  [DRY RUN] Internal note:\n${noteLines.map(l => '    ' + l).join('\n')}`);
      return { dry_run: true, type: 'welcome', order: order.name, email, assignee_id: assigneeId, note: noteLines };
    }

    const headers = await zdHeaders();
    const createRes = await axios.post(`${ZD_BASE}/tickets.json`, ticketPayload, { headers });
    const ticketId = createRes.data.ticket.id;

    await axios.put(`${ZD_BASE}/tickets/${ticketId}.json`, {
      ticket: { comment: { body: noteLines.join('\n'), public: false } },
    }, { headers });

    return { ticket_id: ticketId, assignee_id: assigneeId, type: 'welcome' };

  } else {
    // Phone only — internal call reminder for the assigned agent, no customer-facing email
    const subject = `Call reminder — ${customerName || 'Customer'} received their Core One Pro (${order.name})`;
    const noteLines = [
      `Customer received their order but has no email on file. Please give them a call to welcome them and check in.`,
      ``,
      `Customer: ${customerName || 'n/a'}`,
      `Phone: ${phone}`,
      ...orderDetails,
    ];

    const ticketPayload = {
      ticket: {
        subject,
        requester: { name: customerName || 'Phone-Only Customer', email: 'support@ceretone.com' },
        comment: { body: noteLines.join('\n'), public: false },
        assignee_id: assigneeId,
        ticket_form_id: 50435782665492,
        tags: ['post_delivery_call_reminder'],
        status: 'open',
      },
    };

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would create call reminder for ${order.name} phone=${phone} assignee_id=${assigneeId}`);
      console.log(`  [DRY RUN] Note:\n${noteLines.map(l => '    ' + l).join('\n')}`);
      return { dry_run: true, type: 'call_reminder', order: order.name, phone, assignee_id: assigneeId, note: noteLines };
    }

    const headers = await zdHeaders();
    const createRes = await axios.post(`${ZD_BASE}/tickets.json`, ticketPayload, { headers });
    const ticketId = createRes.data.ticket.id;

    return { ticket_id: ticketId, assignee_id: assigneeId, type: 'call_reminder' };
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  dailyStats.requests++;
  const { order_id } = req.body;

  if (!order_id) {
    dailyStats.errors++;
    return res.status(400).json({ error: 'order_id is required' });
  }

  try {
    const fulfillments = await fetchFulfillments(order_id);

    if (!fulfillments.length) {
      dailyStats.notFound++;
      return res.status(404).json({ error: 'No fulfillments found for this order' });
    }

    const tracking = fulfillments.map(f => ({
      fulfillment_id:  f.id,
      status:          f.shipment_status || f.status,
      tracking_number: f.tracking_number  || null,
      tracking_url:    f.tracking_url     || null,
      carrier:         f.tracking_company || null,
      shipped_at:      f.created_at       || null,
      delivery_at:     f.estimated_delivery_at || null,
    }));

    dailyStats.fulfillmentsFound += tracking.length;
    console.log(`[order ${order_id}] ${tracking.length} fulfillment(s) returned`);
    return res.json({ order_id, fulfillments: tracking });

  } catch (err) {
    if (err.response?.status === 404) {
      dailyStats.notFound++;
      return res.status(404).json({ error: `Order ${order_id} not found in Shopify` });
    }
    dailyStats.errors++;
    console.error(`[order ${order_id}] ERROR:`, err.response?.data || err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

// Caps how many individual ticket lines get spelled out in the consolidated
// Discord report before falling back to "...and N more" (keeps us safely
// under Discord's ~2000 char message limit on big backlog-catch-up runs).
const DISCORD_LIST_CAP = 20;

function formatListForDiscord(label, lines) {
  if (!lines.length) return '';
  const shown = lines.slice(0, DISCORD_LIST_CAP);
  const rest  = lines.length - shown.length;
  return `\n\n${label} (${lines.length}):\n` + shown.map(l => `  • ${l}`).join('\n')
    + (rest > 0 ? `\n  …and ${rest} more` : '');
}

// Batch sync: fetch orders for a date range, write tracking data to the sheet
// FIRST, and only once that succeeds, evaluate delivery-welcome ticket
// eligibility (so a failed sheet write can never leave us in a state where
// welcome tickets went out but the tracking data behind them didn't save).
// Also re-checks any previously-seen shipped-but-undelivered orders regardless
// of how old they are (see `pending` in the state file), so slow-to-deliver
// custom/build-to-order units don't silently fall out of scope once they age
// past the date_from/date_to window the caller passes in.
// POST /sync  { "date_from": "2026-05-01", "date_to": "2026-05-31" }
app.post('/sync', async (req, res) => {
  const { date_from, date_to } = req.body;
  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from and date_to are required (YYYY-MM-DD)' });
  }

  console.log(`[sync] Starting sync for ${date_from} → ${date_to}`);

  let sheets, sheetName, rowMap;
  try {
    sheets    = await getSheetsClient();
    sheetName = await getSheetName(sheets);
    rowMap    = await buildRowMap(sheets, sheetName);
    console.log(`[sync] Sheet "${sheetName}" loaded — ${rowMap.size} order rows indexed`);
  } catch (e) {
    console.error('[sync] Sheets init error:', e.message);
    return res.status(500).json({ error: 'Google Sheets auth/read failed: ' + e.message });
  }

  let orders;
  try {
    orders = await fetchShopifyOrders(date_from, date_to);
    console.log(`[sync] Fetched ${orders.length} Shopify orders`);
  } catch (e) {
    console.error('[sync] Shopify fetch error:', e.message);
    return res.status(500).json({ error: 'Shopify fetch failed: ' + e.message });
  }

  const deliveryState = loadDeliveryState();
  const deliveryCreatedSet = new Set(deliveryState.created_order_ids);

  // ── Phase 1: fetch fulfillment/delivery info for every order in range ──────
  // No Zendesk activity happens here — this pass only figures out what needs
  // to be written to the tracking sheet, and caches what we've already
  // fetched (fulfillments, delivery date, product/knocking flags) so phase 2
  // doesn't need to re-hit Shopify for the same orders.
  const updates      = [];
  const orderContext = [];
  let notInSheet      = 0;
  let noFulfillment   = 0;
  let fetchErrors     = 0;
  const seenThisRun   = new Set();

  for (const order of orders) {
    const orderId  = String(order.id);
    const orderNum = order.order_number;
    seenThisRun.add(orderId);
    const row      = rowMap.get(orderId);

    if (!row) {
      console.warn(`  [#${orderNum}] id=${orderId} — not found in sheet, skipping`);
      notInSheet++;
      continue;
    }

    let fulfillments;
    try {
      fulfillments = await fetchFulfillments(order.id);
    } catch (e) {
      console.error(`  [#${orderNum}] fulfillment fetch error: ${e.message}`);
      fetchErrors++;
      continue;
    }

    if (!fulfillments.length) {
      console.log(`  [#${orderNum}] no fulfillments`);
      noFulfillment++;
      continue;
    }

    const f = fulfillments[0];
    const isHearingAid    = orderHasCoreOnePro(order);
    const isKnockingOrder = !String(order.name || '').startsWith('#CC');

    let deliveryDate = f.estimated_delivery_at || null;
    if (f.shipment_status === 'delivered') {
      try {
        deliveryDate = await fetchDeliveryDate(order.id, f.id) || deliveryDate;
      } catch (e) {
        console.warn(`  [#${orderNum}] delivery event fetch failed: ${e.message}`);
      }
    }

    updates.push({
      row,
      ship_date:          toSheetDate(f.created_at),
      delivery_date:      toSheetDate(deliveryDate),
      carrier:            f.tracking_company || '',
      fulfillment_status: f.shipment_status  || f.status || '',
    });

    console.log(`  [#${orderNum}] row=${row} cop=${isHearingAid} knocking=${isKnockingOrder} ship=${toSheetDate(f.created_at)} carrier=${f.tracking_company} status=${f.shipment_status || f.status} delivered=${toSheetDate(deliveryDate) || 'n/a'}`);

    orderContext.push({ order, f, deliveryDate, isHearingAid, isKnockingOrder });

    await new Promise(r => setTimeout(r, 250));
  }

  // ── Tracking sheet write happens before any welcome-ticket activity ────────
  try {
    await writeTrackingRows(sheets, sheetName, updates);
    console.log(`[sync] Wrote ${updates.length} rows to sheet`);
  } catch (e) {
    console.error('[sync] Sheet write error:', e.message);
    await sendDiscord(
      `❌ TRACKING SYNC FAILED\nRange: ${date_from} → ${date_to}\n` +
      `Sheet write failed before any welcome tickets were evaluated: ${e.message}\nHost: ${os.hostname()}`
    );
    return res.status(500).json({ error: 'Sheet write failed: ' + e.message });
  }

  // ── Phase 2: welcome-ticket eligibility for this batch, using cached data ──
  const deliveryResults = [];
  const createdLines    = [];
  const failedLines     = [];
  let deliveryTickets   = 0;

  for (const { order, f, deliveryDate, isHearingAid, isKnockingOrder } of orderContext) {
    const orderId = String(order.id);

    if (f.shipment_status === 'delivered' && isHearingAid && !isKnockingOrder && !deliveryCreatedSet.has(orderId)) {
      try {
        const result = await createDeliveryTicket(order, f, deliveryDate, deliveryState);
        if (result && !result.dry_run) {
          deliveryCreatedSet.add(orderId);
          delete deliveryState.pending[orderId];
          deliveryState.created_order_ids = Array.from(deliveryCreatedSet);
          saveDeliveryState(deliveryState);
          deliveryTickets++;
          console.log(`  [#${order.order_number}] delivery ticket #${result.ticket_id} created, assignee=${result.assignee_id}`);
          createdLines.push(`#${result.ticket_id} — ${order.name} (assignee ${AGENT_NAMES[result.assignee_id] || result.assignee_id})`);
        } else if (result && result.dry_run) {
          deliveryResults.push(result);
        }
      } catch (e) {
        const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`  [#${order.order_number}] delivery ticket error: ${msg}`);
        failedLines.push(`${order.name}: ${msg}`);
      }
    } else if (f.shipment_status === 'delivered' && isHearingAid && isKnockingOrder) {
      console.log(`  [#${order.order_number}] skipping delivery ticket — knocking order (${order.name})`);
    }

    // Not yet delivered but otherwise eligible → keep tracking indefinitely so a
    // slow-to-ship/build-to-order device isn't lost once this order ages out of
    // future date-range batches (see pending re-check pass below).
    if (f.shipment_status !== 'delivered' && isHearingAid && !isKnockingOrder && !deliveryCreatedSet.has(orderId)) {
      if (!deliveryState.pending[orderId]) deliveryState.pending[orderId] = new Date().toISOString();
    }
  }

  // ── Phase 3: re-check orders carried over from previous runs that are still
  // pending ──────────────────────────────────────────────────────────────────
  // Without this pass, any order whose delivery takes longer than the caller's
  // lookback window would never be looked at again and would silently never
  // get its welcome ticket — this was the root cause found in the 2026-08-05
  // investigation (only ~10% of eligible Core One Pro deliveries were
  // triggering a ticket).
  let pendingChecked = 0, pendingStillPending = 0, pendingCreated = 0, pendingDropped = 0, pendingErrors = 0;
  const droppedLines = [];
  const pendingIds = Object.keys(deliveryState.pending || {}).filter(id => !seenThisRun.has(id));

  for (const orderId of pendingIds) {
    pendingChecked++;
    const firstSeen = deliveryState.pending[orderId];
    const ageDays = (Date.now() - new Date(firstSeen).getTime()) / 86400000;

    if (deliveryCreatedSet.has(orderId)) {
      delete deliveryState.pending[orderId];
      continue;
    }

    if (ageDays > PENDING_MAX_AGE_DAYS) {
      console.warn(`  [pending #${orderId}] exceeded ${PENDING_MAX_AGE_DAYS}d without delivery confirmation — dropping from tracking`);
      delete deliveryState.pending[orderId];
      pendingDropped++;
      droppedLines.push(`${orderId} (${ageDays.toFixed(0)}d, no delivery confirmation)`);
      continue;
    }

    let order;
    try {
      order = await fetchShopifyOrderById(orderId);
    } catch (e) {
      console.error(`  [pending #${orderId}] order refetch failed: ${e.message}`);
      pendingErrors++;
      continue;
    }

    if (isCancelledOrRefunded(order)) {
      delete deliveryState.pending[orderId];
      continue;
    }

    let fulfillments;
    try {
      fulfillments = await fetchFulfillments(orderId);
    } catch (e) {
      console.error(`  [pending #${orderId}] fulfillment fetch error: ${e.message}`);
      pendingErrors++;
      continue;
    }
    if (!fulfillments.length) { pendingStillPending++; continue; }

    const f = fulfillments[0];
    if (f.shipment_status !== 'delivered') { pendingStillPending++; continue; }

    let deliveryDate = f.estimated_delivery_at || null;
    try {
      deliveryDate = await fetchDeliveryDate(orderId, f.id) || deliveryDate;
    } catch (e) {
      console.warn(`  [pending #${orderId}] delivery event fetch failed: ${e.message}`);
    }

    const isKnockingOrder = !String(order.name || '').startsWith('#CC');
    if (isKnockingOrder) { delete deliveryState.pending[orderId]; continue; }

    try {
      const result = await createDeliveryTicket(order, f, deliveryDate, deliveryState);
      if (result && !result.dry_run) {
        deliveryCreatedSet.add(orderId);
        delete deliveryState.pending[orderId];
        deliveryState.created_order_ids = Array.from(deliveryCreatedSet);
        saveDeliveryState(deliveryState);
        deliveryTickets++;
        pendingCreated++;
        console.log(`  [pending #${orderId}] delivery ticket #${result.ticket_id} created (age ${ageDays.toFixed(1)}d), assignee=${result.assignee_id}`);
        createdLines.push(`#${result.ticket_id} — ${order.name} (pending re-check, ${ageDays.toFixed(0)}d, assignee ${AGENT_NAMES[result.assignee_id] || result.assignee_id})`);
      } else if (result && result.dry_run) {
        deliveryResults.push(result);
      }
    } catch (e) {
      const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.error(`  [pending #${orderId}] delivery ticket error: ${msg}`);
      failedLines.push(`${order.name} (pending re-check): ${msg}`);
      pendingErrors++;
    }

    await new Promise(r => setTimeout(r, 250));
  }

  deliveryState.created_order_ids = Array.from(deliveryCreatedSet);
  saveDeliveryState(deliveryState);

  dailyStats.deliveryTickets += deliveryTickets;

  const summary = {
    date_from,
    date_to,
    orders_fetched:           orders.length,
    rows_updated:             updates.length,
    not_in_sheet:             notInSheet,
    no_fulfillment:           noFulfillment,
    fetch_errors:             fetchErrors,
    delivery_tickets_created: deliveryTickets,
    pending_recheck: {
      checked:       pendingChecked,
      still_pending: pendingStillPending,
      created:       pendingCreated,
      dropped_stale: pendingDropped,
      errors:        pendingErrors,
    },
    dry_run:                  DRY_RUN,
    dry_run_would_create:     deliveryResults,
    // Same detail the Discord report gets, so a bad run is debuggable from
    // sync-cron.log even if the Discord message scrolled by or the container
    // that produced it has since been recreated.
    created_tickets:          createdLines,
    failed_tickets:           failedLines,
    dropped_stale_orders:     droppedLines,
  };

  // ── Single consolidated Discord report for the whole run ───────────────────
  const icon = failedLines.length > 0 ? '⚠️' : '📋';
  await sendDiscord(
    `${icon} TRACKING SYNC COMPLETE\n` +
    `Range: ${date_from} → ${date_to}\n` +
    `Orders: ${orders.length} | Updated: ${updates.length} | Not in sheet: ${notInSheet} | No fulfillment: ${noFulfillment} | Errors: ${fetchErrors}\n` +
    `Delivery tickets created: ${deliveryTickets}${DRY_RUN ? ' (DRY RUN)' : ''} (${pendingCreated} via pending re-check)\n` +
    `Pending re-check: ${pendingChecked} checked, ${pendingStillPending} still pending, ${pendingDropped} dropped (stale)\n` +
    `Host: ${os.hostname()}` +
    formatListForDiscord('✅ Welcome tickets created', createdLines) +
    formatListForDiscord('❌ Failed', failedLines) +
    formatListForDiscord('🗑️ Dropped from tracking (stale)', droppedLines)
  );

  console.log('[sync] Done:', summary);
  return res.json(summary);
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`tracking-worker listening on port ${PORT}`);
  scheduleDailySummary();
});
