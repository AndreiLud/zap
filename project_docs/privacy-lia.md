# Legitimate interest assessment

Version of 2026-11-23. Not legal advice: this is the reasoning of a personal project, written down so it can be checked, and it has not been reviewed by a lawyer.

## Context

* Controller: Andrei Ludescher, a private individual who runs Zap as a personal, non-profit project.
* Service: a free truco game in the browser, against an AI built to learn from the people who play (no match with people has trained it yet). No accounts, no money, no purchases, no free chat, ads switched off.
* Who plays: people who declare being 18 or older (see "Age and ECA Digital").
* Where: Cloudflare Workers, with rooms (Durable Objects) in eastern North America, D1 for the link between people and seats, R2 for match records. The AI is trained on the maintainer's own server, which reads match records and a daily export with random group tokens, but never the D1 link.
* Data map: `data-dictionary.md`. Retention: `retention.md`.

## Legal references

* LGPD (Lei 13.709/2018), art. 7, IX: legitimate interest of the controller or a third party as a legal basis, unless the data subject's fundamental rights and freedoms prevail.
* LGPD art. 10: legitimate interest only for legitimate purposes, considered from concrete situations, such as supporting the controller's activities (I) and providing services that benefit the data subject within their legitimate expectations (II); only strictly necessary data (§1); transparency (§2); the ANPD may ask for an impact report (§3).
* LGPD art. 18: data subject rights, including opposition to processing based on a basis other than consent when it does not comply with the law (§2), and petition to the ANPD (§1).
* LGPD art. 19: confirmation and access, immediately in a simplified form, or within 15 days in a clear and complete statement.
* Also relevant: art. 12 (anonymized data), art. 14 (children and adolescents), art. 20 (review of automated decisions), art. 33 (international transfer), art. 46 and 48 (security and incident reporting).
* ECA Digital, Lei 15.211/2025 (digital rights of children and adolescents).
* The structure below follows the usual three steps for legitimate interest, as in ANPD's guidance on the topic: purpose, necessity, balancing with safeguards.

## Summary

| Purpose | Data | Basis |
| --- | --- | --- |
| 1. Playing, rooms, reconnection | device secret hash, pseudonym, nickname, seats | legitimate interest, strictly necessary |
| 2. Protection against bots | human check result, decision times, volume, flags from the training cycle | legitimate interest |
| 3. Rating, history, "You against Zap" | the person's own match records, read and computed on the device; a copy of them and of the pseudonym cached in that browser | legitimate interest |
| 4. AI training and the data report | decisions, without the person in the records; a daily export with a random group per person | legitimate interest |
| 5. Style counters, "How Zap reads you", adaptation | style counters per person; public facts of the current match | legitimate interest, with the "Don't adapt to me" switch |
| 6. Open data | decisions without the person, rules below | legitimate interest, with the "Fora dos dados abertos" switch |
| 7. Public ranking | nickname, rating band | consent (opt in) |

## 1. Playing, rooms and reconnection

**Purpose.** Run the game the person asked for: give them a seat, keep their seat when the connection drops, let them create and join rooms, show a nickname to the others at the table. This is a service that benefits the person (art. 10, II), needed for every match.

**Necessity.** A random secret in an HttpOnly cookie, of which the server keeps only a hash; a random pseudonym; the seats per match; an optional nickname. Alternatives considered: accounts with email and password (more data, rejected); no persistent identifier (no reconnection, no limits per browser, no history, rejected). The room's state, which holds the device hash per seat, is deleted when the room closes or after 24 hours without use.

**Balancing.** Anyone who opens an online game expects it to remember their seat. The data does not identify anyone outside Zap. The nickname is visible only to people in the same room, passes a filter, and is hidden at once when reported. Impact on the person: low.

**Safeguards.** `__Host-` HttpOnly cookies; hash only; no IP stored; deletion at any time on the You page (/voce); deletion after 12 months without playing; notice before the first match.

**Result.** The interest is legitimate and the data is the minimum for the service. Legitimate interest applies.

## 2. Protection against bots and abuse

**Purpose.** Keep automated players out of rooms and out of the training data, and protect the service and the other players from floods. Supports the controller's activity (art. 10, I) and protects the people who play (art. 10, II). Concrete situation: Zap is built to learn from people, so bots would corrupt the AI and the public report once people's matches feed training.

