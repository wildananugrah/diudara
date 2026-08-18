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

# sharp (apps/api/src/domain/image.ts) is this project's only native
# dependency — everything else here is pure TypeScript. `bun install` above
# can succeed while the prebuilt binary it downloaded still doesn't load on
# THIS box (wrong libc, missing shared lib, architecture mismatch — see
# sharp's own install docs). Left unchecked, that failure surfaces the moment
# a real person uploads their first photo, as an opaque 500 nobody on this
# box is watching for. Catching it here, synchronously, in the one place an
# operator running a real redeploy IS watching — same reasoning as the
# postgres and api health polls below.
echo "==> verifying sharp (the only native dependency)"
if ! (cd apps/api && bun -e 'import("sharp").then(s => s.default.versions)') >/dev/null 2>&1; then
  echo "sharp failed to load — images cannot be processed on this box. Deploy stopped." >&2
  exit 1
fi

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

# `pm2 startOrReload` returning 0 means pm2 accepted the reload request, NOT
# that the process is actually serving — a synchronous throw inside
# bootstrap() (e.g. `apps/api/.env` half-configured — see
# selectStreamingProvider/selectPaymentProvider/selectMessagingProviders in
# bootstrap.ts) crashes `apps/api` on the very first tick, pm2 restarts it,
# it crashes again, and the script would print "==> done" and exit 0 while
# the box sits in a silent restart loop. The concrete case that motivated
# this: a box already running the four original MEDIAMTX_* variables throws
# the moment MEDIAMTX_WHIP_BASE_URL ships without also being added to
# apps/api/.env, and nothing before this point would have caught it.
#
# This check only works because ecosystem.config.cjs leaves both apps in
# pm2's default FORK mode, where `reload` fully replaces the process. Switch
# either app to `exec_mode: "cluster"` and pm2 will keep the old workers
# alive when new ones fail to boot — /health would then answer from the
# PREVIOUS release and this poll would pass while the deploy had in fact
# failed. If cluster mode is ever wanted, this check needs to verify the
# running code's identity, not just that something answers.
#
# Same shape as the postgres health-poll above:
# gate on the process's OWN synchronous check (GET /health, which also
# round-trips the database — see routes/health.ts) rather than trusting a
# log line or an exit code that only proves pm2 accepted the command.
# The port is read from apps/api/.env rather than hardcoded, because a real
# deployment does NOT necessarily use 3000: this box runs the api on 3004, and
# its /etc/nginx snippet was hand-edited to match. Hardcoding the documented
# default here would poll a port nothing listens on and fail every deploy with
# "api never became healthy" while the api was in fact serving perfectly — a
# health check that cries wolf gets ignored, which is worse than no check.
# Falls back to 3000 (apps/api/src/server.ts's own default) when PORT is unset.
api_port="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' apps/api/.env | tail -1 | tr -d '"'\''[:space:]')"
case "$api_port" in
  ''|*[!0-9]*) api_port=3000 ;;
esac
echo -n "waiting for the api to be healthy on 127.0.0.1:$api_port"
api_healthy=""
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$api_port/health"; then
    api_healthy="1"
    echo " ok"
    break
  fi
  echo -n "."
  sleep 2
done
if [ -z "$api_healthy" ]; then
  echo "api never became healthy — check 'pm2 logs diudara-api --lines 50 --nostream'." >&2
  echo "A common cause: apps/api/.env is half-configured for one of the guarded" >&2
  echo "provider groups (Xendit, Telegram/Fonnte, email/Resend, or the five" >&2
  echo "MEDIAMTX_*/STREAM_TOKEN_SECRET streaming variables) — bootstrap() refuses" >&2
  echo "to start rather than boot half-wired, and pm2 silently restart-loops the crash." >&2
  echo "See apps/api/.env.example and CONTRIBUTING.md's 'Live streaming (MediaMTX)'" >&2
  echo "section." >&2
  exit 1
fi

echo "==> done"
pm2 list
