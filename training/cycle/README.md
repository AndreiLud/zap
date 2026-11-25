# Training cycle

The cycle turns the matches people play into a new version of the Zap AI, checks that the new version is better, serves it to part of the solo matches for two weeks and rolls it back when people beat it more often. It runs in Docker on the owner's server (`SERVER.md`, and the section "Training server" of `DEPLOY.md`), once a week or after 1,000 new matches. The method behind each rule is in `project_docs/cycle.md`.

Python orchestrates (`zapcycle/`); everything that touches the rules or the network runs in Node with the project's own engine and AI code (`node/`, `gate/`, `ai/bench/`). No language model takes part in any step.

## One cycle

1. `sync`: new match records (`matches/v1/YYYY/MM/DD/<matchId>.json`), the newest daily export and the receipts of the last 8 days, from the events bucket into `data/<profile>/`, with a read only token.
2. `build`: `node/build.ts` replays every record with the engine (`validateMatchRecord`, `normalizeRecord`), joins the export's seat links and writes the decision tables: `records.jsonl`, `decisions.jsonl.gz`, `summary.json`.
3. `human`: the human layers (`zapcycle/human/`), each switched off until its threshold.
4. `train`: the candidate starts from the current version and trains with `training/train.py`; its league holds every member of the gate panel. Then `ai/bench/export-model.ts`, the calibration of the characters (`ai/bench/calibrate-personas.ts`) and the export again with their knobs.
5. `gate`: `gate/gate.ts` plays duplicate pairs against the current version and the panel (SPRT, non-inferiority per segment and against each panel member, the characters' order). Then, for a candidate whose file can read the in-match statistics (features `v2` with a safety net) and only with `[gate] stats = "live"`, the explorer test (`zapcycle/explorer.py`, `project_docs/cycle.md` "The explorer test"): a scripted search ranked by the adaptation part, the fresh measure, every explorer on record measured again (failed or passed), a PPO explorer trained against the candidate for its full iterations, the control explorer, and the criterion of `ai/bench/criterion.ts`. A passing verdict for the same network is reused; a failure against the same network is final unless the owner lifts it (`--lift-failure`). With the statistics live, step 4 trains with the feints league (`[train] league_mix_live`).
6. `publish`: a rejected candidate uploads only its card. A candidate whose file can read is promoted only with a passing verdict of the explorer test for its network, whatever the config says (the guard: otherwise a rejected card that says why, and the cycle fails). A promoted one uploads the model, its card, the manifest, the public summary and the status, in that order, and opens the A/B window. Then, with the open data layer on and once the owner made the first release by hand, it releases open data on its own (`publish.openData` in the result; `cli.open_data_after_promotion`).

Every candidate that reaches the gate takes the next version number, promoted or not; numbers are never reused.

## Layout

| Path | What |
| --- | --- |
| `cycle.py` | entry: `python training/cycle/cycle.py --config <toml> <command>` |
| `config/{prod,local,test}.toml` | complete configs with the same keys (`prod`: R2; `local` and `test`: the local S3 stand-in, tiny sizes) |
| `zapcycle/` | the Python package (storage, formats, sync, build, train, gate, publish, A/B, scheduler, bridge, CLI) |
| `zapcycle/human/` | the human layers, each switched off until its threshold |
| `node/build.ts`, `node/replay.ts`, `node/simulate.ts` | decision tables, replay of a record, simulated records for tests |
| `gate/gate-core.ts`, `gate/gate.ts`, `gate/compare.ts`, `gate/personas-order.ts` | pure rules of the gate, the runner, twin comparisons, the characters measured again on fresh deals |
| `bridge/bridge.ts` | Node half of the local bridge to a local site |
| `devs3/s3server.py` | the local S3 stand-in (below) |
| `e2e/` | local end to end runs and their checks |
| `tests/` | Python unit tests (`unittest`) |
| `data/<profile>/` | records, latest export, receipts, `index.sqlite`, `versions/vN/`, cards, `state.json`, locks, `ab/tables/` (the daily A/B check's records with the newest export's tokens, rewritten every day), `explorer/<cycleId>/<attempt>/` (each attempt of the explorer step in that cycle: the candidate's copy, the result files, the PPO explorer, kept for later re-measures) and `explorer/verdicts/<network>.json` (passing verdicts, reused for the same network) (not in Git) |
| `work/<profile>/<cycleId>/` | tables, training runs, export, gate files and the card of one cycle; the newest 4 stay, and only the newest keeps its per person tables (`tables/`, `human/`) once a newer cycle ends, ok or failed, or a newer `build` runs (not in Git) |
| `training/logs/` | `cycle.log` (rotating at 10 MB, 5 files) and `runs/<cycleId>.log` (output of every subprocess, newest 20 kept) |

A version folder `data/<profile>/versions/vN/` keeps the served file (`model.zapw`), the f32 source (`snapshot.zapw`), the training checkpoint when known (`checkpoint.pt`) and the training arguments (`train-args.json`). The next candidate starts from them.

## Commands

Exit codes: 0 done, 1 error, 2 refused by a guard, 3 lock busy. `--json` prints one JSON object.

| Command | What |
| --- | --- |
| `init` | local profiles: creates the three buckets. Both modes, only when no manifest exists: uploads the bundled models listed in `storage.bundled` (prod: v1 and v2; local and test: v1), their cards, the manifest with the last one current, and an ok status |
| `sync` | step 1 |
| `build [--cycle ID]` | step 2 (a new cycle id without `--cycle`) |
| `train [--cycle ID]` | step 4 (the newest cycle without `--cycle`) |
| `gate [--cycle ID] [--candidate DIR] [--force pass\|fail]` | step 5; `--force` only in the local profiles, the measured result stays in the card |
| `explorer [--cycle ID] [--lift-failure REASON]` | the explorer test of step 5 alone (the newest cycle without `--cycle`); `run` and `adopt` run it after the gate. A network that failed it before is refused without a measure; `--lift-failure` is the owner's reason to measure it in full again, recorded on its card |
| `publish [--cycle ID]` | step 6 |
| `run [--force pass\|fail]` | one full cycle; refused while an A/B window is open |
| `rollback vN` | serves vN again at once; never waits for a running cycle |
| `adopt EXPORT_DIR [--force pass\|fail] [--lift-failure REASON]` | an `export-model.ts` output becomes a candidate (gate, explorer test and publish as usual); `--force` only in the local profiles; `--lift-failure` as for `explorer` |
| `ab` | the daily A/B check (sync, records, rollback or window close, status refresh) |
| `status` | local state, remote status, manifest and newest receipt |
| `scheduler [--now ISO --ticks N --tick-advance S --dry-run]` | the loop of the `scheduler` service |
| `bridge push\|pull --state dev\|e2e` | Python half of the local bridge (local profiles only) |
| `human-model`, `priors`, `flags list\|confirm REF\|clear REF\|push`, `player-types`, `open-data [--upload]` | the human layers' tools |

On the server every command runs in the `cycle` service, for example:

```sh
docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml status
```

## Storage and guards

`zapcycle/storage.py` wraps boto3 (path addressing, SigV4, checksums only when required, 5 attempts). Every guard runs before any network call:

* `prod` (mode `r2`): the endpoint comes from `R2_ENDPOINT` and must be `https://<account id>.r2.cloudflarestorage.com`; the buckets are exactly `zap-events`, `zap-models`, `zap-public`; the events role uses `R2_EVENTS_*` (read and list on `zap-events`), the publish role uses `R2_PUBLISH_*` (read, list, put and delete on `zap-models` and `zap-public`).
* `local` and `test` (mode `minio`): the endpoint is `http://minio:9000` or the loopback address on port 9000, and every bucket name starts with `zap-test-`.
* Any mix, a role reaching another bucket, or a local only role (bridge, admin) in production raises a guard error (exit code 2).
* Subprocesses never receive a credential, and logs replace any credential value with `***`.
* A production sync fails the cycle on a record marked `test: true`; a local sync counts a record without that mark as invalid.

## Locks and state

* `data/<profile>/locks/cycle.lock` (`flock`) is held for a whole cycle and by each step command; a second one exits with code 3. The kernel frees it when its holder dies.
* `data/<profile>/locks/manifest.lock` is held only while the manifest is read and written (init, publish, rollback, window close).
* `data/<profile>/state.json` keeps the sync cursor, the last cycle, the promotions, the A/B window until its close, why the last window closed without the automatic rollback deciding (`lastAbNote`), the latest seed floor and every one measured (`seedFloors`), the last version number taken, the explorers on record as failing against an earlier file (`explorerFailures`), every explorer measured with each file it was measured against (`explorerMeasured`) and the explorer test of every candidate that can read (`explorerVerdicts`).

## Status

The cycle writes `status/training.json` in the models bucket at every step and every 30 minutes during long steps. A step run on its own (`sync`, `build`, `train`, `gate`, `explorer`) shows `running` while it runs and, when it ends ok, puts back the status from before it with a new `updatedAt` (a stale `running`, left by an older version or by a step or cycle that was interrupted, becomes `ok` and `idle`, with `finishedAt` unchanged); `publish` and `adopt` end with the status their publication writes. A failed cycle or step leaves `failed` with the step and the error, and it stays `failed` until a later cycle ends ok. `status` also prints `cycleLock`, who holds the cycle lock (`null` when nothing runs). The daily check refreshes `updatedAt`. The Worker's daily cron emails the owner when the status is failed, older than 8 days, or missing while a manifest exists.

## The A/B window and rollback

After a promotion, 30% of solo matches keep the previous version for 14 days, and the new version only sits in opponent seats (a person's AI partner is always the previous version). The daily check (`ab`) compares the people's results in both arms with a bootstrap over people; when both arms have at least 200 matches and 20 distinct people (`[ab] min_people_per_arm`) and the lower bound of the drop passes 2 points, it rolls back on its own. With fewer people it does not decide: the window closes with the new version in place, and the check says why in the status message (until the next cycle starts, which the scheduler does in the same tick), in `state.json` (`lastAbNote`, which `status` prints, until the next window ends) and in `training/logs/cycle.log`. At the end of the window it writes the final numbers into the card and closes the window. No promotion happens while a window is open.

## Scheduler

One tick every 10 minutes. Nothing while the cycle lock is held. Once a day after 06:00 UTC, the A/B check. Then a cycle starts when no window is open and either the weekly slot (Saturday 22:00, America/Sao_Paulo) came after the last cycle's start, or at least 1,000 new matches arrived since the last cycle (counted at most once an hour). A missed slot runs once at the next tick. A cycle that passes 36 hours is stopped and the status says `failed` with `time limit`.

`--now`, `--tick-advance`, `--ticks` and `--dry-run` run it on a fake clock without starting anything:

```sh
docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/test.toml \
  scheduler --now 2026-11-21T20:00:00Z --ticks 36 --tick-advance 600 --dry-run
```

## Image

`Dockerfile` builds `zap-cycle:local` from `zap-train:local` (Python, CPU PyTorch and Node) and adds boto3 with its dependencies, installed offline from `.cache/wheels-cycle/` with the hashes of `requirements.lock`. Each hash in the lock was compared with `https://pypi.org/pypi/<name>/<version>/json` before it entered the file. To fetch the wheels again (pip checks every hash against the lock):

```sh
docker run --rm --user 1000:1000 -v "$PWD":/app -w /app -e HOME=/app/.cache/home -e PIP_CACHE_DIR=/app/.cache/pip-cycle \
  python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b \
  pip download --no-deps --only-binary=:all: --require-hashes -r training/cycle/requirements.lock -d .cache/wheels-cycle
docker compose --profile cycle build cycle
```

## Local S3 stand-in

The local profiles talk to the compose service `minio` (profile `cycle-dev`, port 9000 on 127.0.0.1, data in `.cache/minio`, credentials `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` from `.env`). The MinIO image is no longer published on Docker Hub, so the service runs `devs3/s3server.py`: a small S3 server on the standard library that checks SigV4 signatures with those credentials and serves the calls the cycle makes (list buckets, create a bucket, list objects, put, get, head, delete). Only `image` and `command` of the service would change for a real MinIO.

```sh
docker compose --profile cycle-dev up -d minio
docker compose --profile cycle-dev stop minio
```

## Tests

* Python: with the stand-in running, `docker compose --profile cycle run --rm -T cycle python -m unittest discover -s training/cycle/tests -t training/cycle`. The tests that need it fail with a clear message when it is down. On this machine the 224 tests took 23 s (2026-11-23, after the fixes of the milestone 10 review; its tests replace the benches and train.py with stand-ins that write their result files, `tests/test_explorer.py`).
* TypeScript: `training/cycle/**/*.test.ts` run inside `npx vitest run` (gate rules on known score arrays, one real gate run with 8 pairs on 1 thread, decision tables, the bridge order).

## Local end to end runs

* `e2e/run-fixtures.sh`: no Worker. Fixture records (simulated matches marked test, with an export and a receipt), then init, sync, build, train (2 iterations of 5,000 decisions, 1 worker, 1 thread), the gate with small sizes, a forced pass, publish, the refusals while the window is open, the daily check, `rollback v1`, status and a final listing that finds only `zap-test-` buckets and test records. Profile `test`. It took 2 minutes on this machine.
* `e2e/run-local.sh [--human]`: against the local site `dev-e2e` with simulated players, the cron's export and the bridge (`bridge.ts export`, `bridge push`, `bridge pull`, `bridge.ts import`). It checks that new matches play the new version only in opponent seats, that both arms appear, and that a match after `rollback v1` plays v1. Profile `local`.

* `tests/sim/cycle-e2e.sh [FROM [TO]]`: the longer proof against the local site `dev`, with its own test config (`tests/sim/cycle-e2e.toml`, buckets `zap-test-e2e-*`): the human layers off at the production thresholds and on at thresholds divided by 25, a flag found by the cycle and reviewed by the owner, a weak model refused by the real gate, then forced in and rolled back by the daily A/B check, a strong one that passes the real gate, a match pinned across a manifest change, the training alert by email and the guards. Evidence in `.cache/e2e-cycle/`, written up in `_local/m6/e2e-cycle.md`.

Every script stops the stand-in at the end, also on failure.
