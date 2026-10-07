const { all, get, run, transaction } = require('./db');
const { notify } = require('./notify');
const { fmtLongDate, fmtTime, serviceLabel, isoDate } = require('./helpers');
const { STATUSES } = require('./constants');

const JOB_SELECT = `
  SELECT j.*, p.name AS property_name, p.address, p.city, p.state, p.zip, p.units,
         p.access_notes, p.onsite_contact, p.org_id, o.name AS org_name,
         s.name AS supervisor_name, s.phone AS supervisor_phone,
         r.description AS request_description, r.location_details, r.quantity, r.priority,
         claimer.name AS claimed_name,
         (SELECT GROUP_CONCAT(u.name, ', ') FROM job_technicians jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = j.id) AS technician_names,
         (SELECT COUNT(*) FROM job_technicians jt WHERE jt.job_id = j.id) AS technician_count
    FROM jobs j
    JOIN properties p ON p.id = j.property_id
    JOIN organizations o ON o.id = p.org_id
    LEFT JOIN users s ON s.id = j.supervisor_id
    LEFT JOIN users claimer ON claimer.id = j.claimed_by
    LEFT JOIN service_requests r ON r.id = j.request_id`;

function getJob(id) {
  const job = get(`${JOB_SELECT} WHERE j.id = ?`, id);
  if (job) job.technicians = all('SELECT u.id, u.name, u.phone FROM job_technicians jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = ? ORDER BY u.name', id);
  return job;
}

function listJobs(where = '1=1', ...params) {
  return all(`${JOB_SELECT} WHERE ${where} ORDER BY j.scheduled_date, j.start_time, j.id`, ...params);
}

function logActivity(requestId, userId, message, kind = 'status') {
  if (!requestId) return;
  run('INSERT INTO request_activity (request_id, user_id, kind, message) VALUES (?, ?, ?, ?)', requestId, userId, kind, message);
}

function setRequestStatus(requestId, status, actorId, message) {
  if (!requestId) return;
  const req = get('SELECT * FROM service_requests WHERE id = ?', requestId);
  if (!req || req.status === status) return;
  run("UPDATE service_requests SET status = ?, updated_at = datetime('now') WHERE id = ?", status, requestId);
  logActivity(requestId, actorId, message || `Status changed to ${STATUSES[status].label}.`);
  if (req.requested_by) {
    notify(req.requested_by, {
      title: `Request #${requestId}: ${STATUSES[status].label}`,
      body: message || `Your ${serviceLabel(req.type)} request is now ${STATUSES[status].label.toLowerCase()}.`,
      link: `/portal/requests/${requestId}`,
    });
  }
}

function setTechnicians(jobId, techIds) {
  const claimed = get('SELECT claimed_by FROM jobs WHERE id = ?', jobId);
  run('DELETE FROM job_technicians WHERE job_id = ?', jobId);
  const ids = new Set(techIds);
  if (claimed && claimed.claimed_by) ids.add(claimed.claimed_by);
  for (const t of ids) run('INSERT OR IGNORE INTO job_technicians (job_id, user_id) VALUES (?, ?)', jobId, t);
}

