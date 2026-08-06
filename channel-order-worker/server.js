"use strict";
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const SHOPIFY_STORE          = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN          = process.env.SHOPIFY_TOKEN;
const SHOPIFY_VERSION        = process.env.SHOPIFY_API_VERSION || "2025-01";
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const PORT             = parseInt(process.env.PORT) || 3005;
const TRACKING_POLL_MS = 60 * 60 * 1000;
const PAYMENT_POLL_MS  = 60 * 60 * 1000;  // 1 hour fallback (webhook handles real-time)

// ── Channel configs ────────────────────────────────────────────────────────
const CHANNELS = {
  secretsavings: {
    store:      process.env.SS_SHOPIFY_STORE,
    token:      process.env.SS_SHOPIFY_TOKEN,
    sheetId:    process.env.SS_SHEET_ID,
    tab:        "SecretSavings",
    prefix:     "SS",
    customerId: parseInt(process.env.SS_CUSTOMER_ID),
    cols:       { carrier: 12, tracking: 13, total: 14 },
  },
  dme: {
    sheetId:        process.env.DME_SHEET_ID,
    tab:            "DMEOrders",
    prefix:         "DME",
    customerId:     parseInt(process.env.DME_CUSTOMER_ID),
    useDraftOrder:  true,       // creates draft order + sends invoice with Pay Now
    sendReceipt:    process.env.DME_SEND_RECEIPT === "true",
    invoiceEmail:   process.env.DME_INVOICE_EMAIL || null,
    pendingPayment: true,
    cols:           { price: 11, carrier: 12, tracking: 13, readyCol: 14, status: 15, total: 16, draftId: 16 },
  },
};

const SS_ARCHIVE_SHEET_ID = "15DpAKrJPx0oCJKyTEbmubXCCx5fcFFlp5jTfRp_Cq80";

const importing  = { secretsavings: false, dme: false };
const pendingRows = { secretsavings: new Set(), dme: new Set() }; // queued row numbers while import runs

function shopifyCreds(channel) {
  return { store: channel.store || SHOPIFY_STORE, token: channel.token || SHOPIFY_TOKEN };
}

// ── Google Auth ────────────────────────────────────────────────────────────
let googleToken  = null;
let googleExpiry = 0;

async function getGoogleToken() {
  if (googleToken && Date.now() < googleExpiry - 60000) return googleToken;
  const res = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  googleToken  = res.data.access_token;
  googleExpiry = Date.now() + res.data.expires_in * 1000;
  return googleToken;
}

