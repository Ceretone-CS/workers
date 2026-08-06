"use strict";
require("dotenv").config();
const express = require("express");
const axios   = require("axios");

const app = express();
app.use(express.json());

const PORT         = parseInt(process.env.PORT) || 3007;
const SHEET_ID     = process.env.BVS_SHEET_ID;
const SHEET_TAB    = process.env.BVS_SHEET_TAB;
const SS_API_TOKEN = process.env.SS_API_TOKEN;
const SS_STORE     = process.env.SS_STORE;
const SS_WAREHOUSE = process.env.SS_WAREHOUSE;
const POLL_MS      = 60 * 60 * 1000; // 1 hour

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

let googleToken  = null;
let googleExpiry = 0;
let running      = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Google Auth ──────────────────────────────────────────────────────────────
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

// ── Google Sheets ────────────────────────────────────────────────────────────

// Returns an array of color names (index 0 = row 2):
//   'orange' | 'green' | 'purple' | 'red' | 'blue' | 'none'
// BVS never sets background colors so our highlights are an unambiguous processed signal.
// Red rows are treated as NOT processed so they get retried on the next run.
async function fetchRowColors() {
  try {
    const token = await getGoogleToken();
    const range = encodeURIComponent(`${SHEET_TAB}!A2:A`);
    const res = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}` +
        `?includeGridData=true&ranges=${range}` +
        `&fields=sheets.data.rowData.values.effectiveFormat.backgroundColor`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
    return rowData.map(row => {
      const bg = row.values?.[0]?.effectiveFormat?.backgroundColor;
      if (!bg) return 'none';
      const r = bg.red ?? 1, g = bg.green ?? 1, b = bg.blue ?? 1;
      if (r >= 0.99 && g >= 0.99 && b >= 0.99) return 'none'; // white = unprocessed
      // Match against our defined colors (within 0.05 tolerance)
      const near = (a, target) => Math.abs(a - target) < 0.05;
      if (near(r, 1.0) && near(g, 0.90) && near(b, 0.70)) return 'orange';
      if (near(r, 0.72) && near(g, 0.88) && near(b, 0.72)) return 'green';
      if (near(r, 0.85) && near(g, 0.73) && near(b, 0.95)) return 'purple';
      if (near(r, 1.0)  && near(g, 0.80) && near(b, 0.80)) return 'red';
      if (near(r, 0.68) && near(g, 0.85) && near(b, 0.95)) return 'blue';
      return 'none'; // unknown color, treat as unprocessed
    });
  } catch (e) {
    console.error("[BVS] fetchRowColors error:", e.message);
    return []; // safe default: treat all as unprocessed
  }
}

async function fetchAllRows() {
  const token = await getGoogleToken();
  const range = encodeURIComponent(`${SHEET_TAB}!A2:T`);
  const [valRes, colors] = await Promise.all([
    axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
    fetchRowColors(),
  ]);
  return (valRes.data.values || [])
    .map((row, i) => ({
      rowIndex:  i,
      orderId:   (row[0]  || "").trim(),
      orderRef:  (row[2]  || "").trim(),
      product:   (row[4]  || "").trim(),
      sku:       (row[5]  || "").trim(),
      firstName: (row[7]  || "").trim(),
      lastName:  (row[8]  || "").trim(),
      street1:   (row[9]  || "").trim(),
      street2:   (row[10] || "").trim(),
      city:      (row[11] || "").trim(),
      state:     (row[12] || "").trim(),
      zip:       (row[13] || "").trim(),
      country:   (row[14] || "US").trim(),
      phone:     (row[15] || "").replace(/^'/, "").trim(),
      tracking:  (row[18] || "").trim(),
      processed: ['orange', 'green', 'purple', 'blue'].includes(colors[i] || 'none'),
    }))
    .filter(r => r.orderId);
}


// ── Highlights ───────────────────────────────────────────────────────────────
const sheetIdCache = {};

async function getSheetId() {
  if (sheetIdCache[SHEET_TAB]) return sheetIdCache[SHEET_TAB];
  const token = await getGoogleToken();
  const res   = await axios.get(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  for (const sheet of res.data.sheets)
    sheetIdCache[sheet.properties.title] = sheet.properties.sheetId;
  return sheetIdCache[SHEET_TAB];
}

const COLORS = {
  orange: { red: 1.0,  green: 0.90, blue: 0.70 },
  blue:   { red: 0.68, green: 0.85, blue: 0.95 },
  green:  { red: 0.72, green: 0.88, blue: 0.72 },
  purple: { red: 0.85, green: 0.73, blue: 0.95 },
  red:    { red: 1.0,  green: 0.80, blue: 0.80 },
};

async function applyHighlights(highlights) {
  if (!highlights.length) return;
  try {
    const token   = await getGoogleToken();
    const sheetId = await getSheetId();
    const requests = highlights.map(({ rowIndex, color }) => ({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex:    rowIndex + 1,
          endRowIndex:      rowIndex + 2,
          startColumnIndex: 0,
          endColumnIndex:   20,
        },
        cell:   { userEnteredFormat: { backgroundColor: COLORS[color] } },
        fields: "userEnteredFormat.backgroundColor",
      },
    }));
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      { requests },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[BVS] Highlight error:", e.message);
  }
}

// ── ShipSavings ──────────────────────────────────────────────────────────────
async function createShipSavingsOrder(row) {
  const payload = {
    store_name:     SS_STORE,
    warehouse_name: SS_WAREHOUSE,
    order_number:   row.orderId,
    verify_address: false,
    client_name:    `${row.firstName} ${row.lastName}`.trim(),
    client_street:  row.street1,
    client_city:    row.city,
    client_state:   row.state,
    client_zip:     row.zip,
    client_country: row.country || "US",
    shipments: [{
      items: [{
        sku:      row.sku || "UNKNOWN",
        title:    row.product || row.sku || "Product",
        quantity: 1,
        price:    0,
      }],
    }],
  };
  if (row.street2) payload.client_street2 = row.street2;
  if (row.phone)   payload.client_phone   = row.phone;

  try {
    const res = await axios.post(
      `https://api.shipsaving.com/api/orders/create?api_token=${SS_API_TOKEN}`,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );
    if (!res.data.order_number) throw new Error(JSON.stringify(res.data));
    return { orderNumber: res.data.order_number, duplicate: false };
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    if (/exist|duplicate|already/i.test(msg)) {
      return { orderNumber: row.orderId, duplicate: true };
    }
    throw e;
  }
}

