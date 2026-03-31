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
const PORT = process.env.PORT || 3002;

let cachedToken    = null;
let tokenExpiresAt = 0;

// SKUs that indicate a device order (not just accessories).
// Only update product_type when one of these appears in the order.
const DEVICE_SKUS = ['CE-A90A', 'A80BPAIR', 'CE-A61', 'DW5A', 'D36', 'A18PAIR', 'D12PAIR', 'A62PAIR', 'A39PAIR'];

// ── Daily stats ────────────────────────────────────────────────────────────

const dailyStats = { requests: 0, usersCreated: 0, usersUpdated: 0, partnerOrders: 0, failsafe: 0, errors: 0 };

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
  dailyStats.partnerOrders = 0;
  dailyStats.failsafe = 0;
  dailyStats.errors = 0;
}

async function sendDailySummary() {
  const date = new Date().toISOString().split('T')[0];
  const icon = dailyStats.errors > 0 ? '⚠️' : '📊';
  const msg = [
    `${icon} SHOPIFY-ORDER-WORKER DAILY SUMMARY`,
    ``,
    `Requests      : ${dailyStats.requests}`,
    `Users Created : ${dailyStats.usersCreated}`,
    `Users Updated : ${dailyStats.usersUpdated}`,
    `Partner Orders: ${dailyStats.partnerOrders}`,
    `Failsafe      : ${dailyStats.failsafe}`,
    `Errors        : ${dailyStats.errors}`,
    `Date: ${date}`,
    `Host: ${os.hostname()}`
  ].join('\n');
  await sendDiscord(msg);
  resetDailyStats();
}

function scheduleDailySummary() {
  const now  = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  setTimeout(() => {
    sendDailySummary().catch(console.error);
    setInterval(() => sendDailySummary().catch(console.error), 24 * 60 * 60 * 1000);
  }, next - now);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePhoneNumber(phone) {
  if (!phone) return '';
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return digits ? '+' + digits : '';
}

function extractField(text, startLabel, endLabel) {
  const regex = new RegExp(`${startLabel}(.*?)${endLabel}`, 's');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Normalize product type from order description.
 * Uses "core one pro" before "core one" to avoid false substring match.
 * Only called when the order contains a device SKU — accessory-only orders
 * do NOT update the user's product_type.
 */
function normalizeProductType(description) {
  const productMap = {
    'core one pro': 'a90',
    'core one':     'a80',
    'beacon':       'dw5a',
    'fusion':       'a61',
    'nexus':        'd36',
    'torch':        'a18',
    'solid':        'd12',
    'style':        'a62',
    'essential':    'a39'
  };

  const lower = (description || '').toLowerCase();
  for (const key of Object.keys(productMap)) {
    if (lower.includes(key)) return productMap[key];
  }
  return 'non_specific';
}

function isDeviceOrder(description) {
  return DEVICE_SKUS.some(sku => (description || '').includes(sku));
}

function isPartnerEmail(email) {
  return (email || '').trim().toLowerCase() === 'logistics@knocking.com';
}

function getShippingBlock(description) {
  const regex = /Shipping address\*?\*?\s*\n([\s\S]*?)(?:\n\s*\n|!\[Shopify\]|\Z)/i;
  const match = (description || '').match(regex);
  return match ? match[1].trim() : '';
}

function normalizeNameFromShippingAddress(description) {
  const block = getShippingBlock(description);
  if (!block) return '';
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[0] : '';
}

function normalizeAddress(description) {
  const block = getShippingBlock(description);
  if (!block) return '';
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i;
  const phoneRegex = /^\+?\d[\d\s\-().]{6,}$/;
  return lines
    .filter((line, idx) => idx !== 0 && !emailRegex.test(line) && !phoneRegex.test(line))
    .join(', ');
}

function normalizeOrderNumber(subject) {
  const m = (subject || '').match(/Order\s+#(\w+)/);
  return m ? m[1] : '';
}

function normalizePhone(description) {
  const lines = (description || '').split('\n').map(l => l.trim()).filter(Boolean);
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i;
  const idx = lines.findIndex(l => emailRegex.test(l));
  if (idx > 0) {
    const m = lines[idx - 1].match(/(\+?\d[\d\s\-().]{6,}\d)/);
    return m ? normalizePhoneNumber(m[1]) : '';
  }
  return '';
}

function normalizeEmail(description) {
  const match = (description || '').match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i);
  return match ? match[0] : '';
}

function normalizeName(subject) {
  const match = (subject || '').match(/placed by (.+)$/);
  return match ? match[1] : '';
}

function parseWarrantyDuration(description) {
  return (description || '').toLowerCase().includes('6-month warranty extension') ? 18 : 12;
}

function formatDate(date) {
  return new Date(date).toISOString().split('T')[0];
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return formatDate(d);
}

// ── Zendesk API ────────────────────────────────────────────────────────────

async function getAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && now < tokenExpiresAt - 60000) return cachedToken;

  const response = await axios.post(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/oauth/tokens`,
    {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'read write tickets:write users:read users:write'
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  cachedToken    = response.data.access_token;
  tokenExpiresAt = now + response.data.expires_in * 1000;
  return cachedToken;
}

async function zendeskGet(url, token) {
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function zendeskPut(url, data, token) {
  return axios.put(url, data, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

async function zendeskPost(url, data, token) {
  return axios.post(url, data, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

async function zendeskDelete(url, data, token) {
  return axios.delete(url, {
    data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
}

async function findZendeskUserByEmail(email, token) {
  const data = await zendeskGet(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(email)}`,
    token
  );
  return data.users.length ? data.users[0] : null;
}

