#!/bin/sh
# Local end to end proof of the training cycle on the dev site (http://dev:8787), with small sizes.
# Evidence lands in .cache/e2e-cycle/ (one JSON file per check, run.log for every command) and is
# written up in _local/m6/e2e-cycle.md.
#
#   tests/sim/cycle-e2e.sh            every step from the start (empties the e2e test buckets and
#                                     the dev site's zap-models first)
#   tests/sim/cycle-e2e.sh 7 [9]      from step 7 on (to step 9), with the times saved by the earlier steps
#
# Steps:
#   1  S3 stand-in up, e2e buckets empty, cycle init, manifest v1 to the site
#   2  simulated players (round 1), plus one person who plays like a metronome for many matches
#   3  daily cron on the site (export, receipt), bridge to the stand-in
#   4  cycle 1 with the production thresholds on every record the site holds; tiny training; the
#      real gate
#   5  cycle 2 with thresholds divided by 25 (ZAP_CYCLE_TEST_THRESHOLDS=1); the owner's first open
#      data release (a dry run); priors and flags back to the site, imported by the cron; the owner
#      reviews the flag
#   6  a deliberately weak model: adopt (the real gate refuses it), then the gate forced to pass
#      (minio mode only) and published, with an A/B window against v1
#   7  the site serves it within the cache time; a match that started before keeps v1; round 2
#   8  the daily A/B check sees the drop and rolls back to v1 by itself; a new match plays v1
#   9  the weak model made current by hand (rollback), then v1 adopted again passes the real gate
#      against it and is published, and the cycle releases open data on its own (a dry run, with
#      OPEN_DATA_ENABLED); round 4 shows the arms
#  10  training alert: a failed cycle step, then a stale status; one email each (local send_email)
#  11  guards: production names, remote endpoints and remote sites are refused; final listing
#  12  the human layers on a slice that holds only this run's round 1: off at the production
#      thresholds, on when they are divided by 25
#  13  cleanup: the dev site's zap-models emptied again, the stand-in stopped
#
# Needs the dev site (docker compose up -d dev), MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env,
# ALERT_FROM and ALERT_EMAIL in .dev.vars (see .dev.vars.example). The stand-in stops at the end,
# also on failure.
set -eu
cd "$(dirname "$0")/../.."
CFG=tests/sim/cycle-e2e.toml
BASE=http://dev:8787
STATE=dev
OUT=.cache/e2e-cycle
LOG=$OUT/run.log
VARS=$OUT/vars.env
TTL_MS=5000
FROM=${1:-1}
TO=${2:-13}
mkdir -p "$OUT"
[ -f "$VARS" ] && . "$VARS"

now() { date +%s%3N; }
say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
keep() { echo "$1=$2" >>"$VARS"; eval "$1=$2"; }
step() { [ "$FROM" -le "$1" ] && [ "$1" -le "$TO" ]; }

