const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ZENDESK_SUBDOMAIN   = process.env.ZENDESK_SUBDOMAIN || 'audiconcorporation';
const CLIENT_ID           = process.env.ZENDESK_CLIENT_ID;
const CLIENT_SECRET       = process.env.ZENDESK_CLIENT_SECRET;
const SHEET_ID            = process.env.SHEET_ID;
const STATE_FILE          = path.join(__dirname, 'data', 'processed.json');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const FIELD_RETURN_ACTIVITY  = 31180534996244;
const FIELD_TRACKING_NUMBER  = 31172376168596;
const FIELD_ORDER_NUMBER     = 28914817987092;
const FIELD_SERIAL_NUMBER    = 27305354980500;
const FIELD_PRODUCT_TYPE     = 27080891599508;
const FIELD_PURCHASED_FROM   = 28507114760468;
const FIELD_RETURN_CONDITION = 31180361044244;
const FIELD_NOTES            = 31171878308244;
const FORM_ID                = 31175384375572;
const BRAND_ID               = 27546230920212;
const GROUP_ID               = 26266273841300;
const ASSIGNEE_ID            = 46221339676692;
const CUSTOM_STATUS_ID       = 25260444955028;

const PRODUCT_MAP = {
  'A90': 'product__a90', 'CORE ONE PRO': 'product__a90',
  'A80': 'product__a80', 'CORE ONE': 'product__a80',
  'A62': 'product__a62', 'STYLE': 'product__a62',
  'A61': 'product__a61', 'FUSION': 'product__a61',
  'A18': 'product__a18', 'TORCH': 'product__a18',
  'A39': 'product__a39', 'ESSENTIAL': 'product__a39',
  'DW5A': 'product__dw5a', 'BEACON': 'product__dw5a',
  'D12': 'product__d12', 'SOLID': 'product__d12',
  'D36': 'product__d36', 'NEXUS': 'product__d36',
  'EQUATE': 'product__equate__d26', 'JH-D26': 'product__equate__d26', 'D26': 'product__equate__d26',
};

function getProductType(raw) {
  if (!raw) return null;
  const u = raw.trim().toUpperCase().replace(/\s*\(B\)\s*/gi, '').trim();
  for (const [k, v] of Object.entries(PRODUCT_MAP)) {
    if (u.includes(k)) return v;
  }
  return null;
}

function getPurchasedFrom(o) {
  if (!o) return 'case__other';
  const ou = o.trim().toUpperCase();
  if (ou.startsWith('AMAZON') || ou.startsWith('AMAZ') || ou.startsWith('S')) return 'case__amazon';
  if (ou.startsWith('CC')) return 'case__shopify';
  if (/^C\d/.test(ou)) return 'case__shopify';
  if (ou.startsWith('HSN') || /^H\d/.test(ou)) return 'case__hsn';
  if (ou.startsWith('W')) return 'case__walmart';
  if (ou.startsWith('CH')) return 'case__cardinal_health';
  if (/^T\d/.test(ou)) return 'case__target';
  if (/^A\d/.test(ou)) return 'case__aafes';
  if (ou.startsWith('FSI')) return 'case__fsi';
  if (ou.startsWith('FSA')) return 'case__cardinal_health';
  if (/^\d+$/.test(ou)) return 'case__other';
  return 'case__other';
}

