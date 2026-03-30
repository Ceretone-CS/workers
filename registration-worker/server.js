'use strict';
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const CLIENT_ID        = process.env.ZENDESK_CLIENT_ID;
const CLIENT_SECRET    = process.env.ZENDESK_CLIENT_SECRET;
const PORT             = process.env.PORT || 3003;

let cachedToken    = null;
let tokenExpiresAt = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function extractField(text, startLabel, endLabel) {
  const regex = new RegExp(`${startLabel}(.*?)${endLabel}`, 's');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
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
    // "core one pro" must come before "core one" to avoid substring collision
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

// ── Route ──────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  try {
    const body = req.body;
    const { requester_id, created_at, ticket_id, subject, description } = body;

    // Parse all fields from the concatenated form body
    const parsed = {
      name:          extractField(description, 'First name', 'Email'),
      email:         extractField(description, 'Email',      'Phone'),
      phone:         extractField(description, 'Phone',      'Address'),
      address:       extractField(description, 'Address',    'Product'),
      product_type:  extractField(description, 'Product',    'Purchased from'),
      purchased_from:extractField(description, 'Purchased from', 'Purchase date'),
      purchase_date: extractField(description, 'Purchase date',  'Serial number'),
      // Fixed: was using a hardcoded form artifact that never matched
      serial_number: extractField(description, 'Serial number', 'Please upload')
    };

    // Log any empty fields so we can catch form structure changes early
    const emptyFields = Object.entries(parsed).filter(([,v]) => !v).map(([k]) => k);
    if (emptyFields.length) {
      console.warn(`[ticket ${ticket_id}] Empty fields: ${emptyFields.join(', ')}`);
    }

    const formattedCreatedAt   = formatDate(created_at);
    const formattedPurchaseDate = formatDate(parsed.purchase_date);

    if (!formattedPurchaseDate) {
      console.error(`[ticket ${ticket_id}] Could not parse purchase date: ${repr(parsed.purchase_date)}`);
    }

    // Fetch existing user to evaluate warranty
    const userRes      = await zendeskRequest('get', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${requester_id}.json`);
    const existingUser = userRes.data.user;
    const existingWarranty = existingUser.user_fields?.warranty_expiration;

    // Set warranty to 18 months from purchase, unless they already have
    // a warranty expiring beyond that (e.g. a purchased extension)
    const eighteenMonthsOut   = new Date(formattedPurchaseDate);
    eighteenMonthsOut.setMonth(eighteenMonthsOut.getMonth() + 18);
    const existingWarrantyDate = existingWarranty ? new Date(existingWarranty) : null;

    const newWarrantyExpiration =
      (!existingWarrantyDate || existingWarrantyDate < eighteenMonthsOut)
        ? eighteenMonthsOut.toISOString().split('T')[0]
        : null;

    // Update user profile
    await zendeskRequest('put', `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${requester_id}.json`, {
      user: {
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
      }
    });

    // Solve ticket with internal note
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
        status:  'solved',
        comment: { body: commentBody, public: false }
      }
    });

    console.log(`[ticket ${ticket_id}] Registration processed for ${parsed.name} — ${parsed.product_type}`);
    return res.json({ message: 'User and ticket updated successfully' });

  } catch (err) {
    const detail = err.response?.data || err.message || String(err);
    console.error(`[ticket ${req.body?.ticket_id}] ERROR:`, JSON.stringify(detail, null, 2));
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`registration-worker listening on port ${PORT}`));
