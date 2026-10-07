const express = require('express');
const { all, get, run } = require('../db');
const { requireRole, hashPassword, createSession, homeFor } = require('../auth');
const { clean, toInt, toArray, isoDate, isValidDate, parseDate, serviceLabel } = require('../helpers');
const { SERVICE_TYPES, NIGHTS, TAX_CLASSES, GIG_PAY } = require('../constants');
const { getJob, listJobs, listOpenGigs, claimJob, releaseJob, setJobStatus } = require('../jobs');
const { notify, notifyRole } = require('../notify');

const router = express.Router();

const GIG_TYPES = Object.keys(SERVICE_TYPES).filter((k) => k !== 'other');

function digits(value, length) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length === length ? d : '';
}

function isAdult(dob) {
  if (!isValidDate(dob)) return false;
  const born = parseDate(dob);
  const now = new Date();
  const limit = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate());
  return born <= limit;
}

function applicationFrom(body) {
  return {
    name: clean(body.name, 120),
    email: clean(body.email, 160).toLowerCase(),
    phone: clean(body.phone, 40),
    city: clean(body.city, 80),
    state: clean(body.state, 2).toUpperCase(),
    zip: clean(body.zip, 10),
    service_radius: toInt(body.service_radius) || 15,
    services: toArray(body.services).filter((s) => SERVICE_TYPES[s]),
    nights: toArray(body.nights).filter((n) => NIGHTS.includes(n)),
    has_vehicle: body.has_vehicle === '1' ? 1 : 0,
    vehicle: clean(body.vehicle, 160),
    can_lift: body.can_lift === '1' ? 1 : 0,
    tax_class: TAX_CLASSES[body.tax_class] ? body.tax_class : 'individual',
    legal_name: clean(body.legal_name, 160),
    business_name: clean(body.business_name, 160),
    tin_last4: digits(body.tin_last4, 4),
    payout_method: body.payout_method === 'check' ? 'check' : 'direct_deposit',
    bank_name: clean(body.bank_name, 80),
    account_last4: digits(body.account_last4, 4),
    date_of_birth: clean(body.date_of_birth, 10),
    ack_1099: body.ack_1099 === '1' ? 1 : 0,
    ack_work_auth: body.ack_work_auth === '1' ? 1 : 0,
    ack_background: body.ack_background === '1' ? 1 : 0,
  };
}

