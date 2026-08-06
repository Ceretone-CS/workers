require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const appointmentsRouter    = require('./routes/appointments');
const calendarEventsRouter  = require('./routes/calendar-events');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/appointments',     appointmentsRouter);
app.use('/calendar-events',  calendarEventsRouter);
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`appt-worker listening on port ${PORT}`));
