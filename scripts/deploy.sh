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

# The pull lives HERE and not in the deploy workflow, deliberately. Both guards
# below are the point:
#
#   --ff-only        a diverged clone must FAIL, not silently gain a merge commit.
#                    Without it, production can end up running a commit that
#                    exists on no remote and that nobody can reproduce.
#   dirty-tree check somebody edited a file on the box. Pulling over it either
#                    fails confusingly mid-merge or buries the edit. Stop and say so.
#
# A bare `git pull origin main` in the workflow before this point would bypass
# both, which is exactly why there isn't one.
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

# infra/docker-compose.yml's mediamtx entrypoint already prints a WARN to
# `docker logs infra-mediamtx-1` on every start where
# MEDIAMTX_WEBRTC_ADDITIONAL_HOSTS is unset (see that file's own comment) —
# loud INSIDE the container, but this script never surfaced it anywhere, so
# on a real non-interactive redeploy that WARN sat in a log stream nobody was
# watching, which is not meaningfully different from the checklist entry it
# was meant to replace. This terminal is the one place an operator running a
# real redeploy IS watching synchronously — the postgres health-poll above
# already earns its keep the same way, gating on its OWN synchronous check
# rather than trusting a log line to be noticed later.
#
# Deliberately CANNOT fail the deploy, unlike the postgres check above: an
# empty MEDIAMTX_WEBRTC_ADDITIONAL_HOSTS is correct on a box where the
# publishing browser and this server are the same machine, and a real
# production redeploy must not break because of it — see
# infra/mediamtx.yml's own webrtcAdditionalHosts comment. `|| true` on the
# grep (not just the `docker logs`) means an empty match (nothing to report)
# and a hard error reading the log (mediamtx not up yet, docker unreachable)
# are both treated as "nothing to report" rather than aborting under this
# script's `set -e`.
echo "==> checking mediamtx logs for the browser-publishing (WebRTC/WHIP) warning"
# 2>&1, NOT 2>/dev/null — found running this for real: the entrypoint
# wrapper's WARN/INF lines are `echo ... >&2` INSIDE the container (stderr),
# and `docker logs` mirrors a container's stdout/stderr onto its OWN
# matching streams rather than interleaving them into one. `2>/dev/null`
# here would silently discard exactly the line this check exists to find,
# passing grep nothing to ever match and making this whole step a no-op
# that looked correct in every test that didn't check the WARN case against
# a genuinely fresh container.
mediamtx_warn="$(docker logs --tail 20 infra-mediamtx-1 2>&1 | grep 'WARN \[mediamtx\]' || true)"
if [ -n "$mediamtx_warn" ]; then
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "$mediamtx_warn"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
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