function applicationErrors(form, { password = '', emailTaken = false } = {}) {
  const errors = [];
  if (!form.name) errors.push('Enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(form.email)) errors.push('Enter a valid email address.');
  if (emailTaken) errors.push('An account with that email already exists. Sign in instead.');
  if (password !== null && password.length < 8) errors.push('Password must be at least 8 characters.');
  if (!form.phone) errors.push('Enter a mobile phone number.');
  if (!form.city || form.state.length !== 2) errors.push('Enter the city and state where you want to work.');
  if (!form.services.length) errors.push('Choose at least one service you can do.');
  if (!form.nights.length) errors.push('Choose at least one day you are available.');
  if (!isAdult(form.date_of_birth)) errors.push('You must be 18 or older. Check the date of birth.');
  if (!form.legal_name) errors.push('Enter the legal name you use for taxes.');
  if (!form.tin_last4) errors.push('Enter only the last 4 digits of your SSN or EIN.');
  if (form.payout_method === 'direct_deposit' && !form.account_last4) errors.push('Enter the last 4 digits of the bank account for payouts.');
  if (!form.ack_work_auth) errors.push('Confirm that you are authorized to work in the United States.');
  if (!form.ack_1099) errors.push('Confirm that you are applying as an independent contractor.');
  if (!form.ack_background) errors.push('Consent to a background check to continue.');
  return errors;
}

function saveProfile(userId, form, status) {
  const existing = get('SELECT user_id FROM contractor_profiles WHERE user_id = ?', userId);
  const values = [
    form.city, form.state, form.zip, form.service_radius, form.services.join(','), form.nights.join(','),
    form.has_vehicle, form.vehicle, form.can_lift, form.tax_class, form.legal_name, form.business_name,
    form.tin_last4, form.payout_method, form.bank_name, form.account_last4, form.date_of_birth,
    form.ack_1099, form.ack_work_auth, form.ack_background, status,
  ];
  if (existing) {
    run(
      `UPDATE contractor_profiles SET city=?, state=?, zip=?, service_radius=?, services=?, nights=?, has_vehicle=?, vehicle=?, can_lift=?,
        tax_class=?, legal_name=?, business_name=?, tin_last4=?, payout_method=?, bank_name=?, account_last4=?, date_of_birth=?,
        ack_1099=?, ack_work_auth=?, ack_background=?, status=?, review_note=NULL, reviewed_at=NULL WHERE user_id=?`,
      ...values, userId
    );
  } else {
    run(
      `INSERT INTO contractor_profiles (city, state, zip, service_radius, services, nights, has_vehicle, vehicle, can_lift,
        tax_class, legal_name, business_name, tin_last4, payout_method, bank_name, account_last4, date_of_birth,
        ack_1099, ack_work_auth, ack_background, status, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values, userId
    );
  }
}

router.get('/join', (req, res) => {
  if (req.user && req.user.role === 'contractor') return res.redirect('/work');
  res.render('work/join', { title: 'Work with Valor Valet', form: { services: ['valet_trash'], nights: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'], service_radius: 15, tax_class: 'individual', payout_method: 'direct_deposit', state: 'TX' } });
});

router.post('/join', (req, res) => {
  if (req.user) {
    res.flash('info', 'Sign out before starting a contractor application.');
    return res.redirect(homeFor(req.user));
  }
  const form = applicationFrom(req.body);
  const password = String(req.body.password || '');
  const emailTaken = !!(form.email && get('SELECT id FROM users WHERE email = ?', form.email));
  const errors = applicationErrors(form, { password, emailTaken });
  if (errors.length) return res.status(422).render('work/join', { title: 'Work with Valor Valet', form, errors });

  const userId = Number(
    run(
      "INSERT INTO users (name, email, phone, password_hash, role, title) VALUES (?, ?, ?, ?, 'contractor', '1099 applicant')",
      form.name, form.email, form.phone, hashPassword(password)
    ).lastInsertRowid
  );
  saveProfile(userId, form, 'submitted');
  notifyRole('admin', {
    title: `New 1099 application: ${form.name}`,
    body: `${form.city}, ${form.state}. Services: ${form.services.map(serviceLabel).join(', ')}`,
    link: `/admin/contractors/${userId}`,
  });
  createSession(res, userId);
  res.flash('success', 'Application received. You can claim gigs as soon as we approve you, usually within one business day.');
  res.redirect('/work');
});

const portal = express.Router();
portal.use(requireRole('contractor'));

function loadProfile(req, res, next) {
  req.profile = get('SELECT * FROM contractor_profiles WHERE user_id = ?', req.user.id);
  if (!req.profile) return res.redirect('/join');
  res.locals.profile = req.profile;
  next();
}
portal.use(loadProfile);

portal.get('/', (req, res) => {
  const approved = req.profile.status === 'approved';
  const open = approved ? listOpenGigs(req.profile) : [];
  const mine = listJobs('j.claimed_by = ? AND j.status != ?', req.user.id, 'cancelled');
  const today = isoDate();
  const upcoming = mine.filter((j) => j.status !== 'completed' && j.scheduled_date >= today);
  const earnings = get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'completed' AND payout_status = 'unpaid' THEN pay_cents END), 0) AS unpaid,
       COALESCE(SUM(CASE WHEN status = 'completed' AND payout_status = 'paid' THEN pay_cents END), 0) AS paid,
       COALESCE(SUM(CASE WHEN status NOT IN ('completed','cancelled') THEN pay_cents END), 0) AS pending
     FROM jobs WHERE claimed_by = ?`,
    req.user.id
  );
  res.render('work/dashboard', { title: 'Contractor home', open, upcoming, earnings, today });
});

portal.get('/earnings', (req, res) => {
  const jobs = all(
    `SELECT j.id, j.title, j.scheduled_date, j.status, j.pay_cents, j.payout_status, j.completed_at, p.name AS property_name, p.city
       FROM jobs j JOIN properties p ON p.id = j.property_id
      WHERE j.claimed_by = ? AND j.status = 'completed'
      ORDER BY j.scheduled_date DESC`,
    req.user.id
  );
  const totals = get(
    `SELECT
       COALESCE(SUM(CASE WHEN payout_status = 'unpaid' THEN pay_cents END), 0) AS unpaid,
       COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN pay_cents END), 0) AS paid
     FROM jobs WHERE claimed_by = ? AND status = 'completed'`,
    req.user.id
  );
  res.render('work/earnings', { title: 'Earnings', jobs, totals });
});

portal.get('/profile', (req, res) => {
  const p = req.profile;
  res.render('work/profile', {
    title: 'Contractor profile',
    form: { ...p, name: req.user.name, email: req.user.email, phone: req.user.phone, services: String(p.services || '').split(','), nights: String(p.nights || '').split(',') },
  });
});

portal.post('/profile', (req, res) => {
  const form = applicationFrom({ ...req.body, email: req.user.email });
  const errors = applicationErrors(form, { password: null });
  if (errors.length) {
    return res.status(422).render('work/profile', { title: 'Contractor profile', form: { ...form, email: req.user.email }, errors });
  }
  const resubmit = ['needs_info', 'declined'].includes(req.profile.status);
  run('UPDATE users SET name = ?, phone = ? WHERE id = ?', form.name, form.phone, req.user.id);
  saveProfile(req.user.id, form, resubmit ? 'submitted' : req.profile.status);
  if (resubmit) {
    notifyRole('admin', { title: `${form.name} updated their contractor application`, body: 'Ready for another review.', link: `/admin/contractors/${req.user.id}` });
    res.flash('success', 'Profile saved and sent back for review.');
  } else res.flash('success', 'Profile saved.');
  res.redirect('/work/profile');
});

function loadGig(req, res) {
  const job = getJob(toInt(req.params.id));
  if (!job || (!job.open_to_contractors && job.claimed_by !== req.user.id)) {
    res.status(404).render('shared/error', { title: 'Gig not found', message: 'That gig is not on the job board.' });
    return null;
  }
  return job;
}

portal.get('/jobs/:id', (req, res) => {
  const job = loadGig(req, res);
  if (!job) return;
  const mine = job.claimed_by === req.user.id;
  res.render('work/job', { title: job.title, job, mine, approved: req.profile.status === 'approved' });
});

portal.post('/jobs/:id/claim', (req, res) => {
  const result = claimJob(toInt(req.params.id), req.user.id);
  res.flash(result.ok ? 'success' : 'error', result.ok ? 'Gig claimed. It is now on your schedule.' : result.error);
  res.redirect(result.ok ? `/work/jobs/${req.params.id}` : '/work');
});

portal.post('/jobs/:id/release', (req, res) => {
  const ok = releaseJob(toInt(req.params.id), req.user.id);
  res.flash(ok ? 'info' : 'error', ok ? 'Gig released back to the job board.' : 'This gig can no longer be released.');
  res.redirect(ok ? '/work' : `/work/jobs/${req.params.id}`);
});

portal.post('/jobs/:id/status', (req, res) => {
  const job = loadGig(req, res);
  if (!job || job.claimed_by !== req.user.id) return res.redirect('/work');
  const status = req.body.status;
  if (!['in_progress', 'completed'].includes(status) || ['completed', 'cancelled'].includes(job.status)) {
    res.flash('error', 'That update is not available.');
    return res.redirect(`/work/jobs/${job.id}`);
  }
  const notes = clean(req.body.notes, 1000);
  setJobStatus(job.id, status, req.user.id, notes);
  res.flash('success', status === 'completed' ? `Marked complete. ${job.pay_cents ? 'Your payout is waiting on the earnings page.' : ''}` : 'Gig started.');
  res.redirect(status === 'completed' ? '/work/earnings' : `/work/jobs/${job.id}`);
});

router.use('/work', portal);
module.exports = router;
