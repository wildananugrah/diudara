#!/usr/bin/env bash
#
# Restart the API and worker so they re-read apps/api/.env, then PROVE they did
# by showing the provider decisions from the new boot.
#
#   scripts/restart.sh
#   scripts/restart.sh --dry-run     # report only; touches nothing
#
# WHY A RESTART IS THE WHOLE MECHANISM: bootstrap() reads process.env once, at
# boot. Nothing re-reads .env while a process lives, so an edited file changes
# nothing until the process is replaced.
#
# WHY BOTH APPS: they share ONE env file. pm2 runs the worker from apps/worker,
# which has no .env of its own — apps/worker/src/main.ts calls loadApiEnv()
# before importing the composition root precisely because of that. Restarting
# only the API leaves the worker on the old configuration.
#
# WHY NOT `pm2 restart --update-env`: bun lets real environment variables take
# precedence over .env, so pushing the invoking shell's environment into pm2
# can override the very file this script exists to reload. A plain restart
# re-executes run.sh with the env pm2 already has, and bun reads the file.
set -euo pipefail

APPS=(diudara-api diudara-worker)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env"
WAIT_SECONDS=45

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

command -v pm2 >/dev/null || { echo "pm2 is not on PATH — is this the deploy host?" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE — nothing to reload" >&2; exit 1; }

# name<TAB>pid<TAB>status<TAB>out_log_path, for our apps only.
snapshot() {
  pm2 jlist | python3 -c '
import json, sys
want = set(sys.argv[1:])
for app in json.load(sys.stdin):
    if app["name"] in want:
        env = app["pm2_env"]
        print("\t".join([app["name"], str(app.get("pid") or 0), env.get("status", ""), env.get("pm_out_log_path", "")]))
' "${APPS[@]}"
}

declare -A OLD_PID OLD_SIZE LOG_PATH
while IFS=$'\t' read -r name pid status log; do
  OLD_PID[$name]=$pid
  LOG_PATH[$name]=$log
  # Byte offset now, so afterwards we read ONLY the new boot's output. Reading
  # the whole file would show the previous boot's decisions and call them fresh.
  OLD_SIZE[$name]=$( [ -n "$log" ] && [ -f "$log" ] && stat -c %s "$log" || echo 0 )
  printf '  %-16s pid=%-8s %s\n' "$name" "$pid" "$status"
done < <(snapshot)

if [ ${#OLD_PID[@]} -eq 0 ]; then
  echo "none of ${APPS[*]} are known to pm2" >&2; exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "  --dry-run: would restart ${APPS[*]} and read each log from the offset above."
  exit 0
fi

echo
echo "  restarting ${APPS[*]} ..."
pm2 restart "${APPS[@]}" >/dev/null

# A new pid is the only honest proof the process was replaced: pm2 reports
# "online" for the OLD process too, right up until it is killed.
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  pending=0
  while IFS=$'\t' read -r name pid status _; do
    if [ "$status" != "online" ] || [ "$pid" = "${OLD_PID[$name]}" ] || [ "$pid" = "0" ]; then
      pending=1
    fi
  done < <(snapshot)
  [ "$pending" = "0" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "  TIMED OUT after ${WAIT_SECONDS}s — current state:" >&2
    snapshot >&2
    echo "  check: pm2 logs ${APPS[0]} --err --lines 40" >&2
    exit 1
  fi
  sleep 1
done

echo
found_any=0
for name in "${APPS[@]}"; do
  log="${LOG_PATH[$name]}"
  echo "  --- $name (new boot) ---"
  lines=""
  # The bootstrap banner is written a moment after the process is up.
  for _ in $(seq 1 20); do
    lines=$(tail -c "+$(( ${OLD_SIZE[$name]} + 1 ))" "$log" 2>/dev/null | grep -a '\[bootstrap\]' || true)
    [ -n "$lines" ] && break
    sleep 1
  done
  if [ -n "$lines" ]; then
    found_any=1
    printf '%s\n' "$lines" | sed 's/^/    /' | cut -c1-200
  else
    echo "    (no [bootstrap] lines yet — try: pm2 logs $name --lines 50)"
  fi
  echo
done

if [ "$found_any" = "0" ]; then
  echo "  restarted, but neither app printed its provider decisions — treat as UNVERIFIED." >&2
  exit 1
fi

echo "  Read the lines above: they are the new process reporting which adapter it chose."
echo "  'DISABLED' or a Fake* adapter means the env var it names did not reach this boot."
