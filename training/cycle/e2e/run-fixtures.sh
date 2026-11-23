#!/bin/sh
# Local end to end of the cycle on fixture records, without a Worker (training/cycle/README.md):
# the S3 stand-in, init, fixture records pushed to zap-test-unit-events, sync, build, train
# (2 iterations of 5,000 decisions, 1 worker, 1 thread), the gate with small sizes, a forced pass,
# publish, the refusals while the A/B window is open, the daily A/B check, rollback v1, status and
# the final listing. Profile test. About 5 minutes on one core. The stand-in stops at the end,
# also on failure.
set -eu
cd "$(dirname "$0")/../../.."
CFG=training/cycle/config/test.toml
LOG=training/logs/test/e2e-fixtures.log
mkdir -p training/logs/test
say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
cycle() { docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config "$CFG" "$@"; }
check() { docker compose --profile cycle run --rm -T cycle python training/cycle/e2e/check.py --config "$CFG" "$@"; }

grep -Eq '^MINIO_ROOT_USER=.{3,}' .env && grep -Eq '^MINIO_ROOT_PASSWORD=.{8,}' .env || { echo "set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env (see .env.example)"; exit 1; }
docker compose config -q
STARTED=0
stop() { [ "$STARTED" = 1 ] && docker compose --profile cycle-dev stop minio >/dev/null 2>&1; return 0; }
trap stop EXIT INT TERM
docker compose --profile cycle-dev up -d minio
STARTED=1
for i in 1 2 3 4 5 6 7 8 9 10; do
  docker compose --profile cycle run --rm -T cycle python -c "import socket; socket.create_connection(('minio', 9000), 2)" 2>/dev/null && break
  sleep 1
done

say "reset the test profile"
docker compose --profile cycle run --rm -T cycle python training/cycle/e2e/reset.py --config "$CFG"
rm -rf .cache/bridge/fixtures
say "init"
cycle init
say "fixture records"
docker compose run --rm -T node node training/cycle/e2e/make-fixtures.ts --out .cache/bridge/fixtures/events --matches 40 --seed 11
cycle bridge push --state fixtures
say "sync"
cycle sync
say "build"
cycle build
say "train"
cycle train
check setups
say "gate as measured"
cycle gate
say "gate forced to pass (minio mode only)"
cycle gate --force pass
say "publish"
cycle publish
check manifest v2 v1
say "while the A/B window is open: no cycle, no second promotion"
set +e
cycle run >/dev/null 2>&1; RC=$?
set -e
[ "$RC" = 2 ] || { say "run should be refused with exit code 2, got $RC"; exit 1; }
say "records of the A/B window and the daily check"
docker compose run --rm -T node node training/cycle/e2e/make-fixtures.ts --out .cache/bridge/fixtures/events --matches 24 --seed 12 --arms v2:v1 --start "$(date -u -d '+1 minute' '+%Y-%m-%dT%H:%M:%SZ')"
cycle bridge push --state fixtures
cycle ab
say "rollback v1"
cycle rollback v1
check manifest v1 none
say "status"
cycle status
check listing
say "all steps done"
