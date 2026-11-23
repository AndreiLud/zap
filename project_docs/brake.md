# The brake

The brake is the Zap's admission control (plan, section 14). Cloudflare's daily limits on Workers Free belong to the whole account, which the Zap shares with the owner's other projects. Before a match starts, the Worker (quick play) or the room (a room's start, "Jogar de novo") reserves the match's typical cost in D1; a match that would take any limit past its share does not start, and the person reads "O Zap chegou ao limite de hoje. Volte depois das 21h." (21h in Brasília is 00:00 UTC, when the daily limits start again). When the match ends, the room swaps the reservation for what it really spent, and when the room expires it writes what it spent after that. Code: `worker/src/brake.ts`, `worker/src/allowance.ts` (`admitMatch`), `worker/src/cf/room.ts`; table: `brake_days` (`worker/migrations/0007_brake.sql`, `project_docs/data-dictionary.md`). How to set it before a deploy, and when to move to Workers Paid: `DEPLOY.md`, "The brake and when to move to Workers Paid".

## How it decides

* One D1 row per UTC day (`brake_days`) holds the open reservations (`r_*`) and the real spend (`s_*`) of the day, for seven meters: Worker requests, Durable Object requests, incoming WebSocket messages, Durable Object rows written, the time the room's handlers run, D1 rows written and D1 rows read.
* **Free mode** (`BRAKE_MODE` `free`): for each of the six Workers Free daily limits, the sum of the day's open reservations, real spend and the new match's estimate must stay at or below 80% of the limit minus the other projects' reserve (`BRAKE_RESERVE`, 0.5 of each limit while their real use is unknown). A share of 0.8 or more is read as 0.8: the Zap gets nothing of that line. On Workers Free every WebSocket message counts as a Durable Object request. The limits and their sources are in `FREE_DAILY` in `brake.ts`.
* **Paid mode** (`paid`): the same sums over every day of the month are priced with the Workers Paid lines (`PAID_MONTHLY` in `brake.ts`, each with its source), on top of the other projects' monthly use (their reserve share of each Free daily limit, as entered, every day of the month), and the bill must stay at or below `BRAKE_MONTHLY_USD`, the $5 base included. What passes the included amount of a line is billed in whole millions, rounded up, as the Durable Objects pricing page says ("500,000 GB-s of billable compute duration is rounded up to 1,000,000 GB-s"); the brake rounds every line that way. The refusal names the end of the month: "Volte depois das 21h de 30 de novembro". A ceiling below the other projects' own bill refuses every match; `worker/dev/brake-table.ts` prints that minimum (US$ 5.15 with the default reserve).
* **Off** (`off`): nothing is reserved or written.
* The reservation and one match of the starter's allowance go to D1 in one batch: the allowance statement runs only when the reservation went through (the row's `ticket`), so a refused match costs the person nothing. A start that does not happen gives both back. When the Worker's call that creates a quick play room fails after the room ran it (its answer was lost), the room answers the Worker's `forget` with `held`: it gives the reservation back itself, and the Worker gives back only the person's match. A room that does not answer keeps the reservation until the day ends, which refuses matches a little early but never counts it twice.
* A refusal writes one row in the same statement: one more `refused`, and its own cost as spent (the Worker request of a quick play, or the WebSocket message of a start or a rematch, and the row itself), since no swap ever follows it. The page then keeps the refusal (`web/src/limit.ts`): until the reset, and an hour at most, "Jogar agora", a room's start and "Jogar de novo" show the message again without asking the server. From 21h to 24h in Brasília the day's reset is the next day's 21h, and the message says "Volte amanhã depois das 21h".
* The swap goes in the same D1 batch as the finished match's row and applies only while that row does not exist yet, so a batch tried again after a lost answer never counts twice. Sums never go below zero. A match that started before 00:00 UTC is swapped on the day of its reservation.
* Each swap carries everything the room counted since the previous one: the lobby before a room's first match, or the time between a match and its rematch. What the room spends after its last swap (the match row batch, the record kept and deleted in storage, closing sockets, the alarm of its expiry and the storage it deletes, and the time all of that ran) is written when it expires, with the row itself, together with the reservation of a match nobody finished. So the ledger costs 2 D1 rows written per match (the reservation and the swap) plus 1 per room (its expiry). A room expires 24 hours after its last event, so that row lands on a later day: in steady use each day carries the tails of the rooms of the day before.
* A value of the configuration that fell back to a default, or a setting that refuses every match, is written once to the logs by the Worker and by each room (`brake config: ...`), and the daily cron run fails with the same text (`DEPLOY.md`).
* Because the sums hold the real spend of every finished match and expired room, the estimate matters only for the matches being played at that moment. How many matches fit in a day depends on what they really spend.
* Tests: `worker/test/brake.test.ts` (arithmetic, the configuration, the duration estimate, the handlers' clock, the day roll, the SQL against the same arithmetic on random inputs, the swap and the expiry, refusals, the Worker's refunds), `worker/test/room-hibernation.test.ts` (nothing in the room keeps it from hibernating, and every handler is on the clock), `worker/test/room-create.test.ts` (`held`), `worker/test/cron.test.ts`, `tests/integration/brake.test.ts` (refusals on a running site, the swap, the expiry and the row budgets), `tests/e2e/brake.spec.ts` (the messages in the browser, and a refusal kept by the page), `web/test/limit.test.ts`.

