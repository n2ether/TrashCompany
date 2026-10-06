const express = require('express');
const { all, get } = require('../db');
const { requireRole } = require('../auth');
const { clean, toInt, isoDate, addDays, fmtLongDate } = require('../helpers');
const { getJob, listJobs, setJobStatus, logActivity } = require('../jobs');
const { notify } = require('../notify');

const router = express.Router();
router.use(requireRole('supervisor', 'technician'));

const MINE = '(j.supervisor_id = ? OR EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = j.id AND jt.user_id = ?))';

router.get('/', (req, res) => {
  const me = req.user.id;
  const today = isoDate();
  const todayJobs = listJobs(`${MINE} AND j.scheduled_date = ? AND j.status != 'cancelled'`, me, me, today);
  const upcoming = listJobs(`${MINE} AND j.scheduled_date BETWEEN ? AND ? AND j.status != 'cancelled'`, me, me, addDays(today, 1), addDays(today, 14));
  const recent = listJobs(`${MINE} AND j.status = 'completed' AND j.scheduled_date BETWEEN ? AND ?`, me, me, addDays(today, -7), addDays(today, -1)).reverse();
  const grouped = {};
  for (const j of upcoming) (grouped[j.scheduled_date] = grouped[j.scheduled_date] || []).push(j);
  const stats = {
    today: todayJobs.length,
    remaining: todayJobs.filter((j) => j.status !== 'completed').length,
    week: upcoming.filter((j) => j.scheduled_date <= addDays(today, 6)).length + todayJobs.length,
  };
  res.render('crew/dashboard', { title: 'My Assignments', todayJobs, grouped, recent, stats, today });
});

function loadJob(req, res) {
  const job = getJob(toInt(req.params.id));
  const mine = job && (job.supervisor_id === req.user.id || job.technicians.some((t) => t.id === req.user.id));
  if (!mine) {
    res.status(404).render('shared/error', { title: 'Assignment not found', message: 'This job is not assigned to you.' });
    return null;
  }
  return job;
}

router.get('/jobs/:id', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const isSupervisor = job.supervisor_id === req.user.id;
  res.render('crew/job-detail', { title: job.title, job, isSupervisor });
});

router.post('/jobs/:id/status', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const status = req.body.status;
  if (!['in_progress', 'completed'].includes(status) || ['completed', 'cancelled'].includes(job.status)) {
    res.flash('error', 'That update is not available for this job.');
    return res.redirect(`/crew/jobs/${job.id}`);
  }
  const notes = clean(req.body.notes, 1000);
  setJobStatus(job.id, status, req.user.id, notes);
  if (job.request_id && notes && status === 'in_progress') logActivity(job.request_id, req.user.id, notes, 'comment');
  if (job.supervisor_id && job.supervisor_id !== req.user.id) {
    notify(job.supervisor_id, {
      title: `${req.user.name} ${status === 'completed' ? 'completed' : 'started'}: ${job.property_name}`,
      body: notes || job.title,
      link: `/crew/jobs/${job.id}`,
      email: false,
    });
  }
  res.flash('success', status === 'completed' ? 'Nice work — job marked complete.' : 'Job started. Stay safe out there.');
  res.redirect(status === 'completed' ? '/crew' : `/crew/jobs/${job.id}`);
});

router.post('/jobs/:id/brief', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (job.supervisor_id !== req.user.id) return res.redirect(`/crew/jobs/${job.id}`);
  const message = clean(req.body.message, 1000);
  if (!message) {
    res.flash('error', 'Write a short message for your crew.');
    return res.redirect(`/crew/jobs/${job.id}`);
  }
  for (const t of job.technicians) {
    notify(t.id, { title: `Briefing from ${req.user.name}: ${job.property_name} (${fmtLongDate(job.scheduled_date)})`, body: message, link: `/crew/jobs/${job.id}` });
  }
  res.flash('success', `Briefing sent to ${job.technicians.length} technician${job.technicians.length === 1 ? '' : 's'}.`);
  res.redirect(`/crew/jobs/${job.id}`);
});

module.exports = router;