**Necessity.** The time of the last human check (Cloudflare Turnstile) and the number of matches since; decision times and volume, which are part of the match records anyway; a temporary block after flooding. Rate limits use an HMAC of the IP with a daily salt that is never stored, and the Siteverify call is made without the visitor's IP. Alternatives considered: storing IPs (rejected); a check before every match (worse experience, no gain); accounts (rejected).

Automated play is found by the training cycle on the maintainer's server, not by the Worker: it looks at the decisions of each group of the daily export (decision times too regular, play around the clock, unusual volume, identical sequences) and writes its findings as `<export date>:<group>` refs to `control/flags.json`. The daily job resolves each ref to a person inside D1 through `export_groups` and writes the flag there, so the pseudonym never leaves D1 and the training server never learns who was flagged. Alternative considered: sending pseudonyms to the training server (rejected: a pseudonym would resolve to the person for as long as D1 keeps it).

**Balancing.** People expect anti-bot checks in an online game. Risks: Turnstile runs in the browser and Cloudflare reads browser signals under its own policy, which is disclosed; a person may be flagged by mistake. A flag removes the browser from training at once (weight 0 in the next export) and from the ranking provisionally, and removes the verified seal; any lasting effect waits for a human review (art. 20), which the owner makes with the cycle's `flags` tool (`moderation.md`). Clearing a flag puts the browser back. The person sees their flags on the You page (/voce) and in the download. Reviewed flags are deleted 12 months after the review, and lose their ref (the link from the cycle's group token to the person) 30 days after it; a flag waiting for review keeps the ref until it is reviewed. A group token resolves for 30 days only; a flag on an older group finds nobody. A clear is not undone by the automation: a flag that arrives less than 15 days after a clear, the cycle's 14 days of evidence seen again under a new group, is ignored, and a flag for the same reason waits 90 days, so a person whose play keeps a pattern the owner judged harmless is not taken out of training again every two weeks. When a recovery joins two browsers that both have a flag, an open or confirmed flag wins over a cleared one, so it stays reviewable.

**Safeguards.** "Como verificamos" page, which says that bots can still pass; human review of every flag; temporary blocks only (15 minutes) for flooding; no IP storage; flags computed from random daily groups, never from identities.

**Result.** Legitimate interest applies.

## 3. Rating, history and "You against Zap"

**Purpose.** Show people their own results against the AI: the history of their matches, a rating, how the AI reads them, their abandons and their best hands. A service that benefits the person (art. 10, II).

**Necessity.** The server keeps nothing new for this. The page `/voce-contra-o-zap` asks for what the You page (/voce) already gives the person: the list of their matches (`GET /api/me/data`, found through `match_seats`), each match record (`GET /api/me/matches/:id`) and the reading (`GET /api/me/reading`), plus the public summary every visitor gets. The history, the rating, the list of abandoned matches and the best hands are computed in the person's browser from those records, each time the page opens. The rating is not stored on the server, nor anywhere else: it is worked out again on every visit. Alternative considered: computing and storing a rating per person in D1 (rejected: it would be one more piece of profile data on the server, and only the person reads it).

So that the page opens fast and a record crosses the network only once, the browser keeps a copy of each record it read in an IndexedDB database of its own (`zap-you`), with the person's pseudonym next to them to know whose copies they are. Records never change, so a cached record is never asked for again. Nothing in the cache is sent anywhere. Alternative considered: no cache (rejected: a person with hundreds of matches would download every record on every visit, which costs them time and data and costs the service requests within the limits of `RL_DATA`).

**Balancing.** Expected in any game with a score. Everything on the page is about the person and stays private to them: nothing about one person appears on public pages, and the public ranking is separate and needs consent (purpose 7). The device cache holds data the person can already download, on their own device, in the browser where they play; the residual risk is someone else using that browser and profile, who could also open the You page (/voce) and the download. A browser that loses its link to the person (after a recovery code moved it to another browser) keeps the copies until the page opens there with another pseudonym, the person presses "Esquecer", or the site's data is cleared.

**Safeguards.** The cache is cleared before use when the pseudonym in it is not the current one. Deleting the data on the You page (/voce) deletes the whole cache in that browser, and the page has its own button, "Esquecer as partidas guardadas neste aparelho". The privacy page says what is kept in the browser and for how long. Download and deletion of the server side at any time; 12 month inactivity deletion.

**Result.** Legitimate interest applies.

## 4. AI training and the data report

**Purpose.** The core of the project: an AI that learns from the people who play, and a public report on how it learns and how people play. Supports the controller's activity (art. 10, I). Concrete situation: the weekly training cycle and the gate that decides whether a new version goes live.

