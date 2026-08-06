const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { sendCustomerConfirmation, sendAgentNotification } = require('../mailer');

// ── Easter Sunday (Anonymous Gregorian algorithm) ─────────
function getEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// ── Date helpers ──────────────────────────────────────────
function ds(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function dayOfWeek(y, m, d) { return new Date(y, m - 1, d).getDay(); } // 0=Sun
function addDays(date, n) {
  const r = new Date(date); r.setDate(r.getDate() + n); return r;
}
function firstMondayOfMonth(y, m) {
  let d = 1; while (new Date(y, m-1, d).getDay() !== 1) d++; return d;
}
function lastMondayOfMonth(y, m) {
  const last = new Date(y, m, 0).getDate();
  let d = last; while (new Date(y, m-1, d).getDay() !== 1) d--; return d;
}

// ── UK Bank Holidays ──────────────────────────────────────
function computeUKHolidays(year) {
  const map = new Map();
  const add = (dateStr, name) => map.set(dateStr, name);

  // New Year's Eve (Dec 31): Saturday only → following Monday (Jan 2); else observed as Dec 31
  const nyeDow = dayOfWeek(year, 12, 31);
  if (nyeDow === 6) add(ds(year+1, 1, 2), "New Year's Eve (observed)");
  else              add(ds(year, 12, 31),  "New Year's Eve");

  // New Year's Day (Jan 1): NOT observed if Saturday; Sunday → observed as Jan 1
  const nyDow = dayOfWeek(year, 1, 1);
  if (nyDow !== 6) add(ds(year, 1, 1), "New Year's Day");

  // Good Friday (Easter − 2 days) + Easter Monday
  const easter = getEasterSunday(year);
  const goodFriday   = addDays(easter, -2);
  const easterMonday = addDays(easter,  1);
  add(goodFriday.toISOString().split('T')[0],   'Good Friday');
  add(easterMonday.toISOString().split('T')[0],  'Easter Monday');

  // Early May Bank Holiday: first Monday of May
  add(ds(year, 5, firstMondayOfMonth(year, 5)), 'Early May Bank Holiday');

  // Spring Bank Holiday: last Monday of May
  add(ds(year, 5, lastMondayOfMonth(year, 5)), 'Spring Bank Holiday');

  // Summer Bank Holiday: last Monday of August
  add(ds(year, 8, lastMondayOfMonth(year, 8)), 'Summer Bank Holiday');

  // Christmas Eve (Dec 24): Saturday only → NOT observed, Dec 23 observed instead; else Dec 24
  const xmasEveDow = dayOfWeek(year, 12, 24);
  if (xmasEveDow === 6) add(ds(year, 12, 23), 'Christmas Eve (observed)');
  else                  add(ds(year, 12, 24), 'Christmas Eve');

  // Christmas Day (Dec 25): NOT observed if Saturday
  const xmasDow = dayOfWeek(year, 12, 25);
  if (xmasDow !== 6) add(ds(year, 12, 25), 'Christmas Day');

  // Boxing Day (Dec 26): next weekday if Dec 26 is a weekend
  const boxDow = dayOfWeek(year, 12, 26);
  if (boxDow === 6)      add(ds(year, 12, 28), 'Boxing Day (observed)');
  else if (boxDow === 0) add(ds(year, 12, 27), 'Boxing Day (observed)');
  else                   add(ds(year, 12, 26), 'Boxing Day');

  return map;
}

// ── US Holidays ───────────────────────────────────────────
function computeUSHolidays(year) {
  const map = new Map();
  const add = (dateStr, name) => map.set(dateStr, name);

  // New Year's Eve (Dec 31): Saturday only → Monday (Jan 2 of next year); else Dec 31
  const nyeDow = dayOfWeek(year, 12, 31);
  if (nyeDow === 6) add(ds(year+1, 1, 2), "New Year's Eve (observed)");
  else              add(ds(year, 12, 31),  "New Year's Eve");

  // New Year's Day (Jan 1): NOT observed if Saturday; Sunday → observed as Jan 1
  const nyDow = dayOfWeek(year, 1, 1);
  if (nyDow !== 6) add(ds(year, 1, 1), "New Year's Day");

  // Presidents' Day: 3rd Monday of February
  { let d = 1, count = 0;
    while (count < 3) { if (new Date(year, 1, d).getDay() === 1) count++; if (count < 3) d++; }
    add(ds(year, 2, d), "Presidents' Day"); }

  // Memorial Day: last Monday of May
  add(ds(year, 5, lastMondayOfMonth(year, 5)), 'Memorial Day');

  // Independence Day (Jul 4): Saturday → Friday; Sunday → Monday
  const jul4Dow = dayOfWeek(year, 7, 4);
  if (jul4Dow === 6)      add(ds(year, 7, 3), 'Independence Day (observed)');
  else if (jul4Dow === 0) add(ds(year, 7, 5), 'Independence Day (observed)');
  else                    add(ds(year, 7, 4), 'Independence Day');

  // Labor Day: 1st Monday of September
  add(ds(year, 9, firstMondayOfMonth(year, 9)), 'Labor Day');

  // Veterans Day (Nov 11): Saturday → Friday; Sunday → Monday
  const vetDow = dayOfWeek(year, 11, 11);
  if (vetDow === 6)      add(ds(year, 11, 10), 'Veterans Day (observed)');
  else if (vetDow === 0) add(ds(year, 11, 12), 'Veterans Day (observed)');
  else                   add(ds(year, 11, 11), 'Veterans Day');

  // Thanksgiving: last Thursday of November
  { let d = new Date(year, 11, 0).getDate(); // Nov 30
    while (new Date(year, 10, d).getDay() !== 4) d--;
    add(ds(year, 11, d), 'Thanksgiving'); }

  // Christmas Eve (Dec 24): Saturday → NOT observed, Dec 26 observed instead; else Dec 24
  const xmasEveDow = dayOfWeek(year, 12, 24);
  if (xmasEveDow === 6) add(ds(year, 12, 26), 'Christmas Eve (observed)');
  else                  add(ds(year, 12, 24), 'Christmas Eve');

  // Christmas Day (Dec 25): NOT observed if Saturday
  const xmasDow = dayOfWeek(year, 12, 25);
  if (xmasDow !== 6) add(ds(year, 12, 25), 'Christmas Day');

  return map;
}

// ── Holiday cache ─────────────────────────────────────────
const _cache = { UK: {}, US: {} };

function getHolidayMap(region, year) {
  if (!_cache[region][year]) {
    _cache[region][year] = region === 'UK' ? computeUKHolidays(year) : computeUSHolidays(year);
  }
  return _cache[region][year];
}

function getHolidayName(dateStr, region) {
  const year = parseInt(dateStr.split('-')[0], 10);
  return getHolidayMap(region, year).get(dateStr) ?? null;
}

// ── Block config ──────────────────────────────────────────
// First and last hour of each block are reserved — not bookable.
const BLOCKS = {
  A: {
    label:  '2:00 AM – 6:00 AM PST',
    region: 'UK',
    agents: [
      { name: 'Johanna Salas',   email: 'johannasalas@audiconcorp.com',  region: 'UK' },
      { name: 'Cesar David Jr.', email: 'jayardavidjr@audiconcorp.com',  region: 'UK' },
    ],
    slots: ['02:00','02:30','03:00','03:30','04:00','04:30','05:00','05:30'],
  },
  B: {
    label:  '10:00 AM – 3:00 PM PST',
    region: 'US',
    agents: [
      { name: 'Rissa Mae Cerezo', email: 'rissacerezo@audiconcorp.com',   region: 'US' },
      { name: 'Martha Canlas',    email: 'martha.canlas@audiconcorp.com', region: 'US' },
    ],
    slots: ['10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30'],
  },
};

const VALID_TYPES   = ['Troubleshooting', 'Onboarding', 'Consultation'];
const VALID_DEVICES = ['Beacon', 'Core One', 'Core One Pro', 'Fusion', 'Nexus', 'Solid', 'Style'];

// ── Helpers ───────────────────────────────────────────────
function getBlock(time) {
  for (const [key, block] of Object.entries(BLOCKS)) {
    if (block.slots.includes(time)) return key;
  }
  return null;
}

function getAvailableAgents(blockKey, date) {
  return BLOCKS[blockKey].agents.filter(a => !getHolidayName(date, a.region));
}

function assignAgent(date, blockKey, excludeId = null) {
  const available = getAvailableAgents(blockKey, date);
  if (available.length === 0) return null;
  const counts = available.map(agent => {
    const query = excludeId
      ? 'SELECT COUNT(*) as n FROM appointments WHERE date=? AND block=? AND agent_email=? AND id!=?'
      : 'SELECT COUNT(*) as n FROM appointments WHERE date=? AND block=? AND agent_email=?';
    const params = excludeId
      ? [date, blockKey, agent.email, excludeId]
      : [date, blockKey, agent.email];
    return { agent, count: db.prepare(query).get(...params).n };
  });
  counts.sort((a, b) => a.count - b.count);
  return counts[0].agent;
}

// ── GET /appointments/holidays ────────────────────────────
router.get('/holidays', (req, res) => {
  const { date, month } = req.query;

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required' });
    return res.json({
      UK: getHolidayName(date, 'UK'),
      US: getHolidayName(date, 'US'),
    });
  }

  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: 'Valid month (YYYY-MM) required' });
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const result = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = ds(y, m, d);
      const uk = getHolidayName(dateStr, 'UK');
      const us = getHolidayName(dateStr, 'US');
      if (uk || us) result[dateStr] = { UK: uk, US: us };
    }
    return res.json(result);
  }

  return res.status(400).json({ error: 'date or month parameter required' });
});