cyc() { docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config "$CFG" --json "$@" 2>>"$LOG"; }
cyc_small() { docker compose --profile cycle run --rm -T -e ZAP_CYCLE_TEST_THRESHOLDS=1 -e OPEN_DATA_ENABLED=true cycle python training/cycle/cycle.py --config "$CFG" --json "$@" 2>>"$LOG"; }
cyc_slice() { docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config tests/sim/cycle-e2e-slice.toml --json "$@" 2>>"$LOG"; }
cyc_slice_small() { docker compose --profile cycle run --rm -T -e ZAP_CYCLE_TEST_THRESHOLDS=1 -e OPEN_DATA_ENABLED=true cycle python training/cycle/cycle.py --config tests/sim/cycle-e2e-slice.toml --json "$@" 2>>"$LOG"; }
pyc() { docker compose --profile cycle run --rm -T cycle python "$@" 2>>"$LOG"; }
nodec() { docker compose run --rm -T node node "$@" 2>>"$LOG"; }
sim() { nodec training/cycle/sim/run.ts --base "$BASE" "$@"; }
bridge_in() { nodec training/cycle/bridge/bridge.ts export --state $STATE >>"$LOG" && cyc bridge push --state $STATE >>"$LOG"; }
bridge_out() { cyc bridge pull --state $STATE >>"$LOG" && nodec training/cycle/bridge/bridge.ts import --state $STATE >>"$LOG"; }
cron() { nodec worker/dev/trigger-cron.ts --base "$BASE" >>"$LOG" || say "the cron run reported a failed job (see the receipt)"; }
jget() { nodec -e "const j=JSON.parse(require('fs').readFileSync('$1','utf8')); console.log($2)"; }
check() { nodec tests/sim/check-records.ts "$@"; }
# keep_cycle NAME WORKROOT CYCLE_ID: copies the cycle's human layers and gate result into the evidence
# folder, since the cycle keeps only its newest work folders.
keep_cycle() {
  for part in human/result.json gate/result.json card.json; do
    [ -f "$2/$3/$part" ] && cp "$2/$3/$part" "$OUT/$1-$(echo "$part" | tr '/' '-')"
  done
  return 0
}
latest_work() { ls -d "$1"/*/ | sed 's#/$##' | sort | tail -1 | sed 's#.*/##'; }
site() { nodec tests/sim/local-site.ts "$@"; }
mails() { docker logs --since "$1" zap-dev-1 2>&1 | grep -c "send_email binding called" || true; }

STARTED=0
stop_minio() { [ "$STARTED" = 1 ] && docker compose --profile cycle-dev stop minio >/dev/null 2>&1; return 0; }
trap stop_minio EXIT INT TERM
minio_up() {
  docker compose --profile cycle-dev up -d minio >>"$LOG" 2>&1
  STARTED=1
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pyc -c "import socket; socket.create_connection(('minio', 9000), 2)" && return 0
    sleep 1
  done
  say "the S3 stand-in does not answer"
  exit 1
}

say "checks"
nodec -e "fetch('$BASE/').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))" || { say "the dev site does not answer: docker compose up -d dev"; exit 1; }
grep -Eq '^MINIO_ROOT_USER=.{3,}' .env && grep -Eq '^MINIO_ROOT_PASSWORD=.{8,}' .env || { say "set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env"; exit 1; }
grep -Eq '^ALERT_EMAIL=.+' .dev.vars && grep -Eq '^ALERT_FROM=.+' .dev.vars || { say "set ALERT_FROM and ALERT_EMAIL in .dev.vars (see .dev.vars.example)"; exit 1; }
docker compose config -q
minio_up

if step 1; then
  : >"$VARS"
  say "1. empty e2e buckets and folders, empty site models, cycle init, manifest to the site"
  pyc training/cycle/e2e/reset.py --config "$CFG" >>"$LOG"
  rm -rf .cache/bridge/$STATE "$OUT"/*.json "$OUT"/weak
  site clear-models --state $STATE >"$OUT/1-clear-models.json"
  cyc init >"$OUT/1-init.json"
  bridge_out
  site models --state $STATE >"$OUT/1-site-models.txt"
  keep T_START "$(now)"
fi

if step 2; then
  say "2. simulated players, round 1 (24 people, 3 matches each) and one metronome player (16 matches)"
  sim --devices 1 --matches 16 --seed 6 --concurrency 1 --trace --out "$OUT/sim-metronome.json" >"$OUT/2-sim-metronome.log" &
  BG=$!
  sim --devices 24 --matches 3 --seed 41 --concurrency 8 --trace --out "$OUT/sim-1.json" >"$OUT/2-sim-1.log"
  wait $BG
  cat "$OUT/2-sim-1.log" "$OUT/2-sim-metronome.log" | tee -a "$LOG"
fi

if step 3; then
  say "3. daily cron (export), bridge to the stand-in"
  cron
  site receipt --state $STATE >"$OUT/3-receipt.json"
  site export --state $STATE >"$OUT/3-export.json"
  bridge_in
fi

if step 4; then
  say "4. cycle 1, production thresholds on every record of the site, tiny training, the real gate"
  cyc run >"$OUT/4-cycle-1.json"
  keep_cycle 4-cycle-1 training/cycle/work/e2e "$(jget "$OUT/4-cycle-1.json" 'j.result.cycleId')"
  tail -c 600 "$OUT/4-cycle-1.json" | tee -a "$LOG"; echo
fi

if step 5; then
  say "5. cycle 2, thresholds / 25; priors and flags back to the site; the owner reviews the flag"
  cyc_small run >"$OUT/5-cycle-2.json"
  keep_cycle 5-cycle-2 training/cycle/work/e2e "$(jget "$OUT/5-cycle-2.json" 'j.result.cycleId')"
  tail -c 600 "$OUT/5-cycle-2.json" | tee -a "$LOG"; echo
  # The owner's first open data release, by hand after looking inside the zip (a dry run here):
  # from then on a promotion releases on its own.
  cyc_small open-data --upload >"$OUT/5-open-data-first.json" || true
  cyc_small flags list >"$OUT/5-flags-list.json"
  bridge_out
  site models --state $STATE >"$OUT/5-site-models.txt"
  cron
  site receipt --state $STATE >"$OUT/5-receipt.json"
  site export --state $STATE >"$OUT/5-export.json"
  site reading --base "$BASE" >"$OUT/5-reading.json"
  # The owner reviews the flag with the flags tool; the cron applies the review.
  REF=$(jget "$OUT/5-flags-list.json" '(j.result.pending[0] || {}).ref || ""')
  if [ -n "$REF" ]; then
    keep FLAG_REF "$REF"
    cyc_small flags confirm "$REF" >"$OUT/5-flags-confirm.json"
    cyc_small flags push >"$OUT/5-flags-push.json"
    bridge_out
    cron
    site receipt --state $STATE >"$OUT/5-receipt-reviewed.json"
  else
    say "no pending flag to review"
  fi
fi

if step 6; then
  say "6. a deliberately weak model: adopt (real gate), then forced pass and publish"
  nodec tests/sim/weak-model.ts "$OUT/weak" >>"$LOG"
  nodec ai/bench/export-model.ts "$OUT/weak/league/it000001.zapw" "$OUT/weak/export" --version v900 --note "random weights, local proof only" >>"$LOG"
  cyc adopt "$OUT/weak/export" >"$OUT/6-adopt-weak.json"
  keep_cycle 6-adopt-weak training/cycle/work/e2e "$(latest_work training/cycle/work/e2e)"
  keep WEAK "$(jget "$OUT/6-adopt-weak.json" 'j.result.version')"
  cyc gate --force pass >"$OUT/6-gate-forced.json"
  cyc publish >"$OUT/6-publish-weak.json"
  keep_cycle 6-forced training/cycle/work/e2e "$(latest_work training/cycle/work/e2e)"
  cyc status >"$OUT/6-status.json"
fi

if step 7; then
  say "7. a long match across the manifest change; the site serves $WEAK; round 2"
  rm -f "$OUT/long-ready.json"
  sim --devices 1 --matches 1 --seed 77 --think-ms 4000 --concurrency 1 --ready-file "$OUT/long-ready.json" --out "$OUT/sim-long.json" >"$OUT/7-sim-long.log" &
  BG=$!
  for i in $(seq 1 60); do [ -f "$OUT/long-ready.json" ] && break; sleep 1; done
  [ -f "$OUT/long-ready.json" ] || { say "the long match did not start"; exit 1; }
  keep T_IMPORT_W_START "$(now)"
  bridge_out
  keep T_IMPORT_W "$(now)"
  sleep 6
  sim --devices 24 --matches 3 --seed 42 --concurrency 8 --trace --out "$OUT/sim-2.json" >"$OUT/7-sim-2.log"
  wait $BG
  keep T_ROUND2_END "$(now)"
  cat "$OUT/7-sim-2.log" "$OUT/7-sim-long.log" | tee -a "$LOG"
  cron
  bridge_in
  check pinned --state $STATE --sim "$OUT/sim-long.json" --after "$T_IMPORT_W" --ttl-ms $TTL_MS --old v1 --new "$WEAK" >"$OUT/7-pinned.json" || true
  check served --state $STATE --after "$T_IMPORT_W" --ttl-ms $TTL_MS --version "$WEAK" >"$OUT/7-served.json" || true
  check window --state $STATE --from $((T_IMPORT_W + TTL_MS)) --to "$T_ROUND2_END" --candidate "$WEAK" --control v1 >"$OUT/7-window.json" || true
  cat "$OUT/7-pinned.json" "$OUT/7-served.json" "$OUT/7-window.json" | tee -a "$LOG"
fi

if step 8; then
  say "8. the daily A/B check: automatic rollback to v1"
  cyc ab >"$OUT/8-ab.json"
  tail -c 800 "$OUT/8-ab.json" | tee -a "$LOG"; echo
  # The decision tables on the newest export: the flagged person is out of training.
  cyc build >"$OUT/8-build.json"
  cyc status >"$OUT/8-status.json"
  bridge_out
  keep T_ROLLBACK "$(now)"
  sleep 6
  sim --devices 3 --matches 2 --seed 43 --concurrency 3 --trace --out "$OUT/sim-3.json" >"$OUT/8-sim-3.log"
  keep T_ROUND3_END "$(now)"
  bridge_in
  check window --state $STATE --from $((T_ROLLBACK + TTL_MS)) --to "$T_ROUND3_END" --version v1 >"$OUT/8-window-v1.json" || true
  cat "$OUT/8-window-v1.json" | tee -a "$LOG"
fi

if step 9; then
  say "9. $WEAK made current by hand; v1 adopted again must pass the real gate against it"
  cyc rollback "$WEAK" >"$OUT/9-rollback-to-weak.json"
  # OPEN_DATA_ENABLED (and thresholds / 25): the promotion releases open data on its own.
  cyc_small adopt ai/models/bootstrap >"$OUT/9-adopt-v1.json"
  keep_cycle 9-adopt-v1 training/cycle/work/e2e "$(latest_work training/cycle/work/e2e)"
  keep STRONG "$(jget "$OUT/9-adopt-v1.json" 'j.result.version')"
  tail -c 600 "$OUT/9-adopt-v1.json" | tee -a "$LOG"; echo
  bridge_out
  keep T_IMPORT_S "$(now)"
  sleep 6
  sim --devices 12 --matches 2 --seed 44 --concurrency 6 --trace --out "$OUT/sim-4.json" >"$OUT/9-sim-4.log"
  keep T_ROUND4_END "$(now)"
  bridge_in
  check window --state $STATE --from $((T_IMPORT_S + TTL_MS)) --to "$T_ROUND4_END" --candidate "$STRONG" --control "$WEAK" >"$OUT/9-window.json" || true
  cat "$OUT/9-window.json" | tee -a "$LOG"
fi

if step 10; then
  say "10. training alert: a failed step, then a stale status"
  T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cyc publish --cycle 19990101-0000 >"$OUT/10-failed-step.json" || true
  cyc status >"$OUT/10-status-failed.json"
  bridge_out
  sleep 1
  cron; site receipt --state $STATE >"$OUT/10-receipt-failed-1.json"; echo "{\"mails\":$(mails "$T0")}" >"$OUT/10-mails-1.json"
  sleep 1
  cron; site receipt --state $STATE >"$OUT/10-receipt-failed-2.json"; echo "{\"mails\":$(mails "$T0")}" >"$OUT/10-mails-2.json"
  site status --state $STATE --value ok --age-days 9 --message "Status nine days old, written by the local proof." >>"$LOG"
  cron; site receipt --state $STATE >"$OUT/10-receipt-stale.json"; echo "{\"mails\":$(mails "$T0")}" >"$OUT/10-mails-3.json"
  site status --state $STATE --value ok --age-days 0 --message "Fresh status, written by the local proof." >>"$LOG"
  cron; site receipt --state $STATE >"$OUT/10-receipt-ok.json"; echo "{\"mails\":$(mails "$T0")}" >"$OUT/10-mails-4.json"
  docker logs --since "$T0" zap-dev-1 2>&1 | grep -A12 "send_email binding called" >"$OUT/10-mail-log.txt" || true
  # The local binding wrote each message's text to a file under .wrangler/tmp (path in the log).
  : >"$OUT/10-mail-texts.txt"
  for f in $(grep -o '/app/\.wrangler/tmp/email/[^ ]*\.txt' "$OUT/10-mail-log.txt" | sed 's#^/app/##'); do
    { echo "== $(basename "$f")"; cat "$f"; echo; } >>"$OUT/10-mail-texts.txt"
  done
  cat "$OUT"/10-mails-*.json | tee -a "$LOG"
fi

if step 11; then
  say "11. guards and the final listing"
  sed -e 's/"zap-test-e2e-events"/"zap-events"/' -e 's/"zap-test-e2e-models"/"zap-models"/' -e 's/"zap-test-e2e-public"/"zap-public"/' "$CFG" >"$OUT/guard-prod-names.toml"
  sed -e 's#endpoint = "http://minio:9000"#endpoint = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"#' "$CFG" >"$OUT/guard-remote-endpoint.toml"
  G=$OUT/11-guards.jsonl
  : >"$G"
  rc=0; o=$(docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config "$OUT/guard-prod-names.toml" --json init 2>>"$LOG") || rc=$?
  echo "{\"guard\":\"minio mode with production bucket names\",\"exit\":$rc,\"out\":$o}" >>"$G"
  rc=0; o=$(docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config "$OUT/guard-remote-endpoint.toml" --json init 2>>"$LOG") || rc=$?
  echo "{\"guard\":\"minio mode with an R2 endpoint\",\"exit\":$rc,\"out\":$o}" >>"$G"
  rc=0; o=$(docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml --json bridge push --state dev 2>>"$LOG") || rc=$?
  echo "{\"guard\":\"bridge push with the production config\",\"exit\":$rc,\"out\":$o}" >>"$G"
  rc=0; docker compose run --rm -T node node training/cycle/sim/run.ts --base https://zap.andreiludescher.com --devices 1 --out "$OUT/refused.json" >>"$LOG" 2>"$OUT/11-sim-refused.txt" || rc=$?
  echo "{\"guard\":\"simulated players with the public site\",\"exit\":$rc}" >>"$G"
  rc=0; docker compose run --rm -T node node worker/dev/trigger-cron.ts --base https://zap.andreiludescher.com >>"$LOG" 2>&1 || rc=$?
  echo "{\"guard\":\"cron trigger with the public site\",\"exit\":$rc}" >>"$G"
  rc=0; docker compose run --rm -T node node training/cycle/bridge/bridge.ts export --state prod >>"$LOG" 2>&1 || rc=$?
  echo "{\"guard\":\"Node bridge with another state folder\",\"exit\":$rc}" >>"$G"
  cat "$G" | tee -a "$LOG"
  pyc training/cycle/e2e/check.py --config "$CFG" listing >"$OUT/11-listing.json" || true
  cat "$OUT/11-listing.json" | tee -a "$LOG"
fi

if step 12; then
  say "12. the human layers on a slice: only this run's round 1, production thresholds, then divided by 25"
  pyc training/cycle/e2e/reset.py --config tests/sim/cycle-e2e-slice.toml >>"$LOG"
  nodec tests/sim/slice-events.ts --from $STATE --sim "$OUT/sim-1.json" --sim "$OUT/sim-metronome.json" >"$OUT/12-slice.json"
  cyc_slice init >"$OUT/12-slice-init.json"
  cyc_slice bridge push --state fixtures >>"$LOG"
  cyc_slice run >"$OUT/12-slice-prod.json"
  cyc_slice_small run >"$OUT/12-slice-div25.json"
  for f in 12-slice-prod 12-slice-div25; do
    keep_cycle "$f" training/cycle/work/e2e-slice "$(jget "$OUT/$f.json" 'j.result.cycleId')"
  done
  cat "$OUT/12-slice.json" | tee -a "$LOG"
fi

if step 13; then
  say "13. cleanup: the dev site back to its bundled model, the stand-in stopped"
  cyc status >"$OUT/13-status.json"
  site models --state $STATE >"$OUT/13-site-models-before-cleanup.txt"
  site clear-models --state $STATE >"$OUT/13-clear-models.json"
  docker compose --profile cycle-dev stop minio >>"$LOG" 2>&1
  docker compose --profile cycle-dev rm -f minio >>"$LOG" 2>&1
  STARTED=0
fi
say "all steps done"
