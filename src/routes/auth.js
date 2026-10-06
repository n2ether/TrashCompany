const express = require('express');
const { get, run, transaction } = require('../db');
const { hashPassword, verifyPassword, createSession, destroySession, homeFor } = require('../auth');
const { clean, toInt } = require('../helpers');
const { notifyRole } = require('../notify');

const router = express.Router();

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : null);

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'Sign in', email: '', next: safeNext(req.query.next) || '' });
});

router.post('/login', (req, res) => {
  const email = clean(req.body.email, 160).toLowerCase();
  const user = get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('auth/login', {
      title: 'Sign in',
      email,
      next: safeNext(req.body.next) || '',
      errors: ['That email and password combination did not match our records.'],
    });
  }
  createSession(res, user.id);
  res.redirect(safeNext(req.body.next) || homeFor(user));
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/');
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/register', { title: 'Create your client account', form: {} });
});

router.post('/register', (req, res) => {
  const form = {
    name: clean(req.body.name, 120),
    title: clean(req.body.title, 120),
    email: clean(req.body.email, 160).toLowerCase(),
    phone: clean(req.body.phone, 40),
    company: clean(req.body.company, 160),
    property_name: clean(req.body.property_name, 160),
    address: clean(req.body.address, 200),
    city: clean(req.body.city, 80),
    state: clean(req.body.state, 2).toUpperCase(),
    zip: clean(req.body.zip, 10),
    units: toInt(req.body.units),
  };
  const password = String(req.body.password || '');
  const errors = [];
  if (!form.name) errors.push('Enter your full name.');
  if (!form.company) errors.push('Enter your management company or ownership group.');
  if (!/^\S+@\S+\.\S+$/.test(form.email)) errors.push('Enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (!form.property_name || !form.address) errors.push('Add at least one property name and street address.');
  if (form.email && get('SELECT id FROM users WHERE email = ?', form.email)) errors.push('An account with that email already exists. Try signing in.');
  if (errors.length) return res.status(422).render('auth/register', { title: 'Create your client account', form, errors });

  const userId = transaction(() => {
    const org = run('INSERT INTO organizations (name, billing_email, phone, plan) VALUES (?, ?, ?, ?)', form.company, form.email, form.phone, 'Pending review');
    run(
      'INSERT INTO properties (org_id, name, address, city, state, zip, units) VALUES (?, ?, ?, ?, ?, ?, ?)',
      org.lastInsertRowid,
      form.property_name,
      form.address,
      form.city,
      form.state,
      form.zip,
      form.units || 0
    );
    const u = run(
      "INSERT INTO users (name, title, email, phone, password_hash, role, org_id) VALUES (?, ?, ?, ?, ?, 'client', ?)",
      form.name,
      form.title,
      form.email,
      form.phone,
      hashPassword(password),
      org.lastInsertRowid
    );
    return Number(u.lastInsertRowid);
  });
  notifyRole('admin', { title: `New client account: ${form.company}`, body: `${form.name} registered ${form.property_name} (${form.units || '?'} units).`, link: '/admin/clients' });
  createSession(res, userId);
  res.flash('success', 'Welcome aboard! Your account is ready. Submit your first service request any time.');
  res.redirect('/portal');
});

module.exports = router;
