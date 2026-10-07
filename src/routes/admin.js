const express = require('express');
const crypto = require('node:crypto');
const { all, get, run } = require('../db');
const { requireRole, hashPassword } = require('../auth');
const { clean, toInt, toArray, isoDate, addDays, startOfWeek, isValidDate, parseDate, serviceLabel } = require('../helpers');
const { SERVICE_TYPES, STATUSES, NIGHTS, CONTRACTOR_STATUSES } = require('../constants');
const { getJob, listJobs, createJob, updateJob, dispatchJob, dispatchDay, setJobStatus, setRequestStatus, logActivity, releaseJob } = require('../jobs');
const { notify } = require('../notify');

const router = express.Router();
router.use(requireRole('admin'));

const crew = () => ({
  supervisors: all("SELECT id, name, phone FROM users WHERE role = 'supervisor' AND active = 1 ORDER BY name"),
  technicians: all("SELECT id, name, phone FROM users WHERE role = 'technician' AND active = 1 ORDER BY name"),
});

const REQUEST_SELECT = `
  SELECT r.*, p.name AS property_name, p.address, p.city, p.state, p.units, o.name AS org_name, u.name AS requester_name, u.email AS requester_email, u.phone AS requester_phone,
         (SELECT COUNT(*) FROM jobs j WHERE j.request_id = r.id AND j.status != 'cancelled') AS job_count
    FROM service_requests r
    JOIN properties p ON p.id = r.property_id
    JOIN organizations o ON o.id = r.org_id
    LEFT JOIN users u ON u.id = r.requested_by`;

router.get('/', (req, res) => {
  const today = isoDate();
  const queue = all(`${REQUEST_SELECT} WHERE r.status = 'submitted' ORDER BY CASE r.priority WHEN 'urgent' THEN 0 ELSE 1 END, r.created_at`);
  const todayJobs = listJobs("j.scheduled_date = ? AND j.status != 'cancelled'", today);
  const tomorrowJobs = listJobs("j.scheduled_date = ? AND j.status != 'cancelled'", addDays(today, 1));
  const weekStart = startOfWeek(today);
  const stats = {
    queue: queue.length,
    urgent: queue.filter((q) => q.priority === 'urgent').length,
    today: todayJobs.length,
    undispatchedToday: todayJobs.filter((j) => j.status === 'scheduled' && !(j.open_to_contractors && !j.claimed_by)).length,
    completedWeek: get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'completed' AND scheduled_date BETWEEN ? AND ?", weekStart, addDays(weekStart, 6)).n,
    doors: get("SELECT COALESCE(SUM(p.units),0) AS n FROM properties p JOIN organizations o ON o.id = p.org_id WHERE o.status = 'active'").n,
    clients: get("SELECT COUNT(*) AS n FROM organizations WHERE status = 'active'").n,
    newLeads: get("SELECT COUNT(*) AS n FROM leads WHERE status = 'new'").n,
  };
  const loads = all(
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM jobs j WHERE j.supervisor_id = s.id AND j.scheduled_date = ? AND j.status != 'cancelled') AS today_count,
            (SELECT COUNT(*) FROM jobs j WHERE j.supervisor_id = s.id AND j.scheduled_date BETWEEN ? AND ? AND j.status != 'cancelled') AS week_count
       FROM users s WHERE s.role = 'supervisor' AND s.active = 1 ORDER BY s.name`,
    today, weekStart, addDays(weekStart, 6)
  );
  res.render('admin/dashboard', { title: 'Operations Dashboard', queue, todayJobs, tomorrowJobs, stats, loads, today });
});

router.get('/requests', (req, res) => {
  const status = STATUSES[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'open';
  const type = SERVICE_TYPES[req.query.type] ? req.query.type : '';
  const q = clean(req.query.q, 80);
  const where = [];
  const params = [];
  if (status === 'open') where.push("r.status NOT IN ('completed','cancelled')");
  else if (status !== 'all') {
    where.push('r.status = ?');
    params.push(status);
  }
  if (type) {
    where.push('r.type = ?');
    params.push(type);
  }
  if (q) {
    where.push('(p.name LIKE ? OR o.name LIKE ? OR r.description LIKE ? OR r.id = ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, toInt(q) || -1);
  }
  const requests = all(`${REQUEST_SELECT} WHERE ${where.join(' AND ') || '1=1'} ORDER BY CASE r.status WHEN 'submitted' THEN 0 ELSE 1 END, CASE r.priority WHEN 'urgent' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 200`, ...params);
  res.render('admin/requests', { title: 'Service Requests', requests, status, type, q });
});

function loadRequest(req, res) {
  const r = get(`${REQUEST_SELECT} WHERE r.id = ?`, toInt(req.params.id));
  if (!r) res.status(404).render('shared/error', { title: 'Request not found', message: 'That request does not exist.' });
  return r;
}

router.get('/requests/:id', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  const property = get('SELECT * FROM properties WHERE id = ?', r.property_id);
  const activity = all('SELECT a.*, u.name AS user_name, u.role AS user_role FROM request_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.request_id = ? ORDER BY a.id', r.id);
  const jobs = listJobs('j.request_id = ?', r.id);
  const defaultDate = r.preferred_date && r.preferred_date >= isoDate() ? r.preferred_date : r.priority === 'urgent' ? isoDate() : addDays(isoDate(), 1);
  const sameDay = listJobs("j.scheduled_date = ? AND j.status != 'cancelled'", defaultDate);
  res.render('admin/request-detail', { title: `Request #${r.id}`, r, property, activity, jobs, defaultDate, sameDay, ...crew() });
});

