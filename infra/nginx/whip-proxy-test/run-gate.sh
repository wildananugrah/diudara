#!/usr/bin/env bash
# TASK 4 — THE BROWSER-PUBLISHING PHASE GATE, as an executable script rather
# than a transcript in a report.
#
# Extends this directory's run-dashboard.sh (Task 3's committed harness) with
# the four checklist items it did not cover, all against the SAME real stack it
# already stands up — a real apps/api, a real apps/web, a real nginx rendering
# the ACTUAL infra/nginx/live-hls.conf.template, and the real MediaMTX and
# Postgres containers from infra/docker-compose.yml:
#
#   1. A real MEMBER, in a second browser context, watching the video a creator
#      is publishing from their browser — through nginx's `/live/<eventId>/`
#      location, with a real watch token and a real active subscription
#      (drive-gate.mjs).
#   2. OBS/RTMP still works — `ffmpeg` publishing to
#      `rtmp://<host>:1935/live/<streamKey>` is what the previous phase used
#      and is equivalent; this phase must not have broken it.
#   3. A second publisher is refused while one is live, IN BOTH DIRECTIONS
#      (browser-while-ffmpeg-holds, and ffmpeg-while-browser-holds), with the
#      UI saying so rather than failing obscurely
#      (drive-second-publisher.mjs, drive-hold-live.mjs).
#   4. The stream key appears in NO log line — nginx's access log, MediaMTX's
#      log, and apps/api's own output are all grepped for the real key of every
#      session this run creates.
#
# WHY THIS SCRIPT SETS `MEDIAMTX_HLS_BASE_URL` ITSELF, and why that is not
# cheating: the member-facing HLS URL is built as
# `<MEDIAMTX_HLS_BASE_URL>/live/<eventId>/index.m3u8` (ResolveWatchToken), and
# only nginx knows how to turn that `<eventId>` back into MediaMTX's internal
# `/live/<streamKey>/...` path. apps/api/.env's committed local value points
# straight at MediaMTX's own port 8888, which bypasses nginx entirely and
# therefore CANNOT serve a member — MediaMTX was never taught about event ids.
# So this script exports the nginx harness's own origin for the apps/api
# process it starts (Bun's own precedence: a real environment variable wins
# over a `.env` file — measured, not assumed), leaving the committed file
# untouched. Production sets both HLS and WHIP base URLs to the one public
# nginx origin, which is exactly what this reproduces.
#
# PREREQUISITES: everything run-dashboard.sh needs (docker with postgres and
# mediamtx up, infra/.env and apps/api/.env, jq, envsubst, nothing on :3000,
# :5173 or the nginx port) — PLUS `ffmpeg`, for the RTMP/OBS-equivalent publishes.
#
# Usage:
#   ./run-gate.sh
set -euo pipefail

for tool in jq docker envsubst ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# 8443 — DELIBERATELY THE SAME NUMBER nginx ITSELF LISTENS ON, unlike
# run-dashboard.sh's 18443:8443 remap, and this is load-bearing rather than
# tidy. nginx builds an absolute `Location` for a path-only `proxy_redirect`
# replacement from its OWN listen port, which it has no way to know is being
# remapped externally. Under run-dashboard.sh's remap, MediaMTX's HLS
# cookie-check 302 therefore came back as `http://localhost:8443/live/...` and
# the member's browser — which, unlike whip-publisher.ts, has no origin-pinning
# logic and just follows the redirect — died on ERR_CONNECTION_REFUSED. That is
# an artifact of the remap, not of the config (production nginx listens on the
# real 443, where the port is omitted from the Location entirely — the same
# finding Task 3's Important 2 established for the `/whip/` location). Making
# the published port equal the listen port removes the artifact instead of
# working around it, so a member-playback failure here means a real failure.
NGINX_ORIGIN_PORT="${NGINX_ORIGIN_PORT:-8443}"
API_PORT="${API_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"
NETWORK_NAME="whip-gate-net-$$"
CONTAINER_NAME="whip-gate-nginx-$$"
WORKDIR="$(mktemp -d)"
NGINX_ORIGIN="http://localhost:${NGINX_ORIGIN_PORT}"

