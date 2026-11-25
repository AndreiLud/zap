# Deploy

How the Zap goes live at `https://zap.andreiludescher.com`: the Cloudflare resources, the build from GitHub, the secrets, the first tests, the public address, the training server that publishes the models, and then the checks, the later releases, the rollbacks and what to do when something breaks. It is written for the owner, who publishes alone: the first time, follow the numbered sections in order. A separate section at the end, "How to enable ads", covers the one step that stays off at launch.

This guide is a snapshot of 2026-11-23. Every Cloudflare or Google price, limit and rule names the page it comes from and the day it was read, and the value is also kept in `facts.json` under `docs` (its key is in an HTML comment next to it). Every number about the Zap itself comes from code that ran: a `facts.json` key in a comment, or the command next to it.

What runs where:

* Cloudflare, on Workers Free: one Worker named `zap`. It serves the static site (`web/dist`), the API, and one Durable Object per room (class `Room`). Next to it: the D1 database `zap`, three private R2 buckets, a Turnstile widget, Email Routing on the zone, and one daily Cron Trigger.
* GitHub, `AndreiLud/zap`: Workers Builds builds and deploys every push to `main`.
* The owner's server, in Docker: the training cycle (`training/cycle/`). It reads match records from R2, trains and tests a new version of the AI, and publishes it back to R2.

The AI that plays is a small neural network (a multilayer perceptron with int8 weights, run in TypeScript inside the Worker), trained by self play on the owner's server, with a rule based player as the last fallback. It is not a language model, and no language model decides any move or takes part in training (`project_docs/ai.md`).

## Contents