function createJob(data, actorId) {
  return transaction(() => {
    const { lastInsertRowid } = run(
      `INSERT INTO jobs (request_id, property_id, type, title, scheduled_date, start_time, end_time, supervisor_id, instructions, open_to_contractors, pay_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.request_id || null,
      data.property_id,
      data.type,
      data.title,
      data.scheduled_date,
      data.start_time || null,
      data.end_time || null,
      data.supervisor_id || null,
      data.instructions || null,
      data.open_to_contractors ? 1 : 0,
      data.pay_cents || null
    );
    const jobId = Number(lastInsertRowid);
    setTechnicians(jobId, data.technician_ids || []);
    if (data.request_id) {
      const when = `${fmtLongDate(data.scheduled_date)}${data.start_time ? ` at ${fmtTime(data.start_time)}` : ''}`;
      setRequestStatus(data.request_id, 'scheduled', actorId, `Scheduled for ${when}.`);
    }
    return jobId;
  });
}

function updateJob(jobId, data, actorId) {
  const before = getJob(jobId);
  transaction(() => {
    run(
      `UPDATE jobs SET title = ?, scheduled_date = ?, start_time = ?, end_time = ?, supervisor_id = ?, instructions = ?, open_to_contractors = ?, pay_cents = ? WHERE id = ?`,
      data.title,
      data.scheduled_date,
      data.start_time || null,
      data.end_time || null,
      data.supervisor_id || null,
      data.instructions || null,
      data.open_to_contractors ? 1 : 0,
      data.pay_cents || null,
      jobId
    );
    setTechnicians(jobId, data.technician_ids || []);
  });
  const moved = before.scheduled_date !== data.scheduled_date || (before.start_time || '') !== (data.start_time || '');
  if (moved && before.request_id) {
    logActivity(before.request_id, actorId, `Rescheduled to ${fmtLongDate(data.scheduled_date)}${data.start_time ? ` at ${fmtTime(data.start_time)}` : ''}.`);
  }
  if (before.dispatched_at) dispatchJob(jobId, actorId, { updated: true });
}

function crewFor(job) {
  const ids = new Set(job.technicians.map((t) => t.id));
  if (job.supervisor_id) ids.add(job.supervisor_id);
  return [...ids];
}

function dispatchJob(jobId, actorId, { updated = false } = {}) {
  const job = getJob(jobId);
  if (!job || ['completed', 'cancelled'].includes(job.status)) return false;
  run("UPDATE jobs SET status = CASE WHEN status = 'scheduled' THEN 'dispatched' ELSE status END, dispatched_at = datetime('now') WHERE id = ?", jobId);
  const when = `${fmtLongDate(job.scheduled_date)}${job.start_time ? `, ${fmtTime(job.start_time)}` : ''}${job.end_time ? ` – ${fmtTime(job.end_time)}` : ''}`;
  const body = [
    `${job.title} — ${job.property_name}`,
    `When: ${when}`,
    `Where: ${job.address}, ${job.city}, ${job.state} ${job.zip}`,
    `Supervisor: ${job.supervisor_name || 'Unassigned'}`,
    `Crew: ${job.technician_names || 'Unassigned'}`,
    job.instructions ? `Instructions: ${job.instructions}` : null,
    job.access_notes ? `Access: ${job.access_notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  for (const userId of crewFor(job)) {
    const person = get('SELECT role FROM users WHERE id = ?', userId);
    notify(userId, {
      title: `${updated ? 'Updated assignment' : 'New assignment'}: ${job.property_name} (${fmtLongDate(job.scheduled_date)})`,
      body,
      link: person && person.role === 'contractor' ? `/work/jobs/${jobId}` : `/crew/jobs/${jobId}`,
    });
  }
  if (job.status === 'scheduled') setRequestStatus(job.request_id, 'dispatched', actorId, `Crew dispatched for ${when}. Supervisor: ${job.supervisor_name || 'TBD'}.`);
  return true;
}

function dispatchDay(date, actorId) {
  const jobs = all(
    "SELECT id FROM jobs WHERE scheduled_date = ? AND status = 'scheduled' AND NOT (open_to_contractors = 1 AND claimed_by IS NULL)",
    date
  );
  for (const j of jobs) dispatchJob(j.id, actorId);
  return jobs.length;
}

function listOpenGigs(profile) {
  const services = String(profile.services || '').split(',').filter(Boolean);
  if (!services.length) return [];
  const marks = services.map(() => '?').join(',');
  return all(
    `${JOB_SELECT}
      WHERE j.open_to_contractors = 1 AND j.claimed_by IS NULL AND j.status = 'scheduled'
        AND j.scheduled_date >= ? AND j.type IN (${marks}) AND p.state = ?
      ORDER BY CASE WHEN p.city = ? THEN 0 ELSE 1 END, j.scheduled_date, j.start_time, j.id`,
    isoDate(),
    ...services,
    profile.state,
    profile.city
  );
}

function claimJob(jobId, userId) {
  const profile = get('SELECT status, services FROM contractor_profiles WHERE user_id = ?', userId);
  if (!profile || profile.status !== 'approved') return { ok: false, error: 'Your application has to be approved before you can claim work.' };
  const job = get('SELECT id, type, status, open_to_contractors, claimed_by, request_id, property_id FROM jobs WHERE id = ?', jobId);
  if (!job || !job.open_to_contractors || job.status !== 'scheduled' || job.claimed_by) {
    return { ok: false, error: 'That gig is no longer available.' };
  }
  const services = String(profile.services || '').split(',');
  if (!services.includes(job.type)) return { ok: false, error: 'This gig is outside the services on your profile.' };
  const updated = transaction(() => {
    const result = run(
      `UPDATE jobs SET claimed_by = ?, claimed_at = datetime('now'), status = 'dispatched', dispatched_at = datetime('now')
        WHERE id = ? AND claimed_by IS NULL AND open_to_contractors = 1 AND status = 'scheduled'`,
      userId,
      jobId
    );
    if (!result.changes) return false;
    run('INSERT OR IGNORE INTO job_technicians (job_id, user_id) VALUES (?, ?)', jobId, userId);
    return true;
  });
  if (!updated) return { ok: false, error: 'Someone else just claimed that gig.' };
  const full = getJob(jobId);
  const who = get('SELECT name FROM users WHERE id = ?', userId);
  if (full.request_id) {
    setRequestStatus(full.request_id, 'dispatched', userId, `${who.name} claimed this job from the contractor board.`);
  }
  for (const admin of all("SELECT id FROM users WHERE role = 'admin' AND active = 1")) {
    notify(admin.id, {
      title: `${who.name} claimed: ${full.property_name}`,
      body: `${full.title} on ${fmtLongDate(full.scheduled_date)}`,
      link: `/admin/jobs/${jobId}`,
      email: false,
    });
  }
  return { ok: true, job: full };
}

function releaseJob(jobId, userId, { admin = false } = {}) {
  const job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job || !job.claimed_by) return false;
  if (!admin && job.claimed_by !== userId) return false;
  if (!['scheduled', 'dispatched'].includes(job.status)) return false;
  const who = job.claimed_by;
  transaction(() => {
    run('DELETE FROM job_technicians WHERE job_id = ? AND user_id = ?', jobId, who);
    run("UPDATE jobs SET claimed_by = NULL, claimed_at = NULL, status = 'scheduled', dispatched_at = NULL WHERE id = ?", jobId);
  });
  if (admin && who !== userId) {
    notify(who, {
      title: 'A gig was returned to the job board',
      body: 'Dispatch released a job you had claimed. It is available for someone else.',
      link: '/work',
    });
  }
  return true;
}

function setJobStatus(jobId, status, actorId, notes) {
  const job = getJob(jobId);
  if (!job) return;
  if (status === 'in_progress') {
    run("UPDATE jobs SET status = 'in_progress', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?", jobId);
    setRequestStatus(job.request_id, 'in_progress', actorId, 'Our crew is on site and working on your request.');
  } else if (status === 'completed') {
    run("UPDATE jobs SET status = 'completed', completed_at = datetime('now'), completion_notes = ? WHERE id = ?", notes || null, jobId);
    setRequestStatus(job.request_id, 'completed', actorId, notes ? `Completed. Crew notes: ${notes}` : 'Service completed.');
    for (const a of all("SELECT id FROM users WHERE role = 'admin' AND active = 1")) {
      notify(a.id, { title: `Job completed: ${job.property_name}`, body: `${job.title}${notes ? ` — ${notes}` : ''}`, link: `/admin/jobs/${jobId}`, email: false });
    }
  } else if (status === 'cancelled') {
    run("UPDATE jobs SET status = 'cancelled' WHERE id = ?", jobId);
    for (const userId of crewFor(job)) {
      notify(userId, { title: `Cancelled: ${job.property_name} (${fmtLongDate(job.scheduled_date)})`, body: job.title, link: `/crew/jobs/${jobId}` });
    }
  } else if (status === 'scheduled') {
    run("UPDATE jobs SET status = 'scheduled', dispatched_at = NULL WHERE id = ?", jobId);
  }
}

module.exports = {
  getJob,
  listJobs,
  createJob,
  updateJob,
  dispatchJob,
  dispatchDay,
  setJobStatus,
  setRequestStatus,
  logActivity,
  listOpenGigs,
  claimJob,
  releaseJob,
};
