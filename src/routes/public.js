const express = require('express');
const { run } = require('../db');
const { clean, toInt } = require('../helpers');
const { notifyRole } = require('../notify');

const router = express.Router();

router.get('/', (req, res) => res.render('public/home', { title: 'Valet Trash & Common Area Care for Apartments' }));
router.get('/services', (req, res) => res.render('public/services', { title: 'Services' }));
router.get('/how-it-works', (req, res) => res.render('public/how-it-works', { title: 'How It Works' }));
router.get('/mission', (req, res) => res.render('public/mission', { title: 'Our Mission' }));
router.get('/style-guide', (req, res) => res.render('public/style-guide', { title: 'Brand & Accessibility Style Guide' }));

router.get('/contact', (req, res) => res.render('public/contact', { title: 'Request a Quote', form: {}, sent: false }));

router.post('/contact', (req, res) => {
  const form = {
    name: clean(req.body.name, 120),
    email: clean(req.body.email, 160),
    phone: clean(req.body.phone, 40),
    company: clean(req.body.company, 160),
    property_name: clean(req.body.property_name, 160),
    units: toInt(req.body.units),
    services: [].concat(req.body.services || []).map((s) => clean(s, 40)).join(', '),
    message: clean(req.body.message, 2000),
  };
  const errors = [];
  if (!form.name) errors.push('Please enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(form.email)) errors.push('Please enter a valid email address.');
  if (errors.length) return res.status(422).render('public/contact', { title: 'Request a Quote', form, errors, sent: false });

  run(
    'INSERT INTO leads (name, email, phone, company, property_name, units, services, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    form.name,
    form.email,
    form.phone,
    form.company,
    form.property_name,
    form.units,
    form.services,
    form.message
  );
  notifyRole('admin', {
    title: `New quote request from ${form.company || form.name}`,
    body: `${form.property_name || 'Property'} — ${form.units || '?'} units. Services: ${form.services || 'not specified'}`,
    link: '/admin/leads',
  });
  res.render('public/contact', { title: 'Request a Quote', form: {}, sent: true });
});

module.exports = router;
