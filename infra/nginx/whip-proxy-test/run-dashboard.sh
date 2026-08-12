#!/usr/bin/env bash
# Stands up the FULL stack Task 3's browser-publishing UI needs — a real
# apps/api dev server, a real apps/web dev server, and this directory's
# nginx /whip/ harness kept running PERSISTENTLY (unlike this directory's
# own run.sh, which tears its container down right after one negotiation) —
# then drives the real EventsPage UI through it twice: once through a full
# go-live/stop cycle (drive-dashboard.mjs) and once through a denied-camera
# permission (drive-dashboard-denied.mjs).
#
# Committed per Task 3's fix-round-1 review, Important 5: the equivalent
# verification existed only as an interactive shell session before this —
# exactly the "narrated rather than captured evidence" failure mode
# CONTRIBUTING.md's own review history calls out. Re-run this after any
# change to EventsPage.tsx, whip-publisher.ts, or the nginx /whip/ location,
# rather than trusting a report's transcript to still be accurate.
#
# PREREQUISITES:
#   - Docker, with postgres and mediamtx already up:
#       docker compose -f infra/docker-compose.yml up -d
#   - infra/.env and apps/api/.env as committed (this repo's normal local
#     dev setup — see CONTRIBUTING.md). apps/api/.env's own
#     MEDIAMTX_WHIP_BASE_URL must point at NGINX_ORIGIN_PORT below (it does,
#     by default: both are 18443) — this script does not rewrite that file.
#   - jq, for parsing the curl-driven signup/community/session responses.
#   - Nothing already listening on :3000, :5173, or NGINX_ORIGIN_PORT.
#
# Usage:
#   ./run-dashboard.sh
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "jq is required — brew install jq" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NGINX_ORIGIN_PORT="${NGINX_ORIGIN_PORT:-18443}"
API_PORT="${API_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"
NETWORK_NAME="whip-dashboard-verify-net-$$"
CONTAINER_NAME="whip-dashboard-verify-nginx-$$"
WORKDIR="$(mktemp -d)"

API_PID=""
WEB_PID=""

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" >/dev/null 2>&1 || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" >/dev/null 2>&1 || true
  # BELT AND SUSPENDERS, measured necessary: `exec` inside the backgrounded
  # subshells (above) makes `$!` name the right process in the common case,
  # but `bun run dev` itself forks `vite` as its own child rather than
  # exec-ing into it, so killing the `bun run` PID alone left `vite` (and
  # therefore :5173) still listening. Killing by PORT is what actually
  # guarantees nothing survives this script, regardless of what any tool in
  # this chain execs versus forks.
  for port in "$API_PORT" "$WEB_PORT"; do
    # No `-r`: BSD xargs (macOS, this repo's own dev machine) does not
    # support it and errors out — both BSD and GNU xargs already skip
    # invoking the command at all when there is no input, so it is not
    # needed for the "nothing to kill" case either.
    lsof -ti "tcp:${port}" 2>/dev/null | xargs kill >/dev/null 2>&1 || true
  done
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if [ ! -f "$REPO_ROOT/infra/.env" ]; then
  echo "Missing infra/.env — see infra/.env.example and CONTRIBUTING.md's local setup steps." >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/apps/api/.env" ]; then
  echo "Missing apps/api/.env — see apps/api/.env.example." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source "$REPO_ROOT/infra/.env"; set +a
: "${MEDIAMTX_WEBHOOK_SECRET:?MEDIAMTX_WEBHOOK_SECRET must be set in infra/.env}"

for container in infra-postgres-1 infra-mediamtx-1; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
    echo "$container is not running — start it first: docker compose -f infra/docker-compose.yml up -d" >&2
    exit 1
  fi
done

echo "==> rendering the ACTUAL live-hls.conf.template (127.0.0.1 -> host.docker.internal), same as this directory's own run.sh"
sed 's/127\.0\.0\.1/host.docker.internal/g' "$REPO_ROOT/infra/nginx/live-hls.conf.template" \
  | MEDIAMTX_WEBHOOK_SECRET="$MEDIAMTX_WEBHOOK_SECRET" envsubst '$MEDIAMTX_WEBHOOK_SECRET' \
  > "$WORKDIR/rendered.conf"

cat > "$WORKDIR/server.conf" <<EOF
server {
    listen 8443;
    server_name _;
    resolver 127.0.0.11 valid=30s;
    include /etc/nginx/snippets/rendered.conf;
    location / { return 404; }
}
EOF