function jobFormData(body) {
  return {
    title: clean(body.title, 160),
    scheduled_date: clean(body.scheduled_date, 10),
    start_time: clean(body.start_time, 5),
    end_time: clean(body.end_time, 5),
    supervisor_id: toInt(body.supervisor_id),
    technician_ids: toArray(body.technician_ids).map(toInt).filter(Boolean),
    instructions: clean(body.instructions, 1500),
    open_to_contractors: body.open_to_contractors === '1',
    pay_cents: Number.isFinite(parseFloat(body.pay)) ? Math.round(parseFloat(body.pay) * 100) : null,
  };
}

function validateJob(d) {
  const errors = [];
  if (!d.title) errors.push('Give the job a short title.');
  if (!isValidDate(d.scheduled_date)) errors.push('Choose a valid service date.');
  if (d.start_time && d.end_time && d.end_time <= d.start_time) errors.push('End time must be after the start time.');
  if (!d.open_to_contractors && !d.supervisor_id) errors.push('Assign a field supervisor, or post the job on the contractor board.');
  if (d.open_to_contractors && !(d.pay_cents > 0)) errors.push('Set a contractor payout greater than zero.');
  return errors;
}

router.post('/requests/:id/schedule', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  const data = { ...jobFormData(req.body), request_id: r.id, property_id: r.property_id, type: r.type };
  const errors = validateJob(data);
  if (errors.length) {
    res.flash('error', errors.join(' '));
    return res.redirect(`/admin/requests/${r.id}#schedule`);
  }
  const jobId = createJob(data, req.user.id);
  const sendCrew = req.body.dispatch_now && !(data.open_to_contractors && !data.technician_ids.length);
  if (sendCrew) dispatchJob(jobId, req.user.id);
  res.flash('success', data.open_to_contractors ? 'Job posted on the contractor board.' : `Job scheduled${sendCrew ? ' and sent to the crew' : ''}.`);
  res.redirect(`/admin/requests/${r.id}`);
});

router.post('/requests/:id/comment', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  const message = clean(req.body.message, 1500);
  if (message) {
    logActivity(r.id, req.user.id, message, 'comment');
    if (r.requested_by) notify(r.requested_by, { title: `Update on request #${r.id}`, body: message, link: `/portal/requests/${r.id}` });
  }
  res.redirect(`/admin/requests/${r.id}#activity`);
});