// ── Route ──────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  dailyStats.requests++;
  try {
    const order = req.body;
    const { description = '', subject = '', ticket_id, created_at } = order;

    const customerEmail  = normalizeEmail(description);
    const partnerEmail   = isPartnerEmail(customerEmail);
    if (partnerEmail) dailyStats.partnerOrders++;

    let customerName = normalizeName(subject);
    if (partnerEmail) {
      const shipName = normalizeNameFromShippingAddress(description);
      if (shipName) customerName = shipName;
    }

    const customerPhone   = normalizePhone(description);
    const customerAddress = normalizeAddress(description);
    const orderNumber     = normalizeOrderNumber(subject);
    const purchaseDate    = formatDate(created_at);
    const warrantyMonths  = parseWarrantyDuration(description);
    const warrantyExpiry  = addMonths(purchaseDate, warrantyMonths);

    const purchasedFrom =
      orderNumber.includes('CC') ? 'ceretone.com' :
      orderNumber.includes('CA') ? 'ceretone.ca' : '';

    const token = await getAccessToken();

    const realCustomerEmail = partnerEmail ? '' : customerEmail;
    const hasContactInfo    = Boolean(realCustomerEmail || customerPhone);

    let user = null;
    if (realCustomerEmail) {
      user = await findZendeskUserByEmail(realCustomerEmail, token);
    }

    // Build order history note if key fields changed
    let notesUpdate = '';
    const prevOrder    = user?.user_fields?.order_number;
    const prevPurchase = user?.user_fields?.purchase_date;
    const isOrderChanged    = prevOrder    && prevOrder !== orderNumber;
    const isPurchaseChanged = prevPurchase && formatDate(prevPurchase) !== purchaseDate;

    if ((isOrderChanged || isPurchaseChanged) && prevOrder && prevPurchase) {
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const prevSerial = user?.user_fields?.serial_number || '';
      notesUpdate = `${today}\n${prevOrder}, ${prevSerial}, ${formatDate(prevPurchase)}\n${user?.notes || ''}`.trim();
    }

    // Only update product_type if the order contains an actual device SKU.
    // Accessory-only orders (ear tips, domes, etc.) should not overwrite the
    // customer's product type — this was causing A90 customers to be tagged
    // as A80 when they ordered A80 accessories by mistake.
    const deviceOrder = isDeviceOrder(description);
    const productType = deviceOrder ? normalizeProductType(description) : null;

    const userFields = {
      customeraddress:    customerAddress,
      order_number:       orderNumber,
      purchase_date:      purchaseDate,
      warranty_expiration: warrantyExpiry,
      purchased_from:     purchasedFrom,
      ...(productType && { product_type: productType })
    };

    const updates = {
      name: customerName,
      ...(notesUpdate && { notes: notesUpdate }),
      user_fields: userFields
    };

    // ── Failsafe: no contact info, not a partner order ──
    if (!user && !hasContactInfo && !partnerEmail) {
      dailyStats.failsafe++;
      const failsafeComment = [
        'No customer email or phone number was found in the Shopify order payload.',
        'A Zendesk user could not be created or matched, so the requester was not updated.',
        '',
        `Order Number: ${orderNumber}`,
        `Customer Name (parsed): ${customerName || '[Not detected]'}`,
        `Product: ${productType || '[Accessory or unknown]'}`,
        `Purchase Date: ${purchaseDate}`,
        `Purchased From: ${purchasedFrom || '[Unknown]'}`,
        '',
        "The ticket has been left in 'New' status for manual review."
      ].join('\n');

      await zendeskPut(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
        { ticket: { comment: { body: failsafeComment, public: false } } },
        token
      );
      await zendeskPost(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}/tags.json`,
        { tags: ['shopify__orderconfirm__noinfo'] },
        token
      );
      await zendeskDelete(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}/tags.json`,
        { tags: ['shopify__orderconfirm'] },
        token
      );

      return res.json({ message: 'Ticket left in New — no contact info found.' });
    }

    // ── Create or update user ──
    if (!user && (hasContactInfo || partnerEmail)) {
      if (realCustomerEmail) updates.email = realCustomerEmail;
      if (customerPhone)     updates.phone = customerPhone;
      if (partnerEmail) {
        updates.notes = `${updates.notes || ''}\n[Auto] Partner email logistics@knocking.com detected; used Shipping address name.`.trim();
      }

      const created = await zendeskPost(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users.json`,
        { user: updates },
        token
      );
      user = created.data.user;
      dailyStats.usersCreated++;

    } else if (user) {
      if (realCustomerEmail && user.email !== realCustomerEmail) updates.email = realCustomerEmail;

      const existingDigits = (user.phone || '').replace(/\D/g, '');
      const newDigits      = (customerPhone || '').replace(/\D/g, '');
      if (newDigits && !existingDigits.includes(newDigits)) updates.phone = customerPhone;

      await zendeskPut(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${user.id}.json`,
        { user: updates },
        token
      );
      dailyStats.usersUpdated++;
    }

    // ── Link user to ticket ──
    if (user) {
      await zendeskPut(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
        { ticket: { requester_id: user.id } },
        token
      );
    }

    // ── Internal comment ──
    const comment = [
      'Customer information updated.',
      '',
      `Order Number:        ${orderNumber}`,
      `Product:             ${productType || '[Accessory order — product type not updated]'}`,
      `Purchase Date:       ${purchaseDate}`,
      `Warranty Expiration: ${warrantyExpiry}`,
      `Purchased From:      ${purchasedFrom}`,
      '',
      `Name:    ${customerName}`,
      `Email:   ${realCustomerEmail || (partnerEmail ? '[Partner email ignored]' : '')}`,
      `Phone:   ${customerPhone}`,
      `Address: ${customerAddress}`
    ].join('\n');

    await zendeskPut(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
      { ticket: { comment: { body: comment, public: false } } },
      token
    );

    return res.json({ message: 'User and ticket updated successfully' });

  } catch (err) {
    dailyStats.errors++;
    const detail = err.response?.data || err.message || String(err);
    console.error('ERROR:', JSON.stringify(detail, null, 2));
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`shopify-order-worker listening on port ${PORT}`);
  scheduleDailySummary();
});
