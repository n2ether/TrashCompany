const express = require('express');
const crypto = require('node:crypto');
const { all, get, run } = require('../db');
const { requireRole, hashPassword, verifyPassword } = require('../auth');
const { clean, toInt, toArray, isoDate, addDays, isValidDate, serviceLabel } = require('../helpers');
const { SERVICE_TYPES, PRIORITIES, FREQUENCIES, NIGHTS } = require('../constants');
const { listJobs, logActivity, setRequestStatus } = require('../jobs');
const { notifyRole, notify } = require('../notify');

const router = express.Router();
router.use(requireRole('client'));

const orgProperties = (orgId) => all('SELECT * FROM properties WHERE org_id = ? ORDER BY name', orgId);

const REQUEST_SELECT = `
  SELECT r.*, p.name AS property_name, u.name AS requester_name,
         (SELECT j.scheduled_date FROM jobs j WHERE j.request_id = r.id AND j.status != 'cancelled' ORDER BY j.scheduled_date LIMIT 1) AS scheduled_date,
         (SELECT j.start_time FROM jobs j WHERE j.request_id = r.id AND j.status != 'cancelled' ORDER BY j.scheduled_date LIMIT 1) AS scheduled_time
    FROM service_requests r
    JOIN properties p ON p.id = r.property_id
    LEFT JOIN users u ON u.id = r.requested_by`;

router.get('/', (req, res) => {
  const orgId = req.user.org_id;
  const today = isoDate();
  const properties = orgProperties(orgId);
  const openRequests = all(`${REQUEST_SELECT} WHERE r.org_id = ? AND r.status NOT IN ('completed','cancelled') ORDER BY r.created_at DESC`, orgId);
  const upcoming = listJobs("p.org_id = ? AND j.scheduled_date BETWEEN ? AND ? AND j.status != 'cancelled'", orgId, today, addDays(today, 7));
  const recent = listJobs("p.org_id = ? AND j.status = 'completed' AND j.scheduled_date >= ?", orgId, addDays(today, -14)).reverse().slice(0, 6);
  const stats = {
    doors: properties.reduce((s, p) => s + (p.units || 0), 0),
    open: openRequests.length,
    completed30: get(
      "SELECT COUNT(*) AS n FROM jobs j JOIN properties p ON p.id = j.property_id WHERE p.org_id = ? AND j.status = 'completed' AND j.scheduled_date >= ?",
      orgId,
      addDays(today, -30)
    ).n,
    balance: get("SELECT COALESCE(SUM(amount_cents),0) AS c FROM invoices WHERE org_id = ? AND status = 'open'", orgId).c,
  };
  res.render('portal/dashboard', { title: 'Dashboard', properties, openRequests, upcoming, recent, stats, today });
});

router.get('/requests', (req, res) => {
  const filter = req.query.status || 'open';
  let where = 'r.org_id = ?';
  if (filter === 'open') where += " AND r.status NOT IN ('completed','cancelled')";
  else if (filter === 'closed') where += " AND r.status IN ('completed','cancelled')";
  const requests = all(`${REQUEST_SELECT} WHERE ${where} ORDER BY r.created_at DESC`, req.user.org_id);
  res.render('portal/requests', { title: 'Service Requests', requests, filter });
});

router.get('/requests/new', (req, res) => {
  const properties = orgProperties(req.user.org_id);
  const type = SERVICE_TYPES[req.query.type] ? req.query.type : '';
  res.render('portal/request-new', {
    title: 'Request Service',
    properties,
    form: { type, property_id: toInt(req.query.property) || (properties[0] && properties[0].id), priority: 'standard', frequency: 'one_time' },
    minDate: isoDate(),
  });
});

router.post('/requests', (req, res) => {
  const properties = orgProperties(req.user.org_id);
  const form = {
    type: clean(req.body.type, 40),
    property_id: toInt(req.body.property_id),
    priority: PRIORITIES[req.body.priority] ? req.body.priority : 'standard',
    frequency: FREQUENCIES[req.body.frequency] ? req.body.frequency : 'one_time',
    preferred_date: clean(req.body.preferred_date, 10),
    preferred_window: clean(req.body.preferred_window, 60),
    location_details: clean(req.body.location_details, 300),
    quantity: toInt(req.body.quantity),
    description: clean(req.body.description, 2000),
  };
  const errors = [];
  if (!SERVICE_TYPES[form.type]) errors.push('Choose the type of service you need.');
  if (!properties.find((p) => p.id === form.property_id)) errors.push('Choose one of your properties.');
  if (form.preferred_date && (!isValidDate(form.preferred_date) || form.preferred_date < isoDate())) errors.push('Preferred date must be today or later.');
  if (!form.description && !form.location_details) errors.push('Tell us where the service is needed or add a short description.');
  if (errors.length) return res.status(422).render('portal/request-new', { title: 'Request Service', properties, form, errors, minDate: isoDate() });

  const { lastInsertRowid } = run(
    `INSERT INTO service_requests (org_id, property_id, requested_by, type, priority, frequency, preferred_date, preferred_window, location_details, quantity, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.org_id,
    form.property_id,
    req.user.id,
    form.type,
    form.priority,
    form.frequency,
    form.preferred_date || null,
    form.preferred_window || null,
    form.location_details || null,
    form.quantity,
    form.description || null
  );
  const id = Number(lastInsertRowid);
  const prop = properties.find((p) => p.id === form.property_id);
  logActivity(id, req.user.id, 'Request submitted.', 'status');
  notifyRole('admin', {
    title: `${form.priority === 'urgent' ? 'URGENT ' : ''}New request #${id}: ${serviceLabel(form.type)}`,
    body: `${req.user.org_name} — ${prop.name}. ${form.location_details || ''} ${form.description || ''}`.trim(),
    link: `/admin/requests/${id}`,
  });
  res.flash('success', `Request #${id} submitted. We'll confirm a date and crew shortly.`);
  res.redirect(`/portal/requests/${id}`);
});

