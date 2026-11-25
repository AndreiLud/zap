# Retention

How long Zap keeps each kind of data and what removes it. Field definitions are in `data-dictionary.md`; the reasons are in `privacy-lia.md`. The site states the same periods on the Privacidade page (`locales/legal.*.json`); change both together.

"Deletion" below means the person's own request on the You page (/voce) (`POST /api/me/delete`), which acts at once. "Retention job" means the Worker's scheduled handler (Cron Trigger `0 4 * * *`, daily at 04:00 UTC).

| Data | Where | Kept for | Removed by |
| --- | --- | --- | --- |
| Device secret | Browser, HttpOnly cookie | Up to 400 days from the last human check or recovery (each one sets the cookie again) | The browser; deletion expires the cookie |
| Credential (passed the human check) | Browser, HttpOnly cookie | 2 hours | The browser; deletion expires the cookie |
| Device row: secret hash, pseudonym, adult timestamp, dates, nickname, switches, abandons, block | D1 `devices` | Until deletion, or 12 months without playing (`last_seen`) | Deletion; retention job |
| Recovery code hash | D1 `devices.recovery_hash` | Until the code is used, replaced, or the device row goes | Recovery; a new code; deletion; retention job |
| Links between a person and seats | D1 `match_seats` | As long as the device row | Deletion; retention job, together with the device row |
| Style counters | D1 `profiles` | As long as the device row; none while "Don't adapt to me" is on | Deletion; switching "Don't adapt to me" on (at once); retention job, together with the device row; a recovery adds this browser's rows into the recovered person's and removes them |
| Rating and the other figures of "You against Zap" (history table, best hands) | Not stored: computed in the person's browser from their records each time the page opens. Which matches were the person's is the `match_seats` row above | Not kept | Nothing to remove |
| Group tokens of the daily export | D1 `export_groups` | 30 days from the export date, and never longer than the device row | Retention job; deletion; a recovery moves them to the recovered person (when both had one in the same export, the recovered person's stays) |
| Files imported from the training cycle (no person) | D1 `cycle_imports` | Current only, one row per file | Replaced by the next import |
| The brake's daily usage sums (no person) | D1 `brake_days` | Kept, one row per UTC day | Nothing to delete: no person, room or match in it (`project_docs/brake.md`) |
| Match summary rows (no person) | D1 `matches` | No limit | Not removed |
| Match records (no person) | R2 `zap-events` | No limit | Not removed; they never contained the person |
| Daily job receipts (no person) | R2 `zap-events` `receipts/` | 30 days | The daily job deletes older ones |
| Daily export of linked seats (match ids, seats, weights, switches and a group token per person, no pseudonym) | R2 `zap-events` `exports/` | 7 days; made only once the training cycle exists | The daily job deletes older ones |
| Models, model cards (no person) | R2 `zap-models` `models/`, `cards/` | No limit (a match pinned to an old version can load it again) | Not removed |
| Model manifest, training status (no person) | R2 `zap-models` `manifest.json`, `status/training.json` | Current only | Replaced by the training cycle |
| Copies on the training server (no person) | Maintainer's server | The newest daily export; the per person tables of the newest cycle (`tables/` and `human/` of its work folder: records and decisions with the group tokens of that export, one style reading per group) and `data/<profile>/ab/tables/`, rewritten by each daily A/B check with the newest export's tokens; the cycle's own flag list (`data/<profile>/flags.json`: `<export date>:<group>` refs, reasons and evidence, up to 400 days). The tokens mean nothing there and resolve in D1 for 30 days at most | Every sync deletes older exports; the end of each cycle, ok or failed, and a `build` run on its own delete `tables/` and `human/` (except its layer states) of every older work folder; each A/B check rewrites its tables; the flag list drops entries older than 400 days |
| Reports made by a person | D1 `reports` | 12 months from creation | Deletion of the reporter; retention job |
| Reports about a person | D1 `reports` | 12 months from creation | Retention job; deletion of the target only clears `target` |
| Flags (suspected automation) | D1 `flags`, with the cycle's `ref` | 12 months after review; unreviewed flags stay until reviewed. The `ref` (`<export date>:<group>`, the link from a group token of the cycle to the person) goes 30 days after the review; an unreviewed flag keeps it until it is reviewed | Deletion; retention job (the row, and the `ref` 30 days after review); a recovery moves them; when both have one, an open or confirmed flag wins over a cleared one |
| The training cycle's priors and flags files (no person) | R2 `zap-models` `control/` | Current only | Replaced by the training cycle |
| Open rooms list | D1 `open_rooms` | Until the room expires (24 h after its last use; the listed expiry runs up to 1 h ahead) | The room's alarm; retention job; deletion of the creator, or the retention job removing the creator's device, clears `device` and keeps the row for the others at the table |
| Rooms a device sits in | D1 `room_members` | Until the room expires (refreshed with the listing, so always at or past the room's own expiry; up to 25 h after its last use) | Deletion; recovery moves the rows to the new id; the room's alarm; retention job |
| Room calls not yet delivered | D1 `room_calls` | Until the room answers or is gone (almost always empty) | The room itself, which looks for its own calls at most every 5 minutes while it is used and removes each one it applied; the Worker once the room answers; retention job retries each row and removes it then, or when the room is no longer listed; the room's alarm |
| Room state, including device hashes per seat | Durable Object storage | Until the room closes or 24 hours without use | The room's alarm (`deleteAll`); deletion and recovery remove the device from every room it is in at once (`Room.forget`, `Room.rekey`) |
| Flood block per device | Durable Object storage and `devices.blocked_until` | 15 minutes | The room's alarm; overwritten on the next block |
| Turnstile token | Memory only | Single use, 300 seconds | Never stored |
| Rate limit key (HMAC of the IP with a daily salt) | Cloudflare rate limiter counters | The limiter's window (60 seconds) | Cloudflare; never written by Zap |
| Worker logs | Cloudflare | Not collected (observability off) | Not applicable |
| D1 automatic backups (Time Travel) | Cloudflare | 7 days on Workers Free, 30 days on Workers Paid; the site says "within 30 days", true on either plan | Cloudflare |
| Language, adult flag, notice version, the Play page's last choice, display settings (four-color deck, sound, single key shortcuts, mute), first match hints already shown; the ads answer, only while ads are on | Browser localStorage | Until the person clears site data | The person; the adult flag and the notice version also go with deletion on the You page (/voce), in that browser |
| Last room code; the brake's last refusal (used until its reset, one hour at most); the time of the last ad break, only while ads are on | Browser sessionStorage | Until the tab closes | The browser |
| Copies of the person's match records and their pseudonym, cached by "You against Zap" | Browser IndexedDB `zap-you` | Until one of the removals; written only by that page | Deletion on the You page (/voce), in that browser; the page's "Esquecer as partidas guardadas neste aparelho"; the page itself when the browser now belongs to another pseudonym; the person clearing the site's data |
| Published open data releases | GitHub Releases | Permanent | Cannot be withdrawn; people who delete or opt out leave future releases |
| Public report and counters (aggregates) | R2 `zap-public` | No limit | Not removed; no person in them |
| Public counters of the data page (no person) | D1 `live_counts` | Kept, one row | Nothing to delete: no person, room or match in it |

## Notes

* Deletion first tells every room the device is in (found through `room_members` and `open_rooms`): each closes the device's connections, drops it from its seats (an AI plays the seat during a match; a lobby seat empties; a lobby the person owned closes; a room left with no person closes) and from the match records it has not written yet. A room that does not answer is called once more; if it still does not, nothing is deleted and the person sees "try again" (every call is safe to repeat). Then one D1 transaction removes the device row, its pseudonym, its seat links, the reports it made, its flags and its room memberships, clears it as the creator of open rooms and as the target of reports about it. Nothing in R2 needs rewriting, because records never held the person.
* A room the device joined while the deletion was running (after the list was read) shows up in that transaction and is told right after it. Only if that room cannot be reached twice in a row is the deleted id kept in `room_calls`, until the room answers or is gone. A room in use looks for its own waiting calls at most every 5 minutes, so it lets go of the id within minutes of its next use; the retention job tries every waiting call once a day as well.
* Room memberships last as long as the room: a person who left keeps their seat (an AI plays it) through the others' rematches, until the room's owner frees it between matches, and their `room_members` row is carried along each time the room rewrites its listing, so a deletion or a recovery a day later still reaches that room.
* Recovery moves D1 first, then tells the rooms. A room that does not answer twice gets the call through `room_calls` (the room applies it itself within minutes of its next use, or the retention job delivers it). A match that ends in between keeps its seat links waiting in the room (up to 5 more tries, a minute apart) until the room learns the new id, so it is not lost from the person's history. A call that lands while the room is writing such a match is taken into that same write.
* The retention job treats a device unseen for 12 months like a deletion, also in the rooms: a person who left a match keeps the seat through the others' rematches without being seen, so before the rows go, each live room that still holds the device gets a call in `room_calls`, and the same job delivers it right after. A room the device created stays listed with no creator for the others at the table.
* Deletion also removes the person's style counters and their group tokens in `export_groups`, in the same transaction. After that, a flag the cycle raises on one of their old groups finds nobody (the receipt lists it as `unresolved`), and the exports already written keep only random tokens that nothing maps back.
* After deletion, the person's former matches stay in R2 and can still be used for training and the report, with no link to anyone. They no longer qualify for open data releases, which only include seats still linked in D1 and not opted out.
* Cookies may outlive the D1 row: a browser that comes back after 12 months without playing, or that kept the cookie of a device whose data was deleted or moved to another browser, gets a new device secret and a new, empty row on its next human check. The old id never comes back, so nothing still kept under it (a room that missed a call, a match waiting in a room) can reach the new row.
* The rating is not a stored item. "You against Zap" computes it in the person's browser from the records each time the page opens, and nothing it computes leaves the browser. A public ranking, when it exists, will be the first place a rating is stored on the server, only for the people who join it; it will get its own row here then.
* The device cache of "You against Zap" lives in one browser. A deletion removes it in the browser where it happens. A browser whose link to the person moved elsewhere (a recovery code used in another browser) keeps its copies until the page opens there with another pseudonym and clears them, "Esquecer" is pressed there, or the site's data is cleared. The copies hold only what the person's own download holds.
* The texts say "within 30 days" for backups, which holds on Workers Free (7 days) and Workers Paid (30 days). If the plan or Cloudflare's window changes beyond 30 days, update this table, `privacy-lia.md`, the Privacidade page and the You page (/voce) texts.

## The daily job's D1 budget

Workers Free allows 50 D1 queries per Worker invocation, a `db.batch()` call counting as one ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), read 2026-11-23). <!-- facts.docs: deploy.cf.free.d1QueriesPerInvocation --> The daily job counts more strictly: every statement it sends, each statement inside a batch included, and the export stops before the run passes 45 (`RUN_STATEMENT_BUDGET` in `worker/src/cycle-jobs.ts`): the file is then written with `partial: true` and the cycle treats it as missing for that day. The export never builds rows in the Worker: D1 returns them as JSON text, 5,000 rows per statement, with a keyset on `(match_id, seat)`.

Measured by `worker/test/cycle-jobs.test.ts` on node:sqlite with the real migrations (whole daily run, one person per 50 linked seats; "same files": the cycle's control files are the ones already imported; "new files": both changed and the flag finds its person, the most a run can need):

| Linked seats | Same files: statements | New files: statements | Export |
| --- | --- | --- | --- |
| 100 | 23 | 28 | complete |
| 10,000 | 24 | 29 | complete |
| 100,000 | 42 | 45 | complete with the same files; partial (90,000 rows) on a day both files change |

The test prints these numbers on its line `daily run, D1 statements`; the run of 2026-11-23 is kept in `facts.json` under `docs`, keys `retention.dailyRun.statements.seats100.same` to `retention.dailyRun.statements.seats100000.new`, `retention.dailyRun.exportRows.seats100000.new` and `retention.dailyRun.retentionStatements`.

The run is retention 17 statements, waiting room calls 1 (plus one per call still waiting), flags 1 (5 when the file changed and a flag applies), priors 1 (2 when it changed), and the export 2 plus one per 5,000 seats. Past about 100,000 linked seats the export no longer fits one invocation on Workers Free; until it is split, the cycle works with the last complete export.