router.post('/requests/:id/status', (req, res) => {
  const r = loadRequest(req, res);
  if (!r) return;
  const status = req.body.status;
  if (['cancelled', 'completed', 'submitted'].includes(status)) {
    if (status === 'cancelled') for (const j of all("SELECT id FROM jobs WHERE request_id = ? AND status NOT IN ('completed','cancelled')", r.id)) setJobStatus(j.id, 'cancelled', req.user.id);
    setRequestStatus(r.id, status, req.user.id, clean(req.body.note, 500) || undefined);
    res.flash('success', `Request marked ${STATUSES[status].label.toLowerCase()}.`);
  }
  res.redirect(`/admin/requests/${r.id}`);
});

router.get('/schedule', (req, res) => {
  const start = startOfWeek(isValidDate(req.query.start) ? req.query.start : isoDate());
  const supervisorId = toInt(req.query.supervisor);
  const params = [start, addDays(start, 6)];
  let where = "j.scheduled_date BETWEEN ? AND ? AND j.status != 'cancelled'";
  if (supervisorId) {
    where += ' AND j.supervisor_id = ?';
    params.push(supervisorId);
  }
  const jobs = listJobs(where, ...params);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    const dayJobs = jobs.filter((j) => j.scheduled_date === date);
    return { date, jobs: dayJobs, pending: dayJobs.filter((j) => j.status === 'scheduled').length };
  });
  res.render('admin/schedule', { title: 'Schedule', days, start, supervisorId, today: isoDate(), prev: addDays(start, -7), next: addDays(start, 7), ...crew() });
});

router.get('/schedule/day', (req, res) => {
  const date = isValidDate(req.query.date) ? req.query.date : isoDate();
  const jobs = listJobs("j.scheduled_date = ? AND j.status != 'cancelled'", date);
  const bySupervisor = {};
  for (const j of jobs) {
    const key = j.supervisor_name || 'Unassigned';
    (bySupervisor[key] = bySupervisor[key] || { phone: j.supervisor_phone, jobs: [] }).jobs.push(j);
  }
  res.render('admin/run-sheet', { title: `Run Sheet — ${date}`, date, bySupervisor, jobs, prev: addDays(date, -1), next: addDays(date, 1) });
});

router.post('/schedule/dispatch', (req, res) => {
  const date = isValidDate(req.body.date) ? req.body.date : isoDate();
  const count = dispatchDay(date, req.user.id);
  res.flash(count ? 'success' : 'info', count ? `${count} job${count === 1 ? '' : 's'} forwarded to supervisors and technicians.` : 'Every job on that day was already dispatched.');
  res.redirect(req.body.return_to && String(req.body.return_to).startsWith('/admin') ? req.body.return_to : `/admin/schedule?start=${startOfWeek(date)}`);
});

router.get('/jobs/new', (req, res) => {
  const properties = all('SELECT p.*, o.name AS org_name FROM properties p JOIN organizations o ON o.id = p.org_id ORDER BY o.name, p.name');
  const date = isValidDate(req.query.date) ? req.query.date : isoDate();
  res.render('admin/job-new', {
    title: 'Create Job',
    properties,
    form: { property_id: toInt(req.query.property), type: 'valet_trash', scheduled_date: date, start_time: '20:00', end_time: '22:00', repeat_until: '', repeat_nights: [] },
    ...crew(),
  });
});

