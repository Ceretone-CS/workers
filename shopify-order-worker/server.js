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

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_TOKEN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';

let cachedToken    = null;
let tokenExpiresAt = 0;

// SKUs that indicate a device order (not just accessories).
// Only update product_type when one of these appears in the order.
const DEVICE_SKUS = ['CE-A90A', 'A80BPAIR', 'CE-A61', 'DW5A', 'D36', 'A18PAIR', 'D12PAIR', 'A62PAIR', 'A39PAIR'];

// Zendesk agent ID for "Ceretone (DO NOT REPLY)" — assigned on every processed ticket.
const CERETONE_AGENT_ID = 46221339676692;

// 📊 Daily stats ─────────────────────────────────────────────────────────────

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
  const icon = dailyStats.errors > 0 ? '🔴' : '🟢';
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
  // Midnight PST (UTC-8) = 08:00 UTC
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    sendDailySummary().catch(console.error);
    setInterval(() => sendDailySummary().catch(console.error), 24 * 60 * 60 * 1000);
  }, next - now);
}

// 🛠 Helpers ──────────────────────────────────────────────────────────────────

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
  // Note: \Z is not an end-of-string anchor in JS (it's the literal char "Z",
  // matching any z/Z case-insensitively) — use $ instead.
  const regex = /Shipping address\*?\*?\s*\n([\s\S]*?)(?:\n\s*!?\[?Shopify\]?|$)/i;
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
  // Search the shipping block first (see normalizeEmail comment below for why:
  // a whole-description scan can anchor off a forwarded header instead of the
  // real shipping-block content). Prefer the line right before an email line
  // (typical layout); fall back to any standalone phone-shaped line in the
  // block (covers orders with no email at all, e.g. phone-only checkouts).
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i;
  const phoneCapture = /(\+?\d[\d\s\-().]{6,}\d)/;
  // Anchored (whole-line) version for the standalone fallback below, so a
  // ZIP+4 embedded in "City, State 12345-6789" can't false-match — real phone
  // lines in these emails are always their own standalone line.
  const standalonePhone = /^\+?\d[\d\s\-().]{6,}$/;
  const block = getShippingBlock(description);
  const blockLines = block.split('\n').map(l => l.trim()).filter(Boolean);

  const emailIdx = blockLines.findIndex(l => emailRegex.test(l));
  if (emailIdx > 0) {
    const m = blockLines[emailIdx - 1].match(phoneCapture);
    if (m) return normalizePhoneNumber(m[1]);
  }
  const standalone = blockLines.find(l => standalonePhone.test(l));
  if (standalone) return normalizePhoneNumber(standalone);
  return '';
}

// Customers never legitimately have a @ceretone.com address (that's the
// company's own domain) — a match against it means we picked up a shared
// mailbox / forwarded-header address, not a real customer.
function isInternalEmail(email) {
  return /@ceretone\.com$/i.test(email || '');
}