// ── GET /appointments ─────────────────────────────────────
router.get('/', (req, res) => {
  let rows;
  if (req.query.date) {
    rows = db.prepare('SELECT * FROM appointments WHERE date=? ORDER BY time').all(req.query.date);
  } else if (req.query.month) {
    rows = db.prepare("SELECT * FROM appointments WHERE date LIKE ? ORDER BY date,time").all(`${req.query.month}%`);
  } else {
    rows = db.prepare('SELECT * FROM appointments ORDER BY date,time').all();
  }
  res.json(rows);
});

// ── GET /appointments/slots ───────────────────────────────
router.get('/slots', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required' });

  const nowPST  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const todayStr = `${nowPST.getFullYear()}-${String(nowPST.getMonth()+1).padStart(2,'0')}-${String(nowPST.getDate()).padStart(2,'0')}`;
  const nowMins  = nowPST.getHours() * 60 + nowPST.getMinutes();
  const isToday  = date === todayStr;

  const result = {};
  for (const [key, block] of Object.entries(BLOCKS)) {
    const holiday        = getHolidayName(date, block.region);
    const agentsOnDuty   = getAvailableAgents(key, date);
    const agentCount     = agentsOnDuty.length;

    const slots = (holiday || agentCount === 0) ? [] : block.slots.filter(time => {
      if (isToday) {
        const [h, m] = time.split(':').map(Number);
        if (h * 60 + m <= nowMins) return false;
      }
      const taken = db.prepare(
        'SELECT COUNT(*) as n FROM appointments WHERE date=? AND time=? AND block=?'
      ).get(date, time, key);
      return taken.n < agentCount;
    });

    result[key] = { label: block.label, slots, holiday };
  }
  res.json(result);
});

