# Training server

How the training cycle lives on the owner's server: what runs, where to look, and what to do by hand. The first setup is in `DEPLOY.md`, section "Training server". What each command does is in `README.md`; why the rules are what they are is in `project_docs/cycle.md`.

## What runs

* One container, the compose service `scheduler` (`restart: unless-stopped`, 4 cores, 6 GB), with the production config `config/prod.toml`.
* Every 10 minutes it looks at the clock. A cycle starts on Saturday at 22:00 (America/Sao_Paulo), or earlier when 1,000 new matches arrived since the last cycle. One cycle at a time; a cycle that passes 36 hours is stopped and marked failed.
* Every day after 06:00 UTC it runs the A/B check and refreshes the status file, so the Worker knows the server is alive.
* While a new version is under test (14 days after a promotion), no new cycle starts. When the window ends, the scheduler runs the closing A/B check at once (final result in the card, or a rollback) before it may start a cycle; `run` and `publish` refuse while the window is still in `state.json`. When that check could not decide (too few people or matches), the window closes with the new version in place, and `state.lastAbNote` in the `status` output says why until the next window ends; the status message says it only until the cycle that follows starts.

## Secrets

Only in the project's `.env` on the server (ignored by Git, mode 600), never in code:

| Variable | What |
| --- | --- |
| `R2_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com` |
| `R2_EVENTS_ACCESS_KEY_ID`, `R2_EVENTS_SECRET_ACCESS_KEY` | events token: Object Read on `zap-events` only |
| `R2_PUBLISH_ACCESS_KEY_ID`, `R2_PUBLISH_SECRET_ACCESS_KEY` | publish token: Object Read and Write on `zap-models` and `zap-public` only |
| `GITHUB_RELEASES_TOKEN`, `OPEN_DATA_ENABLED` | open data (off by default) |

The cycle never passes a credential to a subprocess and never writes one to a log.

## Looking at it

```sh
C="docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml"
$C status                                   # local state, remote status, manifest, newest receipt
docker compose --profile scheduler logs --tail 50 scheduler
tail -n 50 training/logs/cycle.log          # every step of every cycle
ls -t training/logs/runs/ | head            # one file per cycle with the output of training and gate
```

`status.state` `running` means a cycle or a step runs, and `cycleLock` in the same output names who holds the cycle lock. A step run by hand (`$C sync`, `build`, `train`, `gate`, `explorer`) shows `running` until it ends, then the status from before it comes back (a `failed` one stays `failed`). A `running` status while `cycleLock` is `null` and no container of the cycle runs a command is out of date: a step or cycle that did not end left it, such as a step run by hand with an older version of the cycle or one that was interrupted (Ctrl+C, a stopped or killed container, a reboot). The next cycle or step that ends ok writes it again.

The model card of each version is `cards/vN.json` in `zap-models`, also kept in `training/cycle/data/prod/cards/`. It holds the data counts and hashes, the training arguments, the gate result with every number, the characters' statistics and, after the window, the A/B result.

## By hand

* Roll back at once (does not wait for a running cycle; rooms switch within 5 minutes):

  ```sh
  $C rollback v3
  ```

* Run one cycle now (refused while an A/B window is open):

  ```sh
  docker compose --profile scheduler stop scheduler
  $C run
  docker compose --profile scheduler up -d scheduler
  ```

* v2, the model that ships, is the twin of milestone 6 (features `v2-empty`, no in-match reading): `init` uploads it with v1, and its card holds the gate it passed (`project_docs/ai.md`, "What ships"). The adaptive model of milestone 6 that passed the explorer test, `training/runs/m6-adaptive-r/export/zap-v2-b0.2-h1.zapw` (SHA-256 7223c227, safety net Bmax 0.2, nHalf 1; `ai.adaptation.explorer.criterion` in `facts.json`), is ready and not live. Serving it is the owner's decision, in the order of `DEPLOY.md` section 9.2: `AI_ADAPT` `on` and `[gate] stats = "live"` deployed first, then, with the scheduler stopped while no cycle runs, `adopt _local/m6/adopt-proof/export` (a clean export folder with that file) in the scheduler service, which makes it the next version through the same gate and test window with people as any candidate: v3 if no cycle has taken a number since `init`, and the command prints it. On a server that is not the training machine, first copy that folder and the files of `training/runs/` that section 9.2 lists: the snapshot and its run, the run it resumed from (for the card's training time) and the files of its explorer verdict, which the cycle's explorer test then reuses for the same network instead of measuring again. After that adoption, switch the reading off by rolling back to the version that was current before it (`$C rollback <that version>`, v2 unless a cycle promoted another), not with `AI_ADAPT` `off`: without the reading that network is weaker than its twin head to head (`ai.adaptation.ablation.offPolicy`), and every table would play it (`DEPLOY.md` section 9.5).
* With `[gate] stats = "live"`, every candidate whose file can read runs the explorer test after a passing gate (`project_docs/cycle.md`, "The explorer test"): a scripted search, the fresh measure, every explorer on record measured again (those that failed against an earlier file and those that passed, the control among them), and a PPO explorer trained against it for its full `[explorer] trained_iters`; the step fails when the cycle has less time left than `[explorer] trained_hours`. The status shows it as step `gate` ("explorer test"), and the output of each tool goes to `training/logs/runs/<cycleId>.log`. A candidate that fails is rejected and its card lists every verdict; a passing verdict for the same network is reused, so a network that passed before adds only the re-measures of explorers recorded since. A network that failed is final: it is never measured again nor promoted, under any version name, unless you lift it with `--lift-failure "<reason>"`, which its card records. `publish` refuses a file that can read without that passing verdict, whatever `prod.toml` says: such a refusal leaves a rejected card that says why and a failed status, so the alert email reaches you. Keep the scheduler running through the test window of an adaptive version and after it: the cycle that starts when the window closes trains with the feints league and runs this test. The record is `explorerFailures` and `explorerMeasured` in `training/cycle/data/prod/state.json`; it only grows, so the step takes a little longer each cycle, and `[explorer] reserve_hours` is the setting to raise when it no longer fits.