**Necessity.** The decisions are the training data and cannot be replaced: self-play alone does not learn how people play. Identity is not needed, so the records in R2 carry only the match id and the seat number. Decision times are needed for bot detection and for the human behaviour model. Moves made by the AI for a person are marked and left out. Alternatives considered: self-play only (fails the purpose); a person id in each record (rejected, it would make deletion require rewriting files).

**Balancing.** The home page says that each decision becomes data without saying who the person is, and the notice before the first match says it again. Records are pseudonymous while the D1 link exists and lose that link when the person deletes their data or after 12 months without playing. After that, the maintainer keeps nothing that could link a record back to a person, except D1's automatic backups for up to 30 days. Residual risk: someone who sat at the same table knows roughly when the match was played; the bucket is private, so this matters only for open data (purpose 6). Public pages show aggregates only, and every figure built from human data needs at least 20 distinct people per cell, counted only over seats that may go into open data (linked, not flagged, weight above 0, not out of open data); the only exception, requested by the owner, is the total of matches and wins of people against Zap since day one, which counts every quick play match.

**The comparison with people.** When a new version is promoted, for 14 days 30% of quick play matches, drawn at random per match, keep the previous version in every AI seat, and in the others the new version sits only in opponent seats (a person's AI partner stays the previous version). The cycle compares the two groups once a day by how often people beat the AI, with each person (the group token of the latest export) as one cluster, and rolls the new version back on its own when people clearly win more against it. Only seats that may go into open data count, and both the automatic rollback and the public figures of this comparison need at least 20 people in each group. Nothing new is collected for it: the match records already say which version played.

**Safeguards.** No identifiers in records; trust weights per browser and a cap of 2% of the data per browser; flagged browsers left out; separate handling of matches between friends; gate before any new version.

**The daily export.** The trust weights and the 2% cap need to know which seats belong to the same browser, without knowing whose they are. Once the training cycle exists (its manifest is in `zap-models`), the Worker's daily job writes one file to the private bucket with one row per linked seat: match id, seat, weight, the two switches, whether the browser is flagged, and a group token. The token is 64 random bits drawn by D1, new for every person in every export; inside one export it groups one person's seats, which is its purpose, and makes that file pseudonymous data. Rows of two exports can still be joined through their match ids and report ids, so the training server can follow the same person's seats from one export to the next; what it never learns is who the person is, and a token resolves in D1 for 30 days only. No pseudonym, device id, nickname, room code or IP is in the file, and the reporter of a report never is. D1 keeps the token to pseudonym mapping (`export_groups`) for 30 days, only so a flag can find its person; deletion removes it at once. Each export is kept 7 days. The training server keeps only the newest export, the per person tables of its newest cycle (decision tables and style readings keyed by that export's tokens) and `data/<profile>/ab/tables/`, rewritten by each daily A/B check with the newest export's tokens; every older cycle folder loses them when a cycle ends, whether it ended ok or failed, and after a build run on its own. It also keeps its own list of flags (refs, reasons and evidence) for up to 400 days. Alternatives considered: the pseudonym in the export (rejected: a pseudonym would resolve to the person for as long as D1 keeps it); no grouping at all (rejected: one very active browser, or a bot, could then make up a large share of the training data).

**Result.** Legitimate interest applies.

## 5. Style counters, "How Zap reads you" and adaptation

**Purpose.** Show people how Zap reads their way of playing ("How Zap reads you" on the You page (/voce)), which is part of the game experience and of the project's transparency about its AI; later, let the AI respond to a person's style. Three things, switched on at different times:

* Style counters per person, kept since milestone 6 and shown only to the person.
* In-match reading: the AI reads public facts of the current match about each other seat. It is prepared and switched off: `AI_ADAPT` is `off`, and the version in play, v2, has no reading in it.
* Adaptation to the person across matches: the counters as an input to the AI. Not built yet; it turns on only after the human model passes its test and the person has 150 decisions.

