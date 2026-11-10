# IN/OUT Board

A multi-tenant **clock in / clock out** board with live status tracking, admin
controls, and global search across all tenants. Built to replace a paper-style
IN/OUT board with a shared, real-time system that anyone in the office can use
from their own device.

![Original board design reference](assets/board-design.jpg)

---

## What it does

- **Clock in / out** — tap a person to log them as IN or OUT, with an exact
  timestamp recorded every time.
- **Full audit log** — every clock event is stored (who, when, in/out, notes),
  so you can see when someone clocked in and out.
- **Live status board** — shows everyone's current status (IN / OUT) grouped by
  tenant, with their last clock time.
- **Multi-tenant** — add, edit, and remove tenants (departments, offices,
  clients, locations) as separate groups of people.
- **Global search** — the clock interface searches **across all tenants** by
  person name, phone, or tenant name.
- **Admin functionality** — token-protected admin panel for managing tenants,
  people, and reviewing the clock-event history (plus an end-of-day "clock
  everyone out" reset).

---

## How it works (architecture)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Backend | Node.js built-in HTTP server | Zero npm dependencies |
| Database | SQLite via `node:sqlite` | Requires Node.js **22.5+** |
| Frontend | Vanilla HTML / CSS / JS | Served by the same process |
| Auth | Admin accounts (scrypt) + server-side sessions | HttpOnly `SameSite=Strict` cookie; public board at `/` |

### Data model

- **`tenants`** — a group (office, department, client, location) that people
  belong to.
- **`people`** — a person with a name, phone, and tenant assignment.
- **`clock_events`** — an immutable record of a clock-in or clock-out
  (`direction`, `clocked_at`, `notes`).

Current status is *derived* from the most recent clock event per person, so the
audit history is never overwritten.

### API endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/health` | Health check | — |
| GET | `/api/tenants` | List tenants | Admin |
| POST | `/api/tenants` | Add tenant | Admin |
| PUT | `/api/tenants/:id` | Edit tenant | Admin |
| DELETE | `/api/tenants/:id` | Delete tenant | Admin |
| GET | `/api/people` | List people (optional `?search=`, `?tenant_id=`) | Admin |
| POST | `/api/people` | Add person | Admin |
| PUT | `/api/people/:id` | Edit person | Admin |
| DELETE | `/api/people/:id` | Delete person | Admin |
| GET | `/api/directory?q=&tenant_id=` | The public board: every tenant with its people, status and ONLY the contact details each person chose to show. Search matches names and tenant names, never phone numbers or emails. Returns the default layout and mode too | Public |
| POST | `/api/clock` | Clock a person in/out (`person_id`, `direction`); `409` if already in that state | Public (kiosk) |
| GET/PUT | `/api/admin/settings` | Read / change `kiosk_layout` (`table`/`list`/`cards`/`tiles`/`board`) and `kiosk_mode` (`browse`/`search`) | Admin |
| POST | `/api/auth/login` | Sign in (`username`, `password`) → HttpOnly session cookie; throttled to 8 failures / 15 min / IP | Public |
| POST | `/api/auth/logout` | End the session | Session |
| GET | `/api/auth/me` | Current admin | Session |
| POST | `/api/auth/password` | Change own password (`current`, `next`, min 10 chars) | Admin |
| GET/POST | `/api/admin/users` | List / add admin accounts | Admin |
| DELETE | `/api/admin/users/:id` | Remove an admin (not yourself, not the last one) | Admin |
| GET | `/api/status` | Current status of everyone incl. phone & notes (optional `?search=`, `?tenant_id=`) | Admin |
| GET | `/api/people/:id` | Full profile of one person | Admin |
| PUT/DELETE | `/api/people/:id/photo` | Upload (raw JPEG/PNG/WebP body, max 2 MB) / remove a person's photo | Admin |
| POST | `/api/people/:id/access` | Create or reset a person's sign-in; returns `handle` + one-time `temp_password` | Admin |
| DELETE | `/api/people/:id/access` | Turn a person's sign-in off (ends their sessions) | Admin |
| POST | `/api/me/login` | Person signs in (`handle`, `password`); throttled like admin login | Public |
| POST | `/api/me/logout` | Person signs out | Person |
| GET/PUT | `/api/me` | Own profile: `title`, `office`, `phone`, `email`, `bio`, `show_office`/`show_phone`/`show_email`, `avatar_mode` (`photo`/`logo`/`initials`). Name, tenant and the manager flag are admin-only | Person |
| PUT/DELETE | `/api/me/photo` | Own photo | Person |
| POST | `/api/me/password` | Change own password (`current`, `next`, min 8 chars) | Person |
| GET | `/api/me/shifts` | Own shifts for the last 30 days | Person |
| PUT/DELETE | `/api/tenants/:id/logo` | Upload (raw PNG/JPEG/WebP, max 2 MB) / remove a tenant's logo | Admin |
| POST | `/api/admin/visibility` | Bulk-set `show_phone` / `show_email` / `show_office` for everyone or one tenant (`field`, `value`, optional `tenant_id`) | Admin |
| PUT | `/api/me/tenant` | Edit own company's office, phone, email, website (tenant managers only) | Person (manager) |
| PUT/DELETE | `/api/me/tenant/logo` | Upload / remove own company's logo (tenant managers only) | Person (manager) |
| GET | `/photos/<file>` | Serve an uploaded photo (unguessable file names) | Public |
| GET | `/api/events` | Clock-event history; filters `tenant_id`, `person_id`, `direction`, `from`, `to` (ms), `limit`, `offset`, `paged=1` | Admin |
| GET | `/api/events.csv` | Same filters, CSV export | Admin |
| POST | `/api/events` | Manual/corrected entry (`person_id`, `direction`, `clocked_at`, `notes`) | Admin |
| DELETE | `/api/events/:id` | Remove a clock event | Admin |
| GET | `/api/sessions` | IN→OUT shifts with durations + total (same filters); open shifts flagged `open` | Admin |
| GET | `/api/sessions.csv` | Shifts as CSV | Admin |
| GET | `/api/admin/overview` | Totals, per-tenant roll-up (people / in / out / time today), recent activity | Admin |
| POST | `/api/reset` | Clock everyone IN → OUT (end of day) | Admin |

---

## Two front doors

| URL | Who | What |
|-----|-----|------|
| `/` | Anyone (lobby tablet, staff phones) | The public board: all tenants, search, filters, layouts, IN/OUT buttons. |
| `/admin` | Admins only (login required) | The full console below. |

### Admin accounts & security

- Admins sign in at `/admin` with a **username and password** (scrypt-hashed). Sessions are server-side, stored hashed, last 12 hours and ride in an `HttpOnly`, `SameSite=Strict` cookie.
- The first admin is created on first start from `ADMIN_USER` / `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set, a random password is generated and printed once in the server log. Further admins are added under **Admins** in the console, where you can also change your password.
- All tenant, people, status, event and report endpoints require a session. The public board can only read the directory (showing just what each person chose to share) and clock IN/OUT.
- Login is throttled, state-changing requests reject cross-origin `Origin` headers, and the old `ADMIN_TOKEN` is gone.
- Behind HTTPS (recommended — e.g. a reverse proxy or Cloudflare tunnel) set `COOKIE_SECURE=1`, or `TRUST_PROXY=1` so `X-Forwarded-Proto/For` are honoured.

## Profiles

Everyone on the board can have a small profile that **they control** and **admins can see and edit**.

- **Photo** — shows next to their name on the public board, the live board and the people list (coloured initials if there's no photo). Photos are centre-cropped, resized to 512 px and re-encoded in the browser (which also strips EXIF/location data), then checked on the server by file signature. Only JPEG/PNG/WebP up to 2 MB are accepted; SVG is refused. Files live in `data/uploads/`.
- **Details** — job title, phone, email and a short bio.
- **Their own page at `/me`** — sign in, change the photo and details, see their last 30 days of shifts, change their password.
- **Access is opt-in.** An admin opens a person (the 👤 button on **People**) and clicks **Create sign-in**. That generates a sign-in name (e.g. `dana.whitfield`) and a one-time temporary password, shown once. On first sign-in the person must choose their own password (min 8 characters). **Reset password** issues a new temporary one; **Turn off sign-in** ends their access immediately but keeps the profile.
- **Admins** can edit any profile field, upload or remove any photo, and manage sign-in access. People can't change their own name or tenant, and a person's session can never reach admin endpoints (separate cookie, separate checks).

> Photos are served publicly by an unguessable file name, because the public board shows them to anyone who can open it. If that is too open for your site, leave photos off (people can pick *initials*), switch the board to *Search only*, or put it behind your network/tunnel access rules.

## The public board

`/` shows **every tenant (company) and who is in or out**, grouped by tenant, with each company's logo, office and contact details at the top of its section. Anyone can search, filter and clock IN/OUT.

- **Filters:** search by person or company, show Everyone / In / Out, jump to one company with the company chips.
- **Layouts** (the visitor picks; the choice is remembered on that device):

| Layout | Looks like | Good for |
|--------|-----------|----------|
| **Table** | A directory table: name, office, phone, email, status and a button | Reading contact details at a glance (the default) |
| **List** | One roomy row per person | Small screens |
| **Cards** | Photo-forward cards in a grid | Recognising people by face |
| **Tiles** | Big colour-coded tiles; the whole tile is the button | Wall tablets and touch screens |
| **Board** | Classic in/out board with IN and OUT columns | Anyone used to the paper board |

- **Admin defaults** (Admin > Settings): the layout people see first, and whether the board **shows everyone** or is **search only** (visitors must type a name to see anyone; best for a shared tablet). Add `?layout=tiles` to one tablet's address to force a layout on that device.
- **Text size:** visitors can switch between normal, large and extra-large text; it is remembered on that device.

### What each person shows (privacy by choice)

A person's **name, job title, picture and IN/OUT status** are always shown. Everything else is opt-in and controlled by the person (at `/me`) or an admin:

| Detail | Default | Who can change it |
|--------|---------|-------------------|
| Office / suite | shown (if filled in) | the person, an admin |
| Phone | **hidden** | the person, an admin |
| Email | **hidden** | the person, an admin |
| Picture | their photo | the person, an admin: *photo*, *company logo* or *initials* |

Admins can switch a detail on or off for many people at once (People > "Visibility for many...", for everyone or one tenant). The admin Live Board always shows everything, whatever a person shares publicly. Search never matches phone numbers or emails.

### Tenants and company logos

Each tenant has a logo and company details (office, phone, email, website) shown on its section. Admins manage them under **Tenants**. An admin can also mark a person as a **tenant manager** (People > profile): that person can then keep their own company's logo and details up to date from `/me`, without being an admin.

### Accessibility

Built to be usable by everyone: full keyboard operation with visible focus and a skip link; screen-reader labels and live status announcements; every IN/OUT status carries a text label (never colour alone); 44px minimum touch targets; text that scales (browser zoom or the A / A+ / A++ control); light and dark colour schemes that meet contrast requirements; reduced-motion and high-contrast support; dialogs that trap and restore focus. The pages pass automated axe-core (WCAG 2.1 A/AA) checks in every layout.

## Admin dashboard

The admin console has a sidebar:

- **Live Board** — everyone grouped by tenant with phone, status, last clock and notes; auto-refreshes every 30 seconds.
- **Admins** — add/remove admin accounts, change your password.

- **Overview** — people in/out right now, time logged today, a per-tenant table and a live activity feed, plus the end-of-day "clock everyone OUT" action.
- **Tenants** — a card per tenant with people / in / out / time-today. Add, edit and delete tenants in a dialog; jump straight to a tenant's time log.
- **People** — searchable, tenant-filterable table with live status. Add, edit, deactivate and delete people.
- **Time Log** — pick a range (today, this week, last 7 days, month, custom), tenant and person. View **Shifts** (paired IN→OUT with durations; someone still IN shows "so far") or **Raw events**. Export either as CSV. Admins can add a manual entry (e.g. someone forgot to clock out) or delete a bad event.


## Getting started

### Prerequisites

- Node.js **22.5 or later** (for the built-in `node:sqlite` module).

### Run locally

```bash
cd inout-board
ADMIN_USER=jordan ADMIN_PASSWORD='a-long-passphrase' node server.js
```

Then open <http://localhost:3000>.

- **Kiosk** at `/` — public; search your name, tap IN or OUT.
- **Admin console** at `/admin` — sign in with the admin account created on
  first start (`ADMIN_USER` / `ADMIN_PASSWORD`; a random password is printed
  once if you don't set one).

The SQLite database is created automatically at `data/inout.sqlite` (gitignored)
and is seeded with a default **"Main Office"** tenant plus the original board
roster on first run.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_USER` | `admin` | Username of the first admin (only used when no admins exist) |
| `ADMIN_PASSWORD` | random, printed once | Password of the first admin |
| `COOKIE_SECURE` | unset | Set `1` to mark the session cookie `Secure` (use behind HTTPS) |
| `TRUST_PROXY` | unset | Set `1` behind a reverse proxy to honour `X-Forwarded-For/Proto` |

---

## Project layout

```
inout-board/
├── server.js          # Backend: HTTP server + SQLite + API
├── package.json
├── .gitignore
├── assets/
│   └── board-design.jpg   # Original design reference photo
├── public/
│   ├── index.html      # Public board (all tenants, filters, layouts, IN/OUT)
│   ├── home.js
│   ├── prefs.js        # Applies the saved text size before first paint
│   ├── me.html         # Person profile page (served at /me)
│   ├── me.js
│   ├── shared.js       # Avatars + client-side photo resize/upload
│   ├── admin.html      # Admin console shell (served at /admin)
│   ├── app.js          # Admin console logic (login, board, tenants, people, log, admins)
│   └── style.css
└── data/               # SQLite DB + uploads/ photos (created at runtime, gitignored)
```

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for Docker, plain Node/systemd, Cloudflare Tunnel, HTTPS, backups/restore and upgrading. `docker compose up -d` is the quickest route. The `deploy` branch also carries a CI workflow (`npm test`) and a workflow that publishes a container image to GitHub Container Registry.

## Deployment notes

The app is intentionally **self-contained and dependency-free** so it can run
anywhere Node.js runs: a small VPS, a Raspberry Pi on the office network, a
container, or a PaaS. For production:

1. Set a strong `ADMIN_PASSWORD` on first start (then add per-person admins and change it).
2. Put it behind HTTPS (reverse proxy such as nginx/Caddy, or the PaaS TLS).
3. Set `COOKIE_SECURE=1` (and `TRUST_PROXY=1` if behind a proxy). Only give admin accounts to trusted staff.

> Deployment target is TBD — the code is being finalized in this repo first,
> before selecting where to host it for presentation.

---

## Status

✅ Core features implemented: multi-tenant clock in/out, SQLite persistence,
live status board, admin panel, and global search.

Next up: deploy to a shared host for live use.