echo "==> starting the nginx WHIP harness (persistent — NOT torn down until this script exits)"
docker network create "$NETWORK_NAME" >/dev/null
docker run -d --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --add-host=host.docker.internal:host-gateway \
  -p "${NGINX_ORIGIN_PORT}:8443" \
  -v "$WORKDIR/server.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$WORKDIR/rendered.conf:/etc/nginx/snippets/rendered.conf:ro" \
  nginx:1.27-alpine >/dev/null
docker exec "$CONTAINER_NAME" nginx -t
for _ in $(seq 1 10); do
  curl -s -o /dev/null "http://localhost:${NGINX_ORIGIN_PORT}/" && break
  sleep 0.5
done

echo "==> starting apps/api's real dev server on :${API_PORT}"
# `exec` inside the subshell so `$!` names the ACTUAL bun process, not a
# subshell wrapper around it — without it, `kill "$API_PID"` in cleanup()
# killed nothing (measured: the real bun/vite processes stayed listening on
# :3000/:5173 after this script exited).
(cd "$REPO_ROOT/apps/api" && exec bun run --hot src/server.ts > "$WORKDIR/api.log" 2>&1) &
API_PID=$!
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:${API_PORT}/streaming/status" && break
  sleep 0.5
done
curl -s -o /dev/null "http://localhost:${API_PORT}/streaming/status" || {
  echo "apps/api never came up — see $WORKDIR/api.log (kept: trap will still delete WORKDIR, so 'cat' it now if this fails)" >&2
  cat "$WORKDIR/api.log" >&2
  exit 1
}

echo "==> starting apps/web's real dev server on :${WEB_PORT}"
(cd "$REPO_ROOT/apps/web" && exec bun run dev > "$WORKDIR/web.log" 2>&1) &
WEB_PID=$!
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:${WEB_PORT}/" && break
  sleep 0.5
done
curl -s -o /dev/null "http://localhost:${WEB_PORT}/" || {
  echo "apps/web never came up — see $WORKDIR/web.log" >&2
  cat "$WORKDIR/web.log" >&2
  exit 1
}

echo "==> creating a real test creator, community, and two scheduled sessions"
EMAIL="whip-verify+$$@example.com"
SIGNUP=$(curl -s -X POST "http://localhost:${API_PORT}/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Whip Verify\",\"email\":\"${EMAIL}\",\"password\":\"supersecret123\"}")
TOKEN=$(echo "$SIGNUP" | jq -r '.token')
if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "signup failed: $SIGNUP" >&2
  exit 1
fi

COMMUNITY=$(curl -s -X POST "http://localhost:${API_PORT}/communities" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"name\":\"Whip Verify\",\"slug\":\"whip-verify-$$\"}")
COMMUNITY_ID=$(echo "$COMMUNITY" | jq -r '.id')
if [ "$COMMUNITY_ID" = "null" ] || [ -z "$COMMUNITY_ID" ]; then
  echo "community creation failed: $COMMUNITY" >&2
  exit 1
fi

HAPPY_TITLE="drive-dashboard $$ happy"
DENIED_TITLE="drive-dashboard $$ denied"
curl -s -X POST "http://localhost:${API_PORT}/communities/${COMMUNITY_ID}/events" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"title\":\"${HAPPY_TITLE}\"}" >/dev/null
curl -s -X POST "http://localhost:${API_PORT}/communities/${COMMUNITY_ID}/events" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"title\":\"${DENIED_TITLE}\"}" >/dev/null

echo "==> installing this harness's own playwright (isolated devDependency, see package.json)"
(cd "$SCRIPT_DIR" && bun install --silent)

echo "==> driving the real EventsPage UI: full go-live/stop cycle"
(cd "$SCRIPT_DIR" && bun drive-dashboard.mjs "$TOKEN" "$COMMUNITY_ID" "$HAPPY_TITLE" "http://localhost:${WEB_PORT}" "http://localhost:${API_PORT}")
HAPPY_STATUS=$?

echo "==> driving the real EventsPage UI: denied camera/microphone permission"
(cd "$SCRIPT_DIR" && bun drive-dashboard-denied.mjs "$TOKEN" "$COMMUNITY_ID" "$DENIED_TITLE" "http://localhost:${WEB_PORT}")
DENIED_STATUS=$?

if [ "$HAPPY_STATUS" -eq 0 ] && [ "$DENIED_STATUS" -eq 0 ]; then
  echo "==> ALL REAL-BROWSER CHECKS PASSED"
  exit 0
else
  echo "==> AT LEAST ONE REAL-BROWSER CHECK FAILED (happy=$HAPPY_STATUS denied=$DENIED_STATUS)" >&2
  exit 1
fi
