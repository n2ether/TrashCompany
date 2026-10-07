const crypto = require('node:crypto');
const { get, run } = require('./db');

const SESSION_COOKIE = 'vv_sid';
const CSRF_COOKIE = 'vv_csrf';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const secureCookies = process.env.NODE_ENV === 'production';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', id, userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: SESSION_TTL_MS,
  });
}

function destroySession(req, res) {
  const id = req.cookies[SESSION_COOKIE];
  if (id) run('DELETE FROM sessions WHERE id = ?', id);
  res.clearCookie(SESSION_COOKIE);
}

function loadUser(req, res, next) {
  const id = req.cookies[SESSION_COOKIE];
  req.user = null;
  if (id) {
    const row = get(
      `SELECT u.*, s.expires_at, o.name AS org_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN organizations o ON o.id = u.org_id
        WHERE s.id = ?`,
      id
    );
    if (row && row.expires_at > Date.now() && row.active) {
      delete row.password_hash;
      req.user = row;
    } else if (row) {
      run('DELETE FROM sessions WHERE id = ?', id);
      res.clearCookie(SESSION_COOKIE);
    }
  }
  res.locals.user = req.user;
  next();
}

function csrf(req, res, next) {
  let token = req.cookies[CSRF_COOKIE];
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    res.cookie(CSRF_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies });
  }
  res.locals.csrfToken = token;
  if (req.method === 'POST') {
    const sent = req.body && req.body._csrf;
    if (!sent || !req.cookies[CSRF_COOKIE] || sent !== req.cookies[CSRF_COOKIE]) {
      return res.status(403).render('shared/error', {
        title: 'Form expired',
        message: 'Your form session expired. Please go back, refresh the page, and try again.',
      });
    }
  }
  next();
}

function homeFor(user) {
  if (!user) return '/login';
  if (user.role === 'admin') return '/admin';
  if (user.role === 'client') return '/portal';
  if (user.role === 'contractor') return '/work';
  return '/crew';
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('shared/error', {
        title: 'Access restricted',
        message: 'Your account does not have access to this area.',
      });
    }
    next();
  };
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  csrf,
  homeFor,
  requireRole,
  requireLogin,
};
