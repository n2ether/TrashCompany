const { SERVICE_TYPES, STATUSES, ROLES, COMPANY, NIGHTS, PRIORITIES, FREQUENCIES, WINDOWS, GIG_PAY, TAX_CLASSES, CONTRACTOR_STATUSES } = require('./constants');
const { icon } = require('./icons');

const pad = (n) => String(n).padStart(2, '0');

function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function startOfWeek(str) {
  const d = parseDate(str);
  d.setDate(d.getDate() - d.getDay());
  return isoDate(d);
}

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(str || '')) && !Number.isNaN(parseDate(str).getTime());
}

function fmtDate(str, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!str) return '—';
  const d = str.length > 10 ? new Date(str.replace(' ', 'T') + 'Z') : parseDate(str);
  return d.toLocaleDateString('en-US', opts);
}

function fmtLongDate(str) {
  return fmtDate(str, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(str) {
  if (!str) return '—';
  const d = new Date(str.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${pad(m)} ${suffix}`;
}

function fmtMoney(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function relativeDay(str) {
  const today = isoDate();
  if (str === today) return 'Today';
  if (str === addDays(today, 1)) return 'Tomorrow';
  if (str === addDays(today, -1)) return 'Yesterday';
  return fmtDate(str);
}

function serviceLabel(type) {
  return (SERVICE_TYPES[type] || SERVICE_TYPES.other).label;
}

function statusBadge(status) {
  const s = STATUSES[status] || { label: status, tone: 'muted', icon: 'info' };
  return `<span class="badge badge--${s.tone}">${icon(s.icon, 'icon--sm')}${s.label}</span>`;
}

function typeChip(type) {
  const t = SERVICE_TYPES[type] || SERVICE_TYPES.other;
  return `<span class="chip chip--${t.tone}">${icon(t.icon, 'icon--sm')}${t.short}</span>`;
}

function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

function viewLocals(req, res, next) {
  Object.assign(res.locals, {
    icon,
    fmtDate,
    fmtLongDate,
    fmtDateTime,
    fmtTime,
    fmtMoney,
    relativeDay,
    serviceLabel,
    statusBadge,
    typeChip,
    initials,
    isoDate,
    SERVICE_TYPES,
    STATUSES,
    ROLES,
    COMPANY,
    NIGHTS,
    PRIORITIES,
    FREQUENCIES,
    WINDOWS,
    GIG_PAY,
    TAX_CLASSES,
    CONTRACTOR_STATUSES,
    currentPath: req.path,
    query: req.query,
    flash: null,
    errors: [],
  });
  const flash = req.cookies.vv_flash;
  if (flash) {
    try {
      res.locals.flash = JSON.parse(flash);
    } catch {}
    res.clearCookie('vv_flash');
  }
  res.flash = (type, message) => res.cookie('vv_flash', JSON.stringify({ type, message }), { httpOnly: true, sameSite: 'lax' });
  next();
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const toArray = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

const clean = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

module.exports = {
  isoDate,
  parseDate,
  addDays,
  startOfWeek,
  isValidDate,
  fmtDate,
  fmtLongDate,
  fmtTime,
  fmtMoney,
  relativeDay,
  serviceLabel,
  viewLocals,
  toInt,
  toArray,
  clean,
  NIGHTS,
};