// ── Google Sheets ──────────────────────────────────────────────────────────
async function fetchSheetRows(channel) {
  const token  = await getGoogleToken();
  const endCol = columnLetter(channel.cols.total - 1);
  const range  = encodeURIComponent(`${channel.tab}!A2:${endCol}`);
  const res    = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${channel.sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return (res.data.values || [])
    .map((row, i) => ({
      rowIndex:       i,
      purchase_order: row[0]  || "",
      full_name:      row[2]  || "",
      address_1:      row[3]  || "",
      address_2:      row[4]  || "",
      city:           row[5]  || "",
      state:          row[6]  || "",
      post_code:      normalizeZip(row[7] || ""),
      vendor_sku:     row[8]  || "",
      quantity:       parseInt(row[10]) || 1,
      price:          channel.cols.price !== undefined ? row[channel.cols.price] || "" : "",
      carrier:        row[channel.cols.carrier]  || "",
      tracking:       row[channel.cols.tracking] || "",
      ready:          channel.cols.readyCol !== undefined ? String(row[channel.cols.readyCol] || "").toUpperCase() === "TRUE" : true,
    }))
    .filter(r => r.purchase_order);
}

async function writeDraftId(channel, rowIndex, draftId) {
  if (channel.cols.draftId === undefined) return;
  const token = await getGoogleToken();
  const col   = columnLetter(channel.cols.draftId);
  const cell  = `${channel.tab}!${col}${rowIndex + 2}`;
  await axios.put(
    `https://sheets.googleapis.com/v4/spreadsheets/${channel.sheetId}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`,
    { values: [[String(draftId)]] },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

async function writeTracking(channel, rowIndex, carrier, tracking) {
  const token    = await getGoogleToken();
  const startCol = columnLetter(channel.cols.carrier);
  const endCol   = columnLetter(channel.cols.tracking);
  const cell     = `${channel.tab}!${startCol}${rowIndex + 2}:${endCol}${rowIndex + 2}`;
  await axios.put(
    `https://sheets.googleapis.com/v4/spreadsheets/${channel.sheetId}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`,
    { values: [[carrier, tracking]] },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

function columnLetter(zeroIndex) {
  return String.fromCharCode(65 + zeroIndex);
}

const sheetIdCache = {};

async function getSheetId(sheetId, tab) {
  const key = `${sheetId}:${tab}`;
  if (sheetIdCache[key]) return sheetIdCache[key];
  const token = await getGoogleToken();
  const res   = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  for (const sheet of res.data.sheets) {
    sheetIdCache[`${sheetId}:${sheet.properties.title}`] = sheet.properties.sheetId;
  }
  return sheetIdCache[key];
}

const COLORS = {
  red:    { red: 1.0,  green: 0.80, blue: 0.80 },
  purple: { red: 0.85, green: 0.73, blue: 0.95 },
  orange: { red: 1.0,  green: 0.90, blue: 0.70 },
  green:  { red: 0.72, green: 0.88, blue: 0.72 },
  blue:   { red: 0.68, green: 0.85, blue: 0.95 },
};

const STATUS_TEXT = {
  orange: "Processed",
  blue:   "Paid",
  green:  "Shipped",
  purple: "Duplicate",
  red:    "Error",
};

async function applyHighlights(channel, highlights) {
  if (!highlights.length) return;
  try {
    const token   = await getGoogleToken();
    const sheetId = await getSheetId(channel.sheetId, channel.tab);
    const requests = [];
    for (const { rowIndex, color } of highlights) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex:    rowIndex + 1,
            endRowIndex:      rowIndex + 2,
            startColumnIndex: 0,
            endColumnIndex:   channel.cols.total,
          },
          cell:   { userEnteredFormat: { backgroundColor: COLORS[color] } },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
      if (channel.cols.status !== undefined) {
        requests.push({
          updateCells: {
            rows:   [{ values: [{ userEnteredValue: { stringValue: STATUS_TEXT[color] || color } }] }],
            fields: "userEnteredValue",
            start:  { sheetId, rowIndex: rowIndex + 1, columnIndex: channel.cols.status },
          },
        });
      }
    }
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${channel.sheetId}:batchUpdate`,
      { requests },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    console.log(`[${channel.prefix}] Applied ${highlights.length} highlights`);
  } catch (e) {
    console.error(`[${channel.prefix}] Highlight error:`, e.message);
  }
}

// ── Shopify helpers ────────────────────────────────────────────────────────
function shopifyTag(channel, po) {
  return `${channel.prefix.toLowerCase()}-${po}`;
}

function getNextPageUrl(res) {
  const link = res.headers["link"] || "";
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  return next ? next[1] : null;
}

// Extract PO from a Shopify order object based on channel type:
// - Regular orders (SS): parse from order.name "SS-13771" → "13771"
// - Draft-converted orders (DME): parse from order.tags "dme-13771" → "13771"
function extractPoFromOrder(channel, order) {
  if (channel.useDraftOrder) {
    const tagPrefix = `${channel.prefix.toLowerCase()}-`;
    const tags = (order.tags || "").split(",").map(t => t.trim());
    const poTag = tags.find(t => t.startsWith(tagPrefix));
    return poTag ? poTag.slice(tagPrefix.length) : null;
  }
  const name = order.name || "";
  if (!name.startsWith(`${channel.prefix}-`)) return null;
  return name.slice(channel.prefix.length + 1);
}

// Lookup key used in the existingOrders Set:
// - SS:  "SS-13771"  (order name)
// - DME: "13771"     (PO value, since draft orders don't keep our name)
function existingKey(channel, po) {
  return channel.useDraftOrder ? po : `${channel.prefix}-${po}`;
}

// Fetch existing orders/drafts to prevent duplicates.
// Returns a Set of lookup keys (see existingKey above).
async function fetchExistingPOs(channel) {
  const { store, token } = shopifyCreds(channel);
  const existing = new Set();

  if (channel.useDraftOrder) {
    // 1. Real orders with channel tag (completed drafts)
    const tagPrefix = `${channel.prefix.toLowerCase()}-`;
    let url = `https://${store}/admin/api/${SHOPIFY_VERSION}/orders.json?status=any&fields=tags&limit=250`;
    while (url) {
      const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });
      console.log(`[${channel.prefix}] fetchExistingOrders page bucket: ${res.headers?.["x-shopify-shop-api-call-limit"]}`);
      for (const o of res.data.orders) {
        const tags  = (o.tags || "").split(",").map(t => t.trim());
        const poTag = tags.find(t => t.startsWith(tagPrefix));
        if (poTag) existing.add(poTag.slice(tagPrefix.length));
      }
      url = getNextPageUrl(res);
      if (url) await sleep(700);
    }
    // 2. Open draft orders not yet paid (requires read_draft_orders scope — skip if not granted)
    try {
      let draftUrl = `https://${store}/admin/api/${SHOPIFY_VERSION}/draft_orders.json?status=open&fields=note_attributes&limit=250`;
      while (draftUrl) {
        const res = await axios.get(draftUrl, { headers: { "X-Shopify-Access-Token": token } });
        for (const d of res.data.draft_orders) {
          const poAttr = (d.note_attributes || []).find(a => a.name === "purchase_order");
          if (poAttr) existing.add(poAttr.value.replace(/^#/, ""));
        }
        draftUrl = getNextPageUrl(res);
        if (draftUrl) await sleep(700);
      }
    } catch (e) {
      if (e.response?.status === 403) {
        console.warn(`[${channel.prefix}] read_draft_orders scope not granted — skipping open draft check`);
      } else {
        throw e;
      }
    }
  } else {
    // Regular orders: look up by name prefix
    const prefix = `${channel.prefix}-`;
    let url = `https://${store}/admin/api/${SHOPIFY_VERSION}/orders.json?status=any&fields=name&limit=250`;
    while (url) {
      const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });
      console.log(`[${channel.prefix}] fetchExistingOrders page bucket: ${res.headers?.["x-shopify-shop-api-call-limit"]}`);
      for (const o of res.data.orders) {
        if (o.name.startsWith(prefix)) existing.add(o.name);
      }
      url = getNextPageUrl(res);
      if (url) await sleep(700);
    }
  }

  return existing;
}

// Look up a real Shopify order by PO for tracking/payment checks.
// Returns null if not found (draft order not yet paid for DME).
async function getOrderByPo(channel, po) {
  const { store, token } = shopifyCreds(channel);
  let url;
  if (channel.useDraftOrder) {
    const tag = shopifyTag(channel, po);
    url = `https://${store}/admin/api/${SHOPIFY_VERSION}/orders.json?tag=${encodeURIComponent(tag)}&status=any&fields=id,name,tags,fulfillments,financial_status,note`;
  } else {
    const name = `${channel.prefix}-${po}`;
    url = `https://${store}/admin/api/${SHOPIFY_VERSION}/orders.json?name=${encodeURIComponent(name)}&status=any&fields=id,name,fulfillments,financial_status`;
  }
  const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });
  return res.data.orders?.[0] || null;
}