## Automation flags: the owner's review

Each cycle looks at the people of the latest daily export for four patterns (decision times too regular, play around the clock, unusual volume, identical sequences; the rules are in `project_docs/cycle.md`), appends a flag to `training/cycle/data/prod/flags.json` and uploads it as `control/flags.json`. The Worker's daily job applies it inside D1: the device leaves training at once and the ranking provisionally. The cycle only ever sees a group token of one export, so neither the tool nor the server can tell who the person is.

```sh
$C flags list                                  # pending flags: reference, reason, evidence, import status;
                                               # and the open reports of the latest export, by group token
$C flags confirm 2026-11-28:0123456789abcdef   # the flag stands
$C flags clear 2026-11-28:0123456789abcdef     # it was a person: the Worker lifts the flag
$C flags push                                  # uploads the reviews; applied at the next daily run (04:00 UTC)
```

* The import status comes from the newest receipt that names the reference: `applied`, `ignored` (the person already had an open or confirmed flag, or was cleared less than 15 days before, or less than 90 days before for the same reason; nothing to review), `unresolved` (the person deleted their data, or the export's group rows expired after 30 days), `reviewed`, or `not imported yet`.
* Reports listed by group are reviewed as `project_docs/moderation.md` says.
* A clear holds: a new flag for the same person less than 15 days after the clear is ignored by the Worker (the cycle looks back 14 days, so it would see the same evidence again under a new group). A new flag for the same reason waits 90 days, so a person whose play keeps a pattern you judged harmless is not flagged again every two weeks. After that, a flag looks only at play after the clear, and it replaces the cleared one.

## Open data

* Off until `OPEN_DATA_ENABLED=true` is in `.env` and a cycle sees 1,000 valid matches. Then every cycle builds the package in `training/cycle/work/prod/<cycleId>/human/open-data/zap-open-data-<cycleId>.zip`: matches and decisions with new codes per match, ISO weeks, decision times in 0.5 s bands, cells of at least 20 people, the style figures, the dictionary and the CC BY 4.0 notice. Look inside it before the first release: `project_docs/privacy-lia.md` asks for a re-identification check first.
* `$C open-data` builds the package again from the newest cycle's tables (with new codes) and uploads nothing. `$C open-data --upload` builds nothing: it syncs, then sends the zip that is already in the newest cycle's folder, the one you looked at, only when that package was built from the newest daily export and that export is at most a day old. Otherwise it refuses: run `$C sync`, `$C build`, `$C open-data`, look inside the new zip and upload the same day, so nobody who deleted their data or left open data after the package was built is published. It creates the release `open-data-<cycleId>` in the repository of `[human.open_data] repo` (`AndreiLud/zap`) and attaches the zip; a release that already holds the file is left alone. A release cannot be withdrawn.
* The first release is yours, by hand, as above. From then on every promotion releases on its own: right after it publishes a new version, the cycle syncs, builds the tables, the readings and the package again when a newer daily export arrived since its own tables, and uploads with the same refusals. The run's result says what happened (`publish.openData.status`: `off`, `waiting` while no release was made by hand, `empty` when no cell has 20 people, `uploaded`, or `failed` with the error; a failure never undoes the promotion). `state.json` lists every upload (`openDataReleases`, `auto` true for the cycle's own). To stop the automatic releases, set `OPEN_DATA_ENABLED=false`.
* Token: a fine-grained GitHub token for this repository only, permission "Contents: Read and write", in `.env` as `GITHUB_RELEASES_TOKEN`. The cycle never passes it to a subprocess and logs replace it with `***`.
* The local profiles, and a package made from test records, only print the requests (a dry run).

## When the alert email arrives

* "failed": `$C status` shows the step and the error; `training/logs/runs/<cycleId>.log` has the output of that step. The next cycle runs at the next slot; the status stays failed until a cycle ends ok.
* "stale" (no news for 8 days): the scheduler is not running or cannot reach R2. `docker compose --profile scheduler ps`, then the logs.
* "missing": the manifest exists but no status file; run `$C status` and check the publish token.

## Disk

`training/cycle/data/prod/` grows with the match records (at most 256 KB each) and keeps every promoted version (about 0.2 MB served, 0.7 MB source, plus the checkpoint). With the statistics live, `explorer/<cycleId>/<attempt>/` keeps each explorer test (the candidate's file, the result files, the PPO explorer without its checkpoint) and `explorer/verdicts/` the passing verdicts, so a later candidate can measure every explorer on record again and the same network can reuse its verdict; delete neither while a version they judged may still be adopted. `training/cycle/work/prod/` keeps the newest 4 cycles, `training/logs/runs/` the newest 20 logs, and `cycle.log` at most 6 files of 10 MB.

## Updating the code

```sh
docker compose --profile scheduler stop scheduler      # waits for nothing: a running cycle is stopped
git pull
docker compose --profile cycle build cycle             # only when training/cycle/requirements.lock changed
docker compose --profile scheduler up -d scheduler
```

Stopping the scheduler during a cycle kills it; the status says failed until the next cycle ends ok.

## Local S3 stand-in

No MinIO image was downloaded: the `minio/minio` repository is no longer on Docker Hub and `quay.io/minio/minio` requires a login. The local tests use `devs3/s3server.py` on the image `python:3.12-slim` (177 MB, already on the machine as the base of `zap-train:local`). The production server never runs it.
