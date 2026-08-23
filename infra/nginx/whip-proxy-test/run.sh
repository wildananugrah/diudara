#!/usr/bin/env bash
# Stands up a REAL nginx:1.27-alpine container running the ACTUAL, committed
# infra/nginx/live-hls.conf.template (envsubst-rendered, nothing hand-edited),
# then drives a real RTCPeerConnection through its `^~ /whip/u/` location via
# negotiate.mjs — the harness that produced task-1-report.md's "Second run:
# through the new nginx /whip/ location" evidence (browser-publishing phase,
# Task 1). Re-run this any time that location changes, rather than trusting
# the report's own transcript to still be accurate.
#
# THE ONLY SCRIPT LEFT IN THIS DIRECTORY, as of retire-telegram Task 7. The
# others — run-dashboard.sh, run-gate.sh and five `drive-*.mjs` drivers — all
# stood up the deleted creator dashboard (`/dashboard/c/:id/streaming`,
# `localStorage diudara.dashboard.*`) and drove it through deleted API routes
# (`POST /communities`, `GET /c/subscription/:id/status`,
# `GET /c/watch/:token`). They could not be repaired, only rewritten against a
# UI they were never written for, so they went with the world they exercised.
# This one survives because it needs neither: an nginx container, a real
# MediaMTX, and one stream key.
#
# PREREQUISITES, all satisfied by CONTRIBUTING.md's normal local dev setup:
#   - Docker, with the nginx:1.27-alpine image available (pulled on first run
#     if not already cached).
#   - infra/.env with a real MEDIAMTX_WEBHOOK_SECRET (see infra/.env.example
#     — this script only reads it to render the template; the /whip/
#     location itself doesn't use the secret, but envsubst needs SOME value
#     for every ${VAR} the template contains).
#   - A running MediaMTX + apps/api stack (`docker compose -f
#     infra/docker-compose.yml up -d`, `apps/api`'s dev server up, with the
#     five MEDIAMTX_*/STREAM_TOKEN_SECRET vars set so MediaMtxAdapter, not
#     FakeStreamingAdapter, is selected — see CONTRIBUTING.md) reachable at
#     127.0.0.1 on the ports docker-compose.yml maps.
#   - A REAL stream key for a `user_stream` row, passed as this script's one
#     required argument. Start a broadcast from Siaran in the real app and take
#     the key from that row, or insert one by hand:
#       psql "$DATABASE_URL" -c "insert into user_stream (owner_id, title, \
#         status, stream_key) values ('<userId>', 'whip proxy test', 'live', \
#         md5(random()::text)) returning stream_key;"
#     — MediaMTX authorises the publish against apps/api's
#     /webhooks/mediamtx/auth, which resolves `u/<streamKey>`, so the row has
#     to exist and be publishable for the negotiation to succeed. This script
#     needs no apps/web at all: it drives nginx and MediaMTX directly.
#
# Usage:
#   ./run.sh <streamKey>
#
# WHY A CONTAINERISED nginx NEEDS host.docker.internal, NOT 127.0.0.1 —
# and why THAT needs its own DNS resolver: the committed template's
# proxy_pass targets are 127.0.0.1, correct for the DOCUMENTED bare-metal
# deployment (nginx runs directly on the VPS host — see CONTRIBUTING.md), but
# this harness's own local proof needs nginx running AS a container (there is
# no other way to stand up nginx in this repo's sandboxed dev environment),
# where 127.0.0.1 means the CONTAINER's own loopback, not the host's. Every
# 127.0.0.1 in the rendered config is swapped for host.docker.internal below
# — exactly the documented variant in live-hls.conf.template's own header
# comment. Because the /whip/u/ and /u/ locations both build their
# proxy_pass target from a VARIABLE (the captured stream key / stream id),
# nginx resolves that hostname at REQUEST time, which needs an explicit
# `resolver` directive — found running this for real (Task 1): omitting it
# produces "no resolver defined to resolve host.docker.internal" in nginx's
# error log for every single request. 127.0.0.11 is Docker's own embedded DNS
# server, reachable only from containers on a user-defined bridge network
# (not the default "bridge" network) — hence the dedicated network created
# and torn down below.
set -euo pipefail

STREAM_KEY="${1:?usage: ./run.sh <streamKey> -- see the header comment above for how to mint one}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NGINX_ORIGIN_PORT="${NGINX_ORIGIN_PORT:-18443}"
NETWORK_NAME="whip-proxy-test-net-$$"
CONTAINER_NAME="whip-proxy-test-nginx-$$"
WORKDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if [ ! -f "$REPO_ROOT/infra/.env" ]; then
  echo "Missing infra/.env — see infra/.env.example and CONTRIBUTING.md's local setup steps." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source "$REPO_ROOT/infra/.env"; set +a
: "${MEDIAMTX_WEBHOOK_SECRET:?MEDIAMTX_WEBHOOK_SECRET must be set in infra/.env}"

echo "==> rendering the ACTUAL live-hls.conf.template (127.0.0.1 -> host.docker.internal, this harness's containerised nginx only)"
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

echo "==> starting nginx container"
docker network create "$NETWORK_NAME" >/dev/null
docker run -d --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --add-host=host.docker.internal:host-gateway \
  -p "${NGINX_ORIGIN_PORT}:8443" \
  -v "$WORKDIR/server.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$WORKDIR/rendered.conf:/etc/nginx/snippets/rendered.conf:ro" \
  nginx:1.27-alpine >/dev/null

echo "==> nginx -t"
docker exec "$CONTAINER_NAME" nginx -t

for _ in $(seq 1 10); do
  curl -s -o /dev/null "http://localhost:${NGINX_ORIGIN_PORT}/" && break
  sleep 0.5
done

echo "==> installing the harness's own playwright (isolated devDependency, see package.json)"
(cd "$SCRIPT_DIR" && bun install --silent)

echo "==> negotiating a real WHIP session through nginx"
(cd "$SCRIPT_DIR" && bun negotiate.mjs "http://localhost:${NGINX_ORIGIN_PORT}" "$STREAM_KEY")
