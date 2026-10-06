const { all, get, run } = require('./db');
const { COMPANY } = require('./constants');

async function deliverEmail(id, to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || `${COMPANY.name} <onboarding@resend.dev>`,
        to: [to],
        subject,
        text,
      }),
    });
    run('UPDATE outbox SET status = ? WHERE id = ?', resp.ok ? 'sent' : `failed:${resp.status}`, id);
  } catch (err) {
    run('UPDATE outbox SET status = ? WHERE id = ?', 'failed:network', id);
  }
}

/**
 * Every email is recorded in the outbox table so admins can audit what was
 * forwarded. Real delivery only happens when RESEND_API_KEY is configured.
 */
function sendEmail(to, subject, text) {
  if (!to) return;
  const { lastInsertRowid } = run('INSERT INTO outbox (to_email, subject, body) VALUES (?, ?, ?)', to, subject, text);
  if (process.env.NODE_ENV !== 'test') console.log(`[mail] -> ${to}: ${subject}`);
  deliverEmail(lastInsertRowid, to, subject, text);
}

function notify(userId, { title, body = '', link = null, email = true }) {
  run('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)', userId, title, body, link);
  if (email) {
    const user = get('SELECT email FROM users WHERE id = ?', userId);
    const base = process.env.APP_URL || 'http://localhost:3000';
    if (user) sendEmail(user.email, `${COMPANY.name}: ${title}`, `${body}${link ? `\n\nView details: ${base}${link}` : ''}`);
  }
}

function notifyRole(role, payload) {
  for (const u of all('SELECT id FROM users WHERE role = ? AND active = 1', role)) notify(u.id, payload);
}

function unreadCount(userId) {
  return get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', userId).n;
}

module.exports = { notify, notifyRole, sendEmail, unreadCount };
