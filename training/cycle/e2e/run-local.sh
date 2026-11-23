#!/bin/sh
# Local end to end of the cycle against the local site dev-e2e (contract 4.4): simulated players
# make test records, the cron writes the export, the bridge carries them to the S3 stand-in, a full
# cycle runs with a forced gate, the new version is served, the A/B arms show in new records, the
# daily check runs, rollback v1 is served again, and the final listing holds only test data.
#
#   training/cycle/e2e/run-local.sh            12 devices, 3 matches each
#   training/cycle/e2e/run-local.sh --human    60 devices, 2 matches each, thresholds / 25
#
# Needs dev-e2e running (docker compose --profile e2e up -d dev-e2e) and the MinIO values in .env.
# The stand-in stops at the end, also on failure.
set -eu
cd "$(dirname "$0")/../../.."
HUMAN=0
[ "${1:-}" = "--human" ] && HUMAN=1
CFG=training/cycle/config/local.toml
BASE=http://dev-e2e:8788
mkdir -p training/logs
LOG=training/logs/e2e-local.log
say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
if [ "$HUMAN" = 1 ]; then
  cycle() { docker compose --profile cycle run --rm -T -e ZAP_CYCLE_TEST_THRESHOLDS=1 cycle python training/cycle/cycle.py --config "$CFG" "$@"; }
else
  cycle() { docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config "$CFG" "$@"; }
fi
check() { docker compose --profile cycle run --rm -T cycle python training/cycle/e2e/check.py --config "$CFG" "$@"; }
nodecmd() { docker compose run --rm -T node node "$@"; }
bridge_in() { nodecmd training/cycle/bridge/bridge.ts export --state e2e && cycle bridge push --state e2e; }
bridge_out() { cycle bridge pull --state e2e && nodecmd training/cycle/bridge/bridge.ts import --state e2e; }

say "1. checks"
nodecmd -e "fetch('$BASE/').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))" || { say "dev-e2e does not answer: docker compose --profile e2e up -d dev-e2e"; exit 1; }
grep -Eq '^MINIO_ROOT_USER=.{3,}' .env && grep -Eq '^MINIO_ROOT_PASSWORD=.{8,}' .env || { say "set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env (see .env.example)"; exit 1; }
docker compose config -q

say "2. S3 stand-in and init"
STARTED=0
stop() { [ "$STARTED" = 1 ] && docker compose --profile cycle-dev stop minio >/dev/null 2>&1; return 0; }
trap stop EXIT INT TERM
docker compose --profile cycle-dev up -d minio
STARTED=1
for i in 1 2 3 4 5 6 7 8 9 10; do
  docker compose --profile cycle run --rm -T cycle python -c "import socket; socket.create_connection(('minio', 9000), 2)" 2>/dev/null && break
  sleep 1
done
docker compose --profile cycle run --rm -T cycle python training/cycle/e2e/reset.py --config "$CFG"
rm -rf .cache/bridge/e2e
cycle init
bridge_out

say "3. simulated players"
if [ "$HUMAN" = 1 ]; then DEV=60; MATCHES=2; else DEV=12; MATCHES=3; fi
nodecmd training/cycle/sim/run.ts --base "$BASE" --devices "$DEV" --matches "$MATCHES" --seed 7 --concurrency 4 --out .cache/sim/e2e-1.json

say "4. cron (export), bridge to the stand-in"
nodecmd worker/dev/trigger-cron.ts --base "$BASE"
bridge_in

say "5. one full cycle with the gate forced to pass, then the new version to the site"
cycle run --force pass
bridge_out
check manifest v2 v1

say "6. matches after the manifest cache expired: arms and versions"
sleep 7
nodecmd training/cycle/sim/run.ts --base "$BASE" --devices 12 --matches 2 --seed 8 --concurrency 4 --out .cache/sim/e2e-2.json
bridge_in
check arms e2e v2 v1

say "7. daily A/B check, rollback v1, a new match plays v1"
cycle ab
cycle rollback v1
bridge_out
sleep 7
nodecmd training/cycle/sim/run.ts --base "$BASE" --devices 1 --matches 1 --seed 9 --concurrency 1 --out .cache/sim/e2e-3.json
bridge_in
check plays e2e v1

say "8. final listing"
check listing
cycle status
say "all steps done"