function loadRequest(req, res) {
  const r = get(`${REQUEST_SELECT} WHERE r.id = ? AND r.org_id = ?`, toInt(req.params.id), req.user.org_id);
  if (!r) res.status(404).render('shared/error', { title: 'Request not found', message: 'That request does not exist or belongs to another account.' });
  return r;
}

router.get('/requests/:id', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  const activity = all(
    `SELECT a.*, u.name AS user_name, u.role AS user_role FROM request_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.request_id = ? ORDER BY a.id`,
    r.id
  );
  const jobs = listJobs('j.request_id = ?', r.id);
  res.render('portal/request-detail', { title: `Request #${r.id}`, r, activity, jobs });
});

router.post('/requests/:id/comment', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  const message = clean(req.body.message, 1500);
  if (message) {
    logActivity(r.id, req.user.id, message, 'comment');
    notifyRole('admin', { title: `New message on request #${r.id}`, body: `${req.user.name}: ${message}`, link: `/admin/requests/${r.id}`, email: false });
  }
  res.redirect(`/portal/requests/${r.id}#activity`);
});

router.post('/requests/:id/cancel', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  if (r.status === 'submitted') {
    setRequestStatus(r.id, 'cancelled', req.user.id, `Cancelled by ${req.user.name}.`);
    res.flash('info', `Request #${r.id} was cancelled.`);
  } else {
    res.flash('error', 'This request is already scheduled. Send us a message below and we will update it for you.');
  }
  res.redirect(`/portal/requests/${r.id}`);
});

router.get('/schedule', (req, res) => {
  const today = isoDate();
  const propertyId = toInt(req.query.property);
  const properties = orgProperties(req.user.org_id);
  const params = [req.user.org_id, addDays(today, -7), addDays(today, 21)];
  let where = "p.org_id = ? AND j.scheduled_date BETWEEN ? AND ? AND j.status != 'cancelled'";
  if (propertyId) {
    where += ' AND p.id = ?';
    params.push(propertyId);
  }
  const jobs = listJobs(where, ...params);
  const days = {};
  for (const j of jobs) (days[j.scheduled_date] = days[j.scheduled_date] || []).push(j);
  res.render('portal/schedule', { title: 'Service Schedule', days, properties, propertyId, today });
});

function propertyForm(body) {
  return {
    name: clean(body.name, 160),
    address: clean(body.address, 200),
    city: clean(body.city, 80),
    state: clean(body.state, 2).toUpperCase(),
    zip: clean(body.zip, 10),
    units: toInt(body.units) || 0,
    buildings: toInt(body.buildings) || 1,
    property_type: clean(body.property_type, 40),
    service_nights: toArray(body.service_nights).filter((n) => NIGHTS.includes(n)).join(','),
    service_window: clean(body.service_window, 60),
    services: toArray(body.services).filter((s) => SERVICE_TYPES[s]).join(','),
    access_notes: clean(body.access_notes, 1000),
    onsite_contact: clean(body.onsite_contact, 200),
  };
}

router.get('/properties', (req, res) => {
  const properties = all(
    `SELECT p.*, (SELECT COUNT(*) FROM service_requests r WHERE r.property_id = p.id AND r.status NOT IN ('completed','cancelled')) AS open_requests
       FROM properties p WHERE p.org_id = ? ORDER BY p.name`,
    req.user.org_id
  );
  res.render('portal/properties', { title: 'Properties', properties });
});

router.get('/properties/new', (req, res) => {
  res.render('portal/property-form', { title: 'Add a Property', property: { service_nights: 'Sun,Mon,Tue,Wed,Thu', services: 'valet_trash', service_window: '8:00 PM – 10:00 PM' }, isNew: true });
});

