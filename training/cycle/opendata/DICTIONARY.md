# Zap open data: dictionary

Made on {created} by the Zap training cycle (`training/cycle/zapcycle/human/opendata.py`). Zap is a truco game in the browser (paulista and mineiro rules, 1 against 1 and 2 against 2) against an AI that learns from the people who play. The rules engine that produced every match is open source in the same repository (`engine/`), under the MIT license.

## What is in this release, and what is not

* Matches with at least one person, where every person's seat is still linked to an account, the person did not opt out of open data ("Fora dos dados abertos") and the account is not flagged for automation. People who deleted their data are not in any release made after the deletion. Releases already published cannot be withdrawn.
* Each match has a new random code made for this release only. No column links two matches by the same person, and codes are unrelated to codes of other releases.
* Dates appear only as the ISO week of the end of the match. A person's decision time appears only as a band of 0.5 s.
* Matches are grouped in cells of ISO week, variant and number of players. A cell is published only when at least {min_people} distinct people played in it; the matches of smaller cells are left out whole.
* There is no name, nickname, device, account, room code, internal match id, seed or IP address anywhere in the release.

## Files

| File | One row per |
| --- | --- |
| `matches.csv` | match |
| `decisions.csv` | decision of any seat, person or AI, in the order of the match |
| `cells.csv` | published cell |
| `style.csv` | band of match counts, over the people with at least {style_matches} matches: averages, never one person |
| `manifest.json` | release: counts, the SHA-256 of each file, and the date and SHA-256 of the daily export it was built from |
| `LICENSE.md` | the license notice (CC BY 4.0) |

Every CSV file is UTF-8, comma separated, with a header row. An empty field means "not applicable".

## `matches.csv`

| Column | Meaning |
| --- | --- |
| `match` | The match code of this release (16 hex characters). |
| `week` | ISO week of the end of the match, `YYYY-Www`. |
| `variant` | `paulista` or `mineiro`. |
| `players` | 2 (1 against 1) or 4 (2 against 2). |
| `kind` | `solo1` (a person against an AI), `solo2` (a person and an AI partner against two AIs), `friends` (two people as partners), `humans` (people only), `mixed` (people and AIs in other ways). |
| `option_ladder` | Mineiro bet steps: `standard` (2, 4, 6, 10, 12) or `mineiro8` (2, 4, 8, 10, 12). |
| `option_raiseAnyTime` | 1 when a raise was allowed at any moment of the play, 0 when only on one's own turn. |
| `option_bestOf` | 1 (one game of 12 points) or 3 (best of three games). |
| `option_onzeSeesPartner` | 1 when the team on 11 points (10 in mineiro) sees the partner's cards. |
| `option_onzeTieToOpponents` | 1 when a mão de onze (de dez) with three tied rounds goes to the other team. |
| `option_ironHand` | `blind` (mão de ferro played face down) or `normal`. |
| `option_faceDownFirstRound` | 1 when a face down card was allowed in the first round. |
| `option_allTieToMao` | 1 when three tied rounds give the hand to the team that opened it. |
| `option_signals` | Partner signals in 2 against 2: `secret`, `p25` (each opponent sees a signal with chance 25%) or `all`. |
| `human_seats` | Seats of people, separated by spaces (seats are numbered from 0; teams are seats 0 and 2, and 1 and 3). |
| `ai_version` | AI version in the opponent seats. |
| `partner_version` | AI version of an AI partner of a person (the same as `ai_version` outside a test of a new version). |
| `hands` | Hands played. |
| `winner_team` | 0 (seats 0 and 2) or 1 (seats 1 and 3). |
| `points_team0`, `points_team1` | Points at the end of the last game. |
| `games_team0`, `games_team1` | Games won. |

## `decisions.csv`

Each row is one action in the order of the match, with what the deciding seat could see just before it. Nothing in a row is hidden information of another seat.

