# Data dictionary

What Zap stores, where, and what each field means. The legal side (purposes, bases, balancing) is in `privacy-lia.md`; how long each item is kept is in `retention.md`.

Zap separates a person from the game data in three pieces:

1. A random 128-bit secret in an HttpOnly cookie on the person's browser. The server keeps only its hash (`devices.id` in D1).
2. A random internal pseudonym (128-bit, hex) per browser, kept in D1. The person sees it on the You page (/voce) and in the download, and "You against Zap" keeps a copy in that browser (`zap-you`, below).
3. Game data carries only the match id and the seat number.

On the server, the link between a pseudonym and a seat lives only in D1 (`match_seats`); the person's own browser may hold a copy in the `zap-you` cache, which a deletion in that browser removes. Deleting a person removes every D1 row that links them to anything; the match records in R2 never contained them, so nothing there is rewritten.

The types and the checks live in code: `shared/match-record.ts` (record types, `buildMatchRecord`, `validateMatchRecord`), `worker/migrations/*.sql` (D1 tables), `engine/src/` (actions, cards, replay). If this file and the code disagree, the code wins and this file gets fixed.

## Match record (R2)

One JSON file per finished match, written by the room when the match ends, in the bucket `zap-events` (binding `EVENTS`) at `matches/v1/YYYY/MM/DD/<matchId>.json`, where the date is the UTC date of the end. Unfinished matches are not written.

