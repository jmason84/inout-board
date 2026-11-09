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
| Auth | Static admin token | `ADMIN_TOKEN` env var |

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
| GET | `/api/tenants` | List tenants | — |
| POST | `/api/tenants` | Add tenant | Admin |
| PUT | `/api/tenants/:id` | Edit tenant | Admin |
| DELETE | `/api/tenants/:id` | Delete tenant | Admin |
| GET | `/api/people` | List people (optional `?search=`, `?tenant_id=`) | — |
| POST | `/api/people` | Add person | Admin |
| PUT | `/api/people/:id` | Edit person | Admin |
| DELETE | `/api/people/:id` | Delete person | Admin |
| POST | `/api/clock` | Clock a person in/out (`person_id`, `direction`) | — |
| GET | `/api/status` | Current status of everyone (optional `?search=`, `?tenant_id=`) | — |
| GET | `/api/events` | Clock-event history; filters `tenant_id`, `person_id`, `direction`, `from`, `to` (ms), `limit`, `offset`, `paged=1` | Admin |
| GET | `/api/events.csv` | Same filters, CSV export | Admin |
| POST | `/api/events` | Manual/corrected entry (`person_id`, `direction`, `clocked_at`, `notes`) | Admin |
| DELETE | `/api/events/:id` | Remove a clock event | Admin |
| GET | `/api/sessions` | IN→OUT shifts with durations + total (same filters); open shifts flagged `open` | Admin |
| GET | `/api/sessions.csv` | Shifts as CSV | Admin |
| GET | `/api/admin/overview` | Totals, per-tenant roll-up (people / in / out / time today), recent activity | Admin |
| POST | `/api/reset` | Clock everyone IN → OUT (end of day) | Admin |

---

## Admin dashboard

The Admin tab is a small dashboard with a sidebar:

- **Overview** — people in/out right now, time logged today, a per-tenant table and a live activity feed, plus the end-of-day "clock everyone OUT" action.
- **Tenants** — a card per tenant with people / in / out / time-today. Add, edit and delete tenants in a dialog; jump straight to a tenant's time log.
- **People** — searchable, tenant-filterable table with live status. Add, edit, deactivate and delete people.
- **Time Log** — pick a range (today, this week, last 7 days, month, custom), tenant and person. View **Shifts** (paired IN→OUT with durations; someone still IN shows "so far") or **Raw events**. Export either as CSV. Admins can add a manual entry (e.g. someone forgot to clock out) or delete a bad event.

The clock screen has a search across all tenants, tenant filter chips, a per-person "Return / comments" note saved with the clock event, and a single big IN/OUT button. The status board auto-refreshes every 30 seconds.

## Getting started

### Prerequisites

- Node.js **22.5 or later** (for the built-in `node:sqlite` module).

### Run locally

```bash
cd inout-board
ADMIN_TOKEN=change-me-admin-token node server.js
```

Then open <http://localhost:3000>.

- **Clock view** — no token needed; this is the shared kiosk/terminal screen.
- **Status board** — no token needed; this is the "someone on the other end"
  read-only view.
- **Admin** — unlock with the `ADMIN_TOKEN` value.

The SQLite database is created automatically at `data/inout.sqlite` (gitignored)
and is seeded with a default **"Main Office"** tenant plus the original board
roster on first run.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_TOKEN` | `change-me-admin-token` | Admin auth token (change in production!) |

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
│   ├── index.html      # Single-page app shell
│   ├── style.css
│   └── app.js          # Frontend logic (clock, status, admin)
└── data/               # SQLite DB (created at runtime, gitignored)
```

---

## Deployment notes

The app is intentionally **self-contained and dependency-free** so it can run
anywhere Node.js runs: a small VPS, a Raspberry Pi on the office network, a
container, or a PaaS. For production:

1. Set a strong `ADMIN_TOKEN`.
2. Put it behind HTTPS (reverse proxy such as nginx/Caddy, or the PaaS TLS).
3. Restrict the admin token to trusted staff.

> Deployment target is TBD — the code is being finalized in this repo first,
> before selecting where to host it for presentation.

---

## Status

✅ Core features implemented: multi-tenant clock in/out, SQLite persistence,
live status board, admin panel, and global search.

Next up: deploy to a shared host for live use.