| Column | Meaning |
| --- | --- |
| `match` | Match code (as in `matches.csv`). |
| `decision` | Position of the action in the match, from 0. Rows of one match keep this order. |
| `hand` | Hand number in the match, from 0. |
| `seat`, `team` | The deciding seat and its team (`seat` mod 2). |
| `decider` | `human` or `ai`. |
| `persona` | For AI seats: the character (`zap`, `otavio`, `bento`, `lia`, `ravi`, `iara`). |
| `hand_kind` | `normal`, `onze` (mão de onze, or de dez in mineiro) or `iron` (mão de ferro). |
| `phase` | `play`, `raise` (answering a bet) or `onze` (deciding whether to play a mão de onze). |
| `type` | `card` (play phase, no raise possible), `bet` (play phase, a raise is possible), `answer` (answering a bet), `onze` (the mão de onze decision). |
| `round` | Round of the hand, from 0. |
| `value` | Points the hand is worth now. |
| `step` | Bet step reached (0 before any truco). |
| `last_raise_team` | Team that raised last, or -1. |
| `dealer`, `mao` | Seat that dealt, and seat that opened the hand. |
| `score_team0`, `score_team1`, `games_team0`, `games_team1` | Score before the action. |
| `vira` | The card turned up (rank then suit: `4 5 6 7 Q J K A 2 3` and `d s h c`). |
| `manilha` | Rank of the manilhas in paulista (the rank after the vira); empty in mineiro, where the manilhas are fixed cards. |
| `cards` | The seat's own cards by slot, separated by spaces: a card, `--` when already played, `??` in a mão de ferro played blind. |
| `partner_cards` | The partner's cards when the rules show them (mão de onze with `option_onzeSeesPartner`). |
| `table` | Cards on the table in this hand, round by round: `r1:0=4c 1=down | r2:...`, where `seat=card`, and `down` is a card played face down. |
| `signals_seen` | Partner signals this seat saw in this hand: `seat=signal` (`zap`, `copas`, `espadilha`, `picafumo`, `tres`, `nada`). |
| `legal` | Legal actions as a bit mask (bit k set when action k was legal). |
| `action` | The action: 0 to 2 play the card in slot 0 to 2; 3 to 5 play it face down; 6 raise (truco, seis, nove, doze, or the mineiro steps); 7 accept; 8 run; 9 to 14 send a signal. |
| `action_name` | `play`, `cover`, `raise`, `accept`, `run` or `signal`. |
| `action_card` | The card played or covered. |
| `action_signal` | The signal sent. |
| `time_band_s` | People only: the decision time band in seconds, as its lower edge (1.5 means from 1.5 s to 2 s); the last band holds every longer time. Empty for AI seats and for moves the AI made for a person. |
| `auto` | 1 when the AI moved for a person (time out, away or abandoned). |

## `cells.csv`

| Column | Meaning |
| --- | --- |
| `week`, `variant`, `players` | The cell. |
| `people` | Distinct people who played in it (at least {min_people}). |
| `matches` | Matches of the cell in this release. |

## `style.csv`

One row per band of match counts, over the people with at least {style_matches} matches whose data may be published, with no link to any match and no row for a single person. A band is published only when at least 20 people are in it. For each person, each number is a share from 0 to 1: the person's own rate pulled towards the rate of everyone in proportion to how little evidence there is (a Beta posterior mean). The file gives, per band, the mean and the standard deviation of each number over the people of the band, with 2 decimals; both are empty when fewer than 20 people of the band have that number known well enough.

| Column | Meaning |
| --- | --- |
| `matches_band` | Range of the number of matches of the people in the row. |
| `people` | People in the band (at least 20). |
| `raise_mean`, `raise_sd` | Share of normal hands in which a person asked for truco or raised (answers to a bet not counted). |
| `run_mean`, `run_sd` | Share of the bets a person faced that they ran from. |
| `accept_mean`, `accept_sd` | Share of the bets a person faced that they accepted. |
| `reraise_mean`, `reraise_sd` | Share of the bets a person faced that they raised again. |
| `shown_mean`, `shown_sd` | In hands where a person raised: mean strength of the cards they showed face up, from 0 (weakest) to 1 (strongest). |
| `cover_mean`, `cover_sd` | Share of the plays where a face down card was allowed in which a person played face down. |
| `bluff_mean`, `bluff_sd` | Share of the chances to raise with a weak hand (estimated chance below 1 in 3) in which a person raised. |
| `signalTruth_mean`, `signalTruth_sd` | Share of a person's signals that told the truth about their hand. |

## How to cite

Zap open data, release of {created}, https://zap.andreiludescher.com, licensed under CC BY 4.0.
