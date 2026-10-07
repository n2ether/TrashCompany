const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'valor.db');

if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  billing_email TEXT,
  phone TEXT,
  address TEXT,
  plan TEXT DEFAULT 'Standard 5-Night',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('client','admin','supervisor','technician','contractor')),
  title TEXT,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  units INTEGER DEFAULT 0,
  buildings INTEGER DEFAULT 1,
  property_type TEXT DEFAULT 'Garden-style',
  service_nights TEXT DEFAULT 'Sun,Mon,Tue,Wed,Thu',
  service_window TEXT DEFAULT '8:00 PM – 10:00 PM',
  services TEXT DEFAULT 'valet_trash',
  access_notes TEXT,
  onsite_contact TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  priority TEXT DEFAULT 'standard',
  frequency TEXT DEFAULT 'one_time',
  preferred_date TEXT,
  preferred_window TEXT,
  location_details TEXT,
  quantity INTEGER,
  description TEXT,
  status TEXT DEFAULT 'submitted',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT DEFAULT 'comment',
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER REFERENCES service_requests(id) ON DELETE SET NULL,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'scheduled',
  instructions TEXT,
  completion_notes TEXT,
  dispatched_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  open_to_contractors INTEGER DEFAULT 0,
  pay_cents INTEGER,
  claimed_by INTEGER,
  claimed_at TEXT,
  payout_status TEXT DEFAULT 'unpaid',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_technicians (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'logged',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT DEFAULT 'open',
  due_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  property_name TEXT,
  units INTEGER,
  services TEXT,
  message TEXT,
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contractor_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city TEXT,
  state TEXT,
  zip TEXT,
  service_radius INTEGER DEFAULT 15,
  services TEXT,
  nights TEXT,
  has_vehicle INTEGER DEFAULT 0,
  vehicle TEXT,
  can_lift INTEGER DEFAULT 0,
  tax_class TEXT,
  legal_name TEXT,
  business_name TEXT,
  tin_last4 TEXT,
  payout_method TEXT DEFAULT 'direct_deposit',
  bank_name TEXT,
  account_last4 TEXT,
  date_of_birth TEXT,
  ack_1099 INTEGER DEFAULT 0,
  ack_work_auth INTEGER DEFAULT 0,
  ack_background INTEGER DEFAULT 0,
  status TEXT DEFAULT 'submitted',
  review_note TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_contractor_status ON contractor_profiles(status);
CREATE INDEX IF NOT EXISTS idx_requests_org ON service_requests(org_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
`);

function migrate() {
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (usersSql && !usersSql.sql.includes("'contractor'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        phone TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('client','admin','supervisor','technician','contractor')),
        title TEXT,
        org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      db.exec(`INSERT INTO users_new (id, name, email, phone, password_hash, role, title, org_id, active, created_at)
               SELECT id, name, email, phone, password_hash, role, title, org_id, active, created_at FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw err;
    }
    db.exec('PRAGMA foreign_keys = ON');
  }
  const cols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const [name, def] of [
    ['open_to_contractors', 'INTEGER DEFAULT 0'],
    ['pay_cents', 'INTEGER'],
    ['claimed_by', 'INTEGER'],
    ['claimed_at', 'TEXT'],
    ['payout_status', "TEXT DEFAULT 'unpaid'"],
  ]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${def}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_open ON jobs(open_to_contractors, claimed_by, status)');
}

migrate();

const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, all, get, run, transaction, DB_PATH };
