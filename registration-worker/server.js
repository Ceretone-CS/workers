'use strict';
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const os = require('os');

const app = express();
app.use(express.json());

const ZENDESK_SUBDOMAIN   = process.env.ZENDESK_SUBDOMAIN;
const CLIENT_ID           = process.env.ZENDESK_CLIENT_ID;
const CLIENT_SECRET       = process.env.ZENDESK_CLIENT_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PORT                = process.env.PORT || 3003;

let cachedToken    = null;
let tokenExpiresAt = 0;

// ── Daily stats ────────────────────────────────────────────────────────────

const dailyStats = { requests: 0, usersCreated: 0, usersUpdated: 0, warrantyExtended: 0, skipped: 0, errors: 0 };

// Zendesk agent ID for "Ceretone (DO NOT REPLY)" — the "Shopify::Product
// Registration" trigger already sets this as the assignee at ticket-creation
// time, so this worker doesn't need to touch it; kept here only for reference.
const CERETONE_AGENT_ID = 46221339676692;

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
  dailyStats.usersCreated = 0;
  dailyStats.usersUpdated = 0;
  dailyStats.warrantyExtended = 0;
  dailyStats.skipped = 0;
  dailyStats.errors = 0;
}

async function sendDailySummary() {
  const date = new Date().toISOString().split('T')[0];
  const icon = dailyStats.errors > 0 ? '⚠️' : '📊';
  const msg = [
    `${icon} REGISTRATION-WORKER DAILY SUMMARY`,
    ``,
    `Requests         : ${dailyStats.requests}`,
    `Users Created    : ${dailyStats.usersCreated}`,
    `Users Updated    : ${dailyStats.usersUpdated}`,
    `Warranty Extended: ${dailyStats.warrantyExtended}`,
    `Skipped (no email): ${dailyStats.skipped}`,
    `Errors           : ${dailyStats.errors}`,
    `Date: ${date}`,
    `Host: ${os.hostname()}`
  ].join('\n');
  await sendDiscord(msg);
  resetDailyStats();
}

function scheduleDailySummary() {
  const now  = new Date();
  // Midnight PST (UTC-8) = 08:00 UTC
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    sendDailySummary().catch(console.error);
    setInterval(() => sendDailySummary().catch(console.error), 24 * 60 * 60 * 1000);
  }, next - now);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractField(text, startLabel, endLabel) {
  const regex = new RegExp(`${startLabel}(.*?)${endLabel}`, 's');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

// Outlook-style forwards render mailto:/tel: links as plain text right after
// the address (e.g. "deborahkroll7@gmail.com<mailto:deborahkroll7@gmail.com>"),
// which would otherwise get stored/searched with the annotation still attached.
function stripLinkAnnotation(value) {
  return (value || '').replace(/<(?:mailto|tel):[^>]*>/gi, '').trim();
}

function formatDate(dateString) {
  if (!dateString) return '';
  const months = {
    January:'01', February:'02', March:'03', April:'04',
    May:'05', June:'06', July:'07', August:'08',
    September:'09', October:'10', November:'11', December:'12'
  };
  if (dateString.includes(',')) {
    const [month, day, year] = dateString.replace(',', '').split(' ');
    return `${year}-${months[month]}-${day.padStart(2, '0')}`;
  }
  if (dateString.includes('/')) {
    const [month, day, year] = dateString.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return dateString;
}

function normalizeProductType(raw) {
  const map = {
    'core one pro': 'a90',
    'core one':     'a80',
    'beacon':       'dw5a',
    'fusion':       'a61',
    'nexus':        'd36',
    'torch':        'a18',
    'solid':        'd12',
    'style':        'a62',
    'essential':    'a39',
    'equate d26':   'd26'
  };
  return map[raw.trim().toLowerCase()] || 'non_specific';
}

function normalizePurchasedFrom(raw, orderNumber = '') {
  if (/CC/i.test(orderNumber)) return 'ceretone.com';
  if (/CA/i.test(orderNumber)) return 'ceretone.ca';

  const map = {
    'ceretone.com':       'ceretone.com',
    'ceretone.ca':        'ceretone.ca',
    'walmart':            'walmartusa',
    'amazon':             'amazonusa',
    'target':             'targetusa',
    'best buy':           'bestbuyusa',
    'qvc':                'qvc',
    'hsn':                'hsn',
    'hsa store/fsa store':'cardinalhealth',
    'cardinal health':    'cardinalhealth',
    'myshopexchange.com': 'aafes',
    'aafes':              'aafes',
    'shoppersdrugsmart.com': 'sdm',
    'shoppers drug mart': 'sdm',
    'other':              'purchaseotherusa'
  };
  return map[raw.trim().toLowerCase()] || 'purchaseother';
}

function addMonths(dateStr, monthsToAdd) {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + monthsToAdd);
  return date.toISOString().split('T')[0];
}

// ── Zendesk API ────────────────────────────────────────────────────────────

async function getAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && now < tokenExpiresAt - 60000) return cachedToken;

  const response = await axios.post(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`,
    {
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope:         'read write tickets:write users:read users:write'
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  cachedToken    = response.data.access_token;
  tokenExpiresAt = now + response.data.expires_in * 1000;
  return cachedToken;
}

async function zendeskRequest(method, url, data = null, retry = true) {
  let token = await getAccessToken();
  try {
    return await axios({ method, url, data, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  } catch (err) {
    if (retry && [401, 403].includes(err.response?.status)) {
      token = await getAccessToken(true);
      return await axios({ method, url, data, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    }
    throw err;
  }
}

async function findZendeskUserByEmail(email) {
  const res = await zendeskRequest('get', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(email)}`);
  return res.data.users.length ? res.data.users[0] : null;
}

