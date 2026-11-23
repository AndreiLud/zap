# Moderation

How a person reviews reports. Reports come from "Denunciar" at the table (`POST /api/report`). Each one names a room, a seat and a fixed reason (`nickname`, `phrases`, `cheating` or `other`); there is no free text. The reporter and the reported person are pseudonyms (`reports.reporter`, `reports.target`), never device ids. `target` is null for an AI seat and after the reported person deleted their data.

What a nickname report does at once:

* The room hides the name for everyone at that table ("Jogador N" / "Player N").
* `devices.nickname_hidden` becomes 1, so every later room shows the default name too, and the You page (/voce) tells the person it waits for review.
* If the person picks a different nickname, the new one shows at once and `nickname_hidden` goes back to 0. Saving the same nickname keeps it hidden. A new name can be reported again.

The Terms page says that a person reviews every report. Review open reports at least once a week, oldest first. Reports are deleted 12 months after they were made (`runRetention`).

## Commands

Run them from the project root with the production database (`--remote`). Replace `N` with the report id from the list.

List open reports, oldest first, with the reported nickname when there is one:

```sh
npx wrangler d1 execute zap --remote --command "SELECT r.id, datetime(r.created_at/1000,'unixepoch') AS created, r.reason, r.room_code, r.seat, d.nickname FROM reports r LEFT JOIN devices d ON d.pseudonym = r.target WHERE r.status = 'open' ORDER BY r.created_at"
```

Dismiss a report (the nickname is fine, or the report was about something that did not happen). For a nickname report this shows the name again:

```sh
npx wrangler d1 execute zap --remote --command "UPDATE devices SET nickname_hidden = 0 WHERE pseudonym = (SELECT target FROM reports WHERE id = N); UPDATE reports SET status = 'dismissed' WHERE id = N"
```

Uphold a nickname report (the name breaks the Terms). The nickname is removed, so the person shows as "Jogador N" until they choose another one:

```sh
npx wrangler d1 execute zap --remote --command "UPDATE devices SET nickname = NULL, nickname_hidden = 0 WHERE pseudonym = (SELECT target FROM reports WHERE id = N); UPDATE reports SET status = 'upheld' WHERE id = N"
```

Uphold any other report without acting on the nickname:

```sh
npx wrangler d1 execute zap --remote --command "UPDATE reports SET status = 'upheld' WHERE id = N"
```

## Notes

* Several reports about the same nickname: decide one, then apply the same status to the others (`WHERE target = (SELECT target FROM reports WHERE id = N) AND status = 'open'`).
* A room that is still open keeps showing the default name for that seat until the person joins a room again; their next connection carries the reviewed name.
* Reports about cheating or phrases have no automatic effect. Upholding one is a record for later decisions (for example confirming a flag of the same person, below); it changes nothing by itself.
* Never copy pseudonyms, nicknames or room codes out of D1 into notes or tickets.

## Flags from the training cycle

The training cycle looks for automated play in the groups of the latest daily export (`project_docs/privacy-lia.md`, section 2) and appends what it finds to its flag list, which it uploads as `control/flags.json`. The Worker's daily job imports the list when it changed: each ref (`<export date>:<group>`) is resolved to a person inside D1 through `export_groups`, a D1 `flags` row is written with the ref, and `devices.flagged` becomes 1. From then on the person's seats have weight 0 in every export (out of training at once), they play without the verified seal, and they are out of the ranking provisionally. The receipt of that day (`receipts/YYYY-MM-DD.json` in `zap-events`) lists each ref as `applied`, `ignored` (the person already had an open or confirmed flag, or a flag cleared less than 15 days before, or less than 90 days before for the same reason), `unresolved` (no person: the group is older than 30 days or the person deleted their data) or `reviewed`.

Review every open flag with the cycle's `flags` tool on the training server (`training/cycle/SERVER.md`), never by editing D1:

```sh
docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml flags list
docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml flags confirm 2026-11-21:0123456789abcdef
docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml flags clear 2026-11-21:0123456789abcdef
docker compose --profile cycle run --rm -T cycle python training/cycle/cycle.py --config training/cycle/config/prod.toml flags push
```

`flags list` shows each pending ref with its reason, its evidence and its status in the latest receipt, and the open reports of the latest export by group (report id, day, reason), so a report about cheating and a flag on the same group can be read together. `confirm` keeps the person out of training; the flag row itself is deleted 12 months after the review, and its ref 30 days after the review. `clear` puts them back (`devices.flagged` returns to 0). The cycle looks back 14 days (`[human.flags] lookback_days`) and gives the person a new group in every export, so it would find the same evidence again under a new ref: the Worker ignores a flag that arrives less than 15 days after the person's last clear (`CLEARED_GRACE_MS` in `worker/src/cycle-jobs.ts`; keep it above `lookback_days`), and the receipt lists that ref as `ignored`. A flag for the same reason as the cleared one waits 90 days (`CLEARED_SAME_REASON_GRACE_MS`): a person whose play keeps a pattern the owner judged harmless, much volume for example, would otherwise be flagged again, and taken out of training, every 15 to 21 days. A flag after the grace looks only at matches played after the clear, and replaces the cleared one. When a recovery joins two browsers that both have a flag, an open or confirmed flag wins over a cleared one, so the flag that still matters stays reviewable. A review takes effect at the next daily job after `flags push`. The tool shows only refs and evidence; it never sees a pseudonym, and the Worker never sends one back.

A pending flag whose receipt status is `ignored` needs no review: the person already had an open or confirmed flag, or a recent clear (15 days, or 90 for the same reason). Confirming or clearing it changes nothing in D1.

