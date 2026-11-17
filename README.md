# IN/OUT Board

**A simple, self-hosted board that shows who is in and who is out** — for offices, plazas and shared buildings.
Every tenant on one page, each person choosing what they share, five layouts, CSV import/export, and an admin
console with a time log. One Node.js process and one SQLite file; no database server and no `npm install`.

[![CI](https://github.com/jmason84/inout-board/actions/workflows/ci.yml/badge.svg)](https://github.com/jmason84/inout-board/actions/workflows/ci.yml)

### 👉 [Try the live demo](https://jmason84.github.io/inout-board/app/index.html) &nbsp;·&nbsp; [Project site](https://jmason84.github.io/inout-board/)

## Downloads and installation

| Platform | Quick links | Status |
|----------|-------------|--------|
| **Windows x64 — latest installer (1.0.24)** | **[Download Setup EXE](https://github.com/jmason84/inout-board/actions/runs/44042496793/artifacts/14309728770)** · **[Download MSI](https://github.com/jmason84/inout-board/actions/runs/44042496793/artifacts/14311175076)** | Latest successful Windows installer build, verified November 17, 2026. Both installers passed the Windows installation, upgrade and uninstall checks. Source changes are in [PR #10](https://github.com/jmason84/inout-board/pull/10), pending merge into `main`. |
| **Linux — Docker Compose or systemd** | **[Installation instructions](#deploying-on-linux)** · [Compose file](docker-compose.yml) | Current installation methods on `main`; no packaged Linux installer release is published. |
| **Linux — one-step installer preview** | [Installer script](https://github.com/jmason84/inout-board/blob/codex/linux-deployment/deploy/install.sh) · [Preview installation instructions](https://github.com/jmason84/inout-board/blob/codex/linux-deployment/README.md#deploying-on-linux) | Available on `codex/linux-deployment`; not merged into `main` and not yet tested on a real Linux server. |

**Windows installation:** Requires 64-bit Windows and administrator access. Choose **Setup EXE** for a normal installation or **MSI** for IT deployment. GitHub Actions downloads require a GitHub sign-in and arrive as ZIP files. Right-click the ZIP → **Extract All**, open the extracted folder, then run the EXE or MSI and approve the administrator prompt. The installers are unsigned, so Windows may display a publisher or SmartScreen warning. These artifacts expire on February 15, 2027. For newer builds, use the **[Windows installer build list](https://github.com/jmason84/inout-board/actions/workflows/windows.yml?query=is%3Asuccess)** and select the newest successful run for your branch, then its MSI or Setup EXE under **Artifacts**.

**[Latest published release](https://github.com/jmason84/inout-board/releases/latest):** currently the older v1.0 delivery ZIP; it does not contain the Windows MSI/EXE or the Linux one-step installer.

<p align="center"><img src="docs/screenshots/home-table.png" alt="The public board in table layout, listing each tenant with its logo, office, phone and email, and an IN or OUT button for each person" width="900"></p>

> The demo runs the real front end against a small in-browser backend with made-up people, because GitHub Pages can only serve static files. Admin sign-in is `demo` / `demo`. Nothing leaves your browser.

---

## Contents

[Downloads and installation](#downloads-and-installation) · [Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [How it works](#how-it-works) · [CSV import and export](#csv-import-and-export) · [Configuration](#configuration) · [API](#api-endpoints) · [Development](#development) · [Deploying on Linux and Windows](#deploying) · [Roadmap](#roadmap)

## Features

- **One public board for the whole building.** Each company appears with its logo, office and contact details, then its people with a clear **IN / OUT** status and one big button. Search, In/Out filter, company chips.
- **Privacy by choice.** Name, title, picture and status are always shown. Office, phone and email appear only when the person (or an admin) switches them on; phone and email are hidden by default. Search never matches phone numbers or emails.
- **Photo, company logo or initials** next to each name, chosen by the person. **Tenant managers** keep their own company's logo and details up to date without being admins.
- **Five layouts** — table, list, cards, tiles, and the classic in/out board — chosen by the visitor; the admin sets the default. Large-text and dark modes included; the admin can set Light / Dark / System under settings and each browser remembers its own choice.
- **People manage their own profile** at `/me`: picture, title, office, phone, email, what is shared, their recent shifts, password. A live preview shows how they will appear.
- **Admin console:** overview, live board, tenants, people, time log (shifts and hours, CSV export, manual corrections), per-admin accounts, settings.
- **CSV import and export of all people**, with a preview and plain-English problem list before anything is written.
- **Accessible by design:** keyboard friendly, screen-reader labels, text statuses (never colour alone), 44 px targets, scalable text, reduced-motion and high-contrast support. Automated axe-core (WCAG 2.1 A/AA) checks pass on every page and layout.
- **Self-hosted and dependency-free.** Docker, systemd, backup and restore are included.

## Screenshots

All screenshots show fictional people and are generated by `npm run screenshots`.

<table>
<tr>
<td width="50%"><b>Cards</b><br><img src="docs/screenshots/home-cards.png" alt="Board in cards layout"></td>
<td width="50%"><b>Tiles</b> (for a wall tablet)<br><img src="docs/screenshots/home-tiles.png" alt="Board in tiles layout"></td>
</tr>
<tr>
<td><b>Classic board</b><br><img src="docs/screenshots/home-board.png" alt="Board in classic in/out board layout"></td>
<td><b>List</b><br><img src="docs/screenshots/home-list.png" alt="Board in list layout"></td>
</tr>
<tr>
<td><b>On a phone</b><br><img src="docs/screenshots/home-mobile.png" alt="Board on a phone" width="260"></td>
<td><b>Dark mode</b><br><img src="docs/screenshots/home-dark.png" alt="Board in dark mode"></td>
</tr>
<tr>
<td><b>My profile</b> (each person's own page)<br><img src="docs/screenshots/me-profile.png" alt="A person's own profile page with picture and visibility options and a live preview"></td>
<td><b>Large text</b><br><img src="docs/screenshots/home-large-text.png" alt="Board with large text turned on"></td>
</tr>
</table>

**Admin console**

<table>
<tr>
<td width="50%"><b>Overview</b><br><img src="docs/screenshots/admin-overview.png" alt="Admin overview"></td>
<td width="50%"><b>Live board</b><br><img src="docs/screenshots/admin-live-board.png" alt="Admin live board"></td>
</tr>
<tr>
<td><b>Tenants</b><br><img src="docs/screenshots/admin-tenants.png" alt="Admin tenants"></td>
<td><b>People</b><br><img src="docs/screenshots/admin-people.png" alt="Admin people with CSV buttons"></td>
</tr>
<tr>
<td><b>CSV import preview</b><br><img src="docs/screenshots/admin-csv-import.png" alt="CSV import preview with new, updated and skipped rows"></td>
<td><b>Profile dialog</b><br><img src="docs/screenshots/admin-profile.png" alt="Admin profile dialog"></td>
</tr>
<tr>
<td><b>Time log</b><br><img src="docs/screenshots/admin-time-log.png" alt="Admin time log"></td>
<td><b>Settings</b><br><img src="docs/screenshots/admin-settings.png" alt="Admin settings"></td>
</tr>
</table>

## Quick start

Pick your platform. Every option is one Node.js process plus one folder of data (a SQLite file and photos): no database server and no `npm install`.

| You have | Easiest way | Port | Protocol | Full steps |
|----------|-------------|------|----------|------------|
| **Windows** PC or server | MSI or Setup EXE installer | **8443** | **HTTPS** (built-in) | [Deploying on Windows](#deploying-on-windows) |
| **Linux** server or VM | Docker Compose | 3000 | HTTP (HTTPS optional) | [Deploying on Linux](#deploying-on-linux) |
| Just want to try it | `node server.js` on any OS (Node.js 22.5+) | 3000 | HTTP | below |

> **Platform comparison.** The Windows installer is a one-click experience: HTTPS on port 8443, `admin` / `admin` login with forced change, nightly backups and firewall all configured automatically. Linux Docker currently requires a few manual steps and defaults to plain HTTP on port 3000. Improving the Linux experience is tracked in [issue #6](https://github.com/jmason84/inout-board/issues/6) — the code already supports `HTTPS=auto` on Linux, it just is not the Docker default yet.

```bash
git clone https://github.com/jmason84/inout-board.git
cd inout-board
ADMIN_USER=admin ADMIN_PASSWORD='a-long-passphrase' node server.js     # macOS / Linux
```

```powershell
git clone https://github.com/jmason84/inout-board.git
cd inout-board
$env:ADMIN_USER='admin'; $env:ADMIN_PASSWORD='a-long-passphrase'; node server.js     # Windows PowerShell
```

Then open <http://localhost:3000>.

- **Public board:** `/` &nbsp;·&nbsp; **Admin console:** `/admin` &nbsp;·&nbsp; **A person's own page:** `/me`
- The first admin comes from `ADMIN_USER` / `ADMIN_PASSWORD` on the very first start (a random password is printed once if you do not set one). Add more admins in the console.
- Want to look around with sample data first? `BASE=http://localhost:3000 ADMIN_USER=admin ADMIN_PASSWORD=... npm run seed:demo` fills a **new or throwaway** database with a fictional plaza (it removes the built-in sample tenant).

## How it works

| Layer | Technology | Notes |
|-------|-----------|-------|
| Backend | Node.js built-in HTTP server | Zero npm dependencies |
| Database | SQLite via `node:sqlite` | One file (plus an `uploads/` folder for pictures) |
| Frontend | Vanilla HTML / CSS / JS | Served by the same process, no build step |
| Auth | Admin accounts (scrypt) + server-side sessions; separate sign-in for people | `HttpOnly` `SameSite=Strict` cookies; login throttling; CSRF guard |

**Data model:** `tenants` (company, logo, office, contact details) → `people` (name, title, office, phone, email, what is shown, picture choice, optional sign-in) → `clock_events` (immutable IN/OUT records). A person's status is derived from their latest event, so history is never overwritten. Also `admin_users`, `sessions`, `person_sessions` and `settings`.

### The public board

`/` lists every tenant and who is in or out. Visitors can search, filter (Everyone / In / Out), jump to a company, change the layout (remembered per device), and change the text size. Admins choose the default layout and whether the board **shows everyone** or is **search only** (visitors must type a name to see anyone; best for a shared tablet) under Settings. Add `?layout=tiles` to one tablet's address to force a layout on that device.

### What each person shows

| Detail | Default | Who can change it |
|--------|---------|-------------------|
| Name, job title, picture, IN/OUT status | always shown | — |
| Office / suite | shown (if filled in) | the person, an admin |
| Phone | **hidden** | the person, an admin |
| Email | **hidden** | the person, an admin |
| Picture | their photo | the person, an admin: *photo*, *company logo* or *initials* |

Admins can switch a detail on or off for many people at once (People → *Visibility for many…*). The admin live board always shows everything. Pictures are resized in the browser (which also strips location data), checked by file signature on the server, and limited to JPEG/PNG/WebP up to 2 MB.

### People, sign-ins and tenant managers

Sign-in at `/me` is opt-in: an admin clicks **Create sign-in** on a person, which generates a sign-in name and a one-time temporary password; the person must choose their own password on first sign-in. An admin can also mark a person as a **tenant manager**, who can then edit their company's logo, office, phone, email and website. People cannot change their own name, tenant or manager flag, and a person's session can never reach admin endpoints.

### Admin console

Overview (who is in, time today, activity feed, end-of-day clock-out) · Live Board (any layout, refreshes itself) · Tenants (logo, details, live counts) · People (search, edit, profile, bulk visibility, CSV) · Time Log (shifts and hours by person or tenant, raw events, CSV export, manual entries, deletions) · Admins · Settings.

## CSV import and export

**People → Export CSV** downloads everyone (including inactive people) as UTF-8 with a byte-order mark, so Excel and Google Sheets open accents correctly. **People → Import CSV** reads a file, shows a preview ("2 new, 1 updated, 2 skipped" plus a list of problem rows), and only writes when you confirm. **CSV template** downloads a starter file.

| Column | Meaning |
|--------|---------|
| `name` | **Required.** |
| `tenant` | Company name. Created automatically if it does not exist yet. If the column is missing the importer asks which tenant to use. |
| `title`, `office`, `phone`, `email`, `bio` | Plain text. `email` must look like an email address. |
| `active` | `yes` / `no` (also `true`/`false`, `1`/`0`). |
| `show_office`, `show_phone`, `show_email` | `yes` / `no`: whether that detail is public. |
| `avatar_mode` | `photo`, `logo` or `initials`. |
| `manager` | `yes` / `no`: tenant manager. |
| `id` | Optional. Exported files include it so re-importing updates the same people. |

Rules:

- **Existing people are updated, not duplicated.** A row matches by `id` if present, otherwise by name within the tenant (case-insensitive). Importing the same file twice changes nothing.
- **A column that is in the file is authoritative**: a blank cell clears that value. **A column that is not in the file is left alone**, so a short file with just `name,tenant,phone` only touches phones.
- Friendly headers work: `Company`, `Full name`, `Job title`, `Suite`, `Telephone`, `E-mail`, `Show phone`, and similar. Comma, semicolon and tab separated files are detected automatically; quoted fields may contain commas and line breaks.
- Rows with problems (empty name, invalid email, unrecognised yes/no) are skipped and reported with their row number; the rest import in one transaction. Limit: 5,000 rows / 2 MB per file.
- Exports prefix values that start with `=`, `+`, `-` or `@` with an apostrophe so spreadsheets cannot run them as formulas; the importer removes that apostrophe again.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` (`8443` on Windows) | HTTP port (or HTTPS port when `HTTPS=auto`) |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Where the SQLite file and uploaded pictures live |
| `ADMIN_USER` | `admin` | Username of the first admin (only used when no admins exist) |
| `ADMIN_PASSWORD` | random, printed once | Password of the first admin |
| `COOKIE_SECURE` | unset | Set `1` behind HTTPS so cookies are `Secure` |
| `TRUST_PROXY` | unset | Set `1` behind a proxy/tunnel to honour `X-Forwarded-*` |
| `ALLOWED_ORIGINS` | unset | Extra origins allowed to POST (rarely needed) |
| `INOUT_ENV_FILE` | unset | Path to a `KEY=VALUE` settings file (used by the Windows installer). Real environment variables win over the file |
| `PREFERRED_ADDRESS` | active route | Which address is listed first in the startup links. Only changes the display; the app still listens on every address |
| `PUBLIC_SCHEME` / `PUBLIC_PORT` | `http` (`https` with built-in TLS) / `PORT` | How the startup links are written when HTTPS is terminated in front of the app |
| `HTTPS` | unset | `auto`: serve HTTPS directly with a private CA and a certificate for this machine's addresses (CA at `/ca.crt`) |
| `TLS_DIR` | `DATA_DIR/tls` | Where the private CA and server certificate are kept (`HTTPS=auto`) |
| `TLS_CERT` / `TLS_KEY` | unset | Your own certificate and key files; used instead of `HTTPS=auto`, re-read every 6 hours |

## API endpoints

Public endpoints are limited to the directory (showing only what people chose to share) and clocking in/out; everything else needs an admin or person session.

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/health` | Health check | — |
| GET | `/api/tenants` | List tenants | Admin |
| POST | `/api/tenants` | Add tenant | Admin |
| PUT | `/api/tenants/:id` | Edit tenant | Admin |
| DELETE | `/api/tenants/:id` | Delete tenant | Admin |
| GET | `/api/people` | List people (optional `?search=`, `?tenant_id=`) | Admin |
| GET | `/api/people.csv` | Export every person (all settings) as CSV, UTF-8 with BOM for Excel | Admin |
| POST | `/api/people/import?dry_run=1&default_tenant_id=` | Import people from a CSV body (`text/csv`); `dry_run=1` validates and reports without writing | Admin |
| POST | `/api/people` | Add person | Admin |
| PUT | `/api/people/:id` | Edit person | Admin |
| DELETE | `/api/people/:id` | Delete person | Admin |
| GET | `/api/directory?q=&tenant_id=` | The public board: every tenant with its people, status and ONLY the contact details each person chose to show. Search matches names and tenant names, never phone numbers or emails. Returns the default layout and mode too | Public |
| POST | `/api/clock` | Clock a person in/out (`person_id`, `direction`); `409` if already in that state | Public |
| GET/PUT | `/api/admin/settings` | Read / change `kiosk_layout` (`table`/`list`/`cards`/`tiles`/`board`), `kiosk_mode` (`browse`/`search`) and `theme` (`light`/`dark`/`system`) | Admin |
| GET | `/api/admin/update-check` | Check GitHub for a newer release (cached 1 h). Returns `update_available`, versions and release URL | Admin |
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

## Development

```bash
npm test               # 19 end-to-end checks against a throwaway server (node:test not needed)
npm run seed:demo      # fictional demo data into a running server (see Quick start)
npm run screenshots    # regenerates docs/screenshots (needs: npm i --no-save playwright && npx playwright install chromium)
npm run build:pages    # builds the GitHub Pages site into ./_site
```

```
inout-board/
├── server.js              # HTTP server + SQLite + API (single file, no dependencies)
├── public/                # the front end: index.html + home.js (board), me.* (profile), admin.html + app.js, shared.js, style.css
├── pages/                 # GitHub Pages: landing page and the in-browser demo backend (demo-api.js)
├── scripts/               # backup.js, seed-demo.js, screenshots.js, build-pages.js
├── test/smoke.js          # end-to-end tests
├── docs/screenshots/      # the images above
├── deploy/                # systemd unit, Caddyfile example
├── .github/workflows/     # ci.yml (tests), docker.yml (image to GHCR), pages.yml (site)
├── Dockerfile, docker-compose.yml, .env.example, DEPLOY.md
└── data/                  # created at runtime (gitignored)
```

## Deploying

Two things apply everywhere:

- **Back up the data folder** (`inout.sqlite` and `uploads/`) with `node scripts/backup.js <folder>`; it is safe while the app runs. Do not copy the live database file by hand.
- **Use HTTPS** for anything beyond a trusted office network, and set `COOKIE_SECURE=1` when you do (sign-in silently fails over plain `http://` if you set it without HTTPS).

More detail, troubleshooting and the security checklist are in **[DEPLOY.md](DEPLOY.md)**.

### Deploying on Linux

**Option 1: Docker Compose (recommended).** Needs Docker with the Compose plugin. Defaults to **plain HTTP on port 3000**.

```bash
git clone https://github.com/jmason84/inout-board.git
cd inout-board
cp .env.example .env          # set ADMIN_USER and a strong ADMIN_PASSWORD
docker compose up -d          # http://<server-ip>:3000  and  /admin
```

- Data lives in the `inout-board_inout-data` Docker volume and survives restarts and upgrades.
- Update: back up, then `git pull && docker compose up -d --build`.
- **Built-in HTTPS (like the Windows installer):** add `HTTPS=auto` and `PORT=8443` to `.env`, change `HOST_PORT=8443`, and set `COOKIE_SECURE=1`. The board creates its own private CA; other devices install it once from `https://<server-ip>:8443/ca.crt` (see the Windows section for per-device instructions).
- Free HTTPS without opening ports: `docker compose --profile tunnel up -d` with a Cloudflare Tunnel token (set `TUNNEL_TOKEN`, `COOKIE_SECURE=1`, `TRUST_PROXY=1` in `.env`).
- Prebuilt image: pushing the `deploy` branch or a `v*` tag publishes `ghcr.io/jmason84/inout-board` (`.github/workflows/docker.yml`).

**Option 2: Node.js and systemd** (Node.js 22.5 or newer). Defaults to **plain HTTP on port 3000**; see the HTTPS note below to match the Windows experience.

```bash
sudo useradd --system --home /opt/inout-board --shell /usr/sbin/nologin inout
sudo mkdir -p /opt/inout-board /var/lib/inout-board
sudo cp -r server.js package.json public assets scripts /opt/inout-board/
sudo chown -R inout:inout /var/lib/inout-board

sudo tee /etc/inout-board.env >/dev/null <<'EOF'
PORT=3000
ADMIN_USER=admin
ADMIN_PASSWORD=change-this-long-passphrase
# For built-in HTTPS (same as the Windows installer), uncomment:
# HTTPS=auto
# PORT=8443
# COOKIE_SECURE=1
EOF
sudo chmod 600 /etc/inout-board.env

sudo cp deploy/inout-board.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now inout-board
journalctl -u inout-board -f
```

**HTTPS on Linux:** either set `HTTPS=auto` in the env file (the board creates its own private CA and certificate, the same way the Windows installer does; devices install `https://<host>:<port>/ca.crt` once — see the Windows section for per-device steps) or put Caddy or nginx in front and set `TRUST_PROXY=1` and `COOKIE_SECURE=1`. A ready Caddy config with automatic certificates is in [`deploy/Caddyfile.example`](deploy/Caddyfile.example).

**Nightly backup (cron):** `15 2 * * *  cd /opt/inout-board && DATA_DIR=/var/lib/inout-board node scripts/backup.js /var/backups/inout-board` (keeps 14; copy them off the machine too).

### Deploying on Windows

Use the **[download links at the top of this README](#downloads-and-installation)** for the latest verified Windows installers. For subsequent builds, open the [Windows installer build list](https://github.com/jmason84/inout-board/actions/workflows/windows.yml?query=is%3Asuccess), select a successful run for your branch, and download its MSI or Setup EXE under **Artifacts**:

- `InOutBoard-<version>-x64.msi`: for IT, scripting and silent installs.
- `InOutBoard-Setup-<version>-x64.exe`: double-click installer that wraps the same MSI.

Node.js is inside the package and the board serves HTTPS itself; there is nothing else to install.

```powershell
# interactive: double-click the EXE or MSI, or silent (run as Administrator):
msiexec /i InOutBoard-1.0.0-x64.msi /qn
# choose the HTTPS port and also serve the public WAN address:
msiexec /i InOutBoard-1.0.0-x64.msi /qn TLSPORT=443 EXTRAADDRESSES=203.0.113.7
# remove the program (your data is kept):
msiexec /x InOutBoard-1.0.0-x64.msi /qn
```

What you get:

- The board starts at boot and restarts itself if it stops. It serves HTTPS (default port **8443**) on every address of the PC, and only that one TCP port is opened in Windows Firewall.
- Open `https://<this-PC-IP>:8443/` (admin at `/admin`). Addresses are re-discovered at every start and checked every minute, so a changed IP gets a matching certificate without a restart. Run `InOutBoard.ps1 -Action Status` (in `C:\Program Files\IN-OUT Board`) to list every URL.
- Everything you would back up or edit is in `C:\ProgramData\InOutBoard\`: `inout-board.env` (settings), `data\` (database and photos), `backups\` (nightly at 02:15, keeps 14) and `logs\`. Upgrades and normal uninstalls keep that folder so your data survives. To remove everything including the database, run `InOutBoard.ps1 -Action Purge` from an elevated prompt, or pass `PURGEDATA=1` to the MSI uninstall (`msiexec /x {ProductCode} PURGEDATA=1`).
- First sign-in: user `admin`, password `admin`. The board makes you choose a new password (10 or more characters) before anything else works, so do this straight after installing and before exposing the board beyond your office network. Every fresh install (including reinstalling over leftover data) resets the admin to `admin` / `admin` with forced change; upgrades keep your existing password.
- Upgrade by running a newer MSI or EXE over the old one.
- **Updates in the app:** open **Admin → Settings → Software updates**, choose **Check for updates**, then **Update now** when a newer Windows release is available. The installed Windows edition downloads the release MSI, verifies its SHA-256 checksum, backs up the data and configuration, and runs the upgrade. The board briefly restarts; your admin password and existing data are kept. This uses published GitHub Releases, not unpublished commits or Actions artifacts. Install this updater-enabled version manually once to enable the button on older installations.
- Stop, restart and uninstall require administrator rights. Uninstall stops the app and its supervisor before removing files; normal uninstall keeps your data. It does not stop unrelated software that uses the same port.

**HTTPS and certificates.** HTTPS on a bare IP address needs a certificate for that exact IP, so the installer creates a private certificate authority on the PC. **This PC trusts it automatically** (a normal padlock in Chrome and Edge). **Other devices** download it from the board itself: open `https://<this-PC-IP>:8443/ca.crt` (the browser warns once, that is expected), then install it:

Install it once on each device (without it the connection is still encrypted, but the browser warns):

- **Windows:** double-click the file, *Install Certificate*, *Local Machine*, place it in *Trusted Root Certification Authorities*.
- **macOS:** open the file, add it to *Keychain Access*, then set it to *Always Trust*.
- **iPhone / iPad:** open the link in Safari and allow the download, install the profile in *Settings*, then turn it on under *Settings, General, About, Certificate Trust Settings*.
- **Android:** *Settings, Security, Encryption & credentials, Install a certificate, CA certificate*.
- **Firefox** keeps its own list: set `security.enterprise_roots.enabled` to `true` in `about:config` to use the Windows one.

To use a publicly trusted certificate for a public IP instead, set `TLS_CERT` and `TLS_KEY` (paths to the certificate and key files) in `inout-board.env` and restart. The files are re-read every 6 hours, so a renewed certificate is picked up without a restart. Automatic renewal of short-lived public IP certificates is not built in yet.

**Reaching it from outside the office.** Reserve the PC's LAN address in your router (DHCP reservation), forward one public HTTPS port to the same port on the PC, and test from a device outside your network. If your ISP uses carrier-grade NAT, use a VPN or tunnel instead. Anyone who can open the board can still clock anyone in or out, so do not rely on internet exposure until the per-person PIN (see Roadmap) exists.

**Other devices cannot connect, but this PC can?** Run `InOutBoard.ps1 -Action Status` from an *elevated* PowerShell. It checks that the port is listening on all addresses, that the firewall rule exists on every network profile, and that HTTPS answers on each address. If those pass, the cause is outside the PC: router *AP / client isolation* or a guest network, a different subnet or VPN, or a third-party antivirus firewall. Test from the other device with `https://<this-PC-IP>:8443/api/health`; you should see `{"ok":true,...}` after the certificate warning. (Reaching the PC's own IP address from the PC never goes through the firewall, so it proves nothing about other devices.)

The installers are not code-signed yet, so Windows SmartScreen shows a warning on first run. To build them yourself: `powershell -File windows\build.ps1 -Version 1.0.0` on Windows with the WiX CLI (see the script header).

### Also published from this repository

- **GitHub Pages** (landing page + live demo): pushing to `main` runs `.github/workflows/pages.yml`. One-time setup: *Settings → Pages → Build and deployment → Source: GitHub Actions*. The site contains only fictional demo data.

## Roadmap

Ideas, roughly in order of value: an optional per-person PIN at the kiosk; more statuses (lunch, meeting, remote) and a return time / comment; a read-only wall-TV display mode; scheduled automatic end-of-day clock-out; an admin audit log; an emergency "who is in the building" printout; alerts when someone has not clocked back.

## Privacy note for forks and public copies

The built-in first-run sample ("Main Office" with 11 names) and `assets/board-design.jpg` come from a real office board. Remove them before publishing a copy of this repository: replace the seed in `server.js` and delete the image. The screenshots, demo and `npm run seed:demo` data are fictional.
