# Changelog

## Unreleased (codex/windows-slim)
- Smaller and leaner Windows package: the board serves HTTPS itself (`HTTPS=auto`, `scripts/tlscert.js`, no dependencies), so Caddy is no longer bundled. One scheduled task and one port instead of two; certificates follow IP changes without a restart. Existing installs keep their CA (devices do not need to re-install it) and their port; settings are converted once and the old file is kept as `inout-board.env.before-https-builtin`.
- Static assets are gzip-compressed; MSI uses high compression; no `.wixpdb` is published; MSI and EXE are separate artifacts; `NODE_VERSION` pins the bundled Node; CI prints installer and payload sizes.
- `TLS_CERT` / `TLS_KEY` replace `TLS_CERT_FILE` / `TLS_KEY_FILE` (converted automatically).

## Unreleased (codex/windows-fixes)
- `scripts/reset-admin.js` and `InOutBoard.ps1 -Action ResetAdmin` reset or create an admin (default `admin` / `admin`, forced change) without touching other admins. A settings file from an older install with a blank `ADMIN_PASSWORD` now follows the `admin` default when no database exists yet.
- Windows: first sign-in is `admin` / `admin`; the account is flagged and the board refuses everything except choosing a new password (10+ characters) until it is changed. The same flag works anywhere via `ADMIN_MUST_CHANGE=1`.
- Windows: the board's private CA is trusted on the PC automatically (machine-wide, removed again on uninstall) and downloadable by other devices at `/ca.crt`.
- Windows: the firewall rule opens the HTTPS port by number on every network profile; HTTP/3 (UDP) is off so only one TCP port is needed; the HTTPS front end restarts itself when the PC's IP address changes; the installer confirms HTTPS answers on every address.
- Windows: `InOutBoard.ps1 -Action Status` works without administrator rights and reports listeners, firewall, network profile and per-address HTTPS, instead of wrongly saying "not installed".

## Unreleased (codex/windows-wan-deployment)
- Windows installer: MSI and Setup EXE (WiX) bundling Node.js and Caddy; start-at-boot tasks, HTTPS on any IP, firewall rule for the TLS port only, nightly backup, data kept in ProgramData across upgrades and uninstalls.
- Address discovery at startup (`scripts/netinfo.js`) with an optional `PREFERRED_ADDRESS`; every reachable URL is logged.
- `INOUT_ENV_FILE` settings file support.
- GitHub Actions workflow builds the installers on Windows and tests install, HTTPS, backup, upgrade and uninstall.

## Unreleased (feature/csv-and-pages)
- CSV import (with preview and problem report) and export of all people.
- GitHub Pages site: landing page, real screenshots and an interactive in-browser demo.
- README rewritten with screenshots; `seed-demo`, `screenshots` and `build-pages` scripts.

## Public directory board
- Home page lists every tenant with logo, office and contact details; search, In/Out filter, company chips.
- Five layouts (table, list, cards, tiles, board); admin default and search-only mode; text-size control.
- Privacy by choice: office / phone / email shown only when the person or an admin opts in; photo, company logo or initials.
- Tenant logos and company details; tenant-manager role.
- Accessibility pass (WCAG 2.1 AA, axe-core clean).

## Profiles and logins
- Admin accounts with scrypt hashing and server-side sessions; per-person sign-in at `/me` with photo upload.
- Fixed sign-in being blocked behind a proxy or Cloudflare Tunnel (CSRF check now uses `Sec-Fetch-Site`).

## Admin dashboard
- Tenants, people, live board, time log with shifts and hours, manual corrections, CSV export of events.

## Deployment
- Dockerfile, compose file, systemd unit, backup script, CI and container-image workflows, DEPLOY.md.

## First version
- Multi-tenant IN/OUT board with SQLite persistence, clock in/out, global search and a basic admin.
