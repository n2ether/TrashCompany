# Valor Valet — Valet Trash & Common Area Care

A complete web platform for a **Disabled Veteran Owned Small Business (DVOSB)** that provides doorstep valet trash and common area cleanup for apartment and multifamily communities. A portion of profits supports homeless veteran housing programs, and that pledge appears across the marketing site and portals.

It includes five experiences in one app:

| Who | Where | What they can do |
| --- | --- | --- |
| Prospects | `/`, `/services`, `/how-it-works`, `/mission`, `/contact` | Learn about services, the DVOSB mission, and request a quote |
| Property clients | `/portal` | Request service, report missed pickups, track status, view schedules, manage properties, invite teammates, view invoices |
| Admin / dispatch | `/admin` | Triage the request queue, schedule jobs, assign a supervisor + technicians, build recurring routes, forward schedules to crews, print run sheets, manage clients, team, leads, and billing |
| Supervisors & technicians | `/crew` | See today's and upcoming assignments, get directions and access codes, start/complete jobs with notes; supervisors can brief their crew |
| 1099 contractors | `/join`, `/work` | Apply as an independent contractor, get approved, claim open gigs at a posted payout, and track earnings |

## Quick start

Requires **Node.js 22.5+** (uses the built-in `node:sqlite` module, no native builds).

```bash
npm install
npm run seed     # reset and load demo data (dates are relative to today)
npm start        # http://localhost:3000
npm test         # end-to-end workflow tests
```

The server seeds demo data automatically on first start if the database is empty.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Property client | `manager@oakridgepg.com` | `Client2026!` |
| Admin / dispatch | `admin@valorvalet.com` | `Admin2026!` |
| Field supervisor | `marcus@valorvalet.com` | `Crew2026!` |
| Technician | `tyrell@valorvalet.com` | `Crew2026!` |
| 1099 contractor | `andre@valorvalet.com` | `Contractor2026!` |

The login page has one-click buttons that fill these in.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/valor.db` | SQLite file location |
| `APP_URL` | `http://localhost:3000` | Used for links in emails |
| `RESEND_API_KEY` | _unset_ | When set, emails are delivered via [Resend](https://resend.com). Otherwise they are logged to the **Email Log** (`/admin/outbox`). |
| `MAIL_FROM` | `Valor Valet <onboarding@resend.dev>` | From address for delivered email |
| `NODE_ENV` | — | Set to `production` for secure cookies |

## How scheduling and dispatch work

1. A client submits a request (`Submitted`). Admins are notified, and urgent requests are sorted to the top of the queue.
2. An admin opens the request, picks a date/time, a **field supervisor**, and **technicians** (`Scheduled`). The form shows what's already booked that day.
3. The job is **forwarded to the crew**, either immediately or later from the Schedule Board ("Dispatch N" per day) or the Daily Run Sheet. Each supervisor and technician gets an in-app notification and an email with address, time, crew, instructions, and access notes (`Crew Dispatched`). Editing a dispatched job re-notifies the crew.
4. Technicians tap **Start job** (`In Progress`) and **Mark complete** with notes (`Completed`). The client sees every step on a progress tracker and activity timeline, and gets notified at each one.

Recurring nightly valet routes are created from **Create Job → Repeat on selected nights** (up to 13 weeks at a time).

### 1099 contractor job board

1. Someone applies at **Work with us** (`/join`) with their service area, the work they can do, a 1099 acknowledgment, and the last four digits of a tax ID and bank account. Full Social Security numbers and full account numbers are not stored.
2. An admin reviews the application under **1099 Contractors** and approves, asks for more information, or declines. The applicant is notified.
3. Approved contractors see open gigs that match their services and state, with the payout shown up front. Claiming a gig assigns it to them. Gate codes stay hidden until then.
4. They start and complete the gig from the contractor portal. The payout stays unpaid until an admin marks it paid on the job.

Post a gig from **Create Job** or from a service request by checking **Post on the 1099 contractor job board** and setting a payout. A supervisor is optional for those jobs. Dispatching a whole day leaves unclaimed gigs on the board.

## UX research summary

Industry leaders reviewed: Valet Living (Doorstep, MyValet client portal), Butler Plus / Trash Butler, and regional valet and porter operators. Patterns adopted:

- **Missed pickup "comebacks"** are the most common support request, so *Report Missed Pickup* is a permanent button in the client sidebar and the first dashboard quick action.
- **Service status and audit trails** lead competitor portals, so every request has a 5-step tracker and a timestamped activity log.
- **Bulk removal as a one-click order**: service types are large visual cards rather than a dropdown.
- **Per-door, per-month pricing** with 5-night (Sun–Thu) service as the default is the industry norm, so pricing tiers, quote forms, and property setup use the same terms.
- **Self-service team management**: clients invite their own staff.
- **Trust signals above the fold**: background-checked crews, insurance, photo documentation, and DVOSB status.

## Design system

Live reference: **`/style-guide`** (palette with computed contrast ratios, type, components).

- **Colors:** Navy `#13294b` (trust and primary), Honor Gold `#f2b33d` (primary calls to action, always with dark text), Flag Red `#b3261e` (urgent and errors only), Field Green `#1e6b3f` (success). Body text `#15202e` on white is about 16:1 contrast; all UI text meets WCAG AA and body text meets AAA.
- **Type:** [Atkinson Hyperlegible](https://brailleinstitute.org/freefont) for body and UI. It was designed by the Braille Institute for low-vision readers, and its distinct letterforms keep gate codes and unit numbers unambiguous. [Barlow](https://fonts.google.com/specimen/Barlow) is used for headings. Base size is 17px with 1.6 line height.
- **Accessibility:** 48px minimum touch targets, visible focus rings, skip links, labels on every field, error summaries that receive focus, statuses shown with icon + text (never color alone), reduced-motion support, responsive tables that become cards on phones, and printable run sheets.

## Project structure

```
server.js              Express app setup
src/db.js              SQLite schema and helpers
src/auth.js            Password hashing (scrypt), sessions, CSRF, role guards
src/jobs.js            Scheduling, dispatch, and status lifecycle
src/notify.js          In-app notifications + email outbox (Resend optional)
src/routes/            public, auth, portal (client), admin, crew, notifications
src/seed.js            Demo data
views/                 EJS templates (public, auth, portal, admin, crew, partials)
public/css/styles.css  Design system
test/                  End-to-end workflow tests (node:test)
```

## Before going live

- Testimonials on the homepage and the phone, email, and addresses are **placeholder content**. Replace them with real ones.
- Confirm the exact wording of the veteran housing giving pledge (and name partner organizations if desired) with ownership.
- Configure `RESEND_API_KEY` and a verified sending domain for real email delivery.
- Online payments are not included. Invoices are display-only, and admins mark them paid.