async function buildSkuMap(channel) {
  const { store, token } = shopifyCreds(channel);
  const res = await axios.get(
    `https://${store}/admin/api/${SHOPIFY_VERSION}/products.json?limit=250&fields=variants`,
    { headers: { "X-Shopify-Access-Token": token } }
  );
  console.log(`[${channel.prefix}] buildSkuMap bucket: ${res.headers?.["x-shopify-shop-api-call-limit"]}`);
  const map = {};
  for (const p of res.data.products)
    for (const v of p.variants)
      if (v.sku) map[v.sku] = { id: v.id, price: parseFloat(v.price) };
  return map;
}

async function shopifyWithRetry(fn, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.response?.status === 429) {
        const retryAfter = parseFloat(e.response.headers?.["retry-after"] || "2");
        const bucket     = e.response.headers?.["x-shopify-shop-api-call-limit"] || "?";
        const wait       = (retryAfter + 1) * 1000;
        console.warn(`Rate limited — bucket: ${bucket}, waiting ${wait}ms (attempt ${i + 1}/${retries})`);
        await sleep(wait);
      } else {
        throw e;
      }
    }
  }
  throw new Error("Exceeded max retries after rate limiting");
}

function normalizeZip(zip) {
  const str = String(zip).trim();
  if (!str) return str;
  if (str.includes("-")) {
    const [base, plus4] = str.split("-");
    return base.padStart(5, "0") + "-" + plus4.padStart(4, "0");
  }
  return str.padStart(5, "0");
}

