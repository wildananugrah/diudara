#!/usr/bin/env bash
# Redeploys diudara on this box: pulls latest main, rebuilds, migrates, and
# (re)starts the api + worker under pm2. Run from anywhere; paths are resolved
# relative to this script.
#
# Does NOT touch infra/.env or apps/api/.env — those hold real secrets and are
# set up once by hand (see CONTRIBUTING.md). Does NOT touch nginx/TLS — that's
# one-time host config, not part of a code redeploy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIST_TARGET="/var/www/html/diudara/dist"
cd "$REPO_ROOT"

for f in infra/.env apps/api/.env; do
  if [ ! -f "$f" ]; then
    echo "Missing $f — copy it from ${f}.example and fill in real values first." >&2
    exit 1
  fi
done

echo "==> git pull"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes — refusing to pull. Commit, stash, or discard first." >&2
  git status --short >&2
  exit 1
fi
git pull --ff-only origin main

echo "==> bun install"
bun install

echo "==> postgres up"
docker compose -f infra/docker-compose.yml up -d
echo -n "waiting for postgres to be healthy"
for _ in $(seq 1 30); do
  status="$(docker inspect --format='{{.State.Health.Status}}' infra-postgres-1 2>/dev/null || echo "")"
  [ "$status" = "healthy" ] && { echo " ok"; break; }
  echo -n "."
  sleep 2
done
if [ "$status" != "healthy" ]; then
  echo "postgres never became healthy — check 'docker compose -f infra/docker-compose.yml logs postgres'" >&2
  exit 1
fi

echo "==> db migrate"
(cd apps/api && bun run db:migrate)

echo "==> build web"
(cd apps/web && bun run build)

echo "==> deploy web build to $WEB_DIST_TARGET"
sudo mkdir -p "$WEB_DIST_TARGET"
sudo rm -rf "${WEB_DIST_TARGET:?}"/*
sudo cp -r apps/web/dist/* "$WEB_DIST_TARGET/"
sudo chown -R "$(id -un):www-data" "$(dirname "$WEB_DIST_TARGET")"

echo "==> (re)start api + worker under pm2"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "==> done"
pm2 list