router.post('/properties', (req, res) => {
  const p = propertyForm(req.body);
  if (!p.name || !p.address) {
    return res.status(422).render('portal/property-form', { title: 'Add a Property', property: p, isNew: true, errors: ['Property name and street address are required.'] });
  }
  const { lastInsertRowid } = run(
    `INSERT INTO properties (org_id, name, address, city, state, zip, units, buildings, property_type, service_nights, service_window, services, access_notes, onsite_contact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.org_id, p.name, p.address, p.city, p.state, p.zip, p.units, p.buildings, p.property_type, p.service_nights, p.service_window, p.services, p.access_notes, p.onsite_contact
  );
  notifyRole('admin', { title: `New property added: ${p.name}`, body: `${req.user.org_name} added ${p.name} (${p.units} units).`, link: `/admin/clients/${req.user.org_id}`, email: false });
  res.flash('success', `${p.name} was added. Our team will reach out to confirm your service plan.`);
  res.redirect(`/portal/properties#property-${lastInsertRowid}`);
});

router.get('/properties/:id/edit', (req, res) => {
  const property = get('SELECT * FROM properties WHERE id = ? AND org_id = ?', toInt(req.params.id), req.user.org_id);
  if (!property) return res.redirect('/portal/properties');
  res.render('portal/property-form', { title: `Edit ${property.name}`, property, isNew: false });
});

router.post('/properties/:id', (req, res) => {
  const existing = get('SELECT * FROM properties WHERE id = ? AND org_id = ?', toInt(req.params.id), req.user.org_id);
  if (!existing) return res.redirect('/portal/properties');
  const p = propertyForm(req.body);
  if (!p.name || !p.address) {
    return res.status(422).render('portal/property-form', { title: `Edit ${existing.name}`, property: { ...p, id: existing.id }, isNew: false, errors: ['Property name and street address are required.'] });
  }
  run(
    `UPDATE properties SET name=?, address=?, city=?, state=?, zip=?, units=?, buildings=?, property_type=?, service_nights=?, service_window=?, services=?, access_notes=?, onsite_contact=? WHERE id = ?`,
    p.name, p.address, p.city, p.state, p.zip, p.units, p.buildings, p.property_type, p.service_nights, p.service_window, p.services, p.access_notes, p.onsite_contact, existing.id
  );
  res.flash('success', 'Property details saved.');
  res.redirect('/portal/properties');
});

router.get('/account', (req, res) => {
  const org = get('SELECT * FROM organizations WHERE id = ?', req.user.org_id);
  const team = all("SELECT id, name, title, email, phone, created_at FROM users WHERE org_id = ? AND role = 'client' ORDER BY name", req.user.org_id);
  const invoices = all('SELECT * FROM invoices WHERE org_id = ? ORDER BY period DESC LIMIT 12', req.user.org_id);
  res.render('portal/account', { title: 'Account', org, team, invoices, tab: req.query.tab || 'profile' });
});

router.post('/account/profile', (req, res) => {
  const name = clean(req.body.name, 120);
  if (!name) {
    res.flash('error', 'Name is required.');
    return res.redirect('/portal/account');
  }
  run('UPDATE users SET name = ?, title = ?, phone = ? WHERE id = ?', name, clean(req.body.title, 120), clean(req.body.phone, 40), req.user.id);
  res.flash('success', 'Your profile was updated.');
  res.redirect('/portal/account');
});

router.post('/account/organization', (req, res) => {
  const name = clean(req.body.name, 160);
  if (!name) {
    res.flash('error', 'Company name is required.');
    return res.redirect('/portal/account?tab=company');
  }
  run('UPDATE organizations SET name = ?, billing_email = ?, phone = ?, address = ? WHERE id = ?', name, clean(req.body.billing_email, 160), clean(req.body.phone, 40), clean(req.body.address, 240), req.user.org_id);
  res.flash('success', 'Company details saved.');
  res.redirect('/portal/account?tab=company');
});

router.post('/account/password', (req, res) => {
  const row = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  const next = String(req.body.new_password || '');
  if (!verifyPassword(String(req.body.current_password || ''), row.password_hash)) res.flash('error', 'Your current password was incorrect.');
  else if (next.length < 8) res.flash('error', 'New password must be at least 8 characters.');
  else if (next !== req.body.confirm_password) res.flash('error', 'New passwords did not match.');
  else {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
    res.flash('success', 'Password changed.');
  }
  res.redirect('/portal/account?tab=security');
});

router.post('/account/team', (req, res) => {
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 160).toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
    res.flash('error', 'Enter a name and valid email for your teammate.');
  } else if (get('SELECT id FROM users WHERE email = ?', email)) {
    res.flash('error', 'Someone already uses that email address.');
  } else {
    const temp = crypto.randomBytes(5).toString('hex');
    const { lastInsertRowid } = run(
      "INSERT INTO users (name, title, email, phone, password_hash, role, org_id) VALUES (?, ?, ?, ?, ?, 'client', ?)",
      name, clean(req.body.title, 120), email, clean(req.body.phone, 40), hashPassword(temp), req.user.org_id
    );
    notify(Number(lastInsertRowid), {
      title: `You've been invited to ${req.user.org_name}'s Valor Valet portal`,
      body: `${req.user.name} added you. Sign in with ${email} and temporary password ${temp}, then change it under Account > Security.`,
      link: '/login',
    });
    res.flash('success', `${name} was invited. Temporary password: ${temp} (also emailed).`);
  }
  res.redirect('/portal/account?tab=team');
});

module.exports = router;
