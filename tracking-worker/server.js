'use strict';
require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app  = express();
app.use(express.json());

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_TOKEN;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';
const PORT            = process.env.PORT || 3004;

// ── Route ──────────────────────────────────────────────────────────────────

app.post('/', async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
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
      return res.status(404).json({ error: 'No fulfillments found for this order' });
    }

    // Return all fulfillments — split shipments each get their own entry
    const tracking = fulfillments.map(f => ({
      fulfillment_id:  f.id,
      status:          f.shipment_status || f.status,
      tracking_number: f.tracking_number  || null,
      tracking_url:    f.tracking_url     || null,
      carrier:         f.tracking_company || null,
      shipped_at:      f.created_at       || null
    }));

    console.log(`[order ${order_id}] ${tracking.length} fulfillment(s) returned`);
    return res.json({ order_id, fulfillments: tracking });

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `Order ${order_id} not found in Shopify` });
    }
    console.error(`[order ${order_id}] ERROR:`, err.response?.data || err.message);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`tracking-worker listening on port ${PORT}`));