function extractSerial(raw) {
  if (!raw) return '';
  const m = raw.match(/\(21\)([^(]+)/);
  if (m) return m[1].trim();
  return raw.trim();
}

function getCondition(raw) {
  if (!raw) return null;
  const u = raw.trim().toUpperCase();
  if (u === 'LIKE NEW' || u === 'LIKE-NEW') return 'returnresult__condition__new';
  if (u === 'FAIR' || u === 'POOR' || u === 'USED') return 'returnresult__condition__used';
  if (u === 'DAMAGED') return 'returnresult__condition__damaged';
  if (u === 'INCOMPLETE') return 'returnresult__condition__missing_components';
  return null;
}

function col(row, ...names) {
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === name.toLowerCase()) return (row[key] || '').trim();
    }
  }
  return '';
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return { processed: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && now < tokenExpiresAt - 60000) return cachedToken;
  const body = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'read write tickets:write',
  });
  const res = await httpsRequest({
    hostname: `${ZENDESK_SUBDOMAIN}.zendesk.com`,
    path: '/oauth/tokens',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (res.status !== 200) throw new Error(`OAuth failed: ${JSON.stringify(res.body)}`);
  cachedToken = res.body.access_token;
  tokenExpiresAt = now + res.body.expires_in * 1000;
  return cachedToken;
}

async function zdReq(method, zdPath, body, retry = true) {
  const token = await getToken();
  const payload = body ? JSON.stringify(body) : undefined;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
  const res = await httpsRequest({ hostname: `${ZENDESK_SUBDOMAIN}.zendesk.com`, path: zdPath, method, headers }, payload);
  if (retry && (res.status === 401 || res.status === 403)) {
    const token2 = await getToken(true);
    headers['Authorization'] = `Bearer ${token2}`;
    return httpsRequest({ hostname: `${ZENDESK_SUBDOMAIN}.zendesk.com`, path: zdPath, method, headers }, payload);
  }
  return res;
}

function sendDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return Promise.resolve();
  const parsed = new URL(DISCORD_WEBHOOK_URL);
  const body = JSON.stringify({ content: msg });
  return httpsRequest({
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body).catch(e => console.error('Discord webhook error:', e.message));
}

function fetchSheet() {
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv&gid=0';
  return new Promise((resolve, reject) => {
    function follow(u, redirects) {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const parsed = new URL(u);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'sheets-returns-worker/1.0' },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return follow(res.headers.location, redirects + 1);
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    }
    follow(url, 0);
  });
}

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { vals.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    vals.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || '');
    return row;
  });
}

async function createTicket(row) {
  const customerName  = col(row, 'Customer Name');
  const order         = col(row, 'Order Number', 'Order #');
  const tracking      = col(row, 'Tracking Number', 'Tracking #');
  const model         = col(row, 'Product', 'Model');
  const rawSerial     = col(row, 'SERIAL #', 'Serial #', 'Serial Number');
  const condition     = col(row, 'Condition');
  const notes         = col(row, 'Test Result Notes', 'Notes', 'Note');
  const serial        = extractSerial(rawSerial);
  const modelDisplay  = model.replace(/\s*\(B\)\s*/gi, '').trim();
  const CHANNEL_NAMES = ['amazon', 'walmart', 'target', 'hsn', 'cardinal health'];
  const isChannel     = CHANNEL_NAMES.includes(customerName.toLowerCase());
  const requesterName = (customerName && !isChannel) ? customerName : 'Returns Department';
  const subject       = 'Return Check In: ' + modelDisplay + (serial ? ' - ' + serial : '') + (order ? ' (' + order + ')' : '');

  const noteLines = [];
  if (customerName && !isChannel) noteLines.push('<li><strong>Customer:</strong> ' + customerName + '</li>');
  noteLines.push('<li><strong>Order #:</strong> ' + (order || 'N/A') + '</li>');
  noteLines.push('<li><strong>Model:</strong> ' + modelDisplay + '</li>');
  noteLines.push('<li><strong>Serial #:</strong> ' + (serial || 'N/A') + '</li>');
  noteLines.push('<li><strong>Tracking #:</strong> ' + (tracking || 'N/A') + '</li>');
  noteLines.push('<li><strong>Condition:</strong> ' + (condition || 'N/A') + '</li>');
  if (notes) noteLines.push('<li><strong>Notes:</strong> ' + notes + '</li>');

  // Only include fields with values — Zendesk rejects solved tickets where required
  // fields (Order #, Tracking #) are empty or fail the field's regex validation.
  const customFields = [
    { id: FIELD_RETURN_ACTIVITY,  value: 'returnresult__returncheckin' },
    { id: FIELD_SERIAL_NUMBER,    value: serial || 'N/A' },
    { id: FIELD_PURCHASED_FROM,   value: getPurchasedFrom(order) },
    { id: FIELD_PRODUCT_TYPE,     value: getProductType(model) || 'product__general' },
    { id: FIELD_RETURN_CONDITION, value: getCondition(condition) || 'returnresult__condition__used' },
  ];
  customFields.push({ id: FIELD_ORDER_NUMBER,    value: order || 'N/A' });
  customFields.push({ id: FIELD_TRACKING_NUMBER, value: tracking || 'N/A' });
  if (notes)    customFields.push({ id: FIELD_NOTES,           value: notes });

  const ticketBody = {
    subject,
    requester: { name: requesterName, email: 'returns@ceretone.com' },
    brand_id: BRAND_ID, group_id: GROUP_ID, assignee_id: ASSIGNEE_ID,
    ticket_form_id: FORM_ID, custom_status_id: CUSTOM_STATUS_ID, status: 'solved',
    comment: { html_body: '<p><strong>Return Check In — Automated Import</strong></p><ul>' + noteLines.join('') + '</ul>', public: false },
    custom_fields: customFields,
  };

  const res = await zdReq('POST', '/api/v2/tickets.json', { ticket: ticketBody });

  // 422 means a required-to-solve field failed validation (e.g. Order # regex mismatch,
  // missing Tracking #). Retry as open so the ticket is at least created for manual review.
  if (res.status === 422) {
    console.warn('  422 on solve — retrying as open for [' + (order || serial) + ']');
    const fallback = Object.assign({}, ticketBody, { status: 'open', custom_status_id: undefined });
    return zdReq('POST', '/api/v2/tickets.json', { ticket: fallback });
  }

  return res;
}

