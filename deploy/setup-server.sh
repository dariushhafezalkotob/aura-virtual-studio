#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 server.
#
#   scp deploy/setup-server.sh deploy/aura.service deploy/Caddyfile root@<SERVER_IP>:/tmp/
#   ssh root@<SERVER_IP> "bash /tmp/setup-server.sh"
#
# Installs Node, Caddy (which gets the HTTPS certificate on its own), the Python
# bits the panorama slicer needs, a locked-down service user and a firewall.
# Safe to run again: every step checks before it acts.
set -euo pipefail

DOMAIN="${DOMAIN:-pantilt.app}"
APP_USER="aura"
APP_DIR="/srv/aura"

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "==> Installing base packages"
# python3-numpy and python3-pillow are for slice_equirect_views.py, which
# /api/generate-360-from-image shells out to. Ubuntu packages rather than pip:
# 24.04 blocks system-wide pip installs (PEP 668).
apt-get install -y -qq curl ca-certificates gnupg rsync ufw python3 python3-numpy python3-pillow

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "==> Creating the $APP_USER service user"
  useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Preparing $APP_DIR"
mkdir -p "$APP_DIR/data/assets" "$APP_DIR/data/blobs" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f /etc/aura.env ]; then
  echo "==> Writing /etc/aura.env"
  cat > /etc/aura.env <<'ENVEOF'
# Environment for the Aura server. Restart after changing: systemctl restart aura
PORT=3000
PUBLIC_SCHEME=https

# LEAVE THESE EMPTY until there is a login.
# With no key here, a visitor can only generate using a key they enter themselves
# in the app's own Settings -- so nobody can spend your quota.
HF_TOKEN=
GEMINI_API_KEY=
ENVEOF
  chmod 600 /etc/aura.env
fi

echo "==> Installing the service and the web server config"
install -m 644 /tmp/aura.service /etc/systemd/system/aura.service
sed "s/__DOMAIN__/$DOMAIN/g" /tmp/Caddyfile > /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable aura >/dev/null 2>&1 || true

echo "==> Firewall: SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo
echo "Server is ready for $DOMAIN."
echo "Next: run ./deploy/deploy.sh from your Mac to send the app up."