// ── Import new orders ────────────────────────────────────────────────────────
// Returns a Set of rowIndices successfully created/duplicated this run,
// so syncTrackingHighlights can immediately green them if tracking is present.
async function processNewOrders(rows) {
  const newRows = rows.filter(r => !r.processed);
  if (!newRows.length) {
    console.log("[BVS] No new orders to process");
    return new Set();
  }
  console.log(`[BVS] Found ${newRows.length} unprocessed orders`);

  const highlights  = [];
  const justCreated = new Set();

  for (const row of newRows) {
    try {
      const { orderNumber, duplicate } = await createShipSavingsOrder(row);
      highlights.push({ rowIndex: row.rowIndex, color: duplicate ? "purple" : "orange" });
      justCreated.add(row.rowIndex);
      console.log(`[BVS] ${duplicate ? "DUPLICATE" : "CREATED"} ${row.orderId} → #${orderNumber}`);
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.error(`[BVS] FAILED ${row.orderId}: ${detail}`);
      highlights.push({ rowIndex: row.rowIndex, color: "red" });
    }
    await sleep(500);
  }

  await applyHighlights(highlights);
  console.log("[BVS] Import complete");
  return justCreated;
}

// ── Tracking sync (from ShipSavings) ─────────────────────────────────────────
async function getShipSavingsTracking(orderId) {
  try {
    const res = await axios.get(
      `https://api.shipsaving.com/api/shipments/get?api_token=${SS_API_TOKEN}` +
        `&store_name=${encodeURIComponent(SS_STORE)}&order_number=${orderId}`,
      { timeout: 8000 }
    );
    const shipments = res.data;
    if (!Array.isArray(shipments) || !shipments.length) return null;
    const s = shipments[0];
    if (!s.tracking_code) return null;
    // Extract ship date from label_url path (e.g. .../labels/2026-07-08/...)
    const urlMatch = (s.label_url?.[0] || "").match(/labels\/(\d{4}-\d{2}-\d{2})\//);
    const shipDate = urlMatch ? urlMatch[1] : new Date().toISOString().slice(0, 10);
    return { carrier: s.carrier || "", tracking: s.tracking_code, shipDate };
  } catch (e) {
    return null; // not yet shipped or transient error
  }
}

async function syncFromShipSavings(rows, justCreated = new Set()) {
  const candidates = rows.filter(r =>
    !r.tracking && (r.processed || justCreated.has(r.rowIndex))
  );
  if (!candidates.length) {
    console.log("[BVS] Tracking sync: no unshipped orders to check");
    return;
  }
  console.log(`[BVS] Tracking sync: checking ${candidates.length} orders in ShipSavings`);

  const sheetUpdates = [];
  const highlights   = [];

  for (const row of candidates) {
    const info = await getShipSavingsTracking(row.orderId);
    if (info) {
      sheetUpdates.push({ rowIndex: row.rowIndex, ...info });
      highlights.push({ rowIndex: row.rowIndex, color: "green" });
      console.log(`[BVS] SHIPPED ${row.orderId} → ${info.carrier} ${info.tracking}`);
    }
    await sleep(200);
  }

  if (!sheetUpdates.length) {
    console.log("[BVS] Tracking sync: no tracking found yet");
    return;
  }

  // Batch write ship date (Q), carrier (R), tracking (S) in one request
  try {
    const token = await getGoogleToken();
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
      {
        valueInputOption: "RAW",
        data: sheetUpdates.map(({ rowIndex, carrier, tracking, shipDate }) => ({
          range:  `${SHEET_TAB}!Q${rowIndex + 2}:S${rowIndex + 2}`,
          values: [[shipDate, carrier, tracking]],
        })),
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[BVS] Tracking writeback error:", e.message);
  }

  await applyHighlights(highlights);
  console.log(`[BVS] Tracking sync: ${highlights.length} rows marked green`);
}

// ── Main run ─────────────────────────────────────────────────────────────────
async function runOnce() {
  if (running) {
    console.log("[BVS] Already running — skipping");
    return;
  }
  running = true;
  try {
    const rows        = await fetchAllRows();
    const justCreated = await processNewOrders(rows);
    await syncFromShipSavings(rows, justCreated);
  } finally {
    running = false;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.post("/trigger", (_req, res) => {
  res.json({ ok: true, message: "processing" });
  runOnce().catch(e => console.error("[BVS] Error:", e.message));
});

app.post("/sync-tracking", (_req, res) => {
  res.json({ ok: true, message: "syncing tracking from ShipSavings" });
  fetchAllRows()
    .then(rows => syncFromShipSavings(rows))
    .catch(e => console.error("[BVS] Tracking sync error:", e.message));
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", sheet: SHEET_ID, store: SS_STORE, warehouse: SS_WAREHOUSE })
);

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`bvs-worker listening on port ${PORT}`);
  fetchAllRows()
    .then(rows => syncFromShipSavings(rows))
    .catch(e => console.error("[BVS] Startup sync:", e.message));
  setInterval(
    () => runOnce().catch(e => console.error("[BVS] Poll error:", e.message)),
    POLL_MS
  );
});
