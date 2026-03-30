const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendCustomerConfirmation, sendAgentNotification } = require('../mailer');

// ── Config ────────────────────────────────────────────────
const BLOCKS = {
  A: {
    label: '1:00 AM – 7:00 AM PST',
    agents: [
      { name: 'Johanna Salas',   email: 'johannasalas@audiconcorp.com' },
      { name: 'Cesar David Jr.', email: 'jayardavidjr@audiconcorp.com' }
    ],
    slots: ['01:00','01:30','02:00','02:30','03:00','03:30',
            '04:00','04:30','05:00','05:30','06:00','06:30']
  },
  B: {
    label: '9:00 AM – 4:00 PM PST',
    agents: [
      { name: 'Rissa Mae Cerezo', email: 'rissacerezo@audiconcorp.com' },
      { name: 'Martha Canlas',    email: 'martha.canlas@audiconcorp.com' }
    ],
    slots: ['09:00','09:30','10:00','10:30','11:00','11:30',
            '12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30']
  }
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

function assignAgent(date, blockKey, excludeId = null) {
  const agents = BLOCKS[blockKey].agents;
  const counts = agents.map(agent => {
    const query = excludeId
      ? 'SELECT COUNT(*) as n FROM appointments WHERE date = ? AND block = ? AND agent_email = ? AND id != ?'
      : 'SELECT COUNT(*) as n FROM appointments WHERE date = ? AND block = ? AND agent_email = ?';
    const params = excludeId
      ? [date, blockKey, agent.email, excludeId]
      : [date, blockKey, agent.email];
    const row = db.prepare(query).get(...params);
    return { agent, count: row.n };
  });
  counts.sort((a, b) => a.count - b.count);
  return counts[0].agent;
}

// ── GET /appointments ─────────────────────────────────────
router.get('/', (req, res) => {
  let rows;
  if (req.query.date) {
    rows = db.prepare('SELECT * FROM appointments WHERE date = ? ORDER BY time').all(req.query.date);
  } else if (req.query.month) {
    rows = db.prepare("SELECT * FROM appointments WHERE date LIKE ? ORDER BY date, time").all(`${req.query.month}%`);
  } else {
    rows = db.prepare('SELECT * FROM appointments ORDER BY date, time').all();
  }
  res.json(rows);
});

// ── GET /appointments/slots ───────────────────────────────
router.get('/slots', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required' });
  }

  const nowPST   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const todayStr = `${nowPST.getFullYear()}-${String(nowPST.getMonth()+1).padStart(2,'0')}-${String(nowPST.getDate()).padStart(2,'0')}`;
  const nowMins  = nowPST.getHours() * 60 + nowPST.getMinutes();
  const isToday  = date === todayStr;

  const result = {};
  for (const [key, block] of Object.entries(BLOCKS)) {
    const available = block.slots.filter(time => {
      if (isToday) {
        const [h, m] = time.split(':').map(Number);
        if (h * 60 + m <= nowMins) return false;
      }
      const row = db.prepare(
        'SELECT COUNT(*) as n FROM appointments WHERE date = ? AND time = ? AND block = ?'
      ).get(date, time, key);
      return row.n < block.agents.length;
    });
    result[key] = { label: block.label, slots: available };
  }
  res.json(result);
});

// ── GET /appointments/agents ──────────────────────────────
router.get('/agents', (req, res) => {
  res.json(BLOCKS);
});

// ── POST /appointments ────────────────────────────────────
router.post('/', async (req, res) => {
  const { customer_name, customer_email, customer_phone,
          appointment_type, device, date, time, notes } = req.body;

  if (!customer_name || !customer_email || !customer_phone ||
      !appointment_type || !device || !date || !time) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!VALID_TYPES.includes(appointment_type)) return res.status(400).json({ error: 'Invalid appointment type' });
  if (!VALID_DEVICES.includes(device)) return res.status(400).json({ error: 'Invalid device' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

  const blockKey = getBlock(time);
  if (!blockKey) return res.status(400).json({ error: 'Invalid time slot' });

  const taken = db.prepare(
    'SELECT COUNT(*) as n FROM appointments WHERE date = ? AND time = ? AND block = ?'
  ).get(date, time, blockKey);
  if (taken.n >= BLOCKS[blockKey].agents.length) {
    return res.status(409).json({ error: 'This time slot is fully booked' });
  }

  const agent = assignAgent(date, blockKey);

  const result = db.prepare(`
    INSERT INTO appointments
      (customer_name, customer_email, customer_phone, appointment_type,
       device, date, time, block, agent_name, agent_email, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer_name, customer_email, customer_phone, appointment_type,
         device, date, time, blockKey, agent.name, agent.email, notes || null);

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(result.lastInsertRowid);

  Promise.all([
    sendCustomerConfirmation(appt),
    sendAgentNotification(appt)
  ]).catch(err => console.error('[mailer]', err.message));

  res.status(201).json(appt);
});

// ── PUT /appointments/:id ─────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
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
    agent_name,
    agent_email,
  } = req.body;

  if (!VALID_TYPES.includes(appointment_type)) return res.status(400).json({ error: 'Invalid appointment type' });
  if (!VALID_DEVICES.includes(device)) return res.status(400).json({ error: 'Invalid device' });

  const dateChanged = date !== existing.date || time !== existing.time;
  let blockKey = existing.block;

  if (dateChanged) {
    blockKey = getBlock(time);
    if (!blockKey) return res.status(400).json({ error: 'Invalid time slot' });

    const taken = db.prepare(
      'SELECT COUNT(*) as n FROM appointments WHERE date = ? AND time = ? AND block = ? AND id != ?'
    ).get(date, time, blockKey, req.params.id);
    if (taken.n >= BLOCKS[blockKey].agents.length) {
      return res.status(409).json({ error: 'This time slot is fully booked' });
    }
  }

  // Use provided agent or keep existing (or re-assign if block changed)
  let finalAgentName  = agent_name  || existing.agent_name;
  let finalAgentEmail = agent_email || existing.agent_email;

  // If block changed and no explicit agent given, auto-assign
  if (dateChanged && blockKey !== existing.block && !agent_name) {
    const assigned = assignAgent(date, blockKey, req.params.id);
    finalAgentName  = assigned.name;
    finalAgentEmail = assigned.email;
  }

  db.prepare(`
    UPDATE appointments SET
      customer_name=?, customer_email=?, customer_phone=?,
      appointment_type=?, device=?, notes=?,
      date=?, time=?, block=?, agent_name=?, agent_email=?
    WHERE id=?
  `).run(customer_name, customer_email, customer_phone, appointment_type,
         device, notes || null, date, time, blockKey,
         finalAgentName, finalAgentEmail, req.params.id);

  res.json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id));
});

// ── DELETE /appointments/:id ──────────────────────────────
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