async function main() {
  console.log('[' + new Date().toISOString() + '] Starting returns poll...');
  const created = { count: 0 };
  let skipped = 0, errors = 0;
  const errorDetails = [];

  let csv;
  try { csv = await fetchSheet(); }
  catch (e) {
    console.error('Failed to fetch sheet:', e.message);
    await sendDiscord('❌ RETURNS POLL FAILED\n\nFailed to fetch sheet: ' + e.message + '\nHost: ' + os.hostname());
    process.exit(1);
  }

  const rows = parseCsv(csv);
  const state = loadState();

  for (const row of rows) {
    const order  = col(row, 'Order Number', 'Order #');
    const serial = extractSerial(col(row, 'SERIAL #', 'Serial #', 'Serial Number'));
    if (!order && !serial) { skipped++; continue; }
    const key = order + '||' + serial;
    if (state.processed[key]) { skipped++; continue; }
    try {
      const res = await createTicket(row);
      if (res.status === 201) {
        const ticketId = res.body.ticket && res.body.ticket.id;
        console.log('  Created ticket #' + ticketId + ' for [' + key + ']');
        state.processed[key] = { ticketId, createdAt: new Date().toISOString() };
        created.count++;
        saveState(state);
      } else {
        const reason = res.body?.details?.base?.[0]?.description || res.body?.description || res.status;
        console.error('  Error ' + res.status + ' for [' + key + ']:', JSON.stringify(res.body).slice(0, 300));
        errorDetails.push('[' + key + '] ' + reason);
        errors++;
      }
    } catch (e) {
      console.error('  Exception for [' + key + ']:', e.message);
      errorDetails.push('[' + key + '] ' + e.message);
      errors++;
    }
    await new Promise(r => setTimeout(r, 1100));
  }

  const icon = errors > 0 ? '❌' : '✅';
  const totalKeys = Object.keys(state.processed).length;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false }).replace(',', '');
  const lines = [
    icon + ' RETURNS POLL ' + (errors > 0 ? 'ERRORS' : 'OK'), '',
    'Rows Seen    : ' + rows.length,
    'Created      : ' + created.count,
    'Skipped      : ' + skipped,
    'Errors       : ' + errors,
    'Total Created: ' + totalKeys,
  ];
  if (errorDetails.length) lines.push('', ...errorDetails.map(e => '⚠️ ' + e));
  lines.push('Host: ' + os.hostname(), 'Time: ' + now);
  await sendDiscord(lines.join('\n'));
  console.log('[' + new Date().toISOString() + '] Done. Created: ' + created.count + ', Skipped: ' + skipped + ', Errors: ' + errors);
}

main().catch(async e => {
  console.error('Fatal:', e.message);
  await sendDiscord('❌ RETURNS POLL FAILED\n\n' + e.message + '\nHost: ' + os.hostname());
  process.exit(1);
});
