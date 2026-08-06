const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'appointments.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name  TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    appointment_type TEXT NOT NULL,
    device         TEXT NOT NULL,
    date           TEXT NOT NULL,
    time           TEXT NOT NULL,
    block          TEXT NOT NULL,
    agent_name     TEXT NOT NULL,
    agent_email    TEXT NOT NULL,
    notes          TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT NOT NULL CHECK(type IN ('birthday','day_off')),
    label   TEXT NOT NULL,
    date    TEXT NOT NULL,
    annual  INTEGER NOT NULL DEFAULT 0,
    note    TEXT
  )
`);

module.exports = db;
