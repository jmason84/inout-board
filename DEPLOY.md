# Deploying the IN/OUT Board

The app is one Node process plus one folder of data (a SQLite database and uploaded photos). There is nothing else to install: no database server, no `npm install`.

Pick one of the three ways below. **Option A (Docker)** is the easiest.

> **Before you start:** decide how people will reach it. Over plain `http://server-ip:3000` on a trusted office network it works as is. For anything reachable from the internet, put it behind HTTPS (Options A + tunnel, or C) and read "HTTPS and cookies" first.

---

## Option A: Docker (recommended)

Needs Docker with the Compose plugin.

```bash
git clone -b deploy https://github.com/jmason84/inout-board.git
cd inout-board
cp .env.example .env
```

Edit `.env` and set `ADMIN_USER` and a strong `ADMIN_PASSWORD`, then:

```bash
docker compose up -d
```

Open `http://<server-ip>:3000` for the kiosk and `http://<server-ip>:3000/admin` to sign in.

- Data lives in the Docker volume `inout-board_inout-data` and survives restarts and upgrades.
- If you left `ADMIN_PASSWORD` empty, a random one is printed once: `docker compose logs app`
- `ADMIN_USER` / `ADMIN_PASSWORD` are **only read on the very first start**. Afterwards, manage admins in the app (Admin, then Admins). Changing `.env` later does not change existing passwords.

**Update to a newer version**

```bash
git pull
docker compose up -d --build
```

Back up first (see "Backups").

**Use the prebuilt image instead of building**

Pushing to the `deploy` branch (or a `v*` tag) makes GitHub Actions publish `ghcr.io/jmason84/inout-board`. The package is private, so log in once with a personal access token that has `read:packages`:

```bash
echo YOUR_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
docker compose pull && docker compose up -d
```

### Cloudflare Tunnel (no open ports, free HTTPS)

1. In Cloudflare Zero Trust, create a tunnel and copy its token.
2. Add a public hostname (for example `board.yourdomain.com`) pointing at `http://app:3000`.
3. In `.env` set `TUNNEL_TOKEN=...`, `COOKIE_SECURE=1` and `TRUST_PROXY=1`.
4. `docker compose --profile tunnel up -d`

You can also put Cloudflare Access in front of `/admin`. The kiosk (`/`) and `/me` need to stay reachable by staff, so protect only `/admin*` if you do. The admin login is still required either way.

---

## Option B: plain Node (any server, Windows, Mac or Linux)

Needs **Node.js 22.5 or newer**. Check with `node -v`.

```bash
git clone -b deploy https://github.com/jmason84/inout-board.git
cd inout-board
ADMIN_USER=admin ADMIN_PASSWORD='a-long-passphrase' PORT=3000 node server.js
```

Data is stored in `./data` (override with `DATA_DIR=/some/folder`).

### Keep it running on Linux (systemd)

```bash
sudo useradd --system --home /opt/inout-board --shell /usr/sbin/nologin inout
sudo mkdir -p /opt/inout-board /var/lib/inout-board
sudo cp -r server.js package.json public assets scripts /opt/inout-board/
sudo chown -R inout:inout /var/lib/inout-board

sudo tee /etc/inout-board.env >/dev/null <<'EOF'
PORT=3000
ADMIN_USER=admin
ADMIN_PASSWORD=change-this-long-passphrase
# behind HTTPS only:
# COOKIE_SECURE=1
# TRUST_PROXY=1
EOF
sudo chmod 600 /etc/inout-board.env

sudo cp deploy/inout-board.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now inout-board
journalctl -u inout-board -f
```

---

## HTTPS and cookies

Sign-in uses a cookie. Two settings matter:

| Setting | When | Effect |
|---------|------|--------|
| `COOKIE_SECURE=1` | The site is served over **https://** | Cookie is only sent over HTTPS |
| `TRUST_PROXY=1` | A proxy or tunnel sits in front (Caddy, nginx, Cloudflare) | Uses the real visitor IP for login throttling |

**Gotcha:** with `COOKIE_SECURE=1`, sign-in will silently fail over plain `http://`. If you can't sign in after turning it on, check you are using the https address.

A ready-made Caddy config with automatic certificates is in `deploy/Caddyfile.example`.

---

## Backups

All state is in one folder (`data/`, or the `/data` volume): `inout.sqlite` plus `uploads/` (photos). Don't copy the live database file by hand: it runs in WAL mode, so a raw copy can be inconsistent. Use the backup script, which is safe while the app is running:

```bash
# Docker
docker compose exec app node scripts/backup.js /data/backups

# Plain Node
node scripts/backup.js ./backups          # honours DATA_DIR, KEEP=14 by default
```

Each run creates `inout-YYYYMMDD-HHMMSS/` with `inout.sqlite` and `uploads/`, and keeps the newest 14.

**Nightly (cron, plain Node):**

```
15 2 * * *  cd /opt/inout-board && DATA_DIR=/var/lib/inout-board node scripts/backup.js /var/backups/inout-board
```

Copy the backup folder somewhere off the server too (another machine, cloud storage). A backup on the same disk doesn't survive that disk failing.

### Restore

1. Stop the app (`docker compose stop app` or `systemctl stop inout-board`).
2. Replace `inout.sqlite` and `uploads/` in the data folder with the ones from the backup. Delete any leftover `inout.sqlite-wal` / `-shm` files next to it.
3. Start the app.

For Docker, copy into the volume with a throwaway container:

```bash
docker compose stop app
docker run --rm -v inout-board_inout-data:/data -v "$PWD/backup-folder":/backup alpine \
  sh -c 'rm -f /data/inout.sqlite* && rm -rf /data/uploads && cp /backup/inout.sqlite /data/ && cp -r /backup/uploads /data/ && chown -R 1000:1000 /data'
docker compose start app
```

---

## Upgrading from the earlier version (the one using `ADMIN_TOKEN`)

- `ADMIN_TOKEN` no longer exists. Sign-in is now a username and password.
- On first start of the new version, if no admin exists yet, one is created from `ADMIN_USER` / `ADMIN_PASSWORD` (or a random password printed in the log).
- Existing tenants, people and clock history are kept. The new profile, session and settings tables are added automatically. **Back up first anyway.**

---

## Health check and troubleshooting

- `GET /api/health` returns `{"ok":true}`. Docker uses it for its healthcheck.
- **Can't sign in:** wrong address scheme with `COOKIE_SECURE=1` (see above), or you were throttled (8 failed tries in 15 minutes per address; wait or restart the app).
- **Lost the admin password and have no other admin:** stop the app, run the SQLite statement `DELETE FROM admin_users;` against `inout.sqlite` (the sqlite3 CLI, or any SQLite tool), then start with a new `ADMIN_PASSWORD`. A fresh admin is created on start.
- **Photos don't show after a restore:** the `uploads/` folder wasn't restored alongside the database.
- **Port already in use:** change `HOST_PORT` (Docker) or `PORT` (plain Node).

## Security checklist

- [ ] Strong `ADMIN_PASSWORD` set, and `.env` / `/etc/inout-board.env` not world-readable or committed
- [ ] HTTPS in place if reachable beyond the office network, with `COOKIE_SECURE=1`
- [ ] Kiosk mode left on **Search only** unless it is fine for visitors to see names and photos (Admin, then Settings)
- [ ] Nightly backups copied off the server
- [ ] Each admin has their own account (Admin, then Admins), and unused ones are removed