router.post('/jobs', (req, res) => {
  const properties = all('SELECT p.*, o.name AS org_name FROM properties p JOIN organizations o ON o.id = p.org_id ORDER BY o.name, p.name');
  const data = { ...jobFormData(req.body), property_id: toInt(req.body.property_id), type: SERVICE_TYPES[req.body.type] ? req.body.type : 'other' };
  const repeatUntil = clean(req.body.repeat_until, 10);
  const repeatNights = toArray(req.body.repeat_nights).filter((n) => NIGHTS.includes(n));
  const errors = validateJob(data);
  if (!properties.find((p) => p.id === data.property_id)) errors.push('Choose a property.');
  if (repeatUntil && (!isValidDate(repeatUntil) || repeatUntil < data.scheduled_date)) errors.push('"Repeat until" must be on or after the first service date.');
  if (repeatUntil && repeatUntil > addDays(data.scheduled_date, 92)) errors.push('Recurring jobs can be generated up to 13 weeks at a time.');
  if (errors.length) {
    return res.status(422).render('admin/job-new', { title: 'Create Job', properties, form: { ...data, repeat_until: repeatUntil, repeat_nights: repeatNights }, errors, ...crew() });
  }
  const dates = [];
  if (repeatUntil && repeatNights.length) {
    for (let d = data.scheduled_date; d <= repeatUntil; d = addDays(d, 1)) if (repeatNights.includes(NIGHTS[parseDate(d).getDay()])) dates.push(d);
  } else dates.push(data.scheduled_date);
  const ids = dates.map((d) => createJob({ ...data, scheduled_date: d }, req.user.id));
  const sendCrew = req.body.dispatch_now && !(data.open_to_contractors && !data.technician_ids.length);
  if (sendCrew) ids.forEach((id) => dispatchJob(id, req.user.id));
  const where = data.open_to_contractors ? ' and posted on the contractor job board' : sendCrew ? ' and dispatched' : '';
  res.flash('success', `${ids.length} job${ids.length === 1 ? '' : 's'} created${where}.`);
  res.redirect(ids.length === 1 ? `/admin/jobs/${ids[0]}` : `/admin/schedule?start=${startOfWeek(data.scheduled_date)}`);
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(toInt(req.params.id));
  if (!job) return res.status(404).render('shared/error', { title: 'Job not found', message: 'That job does not exist.' });
  res.render('admin/job-detail', { title: `Job #${job.id}`, job, ...crew() });
});

router.post('/jobs/:id', (req, res) => {
  const job = getJob(toInt(req.params.id));
  if (!job) return res.redirect('/admin/schedule');
  const data = jobFormData(req.body);
  const errors = validateJob(data);
  if (errors.length) {
    res.flash('error', errors.join(' '));
    return res.redirect(`/admin/jobs/${job.id}`);
  }
  updateJob(job.id, data, req.user.id);
  res.flash('success', job.dispatched_at ? 'Job updated and the crew was re-notified.' : 'Job updated.');
  res.redirect(`/admin/jobs/${job.id}`);
});

router.post('/jobs/:id/dispatch', (req, res) => {
  const ok = dispatchJob(toInt(req.params.id), req.user.id);
  res.flash(ok ? 'success' : 'error', ok ? 'Assignment forwarded to the supervisor and technicians.' : 'This job cannot be dispatched.');
  res.redirect(`/admin/jobs/${req.params.id}`);
});

router.post('/jobs/:id/status', (req, res) => {
  const status = req.body.status;
  if (['in_progress', 'completed', 'cancelled', 'scheduled'].includes(status)) setJobStatus(toInt(req.params.id), status, req.user.id, clean(req.body.notes, 1000));
  res.flash('success', `Job marked ${STATUSES[status] ? STATUSES[status].label.toLowerCase() : 'updated'}.`);
  res.redirect(`/admin/jobs/${req.params.id}`);
});

router.get('/clients', (req, res) => {
  const clients = all(
    `SELECT o.*,
            (SELECT COUNT(*) FROM properties p WHERE p.org_id = o.id) AS property_count,
            (SELECT COALESCE(SUM(units),0) FROM properties p WHERE p.org_id = o.id) AS doors,
            (SELECT COUNT(*) FROM service_requests r WHERE r.org_id = o.id AND r.status NOT IN ('completed','cancelled')) AS open_requests,
            (SELECT name FROM users u WHERE u.org_id = o.id ORDER BY u.id LIMIT 1) AS primary_contact
       FROM organizations o ORDER BY o.name`
  );
  res.render('admin/clients', { title: 'Clients', clients });
});

router.get('/clients/:id', (req, res) => {
  const org = get('SELECT * FROM organizations WHERE id = ?', toInt(req.params.id));
  if (!org) return res.redirect('/admin/clients');
  const properties = all('SELECT * FROM properties WHERE org_id = ? ORDER BY name', org.id);
  const contacts = all("SELECT * FROM users WHERE org_id = ? AND role = 'client' ORDER BY name", org.id);
  const requests = all(`${REQUEST_SELECT} WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT 25`, org.id);
  const invoices = all('SELECT * FROM invoices WHERE org_id = ? ORDER BY period DESC', org.id);
  res.render('admin/client-detail', { title: org.name, org, properties, contacts, requests, invoices });
});

