#!/usr/bin/env bash
# IN/OUT Board - upgrade a Docker Compose install.
#
#   ./deploy/upgrade.sh            # run from the checkout (backs up, pulls, rebuilds, verifies health)
#   ./deploy/upgrade.sh --no-pull  # rebuild from the files already on disk
#
# For a systemd install, re-run deploy/install.sh from a newer checkout instead.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PULL=1; [ "${1:-}" = "--no-pull" ] && PULL=0
command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin not found" >&2; exit 1; }

echo "==> Backing up"
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  docker compose exec -T app node scripts/backup.js /data/backups
else
  echo "    app is not running; skipping backup (nothing to back up or start it first)"
fi

if [ "$PULL" = 1 ]; then
  echo "==> Pulling latest code"
  git pull --ff-only
fi

echo "==> Rebuilding and restarting"
docker compose up -d --build

echo "==> Waiting for health"
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' inout-board 2>/dev/null || echo unknown)
  [ "$status" = healthy ] && { echo "Healthy. Upgrade complete."; exit 0; }
  sleep 3
done
echo "App did not become healthy. Check:  docker compose logs app" >&2
exit 1