API_PID=""
WEB_PID=""

cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" >/dev/null 2>&1 || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" >/dev/null 2>&1 || true
  # Killing by PORT as well as by PID, for the reason run-dashboard.sh's own
  # cleanup documents: `bun run dev` forks vite rather than exec-ing into it,
  # so the tracked PID is not always the process holding the port.
  for port in "$API_PORT" "$WEB_PORT"; do
    lsof -ti "tcp:${port}" 2>/dev/null | xargs kill >/dev/null 2>&1 || true
  done
  pkill -f "ffmpeg .*rtmp://localhost:1935/live/" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  echo "==> logs kept for inspection in $WORKDIR (delete when done)"
}
trap cleanup EXIT

# ---------------------------------------------------------------- fresh start
echo "==> killing anything stale on :${API_PORT}, :${WEB_PORT}, :${NGINX_ORIGIN_PORT}"
for port in "$API_PORT" "$WEB_PORT" "$NGINX_ORIGIN_PORT"; do
  lsof -ti "tcp:${port}" 2>/dev/null | xargs kill -9 >/dev/null 2>&1 || true
done
pkill -f "ffmpeg .*rtmp://localhost:1935/live/" >/dev/null 2>&1 || true
docker ps -a --format '{{.Names}}' | grep -E '^whip-(dashboard-verify|gate)-nginx-' \
  | xargs -I{} docker rm -f {} >/dev/null 2>&1 || true

for f in "$REPO_ROOT/infra/.env" "$REPO_ROOT/apps/api/.env"; do
  [ -f "$f" ] || { echo "Missing $f — see CONTRIBUTING.md's local setup steps." >&2; exit 1; }
done
# shellcheck disable=SC1091
set -a; source "$REPO_ROOT/infra/.env"; set +a
: "${MEDIAMTX_WEBHOOK_SECRET:?MEDIAMTX_WEBHOOK_SECRET must be set in infra/.env}"
XENDIT_CALLBACK_TOKEN="$(grep -E '^XENDIT_CALLBACK_TOKEN=' "$REPO_ROOT/apps/api/.env" | head -1 | cut -d= -f2-)"
[ -n "$XENDIT_CALLBACK_TOKEN" ] || { echo "XENDIT_CALLBACK_TOKEN missing from apps/api/.env" >&2; exit 1; }

for container in infra-postgres-1 infra-mediamtx-1; do
  docker ps --format '{{.Names}}' | grep -qx "$container" || {
    echo "$container is not running — docker compose -f infra/docker-compose.yml up -d" >&2
    exit 1
  }
done

# MediaMTX is RESTARTED, not merely reused: its own log is one of the four
# places this gate greps for the stream key, and a container that has been up
# since an earlier task carries earlier keys in its log. A fresh container
# means every line the grep sees belongs to this run.
echo "==> recreating MediaMTX so its log contains only THIS run"
docker compose -f "$REPO_ROOT/infra/docker-compose.yml" up -d --force-recreate mediamtx >/dev/null
for _ in $(seq 1 30); do
  docker logs infra-mediamtx-1 2>&1 | grep -q "\[WebRTC\] started" && break
  sleep 0.5
done
docker logs infra-mediamtx-1 2>&1 | grep -E "started with listener" || true

# ---------------------------------------------------------------- nginx
echo "==> rendering the ACTUAL live-hls.conf.template (127.0.0.1 -> host.docker.internal)"
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