**Necessity.** The counters are small: per variant and number of players, how often the person called truco, ran, accepted and raised back, the strength of the cards they showed after calling, how often they played face down, bluffed with a weak hand and told the truth with a signal, and the count and sums of the logarithms of their decision times (`data-dictionary.md`, `profiles`). They are added up from the person's own decisions at the end of each match; a hand in which the AI played for them counts nowhere. Nothing finer is kept (no per-match rows), and the reading is computed on request without storing anything. A number appears on the page only after at least 10 of the person's own observations of it and when its 80% interval is narrower than 30 points, and a population value is never worth more than 50 observations, so a few matches never produce a confident label. The population values it is compared with come from the training cycle, which fits them from at least 100 people (never fewer than 20, and until then from the AI's own play), with no person counting for more than 2% of a number, and imports them as `control/priors.json`, with no person in the file. Each person is read against the population value at their own mix of tables (1 against 1 or 2 against 2, paulista or mineiro), so the tables someone chooses are not read as their style.

When switched on, the in-match reading would use only what everyone at the table saw in that match (raises, answers, cards shown face up, cards played face down, with how many observations each), never hidden cards, never anything from another match, and it would store nothing new: it is worked out again from the match the room already holds. With "Don't adapt to me" on for anyone seated when a match starts, the AI reads nothing about anyone at that table for the whole match, because a partly empty reading never occurs in training; turning the switch on counts for the whole table from its next match.

The explorer test, recorded on 2026-11-23. An explorer is an opponent that fakes a pattern and then switches, so that the reading misjudges it. The rule: against the exact file that would be served, no explorer may gain more than 1 point from the reading, at the one-sided 95% upper bound. The file `training/runs/m6-adaptive-r/export/zap-v2-b0.2-h1.zapw` (SHA-256 7223c227, safety net Bmax 0.2, nHalf 1) passes: all 9 explorers measured against it stay within the rule. The one that gains most, found by a search aimed at the reading itself, gains 0.49 points (from 0.15 to 0.83), with an upper bound of 0.77 points; the explorer that broke the rule against two earlier files, measured again against this one, has an upper bound of 0.50 points; and the reading costs the explorer trained against this file by reinforcement learning 1.00 point (upper bound −0.57 points). Keys: `ai.adaptation.explorer.criterion` in `facts.json`; the verdicts against the earlier files are in `ai.adaptation.history`.

Passing the test does not switch anything on, and the owner decided to keep v2 in play for now. The reading goes live only if the owner adopts that file through the training cycle (`DEPLOY.md` section 9): it becomes the next version, must pass the full gate with the reading live, and then faces the test window with people described under Balancing. Two measurements weigh against the network that carries the reading, and the window is what decides: head to head against its twin (the same training without the statistics) it scores 49.1% (from 48.3% to 49.9%), so it is not stronger overall, and an explorer trained against it takes 3.44 points more from it (from 2.60 to 4.29) than a control explorer, trained the same way against v2, takes from the twin, so by that measure its base is easier to exploit; the reading itself costs that explorer, as above (`ai.adaptation.headToHead`, `ai.adaptation.explorer.control`, which notes that the control was measured against the twin and not against the v2 it trained against). Nothing about the reading has changed for the people who play.

**Balancing.** Profiling can feel intrusive and could be used to exploit a person. Mitigations: the counters are used only to show the person their reading and, later, to play, never for ads or anything outside the game; nothing about one person is shown to anyone else; adaptation is tested against an exploiter and turns on only if no explorer gains more than 1 point from it (the candidate file passed on 2026-11-23); a version that adapts goes through the test window with people: for 14 days 30% of quick play matches stay on the previous version, chosen at random, the cycle rolls the new version back by itself if people beat it by more than 2 points with at least 200 matches and 20 people in each group, and the result is published; the person can switch the reading off for their table.

**Safeguards.** "Don't adapt to me" on the You page (/voce): switching it on deletes the counters at once and keeps no new ones (the room skips that seat and D1 checks the switch again when it writes), and the in-match reading of that table stays off from the next match. Once an adaptive version is in play, such a table plays it with the statistics at no evidence (the same file without reading). Head to head against the twin that network scores 48.5% (from 47.7% to 49.4%, `ai.adaptation.ablation.offPolicy.headToHead`): it is weaker than the twin head to head, so switching the reading off usually works in the person's favour; not always, since against some styles, such as Lia's and Iara's, the reading costs Zap a little and the network without it plays slightly better (`ai.adaptation.ablation.perStyle`). Because that network is weaker head to head, the reading is switched off for everyone by rolling back to the version that was current before the adoption (`$C rollback <that version>`, v2 unless a cycle promoted another; `DEPLOY.md` section 9.5), not by setting `AI_ADAPT` to `off`, which would leave every table on that weaker network. The counters are deleted with the person's data and after 12 months without playing, are in the download, and follow the person in a recovery (added into the recovered history, then removed). If either browser in a recovery had the switch on, no counters stay.

**Result.** Legitimate interest applies, with the opt-out.

## 6. Open data

**Purpose.** Publish a dataset of truco decisions that others can study and reuse, which is part of the project's public value and of its transparency about the AI.

**Necessity.** Releases start only after 1,000 human matches. Each match gets a new code, so no row links two matches by the same person; dates appear only as the week of the year; decision times in bands of 0.5 s; each combination of week, variant and mode is published only when it covers 20 or more distinct people. Style figures are published only as aggregates: for each band of match counts (50 matches or more), the mean and the standard deviation of each number over at least 20 people, never one row per person, with no link to matches. A package records the export it was built from; the upload syncs first and refuses a package built from an older export, or when the newest export is more than a day old, so a release reflects deletions and opt-outs up to that export, made at most a day earlier; a person who leaves after it is left out from the next release. Releases follow promoted versions. The first one is the owner's command after looking inside the package and the re-identification check below; after it, the training cycle releases on its own right after each promotion, with the same refusals, rebuilding the package from the newest export when one arrived since the cycle's tables. Setting `OPEN_DATA_ENABLED` to false stops it. Alternative considered and rejected: a per-person id in each release, as first planned; someone who played at the same table could recognize a match by its date and cards and then follow that person's whole history.

**Balancing.** This is the highest impact purpose, because a release under CC BY 4.0 on GitHub cannot be withdrawn. The rules above aim at data that no longer relates to an identifiable person (art. 12). The notice and the privacy page say that published releases are permanent.

**Safeguards.** "Fora dos dados abertos" switch; people who delete their data leave all future releases; a re-identification check before the first release; GitHub token limited to this repository's releases.

**Result.** Legitimate interest applies with these safeguards. Repeat this assessment before the first release.

## 7. Public ranking (consent)

Not based on legitimate interest. People join only by asking (art. 7, I), see what is shown (nickname and rating band), and can leave at any time, which removes them from the next update. The ranking starts only with 50 people with 20 matches each. It will be the first place where a rating is computed on the server, and only for the people who joined; until then no rating exists outside the person's own browser (purpose 3).

## Age and ECA Digital

The owner chose 18 or older by self-declaration. A neutral screen asks the birth year from a list with no default; only "adult: yes" with a timestamp is stored; the year never leaves the browser. People under 18 can read the rules and the data page, cannot play, and nothing about them reaches the server.

Self-declaration is not effective age assurance, so the project assumes adolescents may still reach the game and keeps protective defaults regardless: no loot boxes, purchases or bets; no free chat; ads off; profiling used only to play; a report button; muting of phrases and signals; a nickname filter. If the maintainer learns that someone under 18 played, their data is deleted. The You page (/voce) lets anyone with the browser delete the data at once, including parents and guardians.

## International transfer

Cloudflare runs the rooms in eastern North America (there is no Durable Object region in South America) and may store D1 and R2 data outside Brazil; open data releases are hosted on GitHub. The privacy page and the notice say that data is transferred to the United States. Art. 33 requires a transfer mechanism; see open points.

## Rights and response times

* The You page (/voce) gives access and a complete download at once (art. 19, I), deletion at once, nickname correction, both switches and the recovery code.
* When `PRIVACY_CONTACT` is set, other requests (review of a flag, objection beyond the switches, questions) go there, with an answer within 15 days (art. 19, II).
* Without the browser or a recovery code, nobody, including the maintainer, can find which matches belong to a person. The pages say so.

## Open points

1. **Contact channel.** `PRIVACY_CONTACT` is empty for now, so the You page (/voce) is the only channel. ANPD Resolution CD/ANPD 2/2022 lets small processing agents, natural persons included, skip naming a data protection officer but still expects a channel for data subjects. Recommended: set `PRIVACY_CONTACT` before launch.
2. **Transfer mechanism (art. 33).** Confirm which mechanism covers Cloudflare and GitHub (for example their data processing terms and standard contractual clauses) and record it here.
3. **Backups.** D1's automatic backups (Time Travel) last 7 days on the Workers Free plan and 30 days on Workers Paid. The texts say "within 30 days", which holds on either plan; if the window ever grows beyond that, update the texts and `retention.md`.
4. **Ads.** Turning ads on needs a new assessment, a new version of the notice, and consent for ad cookies.
5. **Re-identification check** before the first open data release.
6. **Review** this assessment when a purpose changes, before the first open data release, when the in-match reading, adaptation or the ranking turns on (with the explorer test result in section 5), and at least once a year.

Not legal advice.
