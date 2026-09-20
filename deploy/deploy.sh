#!/usr/bin/env bash
# Build here, ship to the server, restart. Run from the project root:
#
#   ./deploy/deploy.sh root@<SERVER_IP>
#   AURA_HOST=root@1.2.3.4 ./deploy/deploy.sh      # or set it once in your shell
#
# Sends only the built output and the manifest - never src/, never data/, never .env.local.
# Your projects and assets on the server are untouched by a deploy.
set -euo pipefail

HOST="${1:-${AURA_HOST:-}}"
APP_DIR="/srv/aura"

if [ -z "$HOST" ]; then
  echo "Usage: ./deploy/deploy.sh root@<SERVER_IP>   (or set AURA_HOST)" >&2
  exit 1
fi

echo "==> Type-checking"
npm run typecheck

echo "==> Building"
npm run build

echo "==> Uploading to $HOST"
rsync -az --delete \
  dist/ "$HOST:$APP_DIR/dist/"
rsync -az --delete \
  dist-server/ "$HOST:$APP_DIR/dist-server/"
rsync -az \
  package.json package-lock.json slice_equirect_views.py "$HOST:$APP_DIR/"

echo "==> Installing production dependencies and restarting"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /srv/aura
npm ci --omit=dev --silent
chown -R aura:aura /srv/aura
systemctl restart aura
sleep 2
systemctl is-active --quiet aura && echo "aura is running" || {
  echo "aura failed to start:"; journalctl -u aura -n 30 --no-pager; exit 1;
}
REMOTE

echo
echo "Deployed. Check https://pantilt.app"