// ── Route ──────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  dailyStats.requests++;
  try {
    const body = req.body;
    const { created_at, subject, description = '' } = body;
    const ticket_id = body.ticket_id ?? body.id;

    if (!ticket_id) {
      console.error('MISSING_TICKET_ID body:', JSON.stringify(body).slice(0, 500));
      return res.status(400).json({ error: 'ticket_id missing from payload' });
    }

    const parsed = {
      name:          extractField(description, 'First name', 'Email'),
      email:         stripLinkAnnotation(extractField(description, 'Email', 'Phone')),
      phone:         stripLinkAnnotation(extractField(description, 'Phone', 'Address')),
      address:       extractField(description, 'Address',    'Product'),
      product_type:  extractField(description, 'Product',    'Purchased from'),
      purchased_from:extractField(description, 'Purchased from', 'Purchase date'),
      purchase_date: extractField(description, 'Purchase date',  'Serial number'),
      serial_number: extractField(description, 'Serial number', 'Please upload')
    };

    const emptyFields = Object.entries(parsed).filter(([,v]) => !v).map(([k]) => k);
    if (emptyFields.length) {
      console.warn(`[ticket ${ticket_id}] Empty fields: ${emptyFields.join(', ')}`);
    }

    // Never trust the payload's requester_id — the ticket always starts out
    // pointed at the shared Support/info@ceretone.com inbox, so blindly
    // writing to that id (the old behavior) meant every registration
    // overwrote the same shared account. Match/create the real customer by
    // the email parsed out of the form submission instead.
    if (!parsed.email) {
      dailyStats.skipped++;
      console.error(`[ticket ${ticket_id}] No email parsed from registration form — leaving requester unchanged for manual review.`);
      await zendeskRequest('put', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
        ticket: { comment: { body: 'No email found in registration form submission, so the requester was not updated. Needs manual review.', public: false } }
      });
      return res.json({ message: 'No email parsed - left for manual review.' });
    }

    const formattedCreatedAt    = formatDate(created_at);
    const formattedPurchaseDate = formatDate(parsed.purchase_date);

    if (!formattedPurchaseDate) {
      console.error(`[ticket ${ticket_id}] Could not parse purchase date: "${parsed.purchase_date}"`);
    }

    let user = await findZendeskUserByEmail(parsed.email);
    const existingWarranty = user?.user_fields?.warranty_expiration;

    const eighteenMonthsOut   = new Date(formattedPurchaseDate);
    eighteenMonthsOut.setMonth(eighteenMonthsOut.getMonth() + 18);
    const existingWarrantyDate = existingWarranty ? new Date(existingWarranty) : null;

    const newWarrantyExpiration =
      (!existingWarrantyDate || existingWarrantyDate < eighteenMonthsOut)
        ? eighteenMonthsOut.toISOString().split('T')[0]
        : null;

    if (newWarrantyExpiration) dailyStats.warrantyExtended++;

    const userUpdates = {
      name:  parsed.name,
      phone: parsed.phone,
      email: parsed.email,
      user_fields: {
        customeraddress:   parsed.address,
        serial_number:     parsed.serial_number,
        purchased_from:    normalizePurchasedFrom(parsed.purchased_from, subject),
        purchase_date:     formattedPurchaseDate,
        registration_date: formattedCreatedAt,
        product_type:      normalizeProductType(parsed.product_type),
        ...(newWarrantyExpiration && { warranty_expiration: newWarrantyExpiration })
      }
    };

    if (user) {
      await zendeskRequest('put', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${user.id}.json`, { user: userUpdates });
      dailyStats.usersUpdated++;
    } else {
      try {
        const created = await zendeskRequest('post', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users.json`, { user: userUpdates });
        user = created.data.user;
        dailyStats.usersCreated++;
      } catch (createErr) {
        // Concurrent duplicate create (e.g. a retried webhook delivery) — fall back to search + update.
        if (createErr.response?.status === 409 || createErr.response?.data?.error === 'DatabaseConflict') {
          user = await findZendeskUserByEmail(parsed.email);
          if (!user) throw createErr;
          await zendeskRequest('put', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${user.id}.json`, { user: userUpdates });
          dailyStats.usersUpdated++;
        } else {
          throw createErr;
        }
      }
    }

    const commentBody = [
      'Customer details updated:',
      `Ticket ID:          ${ticket_id}`,
      `Name:               ${parsed.name}`,
      `Address:            ${parsed.address}`,
      `Serial Number:      ${parsed.serial_number}`,
      `Purchased From:     ${parsed.purchased_from}`,
      `Purchase Date:      ${formattedPurchaseDate}`,
      `Registration Date:  ${formattedCreatedAt}`,
      `Product Type:       ${parsed.product_type}`,
      `Warranty Expiration:${newWarrantyExpiration || existingWarranty || 'unchanged'}`
    ].join('\n');

    await zendeskRequest('put', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`, {
      ticket: {
        requester_id: user.id,
        status:  'solved',
        comment: { body: commentBody, public: false }
      }
    });

    console.log(`[ticket ${ticket_id}] Registration processed for ${parsed.name} — ${parsed.product_type}`);
    return res.json({ message: 'User and ticket updated successfully' });

  } catch (err) {
    dailyStats.errors++;
    const detail = err.response?.data || err.message || String(err);
    console.error(`[ticket ${req.body?.ticket_id ?? req.body?.id}] ERROR:`, JSON.stringify(detail, null, 2));
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Catch malformed JSON bodies (Zendesk test pings, retries with empty body, etc.)
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    console.warn('[bad-request] Malformed JSON body ignored');
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`registration-worker listening on port ${PORT}`);
  scheduleDailySummary();
});