router.post('/clients/:id', (req, res) => {
  const status = ['active', 'paused', 'prospect'].includes(req.body.status) ? req.body.status : 'active';
  run('UPDATE organizations SET plan = ?, status = ? WHERE id = ?', clean(req.body.plan, 80), status, toInt(req.params.id));
  res.flash('success', 'Client account updated.');
  res.redirect(`/admin/clients/${req.params.id}`);
});

router.post('/clients/:id/invoices', (req, res) => {
  const orgId = toInt(req.params.id);
  const amount = Math.round(parseFloat(req.body.amount) * 100);
  const period = clean(req.body.period, 7);
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}$/.test(period)) {
    res.flash('error', 'Enter a billing month and a positive amount.');
  } else {
    const n = get('SELECT COUNT(*) AS n FROM invoices').n + 1001;
    run('INSERT INTO invoices (org_id, number, period, amount_cents, due_date) VALUES (?, ?, ?, ?, ?)', orgId, `VV-${n}`, period, amount, addDays(isoDate(), 30));
    for (const c of all("SELECT id FROM users WHERE org_id = ? AND role = 'client'", orgId)) {
      notify(c.id, { title: `New invoice VV-${n}`, body: `Invoice for ${period} is available in your portal.`, link: '/portal/account?tab=billing' });
    }
    res.flash('success', `Invoice VV-${n} created.`);
  }
  res.redirect(`/admin/clients/${orgId}#billing`);
});

router.post('/invoices/:id/paid', (req, res) => {
  const inv = get('SELECT * FROM invoices WHERE id = ?', toInt(req.params.id));
  if (inv) run("UPDATE invoices SET status = 'paid' WHERE id = ?", inv.id);
  res.redirect(inv ? `/admin/clients/${inv.org_id}#billing` : '/admin/clients');
});

router.get('/team', (req, res) => {
  const today = isoDate();
  const members = all(
    `SELECT u.*,
            (SELECT COUNT(*) FROM jobs j LEFT JOIN job_technicians jt ON jt.job_id = j.id
              WHERE (j.supervisor_id = u.id OR jt.user_id = u.id) AND j.scheduled_date >= ? AND j.status NOT IN ('completed','cancelled')) AS upcoming
       FROM users u WHERE u.role IN ('admin','supervisor','technician') ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, u.name`,
    today
  );
  res.render('admin/team', { title: 'Fulfillment Team', members });
});

router.post('/team', (req, res) => {
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 160).toLowerCase();
  const role = ['supervisor', 'technician', 'admin'].includes(req.body.role) ? req.body.role : 'technician';
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) res.flash('error', 'Enter a name and valid email.');
  else if (get('SELECT id FROM users WHERE email = ?', email)) res.flash('error', 'That email is already in use.');
  else {
    const temp = crypto.randomBytes(5).toString('hex');
    const { lastInsertRowid } = run(
      'INSERT INTO users (name, email, phone, title, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
      name, email, clean(req.body.phone, 40), clean(req.body.title, 120), role, hashPassword(temp)
    );
    notify(Number(lastInsertRowid), { title: 'Welcome to the Valor Valet crew', body: `Sign in with ${email} and temporary password ${temp}.`, link: '/login' });
    res.flash('success', `${name} added. Temporary password: ${temp} (also emailed).`);
  }
  res.redirect('/admin/team');
});

router.post('/team/:id/toggle', (req, res) => {
  const id = toInt(req.params.id);
  if (id !== req.user.id) run('UPDATE users SET active = 1 - active WHERE id = ?', id);
  res.redirect('/admin/team');
});

router.get('/leads', (req, res) => {
  res.render('admin/leads', { title: 'Quote Requests', leads: all('SELECT * FROM leads ORDER BY id DESC') });
});