// ── GET /appointments/agents ──────────────────────────────
router.get('/agents', (_req, res) => res.json(BLOCKS));

// ── POST /appointments ────────────────────────────────────
router.post('/', async (req, res) => {
  const { customer_name, customer_email, customer_phone,
          appointment_type, device, date, time, notes } = req.body;

  if (!customer_name || !customer_email || !customer_phone ||
      !appointment_type || !device || !date || !time)
    return res.status(400).json({ error: 'All fields are required' });
  if (!VALID_TYPES.includes(appointment_type))
    return res.status(400).json({ error: 'Invalid appointment type' });
  if (!VALID_DEVICES.includes(device))
    return res.status(400).json({ error: 'Invalid device' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });

  const blockKey = getBlock(time);
  if (!blockKey) return res.status(400).json({ error: 'Invalid time slot' });

  const holiday = getHolidayName(date, BLOCKS[blockKey].region);
  if (holiday)
    return res.status(409).json({ error: `Booking unavailable — ${holiday}` });

  const agentsOnDuty = getAvailableAgents(blockKey, date);
  if (agentsOnDuty.length === 0)
    return res.status(409).json({ error: 'No agents available for this date' });

  const taken = db.prepare(
    'SELECT COUNT(*) as n FROM appointments WHERE date=? AND time=? AND block=?'
  ).get(date, time, blockKey);
  if (taken.n >= agentsOnDuty.length)
    return res.status(409).json({ error: 'This time slot is fully booked' });

  const agent = assignAgent(date, blockKey);

  const result = db.prepare(`
    INSERT INTO appointments
      (customer_name, customer_email, customer_phone, appointment_type,
       device, date, time, block, agent_name, agent_email, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(customer_name, customer_email, customer_phone, appointment_type,
         device, date, time, blockKey, agent.name, agent.email, notes || null);

  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(result.lastInsertRowid);

  Promise.all([
    sendCustomerConfirmation(appt),
    sendAgentNotification(appt),
  ]).catch(err => console.error('[mailer]', err.message));

  res.status(201).json(appt);
});

// ── PUT /appointments/:id ─────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    customer_name  = existing.customer_name,
    customer_email = existing.customer_email,
    customer_phone = existing.customer_phone,
    appointment_type = existing.appointment_type,
    device         = existing.device,
    notes          = existing.notes,
    date           = existing.date,
    time           = existing.time,
    agent_name, agent_email,
  } = req.body;

  if (!VALID_TYPES.includes(appointment_type))
    return res.status(400).json({ error: 'Invalid appointment type' });
  if (!VALID_DEVICES.includes(device))
    return res.status(400).json({ error: 'Invalid device' });

  const dateChanged = date !== existing.date || time !== existing.time;
  let blockKey = existing.block;

  if (dateChanged) {
    blockKey = getBlock(time);
    if (!blockKey) return res.status(400).json({ error: 'Invalid time slot' });

    const taken = db.prepare(
      'SELECT COUNT(*) as n FROM appointments WHERE date=? AND time=? AND block=? AND id!=?'
    ).get(date, time, blockKey, req.params.id);
    const agentsOnDuty = getAvailableAgents(blockKey, date);
    if (taken.n >= agentsOnDuty.length)
      return res.status(409).json({ error: 'This time slot is fully booked' });
  }

  let finalAgentName  = agent_name  || existing.agent_name;
  let finalAgentEmail = agent_email || existing.agent_email;

  if (dateChanged && blockKey !== existing.block && !agent_name) {
    const assigned = assignAgent(date, blockKey, req.params.id);
    if (assigned) { finalAgentName = assigned.name; finalAgentEmail = assigned.email; }
  }

  db.prepare(`
    UPDATE appointments SET
      customer_name=?,customer_email=?,customer_phone=?,
      appointment_type=?,device=?,notes=?,
      date=?,time=?,block=?,agent_name=?,agent_email=?
    WHERE id=?
  `).run(customer_name, customer_email, customer_phone, appointment_type,
         device, notes || null, date, time, blockKey,
         finalAgentName, finalAgentEmail, req.params.id);

  res.json(db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id));
});

// ── DELETE /appointments/:id ──────────────────────────────
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM appointments WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