* [Before you start](#before-you-start)
* [The configuration at a glance](#the-configuration-at-a-glance)
* [1. Cloudflare resources](#1-cloudflare-resources)
* [2. Workers Builds](#2-workers-builds)
* [3. Secrets](#3-secrets)
* [4. First test on workers.dev](#4-first-test-on-workersdev)
* [5. The public address](#5-the-public-address)
* [6. The Cron Trigger and the account's limit](#6-the-cron-trigger-and-the-accounts-limit)
* [7. Training server](#7-training-server)
* [8. Checks after the deploy](#8-checks-after-the-deploy)
* [9. Adaptation during the match (AI_ADAPT)](#9-adaptation-during-the-match-ai_adapt)
* [10. Open data](#10-open-data)
* [11. The brake and when to move to Workers Paid](#11-the-brake-and-when-to-move-to-workers-paid)
* [12. Later releases](#12-later-releases)
* [13. Rollback](#13-rollback)
* [14. Troubleshooting](#14-troubleshooting)
* [15. Privacy and the law](#15-privacy-and-the-law)
* [How to enable ads](#how-to-enable-ads)
* [Sources](#sources)

## Before you start

* A Cloudflare account on Workers Free with the zones `andreiludescher.com` and `andreiludescher.com.br` active on it.
* The code on the `main` branch of `github.com/AndreiLud/zap`.
* On the server: Linux with Docker and Compose 2.24 or newer. The project's tools run in its own containers (`docker-compose.yml`), so nothing else is installed; the checks use `curl`.
* An inbox you read, for privacy requests and the training alert.
* Two counts in the dashboard. How many Cron Triggers the account's other Workers use: Workers Free allows 5 per account <!-- facts.docs: deploy.cf.free.cronTriggersPerAccount -->, and the Zap needs one, so with 5 in use remove one before section 2, or the first deploy fails (section 6). And whether the zone's free WAF rate limiting rule is already taken (section 5.5).

### The API token

One user API token serves Workers Builds (section 2) and the commands of this guide. In the dashboard: My Profile, API Tokens, Create Token, Create Custom Token. Name it `zap-deploy` and give it:

* Account, Account Settings, Read
* Account, Workers Scripts, Edit
* Account, Workers R2 Storage, Edit
* Account, D1, Edit
* Account, Workers Tail, Read
* Zone, Workers Routes, Edit, for the zone `andreiludescher.com`
* User, User Details, Read
* User, Memberships, Read

Account resources: this account only. Workers Builds gives the token it creates by itself every line above except D1 and Workers Tail, and it accepts only user tokens today ([Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), read 2026-11-23). D1 Edit is there because the deploy command applies the database migrations; Workers Tail Read is for `wrangler tail`. Copy the token once into a password manager.

For the commands, in the project folder (on the server or on your computer):

```sh
export CLOUDFLARE_API_TOKEN=...    # typed in the shell, never written to a file of the project
export CLOUDFLARE_ACCOUNT_ID=...   # dashboard, Workers & Pages, Account details
W="docker compose run --rm -T -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID node npx wrangler"
```

`$W` is the project's own wrangler (the version pinned in `package.json`) in the Node container.

Once per clone, install the project's own tools (they stay in `node_modules/` inside the folder): `docker compose run --rm -T node npm ci`. Without it, `npx wrangler` downloads the newest wrangler instead of the pinned one, and the checks of section 1.6 stop at `tsc: not found`.

## The configuration at a glance

Every binding, var, secret, cron and migration the Worker reads, what it does, where it is set and its value. The sections after this one set them.

### Bindings (`wrangler.jsonc`)

| Binding | Kind | Resource | What it does |
| --- | --- | --- | --- |
| `ASSETS` | static assets | `web/dist`, made by `npm run build:web` | The pages, scripts, fonts and images. `run_worker_first` sends `/api/*`, `/s/*`, `/en/s/*` and `/ads.txt` to the Worker; any other path is a static file, and an unknown path gets the app's page (`single-page-application`). |
| `ROOM` | Durable Object namespace | class `Room`, SQLite storage, declared under `exports` | One object per room: the match, its clock and the AI seats. The first deploy creates the class (section 1.3). After a deploy, a room keeps its old code for up to 24 hours (`code_update_strategy`), so open matches are not cut. |
| `DB` | D1 | database `zap` | Devices, seats, rooms, reports, flags, style counters, the brake's daily ledger and the public counters. |
| `EVENTS` | R2 | bucket `zap-events` | Match records (no person in them), the daily receipts and the daily exports for the training cycle. Read and write. |
| `MODELS` | R2 | bucket `zap-models` | Models, model cards, the manifest, the training status and the cycle's control files. The Worker only reads it. |
| `PUBLIC` | R2 | bucket `zap-public` | `summary.json` of the data page, served by `GET /api/summary`. The Worker only reads it. Despite its name, the bucket stays private. |
| `EMAIL` | `send_email` | none | The training alert (section 7.7), to the address in `ALERT_EMAIL`. No destination is written in the file. |
| `RL_API` | rate limit, namespace `4101` | 60 a minute | Per device credential on the HTTP API, and per daily IP hash on the public routes. |
| `RL_VERIFY` | rate limit, namespace `4102` | 10 a minute | Per daily IP hash, only for the human check and the recovery code. |
| `RL_DATA` | rate limit, namespace `4103` | 300 a minute | Per device, for downloading one's own match records. |

Rate limit namespaces need nothing created, but a namespace id is shared by every Worker of the account that names it ([Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), read 2026-11-23). Check that no other project of the account uses `4101`, `4102` or `4103`.

### Other settings (`wrangler.jsonc`)

| Setting | Value |
| --- | --- |
| `main` | `worker/src/cf/index.ts`, the Worker's entry |
| `compatibility_date` | `2026-11-04`; change it only together with the checks of section 1.6 |
| `rules` | `**/*.zapw` as Data modules: the two bundled models travel inside the Worker |
| `observability` | off: Cloudflare stores no Worker logs (section 14) |
| `routes` | none: the custom domain lives in the dashboard (section 5.1) |

### Vars (`wrangler.jsonc`, `vars`)

Vars live in `wrangler.jsonc` and reach Cloudflare with each deploy. "If you change your environment variables in the Cloudflare dashboard, Wrangler will override them the next time you deploy" ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), "Source of truth", read 2026-11-23). So a var changes in the file, then a commit and a push.

| Var | Production value | What it does |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | the widget's site key (section 1.4) | Handed to the page by `/api/config`. The file ships with Cloudflare's always pass test key `1x00000000000000000000AA`: with a test key the human check answers `500 misconfigured` on https. |
| `TURNSTILE_HOSTNAMES` | `zap.andreiludescher.com` | Hostnames a Turnstile token may come from, comma separated. Empty: `500 misconfigured` on https. |
| `AI_MODE` | `net` | `net`: the model plays. `heuristic`: the tuned rule based player in every seat, for an emergency. |
| `AI_ADAPT` | `off` | Reading the opponents during the match (section 9). |
| `ADS_ENABLED` | `false` | Ads, off at launch ("How to enable ads"). |
| `ADS_CLIENT_ID` | empty | The AdSense publisher id once ads exist. |
| `ADS_TEST_MODE` | `false` | Google's test ads. |
| `ADS_MIN_INTERVAL_S` | `120` | Seconds between two ads. |
| `PRIVACY_CONTACT` | empty today; set it to `privacidade@andreiludescher.com` (section 1.5) | The address the Privacy and You pages show, through `/api/config`. Empty: the You page (/voce) is the only channel. |
| `ALERT_FROM` | empty today; for example `zap-alertas@andreiludescher.com` | Sender of the training alert, an address on the zone with Email Routing. Empty: no email. |
| `PUBLIC_ORIGIN` | `https://zap.andreiludescher.com` | Invite links and their previews, the sitemap, and the only other origin the API accepts. |
| `BRAKE_MODE` | `free` | The brake (section 11). |
| `BRAKE_RESERVE` | 0.5 of each limit until the other projects' use is known | The other projects' share of each daily limit. |
| `BRAKE_MONTHLY_USD` | `"10"`, read only in the paid mode | The ceiling of the monthly bill. |
| `BRAKE_COST_SOLO`, `BRAKE_COST_PER_PERSON` | as committed | The typical cost of a match (`project_docs/brake.md`). |

The build reads two of them from the file as well: `PUBLIC_ORIGIN` (sitemap, robots, canonical links; the build stops when it is not an https origin) and `ADS_ENABLED` (the content security policy in `_headers`).

### Secrets

| Secret | Value | What it does |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | the widget's secret key (section 1.4) | Checks each human check token with Cloudflare, without the visitor's IP. |
| `SESSION_SECRET` | 48 random bytes in base64url (section 3) | Signs the 2 hour credential and salts the daily IP hash of the rate limits. At least 32 characters, or the human check answers `misconfigured`. |
| `ALERT_EMAIL` | your inbox, verified in Email Routing (section 1.5) | Where the training alert goes. A secret, so the address is not in the repository. |

How to set them: section 3.

### Only for the local sites, never in production

| Name | Where | Why |
| --- | --- | --- |
| `TEST_RECORDS=true` | `.dev.vars` | Marks every match record `"test": true`, which the production cycle refuses, and opens the brake's test ledgers on a local host. |
| `MANIFEST_TTL_S` | `.dev.vars` | Reads the model manifest every few seconds instead of every 5 minutes. Counts only with `TEST_RECORDS`. |
| `ROOM_TIME_SCALE` | `--var` of the `dev-e2e` service | Shortens every waiting time for the end to end tests. |
| `BRAKE_MODE=paid`, `BRAKE_MONTHLY_USD=1000` | `.dev.vars` | A ceiling no day of tests reaches. |
| the Turnstile test keys, an empty `TURNSTILE_HOSTNAMES`, `ALERT_FROM` and `ALERT_EMAIL` on `zap.localhost` | `.dev.vars` | Local only. On a local site the alert is written to a file and nothing leaves the machine. |

`.dev.vars.example` holds all of them; copy it to `.dev.vars` (ignored by Git).

### Cron Trigger

`0 4 * * *`: every day at 04:00 UTC (01:00 in Brasília), one run with seven jobs in order (`worker/src/cron.ts`): retention, room calls still waiting, the cycle's flags file, the cycle's priors file, the export of the day, the training alert, and the receipt (`receipts/YYYY-MM-DD.json` in `zap-events`, kept 30 days). A failed job does not stop the others; the run is marked failed in the Cron Events list and the receipt says which one.

### D1 migrations (`worker/migrations/`)

| File | What it adds |
| --- | --- |
| `0001_init.sql` | `devices` and `open_rooms` |
| `0002_room_mode.sql` | `open_rooms.mode`: every room is listed, so an unknown code never wakes a Durable Object |
| `0003_privacy.sql` | the privacy columns of `devices`, and `matches`, `match_seats`, `reports`, `flags` |
| `0004_room_members.sql` | `room_members`: which rooms a device sits in, for deletion and recovery |
| `0005_room_calls.sql` | `room_calls`: calls to rooms that did not answer, retried by the daily job |
| `0006_cycle.sql` | `profiles`, `export_groups`, `cycle_imports` and `flags.ref` for the training cycle |
| `0007_brake.sql` | `brake_days`: the brake's ledger, one row per UTC day |
| `0008_live.sql` | `live_counts`: the public counters of the data page |

The deploy command applies them before each deploy (section 2). Field definitions are in `project_docs/data-dictionary.md`.

### The training server's `.env`

| Variable | Value |
| --- | --- |
| `R2_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com` |
| `R2_EVENTS_ACCESS_KEY_ID`, `R2_EVENTS_SECRET_ACCESS_KEY` | the events token: Object Read only, on `zap-events` only (section 7.1) |
| `R2_PUBLISH_ACCESS_KEY_ID`, `R2_PUBLISH_SECRET_ACCESS_KEY` | the publish token: Object Read and Write, on `zap-models` and `zap-public` only |
| `GITHUB_RELEASES_TOKEN` | empty until open data (section 10) |
| `OPEN_DATA_ENABLED` | `false` until open data |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | only for the cycle's local tests; production never reads them |

`.env.example` has the same lines. These keys never go into the Worker or into the repository.

## 1. Cloudflare resources

Create them in this order. Each name must match `wrangler.jsonc`.

### 1.1 The D1 database

Dashboard: Storage & Databases, D1 SQL Database, Create, name `zap`, location Eastern North America. Or:

```sh
$W d1 create zap --location enam
```

Eastern North America because the rooms run there: there is no Durable Object region in South America, and the Worker asks for `enam` (`worker/src/cf/index.ts`, `roomStub`), so the rooms' writes to D1 stay short. Copy the database id it shows; it goes into `wrangler.jsonc` in section 1.6.

### 1.2 The three R2 buckets

R2 must be enabled on the account first (dashboard, R2 object storage). Cloudflare may ask for a payment method at this step even for the free tier (not verified on 2026-11-23: the pricing page does not say). The free tier covers 10 GB-month of storage, 1 million Class A and 10 million Class B operations a month, with free egress ([R2 pricing](https://developers.cloudflare.com/r2/pricing/), read 2026-11-23). <!-- facts.docs: deploy.cf.r2.free.storageGbMonth, deploy.cf.r2.free.classAPerMonth, deploy.cf.r2.free.classBPerMonth -->

```sh
$W r2 bucket create zap-events
$W r2 bucket create zap-models
$W r2 bucket create zap-public
```

None of them gets public access or a custom domain: the Worker reads `zap-public` through its binding and serves `summary.json` itself.

### 1.3 Durable Objects: nothing to create

`wrangler.jsonc` declares the class under `exports` (`"Room": { "type": "durable-object", "storage": "sqlite" }`), which replaces the older `migrations` list; a Worker uses one or the other. Cloudflare "provisions a namespace for the class the first time you deploy", and Workers Free offers only SQLite storage ([Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), read 2026-11-23). Never rename or delete the class by editing its name: that needs a `renamed` or `deleted` entry under `exports` (same page), and a Worker rollback cannot cross such a change (section 13).

### 1.4 The Turnstile widget

Dashboard: Turnstile, Add widget.

1. Name `zap`, hostname `zap.andreiludescher.com`, mode Managed, no pre-clearance.
2. Copy the site key (it goes into `wrangler.jsonc`, section 1.6) and the secret key (a secret, section 3).

A widget needs at least one hostname, a listed hostname also covers its subdomains, and the free plan allows 10 hostnames per widget ([Turnstile hostname management](https://developers.cloudflare.com/turnstile/concepts/hostname-management/), read 2026-11-23). <!-- facts.docs: deploy.cf.turnstile.free.hostnamesPerWidget --> The widget will not run on the workers.dev address; section 4 tests that address without a browser.

### 1.5 Email Routing: the privacy address and the alert

The privacy contact and the training alert both use Email Routing on the zone `andreiludescher.com`.

1. Dashboard, zone `andreiludescher.com`, Email, Email Routing. If it is not on yet, turn it on: Cloudflare adds the MX and TXT records it needs. If the zone already receives mail through another provider, stop here: Email Routing would take over its MX records. Then use an inbox you already have for `PRIVACY_CONTACT` and leave the alert off (`ALERT_FROM` empty).
2. Destination addresses: add your inbox and click the link in the email Cloudflare sends. Only verified addresses receive mail.
3. Routing rules, Custom addresses: `privacidade@andreiludescher.com`, action Send to an email, destination your verified inbox.
4. The sender of the alert is any address on the zone, for example `zap-alertas@andreiludescher.com`; it needs no rule. A Worker can "only send from your routing domains", and before a sending domain is onboarded to Cloudflare's Email Service it can send "only to verified destination addresses in your account", which is all the alert needs ([Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/), read 2026-11-23). "Sending to verified destination addresses in your account is free on all plans" ([Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), read 2026-11-23).

Recommended: create the privacy address before launch. `project_docs/privacy-lia.md` ("Open points", 1) explains why a channel besides the You page (/voce) is expected, and the site promises an answer within 15 days.

### 1.6 The values into `wrangler.jsonc`

Edit four lines:

* `d1_databases[0].database_id`: the id from section 1.1 (the file holds a placeholder of zeros, and the first build fails with it).
* `vars.TURNSTILE_SITE_KEY`: the site key from section 1.4.
* `vars.PRIVACY_CONTACT`: `privacidade@andreiludescher.com`.
* `vars.ALERT_FROM`: the sender from section 1.5, for example `zap-alertas@andreiludescher.com`.

Leave `TURNSTILE_HOSTNAMES` at `zap.andreiludescher.com`.

Keep the local sites on the test key: `.dev.vars` must hold the line `TURNSTILE_SITE_KEY=1x00000000000000000000AA` (it is in `.dev.vars.example`; copy the file again or add the line), since `.dev.vars` overrides `wrangler.jsonc` locally.

wrangler dev keys its local database by `database_id`, so after this edit the local sites start from an empty local D1 (the next start of `dev` and `dev-e2e` applies the migrations again); the old local data stays in `.wrangler/` unused.

Then, from the project root:

```sh
docker compose run --rm -T node npm run typecheck
docker compose run --rm -T node npx vitest run
docker compose run --rm -T node npm run build:web
```

`worker/test/brake.test.ts` reads the brake's settings in `wrangler.jsonc` the way the Worker does and fails on any problem it would report. A last local check builds the Worker exactly as the deploy would, sends nothing, and lists every binding and var it found:

```sh
docker compose run --rm -T node npx wrangler deploy --dry-run --outdir .cache/dryrun
```

On 2026-11-23 it gave a Worker of 741,271 bytes (the script and the two bundled models) <!-- facts.docs: deploy.bundle.workerBytes -->, against a limit of 64 MiB uncompressed on both plans <!-- facts.docs: deploy.cf.workerSizeMiB -->, and `web/dist` held 98 files to upload <!-- facts.docs: deploy.bundle.assetFiles -->, the largest 131,548 bytes <!-- facts.docs: deploy.bundle.largestAssetBytes -->, against 20,000 files per version on Workers Free and 25 MiB per file <!-- facts.docs: deploy.cf.free.assetFilesPerVersion, deploy.cf.assetFileMiB --> ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-11-23).

Commit and push to `main`.

## 2. Workers Builds

Dashboard: Workers & Pages, Create application, then import a repository from GitHub (authorize Cloudflare's GitHub app for `AndreiLud/zap` when asked). Fill the form:

| Field | Value |
| --- | --- |
| Repository | `AndreiLud/zap` |
| Worker name | `zap`. It must match `name` in `wrangler.jsonc`, or the build fails ([Builds troubleshooting](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/), read 2026-11-23). |
| Root directory | empty (the repository root, where `wrangler.jsonc` is) |
| Build command | `npm run build:web` |
| Deploy command | `npx wrangler d1 migrations apply zap --remote && npx wrangler deploy` |
| API token | the `zap-deploy` token of "Before you start" (not a new one: the token Cloudflare creates has no D1 permission) |
| Build variables | none |

Then, in the Worker's Settings, Build, Branch control: production branch `main`, and clear "Enable Preview Builds", so a push to another branch never builds ([Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), read 2026-11-23).

What the build does:

* The build image installs the dependencies itself; the lockfile (`package-lock.json`) makes it use npm. The Node version comes from `.node-version` at the root (24.22.2); without it the image would use its default 24.22.1 ([Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/), read 2026-11-23). <!-- facts.docs: deploy.cf.builds.nodeDefault -->
* The build command builds the site into `web/dist` and checks its size budget. The log line `prerender: ... _headers (ads off)` says the content security policy has no ad sources.
* The deploy command applies every migration of `worker/migrations/` that the remote database has not seen, then deploys. Outside an interactive terminal, wrangler answers its own "continue?" question with yes. If a migration fails, `&&` stops before the deploy. To apply or list them by hand: `$W d1 migrations apply zap --remote`, `$W d1 migrations list zap --remote`.
* Build variables are not available to the Worker at runtime (Builds configuration page); the Worker's settings come from `wrangler.jsonc` and the secrets.

Workers Free gives 3,000 build minutes a month, one build at a time, and 20 minutes per build ([Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/), read 2026-11-23). <!-- facts.docs: deploy.cf.builds.free.minutesPerMonth, deploy.cf.builds.timeoutMinutes -->

Save and deploy. The build log is under the Worker's Deployments, View build history. The first one should list the eight migrations as applied and end with the `workers.dev` address of the Worker and the schedule `0 4 * * *`.

## 3. Secrets

The Worker exists after the first build; now give it the three secrets. Dashboard: Workers & Pages, `zap`, Settings, Variables and Secrets, Add, type Secret, then Deploy. Or with `$W`:

```sh
printf '%s' '<the widget secret key>' | $W secret put TURNSTILE_SECRET_KEY
docker compose run --rm -T node node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
printf '%s' '<the line printed above>' | $W secret put SESSION_SECRET
printf '%s' '<your verified inbox>' | $W secret put ALERT_EMAIL
```

Each secret creates and deploys a new version at once ([Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), read 2026-11-23), and later deploys keep them. Never add a var named like a secret to `wrangler.jsonc`: "The variable replaces the secret, and the secret is deleted" (same page).

Changing `SESSION_SECRET` later signs everyone out (they pass the human check again) and changes nothing else.

## 4. First test on workers.dev

Find the Worker's address under Settings, Domains & Routes (`zap.<your subdomain>.workers.dev`). The Turnstile widget is not set for that hostname, so this test uses curl; the first match in a browser happens on the real address (section 5.6).

```sh
D=https://zap.<your subdomain>.workers.dev
```

Each command, then the answer it must give:

1. `curl -s -o /dev/null -w '%{http_code}\n' $D/` answers `200`.
2. `curl -sI $D/ | grep -i -E '^(strict-transport-security|content-security-policy|x-frame-options):'` prints three lines: `max-age=31536000; includeSubDomains`; a policy that starts `default-src 'self'; script-src 'self' https://challenges.cloudflare.com` and names no Google domain; `DENY`.
3. `curl -s $D/api/config` answers `{"turnstileSiteKey":"<your site key>","adsEnabled":false,"ads":null,"hold":true,"privacyContact":"privacidade@andreiludescher.com"}`. The site key is never `1x00000000000000000000AA`.
4. `curl -s $D/api/me` answers `{"device":false,"verified":false,"verifiedUntil":null,"adult":false,"nickname":null,"nicknameHidden":false,"prefs":{"openDataOptOut":false,"noAdapt":false}}`.
5. The human check with a made up token:

   ```sh
   curl -s -w '\n%{http_code}\n' -X POST $D/api/session -H "origin: $D" -H 'content-type: application/json' -d '{"adult":true,"token":"test"}'
   ```

   It answers `{"error":"check_failed"}` and `403`: both secrets are set, no key is a test key, and Cloudflare refused the token. A wrong `TURNSTILE_SECRET_KEY` gives the same answer, so the widget's own key pair is proven only by the browser test of section 5.6. `{"error":"misconfigured"}` and `500` means a secret is missing, `SESSION_SECRET` is shorter than 32 characters, the site key is still the test key, or `TURNSTILE_HOSTNAMES` is empty.
6. `curl -s $D/api/live` answers `{"schema":"zap-live/1","at":<a time>,"matches":0,"decisions":0,"current":"v2","adapt":false,"humansVsZap":null}`: the rooms play the bundled v2 and read nothing during the match.
7. `curl -s -w '\n%{http_code}\n' $D/api/summary` answers `{"error":"no_summary"}` and `404` until the training cycle writes its first summary (section 7.6).
8. `curl -s -o /dev/null -w '%{http_code}\n' $D/ads.txt` answers `404`: ads are off.
9. `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $D/s/ABCDE` answers `200 text/html; charset=utf-8`: an invite page, which does not check that the room exists.
10. `curl -s -o /dev/null -w '%{http_code}\n' $D/en/data` answers `200`.
11. `$W d1 migrations list zap --remote` says there is no migration left to apply.

## 5. The public address

### 5.1 Custom domain

Workers & Pages, `zap`, Settings, Domains & Routes, Add, Custom Domain: `zap.andreiludescher.com`. Cloudflare creates the DNS record and the certificate itself, and it refuses a hostname that already has a CNAME record ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), read 2026-11-23): delete such a record first.

### 5.2 Turn off workers.dev

Once the custom domain answers, add two lines at the top level of `wrangler.jsonc`, then commit and push:

```jsonc
"workers_dev": false,
"preview_urls": false,
```

Without them every deploy turns the workers.dev address on again: `workers_dev` "Defaults to `true` when the configuration has no `route` or `routes`". The custom domain stays as the dashboard set it: "To manage routes via the Cloudflare dashboard only, remove any route and routes keys from your Wrangler configuration file. Then add `workers_dev = false` to your Wrangler configuration file." ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), read 2026-11-23). The workers.dev address could not run the human check anyway, so this only removes a copy of the site.

### 5.3 The .com.br redirect

In the zone `andreiludescher.com.br`:

1. DNS, Records: an `AAAA` record, name `zap`, address `100::`, proxy status Proxied. Redirect rules need the hostname's traffic to go through Cloudflare ([Single Redirects](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-dashboard/), read 2026-11-23).
2. Rules, Overview, Create rule, Redirect Rule: wildcard pattern, request URL `http*://zap.andreiludescher.com.br/*`, target URL `https://zap.andreiludescher.com/${2}`, status code 301, preserve query string on.

The Worker needs nothing for it: the request never reaches it.

### 5.4 HTTPS and HSTS

The Worker and the static pages send `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Browsers honor it only on an https answer, so plain http must never serve the site:

1. Zone `andreiludescher.com`, SSL/TLS, Edge Certificates: turn on Always Use HTTPS. It redirects every http request of every hostname of the zone ([Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/), read 2026-11-23).
2. Leave the zone's own HSTS setting off. It would apply to the whole zone, the portfolio and the other projects included, and the Zap's header already comes from the Worker.

The Worker refuses the API over plain http on any public host (`403 https_required`), so a missing Always Use HTTPS never hands out cookies without `Secure`.

### 5.5 The WAF rate limiting rule, if it is free

The Free plan has one rate limiting rule per zone, counting by IP, with the path as the only useful field, a 10 second period and a 10 second block ([Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/), read 2026-11-23). <!-- facts.docs: deploy.cf.waf.free.rateLimitRules, deploy.cf.waf.free.periodSeconds, deploy.cf.waf.free.mitigationSeconds --> The Worker already limits per device and per IP hash (the `RL_*` bindings); a WAF rule stops a flood before it costs Worker requests, which count toward the account's daily limit.

If the zone's rule is free: Security rules, Create rule, Rate limiting rules. Name `zap api flood`; field URI Path, operator starts with, value `/api/`, and a second condition: URI Path does not start with `/api/me/matches/`; characteristic IP; when rate exceeds 50 requests per 10 seconds; action Block; duration 10 seconds. The second condition keeps the download of one's data and the "You against Zap" page out of the rule: both fetch a person's match records 10 at a time, batch after batch, so a person with many matches passes 50 in 10 seconds. If the editor of the Free plan does not accept the second condition, skip this step: the page waits out a block and tries again, but a block on every batch makes a long download slow. The rule covers every hostname of the zone, since the Free plan cannot filter by hostname: check that 50 requests in 10 seconds from one IP is far above what the other projects' own `/api/` paths see, keeping in mind that people on one Wi-Fi share an IP. If the rule is taken, skip this step.

### 5.6 First match in a browser

Open `https://zap.andreiludescher.com`, pass the age screen and the human check, play a quick match to the end, open the You page (/voce) and download your data. The downloaded record says `"schema": "zap-match/2"` and `"test": false`. Then:

```sh
$W d1 execute zap --remote --command "SELECT day, matches, settled, refused FROM brake_days ORDER BY day DESC LIMIT 1"
```

The day's row counts the match (`matches` 1 or more, `settled` 1 or more once it ended, `refused` 0).

## 6. The Cron Trigger and the account's limit

The Worker has one Cron Trigger, `0 4 * * *`, deployed with it. Workers Free allows 5 Cron Triggers per account, shared by every Worker of the account ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-11-23). <!-- facts.docs: deploy.cf.free.cronTriggersPerAccount --> The owner's other projects share the account, which is why "Before you start" counts theirs (Workers & Pages, each Worker, Settings, Trigger Events). With 5 already in use the Zap's deploy cannot add its own; free one first, or move to Workers Paid (1,000 per account, same page). <!-- facts.docs: deploy.cf.paid.cronTriggersPerAccount -->

After the deploy, check that `zap` lists `0 4 * * *` under Settings, Trigger Events. A deploy replaces the Cron Triggers with those of `wrangler.jsonc` ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), read 2026-11-23), so never edit them in the dashboard. Cron Events, under Trigger Events, keeps the 100 most recent runs (same page). <!-- facts.docs: deploy.cf.cronEvents.kept -->

The day after the first deploy, read the receipt:

```sh
$W r2 object get "zap-events/receipts/$(date -u +%F).json" --remote --pipe
```

Every job reads `"ok"`, `"off"` or `"skipped"`; only `"failed"` is a problem, and its `error` says why. Before the training cycle publishes its first manifest, `flags`, `priors` and `export` are `"off"` (they start only once the cycle exists), and `alert` is `"ok"` with `"sent": false` (`"off"` only when `ALERT_FROM` or `ALERT_EMAIL` is missing). After `init`, `flags` and `priors` read `"skipped"` while the cycle has no new control file for them.

<a id="training-server"></a>

## 7. Training server

The training cycle runs on the owner's server, not on Cloudflare (`training/cycle/README.md`; daily life in `training/cycle/SERVER.md`). The scheduler needs 4 free cores and 6 GB of memory (`docker-compose.yml`).

### 7.1 Two R2 tokens

Dashboard: R2 object storage, Account Details, API Tokens, Manage, Create Account API token. Account tokens stay valid when a user changes; a user token "becomes inactive if your user is removed from the account" ([R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), read 2026-11-23).

* `zap-events-read`: permission Object Read only, applied to the bucket `zap-events` only. It reads and lists objects (same page).
* `zap-publish`: permission Object Read & Write, applied to the buckets `zap-models` and `zap-public` only.

Each token shows an Access Key ID, a Secret Access Key (shown once) and the S3 endpoint `https://<account id>.r2.cloudflarestorage.com`. The cycle refuses any other endpoint form and any other bucket before a request leaves the machine (`training/cycle/README.md`, "Storage and guards").

### 7.2 The project and its `.env`

On the server, in the project folder: the one that already holds the training runs, on the machine that trained the models, or a clone of `AndreiLud/zap`.

```sh
[ -e .env ] || cp .env.example .env; chmod 600 .env
```

Fill `R2_ENDPOINT` and the four `R2_EVENTS_*` and `R2_PUBLISH_*` keys. Leave `GITHUB_RELEASES_TOKEN` empty and `OPEN_DATA_ENABLED=false`. If `MINIO_ROOT_*` are already set for the cycle's local tests, keep them: the r2 mode never reads them.

`training/runs/` is not in Git (`.gitignore`), so a clone lacks it: copy `training/runs/m6-twin/` into the clone for section 7.5 and, later, the files that section 9.2 lists. Without `m6-twin`, `init` makes the first candidate start from the int8 file (section 7.5).

### 7.3 Images

Fetch the Python wheels once; pip checks every file against the SHA-256 in the lock files. Then build the two images (the cycle image starts from the training image):

```sh
PY="docker run --rm --user $(id -u):$(id -g) -v $PWD:/app -w /app -e HOME=/app/.cache/home -e PIP_CACHE_DIR=/app/.cache/pip python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b"
$PY pip download --no-deps --only-binary=:all: --require-hashes -r training/requirements.lock -d .cache/wheels \
  --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple
$PY pip download --no-deps --only-binary=:all: --require-hashes -r training/cycle/requirements.lock -d .cache/wheels-cycle
docker compose --profile train build train
docker compose --profile cycle build cycle
```

### 7.4 Check that the tokens reach R2

```sh
C="docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml"
$C status
```

It prints the profile `prod`, mode `r2`, and the remote `status` and `manifest`, both `null` before section 7.5. It exits 0 even when R2 cannot be reached: a wrong endpoint, a missing key or a refused token shows as `"remote": "unavailable: ..."` in place of `status` and `manifest` (a guard names the variable or bucket; a refused token only names the error type, such as `ClientError`: check the token's permissions and buckets in section 7.1). The other commands exit with code 2 on a guard error and 3 when another cycle command holds the lock.

### 7.5 Publish the first model

Until a manifest exists, the rooms play the model bundled in the Worker, v2, with v1 behind it. `init` publishes both so the cycle can build on them:

```sh
$C init
```

Only when no manifest exists, it uploads the two bundled models of `storage.bundled` in `training/cycle/config/prod.toml`, oldest first, and makes v2 current. It refuses a bundled file that does not match its manifest.

| Key in `zap-models` | From | SHA-256 | Bytes |
| --- | --- | --- | --- |
| `models/v1.zapw` | `ai/models/bootstrap/zap-v1.zapw` | `d6fd4924ab4a7ea0ab311f94907ae1106639c58412dde602df586217ca53c62d` <!-- facts: ai.bootstrapModel.previous.sha256 --> | 184,976 <!-- facts: ai.bootstrapModel.previous.bytes --> |
| `cards/v1.json` | a card made from `ai/models/bootstrap/manifest.json` | | |
| `models/v2.zapw` | `ai/models/bootstrap/zap-v2.zapw` | `afdc60963af013807329a18f73eb62edfeadba7756e350818759ef99af562632` <!-- facts: ai.bootstrapModel.sha256 --> | 193,512 <!-- facts: ai.bootstrapModel.bytes --> |
| `cards/v2.json` | `ai/models/bootstrap/card-v2.json`, the gate v2 passed against v1 | | |
| `manifest.json` | `current: "v2"`, no test window, one entry per model with its knobs | | |
| `status/training.json` | `ok` | | |

Then `$C status` shows the manifest with `current` `v2` and both entries. A room reads the manifest at most every 5 minutes; since the SHA-256 of both files match the bundled ones, the rooms never download them. When `training/runs/m6-twin/` (the run behind v2: snapshot, checkpoint, `args.json`) is on the server, `init` copies it to `training/cycle/data/prod/versions/v2/` and the first candidate starts from it; otherwise from the int8 file. From now on the cycle numbers its candidates itself (the first one is v3).

### 7.6 The scheduler: start, status, logs, stop

Nothing starts the scheduler for you. It runs only after you start it:

```sh
docker compose --profile scheduler up -d scheduler
```

Start it when no other long training job uses the server's cores: it takes 4 cores and 6 GB while a cycle runs. It has `restart: unless-stopped`, so it comes back by itself after a reboot until you stop it.

| What | Command |
| --- | --- |
| Is it running | `docker compose --profile scheduler ps scheduler` |
| Its decisions, one JSON line each | `docker compose --profile scheduler logs --tail 50 scheduler` (add `-f` to follow) |
| The cycle's state, remote status, manifest, newest receipt | `$C status` |
| Every step of every cycle | `tail -n 50 training/logs/cycle.log` |
| The output of training and gate | `ls -t training/logs/runs/ \| head` |
| Stop it | `docker compose --profile scheduler stop scheduler` |
| Remove its container after a stop | `docker compose --profile scheduler rm -f scheduler` |

Stopping it during a cycle kills the cycle; the status says failed until the next cycle ends ok. Do not use `docker compose down` for it: that would also stop the project's other services.

What it does (`training/cycle/SERVER.md`): every 10 minutes it looks at the clock. A cycle starts on Saturday at 22:00 (America/Sao_Paulo), or earlier after 1,000 new matches; one cycle at a time, stopped and marked failed after 36 hours. Every day after 06:00 UTC it runs the daily check, which refreshes the training status and writes `summary.json` for the data page: from then on `GET /api/summary` answers 200. Training is self play against the whole panel, so a cycle runs before anyone plays; people's matches feed the human layers once these reach their thresholds.

### 7.7 The training alert

The daily cron reads `status/training.json` in `zap-models` and sends one email when the cycle failed, sent no news for more than 8 days, or left no status while a manifest exists; one email per change of state, not one a day (`worker/src/cron.ts`). It needs the `EMAIL` binding, `ALERT_FROM` and `ALERT_EMAIL`; with any of them missing the receipt says `jobs.alert.status` `"off"`. After `init`, start the scheduler within 8 days, or the first email you get is the "stale" alert. What to do with each alert: `training/cycle/SERVER.md`, "When the alert email arrives".

## 8. Checks after the deploy

Run them after the first deploy and after every release. `D=https://zap.andreiludescher.com`.

1. The checks of section 4 with this `D`, from 1 to 10. After the first match, the `/api/live` check shows the real `matches` and `decisions`, and once the scheduler wrote a summary it shows `humansVsZap` and the `/api/summary` check answers `200` (item 8). Run `curl -s -o /dev/null -D - $D/api/live | grep -i -E '^(cf-cache-status|cache-control|x-zap-cache-control):'` twice in a row: the second answer comes from the Worker's cache (`cf-cache-status: HIT`) and must still say `cache-control: public, max-age=60`, with no `x-zap-cache-control` line (the Worker's internal header, which must not reach a browser). The zone's Browser Cache TTL rewrites the `cache-control` of a cached answer and the Worker puts its own back, so while this check passes that setting needs no change. If the second answer says any other `max-age`, such as `max-age=14400`, the zone rewrites it after the Worker: set Caching, Configuration, Browser Cache TTL to Respect Existing Headers (a setting of the whole zone, so it also applies to the other projects' hostnames). The site's own pages ask with `cache: 'no-cache'`, so they show fresh numbers either way.
2. `curl -sI http://zap.andreiludescher.com/ | grep -i -E '^(HTTP|location)'`: a permanent redirect (301 or 308) to `https://zap.andreiludescher.com/`.
3. `curl -sI 'https://zap.andreiludescher.com.br/regras?x=1' | grep -i -E '^(HTTP|location)'`: `301` to `https://zap.andreiludescher.com/regras?x=1`.
4. `curl -s https://zap.andreiludescher.com/robots.txt`: ends with `Sitemap: https://zap.andreiludescher.com/sitemap.xml`.
5. In a browser: the first match of section 5.6, the English site (`/en/`), the data page (`/dados`), and a room with a friend through an invite link.
6. The next day: the receipt (section 6) with no job `"failed"`, and the cron run marked as a success under Cron Events.
7. After `init`: `curl -s $D/api/live` still says `"current":"v2"`, and `$C status` on the server shows the manifest.
8. The day after the scheduler's first daily check: `curl -s -o /dev/null -w '%{http_code}\n' $D/api/summary` answers `200`.

## 9. Adaptation during the match (AI_ADAPT)

### 9.1 Where it stands

The reading is live. `AI_ADAPT` is `"on"` in `wrangler.jsonc`, and on 2026-11-25 the cycle adopted as v3 the network that passed the explorer test described below: its full gate against v2, with the reading live, accepted it after 800 pairs with a mean of 52.6%, all four segments passed, and the cycle reused that explorer verdict. <!-- facts: ai.releases.v3.date, ai.releases.v3.gate.sprt.pairs, ai.releases.v3.gate.sprt.mean --> It is in its 14 day test with people until 2026-12-09, with v2 on 30% of quick play matches as the control (section 9.3), and that test decides whether it stays. <!-- facts: ai.inPlay.controlUntil, ai.inPlay.controlShare --> v2 is the twin trained with the statistics always empty (features `v2-empty`), so `AI_ADAPT` changes nothing for it (`project_docs/ai.md`, "What ships").

What `on` does: an adaptive model (features `v2` with a finite safety net in its file) reads public facts of the current match about each other seat (raises, answers, cards shown, cards played face down), never hidden cards and never another match, and may shift its play a little as evidence grows. With "Don't adapt to me" on for anyone at the table, it reads nobody at that table. `/api/live` then reports `"adapt": true` and the data page says the reading is on.

A file may carry the reading only after its explorer test: against that exact file, no explorer may gain more than 1 point from the reading, at the one sided 95% upper bound. On 2026-11-23 the file `training/runs/m6-adaptive-r/export/zap-v2-b0.2-h1.zapw` (SHA-256 `7223c22787cfdbb95753ae6d028e508bd30907eb9c5a6fa4b7bbd3e8b5af1372`, safety net Bmax 0.2, nHalf 1) passed: all 9 verdicts measured against it hold, the highest upper bound is 0.77 points, and the reading costs the explorer trained against it by reinforcement learning (its adaptation part is −1.00 point, with an upper bound of −0.57 points). <!-- facts: ai.adaptation.explorer.criterion.pass, ai.adaptation.explorer.criterion.requirement, ai.adaptation.explorer.criterion.servedModel.adapt.bmax, ai.adaptation.explorer.criterion.servedModel.adapt.nHalf, ai.adaptation.switchOnCheck.explorer.verdicts, ai.adaptation.switchOnCheck.explorer.worstUpper95, ai.adaptation.explorer.trained.fresh.adaptationPart.mean, ai.adaptation.explorer.trained.fresh.adaptationPart.upper95 -->

The same day, the steps of section 9.2 ran on a local copy of the cycle with the production gate sizes and `[gate] stats = "live"`, against the shipped v2 (`ai.adaptation.switchOnCheck` in `facts.json`). `cycle adopt` gave the network the number v3 and its full gate passed: the sequential test accepted v3 after 1,200 pairs with a mean of 53.3% against v2, all four segments and all five panel members passed, and the characters kept their order. <!-- facts: ai.adaptation.switchOnCheck.gate.sprt.pairs, ai.adaptation.switchOnCheck.gate.sprt.mean --> A local site then served what the cycle published. With `AI_ADAPT` on, v3 read the statistics in the candidate group and v2 played the control group; v3 played at no evidence at the tables of a person who opted out, and everywhere once `AI_ADAPT` was off; after `$C rollback v2` every match played v2 again. That local proof switched nothing on for real; the adoption described at the start of this section did.

### 9.2 Switching it on, in order

1. Review `project_docs/privacy-lia.md`, section 5, which already records the explorer result (section 15).
2. The files on the server. `_local/` and `training/runs/` are not in Git. On a server that is not the machine that trained the model, copy these into the project folder, at the same paths:
   * `_local/m6/adopt-proof/export/`, a clean export folder with two files: `manifest.json` (it names the snapshot and the safety net) and `zap-v2.zapw` (the file that passed, a copy of `zap-v2-b0.2-h1.zapw`);
   * from `training/runs/m6-adaptive-r/`: `league/it000590.zapw` (the snapshot the cycle exports again), `args.json`, `checkpoint.pt`, `metrics.jsonl` and `resumed-from.json` (the card's training arguments and time; the next cycle trains on from this checkpoint);
   * from `training/runs/m6-adaptive/`, the run that fine-tune resumed from: `args.json` and `metrics.jsonl`. The card's training time counts every run of that chain, and `adopt` stops before the export, naming the file, when one of them is missing;
   * the files of the explorer verdict of section 9.1, so that the cycle's explorer test reuses it instead of running again: `training/runs/m6-adaptive-r/export/zap-v2-b0.2-h1.zapw` (the file the verdict judged) and, in `training/runs/m6-adaptive-r/eval/`, `explorer-fresh-5.json`, `explorer-fresh-6.json`, `explorer-fresh-7.json`, `explorer-fresh-8.json`, `explorer-trained.json`, `explorer-control.json` and `history/old-m6-explorer-b0.2-h1.json`. `facts.json`, in Git, names them in `ai.adaptation.explorer.criterion`; the cycle reads every verdict again from these files and reuses them only for a file with the same network (the same weights, safety net and priors; the version name may differ);
   * the files of the explorers that verdict measured, which the cycle measures again against every later candidate that can read (`project_docs/cycle.md`, "The explorer test"): `explorer.zapw`, `args.json` and `metrics.jsonl` of `training/runs/m6-explorer-r/`, `training/runs/m6-explorer/` and `training/runs/m6-explorer-twin/` (the control), `training/runs/m6-explorer-init/start.zapw`, and `training/runs/m6-adaptive/export/zap-v2-b0.5-h1.zapw` (the file `m6-explorer` trained against). Without them the next candidate's explorer test leaves those explorers pending, and the candidate is not promoted.

   Check them with `sha256sum _local/m6/adopt-proof/export/zap-v2.zapw training/runs/m6-adaptive-r/export/zap-v2-b0.2-h1.zapw training/runs/m6-adaptive-r/league/it000590.zapw`: `7223c227...` for the first two and `4e127c1c...` for the snapshot.
3. In `wrangler.jsonc`, set `vars.AI_ADAPT` to `"on"`. In the same commit:
   * in `worker/test/no-remote.test.ts`, change `expect(cfg.vars.AI_ADAPT).toBe('off')` to `expect(['off', 'on']).toContain(cfg.vars.AI_ADAPT)`, or the checks of section 1.6 fail;
   * regenerate the data page's view of the facts, `docker compose run --rm -T node node tools/data/facts-view.ts`, and commit `web/src/data/generated/facts-view.json`: it records `AI_ADAPT`, and `web/test/data-generated.test.ts` fails until it agrees with `wrangler.jsonc`;
   * in `training/cycle/config/prod.toml`, set `[gate] stats = "live"`, so the gate measures every network as the rooms will play it. With it the weekly cycle also trains with the feints league (`[train] league_mix_live`) and runs the explorer test of every candidate that can read (`[explorer]`; leave `on = true`). Then regenerate the data page's copy of the cycle rules, `docker compose run --rm -T node node tools/data/cycle-rules.ts`, and commit `web/src/data/generated/cycle-rules.json`: the same test fails until it agrees with `prod.toml`, and the data page states the gate from that copy. The regeneration changes only `gate.stats` and the provenance.

   Before the push, run the checks of section 1.6, then the integration suite and the end to end suite three times each (the commands are in `README.md`, "Tests"), against the local sites started again after these edits, so they serve `AI_ADAPT` `"on"`. Runbook step 10 asks for this, and it has not run for a switch.

   Push, and wait until Workers Builds has deployed. Nothing changes yet: the version in play has no reading, so `curl -s $D/api/live` still says `"adapt":false`. Do not adopt before this deploy: a version adopted while `AI_ADAPT` is off would face people for its 14 days at no evidence, the weaker network of section 9.4, while its gate measured it reading.
4. On the server, at least 24 hours after that deploy: until then a room still open may keep the old Worker settings, with `AI_ADAPT` off, and play the new version without reading (section 12). First check that no cycle runs and note the version in play: `$C status` must show `status.step` `idle` (stopping the scheduler during a cycle kills it, section 7.6), and `manifest.current` is the version the gate measures against and the one to roll back to (v2 unless a cycle promoted another since `init`). If `status.state` is `running` but `cycleLock` in the same output is `null` (no cycle, step or daily check holds the cycle lock) and no container of the cycle runs a command (`docker ps`), the status is out of date: a step or cycle that did not end left it, such as a step run by hand with an older version of the cycle (`$C sync`) or a step or cycle that was interrupted (Ctrl+C, a stopped or killed container, a reboot). Go on; the adoption writes the status again. A `failed` state is a real failure: read its message first (section 7.7). `cycleLock` is printed only once the server runs this version of the cycle (section 12, step 6); before that, rely on `docker ps` alone. Then stop the scheduler, take the new `prod.toml`, adopt, start the scheduler again:

   ```sh
   $C status
   docker compose --profile scheduler stop scheduler
   git pull
   S="docker compose --profile scheduler run --rm -T scheduler python training/cycle/cycle.py --config training/cycle/config/prod.toml"
   $S adopt _local/m6/adopt-proof/export
   docker compose --profile scheduler up -d scheduler
   ```

   `$S` is `$C` in the scheduler's service, with its 4 cores and 6 GB for the gate (`$C` has 1 core). The cycle exports the snapshot again as the next version, with the safety net of the folder's manifest: the same network as the file that passed, with only the version name in its header changed. That number is one more than the largest the cycle has used, and every cycle takes one when it exports a candidate, even one the gate rejects: it is v3 only if no cycle has run since `init`, so read it in the `version` the command prints. It calibrates the characters with the statistics live and runs the full gate against the version in play, then the explorer test. With the files of step 2 that test reuses the verdict of section 9.1, since the network is the same, and measures again only the explorers on record that the verdict did not measure or that failed after it (none until a cycle has run with the statistics live), so it adds no measurement; the card names the verdict it reused (`explorer.reusedFrom`). Without those files it runs the whole test, which trains an explorer for its full `[explorer] trained_iters` and fails, rather than train a shorter one, when the cycle has less time left than `[explorer] trained_hours`. A network that failed the explorer test once is never measured again nor promoted, under any version name: only you can lift that, with `--lift-failure "<reason>"` after `adopt <folder>`, and its card records the reason. If the gate and the explorer test pass, the new version becomes current with the previous one as its control (section 9.3) and the rooms start reading within 5 minutes; if either fails, nothing changes for anyone and its card, `cards/<version>.json`, says why. On this machine the whole command took 14.9 minutes, measured before the cycle had the explorer step; the card's training time now counts every run of the chain (`ai.adaptation.switchOnCheck.candidate.trainingSecondsChain`). <!-- facts: ai.adaptation.switchOnCheck.adopt.minutes -->
5. After a passing adoption, bring the texts that say the reading is not live into line, in both languages: `legal.you.prefs.noAdaptHelp` in `locales/legal.*.json` ("Adaptation is not switched on for anyone yet") and the status lines of `project_docs/privacy-lia.md` section 5 ("It is prepared and switched off", "Nothing about the reading has changed for the people who play"). Decide whether the change needs a new `NOTICE_VERSION` (`web/src/consent-keys.ts`). Then record the cycle's state and render the READMEs and the data page's view as in section 9.6.

### 9.3 The 14 days with people

Below, the new version is the one the adoption created and the previous version the one that was current before it (v3 and v2 when no cycle has run since `init`).

* Within 5 minutes of the adoption, `curl -s $D/api/live` names the new version in `"current"` and says `"adapt":true`; each Cloudflare location may keep an older answer for 60 seconds more. A room already open may keep the old Worker settings for up to 24 hours (`code_update_strategy`), and a match keeps the version it started with.
* How matches are split: in quick play, 30% of the matches play the previous version on every AI seat (the control group); in the others the opponents are the new version and the AI partner is the previous one, so the new version never sits next to a person. Rooms with friends face the new version in the opponent seats. <!-- facts: ai.adaptation.switchOnCheck.window.controlShare -->
* `$C status` shows the manifest with the new version as `current`, the previous one as `control`, and `controlUntil`, the end of the window. No cycle starts until the window closes, but keep the scheduler running during the window: it runs the daily check that compares the groups.
* The daily check (after 06:00 UTC) compares how often people beat the new version and how often they beat the previous one, in quick play. It rolls the new version back by itself when people clearly beat it: by more than 2 points at its boundary, with at least 200 matches and 20 different people in each group. <!-- facts: ai.adaptation.switchOnCheck.window.rollbackDrop, ai.adaptation.switchOnCheck.window.minMatchesPerArm, ai.adaptation.switchOnCheck.window.minPeoplePerArm --> With fewer people the luck of a few players could pass for a drop, so the check does not decide: the window ends with the new version in place, and the check says why (`The automatic rollback could not decide: too few people played ...`). The status message keeps that only until the next cycle starts, which the same scheduler tick does (the last item of this section), so `$C status` also keeps it in `state.lastAbNote` until the next window ends, and `grep 'could not decide' training/logs/cycle.log` finds it in the log. Then only `$C rollback <previous version>` brings the previous version back (section 9.5). It does not wait for that cycle: if the cycle already promoted a newer version, trained from the new one, the rollback replaces that one too, and if it lands while the cycle runs, after a gate that passed, the cycle stops at its publish step with `the current version changed since the gate ran` and the alert of section 7.7 tells you. `tail -n 50 training/logs/cycle.log` shows each check; a failed or stale cycle sends the alert of section 7.7.
* The cycle publishes the result itself: the data page shows the comparison once both groups have 20 people, and the check that ends the window writes the final result into the new version's card (`cards/<version>.json` in `zap-models`, also kept in `training/cycle/data/prod/cards/`) and into `summary.json`, which the data page reads. <!-- facts: ai.adaptation.switchOnCheck.window.minPeoplePerArm --> If the check rolled the new version back, the card says `rolled-back` with the numbers.
* After the window: the scheduler tick that closes the window also starts a cycle at once, since a weekly slot passed during the window. That cycle trains the next candidate from the new version with the statistics, its safety net and the feints league of the network that passed (`league_mix_live`, `feint_hands` and `feint_evidence` in the `[train]` of `prod.toml`, the values of `training/runs/m6-adaptive-r/args.json`), gates it with the statistics live and then runs the explorer test against it (`project_docs/cycle.md`, "The explorer test"): a scripted search ranked by the adaptation part, the fresh measure, every explorer on record measured again (those that failed against an earlier file and those that passed, so the explorers of section 9.1 and the control among them), and an explorer trained against it by reinforcement learning for its full 103 iterations. The candidate is promoted only when every verdict stays within 1 point; otherwise its card lists every verdict and says why, and the version in play stays. `publish` refuses a file that can read without that passing verdict whatever `prod.toml` says, and such a refusal fails the cycle, so the alert of section 7.7 tells you. Keep the scheduler running through the window and after it: nothing has to be stopped by hand. <!-- facts: ai.adaptation.explorer.trained.training.iterations -->

### 9.4 What the measurements say before you decide

The reading passed its safety test and has been live since the adoption of v3, and three measurements of 2026-11-23 weigh against the network that carries it: the test window with people is what decides. The twin below is the same training without the statistics (`training/runs/m6-twin-r`); v2, the control of the window, is the twin of the earlier run (`training/runs/m6-twin`, SHA-256 `afdc6096...`).

* **With the reading off, the network is weaker head to head.** What a table plays while `AI_ADAPT` is off, and at every table with a person who turned on "Don't adapt to me", is the ablated network: the same file with the statistics at no evidence. Head to head against the twin it scores 48.5% (95% interval from 47.7% to 49.4%). <!-- facts: ai.adaptation.ablation.offPolicy.headToHead.mean, ai.adaptation.ablation.offPolicy.headToHead.ci95.0, ai.adaptation.ablation.offPolicy.headToHead.ci95.1 --> Against the styled opponents it scores 0.48 points more than the twin (from 0.25 points to 0.71 points). <!-- facts: ai.adaptation.ablation.offPolicy.pooledAblatedMinusTwin.mean, ai.adaptation.ablation.offPolicy.pooledAblatedMinusTwin.ci95.0, ai.adaptation.ablation.offPolicy.pooledAblatedMinusTwin.ci95.1 --> Runbook step 10 lets the file also play with the reading off only when the low end of that interval is less than 1 point below an even score; here it is 47.7%, so `ai.adaptation.ablation.offPolicy.servesAdaptiveWhileOff` is false. <!-- facts: ai.adaptation.ablation.offPolicy.headToHead.ci95.0 --> That is why section 9.5 turns the reading off with a rollback. For a person who opted out it works in their favour: the network that faces them is weaker than the twin head to head. Their quick play matches still count in the test window.
* **Not stronger than its twin.** Head to head against the twin the adaptive network scores 49.1% (from 48.3% to 49.9%). <!-- facts: ai.adaptation.headToHead.rows.adaptive-twin.mean, ai.adaptation.headToHead.rows.adaptive-twin.ci95.0, ai.adaptation.headToHead.rows.adaptive-twin.ci95.1 --> Against the styled opponents it gains 0.72 points over the twin (from 0.49 points to 0.94 points), of which the reading itself is 0.24 points (from 0.13 points to 0.35 points). <!-- facts: ai.adaptation.perStyle.pooled.allStyles.gainVsTwin.mean, ai.adaptation.perStyle.pooled.allStyles.gainVsTwin.ci95.0, ai.adaptation.perStyle.pooled.allStyles.gainVsTwin.ci95.1, ai.adaptation.perStyle.pooled.allStyles.gainVsAblated.mean, ai.adaptation.perStyle.pooled.allStyles.gainVsAblated.ci95.0, ai.adaptation.perStyle.pooled.allStyles.gainVsAblated.ci95.1 --> Against v1 it scores 71.3% and the twin 72.3%. <!-- facts: ai.adaptation.headToHead.rows.adaptive-v1.mean, ai.adaptation.headToHead.rows.twin-v1.mean --> Its 53.3% against v2 in the local gate most likely comes from the training it had after v2's snapshot (v3 is iteration 590 of its run, v2 is `it000390` of the earlier one), not from the reading, since against its own twin, trained as long, it is not stronger; that twin was not measured against v2. <!-- facts: ai.adaptation.switchOnCheck.gate.sprt.mean, ai.adaptation.switchOnCheck.candidate.iterations -->
* **By one measure, its base is easier to exploit.** An explorer trained by reinforcement learning against the adaptive file scored 59.9% against it as served and 60.5% against the ablated network; a control explorer, trained the same way against v2, scored 56.4% against the twin (`training/runs/m6-twin-r`), a file it never trained against. <!-- facts: ai.adaptation.explorer.control.fresh.trained.scores.vsAdaptive.mean, ai.adaptation.explorer.control.fresh.trained.scores.vsAblated.mean, ai.adaptation.explorer.control.fresh.control.scores.vsTwin.mean --> By this measure a dedicated trained opponent takes 3.44 points more from the adaptive network as served (from 2.60 points to 4.29 points). <!-- facts: ai.adaptation.explorer.control.fresh.asServed.mean, ai.adaptation.explorer.control.fresh.asServed.ci95.0, ai.adaptation.explorer.control.fresh.asServed.ci95.1 --> The trained explorer was measured against the file it trained on and the control was not, so this comparison is less clean; the cross checks outside each explorer's own training are within noise (`ai.adaptation.explorer.control.fresh.crossControlVsAdaptiveMinusTwin` and `crossTrainedVsTwinMinusControlVsTwin`). The reading itself is not what that explorer exploits: it costs it (section 9.1).

The test with people decides: it measures what none of these can, how people fare against the network that reads them.

### 9.5 Switching it off

Before an adaptive version is adopted there is nothing to switch off: the version in play has no reading. After the adoption, do not use `AI_ADAPT` `"off"`: every table would then play the new version's ablated network (section 9.4). Roll back on the server instead, to the version that was current before the adoption (`manifest.current` in the `$C status` of section 9.2, step 4; v2 if no cycle promoted another):

```sh
$C rollback <previous version>
```

It makes that version current at once, without waiting for a running cycle, ends the test window and marks the new version's card `rolled-back`; the rooms switch within 5 minutes, and a match keeps the version it started with. In the local proof, after `$C rollback v2` every match played v2 on every AI seat, outside any group. `AI_ADAPT` may then go back to `"off"` in a later release; for a version without reading it changes nothing. After a rollback the weekly cycles train from that version, without the reading; while an adaptive version stays in play they train from it and test every candidate against explorers (section 9.3). The cycle's own rollback (section 9.3) does the same as this command. `AI_MODE` `"heuristic"` stays the emergency switch that takes every model out of the seats.

### 9.6 After an adoption

The READMEs read what is served from `facts.json`, and so does the data page's build until `/api/live` answers; neither reads R2. Until you record the cycle's state there, they keep saying that v2 is in play and that the reading is ready, not live. The data page's status line follows `/api/live` and `/api/summary` by itself: it says the reading is on, adds the end of the test window and the share kept on the previous version while the window is open, and says the reading is off after a rollback.

Record the cycle's state after each of these, once the command that caused it has ended:

* a passing adoption (section 9.2, step 4), which opens the test window;
* the end of the window, when the daily check closes it and the new version stays (section 9.3);
* a rollback, by the daily check or with `$C rollback` (section 9.5);
* any later promotion by the weekly cycle.

On the server, in the project folder, after `git pull` (the tool records `AI_ADAPT` from that `wrangler.jsonc`):

```sh
$C --json status > training/cycle/data/prod/status-now.json
N="docker compose --profile cycle run --rm -T cycle node"
$N tools/docs/record-release.ts --status training/cycle/data/prod/status-now.json --cycle-data training/cycle/data/prod
$N tools/docs/readme-facts.ts
$N tools/data/facts-view.ts
```

`record-release.ts` reads the manifest from that status (the version in play, the control, the control share and the end of the window) and each version's card and file from `training/cycle/data/prod` (`cards/` and `versions/`). It writes `ai.inPlay` and one `ai.releases.<version>` for each version the cycle published into `facts.json`, through a temporary file and a rename, and prints what it recorded; with `--dry-run` it prints the records and writes nothing. It refuses a file whose SHA-256 is not the one on its card, and an open window whose share the status does not give. It knows the network that passed the explorer test of section 9.1 by its weights, so the version the adoption created counts as that network although the version name inside its file changed.

`readme-facts.ts` then writes both READMEs. The snapshot table describes the version in play: its file, its strength from the panel of its gate (with the previous version on the same deals), its gate, its characters from its card, and its decision time when it is the network the explorer test judged ("not measured" otherwise). The reading section says one of these:

* in a test with people, with the day of the adoption, the end of the window and the share of quick play matches kept on the previous version;
* on, after the window, with the comparison with people when each group had enough people for a public number;
* off again, after a rollback, with the version that carried the reading and the days it was adopted and rolled back;
* off, when a version that carries the reading plays while `AI_ADAPT` is `"off"`.

For a network the explorer test of section 9.1 did not judge, it says so, or gives the numbers of the cycle's own explorer step from that version's card. `facts-view.ts` makes the data page's build name the same version in play and whether its file reads.

Then, where you build and push (the server, or your checkout after copying `facts.json`, `README.md`, `README.pt-BR.md` and `web/src/data/generated/facts-view.json` into it): run the checks of section 1.6, which compare both READMEs and the data page's view with `facts.json` and fail the build when the data page goes over its size budget, then commit those four files and push. Workers Builds deploys the site.

Recording changes no model, no window and nothing in R2: it only brings the texts into line with what the cycle already did. To look first without touching the repository, give the tool a copy of `facts.json` and render the READMEs into another folder:

```sh
cp facts.json training/cycle/data/prod/facts-copy.json
$N tools/docs/record-release.ts --facts training/cycle/data/prod/facts-copy.json --status training/cycle/data/prod/status-now.json --cycle-data training/cycle/data/prod
$N tools/docs/readme-facts.ts --facts training/cycle/data/prod/facts-copy.json --out training/cycle/data/prod/readme-preview
```

## 10. Open data

Off: `OPEN_DATA_ENABLED=false` in the server's `.env` until there are 1,000 valid human matches (`open_data_matches` in `training/cycle/config/prod.toml`). The rules of the package and why: `project_docs/cycle.md`, "Open data", and `project_docs/privacy-lia.md`, section 6.

1. The token. GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token. Name `zap-open-data`; resource owner `AndreiLud`; repository access Only select repositories, `AndreiLud/zap`; repository permissions Contents, Read and write (creating a release needs Contents write: [permissions for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), read 2026-11-23); an expiration with a reminder in your calendar. Put it in `.env` as `GITHUB_RELEASES_TOKEN`.
2. When a cycle reports 1,000 valid matches, set `OPEN_DATA_ENABLED=true` in `.env`. The scheduler reads `.env` when its container starts, so recreate it outside a cycle (the end of each cycle is in `training/logs/cycle.log`): `docker compose --profile scheduler up -d --force-recreate scheduler`.
3. The first release is yours, by hand, on one day: `$C sync`, `$C build`, `$C open-data`, look inside the zip it names, run the re-identification check of `project_docs/privacy-lia.md` (section 6 asks to repeat the assessment before the first release), then `$C open-data --upload`. The upload refuses a package built from an older export, or when the newest export is more than a day old.
4. After that first release, every promotion releases on its own with the same refusals (`publish.openData` in the run's result).

A release cannot be withdrawn. To stop the automatic releases, set `OPEN_DATA_ENABLED=false` and recreate the scheduler's container as in step 2.

## 11. The brake and when to move to Workers Paid

The brake stops a new match before the Zap takes one of Cloudflare's limits past its share, and the person reads when to come back (`project_docs/brake.md`). The numbers in this section come from `docker compose run --rm -T node node worker/dev/brake-table.ts`, run on 2026-11-23 with the `wrangler.jsonc` of that day: the brake's own arithmetic on the estimates `BRAKE_COST_SOLO` and `BRAKE_COST_PER_PERSON`. Those estimates are what a match cost with its room until the room expired, measured on the local site with simulated people whose matches were short (4.875 hands and 13 messages per solo match, where the plan assumed about 12 hands and 36 messages). <!-- facts: worker.brake.measured.solo.handsMean, worker.brake.measured.solo.wsMessagesMean --> Real people may play longer, so each number also has its value for matches three times as long, in parentheses.

The variables, in `wrangler.jsonc`:

* `BRAKE_MODE`: `"free"` (the default, and what any unknown value means), `"paid"` or `"off"`.
* `BRAKE_RESERVE`: the other projects' share of each limit, 0 or more.
* `BRAKE_MONTHLY_USD`: in the paid mode only, the whole Workers Paid bill of a month in US dollars, the base fee included.
* `BRAKE_COST_SOLO` and `BRAKE_COST_PER_PERSON`: the typical cost of a match. Change them only from the ledger's real averages (`project_docs/brake.md`, "Reading the ledger").

### Problems in the configuration

A missing or invalid value falls back to a protective default, and a setting that refuses every match is accepted as written. Both are reported: the Worker and each room write one line `brake config: ...` to the logs (`$W tail`), and the daily cron run fails with the same text every day until the setting is fixed. The cases: a mode that is not `"free"`, `"paid"` or `"off"` (read as `"free"`), a reserve share missing, negative or not a number (read as 0.5), a share of 0.8 or more on Workers Free (the Zap gets nothing of that line), a paid ceiling missing or below the base fee (read as the base fee), a paid ceiling below the other projects' own bill (every match refused), and a cost estimate (`BRAKE_COST_SOLO`, `BRAKE_COST_PER_PERSON`) that is not an object or has a missing or invalid line (read as the code's fallbacks in `worker/src/brake.ts`). `worker/test/brake.test.ts` checks `wrangler.jsonc` the same way before you push.

### On Workers Free (`"free"`)

The daily limits of Workers Free belong to the whole account, shared with the portfolio and the other projects. The Zap keeps for itself 80% of each limit minus the other projects' reserve. To set the reserve, read in the dashboard the account's use over the last 14 days of every project except the Zap, take each line's highest day, divide it by the Free limit and put the result in `BRAKE_RESERVE`:

| Key | Free limit a day | The other projects' use to read |
| --- | --- | --- |
| `workerRequests` | 100,000 Worker requests <!-- facts.docs: deploy.cf.free.workerRequestsPerDay --> | Workers requests |
| `doRequests` | 100,000 requests <!-- facts.docs: deploy.cf.free.doRequestsPerDay --> | Durable Objects requests, WebSocket messages included |
| `doRowsWritten` | 100,000 rows <!-- facts.docs: deploy.cf.free.doRowsWrittenPerDay --> | Durable Objects rows written |
| `doGbSeconds` | 13,000 GB-s <!-- facts.docs: deploy.cf.free.doGbSecondsPerDay --> | Durable Objects duration |
| `d1RowsWritten` | 100,000 rows <!-- facts.docs: deploy.cf.free.d1RowsWrittenPerDay --> | D1 rows written, every database |
| `d1RowsRead` | 5,000,000 rows <!-- facts.docs: deploy.cf.free.d1RowsReadPerDay --> | D1 rows read, every database |

Limits from [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), read 2026-11-23. A project that uses none of a line gives 0. At 0.8 or above the Zap gets nothing of that line and no match starts; enter the real share all the same, since the logs and the test report it, which is the sign to move to Workers Paid. Without the numbers, 0.5 of each.

Solo matches a day the free mode admits:

| Other projects' reserve | Solo matches a day | The limit that binds first |
| --- | --- | --- |
| 50% (until their use is known) | 1,111 <!-- facts.docs: deploy.brake.free.soloPerDay.reserve50 --> (483 <!-- facts: worker.brake.freeSoloMatchesPerDay.threeTimesAsLong.reserve50 -->) | D1 rows written (Durable Object rows written) |
| 30% | 1,851 <!-- facts.docs: deploy.brake.free.soloPerDay.reserve30 --> (806 <!-- facts: worker.brake.freeSoloMatchesPerDay.threeTimesAsLong.reserve30 -->) | D1 rows written (Durable Object rows written) |
| 20% | 2,222 <!-- facts.docs: deploy.brake.free.soloPerDay.reserve20 --> (967 <!-- facts: worker.brake.freeSoloMatchesPerDay.threeTimesAsLong.reserve20 -->) | D1 rows written (Durable Object rows written) |
| 0% | 2,962 <!-- facts.docs: deploy.brake.free.soloPerDay.reserve0 --> (1,290 <!-- facts: worker.brake.freeSoloMatchesPerDay.threeTimesAsLong.reserve0 -->) | D1 rows written (Durable Object rows written) |

D1 rows written bind first, with Durable Object rows written close behind (1,153 with the 50% reserve). <!-- facts.docs: deploy.brake.free.doRowsWrittenNextReserve50 --> For matches three times as long, Durable Object rows written bind and Durable Object requests come next, at 697 a day with the 50% reserve. <!-- facts: worker.brake.freeSoloMatchesPerDay.threeTimesAsLong.next --> Duration is far from binding: a solo match reserves 0.6 GB-s <!-- facts: worker.brake.estimate.solo.doGbSeconds -->, 269 ms for each of its requests and messages <!-- facts: worker.brake.duration.reservedMsPerInvocation -->, which the rounding up to a tenth of a GB-s turns into 282 ms each <!-- facts.docs: deploy.brake.reservedMsPerInvocation -->, and duration would bind first only above 1,652 ms each. <!-- facts.docs: deploy.brake.durationBindsAboveMs --> A room with 4 people counts as 4.5 solo matches on its heaviest lines. <!-- facts: worker.brake.estimate.room4WeighsSolo -->

What a day of solo matches uses of each Free daily limit, and the Workers Paid bill of a 30 day month for the Zap alone:

| Solo matches a day | Durable Object rows written | D1 rows written | Durable Object requests | Duration | Workers Free | Workers Paid, Zap alone |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 2.6% <!-- facts.docs: deploy.brake.doRowsWrittenShare.solo100 --> (6.2% <!-- facts.docs: deploy.brake.threeTimes.doRowsWrittenShare.solo100 -->) | 2.7% <!-- facts.docs: deploy.brake.d1RowsWrittenShare.solo100 --> | 1.7% <!-- facts.docs: deploy.brake.doRequestsShare.solo100 --> (4.3% <!-- facts.docs: deploy.brake.threeTimes.doRequestsShare.solo100 -->) | 0.5% <!-- facts.docs: deploy.brake.doGbSecondsShare.solo100 --> (1.2% <!-- facts.docs: deploy.brake.threeTimes.doGbSecondsShare.solo100 -->) | fits | US$ 5.00 <!-- facts: worker.brake.paidUsdPerMonth.alone.soloPerDay100 --> (US$ 5.00 <!-- facts.docs: deploy.brake.threeTimes.paidAloneUsd.solo100 -->) |
| 1,000 | 26% <!-- facts: worker.brake.freeShareAt1000PerDay.doRowsWritten --> (62% <!-- facts: worker.brake.freeShareAt1000PerDay.threeTimesAsLong.doRowsWritten -->) | 27% <!-- facts.docs: deploy.brake.d1RowsWrittenShare.solo1000 --> | 17% <!-- facts.docs: deploy.brake.doRequestsShare.solo1000 --> (43% <!-- facts.docs: deploy.brake.threeTimes.doRequestsShare.solo1000 -->) | 4.6% <!-- facts: worker.brake.freeShareAt1000PerDay.doGbSeconds --> (12% <!-- facts: worker.brake.freeShareAt1000PerDay.threeTimesAsLong.doGbSeconds -->) | fits with the other projects at 50% (three times as long: only with the other projects at 0) | US$ 5.00 <!-- facts: worker.brake.paidUsdPerMonth.alone.soloPerDay1000 --> (US$ 5.00 <!-- facts: worker.brake.paidUsdPerMonth.threeTimesAsLong.alone.soloPerDay1000 -->) |
| 10,000 | 260% <!-- facts.docs: deploy.brake.doRowsWrittenShare.solo10000 --> (620% <!-- facts.docs: deploy.brake.threeTimes.doRowsWrittenShare.solo10000 -->) | 270% <!-- facts.docs: deploy.brake.d1RowsWrittenShare.solo10000 --> | 170% <!-- facts.docs: deploy.brake.doRequestsShare.solo10000 --> (430% <!-- facts.docs: deploy.brake.threeTimes.doRequestsShare.solo10000 -->) | 46% <!-- facts.docs: deploy.brake.doGbSecondsShare.solo10000 --> (115% <!-- facts.docs: deploy.brake.threeTimes.doGbSecondsShare.solo10000 -->) | does not fit | US$ 5.15 <!-- facts: worker.brake.paidUsdPerMonth.alone.soloPerDay10000 --> (US$ 17.65 <!-- facts: worker.brake.paidUsdPerMonth.threeTimesAsLong.alone.soloPerDay10000 -->) |

D1 rows do not grow with the length of a match: a match writes its rows when it starts and ends. Worker requests stay at or below 20% of their Free limit in every row. <!-- facts.docs: deploy.brake.workerRequestsShare.solo10000 --> With the other projects at 50% of the Free limits on top, the Paid bill reads US$ 5.15, US$ 5.15 and US$ 5.30 <!-- facts: worker.brake.paidUsdPerMonth.withOthers50.soloPerDay100, worker.brake.paidUsdPerMonth.withOthers50.soloPerDay1000, worker.brake.paidUsdPerMonth.withOthers50.soloPerDay10000 --> (US$ 5.15, US$ 5.15 and US$ 17.95 <!-- facts.docs: deploy.brake.threeTimes.paidWithOthers50Usd.solo100; facts: worker.brake.paidUsdPerMonth.threeTimesAsLong.withOthers50.soloPerDay1000, worker.brake.paidUsdPerMonth.threeTimesAsLong.withOthers50.soloPerDay10000 -->).

### When to move to Workers Paid, and what it costs

Move when the brake turns people away. A day in the ledger with `refused` above zero means someone read "O Zap chegou ao limite de hoje":

```sh
$W d1 execute zap --remote --command "SELECT day, matches, refused FROM brake_days WHERE refused > 0 ORDER BY day DESC LIMIT 14"
```

On Workers Free the brake keeps the other projects safe, but the Zap stops for the rest of the day. A higher reserve or a looser brake is not the answer; Workers Paid is. Two more reasons to move, whichever comes first: the account needs more than 5 Cron Triggers (section 6), or the daily export grows past what one cron run may query on Workers Free (`project_docs/retention.md`, "The daily job's D1 budget").

What Workers Paid costs ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), read 2026-11-23):

* A minimum of US$ 5 a month for the account. <!-- facts.docs: deploy.cf.paid.baseUsdPerMonth -->
* Included each month: 10 million Worker requests, then US$ 0.30 a million <!-- facts.docs: deploy.cf.paid.workerRequestsIncludedPerMonth, deploy.cf.paid.workerRequestsUsdPerMillion -->; 30 million CPU milliseconds, then US$ 0.02 a million <!-- facts.docs: deploy.cf.paid.cpuMsIncludedPerMonth, deploy.cf.paid.cpuUsdPerMillionMs -->.
* Durable Objects: 1 million requests, then US$ 0.15 a million <!-- facts.docs: deploy.cf.paid.doRequestsIncludedPerMonth, deploy.cf.paid.doRequestsUsdPerMillion -->; 400,000 GB-s of duration, then US$ 12.50 a million GB-s. <!-- facts.docs: deploy.cf.paid.doGbSecondsIncludedPerMonth, deploy.cf.paid.doGbSecondsUsdPerMillion -->
* Incoming WebSocket messages count as one Durable Object request for every 20 on the Paid bill <!-- facts.docs: deploy.cf.paid.wsMessagesPerBilledRequest -->, while the Free daily limit counts each one.
* Rows, for Durable Object storage and for D1 alike: 50 million written, then US$ 1.00 a million <!-- facts.docs: deploy.cf.paid.rowsWrittenIncludedPerMonth, deploy.cf.paid.rowsWrittenUsdPerMillion -->; 25 billion read, then US$ 0.001 a million. <!-- facts.docs: deploy.cf.paid.rowsReadIncludedPerMonth, deploy.cf.paid.rowsReadUsdPerMillion -->
* Usage beyond an included amount is rounded up to the next whole million before it is priced (the Durable Objects pricing page, quoted in `project_docs/brake.md`), so a line that just passes its included amount adds a whole million: US$ 0.15 for requests, US$ 12.50 for duration. That is what happens at 10,000 solo matches a day three times as long.

These are the prices `PAID_MONTHLY` in `worker/src/brake.ts` uses; they matched the pricing page on 2026-11-23. If Cloudflare changes them, change them there too.

To move:

1. Dashboard: Workers & Pages, Plans, Workers Paid.
2. In `wrangler.jsonc`: `BRAKE_MODE` `"paid"` and `BRAKE_MONTHLY_USD` the most the month's bill may reach, for example `"20"`. It must be above the other projects' own bill or every match is refused: US$ 5.15 with the 50% reserve, US$ 5.30 with every share at 80% <!-- facts: worker.brake.paidMinimumCeilingUsd.reserve50, worker.brake.paidMinimumCeilingUsd.reserve80 --> (`brake-table.ts` prints it for the reserve in the file). `BRAKE_RESERVE` stays as entered, even above 0.8: on Paid it stands for the other projects' use of the included amounts, every day of the month. Commit and push (no migration). The month starts on the 1st at 00:00 UTC, and a refusal names the month's last day.
3. Or `BRAKE_MODE` `"off"`: no brake and no ledger, only Cloudflare's bill. Set a billing notification in the dashboard then.

Solo matches the paid mode admits in a 30 day month, with the other projects at 50%: about 11,389 a day for US$ 10 <!-- facts: worker.brake.paidSoloMatchesPerDay.usd10 --> (4,556 <!-- facts: worker.brake.paidSoloMatchesPerDay.threeTimesAsLong.usd10 -->), 61,111 for US$ 20 <!-- facts.docs: deploy.brake.paid.soloPerDay.usd20 --> (26,613 <!-- facts: worker.brake.paidSoloMatchesPerDay.threeTimesAsLong.usd20 -->) and 72,222 for US$ 50 <!-- facts.docs: deploy.brake.paid.soloPerDay.usd50 --> (35,753 <!-- facts: worker.brake.paidSoloMatchesPerDay.threeTimesAsLong.usd50 -->). The steps are uneven because each line is billed by the whole million. Long before those numbers the real ledger replaces the estimates; read the month's bill in the dashboard too.

## 12. Later releases

1. Before a push to `main`, run the checks of section 1.6 (typecheck, tests, build). The integration and end to end suites run against the local sites (`tests/integration`, `tests/e2e/playwright.config.ts`).
2. Push. Workers Builds applies any new migration, then deploys. A migration must only add: new code may use a new table, and old code still running ignores it.
3. Rooms keep their old code for up to 24 hours after a deploy (`code_update_strategy` `deferred`), so open matches are not cut. During that time the new Worker may call a room that still runs the old `Room` class:
   * A release that adds or changes a `Room` method the Worker calls (`create`, `info`, `report`, `forget`, `rekey`, `setNoAdapt`, or the `X-Zap-*` headers of the WebSocket hand off) goes out with `"mode": "immediate"` for that one deploy, then back to `deferred`. Open matches reconnect once.
   * If that is skipped, nothing is lost silently: a deletion that cannot reach such a room deletes nothing and asks the person to try again, and a recovery keeps the call in `room_calls` until the room runs the new code or the daily job delivers it.
4. After the deploy, run section 8 again.
5. Models are not part of a release: the training cycle publishes them to `zap-models`. A Worker release changes the bundled models (v2 by default, v1 behind it) only when `ai/models/bootstrap/` changes.
6. On the server, after `git pull`: when `training/requirements.lock` or `training/Dockerfile` changed, rebuild the training image and then the cycle image (section 7.3); when only `training/cycle/requirements.lock` or `training/cycle/Dockerfile` changed, rebuild the cycle image. Code needs no rebuild: the folder is mounted. Restart the scheduler while no cycle runs (`training/cycle/SERVER.md`, "Updating the code").

## 13. Rollback

| What went wrong | Roll back with |
| --- | --- |
| A new model plays badly | On the server: `$C rollback vN`. It never waits for a running cycle; rooms switch within 5 minutes. The cycle also rolls back by itself when people clearly beat the new version in its test window. |
| A Worker release | Dashboard: `zap`, Deployments, the version to go back to, the three dots, Rollback. Or `$W rollback <version id>`. Then revert the commit on `main`, or the next push deploys it again. |
| The reading during the match | Before an adaptive version is adopted there is nothing to undo. After it: on the server, `$C rollback <previous version>` (v2 unless a cycle promoted another), not `AI_ADAPT` `"off"` (section 9.5). |
| Ads | `ADS_ENABLED` `"false"` ("How to enable ads"). |
| A broken migration | D1 Time Travel (below). |

About the Worker rollback ([Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/), read 2026-11-23): it reaches the 100 most recent versions <!-- facts.docs: deploy.cf.rollback.versions -->; "Resources connected to your Worker will not be changed during a rollback", so D1 and R2 stay as they are; and it is refused across a change of a Durable Object class under `exports`.

D1 Time Travel restores the database to a minute within the last 7 days on Workers Free, 30 on Workers Paid <!-- facts.docs: deploy.cf.d1.timeTravelDaysFree, deploy.cf.d1.timeTravelDaysPaid --> ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), read 2026-11-23):

```sh
$W d1 time-travel info zap --timestamp="2026-12-01T03:59:00Z"
$W d1 time-travel restore zap --timestamp=<unix seconds>
```

A restore overwrites the database in place and loses everything written after that minute, including people's deletions and changes. Use it only for a migration that broke the database, to a minute just before it, and only when nothing else fixes it.

## 14. Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| The build stops before installing anything | The Worker name is not `zap`, or `wrangler.jsonc` is not at the root directory | Section 2 |
| The build stops at `d1 migrations apply` | The token has no D1 Edit, or `database_id` is still the placeholder | Sections "Before you start" and 1.6 |
| The build stops after `prerender` with a budget line | The site grew past its size budget (`web/scripts/budget.ts`) | Run `npm run build:web` locally and read the line |
| The deploy refuses a binding | A bucket name differs from `wrangler.jsonc`, or 5 Cron Triggers are already in use | Sections 1.2 and 6 |
| `500 {"error":"misconfigured"}` | A secret is missing, `SESSION_SECRET` is short, the site key is the test key, or `TURNSTILE_HOSTNAMES` is empty | Sections 1.4, 1.6 and 3 |
| `403 {"error":"https_required"}` | The API was called over plain http | Section 5.4 |
| `403 {"error":"bad_origin"}` | A change came from another origin than the page's or `PUBLIC_ORIGIN` | Check `PUBLIC_ORIGIN` |
| The human check never appears, or fails in the browser | The hostname is not in the widget or in `TURNSTILE_HOSTNAMES`, or the secret belongs to another widget | Section 1.4; the browser console names a blocked source |
| `503 {"error":"limit_reached"}` | The brake refused a match | Section 11 |
| `429 {"error":"too_many"}` | A rate limit (the `RL_*` bindings or the WAF rule) | Wait a minute; check the WAF rule's numbers |
| The cron run fails every day with `brake config: ...` | A brake var is wrong | Section 11, "Problems in the configuration" |
| The cron run fails with `daily jobs failed: ...` | One job failed; the receipt names it | Read the receipt (section 6) and `$W tail` during the next run |
| No alert email ever, and the receipt says `jobs.alert.status` `"off"` | `ALERT_FROM`, `ALERT_EMAIL` or Email Routing is missing | Sections 1.5 and 3. The Email Routing summary lists the Worker's emails as dropped even when they arrive ([Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/), read 2026-11-23) |
| A "stale" alert | The scheduler is not running or cannot reach R2 | Section 7.6 |
| `$C` exits with code 2 | A guard: wrong variable, endpoint or bucket | The message names it; section 7.1 |
| `$C` exits with code 3 | A cycle holds the lock | Try again later |
| `$C status` shows `status.state` `running`, but `cycleLock` is `null` and no container of the cycle runs a command | A step or cycle that did not end left an out of date status: a step run by hand with an older version of the cycle, such as `$C sync`, or a step or cycle that was interrupted (Ctrl+C, a stopped or killed container, a reboot) | Nothing to undo: the next cycle or step that ends ok writes it again, and `$C sync` is the quickest such step (section 9.2, step 4) |
| `$C status` prints `"remote": "unavailable: ..."` | Endpoint, keys or token scope | Sections 7.1 and 7.2 |
| `/api/summary` answers 404 | No summary yet | Wait for the scheduler's first daily check (section 7.6) |
| Rooms still play the old model after a rollback | The manifest is cached | Up to 5 minutes |
| The custom domain cannot be added | A CNAME record exists for `zap` | Section 5.1 |
| The .com.br address does not redirect | The `AAAA` record is missing or not proxied | Section 5.3 |

Logs: observability is off (`"observability": { "enabled": false }`), so Cloudflare stores no Worker logs (`project_docs/retention.md`). To watch live, `$W tail` while you reproduce the problem; it stores nothing. Turning observability on would store logs at Cloudflare and needs `retention.md` and the Privacidade page to change first.

## 15. Privacy and the law

Not legal advice: this section lists what the project's own assessment asks for. It has not been reviewed by a lawyer (`project_docs/privacy-lia.md`).

* Set `PRIVACY_CONTACT` before launch (section 1.5) and answer requests within 15 days (LGPD art. 19, as the assessment reads it).
* The minimum age is 18, by self declaration; the assessment explains why that does not remove the duties of the ECA Digital, and the defaults it keeps for that reason.
* Data goes to Cloudflare in the United States and, for open data, to GitHub. The assessment lists the transfer mechanism as an open point to confirm.
* Repeat the assessment before the first open data release (section 10), before switching on the reading during the match (section 9), before ads ("How to enable ads"), and once a year.
* Review reports and flags weekly (`project_docs/moderation.md`).

Not legal advice.

<a id="ads-in-test-mode"></a>

## How to enable ads

Ads are off at launch, and the code holds only their structure. This section says how to turn them on, in an order that keeps the game working at every step. Every Google page cited below was read on 2026-11-23, and each one could be read. Not legal advice: ads touch the LGPD, the ECA Digital and the European rules on cookies and consent, and the steps below are what Google's pages and the project's assessment ask for, not a legal opinion.

### What the code does today

* `ADS_ENABLED` is `"false"`. Then `/api/config` answers `"ads": null`, `/ads.txt` answers 404, the content security policy in `_headers` names no Google domain, and the page loads nothing from Google: no script, no consent dialog, no reserved space (`worker/src/ads.ts`, `web/src/ads/`).
* When ads are on, the page asks once ("Aceitar anúncios" or "Jogar sem anúncios", equal buttons). Whoever says no plays the same, with no ads.
* Ads are full screen only, never a reward, and appear only at pause points: when a room's match ends, at "Jogar de novo" after a solo match, between two hands of a solo match, and in a lobby after a few seconds of waiting. Never during a hand or while a clock runs: between solo hands the room holds the person's clock while the ad shows, and gives back the time that was left.
* A failed or blocked ad shows nothing and the game goes on. Ad events never enter training, and the time an ad holds never counts as decision time.
* The loader asks Google for non-personalized ads for everyone (`requestNonPersonalizedAds = 1`, `web/src/ads/loader.ts`).

### The product: AdSense H5 Games Ads

Ads inside a browser game use AdSense H5 Games Ads, with Google's Ad Placement API (`adBreak()` and `adConfig()`). "H5 Games Ads let you grow your earnings by showing interstitial and rewarded ads in your HTML5 (H5) games. It is a by-application product", and "You need an approved AdSense account to show ads in your H5 games" ([Sign up for H5 Games Ads](https://support.google.com/adsense/answer/1705831?hl=en), read 2026-11-23). "Account approval is not guaranteed as it is subject to partner eligibility" ([Ad Placement API, how to sign up](https://developers.google.com/ad-placement/docs/signup), read 2026-11-23); the form it links to is `https://adsense.google.com/start/h5-beta/?src=devsite`, and its address still says beta, though the page text does not. Google's product page says "all publishers that have an H5 games site can apply", within the Advertising and AdSense Program policies ([H5 Games Ads](https://adsense.google.com/start/h5-games-ads/), read 2026-11-23). Full screen ads must sit at natural transitions and must not interrupt continuous gameplay ([H5 Games Ads overview](https://support.google.com/adsense/answer/9959170?hl=en), read 2026-11-23), which is what the pause points above do.

The steps:

1. An AdSense account. Applicants must be at least 18 <!-- facts.docs: deploy.google.adsense.minApplicantAge --> and must be able to edit the site's HTML ([AdSense eligibility](https://support.google.com/adsense/answer/9724?hl=en), read 2026-11-23).
2. The site. AdSense accepts root domains as sites, not subdomains of an existing site: "You'll no longer be able to add or manage subdomains that are part of an existing site" ([Site management changes](https://support.google.com/adsense/answer/12170421?hl=en), read 2026-11-23). So the site is `andreiludescher.com`, which covers `zap.andreiludescher.com`. In AdSense, Sites, New site, enter it, verify it with the ads.txt snippet (below), and request a review. The review "usually takes a few days, but in some cases can take 2-4 weeks" ([Add a site](https://support.google.com/adsense/answer/12169212?hl=en), read 2026-11-23). <!-- facts.docs: deploy.google.adsense.siteReview --> The site under review is the root domain, the portfolio.
3. Apply for H5 Games Ads with the form above, giving the publisher id.

### ads.txt

"Use of ads.txt is not mandatory, but it's highly recommended", in the root directory of the site, with the line `google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0` where the zeros are your publisher id; AdSense may take a few days to see a change, up to a month for a site with few ad requests ([Ads.txt guide](https://support.google.com/adsense/answer/12171612?hl=en), read 2026-11-23). <!-- facts.docs: deploy.google.adsTxt.pickup -->

* Put that line in `https://andreiludescher.com/ads.txt`, on the portfolio's own site.
* The Zap answers `https://zap.andreiludescher.com/ads.txt` with the same line while ads are on (`worker/src/ads.ts`). Google crawls a subdomain's ads.txt when the root file names it with a `subdomain=` line, but "You only need to do this if the authorized seller or your publisher ID are different for the subdomain" ([Ads.txt FAQs](https://support.google.com/adsense/answer/9785052?hl=en), read 2026-11-23). With one publisher id for both, the root line is enough.

### Block sensitive categories before ads go on

AdSense, Brand safety, your product, Blocking controls, then Manage Sensitive categories. "Standard sensitive categories are allowed by default" and "Restricted sensitive categories are blocked by default" ([Sensitive categories](https://support.google.com/adsense/answer/164131?hl=en), read 2026-11-23):

* Gambling & Betting (18+): restricted, blocked by default. Keep it blocked.
* Alcohol: restricted, blocked by default. Keep it blocked.
* Social Casino Games: standard, allowed by default. Block it: the Zap must never look like betting.
* Block these standard ones too, which do not fit a card game that people of any age may reach: Dating, Get rich quick, Consumer Loans, Reference to sex, Sensationalism, Weight loss, Cosmetic procedures & body modification, Drugs & supplements, Astrology & esoteric. Leave the others as you judge.

Blocking controls apply to the whole site `andreiludescher.com`, since subdomain settings were moved up to the domain (Site management changes page).

### Non-personalized ads for everyone

"Non-personalized ads are not based on a user's past behavior", but they "do still use cookies or mobile ad identifiers for frequency capping and aggregated ad reporting. You must obtain consent to use cookies or mobile ad identifiers for those purposes where legally required" ([Personalized and non-personalized ads](https://support.google.com/adsense/answer/9007336?hl=en), read 2026-11-23). The code sets `(adsbygoogle=window.adsbygoogle||[]).requestNonPersonalizedAds=1` before Google's script loads; Google's example puts it after the script tag and asks only that it come before the first ad request ([Ad code examples for ads personalization settings](https://support.google.com/adsense/answer/9042142?hl=en), read 2026-11-23), and only after the person said yes in the Zap's own dialog. For Brazil, Google lets a publisher "serve only non-personalized ads to users in Brazil" ([LGPD](https://support.google.com/adsense/answer/9928203?hl=en), read 2026-11-23). Keep it this way: the ECA Digital restricts profiling children and adolescents for commercial advertising, and the age screen does not prove anyone's age (`project_docs/privacy-lia.md`, "Age and ECA Digital").

### Consent in the European Economic Area, the United Kingdom and Switzerland

Google requires "a certified CMP integrated with the TCF" for personalized ads in the EEA and the UK since 2024-01-16, and in Switzerland since 2024-07-31; "Traffic from a non-certified CMP may be eligible for non-personalized ads or limited ads" ([Google-certified CMP requirement](https://support.google.com/adsense/answer/13554116?hl=en), read 2026-11-23). <!-- facts.docs: deploy.google.cmp.eeaUkSince, deploy.google.cmp.switzerlandSince --> Publishers and CMPs had to move to TCF v2.3 by 2026-03-01 ([Recent transition to IAB TCF v2.3](https://support.google.com/adsense/answer/16942036?hl=en), read 2026-11-23). <!-- facts.docs: deploy.google.tcf.version, deploy.google.tcf.requiredSince -->

The Zap's own dialog is not a certified CMP. Before ads go on, choose one:

* Google's own: AdSense, Privacy & messaging, European regulations message, which is certified (same page), or a CMP from Google's list of certified CMPs. It loads its own script and shows its own message to people in those regions, on top of the Zap's dialog. Check that the two do not ask twice in a confusing way, in the test of the last step.
* Or keep ads off for people in those regions. The code has no way to do that today: it would need a change (for example the Worker reading the request's country and answering `ads: null`).

Without one of these, do not turn ads on.

### The site's own notice and texts

* Turning ads on changes the version of the notice from `NOTICE_VERSION` to its `+ads` form (`web/src/consent-keys.ts`), so everyone sees the notice again, now with its ads row. Nothing to do for that.
* The legal texts still say there are no ads. Before ads go on, change in both languages `legal.privacy.notCollected.p3` ("Hoje não há anúncios nem rastreadores"), `legal.privacy.minors.p3` (which lists ads among what the Zap does not have), the sharing section (Google as a recipient) and the browser section (`legal.privacy.browser.*`: the ads answer in localStorage `zap-ads` and the time of the last ad break in sessionStorage `zap-ads-last`), in `locales/legal.pt-BR.json` and `locales/legal.en.json`, and make a new version of the assessment (`project_docs/privacy-lia.md`, "Open points", 4).

### The content security policy needs a change first

Google supports only a strict policy for the AdSense code: "we only support strict CSP (option 2)", because "the domains that the AdSense ad code uses change over time". The policy it shows is `object-src 'none'; script-src 'nonce-{random}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:; base-uri 'none';`, with the nonce on every script tag of the page, and it suggests testing first with the `Content-Security-Policy-Report-Only` header ([AdSense and CSP](https://support.google.com/adsense/answer/16283098?hl=en), read 2026-11-23).

What the code does today does not match it. The pages are static files with one policy, written by the build: `web/public/_headers` holds only `frame-ancestors 'none'` as its policy line, and the build replaces it with the full policy (`CSP` and `buildHeaders` in `web/scripts/head.ts`). With `ADS_ENABLED` `"true"` the build only appends a list of Google domains (`ADS_CSP`, same file) to `script-src`, `frame-src`, `img-src` and `connect-src`. Google says a stricter policy than its own "may break without notice", and it does not support a list of domains. Before ads go on, the site needs a code change:

* a fresh nonce on every HTML answer, which means the Worker (not the static files) answers the pages, adds the nonce to each script tag, and sends a policy with that nonce and `'strict-dynamic'` (each page view then costs a Worker request, which counts toward the daily limit and the brake's arithmetic);
* `frame-src`, `img-src`, `connect-src` and `style-src` loose enough for the ads' frames, images, requests and inline styles (the policy has no `'unsafe-inline'` for styles today), which Google's page does not list;
* a first run with `Content-Security-Policy-Report-Only`, watching the browser console.

Test ads alone do not prove the policy: in test mode Google shows mock ads and "can't help you to detect issues related to misconfiguration of the AdSense code" ([Testing modes](https://developers.google.com/ad-placement/docs/test), read 2026-11-23).

### The vars and what the site does with each

| Var | Values | What the site does |
| --- | --- | --- |
| `ADS_ENABLED` | `"true"` or anything else | Anything but `"true"`: everything off, as above. `"true"` with a valid client id: `/api/config` sends `ads`, `/ads.txt` answers the publisher's line, the notice shows its ads row and the dialog asks once. The build reads it too: with `"true"` the policy in `_headers` gets the ad sources, even while an invalid client id keeps ads off (the change above replaces this). |
| `ADS_CLIENT_ID` | `ca-pub-` and 16 digits | Anything else keeps ads off even with `ADS_ENABLED` `"true"`. Its digits make the ads.txt line. |
| `ADS_TEST_MODE` | `"true"` or `"false"` | `"true"` adds `data-adbreak-test="on"` to Google's script: mock ads that follow the frequency and alternate between an ad that loads and one that does not ([Testing modes](https://developers.google.com/ad-placement/docs/test)). `"false"`: real ads. |
| `ADS_MIN_INTERVAL_S` | seconds | Sent as `data-ad-frequency-hint`, and the page itself never asks for two ads closer than this in one tab. Empty or invalid: 120. Below 30: 30. Google's default is "120s" and "the maximum rate that ads can show is once every 30s"; the first ad is not capped, and the hint "could be ignored or overridden by a server control in future" ([Control the rate the players see ads](https://developers.google.com/ad-placement/docs/ad-rate), read 2026-11-23). <!-- facts.docs: deploy.google.h5.frequencyHintDefaultSeconds, deploy.google.h5.maxRateSeconds --> |

A var changes in `wrangler.jsonc`, then a commit and a push; a room already open may keep the old values for up to 24 hours.

### Test mode first, then real ads

Only after the account and H5 Games Ads are approved, the categories are blocked, the CMP is chosen, the texts and the assessment are updated and the policy change is in:

1. In `wrangler.jsonc`: `ADS_CLIENT_ID` your publisher id, `ADS_TEST_MODE` `"true"`, `ADS_MIN_INTERVAL_S` `"120"`, `ADS_ENABLED` `"true"`. Commit, push.
2. Check:

   ```sh
   curl -s https://zap.andreiludescher.com/api/config
   # "ads":{"client":"ca-pub-...","test":true,"minIntervalS":120}
   curl -s https://zap.andreiludescher.com/ads.txt
   # google.com, pub-..., DIRECT, f08c47fec0942fa0
   ```

3. In a browser, on a phone and on a computer: the notice shows again with its ads row; the dialog asks once; whoever says no plays with no ads and no request to Google; test ads show only at the pause points; the clock between solo hands comes back with the time that was left; a blocked ad (an ad blocker on) shows nothing and the game goes on; the console names no blocked source.
4. After a few days of test ads with nothing wrong in the console, set `ADS_TEST_MODE` `"false"`, commit, push, and watch the console again with real ads.

### Turning ads off

`ADS_ENABLED` `"false"`, commit, push. `/ads.txt` answers 404 again, the policy loses the ad sources, and the dialog no longer appears. The root domain's ads.txt line can stay.

## Sources

Every page below was read on 2026-11-23.

| Page | URL | Used for |
| --- | --- | --- |
| Workers pricing | https://developers.cloudflare.com/workers/platform/pricing/ | Free daily limits, Workers Paid prices, D1 and Durable Object rows, WebSocket messages on the Paid bill |
| Workers limits | https://developers.cloudflare.com/workers/platform/limits/ | Cron Triggers per account, Worker size, static assets |
| Builds configuration | https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ | build and deploy commands, API token |
| Build image | https://developers.cloudflare.com/workers/ci-cd/builds/build-image/ | Node version, dependency install |
| Build branches | https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/ | production branch, preview builds |
| Builds limits | https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ | build minutes and timeout |
| Builds troubleshooting | https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/ | Worker name |
| Wrangler configuration | https://developers.cloudflare.com/workers/wrangler/configuration/ | source of truth, `workers_dev` |
| Secrets | https://developers.cloudflare.com/workers/configuration/secrets/ | setting secrets |
| Durable Objects migrations | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ | `exports`, SQLite on Free |
| Rate Limiting binding | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ | namespace ids |
| R2 pricing | https://developers.cloudflare.com/r2/pricing/ | free tier |
| R2 API tokens | https://developers.cloudflare.com/r2/api/tokens/ | scoped tokens |
| Turnstile hostname management | https://developers.cloudflare.com/turnstile/concepts/hostname-management/ | widget hostnames |
| Email Service limits | https://developers.cloudflare.com/email-service/platform/limits/ | sending to verified addresses |
| Email Service pricing | https://developers.cloudflare.com/email-service/platform/pricing/ | free sends to verified addresses |
| Custom Domains | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ | custom domain |
| Single Redirects | https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-dashboard/ | the .com.br redirect |
| Always Use HTTPS | https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/ | https for the zone |
| Rate limiting rules | https://developers.cloudflare.com/waf/rate-limiting-rules/ | the free WAF rule |
| Cron Triggers | https://developers.cloudflare.com/workers/configuration/cron-triggers/ | deploys replace crons, Cron Events |
| Rollbacks | https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/ | Worker rollback |
| Time Travel | https://developers.cloudflare.com/d1/reference/time-travel/ | D1 restore |
| Fine-grained token permissions | https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens | Contents write for releases |
| Sign up for H5 Games Ads | https://support.google.com/adsense/answer/1705831?hl=en | by application, AdSense account |
| How to sign up (Ad Placement API) | https://developers.google.com/ad-placement/docs/signup | approval, the form |
| H5 Games Ads (product page) | https://adsense.google.com/start/h5-games-ads/ | who may apply |
| H5 Games Ads overview | https://support.google.com/adsense/answer/9959170?hl=en | formats, placement |
| AdSense eligibility | https://support.google.com/adsense/answer/9724?hl=en | age, HTML access |
| Site management changes | https://support.google.com/adsense/answer/12170421?hl=en | root domains only |
| Add a site | https://support.google.com/adsense/answer/12169212?hl=en | site review |
| Ads.txt guide | https://support.google.com/adsense/answer/12171612?hl=en | ads.txt line |
| Ads.txt FAQs | https://support.google.com/adsense/answer/9785052?hl=en | subdomains |
| Sensitive categories | https://support.google.com/adsense/answer/164131?hl=en | defaults of each category |
| Personalized and non-personalized ads | https://support.google.com/adsense/answer/9007336?hl=en | cookies of non-personalized ads |
| Ad code examples for ads personalization settings | https://support.google.com/adsense/answer/9042142?hl=en | `requestNonPersonalizedAds` |
| LGPD | https://support.google.com/adsense/answer/9928203?hl=en | non-personalized ads in Brazil |
| Google-certified CMP requirement | https://support.google.com/adsense/answer/13554116?hl=en | EEA, UK, Switzerland |
| Recent transition to IAB TCF v2.3 | https://support.google.com/adsense/answer/16942036?hl=en | TCF v2.3 |
| AdSense and CSP | https://support.google.com/adsense/answer/16283098?hl=en | strict policy only |
| Testing modes | https://developers.google.com/ad-placement/docs/test | `data-adbreak-test` |
| Control the rate the players see ads | https://developers.google.com/ad-placement/docs/ad-rate | `data-ad-frequency-hint` |
