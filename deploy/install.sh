#!/usr/bin/env bash
# IN/OUT Board - one-step installer for Linux servers (systemd).
#
#   From a checkout:   sudo ./deploy/install.sh
#   One line:          curl -fsSL https://raw.githubusercontent.com/jmason84/inout-board/main/deploy/install.sh | sudo bash
#                      (a private repo needs a token: add  INOUT_TOKEN=<token>  before "bash")
#
# Sets up: Node.js 22.5+ (if missing), a system user "inout", the app in /opt/inout-board,
# /etc/inout-board.env (HTTPS=auto on 8443, admin/admin with forced change), the systemd service,
# a nightly backup timer (02:15, keeps 14) and, if ufw or firewalld is active, the firewall port.
# Safe to re-run: it upgrades the program files and keeps your data and settings.
#
# Options:  --port N        HTTPS port (default 8443)
#           --addresses A   extra IPs/names for the certificate (comma separated)
#           --reset-admin   reset admin to admin/admin (forced change) even on an existing install
#           --no-firewall   do not touch the firewall
#           --ref REF       branch/tag to download in one-line mode (default main)
# Environment: INOUT_REPO (default jmason84/inout-board), INOUT_TOKEN, INOUT_SRC (use this folder)
set -euo pipefail

APP_DIR=/opt/inout-board
DATA_DIR=/var/lib/inout-board
BACKUP_DIR=/var/backups/inout-board
ENV_FILE=/etc/inout-board.env
PORT=8443
EXTRA=""
RESET_ADMIN=0
FIREWALL=1
REF=main
REPO=${INOUT_REPO:-jmason84/inout-board}

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)         PORT=${2:?--port needs a number}; shift 2 ;;
    --addresses)    EXTRA=${2:?--addresses needs a value}; shift 2 ;;
    --reset-admin)  RESET_ADMIN=1; shift ;;
    --no-firewall)  FIREWALL=0; shift ;;
    --ref)          REF=${2:?--ref needs a value}; shift 2 ;;
    -h|--help)      sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be between 1 and 65535"
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."
command -v systemctl >/dev/null || die "systemd is required. On other systems use Docker Compose (see DEPLOY.md)."

# ---- 1. Node.js 22.5+ -------------------------------------------------------
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'
}
if ! node_ok; then
  say "Installing Node.js 22 (NodeSource)"
  if command -v apt-get >/dev/null; then
    apt-get update -y && apt-get install -y ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    PM=$(command -v dnf || command -v yum)
    "$PM" install -y curl
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    "$PM" install -y nodejs
  else
    die "Install Node.js 22.5 or newer yourself (https://nodejs.org), then run this again."
  fi
  node_ok || die "Node.js 22.5+ is required (found: $(node -v 2>/dev/null || echo none))."
fi
NODE_BIN=$(command -v node)
say "Using Node.js $(node -v) at $NODE_BIN"

# ---- 2. Get the program files ----------------------------------------------
SRC=${INOUT_SRC:-}
if [ -z "$SRC" ]; then
  HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
  if [ -n "$HERE" ] && [ -f "$HERE/../server.js" ]; then SRC=$(cd "$HERE/.." && pwd); fi
fi
if [ -z "$SRC" ]; then
  say "Downloading $REPO@$REF"
  command -v curl >/dev/null || die "curl is required."
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  AUTH=(); [ -n "${INOUT_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $INOUT_TOKEN")
  curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/$REPO/tarball/$REF" -o "$TMP/src.tgz" \
    || die "Download failed (private repo? set INOUT_TOKEN)."
  tar -xzf "$TMP/src.tgz" -C "$TMP"
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)
fi
[ -f "$SRC/server.js" ] || die "server.js not found in $SRC"

# ---- 3. User, folders, files ------------------------------------------------
id inout >/dev/null 2>&1 || { say "Creating system user inout"; useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin inout; }
FRESH=0; [ -f "$ENV_FILE" ] || FRESH=1
HAD_DB=0; [ -f "$DATA_DIR/inout.sqlite" ] && HAD_DB=1
UPGRADE=0; [ -d "$APP_DIR" ] && [ "$FRESH" = 0 ] && UPGRADE=1