echo "==> starting the nginx harness on ${NGINX_ORIGIN}"
docker network create "$NETWORK_NAME" >/dev/null
docker run -d --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --add-host=host.docker.internal:host-gateway \
  -p "${NGINX_ORIGIN_PORT}:8443" \
  -v "$WORKDIR/server.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$WORKDIR/rendered.conf:/etc/nginx/snippets/rendered.conf:ro" \
  nginx:1.27-alpine >/dev/null
docker exec "$CONTAINER_NAME" nginx -t
for _ in $(seq 1 20); do curl -s -o /dev/null "$NGINX_ORIGIN/" && break; sleep 0.5; done

# ---------------------------------------------------------------- apps/api
echo "==> starting apps/api on :${API_PORT} with both MediaMTX base URLs = ${NGINX_ORIGIN}"
(cd "$REPO_ROOT/apps/api" && MEDIAMTX_HLS_BASE_URL="$NGINX_ORIGIN" MEDIAMTX_WHIP_BASE_URL="$NGINX_ORIGIN" \
  exec bun run --hot src/server.ts > "$WORKDIR/api.log" 2>&1) &
API_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://localhost:${API_PORT}/health" && break
  sleep 0.5
done
curl -s -o /dev/null "http://localhost:${API_PORT}/health" || {
  echo "apps/api never came up:" >&2; cat "$WORKDIR/api.log" >&2; exit 1;
}

echo "==> starting apps/web on :${WEB_PORT}"
(cd "$REPO_ROOT/apps/web" && exec bun run dev > "$WORKDIR/web.log" 2>&1) &
WEB_PID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://localhost:${WEB_PORT}/" && break; sleep 0.5; done
curl -s -o /dev/null "http://localhost:${WEB_PORT}/" || {
  echo "apps/web never came up:" >&2; cat "$WORKDIR/web.log" >&2; exit 1;
}

API="http://localhost:${API_PORT}"
WEB="http://localhost:${WEB_PORT}"

psql_q() { docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" infra-postgres-1 \
  psql -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"; }

# ---------------------------------------------------------------- fixtures
echo "==> creating a real creator, community, tier, and a PAYING member"
SUFFIX="$$"
SIGNUP=$(curl -s -X POST "$API/auth/signup" -H "Content-Type: application/json" \
  -d "{\"name\":\"Gate Tester\",\"email\":\"gate+${SUFFIX}@example.com\",\"password\":\"supersecret123\"}")