function normalizeEmail(description) {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i;
  // Forwarded (FW:) tickets quote the original From/To headers above the actual
  // order content, so a whole-description scan can grab info@ceretone.com (the
  // shared Support inbox) instead of the real customer email in the shipping
  // block. Prefer the shipping block; only fall back to a full scan if it's
  // empty, and never accept an internal ceretone.com address as the customer.
  const block = getShippingBlock(description);
  const blockMatch = block.match(emailRegex);
  if (blockMatch && !isInternalEmail(blockMatch[0])) return blockMatch[0];
  const match = (description || '').match(emailRegex);
  if (match && !isInternalEmail(match[0])) return match[0];
  return '';
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

// 🔑 Zendesk API ──────────────────────────────────────────────────────────────

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

function isTokenError(err) {
  return err.response?.status === 401 ||
    err.response?.data?.error === 'invalid_token';
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

// 🛒 Shopify API ──────────────────────────────────────────────────────────────

async function fetchShopifyContact(orderNumber) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN || !orderNumber) return null;
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/orders.json` +
      `?name=${encodeURIComponent('#' + orderNumber)}&status=any&fields=email,phone,customer`;
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const shopifyOrder = res.data.orders?.[0];
    if (!shopifyOrder) return null;
    return {
      email: shopifyOrder.email || shopifyOrder.customer?.email || '',
      phone: shopifyOrder.phone || shopifyOrder.customer?.phone || ''
    };
  } catch (e) {
    console.error('Shopify lookup error:', e.message);
    return null;
  }
}

// 🚀 Route ────────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  dailyStats.requests++;

  // Inner handler — accepts a token so we can retry with a fresh one on 401.
  async function handle(token) {
    const order = req.body;
    console.log('BODY_KEYS:', JSON.stringify(Object.keys(order)));
    const { description = '', subject = '', created_at } = order;
    const ticket_id = order.ticket_id ?? order.id;

    if (!ticket_id) {
      console.error('MISSING_TICKET_ID body:', JSON.stringify(order).slice(0, 500));
      return res.status(400).json({ error: 'ticket_id missing from payload' });
    }

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

    // Fix: guard against missing created_at to prevent "Invalid time value" crash
    const purchaseDate    = created_at ? formatDate(created_at) : formatDate(new Date().toISOString());
    const warrantyMonths  = parseWarrantyDuration(description);
    const warrantyExpiry  = addMonths(purchaseDate, warrantyMonths);

    const purchasedFrom =
      orderNumber.includes('CC') ? 'ceretone.com' :
      orderNumber.includes('CA') ? 'ceretone.ca' : '';

    let realCustomerEmail = partnerEmail ? '' : customerEmail;
    let customerPhoneFinal = customerPhone;

    // If no contact info found in description, fall back to Shopify API
    if (!realCustomerEmail && !customerPhoneFinal && !partnerEmail && orderNumber) {
      const shopify = await fetchShopifyContact(orderNumber);
      if (shopify) {
        if (shopify.email) realCustomerEmail = shopify.email;
        if (shopify.phone) customerPhoneFinal = normalizePhoneNumber(shopify.phone);
        if (shopify.email || shopify.phone) {
          console.log(`Shopify fallback for ${orderNumber}: email=${shopify.email} phone=${shopify.phone}`);
        }
      }
    }

    const hasContactInfo = Boolean(realCustomerEmail || customerPhoneFinal);

    let user = null;
    if (realCustomerEmail) {
      user = await findZendeskUserByEmail(realCustomerEmail, token);
    }

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

    const deviceOrder = isDeviceOrder(description);
    const productType = deviceOrder ? normalizeProductType(description) : null;
    // Ticket field "Product Type" (tagger, required to solve) isn't always set by
    // the SKU-specific triggers (e.g. accessory-only or DME bulk orders), so make
    // sure it's always populated to avoid a 422 on this ticket update.
    const productTag = 'product__' + (productType || 'general');

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

    // 🛡 Failsafe: no contact info, not a partner order
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

      await zendeskPost(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}/tags.json`,
        { tags: [productTag] },
        token
      );
      await zendeskPut(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
        { ticket: { assignee_id: CERETONE_AGENT_ID, comment: { body: failsafeComment, public: false } } },
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

      return res.json({ message: 'Ticket left in New - no contact info found.' });
    }

    // 👤 Create or update user
    if (!user && (hasContactInfo || partnerEmail)) {
      if (realCustomerEmail)   updates.email = realCustomerEmail;
      if (customerPhoneFinal) updates.phone = customerPhoneFinal;
      if (partnerEmail) {
        updates.notes = `${updates.notes || ''}\n[Auto] Partner email logistics@knocking.com detected; used Shipping address name.`.trim();
      }

      try {
        const created = await zendeskPost(
          `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users.json`,
          { user: updates },
          token
        );
        user = created.data.user;
        dailyStats.usersCreated++;
      } catch (createErr) {
        // Fix: on DatabaseConflict (concurrent duplicate create), fall back to search + update
        if (createErr.response?.status === 409 ||
            createErr.response?.data?.error === 'DatabaseConflict') {
          if (realCustomerEmail) {
            user = await findZendeskUserByEmail(realCustomerEmail, token);
          }
          if (user) {
            await zendeskPut(
              `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${user.id}.json`,
              { user: updates },
              token
            );
            dailyStats.usersUpdated++;
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }

    } else if (user) {
      if (realCustomerEmail && user.email !== realCustomerEmail) updates.email = realCustomerEmail;

      const existingDigits = (user.phone || '').replace(/\D/g, '');
      const newDigits      = (customerPhoneFinal || '').replace(/\D/g, '');
      if (newDigits && !existingDigits.includes(newDigits)) updates.phone = customerPhoneFinal;

      await zendeskPut(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${user.id}.json`,
        { user: updates },
        token
      );
      dailyStats.usersUpdated++;
    }

    // 🔗 Link user to ticket and set assignee
    if (user) {
      await zendeskPost(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}/tags.json`,
        { tags: [productTag] },
        token
      );
      await zendeskPut(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
        { ticket: { requester_id: user.id, assignee_id: CERETONE_AGENT_ID } },
        token
      );
    }

    // 💬 Internal comment
    const comment = [
      'Customer information updated.',
      '',
      `Order Number:        ${orderNumber}`,
      `Product:             ${productType || '[Accessory order - product type not updated]'}`,
      `Purchase Date:       ${purchaseDate}`,
      `Warranty Expiration: ${warrantyExpiry}`,
      `Purchased From:      ${purchasedFrom}`,
      '',
      `Name:    ${customerName}`,
      `Email:   ${realCustomerEmail || (partnerEmail ? '[Partner email ignored]' : '')}`,
      `Phone:   ${customerPhoneFinal}`,
      `Address: ${customerAddress}`
    ].join('\n');

    await zendeskPut(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
      { ticket: { comment: { body: comment, public: false } } },
      token
    );

    return res.json({ message: 'User and ticket updated successfully' });
  }

  try {
    // Fix: retry once with a fresh token on invalid_token / 401
    let token = await getAccessToken();
    try {
      return await handle(token);
    } catch (err) {
      if (isTokenError(err)) {
        token = await getAccessToken(true);
        return await handle(token);
      }
      throw err;
    }
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