function validZip(zip) {
  return /^\d{5}(-\d{4})?$/.test(normalizeZip(zip));
}

function validateRow(row) {
  if (!row.full_name)  return "Missing full_name";
  if (!row.address_1)  return "Missing address_1";
  if (!row.city)       return "Missing city";
  if (!row.state)      return "Missing state";
  if (!row.post_code)  return "Missing post_code";
  if (!row.vendor_sku) return "Missing vendor_sku";
  if (!row.quantity || row.quantity < 1) return "Invalid quantity";
  if (!validZip(row.post_code)) return `Invalid zip code: ${row.post_code}`;
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function inferCarrier(trackingNumber) {
  if (!trackingNumber) return "";
  const tn = trackingNumber.replace(/\s/g, "");
  if (/^(94|93|92|91|90|420)/.test(tn)) return "USPS";
  if (/^1Z/i.test(tn))                  return "UPS";
  if (/^(96\d{18}|\d{12}|\d{15}|\d{20,22})$/.test(tn)) return "FedEx";
  if (/^DHL/i.test(tn))                 return "DHL";
  return "";
}

const US_STATES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",
  CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",
  KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",
  MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",
  OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
  DC:"District of Columbia",
};

// ── Regular order creation (SS) ────────────────────────────────────────────
async function createOrder(channel, row, skuMap) {
  const { store, token } = shopifyCreds(channel);
  const po        = row.purchase_order.replace(/^#/, "");
  const orderName = `${channel.prefix}-${po}`;
  const validationError = validateRow(row);
  if (validationError) return { ok: false, orderName, reason: validationError };
  const variantInfo = skuMap[row.vendor_sku];
  if (!variantInfo) return { ok: false, orderName, reason: `Unknown SKU: ${row.vendor_sku}` };
  const variantId = variantInfo.id;

  const parts     = row.full_name.trim().split(" ");
  const firstName = parts[0];
  const lastName  = parts.slice(1).join(" ") || "-";

  const res = await axios.post(
    `https://${store}/admin/api/${SHOPIFY_VERSION}/orders.json`,
    {
      order: {
        name:     orderName,
        customer: { id: channel.customerId },
        shipping_address: {
          first_name:    firstName,
          last_name:     lastName,
          address1:      row.address_1,
          address2:      row.address_2,
          city:          row.city,
          province_code: row.state,
          zip:           String(row.post_code),
          country_code:  "US",
        },
        line_items:               [{ variant_id: variantId, quantity: row.quantity, ...(row.price ? { price: String(row.price) } : {}) }],
        note_attributes:          [{ name: "purchase_order", value: row.purchase_order }],
        financial_status:         channel.financialStatus || "paid",
        send_receipt:             channel.sendReceipt || false,
        send_fulfillment_receipt: false,
      },
    },
    { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
  );
  const bucket = res.headers?.["x-shopify-shop-api-call-limit"];
  if (res.data.order) return { ok: true, orderName, shopifyId: res.data.order.id, bucket };
  return { ok: false, orderName, reason: JSON.stringify(res.data.errors) };
}

// ── Draft order creation + invoice send (DME) ──────────────────────────────
// Creates a draft order (financial_status: pending until customer pays via invoice link)
// then immediately sends the invoice email with "Pay Now" button.
async function createDraftOrder(channel, row, skuMap) {
  const { store, token } = shopifyCreds(channel);
  const po        = row.purchase_order.replace(/^#/, "");
  const orderName = `${channel.prefix}-${po}`; // used for logging only
  const validationError = validateRow(row);
  if (validationError) return { ok: false, orderName, reason: validationError };
  const variantInfo = skuMap[row.vendor_sku];
  if (!variantInfo) return { ok: false, orderName, reason: `Unknown SKU: ${row.vendor_sku}` };
  const variantId    = variantInfo.id;
  const variantPrice = variantInfo.price;

  // Compute discount needed to hit the custom price (draft orders don't accept price overrides directly)
  const customPrice    = row.price ? parseFloat(row.price) : null;
  const discountAmount = customPrice !== null ? (variantPrice - customPrice) : 0;

  const parts     = row.full_name.trim().split(" ");
  const firstName = parts[0];
  const lastName  = parts.slice(1).join(" ") || "-";

  const draftRes = await axios.post(
    `https://${store}/admin/api/${SHOPIFY_VERSION}/draft_orders.json`,
    {
      draft_order: {
        customer:         { id: channel.customerId },
        shipping_address: {
          first_name:    firstName,
          last_name:     lastName,
          address1:      row.address_1,
          address2:      row.address_2,
          city:          row.city,
          province:      US_STATES[row.state.toUpperCase()] || row.state,
          province_code: row.state,
          zip:           String(row.post_code),
          country:       "United States",
          country_code:  "US",
        },
        line_items:      [{
          variant_id:       variantId,
          quantity:         row.quantity,
          ...(discountAmount > 0 ? {
            applied_discount: {
              value_type: "fixed_amount",
              value:      discountAmount.toFixed(2),
              title:      "Distributor price",
            },
          } : {}),
        }],
        note_attributes: [{ name: "purchase_order", value: row.purchase_order }],
        tags:            shopifyTag(channel, po), // "dme-13771" — used for lookup after payment
      },
    },
    { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
  );

  if (!draftRes.data.draft_order) {
    return { ok: false, orderName, reason: JSON.stringify(draftRes.data.errors) };
  }

  const draftId = draftRes.data.draft_order.id;
  const bucket  = draftRes.headers?.["x-shopify-shop-api-call-limit"];

  // Send invoice email with Pay Now link — wait for Shopify to finish calculating draft totals
  await sleep(3000);
  if (channel.sendReceipt) {
    try {
      const invoicePayload = channel.invoiceEmail ? { to: channel.invoiceEmail } : {};
      const inv = await axios.post(
        `https://${store}/admin/api/${SHOPIFY_VERSION}/draft_orders/${draftId}/send_invoice.json`,
        { draft_order_invoice: invoicePayload },
        { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
      );
      console.log(`[${channel.prefix}] Invoice sent to ${inv.data.draft_order_invoice?.to} for draft ${draftId}`);
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.warn(`[${channel.prefix}] Invoice send failed for draft ${draftId}: ${detail}`);
    }
  }

  return { ok: true, orderName, shopifyId: draftId, bucket };
}

// ── Import Logic ───────────────────────────────────────────────────────────
async function processNewOrders(channel, targetSheetRows = null) {
  let rows = await fetchSheetRows(channel);
  if (targetSheetRows && targetSheetRows.length) {
    const targetSet = new Set(targetSheetRows.map(r => r - 2));
    rows = rows.filter(r => targetSet.has(r.rowIndex));
  }
  const skuMap = await shopifyWithRetry(() => buildSkuMap(channel));
  await sleep(1500);
  const existingOrders = await fetchExistingPOs(channel);
  await sleep(1500);
  console.log(`[${channel.prefix}] Rows: ${rows.length} | Existing: ${existingOrders.size}`);

  const result     = { created: 0, skipped: 0, failed: 0, errors: [] };
  const highlights = [];

  for (const row of rows) {
    const po  = row.purchase_order.replace(/^#/, "");
    const key = existingKey(channel, po);

    if (!row.ready) continue;

    if (existingOrders.has(key)) {
      result.skipped++;
      highlights.push({ rowIndex: row.rowIndex, color: "purple" });
      await sleep(8000);
      continue;
    }

    const createFn = channel.useDraftOrder
      ? () => createDraftOrder(channel, row, skuMap)
      : () => createOrder(channel, row, skuMap);

    const res = await shopifyWithRetry(createFn);

    if (res.ok) {
      result.created++;
      existingOrders.add(key);
      highlights.push({ rowIndex: row.rowIndex, color: "orange" });
      if (channel.useDraftOrder && res.shopifyId) {
        await writeDraftId(channel, row.rowIndex, res.shopifyId).catch(e =>
          console.warn(`[${channel.prefix}] writeDraftId failed for ${res.orderName}: ${e.message}`)
        );
      }
      console.log(`[${channel.prefix}] CREATED ${res.orderName} (${res.shopifyId}) bucket:${res.bucket}`);
    } else {
      result.failed++;
      result.errors.push({ order: res.orderName, reason: res.reason });
      highlights.push({ rowIndex: row.rowIndex, color: "red" });
      console.error(`[${channel.prefix}] FAILED ${res.orderName}: ${res.reason}`);
    }
    await sleep(8000);
  }

  await applyHighlights(channel, highlights);
  console.log(`[${channel.prefix}] Import complete — created:${result.created} skipped:${result.skipped} failed:${result.failed}`);
  return result;
}

// ── Tracking Writeback ─────────────────────────────────────────────────────
async function syncTracking(channel) {
  const rows         = await fetchSheetRows(channel);
  const needTracking = rows.filter(r => r.purchase_order && !r.tracking);
  if (!needTracking.length) return;

  for (const row of needTracking) {
    const po = row.purchase_order.replace(/^#/, "");
    try {
      const order = await getOrderByPo(channel, po);
      if (!order?.fulfillments?.length) continue;
      const f        = order.fulfillments[0];
      const tracking = f.tracking_number  || "";
      const carrier  = f.tracking_company || inferCarrier(tracking) || "";
      if (!tracking) continue;
      await writeTracking(channel, row.rowIndex, carrier, tracking);
      await applyHighlights(channel, [{ rowIndex: row.rowIndex, color: "green" }]);
      console.log(`[${channel.prefix}] TRACKING ${channel.prefix}-${po}: ${carrier} ${tracking}`);
      await sleep(300);
    } catch (e) {
      console.error(`[${channel.prefix}] Tracking error for ${channel.prefix}-${po}:`, e.message);
    }
  }
}

// ── Payment Polling ────────────────────────────────────────────────────────
async function syncPayment(channel) {
  if (!channel.pendingPayment) return;
  const rows      = await fetchSheetRows(channel);
  const needCheck = rows.filter(r => r.purchase_order && !r.tracking);
  if (!needCheck.length) return;

  const highlights = [];
  for (const row of needCheck) {
    const po = row.purchase_order.replace(/^#/, "");
    try {
      const order = await getOrderByPo(channel, po);
      // Draft orders: a real order existing = the draft was paid and completed
      // Regular orders: check financial_status explicitly
      const isPaid = channel.useDraftOrder
        ? order !== null
        : order?.financial_status === "paid";
      if (isPaid) {
        highlights.push({ rowIndex: row.rowIndex, color: "blue" });
        console.log(`[${channel.prefix}] PAID ${channel.prefix}-${po}`);
        // Write PO reference as order note (Shopify order name is not updatable via API)
        if (channel.useDraftOrder && order) {
          const poRef = `${channel.prefix}-${po}`;
          if (!order.note?.includes(poRef)) {
            const { store, token } = shopifyCreds(channel);
            try {
              await axios.put(
                `https://${store}/admin/api/${SHOPIFY_VERSION}/orders/${order.id}.json`,
                { order: { note: poRef } },
                { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
              );
              console.log(`[${channel.prefix}] NOTE set on order ${order.name} → ${poRef}`);
            } catch (e) {
              console.warn(`[${channel.prefix}] Note write failed for order ${order.id}: ${e.message}`);
            }
          }
        }
      }
      await sleep(300);
    } catch (e) {
      console.error(`[${channel.prefix}] Payment check error for ${channel.prefix}-${po}:`, e.message);
    }
  }
  await applyHighlights(channel, highlights);
}

// ── SS Archive (daily 6 PM PST) ────────────────────────────────────────────
// Rows with both carrier and tracking filled are appended to the archive sheet
// and deleted from the source sheet.
async function archiveShippedRows() {
  const channel = CHANNELS.secretsavings;
  const token   = await getGoogleToken();

  // Fetch raw rows using the same range as fetchSheetRows
  const endCol = columnLetter(channel.cols.total - 1);
  const range  = encodeURIComponent(`${channel.tab}!A2:${endCol}`);
  const res    = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${channel.sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const rawRows = res.data.values || [];

  // Rows with PO + carrier + tracking are fully shipped
  const shipped = rawRows
    .map((row, i) => ({ i, row }))
    .filter(({ row }) =>
      row[0] &&
      (row[channel.cols.tracking] || "").trim()
    );

  if (!shipped.length) {
    console.log("[SS] Archive: nothing to archive");
    return;
  }

  // Append to archive sheet
  await axios.post(
    `https://sheets.googleapis.com/v4/spreadsheets/${SS_ARCHIVE_SHEET_ID}/values/A1:append` +
    `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: shipped.map(({ row }) => row) },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  console.log(`[SS] Archive: appended ${shipped.length} rows to archive sheet`);

  // Delete from source — descending order so row indices stay valid
  const srcSheetId = await getSheetId(channel.sheetId, channel.tab);
  const requests   = shipped
    .slice()
    .sort((a, b) => b.i - a.i)
    .map(({ i }) => ({
      deleteDimension: {
        range: {
          sheetId:    srcSheetId,
          dimension:  "ROWS",
          startIndex: i + 1,  // +1 to skip header row (index 0)
          endIndex:   i + 2,
        },
      },
    }));

  await axios.post(
    `https://sheets.googleapis.com/v4/spreadsheets/${channel.sheetId}:batchUpdate`,
    { requests },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  console.log(`[SS] Archive: deleted ${shipped.length} rows from source`);
}

function scheduleArchive() {
  const now  = new Date();
  // 6 PM PST = 02:00 UTC
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    archiveShippedRows().catch(e => console.error("[SS] Archive error:", e.message));
    setInterval(
      () => archiveShippedRows().catch(e => console.error("[SS] Archive error:", e.message)),
      24 * 60 * 60 * 1000
    );
  }, next - now);
}

// ── Import mutex with row queuing ─────────────────────────────────────────
// If an import is already running and targeted rows were specified, queue them
// so they get processed in the next pass immediately after the current one finishes.
async function runImportOnce(channel, targetSheetRows = null) {
  const key = Object.keys(CHANNELS).find(k => CHANNELS[k] === channel) || channel.prefix.toLowerCase();
  if (importing[key]) {
    if (targetSheetRows && targetSheetRows.length) {
      targetSheetRows.forEach(r => pendingRows[key].add(r));
      console.log(`[${channel.prefix}] Import in progress — queued rows: ${[...pendingRows[key]]}`);
    } else {
      console.log(`[${channel.prefix}] Import already in progress — skipping`);
    }
    return;
  }
  importing[key] = true;
  try {
    await processNewOrders(channel, targetSheetRows);
    // Drain any rows that arrived while we were running
    while (pendingRows[key].size > 0) {
      const queued = [...pendingRows[key]];
      pendingRows[key].clear();
      console.log(`[${channel.prefix}] Processing queued rows: ${queued}`);
      await processNewOrders(channel, queued);
    }
  } finally {
    importing[key] = false;
  }
}

// ── HMAC verification helper ───────────────────────────────────────────────
function verifyWebhookHmac(req, res, channel) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const computed   = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest("base64");
  if (computed !== hmacHeader) {
    console.warn(`[${channel.prefix}] Webhook HMAC mismatch — rejected`);
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// orders/fulfilled webhook — instant tracking writeback
app.post("/webhook/fulfillment", async (req, res) => {
  const channelKey = (req.query.channel || "secretsavings").toLowerCase();
  const channel    = CHANNELS[channelKey];
  if (!channel) return res.status(400).send("Unknown channel");
  if (!verifyWebhookHmac(req, res, channel)) return;

  res.status(200).send("OK");

  try {
    const order      = JSON.parse(req.rawBody.toString());
    const po         = extractPoFromOrder(channel, order);
    if (!po) return;

    const fulfillments = order.fulfillments || [];
    const f = fulfillments[fulfillments.length - 1];
    const trackingNum  = f?.tracking_number  || "";
    const trackingComp = f?.tracking_company || inferCarrier(trackingNum) || "";
    if (!trackingNum) return;

    const rows = await fetchSheetRows(channel);
    const row  = rows.find(r => r.purchase_order.replace(/^#/, "") === po);
    if (!row) { console.warn(`[${channel.prefix}] Webhook: no sheet row for PO ${po}`); return; }

    await writeTracking(channel, row.rowIndex, trackingComp, trackingNum);
    await applyHighlights(channel, [{ rowIndex: row.rowIndex, color: "green" }]);
    console.log(`[${channel.prefix}] WEBHOOK TRACKING ${channel.prefix}-${po}: ${trackingComp} ${trackingNum}`);
  } catch (e) {
    console.error(`[${channel.prefix}] Fulfillment webhook error:`, e.message);
  }
});

// orders/paid webhook — instant payment detection (DME)
app.post("/webhook/paid", async (req, res) => {
  const channelKey = (req.query.channel || "dme").toLowerCase();
  const channel    = CHANNELS[channelKey];
  if (!channel) return res.status(400).send("Unknown channel");
  if (!verifyWebhookHmac(req, res, channel)) return;

  res.status(200).send("OK");

  try {
    const order = JSON.parse(req.rawBody.toString());
    const po    = extractPoFromOrder(channel, order);
    if (!po) return;

    const rows = await fetchSheetRows(channel);
    const row  = rows.find(r => r.purchase_order.replace(/^#/, "") === po);
    if (!row) { console.warn(`[${channel.prefix}] Webhook: no sheet row for PO ${po}`); return; }

    await applyHighlights(channel, [{ rowIndex: row.rowIndex, color: "blue" }]);
    console.log(`[${channel.prefix}] WEBHOOK PAID ${channel.prefix}-${po}`);

    // Write PO reference as order note (Shopify order name is not updatable via API)
    if (channel.useDraftOrder) {
      const poRef = `${channel.prefix}-${po}`;
      try {
        const { store, token } = shopifyCreds(channel);
        await axios.put(
          `https://${store}/admin/api/${SHOPIFY_VERSION}/orders/${order.id}.json`,
          { order: { note: poRef } },
          { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
        );
        console.log(`[${channel.prefix}] NOTE set on order ${order.name} → ${poRef}`);
      } catch (e) {
        console.warn(`[${channel.prefix}] Note write failed for order ${order.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[${channel.prefix}] Paid webhook error:`, e.message);
  }
});

app.post("/trigger", (req, res) => {
  const channelKey = (req.body?.channel || "secretsavings").toLowerCase();
  const channel    = CHANNELS[channelKey];
  if (!channel) return res.status(400).json({ ok: false, error: `Unknown channel: ${channelKey}` });
  const targetRows = req.body?.rows || null;
  console.log(`Trigger received — channel: ${channelKey}${targetRows ? ` rows: ${targetRows}` : ""}`);
  res.json({ ok: true, message: "processing", channel: channelKey });
  runImportOnce(channel, targetRows).catch(e => console.error(`[${channelKey}] Error:`, e.message));
});

app.post("/sync-tracking", (req, res) => {
  const channelKey = (req.body?.channel || "all").toLowerCase();
  res.json({ ok: true, message: "syncing", channel: channelKey });
  const targets = channelKey === "all" ? Object.values(CHANNELS) : [CHANNELS[channelKey]].filter(Boolean);
  targets.forEach(ch => syncTracking(ch).catch(e => console.error(`[${ch.prefix}] Tracking sync error:`, e.message)));
});

app.post("/sync-payment", (req, res) => {
  const channelKey = (req.body?.channel || "all").toLowerCase();
  res.json({ ok: true, message: "syncing payment", channel: channelKey });
  const targets = channelKey === "all" ? Object.values(CHANNELS) : [CHANNELS[channelKey]].filter(Boolean);
  targets.forEach(ch => syncPayment(ch).catch(e => console.error(`[${ch.prefix}] Payment sync error:`, e.message)));
});

app.post("/archive", (req, res) => {
  res.json({ ok: true, message: "archive triggered" });
  archiveShippedRows().catch(e => console.error("[SS] Archive error:", e.message));
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", store: SHOPIFY_STORE, channels: Object.keys(CHANNELS) })
);

// ── Polling intervals ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`channel-order-worker listening on port ${PORT}`);

  setInterval(async () => {
    for (const [key, channel] of Object.entries(CHANNELS)) {
      if (importing[key]) { console.log(`[${channel.prefix}] Tracking poll skipped — import in progress`); continue; }
      console.log(`[${channel.prefix}] Polling tracking...`);
      try { await syncTracking(channel); }
      catch (e) { console.error(`[${channel.prefix}] Poll error:`, e.message); }
    }
  }, TRACKING_POLL_MS);

  setInterval(async () => {
    for (const [key, channel] of Object.entries(CHANNELS)) {
      if (!channel.pendingPayment) continue;
      if (importing[key]) { console.log(`[${channel.prefix}] Payment poll skipped — import in progress`); continue; }
      console.log(`[${channel.prefix}] Polling payment status...`);
      try { await syncPayment(channel); }
      catch (e) { console.error(`[${channel.prefix}] Payment poll error:`, e.message); }
    }
  }, PAYMENT_POLL_MS);

  scheduleArchive();
});