if [ "$UPGRADE" = 1 ] && [ -f "$DATA_DIR/inout.sqlite" ]; then
  say "Existing install found: backing up first"
  mkdir -p "$BACKUP_DIR"; chown inout:inout "$BACKUP_DIR"
  (cd "$APP_DIR" && runuser -u inout -- env DATA_DIR="$DATA_DIR" "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/backup.js "$BACKUP_DIR") \
    || warn "Pre-upgrade backup failed; continuing"
fi

say "Installing program files to $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
for item in server.js package.json public assets scripts; do
  rm -rf "${APP_DIR:?}/$item"; cp -r "$SRC/$item" "$APP_DIR/$item"
done
chown -R root:root "$APP_DIR"
chown -R inout:inout "$DATA_DIR" "$BACKUP_DIR"

# ---- 4. Settings (never overwritten on upgrade) ----------------------------
if [ "$FRESH" = 1 ]; then
  say "Writing $ENV_FILE"
  umask 077
  {
    echo "# IN/OUT Board settings. Restart after editing:  sudo systemctl restart inout-board"
    echo "HTTPS=auto"
    echo "PORT=$PORT"
    echo "ADMIN_USER=admin"
    echo "ADMIN_PASSWORD=admin"
    echo "ADMIN_MUST_CHANGE=1"
    [ -n "$EXTRA" ] && echo "EXTRA_ADDRESSES=$EXTRA"
    true
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  say "Keeping existing $ENV_FILE"
  if [ -n "$EXTRA" ]; then
    grep -q '^EXTRA_ADDRESSES=' "$ENV_FILE" && sed -i "s|^EXTRA_ADDRESSES=.*|EXTRA_ADDRESSES=$EXTRA|" "$ENV_FILE" || echo "EXTRA_ADDRESSES=$EXTRA" >> "$ENV_FILE"
  fi
  PORT=$(grep -E '^PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true); PORT=${PORT:-8443}
fi

# ---- 5. systemd -------------------------------------------------------------
say "Installing systemd units"
for u in inout-board.service inout-board-backup.service inout-board-backup.timer; do
  cp "$SRC/deploy/$u" "/etc/systemd/system/$u"
done
sed -i "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" /etc/systemd/system/inout-board.service /etc/systemd/system/inout-board-backup.service
systemctl daemon-reload

# Fresh install over leftover data (e.g. reinstall after removing the app): start from admin/admin again,
# like the Windows installer. Upgrades keep every account.
if [ "$HAD_DB" = 1 ] && { [ "$RESET_ADMIN" = 1 ] || [ "$FRESH" = 1 ]; }; then
  say "Resetting admin to admin / admin (you will choose a new password at first sign-in)"
  systemctl stop inout-board 2>/dev/null || true
  (cd "$APP_DIR" && runuser -u inout -- env DATA_DIR="$DATA_DIR" "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/reset-admin.js)
fi

systemctl enable --now inout-board-backup.timer >/dev/null
systemctl enable inout-board >/dev/null
systemctl restart inout-board

# ---- 6. Firewall ------------------------------------------------------------
if [ "$FIREWALL" = 1 ]; then
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say "Opening TCP $PORT in ufw"; ufw allow "$PORT"/tcp >/dev/null
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    say "Opening TCP $PORT in firewalld"; firewall-cmd --permanent --add-port="$PORT"/tcp >/dev/null && firewall-cmd --reload >/dev/null
  else
    say "No active ufw/firewalld found; not touching the firewall (open TCP $PORT yourself if you use another one)"
  fi
fi

# ---- 7. Wait for health, print URLs ----------------------------------------
say "Waiting for the board to answer"
OK=0
for _ in $(seq 1 30); do
  if (cd "$APP_DIR" && PORT="$PORT" HTTPS=auto "$NODE_BIN" scripts/healthcheck.js) 2>/dev/null; then OK=1; break; fi
  sleep 1
done
[ "$OK" = 1 ] || { warn "Not answering yet. Check:  journalctl -u inout-board -n 50"; }

echo
echo "IN/OUT Board is installed."
HOSTNAME_=$(hostname 2>/dev/null || true)
for ip in $(hostname -I 2>/dev/null); do echo "  https://$ip:$PORT/          (admin: /admin)"; done
[ -n "$HOSTNAME_" ] && echo "  https://$HOSTNAME_:$PORT/"
echo
echo "First sign-in: user admin, password admin. You must choose a new password (10+ characters) straight away."
echo "Each device installs the certificate once from  https://<address>:$PORT/ca.crt  (see README: Deploying on Linux)."
echo "Settings: $ENV_FILE   Data: $DATA_DIR   Backups: $BACKUP_DIR (nightly 02:15, keeps 14)"
echo "Logs: journalctl -u inout-board -f      Upgrade: re-run this script     Lost password: sudo -u inout DATA_DIR=$DATA_DIR $NODE_BIN $APP_DIR/scripts/reset-admin.js"