The rules engine is deterministic: the configuration, the seed and the action log are enough to rebuild every state of the match, including what each seat saw at each decision. The record therefore stores only those, plus what cannot be rebuilt (timing, automatic moves, seat kinds, the AI's estimates).

Schema `zap-match/2` since milestone 6. Records written before keep `zap-match/1`: the same fields without `partnerVersion`, `arm`, `test` and `seats[j].aiVersion`, with one version for every AI seat. Both stay valid (`validateMatchRecord`), and `normalizeRecord` (`shared/match-record.ts`) reads a `/1` record as `/2` with `partnerVersion` equal to `aiVersion`, `arm` null, `test` false and every AI seat on `aiVersion`. The key keeps `matches/v1/...` (the `v1` there is the key layout).

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"zap-match/2"` | Format name and version. A change that breaks readers gets a new version. |
| `engine` | integer, `1` | Version of the rules engine needed to replay the log. |
| `matchId` | UUID string | Random id of the match, also the file name. It says nothing about the room or the people in it. |
| `startedAt` | integer, ms since 1970 (UTC) | When the match started. |
| `endedAt` | integer, ms since 1970 (UTC) | When the match ended. |
| `kind` | `"solo2"`, `"solo1"`, `"friends"`, `"humans"`, `"mixed"` | `solo2` and `solo1`: quick play, one person with AIs, 2 against 2 or 1 against 1. `friends`: a room where two people are partners and AIs fill the other seats. `humans`: every seat is a person. `mixed`: any other room with people. |
| `turnSeconds` | `15`, `30`, `60` or `null` | Seconds per move. `null` means no limit, only allowed when every seat is a person. |
| `aiVersion` | string, e.g. `"v1"` | The model version on the AI seats that face people (and on every AI seat outside a test). `"heuristic"` when the tuned heuristic played. Fixed at the start of the match. D1 `matches.ai_version` keeps this value. |
| `partnerVersion` | string | The version on the AI seats whose partner was a person at the start, and of the AI that plays for a person. Equals `aiVersion` outside a test of a new version (`project_docs/ai.md`, "Serving"). |
| `arm` | `"candidate"`, `"control"` or `null` | Quick play during a test: `candidate` (the new version faces the person, the previous one is the partner) or `control` (the previous version everywhere). `null` for every other match. `control` requires `partnerVersion` equal to `aiVersion`; `candidate` requires them to differ. |
| `test` | boolean | `true` only for records written by a local test site (Worker var `TEST_RECORDS`). The training cycle refuses such a record in production. |
| `config` | object | The engine's `MatchConfig`, below. |
| `seed` | 64 hex characters | 256-bit match seed from a cryptographic generator. The dealer of the first hand, every shuffle and every 25% signal draw derive from it. |
| `log` | array of integers | Every action in order, each as `seat * 16 + action`. |
| `moves` | array of objects, same length as `log` | Per action: `ms`, `auto`, `winProb`, below. |
| `seats` | array of objects, one per seat | `seat`, `kind`, `verified`, `persona`, below. |
| `abandoned` | array of seat numbers | Seats whose person abandoned the match (away more than 120 s, or 3 timeouts in a row; not counted when everyone dropped at once). |
| `result` | object | `winner` (team 0 or 1), `score` (final points `[team 0, team 1]`), `games` (games won `[team 0, team 1]`, for best of three). |

`config` (`MatchConfig` in `engine/src/config.ts`):

| Field | Values | Meaning |
| --- | --- | --- |
| `variant` | `"paulista"`, `"mineiro"` | Rules variant. |
| `players` | `2`, `4` | 1 against 1 or 2 against 2. |
| `options.ladder` | `"standard"`, `"mineiro8"` | Mineiro only: raises 2, 4, 6, 10, 12 or 2, 4, 8, 10, 12. |
| `options.raiseAnyTime` | boolean | Truco can be called at any moment, not only on your own turn. |
| `options.bestOf` | `1`, `3` | One game of 12 points, or best of three games. |
| `options.onzeSeesPartner` | boolean | In the mão de onze (or de dez), the team on the threshold sees the partner's cards. |
| `options.onzeTieToOpponents` | boolean | A mão de onze with all three rounds tied goes to the other team. |
| `options.ironHand` | `"blind"`, `"normal"` | Both teams on the threshold: face down to everyone, or a regular hand. |
| `options.faceDownFirstRound` | boolean | A face-down card is allowed in the first round, except for the player who opens. |
| `options.allTieToMao` | boolean | Three tied rounds give the hand to the team of the "mão". |
| `options.signals` | `"secret"`, `"p25"`, `"all"` | Who sees partner signals besides the partner: nobody, each opponent with a 25% chance, or everyone. |

`moves[i]`, aligned with `log[i]`:

| Field | Type | Meaning |
| --- | --- | --- |
| `ms` | integer or `null` | Time the person took for this decision, in ms, from the moment the decision became theirs. Pauses for reconnection or ads are not counted (an ad between quick play hands holds the clock; past 150 s the rest of the pause counts). `null` for AI seats and for automatic moves. |
| `auto` | boolean | The move was made by the AI for a person (time ran out, the person was away, or the seat was abandoned). These moves are left out of the human data. |
| `winProb` | number in [0, 1] or `null` | For AI decisions: the AI's estimate of its team's chance of winning the match at that moment. `null` for people. |

`seats[j]`:

| Field | Type | Meaning |
| --- | --- | --- |
| `seat` | integer | Seat number, in play order. Teams are `seat % 2`. |
| `kind` | `"human"`, `"ai"` | Who sat there when the match started. A person's seat stays `"human"` even when the AI played some moves for them (see `moves[i].auto`). |
| `verified` | boolean | The person had passed the human check in the last 2 hours, had not used up the 10 matches that check allows, and was not flagged when the match started. Someone carried into a match by another person's start after their 10 matches loses it (the room clears it as soon as D1 answers the count). Always `false` for AIs. |
| `persona` | `"otavio"`, `"bento"`, `"lia"`, `"ravi"`, `"iara"`, `"zap"` or `null` | The AI character in that seat; `null` for people. |
| `aiVersion` | string or `null` | The model version that played this AI seat: `partnerVersion` when the table has four seats and the seat's partner (`seat ^ 2`) is a person, `aiVersion` otherwise. `null` for people. |

Never inside a record: device ids, pseudonyms, nicknames, IP addresses, cookies, room codes, recovery codes or their hashes. `validateMatchRecord` checks the structure and replays the log, which must reach the stated `result`.

### Actions and cards

An action is a small integer (`engine/src/engine.ts`):

| Code | Action |
| --- | --- |
| 0, 1, 2 | Play the card in hand slot 0, 1 or 2 face up. Slots are the order of the deal; a played slot stays empty. |
| 3, 4, 5 | Play the card in slot 0, 1 or 2 face down (worth nothing). |
| 6 | Call truco, or raise the bet to the next step. |
| 7 | Accept the bet, or play the mão de onze (de dez). |
| 8 | Run from the bet, or from the mão de onze (de dez). |
| 9 to 14 | Signal to the partner "I have": zap, copas, espadilha, pica-fumo, a three, nothing. A signal may be a lie. |

A log entry `e` decodes as `seat = e >> 4` and `action = e & 15`.

A card id is `rank * 4 + suit`. Ranks, weakest first: 4, 5, 6, 7, Q, J, K, A, 2, 3 (0 to 9). Suits: diamonds 0, spades 1, hearts 2, clubs 3. Manilhas follow `project_docs/rules.md`.

## Training files (R2)

Written by the training cycle on the maintainer's server or by the Worker's daily job, in the formats of `shared/cycle-formats.ts` (every object has exactly its keys). None of them holds a device id, a pseudonym, a nickname, an IP address or a room code.

| Bucket and key | Format | Written by | What |
| --- | --- | --- | --- |
| `zap-models` `manifest.json` | `zap-manifest/1` | the cycle (init, publish, A/B window, rollback) | The current version, the previous one during a test (`control`, `controlShare` from 0 to 0.5, `controlUntil`), and one entry per published version: `sha256`, `bytes`, `arch`, `features`, `inputs`, `hidden`, `adapt` (the safety net, only for features v2), `personas` (knobs calibrated for that model), `createdAt`. Entries are never removed. |
| `zap-models` `models/vN.zapw` | ZAPW, int8 (`ai/src/mlp.ts`) | the cycle | The model of version N, at most 2 MB. Never deleted. |
| `zap-models` `cards/vN.json` | `zap-card/1` | the cycle | Model card: parent version, cycle id, result (`bootstrap`, `promoted`, `rejected`, `rolled-back`), the training command and seeds, data counts and the SHA-256 of the records used (counts of people only from 20 on), the gate result, the characters' numbers (measured again on fresh deals of the cycle), the twin comparison (with the seed floor of this cycle or of the latest one that measured it, `seedFloorCycle`, and `seedNoise`, how far the floors measured so far sit from 0.5) and the A/B result. Every candidate that reaches the gate gets a number and a card, promoted or not. |
| `zap-models` `status/training.json` | `zap-status/1` | the cycle and its scheduler | State (`ok`, `running`, `failed`), step, start, end, last update and last promotion of the training cycle, with a plain message of at most 500 characters and no personal data. The Worker's daily job reads it for the training alert. |
| `zap-models` `control/priors.json`, `control/flags.json` | `zap-priors/1`, `zap-flags/1` | the cycle | Population priors for "How Zap reads you", and the automation flags for the daily import (see the cycle's documentation). |
| `zap-public` `summary.json` | `zap-summary/2` (`zap-summary/1` before milestone 7) | the cycle | Aggregates for the data page: a number built from people only for a group of at least 20 people. Fields in "The data page's public answers" below. |
| `zap-events` `receipts/YYYY-MM-DD.json` | `zap-receipt/1` | the Worker's daily job | One per day: the status of each daily job (`retention`, `calls`, `flags`, `priors`, `export`, `alert`), with counts, the SHA-256 of the files imported or written, and whether the training alert sent an email and why (`failed`, `stale`, `missing`). Errors are one line of at most 200 characters. |
| `zap-events` `exports/YYYY-MM-DD.json` | `zap-export/1` | the Worker's daily job | One per day while the cycle exists (its `manifest.json` is in `zap-models`): one row per linked seat in D1 `match_seats`, and the open reports. No pseudonym, device id, nickname, room code or IP. Kept 7 days. Fields below. |

### Daily export (`exports/YYYY-MM-DD.json`)

Built by D1 itself in the daily job (`worker/src/cycle-jobs.ts`), so no row passes through the Worker as an object: `{schema, date, createdAt, partial, rows, reports}`. `date` is the UTC date of the run and also the key. `partial` is true when the run's D1 budget (45 statements, `retention.md`) cut the rows or the reports short; the cycle treats a partial export as missing.

`rows[i]`, one per D1 `match_seats` row:

| Field | Type | Meaning |
| --- | --- | --- |
| `matchId` | UUID | The match, as in its record. |
| `seat` | integer from 0 to 3 | The seat. |
| `weight` | number from 0 to 1, 3 decimals | How much the seat counts in training: 0 while the person has a flag (`devices.flagged`); otherwise `v * (1 - min(0.5, abandons / max(10, seats)))`, with `v` 1 for a seat with the verified seal and 0.5 without it, `abandons` the person's abandoned matches and `seats` the person's linked seats. |
| `flagged` | boolean | The person has an open or confirmed flag. |
| `openDataOptOut` | boolean | "Fora dos dados abertos" is on now. |
| `noAdapt` | boolean | "Don't adapt to me" is on now. |
| `group` | 16 hex characters | A random token per person, new in every export and the same for all of that person's rows in this file. It lets the cycle cap one person at 2% of the data and point a flag at a person without knowing who they are. Only D1 `export_groups` maps it back, for 30 days. The token itself carries nothing from one export to the next, but the rows of two exports share their `matchId` and `seat` (and reports their `id`), so the training server can follow the same person's seats from one export to the next; what it never learns is who the person is. |

`reports[i]`, one per open report (newest 10,000): `id` (`reports.id`), `day` (UTC date the report was made), `reason`, `matchId` (or null), `seat`, and `group`: the reported person's group in this export, or null for an AI seat, a person with no linked seat, or one who deleted their data. The reporter is never in the file.

A receipt's `flags` job lists each ref of `control/flags.json` once, as `applied` (the person's flag holds this ref and waits for review), `ignored` (the person already had an open or confirmed flag, or one cleared less than 15 days before, or less than 90 days before for the same reason), `unresolved` (no person: the group expired or the person deleted their data) or `reviewed` (confirmed or cleared). The import runs only when the file changed; a day with the same file reads `skipped` with empty lists.

## Per-decision table (derived)

Training, the data page and the open data work on one row per decision. These rows are not stored in R2: they are rebuilt by replaying each record with the engine (`replay`, then `observe` for the acting seat before each action). The columns:

| Column | Source | Meaning |
| --- | --- | --- |
| `match` | `matchId` | The match. |
| `hand` | replay | Hand number inside the match, from 0. |
| `decision` | index in `log` | Decision number inside the match, from 0. |
| `seat` | `log[i] >> 4` | Who decided. |
| `team` | `seat % 2` | The seat's team. |
| `mode` | `config.players` | `1x1` (2 players) or `2x2` (4 players). |
| `variant` | `config.variant` | Paulista or mineiro. |
| `options` | `config.options` | The room options, one column each. |
| `match_kind` | `kind` | solo2, solo1, friends, humans or mixed. |
| `decider` | `seats[seat]` | `human` (with `verified`) or `ai` (with `persona` and `aiVersion`). |
| `saw` | `observe(state, seat)` | What that seat could see: own cards by slot, cards played in each round, vira and manilha, hand kind (normal, onze, ferro), phase, bet value and step, who raised last, the partner's cards in a mão de onze when the options allow it, and the signals this seat saw. Never another seat's hidden cards. |
| `legal` | same observation | The legal actions, as a bit mask and as a list. |
| `forced` | derived | Only one legal action. These rows are left out of the human behaviour model. |
| `action` | `log[i] & 15` | The chosen action (table above). |
| `decision_ms` | `moves[i].ms` | Decision time in ms; `null` for AIs and automatic moves. |
| `auto` | `moves[i].auto` | The AI moved for a person. |
| `score` | observation | Points and games for both teams before the decision. |
| `win_prob` | `moves[i].winProb` | AI rows only: the AI's estimated chance of winning the match. |

A per-hand table can be rebuilt the same way: dealer, vira, every seat's three cards, rounds, value, who ran and the points scored.

## D1 tables

D1 is the only place that links a person to matches. Every table and column, after migrations `0001_init.sql`, `0002_room_mode.sql`, `0003_privacy.sql`, `0004_room_members.sql`, `0005_room_calls.sql`, `0006_cycle.sql`, `0007_brake.sql` and `0008_live.sql`:

### `devices`

One row per browser that has started a session.

| Column | Meaning |
| --- | --- |
| `id` | Primary key. SHA-256 of the cookie secret (`zap-device:` + secret). The secret itself is never stored. After a recovery, it becomes the hash of the new secret. An id whose row is gone (deleted, moved by a recovery, removed after 12 months) is never written again: a browser that still has its cookie gets a new secret at its next human check. |
| `created_at` | When the row was created (ms). |
| `verified_at` | Last time the human check passed. |
| `matches_since_verify` | Matches started since that check; a new check is needed after 10. |
| `flagged` | 1 when the browser is marked for suspected automation (out of training and, provisionally, the ranking). |
| `blocked_until` | End of a 15 minute block after flooding (ms), or 0. |
| `pseudonym` | Random 128-bit hex, unique, set at the first session. Shown to the person on the You page (/voce) and in the download, never anywhere else. "You against Zap" keeps a copy in the person's own browser, to know whose records its cache holds ("In the browser" below). |
| `adult_at` | When the person declared being 18 or older (ms). The birth year is never sent. |
| `last_seen` | Last session or match (ms). Drives the 12 month deletion. |
| `nickname` | Filtered nickname (2 to 20 letters, digits and single spaces), or null. |
| `nickname_hidden` | 1 after a nickname report, until review; rooms then show "Jogador N" / "Player N". |
| `open_data_opt_out` | 1 when the person switched on "Fora dos dados abertos". |
| `no_adapt` | 1 when the person switched on "Don't adapt to me". |
| `abandons` | Number of abandoned matches. |
| `recovery_hash` | Hash of the current recovery code, or null. Cleared when the code is used. |

### `open_rooms`

Rooms that are still open, so the Worker can refuse unknown codes without waking a room and can cap rooms with friends at 3 per browser.

| Column | Meaning |
| --- | --- |
| `code` | Room code (5 characters). |
| `device` | `devices.id` of the creator; empty after the creator deleted their data or the retention job removed their device (the room stays reachable for the others). |
| `created_at`, `expires_at` | Creation and expiry. The room keeps `expires_at` at or up to 1 h after its own expiry (24 h after the last use), and deletes the row when it expires. |
| `mode` | `solo` or `room`. Only `room` counts toward the cap. |

### `room_members`

The rooms each device sits in, so a deletion or a recovery reaches every room that holds the device id. Primary key `(code, device)`, index on `device`. A row is written before the room gives the seat, and only while `devices` has the device, so a deleted or moved id never comes back here.

| Column | Meaning |
| --- | --- |
| `code` | Room code. |
| `device` | `devices.id` of the person seated there (also while an AI keeps the seat for them). |
| `expires_at` | Never before the room's own expiry: set on a join or a match start to at least 25 h ahead, and carried along with `open_rooms.expires_at` for everyone seated each time the room rewrites its listing. It only moves forward. The room deletes its rows when it expires; leftovers go with the retention job. |

### `room_calls`

Calls to a room that did not get through when a person deleted their data (`Room.forget`) or recovered it in another browser (`Room.rekey`), and the calls the retention job queues for live rooms that still hold a device it removes. Empty almost always: a call is tried twice at once, and a deletion whose first calls fail deletes nothing and asks the person to try again. Primary key `(code, device)`, index on `to_device`.

| Column | Meaning |
| --- | --- |
| `code` | Room code. |
| `device` | The id the room must let go of: a recovered device's former id; when a room joined during the deletion itself could not be told, the deleted id; or a device the retention job removed. |
| `to_device` | After a recovery, the new `devices.id`; NULL after a deletion. A later recovery moves it to the newest id; a deletion of that id turns the call into a forget and removes the row once the room let go; so does the retention job when it removes that id. A delivered call removes its row only while `to_device` is still the target it was delivered with, so a newer recovery written meanwhile stays queued. |
| `created_at` | When the call was queued. The room looks for its own rows at most every 5 minutes while it is used, applies them and removes them. The daily retention job tries every row again and removes it once the room answers; a row whose room is no longer listed goes with the same job, and the room's own expiry removes its rows. |

### `matches`

One row per finished match, with no person in it.

| Column | Meaning |
| --- | --- |
| `id` | `matchId`. |
| `started_at`, `ended_at` | As in the record. |
| `kind`, `variant`, `players`, `ai_version` | As in the record. |
| `record_key` | Path of the record in R2. |

### `match_seats`

The only link between a person and a seat. Primary key `(match_id, seat)`, index on `pseudonym`.

| Column | Meaning |
| --- | --- |
| `match_id` | `matches.id`. |
| `seat` | Seat number. |
| `pseudonym` | `devices.pseudonym` of the person in that seat. |
| `verified` | Whether the seat had the verified badge. |

### `reports`

| Column | Meaning |
| --- | --- |
| `id` | Sequential id. |
| `created_at` | When the report was made. |
| `match_id`, `room_code`, `seat` | Where it happened. |
| `reason` | `nickname`, `phrases`, `cheating` or `other`. No free text. |
| `reporter` | Pseudonym of the person who reported. |
| `target` | Pseudonym of the reported person; null for an AI seat, and set to null when the target deletes their data. |
| `status` | `open` until reviewed. |

### `flags`

| Column | Meaning |
| --- | --- |
| `pseudonym` | Primary key. The flagged person. |
| `reason` | Which signal of automation triggered it: from the training cycle `regular-times`, `around-the-clock`, `volume` or `identical-sequences`. |
| `created_at`, `reviewed_at` | When it was raised and reviewed. |
| `decision` | The review's outcome: `confirmed` or `cleared`; null while open. |
| `ref` | For a flag from the training cycle, `<export date>:<group>`: the export and the group token the cycle saw, unique. Later reviews find the row by it, so they need no `export_groups` row. Null for a flag raised by hand, and once 30 days have passed since the review (the retention job clears it). |

A flag from the cycle arrives through `control/flags.json` and the daily import: the import resolves `ref` to a person through `export_groups` inside D1, writes the row and sets `devices.flagged` to 1, which takes the person's seats out of training at once (weight 0 in the export) and keeps the verified seal off. `cleared` sets `devices.flagged` back to 0; a later flag for the same person replaces a cleared row only when it arrives at least 15 days after the clear, or 90 days for the same reason (an earlier one is `ignored`). A recovery moves this browser's flag to the recovered person; when both have one, an open or confirmed flag wins over a cleared one, and between two of the same kind the recovered person's stays. Rules in `project_docs/moderation.md`.

### `profiles`

The person's style counters, one row per person and rules segment (`paulista-2`, `paulista-4`, `mineiro-2`, `mineiro-4`). The room adds one finished match to them in the same D1 batch that links the seat, and only then: a repeated write counts once. Nothing is added for a person with "Don't adapt to me" on, and switching it on deletes the rows at once. They feed "How Zap reads you" (below) and nothing else for now. Counting rules in `shared/profile.ts`: only the person's own decisions, and a hand in which the AI played for them counts nowhere for them. Primary key `(pseudonym, segment)`.

| Column | Meaning |
| --- | --- |
| `pseudonym` | `devices.pseudonym`. |
| `segment` | Variant and number of players. |
| `matches` | Matches counted. |
| `decisions` | The person's decisions with more than one legal action. |
| `h`, `k` | Normal hands played, and hands in which the person called truco or raised without answering a call. |
| `u`, `a`, `x` | Bets the person answered by running, accepting, or raising back. |
| `s`, `q` | Sum of the strength (0 to 1) of the cards the person showed face up in hands where they raised, and how many such cards. |
| `v`, `w` | Cards played face down, and cards that could have been played face down. |
| `bc`, `br` | Chances to call truco with a weak hand (the base heuristic's estimate below 1/3), and calls at them. |
| `g`, `gt` | Signals sent to the partner, and true signals. |
| `tn`, `tl`, `tl2` | Decision times: how many, the sum of their natural logarithms (ms, clamped from 100 ms to 120 s), and the sum of the squares of those logarithms. |
| `updated_at` | End of the last match counted. |

### `export_groups`

The random group token of each person in each daily export: the only way a flag from the training cycle finds its person. Primary key `(export_date, grp)`, unique `(export_date, pseudonym)`, index on `pseudonym`.

| Column | Meaning |
| --- | --- |
| `export_date` | The export's UTC date. |
| `grp` | 16 hex characters from D1's random generator. |
| `pseudonym` | The person. |

### `cycle_imports`

The last file imported from the training cycle, per name. No person in it.

| Column | Meaning |
| --- | --- |
| `name` | `priors` or `flags`. |
| `sha256` | SHA-256 of the imported file; the daily job imports again only when it changes. |
| `body` | The validated `control/priors.json` (`zap-priors/1`); null for `flags`. |
| `imported_at` | When it was imported. |

### "How Zap reads you" (`GET /api/me/reading`)

Computed on each request from the person's `profiles` rows (summed over the segments) and the priors in `cycle_imports`, or the bundled `shared/profile-priors-default.json` before any import. Nothing is stored. Format `zap-reading/1` (`shared/cycle-formats.ts`): `noAdapt`, `matches`, `decisions`, `priors` (`selfplay` or `people`), and for each of the 8 numbers (`raise` K/H, `run`, `accept` and `reraise` over U+A+X, `shown` S/Q, `cover` V/W, `bluff` BR/BC, `signalTruth` GT/G) the observations `n`, the population value, where that value comes from (`source`: `people` when the priors fitted that number on people, `selfplay` otherwise; the page says which), and the value with its 80% interval only after at least 10 observations and when the interval is narrower than 30 points; the decision time the same way (10 timed decisions, interval narrower than 30% of the median). The population value of `raise`, `run`, `accept`, `reraise`, `shown`, `cover` and `bluff` is the priors' value of each segment (`segments`, and `readingSegments` for bluff) weighted by the person's own observations in that segment, because these numbers differ from about two to four times between 1 against 1 and 2 against 2; `signalTruth` exists only at 2 against 2 and reads the pooled value. One shown card counts as about 3.6 yes or no answers in the posterior (its variance in self-play is 0.07, against 0.25 for a yes or no answer); `n` stays the number of cards. Math in `shared/profile.ts` (`readProfile`).

### `brake_days`

The brake's ledger (`worker/src/brake.ts`, `project_docs/brake.md`): one row per UTC day with what the matches reserved before they started and what the rooms really spent. No person in it, and no room code or match id. Kept: one row a day, with no retention job. Primary key `day` (`WITHOUT ROWID`).

| Column | Meaning |
| --- | --- |
| `day` | The UTC date, `YYYY-MM-DD`. On a local test site only, `t-<16 hex>` for a test's own ledger. |
| `matches` | Matches the brake admitted that day (a refund takes one back). |
| `settled` | Of those, matches whose reservation the room swapped for the real spend (at the match's end, or at its room's expiry when nobody finished it). |
| `refused` | Starts the brake refused (quick play, a room's start, a rematch). |
| `ticket` | 16 hex characters of the last admission, which ties the starter's allowance to it in the same batch. |
| `r_*` | Reservations still open: the typical cost of matches that have not ended. |
| `s_*` | Real spend: each match's swap, what each room spent after its last swap (written when it expires), and what each refusal cost (its request or message and its row). |
| `*_wreq`, `*_doreq`, `*_dows` | Worker requests, Durable Object requests other than WebSocket messages, incoming WebSocket messages. |
| `*_dorows`, `*_doms` | Durable Object rows written, and the time the room's handlers ran in ms, with 10 ms of CPU allowance per invocation (8,000 ms make one GB-s at 128 MB; `worker/src/brake.ts` BusyClock). |
| `*_d1w`, `*_d1r` | D1 rows written and read. |
| `updated_at` | Last change. |

### `live_counts`

The public counters of the data page (`GET /api/live`, below). Migration `0008_live.sql`. One row, with no person, room or match in it. Kept: the one row, with no retention job.

| Column | Meaning |
| --- | --- |
| `id` | Always 1 (`CHECK (id = 1)`). |
| `matches` | Finished matches with at least one person, every kind, since launch. The migration starts it at the count of rows already in `matches`. |
| `decisions` | Moves people made themselves in those matches: moves whose `ms` is not null, so neither AI moves nor the moves the AI made for a person. It starts at 0: the moves of matches finished before the migration are in R2, not in D1. |
| `updated_at` | End of the last match counted (ms). |

A finished match adds itself in the same D1 batch that writes its `matches` row (`liveCountStatement` in `worker/src/privacy.ts`), and only while D1 has no row for that match yet, so a batch tried again never counts twice. The room passes `humanDecisions`, the number of its people's own moves; a match saved for a later try before this table existed counts 0 moves.

### Rating and history ("You against Zap")

No table. The page `/voce-contra-o-zap` (`web/src/you-vs-zap/`) computes the history, the rating (OpenSkill, Weng-Lin with Bradley-Terry full pairing, one rating for 1 against 1 and one for 2 against 2, the AI seats as fixed anchors), the list of abandoned matches and the best hands in the person's browser, from the person's own records (`GET /api/me/data` and `GET /api/me/matches/:id`), the characters' measured levels shipped with the page and the public summary. Nothing it computes is sent back or stored on the server; only the records it read stay in the browser (`zap-you` below). `shared/rating.ts` holds the anchors and has no browser code, so a public ranking could reuse it on the server one day (it would be opt in, `privacy-lia.md` section 7).

## The data page's public answers

Two answers without a credential and without anything about a person, read by the data page and the Play page (`worker/src/public-data.ts`, routed in `worker/src/cf/index.ts`). Each is limited per IP key like the other routes without a credential (`RL_API`) and cached per Cloudflare location with the Cache API for its period, so D1 and R2 are read at most once per period there; a local test site (`TEST_RECORDS`) skips the cache.

### `GET /api/live` (`zap-live/1`)

Answer of `liveAnswer`, `cache-control: public, max-age=60`. Any failure answers `503 { "error": "unavailable" }`.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"zap-live/1"` | Format name and version. |
| `at` | integer, ms since 1970 (UTC) | When this answer was made. |
| `matches` | integer | `live_counts.matches`: finished matches with at least one person, every kind, since launch. 0 before the row exists. |
| `decisions` | integer | `live_counts.decisions`: moves people made themselves in those matches. |
| `current` | string | The version on the AI seats now: the manifest's `current` (`zap-models` `manifest.json`), the bundled model's label before the first manifest, or `"heuristic"` when the Worker var `AI_MODE` is `heuristic` (`servedNow`). |
| `adapt` | boolean | The in-match reading is on for that version: `AI_ADAPT` is `on`, the model has features v2 and a valid safety net (`ai/src/safety.ts`), the rooms' own rule. |
| `humansVsZap` | `{ matches, humanWins }` or `null` | The same fields of `summary.json` when the file is there and valid; `null` otherwise. |

### `GET /api/summary` (`zap-summary/2`)

`summary.json` of the `zap-public` bucket (binding `PUBLIC`, read only by the Worker), answered as stored with `cache-control: public, max-age=300` once it is at most 1 MB (`LIMITS.summary`) and passes `validateSummary` (`shared/cycle-formats.ts`). Missing or invalid: `404 { "error": "no_summary" }`, and an invalid file is logged once per Worker instance. The training cycle writes it (`training/cycle/zapcycle/summary.py`) after a cycle, a promotion, a rollback or a daily A/B check. `validateSummary` accepts `zap-summary/1` too, and `normalizeSummary` (`shared/summary-view.ts`) reads a `/1` file as `/2` with the new fields `null` or empty.

Every number built from people's matches comes from a group of at least 20 distinct people (`minPeople`), counted over seats that may go into open data (linked, not flagged, weight above 0, not out of open data); the validators refuse a file that breaks this. The one exception, asked for by the owner, is `humansVsZap`, a total of every quick play match.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"zap-summary/2"` | Format name and version. |
| `generatedAt` | integer, ms | When the cycle wrote the file. |
| `minPeople` | `20` | The smallest group a number built from people may come from. |
| `training` | object | `state` (`ok`, `running`, `failed`) and `finishedAt` from `status/training.json`, `current` (the manifest's current version) and `nextAfter` (the end of the running comparison with people, `ab.until`, or null). |
| `humansVsZap` | object | `matches` and `humanWins`: quick play matches (`solo1`, `solo2`) with a person, and how many the person's team won; `since`: the end of the first one, null while there is none. |
| `versions` | array, oldest first | One entry per version that was served (bootstrap, promoted, rolled back), below. |
| `ab` | object or `null` | The comparison with people of the newest version (`project_docs/cycle.md`): `version`, `control`, `share` (the share of quick play matches that keep the previous version), `from`, `until`, `detectablePoints` (the true drop, in points per 100 matches, that the rollback rule catches 80% of the time by the end of the window) and `result` (`drop`, `lo`, `hi`: how much more often people beat the new version than the previous one, with its 90% interval). Both stay null until each group has 20 people. |
| `layers` | object | One entry per layer that turns on with people's data (`humanModel`, `priors`, `adaptation`, `playerTypes`, `ranking`, `openData`, `flags`): `on`, `why` (a plain sentence of at most 500 characters) and `progress` (counts toward the layer's threshold; a count of people is null under 20). |
| `cells` | array | Per ISO week, variant and number of players: `people`, `matches` and `humanWinRate` of quick play, only for groups of at least 20 people. |
| `playerTypes` | object or `null` | The player types once each has 20 people: `k` types, `ari` (how stable the grouping is, from -1 to 1) and per type its `share` and `center` (the 8 reading numbers of `zap-reading/1`). |
| `seedNoise` | object or `null` | How far the twin comparisons of two runs with different seeds sit from an even score: `floors` (how many were measured) and `rms`, from the newest model card that has it. |
| `scoreboard` | array | People against Zap by mode: `variant`, `players`, `aiVersion` (the version facing the person), `partnerVersion` (the version of the person's AI partner in 2 against 2, null in 1 against 1), `people`, `matches` and `humanWins`. A row only with at least 20 people. |
| `disagreements` | `null` | Reserved for the human layer: per decision type, the share of people's decisions the served model found very unlikely. Written null until that layer measures it. |

`versions[i]`:

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `"vN"` | The version. |
| `promotedAt` | integer, ms | When it went live (for the bootstrap, when its manifest entry was made). |
| `result` | `"bootstrap"`, `"promoted"`, `"rolled-back"` | What its model card says. |
| `anchors` | object or `null` | Its score against the gate's panel (`random`, `base`, `tuned`, `v1`), each `{ mean, lo, hi }`; null for the bootstrap. "You against Zap" places the characters of that version on the rating scale from them. |
| `twin` | `{ pairs, mean, lo, hi }` or `null` | This version against its twin, the same training without people's matches, in duplicate pairs. |
| `personas` | `{ pairs, stats }` or `null` | The characters' numbers measured again for this version: per character `trucoRate`, `bluffRate`, `runRate`, `reraiseRate`, `signalTruth` and `vsZap`, with the duplicate pairs behind each `vsZap`. |
| `data` | `{ validMatches, people }` or `null` | Matches with people in its training data, and how many people (null under 20). |

## The person's download (`GET /api/me/data`)

Everything D1 keeps about the device, without the device id, the secret or the recovery hash: the pseudonym, the device row's dates and switches, the matches and seats, open and joined rooms, reports made, reports about the person (day only, no reporter), flags (with `ref`), `profile` (one entry per segment: `segment`, `matches`, `decisions` and the counters as `H`, `K`, `U`, `A`, `X`, `S`, `Q`, `V`, `W`, `BC`, `BR`, `G`, `GT`, `TN`, `TL`, `TL2`, the names of `shared/profile.ts`) and `exportGroups` (`exportDate`, `group` for each export of the last 30 days). The page adds the full record of each match.

## In the browser

| Item | Kind | Content | Sent to the server |
| --- | --- | --- | --- |
| `__Host-zap_device` (`zap_device` on plain http in development) | HttpOnly cookie, 400 days from the last human check or recovery | The device secret. | Yes, as a cookie; never readable by page scripts. |
| `__Host-zap_cred` (`zap_cred`) | HttpOnly cookie, 2 h | Signed credential: a keyed hash of the device id (not the id), when the check passed, expiry. | Yes, as a cookie. |
| `zap-lang` | localStorage (`web/src/i18n.ts`) | `pt` or `en`, the language the person chose. | No. |
| `zap.adult` | localStorage (`web/src/consent.ts`) | `1` once the person declared being 18 or older. Removed by "Apagar meus dados" in that browser. | No (the server only gets `adult: true` once). |
| `zap.notice` | localStorage (`web/src/consent.ts`) | The version of the notice the person accepted with "Entendi": `NOTICE_VERSION`, or its `+ads` form while ads are on. A different version shows the notice again. Removed by "Apagar meus dados" in that browser. | No. |
| `zap-jogar` | localStorage (`web/src/play/state.ts`) | The Play page's last choice: `{ modo, variante, contra: { dupla, solo } }`, the mode, the variant and the opponents of each line up. | No. The server gets only the settings of a match when it starts. |
| `zap-mute-phrases` | localStorage (`web/src/store.ts`) | `1` or `0`: "Silenciar frases e sinais dos outros". | No. |
| `zap-four-color` | localStorage (`web/src/prefs.ts`) | `1` or `0`: the four-color deck, off unless `1`. | No. |
| `zap-sound` | localStorage (`web/src/prefs.ts`) | `1` or `0`: sound and vibration, on unless `0`. | No. |
| `zap-keys` | localStorage (`web/src/prefs.ts`) | `1` or `0`: the single key shortcuts, on unless `0`. | No. |
| `zap-terms-seen` | localStorage (`web/src/table/HandInfo.tsx`) | JSON list of the first match hints already shown (`vira`, `manilha`, `tento`), so each one shows once. | No. |
| `zap-ads` | localStorage (`web/src/ads/index.ts`), written only while ads are on | The answer to the ads dialog with the notice version: `yes:<version>+ads` or `no:<version>+ads`. | No. |
| `zap-last-room` | sessionStorage (`web/src/actions.ts`) | Last room code, for the "back to room" button. | No. |
| `zap-limit` | sessionStorage (`web/src/limit.ts`) | The brake's last refusal as `{ limit: { period, resetAt }, until }`: the page shows the message again without a request until the reset, for `LIMIT_HOLD_MS` (one hour) at most. | No. It is a copy of the server's own answer. |
| `zap-ads-last` | sessionStorage (`web/src/ads/index.ts`), written only while ads are on | When the last ad break of the tab was shown (milliseconds since the epoch), to keep `ADS_MIN_INTERVAL_S` between breaks. | No. |
| `zap-you` | IndexedDB database, version 1 (`web/src/you-vs-zap/records-cache.ts`) | Written only when the person opens "You against Zap". Store `records`: key the match id, value `{ yourSeat, record }`, a copy of the person's own match record as `GET /api/me/matches/:id` gave it (the same as in the download). Store `meta`: key `owner`, value the person's pseudonym from `GET /api/me/data`. | No. The page reads them instead of asking the server again; nothing in them is sent anywhere. |

This is every cookie, key and database the site writes: the Worker sets only the two cookies, and the page code (`web/src`) the rest. Unless a row says otherwise, a localStorage key stays until the person clears the site's data, and a sessionStorage key goes when the tab closes. The two keys marked for ads are never written while `/api/config` answers `ads: null`, as it does today; the privacy page lists them once ads go on (DEPLOY.md, "The site's own notice and texts").

The `zap-you` cache: the page claims it for the pseudonym of `GET /api/me/data` before reading it, and when `meta.owner` is another pseudonym (after a recovery code, or a deletion and a new start) it clears both stores first. A cached record is never fetched again, since records never change; the missing ones come in batches of 10. Every call is wrapped so that a browser without IndexedDB (a private window, blocked storage) simply fetches on each visit. The whole database is deleted when the person deletes their data on the You page (/voce) (`POST /api/me/delete` succeeded, in that browser) and when they press "Esquecer as partidas guardadas neste aparelho" on the page itself; clearing the site's data in the browser removes it too. The history, the rating and the best hands are computed from these records each time the page opens and are not stored, here or on the server.

## What never appears anywhere

* IP addresses. Zap never writes one to D1, R2, Durable Object storage or files. Rate limits use an HMAC of the IP with a salt that changes every day, kept only in Cloudflare's rate limiter counters for their window. The Turnstile check is sent without the visitor's IP. Worker logs (observability) are off.
* The device secret. Only its hash is stored. Room storage keeps the hash while the room is open; it goes away with the room, or at once when the person deletes their data or moves it to another browser.
* The birth year. The age screen keeps it in the page only to compute the answer.
* The recovery code. Only its hash, and only until it is used or replaced.
* Names, emails, phone numbers, locations or free text. There is no chat: phrases travel as fixed keys, and report reasons are fixed values.
* In R2 records, data releases and public pages: device ids, pseudonyms, nicknames, room codes and cookies.

## Open data release (planned)

From 1,000 human matches on, and only with `OPEN_DATA_ENABLED=true` on the training server, a release built from the per-decision table follows each promoted AI version: the first one by the maintainer's command after looking inside the package, the later ones by the training cycle right after the promotion. Every release has these changes: a new random code per match, so no row links two matches by the same person; dates only as the ISO week; decision times in 0.5 s bands; each combination of week, variant and mode published only when it covers at least 20 distinct people; only matches whose every person is linked, not opted out ("Fora dos dados abertos") and not flagged, so seats of people who deleted their data are left out. Style figures are published separately, only as aggregates: per band of match counts (50 matches or more), the mean and the standard deviation of each reading number over at least 20 people, never one row per person and with no link to matches. A package records the export it was built from, and the upload refuses it once a newer export exists or when that export is more than a day old, so a release reflects deletions and opt-outs up to that export, made at most a day earlier; a person who leaves after it is left out from the next release. License CC BY 4.0. The release builder is in `training/cycle/opendata/`, and each release carries its own `DICTIONARY.md` with every column.
