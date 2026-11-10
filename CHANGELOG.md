# Changelog

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
