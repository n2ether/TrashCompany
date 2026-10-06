const express = require('express');
const { all, run, get } = require('../db');
const { requireLogin } = require('../auth');
const { toInt } = require('../helpers');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const items = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  res.render('shared/notifications', { title: 'Notifications', items });
});

router.post('/read-all', (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.redirect('/notifications');
});

router.get('/:id/open', (req, res) => {
  const n = get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', toInt(req.params.id), req.user.id);
  if (!n) return res.redirect('/notifications');
  run('UPDATE notifications SET read = 1 WHERE id = ?', n.id);
  res.redirect(n.link && n.link.startsWith('/') ? n.link : '/notifications');
});

module.exports = router;