router.post('/leads/:id/status', (req, res) => {
  const status = ['new', 'contacted', 'won', 'lost'].includes(req.body.status) ? req.body.status : 'new';
  run('UPDATE leads SET status = ? WHERE id = ?', status, toInt(req.params.id));
  res.redirect('/admin/leads');
});

router.get('/outbox', (req, res) => {
  res.render('admin/outbox', { title: 'Email Log', emails: all('SELECT * FROM outbox ORDER BY id DESC LIMIT 200') });
});

const CONTRACTOR_LIST = `
  SELECT u.id, u.name, u.email, u.phone, u.active, u.created_at, c.*,
         (SELECT COUNT(*) FROM jobs j WHERE j.claimed_by = u.id AND j.status NOT IN ('completed','cancelled')) AS active_gigs,
         (SELECT COALESCE(SUM(pay_cents),0) FROM jobs j WHERE j.claimed_by = u.id AND j.status = 'completed' AND j.payout_status = 'unpaid') AS unpaid_cents
    FROM contractor_profiles c JOIN users u ON u.id = c.user_id`;

router.get('/contractors', (req, res) => {
  const status = CONTRACTOR_STATUSES[req.query.status] ? req.query.status : 'submitted';
  const people = all(`${CONTRACTOR_LIST} WHERE c.status = ? ORDER BY c.created_at`, status);
  const counts = all('SELECT status, COUNT(*) AS n FROM contractor_profiles GROUP BY status');
  res.render('admin/contractors', { title: '1099 Contractors', people, status, counts });
});

router.get('/contractors/:id', (req, res) => {
  const person = get(`${CONTRACTOR_LIST} WHERE u.id = ?`, toInt(req.params.id));
  if (!person) return res.redirect('/admin/contractors');
  const gigs = listJobs('j.claimed_by = ?', person.id);
  res.render('admin/contractor-detail', { title: person.name, person, gigs });
});

router.post('/contractors/:id/review', (req, res) => {
  const person = get('SELECT u.id, u.name, c.status FROM users u JOIN contractor_profiles c ON c.user_id = u.id WHERE u.id = ? AND u.role = ?', toInt(req.params.id), 'contractor');
  if (!person) return res.redirect('/admin/contractors');
  const status = CONTRACTOR_STATUSES[req.body.status] ? req.body.status : person.status;
  const note = clean(req.body.review_note, 1000);
  run("UPDATE contractor_profiles SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE user_id = ?", status, note || null, person.id);
  if (status === 'approved') run("UPDATE users SET title = '1099 Contractor', active = 1 WHERE id = ?", person.id);
  const messages = {
    approved: 'You are approved. Open the job board and claim a gig.',
    needs_info: note || 'We need a bit more information. Update your profile and send it back.',
    declined: note || 'We are not able to approve this application right now.',
    suspended: note || 'Your contractor account is suspended. Contact dispatch with questions.',
  };
  notify(person.id, { title: `Contractor application: ${CONTRACTOR_STATUSES[status].label}`, body: messages[status] || note, link: status === 'approved' ? '/work' : '/work/profile' });
  res.flash('success', `${person.name} marked ${CONTRACTOR_STATUSES[status].label.toLowerCase()}.`);
  res.redirect(`/admin/contractors/${person.id}`);
});

router.post('/jobs/:id/release', (req, res) => {
  const ok = releaseJob(toInt(req.params.id), req.user.id, { admin: true });
  res.flash(ok ? 'success' : 'error', ok ? 'Gig returned to the job board.' : 'This gig is not claimed, or work has already started.');
  res.redirect(`/admin/jobs/${req.params.id}`);
});

router.post('/jobs/:id/payout', (req, res) => {
  const job = get("SELECT id, claimed_by, title, pay_cents FROM jobs WHERE id = ? AND status = 'completed'", toInt(req.params.id));
  if (job) {
    run("UPDATE jobs SET payout_status = 'paid' WHERE id = ?", job.id);
    if (job.claimed_by) notify(job.claimed_by, { title: `Payout sent for ${job.title}`, body: 'This gig is marked paid on your earnings page.', link: '/work/earnings', email: false });
  }
  res.redirect(`/admin/jobs/${req.params.id}`);
});

module.exports = router;
