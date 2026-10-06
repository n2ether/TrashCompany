const { db, run, get, transaction } = require('./db');
const { hashPassword } = require('./auth');
const { isoDate, addDays, parseDate } = require('./helpers');
const { NIGHTS } = require('./constants');

const DEMO_PASSWORDS = { admin: 'Admin2026!', client: 'Client2026!', crew: 'Crew2026!' };

function reset() {
  db.exec(`
    DELETE FROM notifications; DELETE FROM outbox; DELETE FROM job_technicians; DELETE FROM jobs;
    DELETE FROM request_activity; DELETE FROM service_requests; DELETE FROM invoices; DELETE FROM properties;
    DELETE FROM sessions; DELETE FROM users; DELETE FROM organizations; DELETE FROM leads;
    DELETE FROM sqlite_sequence;
  `);
}

function seed() {
  const today = isoDate();
  const id = (r) => Number(r.lastInsertRowid);

  transaction(() => {
    const user = (name, email, role, password, extra = {}) =>
      id(
        run(
          'INSERT INTO users (name, email, role, password_hash, phone, title, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          name, email, role, hashPassword(password), extra.phone || null, extra.title || null, extra.org_id || null
        )
      );

    user('Jordan Hayes', 'admin@valorvalet.com', 'admin', DEMO_PASSWORDS.admin, { title: 'Operations Director', phone: '(800) 555-0142' });
    const marcus = user('Marcus Ramirez', 'marcus@valorvalet.com', 'supervisor', DEMO_PASSWORDS.crew, { title: 'Field Supervisor — North Route', phone: '(512) 555-0110' });
    const dana = user('Dana Whitfield', 'dana@valorvalet.com', 'supervisor', DEMO_PASSWORDS.crew, { title: 'Field Supervisor — South Route', phone: '(512) 555-0111' });
    const techs = [
      ['Tyrell Brooks', 'tyrell@valorvalet.com'],
      ['Ana Delgado', 'ana@valorvalet.com'],
      ['Chris Nguyen', 'chris@valorvalet.com'],
      ['Sam Okafor', 'sam@valorvalet.com'],
      ['Lena Park', 'lena@valorvalet.com'],
    ].map(([n, e], i) => user(n, e, 'technician', DEMO_PASSWORDS.crew, { title: 'Service Technician', phone: `(512) 555-01${20 + i}` }));
    const [tyrell, ana, chris, sam, lena] = techs;

    const org = (name, email, phone, address, plan, status = 'active') =>
      id(run('INSERT INTO organizations (name, billing_email, phone, address, plan, status) VALUES (?, ?, ?, ?, ?, ?)', name, email, phone, address, plan, status));
    const oak = org('Oakridge Property Group', 'ap@oakridgepg.com', '(512) 555-0300', '400 Congress Ave, Suite 1200, Austin, TX 78701', 'Valet Trash 5-Night + Porter');
    const summit = org('Summit Residential', 'billing@summitres.com', '(512) 555-0400', '9800 N Lamar Blvd, Austin, TX 78753', 'Valet Trash 6-Night');
    const bay = org('Bayview Living Co.', 'office@bayviewliving.com', '(512) 555-0500', '220 Lakeshore Dr, Round Rock, TX 78664', 'Common Area Porter', 'active');

    const priya = user('Priya Shah', 'manager@oakridgepg.com', 'client', DEMO_PASSWORDS.client, { title: 'Regional Property Manager', phone: '(512) 555-0301', org_id: oak });
    user('Kevin Lewis', 'maintenance@oakridgepg.com', 'client', DEMO_PASSWORDS.client, { title: 'Maintenance Supervisor', phone: '(512) 555-0302', org_id: oak });
    const erica = user('Erica Moore', 'erica@summitres.com', 'client', DEMO_PASSWORDS.client, { title: 'Community Manager', phone: '(512) 555-0401', org_id: summit });
    const luis = user('Luis Romero', 'luis@bayviewliving.com', 'client', DEMO_PASSWORDS.client, { title: 'Property Manager', phone: '(512) 555-0501', org_id: bay });

    const prop = (orgId, p) =>
      id(
        run(
          `INSERT INTO properties (org_id, name, address, city, state, zip, units, buildings, property_type, service_nights, service_window, services, access_notes, onsite_contact)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          orgId, p.name, p.address, p.city, 'TX', p.zip, p.units, p.buildings, p.type, p.nights, p.window, p.services, p.access, p.contact
        )
      );
    const riverside = prop(oak, {
      name: 'The Oakridge at Riverside', address: '1500 Riverside Dr', city: 'Austin', zip: '78741', units: 240, buildings: 12, type: 'Garden-style',
      nights: 'Sun,Mon,Tue,Wed,Thu', window: '8:00 PM – 10:00 PM', services: 'valet_trash,pet_station,common_area',
      access: 'Gate code #4417. Compactor key in leasing office lockbox (code 2580). Building 7 stairwell lights are out — bring headlamps.',
      contact: 'Kevin Lewis (512) 555-0302',
    });
    const maple = prop(oak, {
      name: 'Maple Commons', address: '820 E Oltorf St', city: 'Austin', zip: '78704', units: 128, buildings: 6, type: 'Mid-rise',
      nights: 'Sun,Mon,Tue,Wed,Thu', window: '7:30 PM – 9:30 PM', services: 'valet_trash,common_area,enclosure',
      access: 'Use fob #12 at the north garage entrance. Trash chute rooms on every floor next to elevators.',
      contact: 'Front desk (512) 555-0310',
    });
    const heights = prop(summit, {
      name: 'Summit Heights', address: '11200 Metric Blvd', city: 'Austin', zip: '78758', units: 312, buildings: 4, type: 'Mid-rise',
      nights: 'Sun,Mon,Tue,Wed,Thu,Sat', window: '8:00 PM – 10:00 PM', services: 'valet_trash,trash_out,bulk_removal',
      access: 'Courtesy officer on site after 9 PM (512) 555-0499. Buildings A–D, elevators in each lobby.',
      contact: 'Erica Moore (512) 555-0401',
    });
    const lakeshore = prop(bay, {
      name: 'Lakeshore Flats', address: '220 Lakeshore Dr', city: 'Round Rock', zip: '78664', units: 96, buildings: 3, type: 'Garden-style',
      nights: '', window: '', services: 'common_area,pet_station',
      access: 'Clubhouse code 1966. Pool deck locked after 10 PM.', contact: 'Luis Romero (512) 555-0501',
    });

    const routes = [
      { property: riverside, name: 'The Oakridge at Riverside', supervisor: marcus, techs: [tyrell, ana], start: '20:00', end: '22:00', nights: 'Sun,Mon,Tue,Wed,Thu' },
      { property: maple, name: 'Maple Commons', supervisor: marcus, techs: [chris], start: '19:30', end: '21:30', nights: 'Sun,Mon,Tue,Wed,Thu' },
      { property: heights, name: 'Summit Heights', supervisor: dana, techs: [sam, lena], start: '20:00', end: '22:00', nights: 'Sun,Mon,Tue,Wed,Thu,Sat' },
    ];

    const job = (j) => {
      const jobId = id(
        run(
          `INSERT INTO jobs (request_id, property_id, type, title, scheduled_date, start_time, end_time, supervisor_id, status, instructions, completion_notes, dispatched_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          j.request_id || null, j.property_id, j.type, j.title, j.date, j.start, j.end, j.supervisor, j.status, j.instructions || null, j.notes || null,
          j.status === 'scheduled' ? null : `${j.date} 12:00:00`,
          ['in_progress', 'completed'].includes(j.status) ? `${j.date} ${j.start || '09:00'}:00` : null,
          j.status === 'completed' ? `${j.date} ${j.end || '12:00'}:00` : null
        )
      );
      for (const t of j.techs) run('INSERT INTO job_technicians (job_id, user_id) VALUES (?, ?)', jobId, t);
      return jobId;
    };

    const completionNotes = [
      'All doors serviced. Compactor at 70%.',
      'Route complete. 3 bins left out without bags — tagged with courtesy notices.',
      'Complete. Recycling sorted; cardboard broken down at enclosure.',
      'All buildings serviced. Overflow cleaned at dumpster #2.',
    ];
    for (let offset = -7; offset <= 10; offset++) {
      const date = addDays(today, offset);
      const night = NIGHTS[parseDate(date).getDay()];
      routes.forEach((r, i) => {
        if (!r.nights.split(',').includes(night)) return;
        const status = offset < 0 ? 'completed' : offset === 0 ? 'dispatched' : offset <= 2 ? 'dispatched' : 'scheduled';
        job({
          property_id: r.property, type: 'valet_trash', title: `Nightly valet trash route — ${r.name}`, date, start: r.start, end: r.end,
          supervisor: r.supervisor, techs: r.techs, status,
          instructions: 'Collect bagged trash and recycling from every door. Photograph and tag any violations. Report compactor levels.',
          notes: status === 'completed' ? completionNotes[(offset + 7 + i) % completionNotes.length] : null,
        });
      });
    }

    const request = (r) => {
      const reqId = id(
        run(
          `INSERT INTO service_requests (org_id, property_id, requested_by, type, priority, frequency, preferred_date, preferred_window, location_details, quantity, description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.org, r.property, r.by, r.type, r.priority || 'standard', r.frequency || 'one_time', r.preferred_date || null, r.window || null,
          r.location, r.quantity || null, r.description, r.status, `${r.created} 15:00:00`, `${r.created} 15:00:00`
        )
      );
      run('INSERT INTO request_activity (request_id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)', reqId, r.by, 'status', 'Request submitted.', `${r.created} 15:00:00`);
      return reqId;
    };
    const activity = (reqId, userId, message, at, kind = 'status') =>
      run('INSERT INTO request_activity (request_id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)', reqId, userId, kind, message, at);
    const admin = get("SELECT id FROM users WHERE role = 'admin'").id;

    request({
      org: oak, property: riverside, by: priya, type: 'bulk_removal', priority: 'urgent', created: today, preferred_date: today, window: 'Afternoon (12 PM – 5 PM)',
      location: 'Building 4 dumpster enclosure', quantity: 3, status: 'submitted',
      description: 'Resident left a queen mattress, box spring, and a sectional couch next to the enclosure. Blocking the compactor door.',
    });
    request({
      org: oak, property: maple, by: priya, type: 'common_area', frequency: 'weekly', created: addDays(today, -1), preferred_date: addDays(today, 3), window: 'Morning (8 AM – 12 PM)',
      location: 'Clubhouse, mailroom, and 1st floor lobby', status: 'submitted',
      description: 'Weekly sweep, mop, and trash removal ahead of our weekend leasing tours. Please wipe down mailbox fronts.',
    });
    request({
      org: summit, property: heights, by: erica, type: 'missed_pickup', priority: 'urgent', created: today, location: 'Building C, 3rd floor, units C301–C318', status: 'submitted',
      description: 'Several residents on C3 reported their trash was not collected last night.',
    });

    const pet = request({
      org: oak, property: riverside, by: priya, type: 'pet_station', frequency: 'weekly', created: addDays(today, -3), preferred_date: addDays(today, 1), window: 'Morning (8 AM – 12 PM)',
      location: 'All 8 pet stations along the dog walk and Building 1–12 corners', status: 'dispatched',
      description: 'Empty, sanitize and restock bags at every station.',
    });
    activity(pet, admin, `Scheduled for ${addDays(today, 1)} at 9:00 AM.`, `${addDays(today, -2)} 10:00:00`);
    activity(pet, admin, 'Crew dispatched. Supervisor: Marcus Ramirez.', `${addDays(today, -2)} 10:05:00`);
    job({ request_id: pet, property_id: riverside, type: 'pet_station', title: 'Pet waste station service — Riverside', date: addDays(today, 1), start: '09:00', end: '11:00', supervisor: marcus, techs: [ana], status: 'dispatched', instructions: 'Restock 2 rolls per station. Report any broken dispensers with a photo.' });

    const enclosure = request({
      org: oak, property: maple, by: priya, type: 'enclosure', created: addDays(today, -2), preferred_date: today, window: 'Afternoon (12 PM – 5 PM)',
      location: 'North garage compactor room', status: 'in_progress',
      description: 'Spilled liquid and loose debris around the compactor. Strong odor reported by residents.',
    });
    activity(enclosure, admin, `Scheduled for ${today} at 1:00 PM.`, `${addDays(today, -1)} 09:00:00`);
    activity(enclosure, admin, 'Crew dispatched. Supervisor: Marcus Ramirez.', `${addDays(today, -1)} 09:02:00`);
    activity(enclosure, chris, 'Our crew is on site and working on your request.', `${today} 13:05:00`);
    job({ request_id: enclosure, property_id: maple, type: 'enclosure', title: 'Compactor room cleanup — Maple Commons', date: today, start: '13:00', end: '15:00', supervisor: marcus, techs: [chris, tyrell], status: 'in_progress', instructions: 'Pressure-wash floor, apply enzyme deodorizer, haul loose debris.' });

    const trashOut = request({
      org: summit, property: heights, by: erica, type: 'trash_out', created: addDays(today, -6), preferred_date: addDays(today, -3), window: 'Morning (8 AM – 12 PM)',
      location: 'Unit B214 (move-out)', status: 'completed',
      description: 'Full unit trash-out after move-out. Furniture left in living room and bedroom.',
    });
    activity(trashOut, admin, `Scheduled for ${addDays(today, -3)} at 8:30 AM.`, `${addDays(today, -5)} 11:00:00`);
    activity(trashOut, admin, 'Crew dispatched. Supervisor: Dana Whitfield.', `${addDays(today, -5)} 11:05:00`);
    activity(trashOut, sam, 'Completed. Crew notes: Removed 1 sofa, 2 dressers, 14 bags. Unit is broom-swept and ready for make-ready.', `${addDays(today, -3)} 11:40:00`);
    job({ request_id: trashOut, property_id: heights, type: 'trash_out', title: 'Unit trash-out — Summit Heights B214', date: addDays(today, -3), start: '08:30', end: '11:30', supervisor: dana, techs: [sam, lena], status: 'completed', notes: 'Removed 1 sofa, 2 dressers, 14 bags. Unit is broom-swept and ready for make-ready.' });

    const porter = request({
      org: bay, property: lakeshore, by: luis, type: 'common_area', frequency: 'weekly', created: addDays(today, -4), preferred_date: addDays(today, 2), window: 'Morning (8 AM – 12 PM)',
      location: 'Clubhouse, pool deck, fitness center', status: 'scheduled',
      description: 'Weekly porter service: trash cans, sweep pool deck, wipe fitness equipment.',
    });
    activity(porter, admin, `Scheduled for ${addDays(today, 2)} at 8:00 AM.`, `${addDays(today, -3)} 14:00:00`);
    job({ request_id: porter, property_id: lakeshore, type: 'common_area', title: 'Common area porter — Lakeshore Flats', date: addDays(today, 2), start: '08:00', end: '11:00', supervisor: dana, techs: [lena], status: 'scheduled', instructions: 'Bring microfiber kit and gym disinfectant.' });

    const month = (n) => {
      const d = parseDate(today);
      d.setMonth(d.getMonth() - n, 1);
      return isoDate(d).slice(0, 7);
    };
    let invoiceNo = 1001;
    const invoice = (orgId, period, cents, status) =>
      run('INSERT INTO invoices (org_id, number, period, amount_cents, status, due_date) VALUES (?, ?, ?, ?, ?, ?)', orgId, `VV-${invoiceNo++}`, period, cents, status, `${period}-28`);
    for (const n of [3, 2, 1, 0]) {
      invoice(oak, month(n), 240 * 1400 + 128 * 1500 + 105000, n === 0 ? 'open' : 'paid');
      invoice(summit, month(n), 312 * 1350, n === 0 ? 'open' : 'paid');
      invoice(bay, month(n), 105000, n <= 1 ? 'open' : 'paid');
    }

    run(
      'INSERT INTO leads (name, email, phone, company, property_name, units, services, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'Rachel Kim', 'rkim@cedarparkapts.com', '(512) 555-0601', 'Cedar Park Apartments', 'Cedar Park Apartments', 184, 'valet_trash, common_area',
      'We are switching providers at lease renewal season. Need 5-night service plus weekly hallway cleaning.', `${addDays(today, -1)} 16:20:00`
    );
    run(
      "INSERT INTO leads (name, email, phone, company, property_name, units, services, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'contacted', ?)",
      'Tom Alvarez', 'talvarez@hillcountryhomes.com', '(512) 555-0702', 'Hill Country Homes', 'Westlake Townhomes', 62, 'bulk_removal, trash_out',
      'Looking for an on-call vendor for move-outs.', `${addDays(today, -5)} 10:00:00`
    );

    const note = (userId, title, body, link, read = 0) => run('INSERT INTO notifications (user_id, title, body, link, read) VALUES (?, ?, ?, ?, ?)', userId, title, body, link, read);
    note(admin, 'URGENT New request: Bulk Item Removal', 'Oakridge Property Group — The Oakridge at Riverside. Building 4 dumpster enclosure.', '/admin/requests/1');
    note(admin, 'URGENT New request: Missed Pickup (Comeback)', 'Summit Residential — Summit Heights. Building C, 3rd floor.', '/admin/requests/3');
    note(admin, 'New quote request from Cedar Park Apartments', '184 units. Services: valet_trash, common_area', '/admin/leads');
    note(marcus, `New assignment: The Oakridge at Riverside`, 'Nightly valet trash route. Crew: Tyrell Brooks, Ana Delgado.', '/crew');
    note(tyrell, 'New assignment: Compactor room cleanup — Maple Commons', 'Supervisor: Marcus Ramirez. Bring enzyme deodorizer.', '/crew');
    note(priya, 'Request #5: In Progress', 'Our crew is on site and working on your request.', `/portal/requests/${enclosure}`);
    note(priya, 'Request #4: Crew Dispatched', 'Crew dispatched. Supervisor: Marcus Ramirez.', `/portal/requests/${pet}`, 1);
  });
}

if (require.main === module) {
  if (process.argv.includes('--reset')) reset();
  seed();
  console.log('Seeded demo data.');
  console.log(`  Admin:       admin@valorvalet.com / ${DEMO_PASSWORDS.admin}`);
  console.log(`  Client:      manager@oakridgepg.com / ${DEMO_PASSWORDS.client}`);
  console.log(`  Supervisor:  marcus@valorvalet.com / ${DEMO_PASSWORDS.crew}`);
  console.log(`  Technician:  tyrell@valorvalet.com / ${DEMO_PASSWORDS.crew}`);
}

module.exports = { seed, reset, DEMO_PASSWORDS };
