const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

function fmt(time24) {
  const [h, m] = time24.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function row(label, value, shaded) {
  const bg = shaded ? 'background:#f5f5f5;' : '';
  return `<tr>
    <td style="padding:10px;${bg}font-weight:600;width:38%;color:#555">${label}</td>
    <td style="padding:10px;${bg}color:#1a1a1a">${value}</td>
  </tr>`;
}

function baseTemplate(title, body) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:#FF8C42;padding:24px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:20px">${title}</h1>
      </div>
      <div style="padding:32px;background:#ffffff">
        ${body}
        <p style="margin-top:24px;font-size:13px;color:#999">— Ceretone Support Team</p>
      </div>
    </div>`;
}

async function sendCustomerConfirmation(appt) {
  const table = `
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
      ${row('Date', appt.date, true)}
      ${row('Time', fmt(appt.time) + ' PST', false)}
      ${row('Type', appt.appointment_type, true)}
      ${row('Device', appt.device, false)}
      ${row('Agent', appt.agent_name, true)}
    </table>`;

  await transporter.sendMail({
    from: `"Ceretone Support" <${process.env.GMAIL_USER}>`,
    to: appt.customer_email,
    subject: 'Your Appointment is Confirmed — Ceretone Support',
    html: baseTemplate('Appointment Confirmed', `
      <p>Hi ${appt.customer_name},</p>
      <p>Your support appointment has been confirmed. Here are your details:</p>
      ${table}
      <p>To reschedule or cancel, reply to this email.</p>
      <p>We look forward to speaking with you!</p>
    `)
  });
}

async function sendAgentNotification(appt) {
  const firstName = appt.agent_name.split(' ')[0];
  const table = `
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
      ${row('Date', appt.date, true)}
      ${row('Time', fmt(appt.time) + ' PST', false)}
      ${row('Customer', appt.customer_name, true)}
      ${row('Email', appt.customer_email, false)}
      ${row('Phone', appt.customer_phone, true)}
      ${row('Type', appt.appointment_type, false)}
      ${row('Device', appt.device, true)}
    </table>`;

  await transporter.sendMail({
    from: `"Ceretone Appointments" <${process.env.GMAIL_USER}>`,
    to: appt.agent_email,
    subject: `New Appointment — ${appt.customer_name} on ${appt.date} at ${fmt(appt.time)} PST`,
    html: baseTemplate('New Appointment Booked', `
      <p>Hi ${firstName},</p>
      <p>You have a new appointment scheduled:</p>
      ${table}
    `)
  });
}

module.exports = { sendCustomerConfirmation, sendAgentNotification };
