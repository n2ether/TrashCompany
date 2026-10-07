process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { seed } = require('../src/seed');
const { get } = require('../src/db');
const { isoDate, addDays } = require('../src/helpers');

let server;
let base;

before(async () => {
  seed();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function client() {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      const val = v.join('=');
      if (val === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k];
      else jar[k] = val;
    }
  };
  const csrf = () => jar.vv_csrf;
  return {
    async get(path) {
      const res = await fetch(base + path, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
      store(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async post(path, data = {}) {
      if (!csrf()) await this.get('/login');
      const body = new URLSearchParams();
      body.append('_csrf', csrf());
      for (const [k, v] of Object.entries(data)) [].concat(v).forEach((x) => body.append(k, x));
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      store(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async login(email, password) {
      const res = await this.post('/login', { email, password });
      assert.strictEqual(res.status, 302, `login failed for ${email}`);
      return res.location;
    },
  };
}

test('every role lands on its own dashboard and pages render', async () => {
  const pages = {
    'manager@oakridgepg.com': ['Client2026!', '/portal', ['/portal', '/portal/requests', '/portal/requests/new', '/portal/requests/1', '/portal/schedule', '/portal/properties', '/portal/properties/new', '/portal/properties/1/edit', '/portal/account', '/portal/account?tab=company', '/portal/account?tab=team', '/portal/account?tab=billing', '/portal/account?tab=security', '/notifications']],
    'admin@valorvalet.com': ['Admin2026!', '/admin', ['/admin', '/admin/requests', '/admin/requests?status=all', '/admin/requests/1', '/admin/requests/6', '/admin/schedule', '/admin/schedule/day', '/admin/jobs/new', '/admin/jobs/1', '/admin/clients', '/admin/clients/1', '/admin/team', '/admin/leads', '/admin/outbox', '/notifications']],
    'marcus@valorvalet.com': ['Crew2026!', '/crew', ['/crew', '/notifications']],
    'tyrell@valorvalet.com': ['Crew2026!', '/crew', ['/crew']],
    'andre@valorvalet.com': ['Contractor2026!', '/work', ['/work', '/work/earnings', '/work/profile', '/notifications']],
  };
  for (const [email, [pw, home, urls]] of Object.entries(pages)) {
    const c = client();
    assert.strictEqual(await c.login(email, pw), home);
    for (const url of urls) {
      const res = await c.get(url);
      assert.strictEqual(res.status, 200, `${email} ${url} -> ${res.status}`);
    }
  }
});

test('role boundaries are enforced', async () => {
  const c = client();
  await c.login('manager@oakridgepg.com', 'Client2026!');
  assert.strictEqual((await c.get('/admin')).status, 403);
  assert.strictEqual((await c.get('/crew')).status, 403);
  assert.strictEqual((await c.get('/work')).status, 403);
  assert.strictEqual((await c.get('/portal/requests/3')).status, 404, 'client cannot view another org request');

  const anon = client();
  const res = await anon.get('/portal');
  assert.strictEqual(res.status, 302);
  assert.match(res.location, /^\/login/);

  const bad = client();
  await bad.get('/login');
  const forged = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b', redirect: 'manual' });
  assert.strictEqual(forged.status, 403, 'missing CSRF token is rejected');
});

test('request -> schedule -> dispatch -> complete workflow', async () => {
  const mgr = client();
  await mgr.login('manager@oakridgepg.com', 'Client2026!');
  const created = await mgr.post('/portal/requests', {
    type: 'bulk_removal',
    property_id: '1',
    priority: 'urgent',
    preferred_date: isoDate(),
    preferred_window: 'Afternoon (12 PM – 5 PM)',
    location_details: 'Building 9 breezeway',
    quantity: '2',
    description: 'Two recliners left in the breezeway.',
  });
  assert.strictEqual(created.status, 302);
  const requestId = Number(created.location.split('/').pop());
  assert.strictEqual(get('SELECT status FROM service_requests WHERE id = ?', requestId).status, 'submitted');

  const admin = client();
  await admin.login('admin@valorvalet.com', 'Admin2026!');
  const queue = await admin.get('/admin');
  assert.match(queue.text, /Building 9 breezeway|Bulk Item Removal/);

  const marcus = get("SELECT id FROM users WHERE email = 'marcus@valorvalet.com'").id;
  const tyrell = get("SELECT id FROM users WHERE email = 'tyrell@valorvalet.com'").id;
  const ana = get("SELECT id FROM users WHERE email = 'ana@valorvalet.com'").id;
  const scheduled = await admin.post(`/admin/requests/${requestId}/schedule`, {
    title: 'Bulk pickup — Building 9',
    scheduled_date: addDays(isoDate(), 1),
    start_time: '13:00',
    end_time: '14:00',
    supervisor_id: String(marcus),
    technician_ids: [String(tyrell), String(ana)],
    instructions: 'Bring the dolly.',
    dispatch_now: '1',
  });
  assert.strictEqual(scheduled.status, 302);
  const job = get('SELECT * FROM jobs WHERE request_id = ?', requestId);
  assert.ok(job, 'job created');
  assert.strictEqual(job.status, 'dispatched');
  assert.strictEqual(get('SELECT status FROM service_requests WHERE id = ?', requestId).status, 'dispatched');

  for (const uid of [marcus, tyrell, ana]) {
    const n = get('SELECT * FROM notifications WHERE user_id = ? AND link = ?', uid, `/crew/jobs/${job.id}`);
    assert.ok(n, `crew member ${uid} was notified`);
  }
  const emails = get("SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE '%New assignment%' AND body LIKE '%Bring the dolly%'").n;
  assert.strictEqual(emails, 3, 'schedule emailed to supervisor + 2 technicians');

  const tech = client();
  await tech.login('tyrell@valorvalet.com', 'Crew2026!');
  assert.match((await tech.get('/crew')).text, /Bulk pickup|The Oakridge at Riverside/);
  assert.strictEqual((await tech.get(`/crew/jobs/${job.id}`)).status, 200);
  await tech.post(`/crew/jobs/${job.id}/status`, { status: 'in_progress' });
  assert.strictEqual(get('SELECT status FROM service_requests WHERE id = ?', requestId).status, 'in_progress');
  await tech.post(`/crew/jobs/${job.id}/status`, { status: 'completed', notes: 'Both recliners hauled.' });
  assert.strictEqual(get('SELECT status FROM jobs WHERE id = ?', job.id).status, 'completed');
  assert.strictEqual(get('SELECT status FROM service_requests WHERE id = ?', requestId).status, 'completed');

  const outsider = client();
  await outsider.login('sam@valorvalet.com', 'Crew2026!');
  assert.strictEqual((await outsider.get(`/crew/jobs/${job.id}`)).status, 404, 'unassigned tech cannot open job');

  const detail = await mgr.get(`/portal/requests/${requestId}`);
  assert.match(detail.text, /Both recliners hauled/);
});

test('dispatching a whole day forwards every scheduled job', async () => {
  const admin = client();
  await admin.login('admin@valorvalet.com', 'Admin2026!');
  const day = addDays(isoDate(), 5);
  const pending = get("SELECT COUNT(*) AS n FROM jobs WHERE scheduled_date = ? AND status = 'scheduled'", day).n;
  const res = await admin.post('/admin/schedule/dispatch', { date: day });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(get("SELECT COUNT(*) AS n FROM jobs WHERE scheduled_date = ? AND status = 'scheduled'", day).n, 0);
  if (pending) assert.ok(get("SELECT COUNT(*) AS n FROM jobs WHERE scheduled_date = ? AND status = 'dispatched'", day).n >= pending);
});

test('recurring route generation creates one job per selected night', async () => {
  const admin = client();
  await admin.login('admin@valorvalet.com', 'Admin2026!');
  const start = addDays(isoDate(), 30);
  const before = get('SELECT COUNT(*) AS n FROM jobs').n;
  const res = await admin.post('/admin/jobs', {
    property_id: '4',
    type: 'common_area',
    title: 'Weekly porter — Lakeshore',
    scheduled_date: start,
    start_time: '08:00',
    end_time: '10:00',
    supervisor_id: String(get("SELECT id FROM users WHERE email = 'dana@valorvalet.com'").id),
    repeat_until: addDays(start, 13),
    repeat_nights: ['Mon', 'Thu'],
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(get('SELECT COUNT(*) AS n FROM jobs').n - before, 4);
});

test('new clients can register and quote requests reach admin', async () => {
  const c = client();
  await c.get('/register');
  const res = await c.post('/register', {
    name: 'Nora Diaz', email: 'nora@pinesapts.com', password: 'longpassword', company: 'Pines Apartments LLC',
    property_name: 'The Pines', address: '1 Pine St', city: 'Austin', state: 'tx', zip: '78701', units: '150',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/portal');
  assert.strictEqual((await c.get('/portal')).status, 200);

  const lead = await client().post('/contact', { name: 'Ann', email: 'ann@example.com', units: '90', services: ['valet_trash'] });
  assert.strictEqual(lead.status, 200);
  assert.ok(get("SELECT id FROM leads WHERE email = 'ann@example.com'"));
});

test('1099 contractors apply, get approved, and claim a posted gig', async () => {
  const anon = client();
  const page = await anon.get('/join');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /independent contractor/i);

  const rejected = await anon.post('/join', {
    name: 'No Ack', email: 'noack@example.com', password: 'longpassword', phone: '5125550000',
    city: 'Austin', state: 'TX', date_of_birth: '1990-01-01', legal_name: 'No Ack', tin_last4: '1234',
    services: ['bulk_removal'], nights: ['Mon'], account_last4: '9999',
  });
  assert.strictEqual(rejected.status, 422, 'agreements are required');

  const applied = await anon.post('/join', {
    name: 'Riley Santos', email: 'riley@example.com', password: 'longpassword', phone: '(512) 555-0199',
    city: 'Austin', state: 'tx', zip: '78702', date_of_birth: '1994-06-01', legal_name: 'Riley Santos',
    tin_last4: '1234', services: ['bulk_removal', 'common_area'], nights: ['Mon', 'Tue'],
    account_last4: '4242', bank_name: 'Test Bank', has_vehicle: '1', can_lift: '1',
    ack_work_auth: '1', ack_1099: '1', ack_background: '1', tax_class: 'individual', payout_method: 'direct_deposit',
  });
  assert.strictEqual(applied.status, 302);
  assert.strictEqual(applied.location, '/work');
  assert.match((await anon.get('/work')).text, /review/i);
  const stored = get("SELECT tin_last4, account_last4 FROM contractor_profiles WHERE user_id = (SELECT id FROM users WHERE email = 'riley@example.com')");
  assert.strictEqual(stored.tin_last4, '1234');
  assert.strictEqual(stored.account_last4, '4242');

  const gig = get("SELECT id FROM jobs WHERE open_to_contractors = 1 AND claimed_by IS NULL AND type = 'bulk_removal' AND status = 'scheduled'");
  assert.ok(gig, 'an open gig exists');
  await anon.post(`/work/jobs/${gig.id}/claim`);
  assert.strictEqual(get('SELECT claimed_by FROM jobs WHERE id = ?', gig.id).claimed_by, null, 'pending applicants cannot claim');

  const admin = client();
  await admin.login('admin@valorvalet.com', 'Admin2026!');
  const riley = get("SELECT id FROM users WHERE email = 'riley@example.com'");
  assert.strictEqual((await admin.get('/admin/contractors')).status, 200);
  assert.strictEqual((await admin.get(`/admin/contractors/${riley.id}`)).status, 200);
  await admin.post(`/admin/contractors/${riley.id}/review`, { status: 'approved', review_note: 'Welcome aboard.' });
  assert.strictEqual(get('SELECT status FROM contractor_profiles WHERE user_id = ?', riley.id).status, 'approved');

  const claim = await anon.post(`/work/jobs/${gig.id}/claim`);
  assert.strictEqual(claim.status, 302);
  assert.strictEqual(get('SELECT claimed_by, status FROM jobs WHERE id = ?', gig.id).claimed_by, riley.id);
  assert.match((await anon.get(`/work/jobs/${gig.id}`)).text, /This gig is yours/);

  const other = client();
  await other.login('andre@valorvalet.com', 'Contractor2026!');
  await other.post(`/work/jobs/${gig.id}/claim`);
  assert.strictEqual(get('SELECT claimed_by FROM jobs WHERE id = ?', gig.id).claimed_by, riley.id, 'a second contractor cannot take a claimed gig');

  await anon.post(`/work/jobs/${gig.id}/status`, { status: 'completed', notes: 'Hauled the sofa.' });
  const done = get('SELECT status, payout_status, completion_notes FROM jobs WHERE id = ?', gig.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.payout_status, 'unpaid');
  assert.match(done.completion_notes, /Hauled the sofa/);
  assert.match((await anon.get('/work/earnings')).text, /\$75\.00|Waiting to be paid/);

  await admin.post(`/admin/jobs/${gig.id}/payout`);
  assert.strictEqual(get('SELECT payout_status FROM jobs WHERE id = ?', gig.id).payout_status, 'paid');
});
