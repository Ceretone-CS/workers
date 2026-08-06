const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /calendar-events  ?month=YYYY-MM | ?date=YYYY-MM-DD | (all)
router.get('/', (req, res) => {
  const { month, date } = req.query;
  if (date) {
    const mmdd = date.slice(5);
    return res.json(db.prepare(`
      SELECT * FROM calendar_events
      WHERE (annual=0 AND date=?) OR (annual=1 AND substr(date,6)=?)
      ORDER BY type, label
    `).all(date, mmdd));
  }
  if (month) {
    const mm = month.slice(5).padStart(2, '0');
    return res.json(db.prepare(`
      SELECT * FROM calendar_events
      WHERE (annual=0 AND date LIKE ?) OR (annual=1 AND substr(date,6) LIKE ?)
      ORDER BY date, type, label
    `).all(`${month}-%`, `${mm}-%`));
  }
  res.json(db.prepare('SELECT * FROM calendar_events ORDER BY type, annual DESC, date, label').all());
});

// POST /calendar-events
router.post('/', (req, res) => {
  const { type, label, date, annual = 0, note = null } = req.body;
  if (!type || !label || !date) return res.status(400).json({ error: 'type, label, date required' });
  if (!['birthday', 'day_off'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  const result = db.prepare(
    'INSERT INTO calendar_events (type, label, date, annual, note) VALUES (?,?,?,?,?)'
  ).run(type, label, date, annual ? 1 : 0, note || null);
  res.status(201).json(db.prepare('SELECT * FROM calendar_events WHERE id=?').get(result.lastInsertRowid));
});

// DELETE /calendar-events/:id
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM calendar_events WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
