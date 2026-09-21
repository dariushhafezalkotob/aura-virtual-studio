#!/usr/bin/env bash
# Installs MongoDB 8 on the app server and points the app at it.
#
#   scp deploy/setup-mongodb.sh root@<SERVER_IP>:/tmp/
#   ssh root@<SERVER_IP> "bash /tmp/setup-mongodb.sh"
#
# The database listens on 127.0.0.1 only - it is never reachable from the internet,
# and the firewall does not open 27017. Access still needs a password, so a bug in
# the app cannot be turned into "read every collection".
#
# The generated password is written into /etc/aura.env (root-only) and nowhere else.
# Safe to run again: it skips anything already done.
set -euo pipefail

DB_NAME="aura"
DB_USER="aura"

if ! command -v mongod >/dev/null 2>&1; then
  echo "==> Adding the MongoDB 8 repository"
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
    | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list

  echo "==> Installing MongoDB"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq mongodb-org
fi

echo "==> Configuring"
# 4 GB box: cap the cache so Node keeps room to serve models.
if ! grep -q "cacheSizeGB" /etc/mongod.conf; then
  sed -i 's|^storage:|storage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 1|' /etc/mongod.conf
fi
# Listen on loopback only (this is the shipped default; make it explicit).
sed -i 's|^  bindIp:.*|  bindIp: 127.0.0.1|' /etc/mongod.conf

systemctl enable mongod >/dev/null 2>&1 || true
systemctl restart mongod
sleep 3

if ! grep -q "^MONGODB_URI=" /etc/aura.env; then
  echo "==> Creating the application database user"
  DB_PASS="$(openssl rand -hex 24)"

  # Create the user while authorization is still off, then turn it on.
  mongosh --quiet --eval "
    db.getSiblingDB('admin').createUser({
      user: '$DB_USER',
      pwd: '$DB_PASS',
      roles: [{ role: 'readWrite', db: '$DB_NAME' }]
    })
  " >/dev/null

  if ! grep -q "authorization: enabled" /etc/mongod.conf; then
    printf '\nsecurity:\n  authorization: enabled\n' >> /etc/mongod.conf
  fi
  systemctl restart mongod
  sleep 3

  echo "MONGODB_URI=mongodb://$DB_USER:$DB_PASS@127.0.0.1:27017/$DB_NAME?authSource=admin" >> /etc/aura.env
  chmod 600 /etc/aura.env
  echo "    credentials written to /etc/aura.env"
else
  echo "    MONGODB_URI already present in /etc/aura.env - leaving it alone"
fi

echo "==> Checking"
systemctl is-active --quiet mongod && echo "    mongod is running" || { echo "    mongod FAILED"; journalctl -u mongod -n 20 --no-pager; exit 1; }
ss -lntp 2>/dev/null | grep 27017 || true
echo
echo "MongoDB is ready, on loopback only."
