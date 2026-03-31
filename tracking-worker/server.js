'use strict';
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const os      = require('os');

const app  = express();
app.use(express.json());

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN       = process.env.SHOPIFY_TOKEN;
const SHOPIFY_VERSION     = process.env.SHOPIFY_API_VERSION || '2026-01';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PORT                = process.env.PORT || 3004;

// ── Daily stats ────────────────────────────────────────────────────────────

const dailyStats = { requests: 0, fulfillmentsFound: 0, notFound: 0, errors: 0 };

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
    `Errors            : ${dailyStats.errors}`,
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

// ── Route ──────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  dailyStats.requests++;
  const { order_id } = req.body;

  if (!order_id) {
    dailyStats.errors++;
    return res.status(400).json({ error: 'order_id is required' });
  }

  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_VERSION}/orders/${order_id}/fulfillments.json`;
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const fulfillments = response.data.fulfillments || [];

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
      shipped_at:      f.created_at       || null
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`tracking-worker listening on port ${PORT}`);
  scheduleDailySummary();
});