## What a room counts

The room keeps a meter in its stored state, written with the state it already writes:

* every request it receives: calls from the Worker, socket upgrades, alarms and close events (`r_doreq`); every incoming WebSocket message (`dows`); a call or an upgrade also counts as one Worker request (`wreq`);
* every row it writes in its own storage: each put and each delete, each alarm it sets, and every key it deletes when a reused code starts clean or the room expires;
* the rows D1 reports for each of its statements (`rows_written`, `rows_read`), and for quick play also the D1 rows of the Worker's request that created the room;
* the time its handlers run (`BusyClock` in `brake.ts`), which is what Cloudflare bills as duration (next section): every invocation (a call from the Worker, a socket upgrade, a WebSocket message or close, an alarm, the constructor of a new or woken instance) from its entry until the promise it returns settles, awaited I/O included, and every promise the room hands to `ctx.waitUntil` until it settles. Work that overlaps counts once. Each invocation adds 10 ms (`CPU_PER_INVOCATION_MS`): inside a Worker, `Date.now()` moves only when I/O happens, so CPU work after the last awaited I/O reads as no time, and 10 ms is the CPU an invocation may use on Workers Free. Duration is billed at 128 MB per object, so 8,000 ms make one GB-s.

A room may hibernate right after an event, and its memory is lost then. So each save counts its own row, the rows written before it in the same event (the listing, the calls check, the alarm) and the time its handlers ran until that moment before the state goes to storage, and after the flush of a finished match (the match row batch in D1, the record's delete) the room stores its state once more. That one extra row per finished match is the only row the counting itself costs. The time a handler runs after the last save of its event (sending the messages, a `waitUntil` batch still in flight) stays in memory and goes with the next save; when the room hibernates first, it is lost. The margin of the estimate covers it (below).

### Why duration is the time the handlers run

The first version of the brake billed a room for every second it stayed in memory, up to 10 s after its last event, from the research notes ("hibernates after 10 s idle if no timers"). Cloudflare's pages say otherwise (read on 2026-11-22, quoted in `_local/pesquisa/research-notes.md`): a Durable Object is billed "while the Durable Object is actively running or is idle in memory but unable to hibernate", and "Durable Objects that are idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them" (pricing page). The WebSocket Hibernation API is there "to avoid incurring duration charges once all event handlers finish running". What keeps an object from being eligible (lifecycle page): a `setTimeout` or `setInterval` callback, unfinished I/O or a `ctx.waitUntil` promise, an open outbound connection, the standard WebSocket API, or a request or event still being processed.

The room uses `ctx.acceptWebSocket` (the hibernation API) and one alarm, never a timer, an outgoing socket or an outgoing `fetch`; its storage and D1 and R2 calls are awaited inside its handlers or handed to `waitUntil`, which the clock counts. `worker/test/room-hibernation.test.ts` reads the room and every module it imports and fails on `setTimeout`, `setInterval`, `scheduler.wait`, `new WebSocket(`, a TCP socket, an outgoing `fetch` or `.accept()`, and checks that every handler and RPC method runs through the clock and every `waitUntil` goes through it too. A pending alarm does not keep a room awake: the alarm wakes it when it fires, and its handler is counted then.

The ledger does not see: the page's own API calls (`/api/config` and `/api/me` on each page load, `/api/session` at each human check, the You page (/voce)), the keep-alive pings the platform answers every 25 s without waking the room (the research notes do not say whether Cloudflare counts them), R2 operations (one record per match and the daily export; R2 limits are monthly), the daily cron's Worker time, and the rows of a room's last D1 batch (the deletes of its listing and members are counted, the ledger row is counted as one). Worker requests have the most room of all the limits, so the first of these matters least. The daily cron's D1 rows are counted: after its jobs, the run adds the rows its statements read and wrote, as D1 reports them in each result, to the day's row as spent rows (`worker/src/cron.ts`, `worker/src/d1-budget.ts`), so the export's rows count against the same daily limit as the matches.

## Measured on the local site

Matches on `http://dev:8787` (wrangler dev, 2026-11-22), each on its own test ledger, played by `tests/sim/brake-measure.ts`: the simulated people of the training cycle (`training/cycle/sim/styles.ts`: the base heuristic's cards and one of four betting styles, cautious, caller, aggressive and bluffer), each deciding after the events of a message are shown, as in a browser, with a log-normal think time around a median. Quick play is 2 against 2, paulista; a room has 4 people, paulista, 30 seconds a move. After the match the people stay 5 s on the result and close the page; then the room is made to expire at once (`POST /api/test/rooms/<code>/expire`, local test sites only), as it would 24 hours later, and its expiry writes what the room spent after the swap. The numbers are the room's own count: "match" is the swap, "after" what the expiry wrote, "room" both.

```sh
docker compose run --rm -T -e BASE=http://dev:8787 node node tests/sim/brake-measure.ts --solo 8 --room4 3 --think-ms 3000 --seed 21 --linger-ms 5000 --out .cache/brake-measure/active-3000.json
```

Two runs with the same command. The first (`.cache/brake-measure/think-3000-tail.json`, under the model of a room billed while awake) gave the estimates of every meter but duration. The second (`.cache/brake-measure/active-3000.json`, with the handlers' time) measured duration; its matches were a little shorter, and every other mean came out at or below the first run's.

The room then gained the hold message of milestone 8 (sent by the client only while ads are on). A third, shorter run with the same settings (seed 22, 4 solo matches and 1 room of 4, `.cache/brake-measure/recheck-3000.json`) found the same costs per unit: 5 rows plus 1 per message in every solo match, and the same rows, requests and D1 rows after each match. Every number on this page is in `facts.json` under `worker.brake`, with its method.

| Per match | First run: 8 solo matches | First run: 3 rooms of 4 people |
| --- | --- | --- |
| Hands | from 1 to 14, mean 4.875 | from 4 to 7, mean 5.67 |
| WebSocket messages | from 5 to 24, mean 13 | from 51 to 63, mean 57.33 |
| Durable Object rows written: match, after, room | 18, 8, 26 (room from 18 to 37) | 79, 11, 90 (room from 83 to 97) |
| Durable Object requests (other than messages): match, after, room | 2, 2, 4 | 11.33, 5, 16.33 |
| Worker requests the room saw | 2 | 5 |
| D1 rows written: match, after, room | 14, 12, 26 | 40, 30, 70 |
| D1 rows read: match, after, room | 11, 5, 16 | 29, 14, 43 |

| Per match | Second run: 8 solo matches | Second run: 3 rooms of 4 people |
| --- | --- | --- |
| Hands | from 1 to 6, mean 3.875 | from 3 to 7, mean 5.67 |
| WebSocket messages | from 5 to 14, mean 10 | from 28 to 50, mean 40.67 |
| Durable Object rows written: room | 23 (from 18 to 27) | 70 (from 52 to 82) |
| Durable Object requests and messages (invocations): room | 14 (from 9 to 18) | 55.33 (from 40 to 66) |
| Handlers' time: match, after, room | 204 ms, 59 ms, 263 ms (0.033 GB-s; room from 175 to 314 ms) | 583 ms, 105 ms, 688 ms (0.086 GB-s; room from 510 to 822 ms) |
| Handlers' time per invocation, room | 18.9 ms (from 17.4 to 20.1) | 12.5 ms (from 12.2 to 12.75) |

The handlers' time includes the 10 ms CPU allowance of each invocation, so a room's own work took from about 2.5 to 9 ms per invocation on the local site. The first model counted 95.5 s awake for a solo room (11.94 GB-s) and 223 s for a room of 4 (27.87 GB-s): from 320 to 365 times the handlers' time.

The integration test, whose players answer 300 ms after each state without waiting for the cards to be shown, measured in two runs of 2026-11-22 solo matches with 12 and 6 messages at 17 and 11 rows written (25 and 19 with the room until expiry), and rooms of 4 with 102 and 123 messages at 113 and 134 rows (124 and 145 until expiry). A run with the handlers' clock gave a solo match of 8 messages at 13 rows, 0.16 s of handlers' time, and 0.26 s with its room until expiry.

What the numbers show:

* A solo match writes 5 rows plus one per message, and its room 8 more after it: 13 plus one per message, in all 16 solo rooms of both runs. At the plan's 36 messages that is 49 rows.
* **The plan's row budget holds**: a solo room wrote at most 37 rows with its match against a budget of 60, and a room of 4 at most 145 against 320. `tests/integration/brake.test.ts` keeps checking both, with the expiry included.
* What a room spends after its match is the same in every solo room: 8 rows, 2 requests, 12 D1 rows written, from 55 to 70 ms of handlers' time.
* **Rows written bind, not duration.** A room is billed only while its handlers run, a few milliseconds per move. With the estimates of today (below), D1 rows written allow 1,111 solo matches a day with the 50% reserve <!-- facts.docs: deploy.brake.free.soloPerDay.reserve50 --> and Durable Object rows written 1,153 <!-- facts.docs: deploy.brake.free.doRowsWrittenNextReserve50 -->, and duration would bind first only if each request or message took more than 1.6 s.
* The simulated matches were short: from 3.875 to 4.875 hands and from 10 to 13 messages per solo match, where the plan assumed about 12 hands and 36 messages. Their AIs and betting styles raise often, and a truco accepted up to twelve ends a match in a hand or two. Real people may play longer matches. `worker/dev/brake-table.ts` therefore also prints every number for matches three times as long (the 8 rows after the match do not grow; duration grows with the requests and messages).

## The estimates

`BRAKE_COST_SOLO` and `BRAKE_COST_PER_PERSON` in `wrangler.jsonc` (the same values are the code's fallbacks) are the first run's room means (match and after) rounded up: a solo match reserves 2 Worker requests, 4 Durable Object requests, 13 messages, 26 rows written, 27 D1 rows written and 17 read (the measured 26 and 16, plus the public counters' row each match writes and reads since milestone 7: `LIVE_COUNTER_ROWS` in `brake.ts`); each further person adds 1, 5, 15, 22, 15 and 9 (the difference between the room of 4 and the solo means, divided by 3, rounded up).

Duration is reserved per request and message: 269 ms each (`durationEstimateMs` in `brake.ts`), in GB-s rounded up to a tenth. That is 0.6 GB-s for a solo match (17 requests and messages) and 0.7 GB-s for each further person (20), so a room of 4 reserves 2.7 GB-s. The 269 ms are:

* 19 ms measured (`MEASURED_MS_PER_INVOCATION`): the larger of the two means per invocation, rounded up, the 10 ms CPU allowance included.
* A margin of 250 ms (`DURATION_MARGIN_MS`) for what production adds. On the local site D1, R2 and the room's storage answer in about a millisecond; in production a call to D1 or R2 crosses the network and storage writes are committed to other machines. 250 ms lets every invocation wait for one such round trip across regions, though most invocations (a move, a close) await none: a match's remote calls are its start, its record (R2 and D1) and its expiry. It also covers the time lost when a room hibernates before its next save. It is an allowance, not a measurement: there is no production site yet. The ledger's real spend, measured by the same clock in production, replaces it as matches end.

The margin barely matters for admissions: duration binds before rows written only above 1.6 s per request or message (`brake-table.ts` prints it), six times the 269 ms reserved. `worker/test/brake.test.ts` checks that the estimates in `wrangler.jsonc` are this rule applied to their own requests and messages.

With these estimates (`docker compose run --rm -T node node worker/dev/brake-table.ts`, output in `.cache/brake-measure/table-active.txt`):

* Free mode with the default 50% reserve admits 1,111 solo matches a day <!-- facts.docs: deploy.brake.free.soloPerDay.reserve50 -->, bound by D1 rows written (27 per match since the public counters); Durable Object rows written follow at 1,153. <!-- facts.docs: deploy.brake.free.doRowsWrittenNextReserve50 --> For matches three times as long: 483. <!-- facts: worker.brake.freeSoloMatchesPerDay.threeTimesAsLong.reserve50 -->
* A room of 4 weighs 4.5 solo matches on its heaviest lines (Durable Object requests and duration).
* 1,000 solo matches a day use 27% of the Free D1 rows written <!-- facts.docs: deploy.brake.d1RowsWrittenShare.solo1000 -->, 26% of the Free Durable Object rows written <!-- facts: worker.brake.freeShareAt1000PerDay.doRowsWritten --> and 4.6% of the Free duration limit <!-- facts: worker.brake.freeShareAt1000PerDay.doGbSeconds --> (62% and 12% for matches three times as long <!-- facts: worker.brake.freeShareAt1000PerDay.threeTimesAsLong.doRowsWritten, worker.brake.freeShareAt1000PerDay.threeTimesAsLong.doGbSeconds -->), so they fit Workers Free with the 50% reserve (not when three times as long).
* Workers Paid, 30 days, the other projects at 50%: US$ 5.15 a month at 1,000 solo matches a day and US$ 5.30 at 10,000 (US$ 5.15 and US$ 17.95 for matches three times as long, where duration passes the 400,000 GB-s included and the rounding bills a whole million GB-s).

## Reading the ledger

In production (`$W` as in `DEPLOY.md`):

```sh
$W d1 execute zap --remote --command "SELECT day, matches, settled, refused, s_doreq + s_dows AS do_requests, s_dorows, s_doms / 8000.0 AS gb_s, s_wreq, s_d1w FROM brake_days ORDER BY day DESC LIMIT 14"
```

The real spend of an average match, with its share of its room's expiry and of the refusals, is each `s_*` sum divided by `settled` (quick play and rooms together), over a few days so the expiries of each day's rooms are in. After the first weeks, when it differs much from the estimate, put the new means in `BRAKE_COST_SOLO`. For duration, `gb_s` divided by the requests and messages of the same rows gives the production time per invocation, to compare with the 269 ms the estimate reserves (`s_doms / (s_doreq + s_dows)` in ms). Cloudflare's dashboard shows the account's real duration too: the ledger should stay at or above the Zap's share of it. A day with `refused` above zero turned people away.