TOKEN=$(echo "$SIGNUP" | jq -r '.token')
[ "$TOKEN" != "null" ] || { echo "signup failed: $SIGNUP" >&2; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

curl -s -X POST "$API/payment-account" "${AUTH[@]}" >/dev/null
COMMUNITY=$(curl -s -X POST "$API/communities" "${AUTH[@]}" \
  -d "{\"name\":\"Gate Community\",\"slug\":\"gate-${SUFFIX}\"}")
COMMUNITY_ID=$(echo "$COMMUNITY" | jq -r '.id')
COMMUNITY_SLUG=$(echo "$COMMUNITY" | jq -r '.slug')
[ "$COMMUNITY_ID" != "null" ] || { echo "community failed: $COMMUNITY" >&2; exit 1; }

TIER=$(curl -s -X POST "$API/communities/$COMMUNITY_ID/tiers" "${AUTH[@]}" \
  -d '{"name":"Basic","priceAmount":50000,"billingCycle":"monthly"}')
TIER_ID=$(echo "$TIER" | jq -r '.id')
[ "$TIER_ID" != "null" ] || { echo "tier failed: $TIER" >&2; exit 1; }

CHECKOUT=$(curl -s -X POST "$API/c/$COMMUNITY_SLUG/checkout" -H "Content-Type: application/json" \
  -d "{\"tierId\":\"$TIER_ID\",\"payerName\":\"Siti\",\"payerWhatsappNumber\":\"+6281234567890\"}")
SUBSCRIPTION_ID=$(echo "$CHECKOUT" | jq -r '.subscriptionId')
TRANSACTION_ID=$(echo "$CHECKOUT" | jq -r '.transactionId')
[ "$SUBSCRIPTION_ID" != "null" ] || { echo "checkout failed: $CHECKOUT" >&2; exit 1; }

# The gateway reference the payment webhook must echo back — read from the real
# transaction row rather than guessed from FakePaymentAdapter's counter.
GATEWAY_REF=$(psql_q "select gateway_reference_id from transaction where id = '$TRANSACTION_ID'")

# A LOCAL-DEV-ONLY WART THIS HARNESS HAS TO STEP AROUND, recorded here because
# it cost a debugging round and will cost the next person one too:
# `FakePaymentAdapter` (the provider `bootstrap()` selects when no Xendit key is
# configured — i.e. every local dev box) mints invoice ids from an IN-MEMORY
# counter: `fake-inv-1`, `fake-inv-2`, ... It restarts at 1 with every API
# process, while Postgres persists across them. `HandlePaymentWebhook`'s replay
# guard keys on `<invoiceId>:<status>`, so the FIRST checkout of every fresh API
# process collides with `fake-inv-1:PAID` from any earlier session — and a
# replay is answered `200 {"received":true}` with the subscription left
# `pending` and nothing logged, which looks exactly like success. Only the fake
# is affected: the real `XenditPaymentAdapter` gets globally unique invoice ids
# from Xendit itself, and the test suite resets the database per test. This
# deletes the colliding row so THIS run's delivery is genuinely new; it does not
# touch the code path under test.
psql_q "delete from webhook_event where provider = 'xendit' and provider_event_id = '${GATEWAY_REF}:PAID'" >/dev/null
curl -s -o /dev/null -X POST "$API/webhooks/xendit" \
  -H "Content-Type: application/json" -H "X-CALLBACK-TOKEN: $XENDIT_CALLBACK_TOKEN" \
  -d "{\"id\":\"$GATEWAY_REF\",\"external_id\":\"$TRANSACTION_ID\",\"status\":\"PAID\",\"amount\":50000}"
SUB_STATUS=$(curl -s "$API/c/subscription/$SUBSCRIPTION_ID/status" | jq -r '.status')
echo "==> member subscription status after the PAID webhook: $SUB_STATUS"
[ "$SUB_STATUS" = "active" ] || { echo "member subscription never became active" >&2; exit 1; }

new_session() {
  local title="$1"
  curl -s -X POST "$API/communities/$COMMUNITY_ID/events" "${AUTH[@]}" -d "{\"title\":\"$title\"}"
}
session_field() { echo "$1" | jq -r ".$2"; }
event_status() {
  curl -s "$API/communities/$COMMUNITY_ID/events" -H "Authorization: Bearer $TOKEN" \
    | jq -r ".[] | select(.title==\"$1\") | .status"
}
wait_for_status() {
  local title="$1" want="$2" seen=""
  for _ in $(seq 1 40); do
    seen=$(event_status "$title")
    [ "$seen" = "$want" ] && { echo "$seen"; return 0; }
    sleep 0.5
  done
  echo "$seen"
}

GATE_TITLE="gate ${SUFFIX} browser+member"
RTMP_TITLE="gate ${SUFFIX} obs rtmp"
RACE_A_TITLE="gate ${SUFFIX} race ffmpeg-first"
RACE_B_TITLE="gate ${SUFFIX} race browser-first"
RACE_C_TITLE="gate ${SUFFIX} race armed-browser"

GATE_SESSION=$(new_session "$GATE_TITLE")
RTMP_SESSION=$(new_session "$RTMP_TITLE")
RACE_A_SESSION=$(new_session "$RACE_A_TITLE")
RACE_B_SESSION=$(new_session "$RACE_B_TITLE")
RACE_C_SESSION=$(new_session "$RACE_C_TITLE")

GATE_EVENT_ID=$(session_field "$GATE_SESSION" id)
GATE_KEY=$(session_field "$GATE_SESSION" streamKey)
RTMP_URL=$(session_field "$RTMP_SESSION" rtmpUrl)
RTMP_KEY=$(session_field "$RTMP_SESSION" streamKey)
RACE_A_RTMP=$(session_field "$RACE_A_SESSION" rtmpUrl)
RACE_A_KEY=$(session_field "$RACE_A_SESSION" streamKey)
RACE_B_RTMP=$(session_field "$RACE_B_SESSION" rtmpUrl)
RACE_B_KEY=$(session_field "$RACE_B_SESSION" streamKey)
RACE_C_RTMP=$(session_field "$RACE_C_SESSION" rtmpUrl)
RACE_C_KEY=$(session_field "$RACE_C_SESSION" streamKey)
echo "==> five sessions created (stream keys deliberately NOT echoed)"

echo "==> installing this harness's own playwright"
(cd "$SCRIPT_DIR" && bun install --silent)

# A synthetic RTMP publish — the OBS/Streamlabs equivalent the previous phase
# used. `-re` paces it at real time like a real encoder; testsrc2/sine give
# real, changing video and audio.
ffmpeg_publish() {
  local url="$1" log="$2"
  ffmpeg -hide_banner -loglevel warning \
    -re -f lavfi -i "testsrc2=size=320x240:rate=15" \
    -re -f lavfi -i "sine=frequency=440:sample_rate=44100" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 \
    -c:a aac -ar 44100 -b:a 64k -f flv "$url" > "$log" 2>&1 &
  echo $!
}

STATUSES=()
record() { STATUSES+=("$1=$2"); }

# ============================================================= CHECK 1
echo
echo "############ CHECK 1: browser publish + member watch page ############"
GATE_STATUS=0
(cd "$SCRIPT_DIR" && bun drive-gate.mjs "$TOKEN" "$COMMUNITY_ID" "$GATE_TITLE" \
  "$SUBSCRIPTION_ID" "$WEB" "$API") || GATE_STATUS=$?
record gate "$GATE_STATUS"

echo "---- activity_log rows for this event, straight from Postgres ----"
psql_q "select event_type, metadata->>'eventId' as event_id, community_id is not null as has_community, member_id is null as member_id_null from activity_log where metadata->>'eventId' = '$GATE_EVENT_ID' order by created_at"

# ============================================================= CHECK 2
echo
echo "############ CHECK 2: OBS/RTMP still works (ffmpeg) ############"
FF_LOG="$WORKDIR/ffmpeg-rtmp.log"
FF_PID=$(ffmpeg_publish "$RTMP_URL" "$FF_LOG")
RTMP_LIVE=$(wait_for_status "$RTMP_TITLE" live)
echo "==> server-reported status while ffmpeg publishes: $RTMP_LIVE"
echo "---- MediaMTX log for this RTMP publish ----"
docker logs infra-mediamtx-1 2>&1 | grep -E "RTMP" | tail -5
kill "$FF_PID" >/dev/null 2>&1 || true
wait "$FF_PID" 2>/dev/null || true
RTMP_ENDED=$(wait_for_status "$RTMP_TITLE" ended)
echo "==> server-reported status after ffmpeg stops: $RTMP_ENDED"
[ "$RTMP_LIVE" = "live" ] && [ "$RTMP_ENDED" = "ended" ] && record rtmp 0 || record rtmp 1

# ============================================================= CHECK 3a
echo
echo "############ CHECK 3a: browser publish refused while ffmpeg holds the key ############"
echo "---- 3a-i: the page is loaded AFTER the status flipped (client-side guard) ----"
FF_A_LOG="$WORKDIR/ffmpeg-race-a.log"
FF_A_PID=$(ffmpeg_publish "$RACE_A_RTMP" "$FF_A_LOG")
RACE_A_LIVE=$(wait_for_status "$RACE_A_TITLE" live)
echo "==> ffmpeg holds the key; server-reported status: $RACE_A_LIVE"

RACE_A1_STATUS=0
(cd "$SCRIPT_DIR" && bun drive-second-publisher.mjs "$TOKEN" "$COMMUNITY_ID" "$RACE_A_TITLE" \
  "$WEB" --expect=disabled) || RACE_A1_STATUS=$?
record race-a-ui-guard "$RACE_A1_STATUS"

kill "$FF_A_PID" >/dev/null 2>&1 || true
wait "$FF_A_PID" 2>/dev/null || true
wait_for_status "$RACE_A_TITLE" ended >/dev/null

echo
echo "---- 3a-ii: the page was ALREADY loaded and armed when ffmpeg took the key ----"
# The harder, more realistic half, and the one that actually exercises the
# refusal: the client-side `liveElsewhere` guard cannot fire, because this page
# rendered while the session was still `scheduled`. The WHIP POST genuinely
# goes out, MediaMTX genuinely refuses it (`overridePublisher: false`), and
# what is under test is whether the CREATOR sees a sentence explaining that
# rather than a spinner or a silent nothing.
#
# An earlier version of this check used `curl --data-binary 'v=0'` instead.
# That was worthless and is recorded here so nobody re-adds it: MediaMTX
# rejects the malformed SDP (`400 {"error":"EOF"}`) BEFORE it ever considers
# whether the path already has a publisher, so the check passed identically
# whether or not a second publisher would have been refused.
MARKERS_A="$WORKDIR/markers-a"; mkdir -p "$MARKERS_A"
RACE_A2_LOG="$WORKDIR/second-publisher-rejected.log"
RACE_A2_STATUS=0
(cd "$SCRIPT_DIR" && bun drive-second-publisher.mjs "$TOKEN" "$COMMUNITY_ID" "$RACE_C_TITLE" \
  "$WEB" --expect=rejected "$MARKERS_A" > "$RACE_A2_LOG" 2>&1) &
RACE_A2_PID=$!
for _ in $(seq 1 120); do [ -f "$MARKERS_A/ready" ] && break; sleep 0.5; done
if [ ! -f "$MARKERS_A/ready" ]; then
  echo "==> the second-publisher page never armed; see $RACE_A2_LOG" >&2
  cat "$RACE_A2_LOG" >&2
  record race-a-whip-refusal 1
else
  echo "==> page armed while the session is still scheduled; starting ffmpeg on the same key"
  FF_A2_LOG="$WORKDIR/ffmpeg-race-a2.log"
  FF_A2_PID=$(ffmpeg_publish "$RACE_C_RTMP" "$FF_A2_LOG")
  RACE_A2_LIVE=$(wait_for_status "$RACE_C_TITLE" live)
  echo "==> ffmpeg holds the key; server-reported status: $RACE_A2_LIVE"
  touch "$MARKERS_A/go"
  wait "$RACE_A2_PID" || RACE_A2_STATUS=$?
  cat "$RACE_A2_LOG"
  echo "---- MediaMTX's own refusal of that WHIP session ----"
  docker logs infra-mediamtx-1 --since 60s 2>&1 | grep -iE "WebRTC|already publishing" | tail -6
  echo "---- ffmpeg (the FIRST publisher) survived the attempt? ----"
  kill -0 "$FF_A2_PID" 2>/dev/null && echo "YES — still publishing" || echo "NO — it was displaced"
  kill -0 "$FF_A2_PID" 2>/dev/null || RACE_A2_STATUS=1
  echo "==> server-reported status after the refused attempt: $(event_status "$RACE_C_TITLE")"
  [ "$(event_status "$RACE_C_TITLE")" = "live" ] || RACE_A2_STATUS=1
  kill "$FF_A2_PID" >/dev/null 2>&1 || true
  wait "$FF_A2_PID" 2>/dev/null || true
  record race-a-whip-refusal "$RACE_A2_STATUS"
fi

# ============================================================= CHECK 3b
echo
echo "############ CHECK 3b: ffmpeg (OBS) refused while a browser publish holds the key ############"
MARKERS="$WORKDIR/markers"; mkdir -p "$MARKERS"
HOLD_LOG="$WORKDIR/hold-live.log"
(cd "$SCRIPT_DIR" && bun drive-hold-live.mjs "$TOKEN" "$COMMUNITY_ID" "$RACE_B_TITLE" \
  "$WEB" "$MARKERS" 60 > "$HOLD_LOG" 2>&1) &
HOLD_SHELL_PID=$!
for _ in $(seq 1 120); do [ -f "$MARKERS/live" ] && break; sleep 0.5; done
if [ ! -f "$MARKERS/live" ]; then
  echo "==> the browser publish never went live; see $HOLD_LOG" >&2
  cat "$HOLD_LOG" >&2
  record race-b 1
else
  RACE_B_LIVE=$(wait_for_status "$RACE_B_TITLE" live)
  echo "==> browser holds the key; server-reported status: $RACE_B_LIVE"
  echo "==> now attempting an ffmpeg RTMP publish to the SAME key:"
  # BOUNDED BY THIS SCRIPT, not by ffmpeg's own `-t`, and the difference is the
  # whole point of the check. Before `overridePublisher: false`, this ffmpeg was
  # ACCEPTED (it took the path over) and then ran for eleven minutes, ignoring
  # `-t 5` because that limits the INPUT duration of a live lavfi source, not
  # the process. "Still running after N seconds" is therefore the exact symptom
  # of a NOT-refused second publisher, and it has to be measured rather than
  # waited on — the earlier version of this check simply blocked forever and
  # then recorded a PASS when cleanup killed ffmpeg, which is a false pass.
  ffmpeg -hide_banner -loglevel info \
    -re -f lavfi -i "testsrc2=size=320x240:rate=15" \
    -re -f lavfi -i "sine=frequency=440:sample_rate=44100" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -f flv "$RACE_B_RTMP" \
    > "$WORKDIR/ffmpeg-race-b.log" 2>&1 &
  FF_B_PID=$!
  FF_B_EXIT=""
  for _ in $(seq 1 30); do
    if ! kill -0 "$FF_B_PID" 2>/dev/null; then
      # `|| FF_B_EXIT=$?`, not a bare `wait` inside a `{ }` group: `set -e`
      # aborts the whole script on a failing `wait`, and a FAILING ffmpeg is
      # the success case here. (Measured: the earlier version of this loop
      # killed the script at exactly this line, skipping check 4 entirely.)
      FF_B_EXIT=0
      wait "$FF_B_PID" || FF_B_EXIT=$?
      break
    fi
    sleep 1
  done
  RACE_B_STATUS=0
  if [ -z "$FF_B_EXIT" ]; then
    echo "==> ffmpeg is STILL PUBLISHING after 30s — it was NOT refused"
    kill -9 "$FF_B_PID" >/dev/null 2>&1 || true
    RACE_B_STATUS=1
  else
    echo "==> ffmpeg exited with $FF_B_EXIT (non-zero = refused, which is what this check wants)"
    [ "$FF_B_EXIT" -ne 0 ] || RACE_B_STATUS=1
  fi
  echo "---- ffmpeg's own last lines ----"
  tail -5 "$WORKDIR/ffmpeg-race-b.log"
  echo "---- MediaMTX's own refusal line ----"
  docker logs infra-mediamtx-1 --since 60s 2>&1 | grep -iE "already publish|RTMP" | tail -5

  # Refusing the newcomer is only half of what "refused" has to mean. The
  # INCUMBENT — the creator's browser publish — must still be on the air, and
  # the event must still read `live`. Before the fix, both of these failed:
  # the WebRTC session was `closed: terminated` and the event was `ended`.
  RACE_B_STATUS_AFTER=$(event_status "$RACE_B_TITLE")
  echo "==> server-reported status after the refused attempt: $RACE_B_STATUS_AFTER"
  [ "$RACE_B_STATUS_AFTER" = "live" ] || RACE_B_STATUS=1
  STOP_BUTTON=$(grep -c "hold-live: LIVE" "$HOLD_LOG" || true)
  echo "==> the browser publish is still held (marker present): $([ -f "$MARKERS/live" ] && echo yes || echo no), go-live confirmations in its log: $STOP_BUTTON"

  touch "$MARKERS/release"
  wait "$HOLD_SHELL_PID" || RACE_B_STATUS=1
  cat "$HOLD_LOG"
  record race-b "$RACE_B_STATUS"
fi

# ============================================================= CHECK 4
echo
echo "############ CHECK 4: the stream key appears in NO log line ############"
docker logs "$CONTAINER_NAME" > "$WORKDIR/nginx-stdout.log" 2>"$WORKDIR/nginx-stderr.log" || true
docker logs infra-mediamtx-1 > "$WORKDIR/mediamtx.log" 2>&1 || true

LEAKS=0
for key in "$GATE_KEY" "$RTMP_KEY" "$RACE_A_KEY" "$RACE_B_KEY" "$RACE_C_KEY"; do
  # nginx ACCESS log (stdout in the official image) — the `/whip/` location's
  # `access_log off` is what this proves. nginx's ERROR log (stderr) is
  # EXCLUDED ON PURPOSE: this project decided deliberately (see
  # live-hls.conf.template's own comment) that the error log is
  # secret-bearing and must be handled as such, rather than being silenced.
  if grep -q "$key" "$WORKDIR/nginx-stdout.log"; then
    echo "LEAK: nginx access log (stdout) contains a stream key"; LEAKS=$((LEAKS+1))
  fi
  if grep -q "$key" "$WORKDIR/api.log"; then
    echo "LEAK: apps/api's own output contains a stream key"; LEAKS=$((LEAKS+1))
  fi
  if grep -q "$key" "$WORKDIR/web.log"; then
    echo "LEAK: apps/web's dev-server output contains a stream key"; LEAKS=$((LEAKS+1))
  fi
  # MediaMTX's log is reported, NOT failed on: it logs its own path names
  # (`[path live/<key>]`) by design and this project has never claimed
  # otherwise — see the report for how that is judged.
  MTX_HITS=$(grep -c "$key" "$WORKDIR/mediamtx.log" || true)
  NGX_ERR_HITS=$(grep -c "$key" "$WORKDIR/nginx-stderr.log" || true)
  echo "key ...${key: -6}: nginx-access=$(grep -c "$key" "$WORKDIR/nginx-stdout.log" || true) nginx-error=$NGX_ERR_HITS api=$(grep -c "$key" "$WORKDIR/api.log" || true) web=$(grep -c "$key" "$WORKDIR/web.log" || true) mediamtx=$MTX_HITS"
done
echo "---- how many lines nginx's access log holds at all (proving it IS logging elsewhere) ----"
wc -l < "$WORKDIR/nginx-stdout.log"
grep -E "GET /live/" "$WORKDIR/nginx-stdout.log" | head -3 || echo "(no /live/ lines — access_log off there too)"
[ "$LEAKS" -eq 0 ] && record no-key-in-logs 0 || record no-key-in-logs 1

echo
echo "############ SUMMARY ############"
FAILED=0
for entry in "${STATUSES[@]}"; do
  name="${entry%%=*}"; status="${entry##*=}"
  if [ "$status" = "0" ]; then echo "PASS  $name"; else echo "FAIL  $name (exit $status)"; FAILED=1; fi
done
[ "$FAILED" -eq 0 ] && echo "==> ALL GATE CHECKS PASSED" || echo "==> AT LEAST ONE GATE CHECK FAILED" >&2
exit "$FAILED"
