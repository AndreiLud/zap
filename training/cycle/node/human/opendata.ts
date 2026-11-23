// Rows of the open data package (contract 3.11): one CSV row per match and one per decision of the
// matches the cycle selected (zapcycle/human/opendata.py chooses them and gives each a new random
// code). Nothing here names a person, a device, a group, a room, the match id or the seed: a match
// is its new code, its date is the ISO week, and a person's decision time is a 0.5 s band.
//
// Usage: node training/cycle/node/human/opendata.ts --records DIR --selection FILE --out DIR
//          [--time-bin-ms 500] [--max-time-s 120]
// selection: JSON lines {key, code, week}. Writes OUT/matches.csv and OUT/decisions.csv and prints
// one JSON line {matches, decisions}.

import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cardToString, RANKS } from '../../../../engine/src/cards.ts';
import { A_ACCEPT, A_COVER0, A_PLAY0, A_RAISE, A_RUN, A_SIGNAL0, SIGNALS } from '../../../../engine/src/engine.ts';
import { HIDDEN, type Observation } from '../../../../engine/src/observe.ts';
import type { MatchRecord } from '../../../../shared/match-record.ts';
import { decisionType } from '../build.ts';
import { forEachDecision } from '../replay.ts';
import { arg, loadRecord } from './tables.ts';

export const OPTION_KEYS = ['ladder', 'raiseAnyTime', 'bestOf', 'onzeSeesPartner', 'onzeTieToOpponents', 'ironHand', 'faceDownFirstRound', 'allTieToMao', 'signals'] as const;

export const MATCH_COLUMNS = ['match', 'week', 'variant', 'players', 'kind', ...OPTION_KEYS.map((k) => `option_${k}`), 'human_seats', 'ai_version', 'partner_version', 'hands', 'winner_team', 'points_team0', 'points_team1', 'games_team0', 'games_team1'] as const;

export const DECISION_COLUMNS = [
  'match', 'decision', 'hand', 'seat', 'team', 'decider', 'persona', 'hand_kind', 'phase', 'type', 'round', 'value', 'step', 'last_raise_team',
  'dealer', 'mao', 'score_team0', 'score_team1', 'games_team0', 'games_team1', 'vira', 'manilha', 'cards', 'partner_cards', 'table', 'signals_seen',
  'legal', 'action', 'action_name', 'action_card', 'action_signal', 'time_band_s', 'auto',
] as const;

export interface Selection {
  key: string;
  code: string;
  week: string;
}

/** One CSV field: plain text, quoted only when it holds a comma, a quote or a line break. */
export function csvField(v: string | number | boolean | null): string {
  if (v === null) return '';
  const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (fields: (string | number | boolean | null)[]): string => fields.map(csvField).join(',') + '\n';

/** The lower edge of a decision time band, in seconds: 1.5 means from 1.5 s to 2 s; the last band holds every longer time. */
export function timeBand(ms: number | null, binMs = 500, maxS = 120): number | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const top = Math.floor((maxS * 1000) / binMs) * binMs;
  const b = Math.floor(Math.min(Math.max(ms, 0), top) / binMs) * binMs;
  return Math.round(b) / 1000;
}

const card = (c: number) => (c === HIDDEN ? '??' : c < 0 ? '--' : cardToString(c));

export function actionName(a: number): string {
  if (a < A_COVER0) return 'play';
  if (a < A_RAISE) return 'cover';
  if (a === A_RAISE) return 'raise';
  if (a === A_ACCEPT) return 'accept';
  if (a === A_RUN) return 'run';
  return 'signal';
}

function tableText(obs: Observation): string {
  return obs.rounds
    .map((r, k) => `r${k + 1}:` + r.plays.map((p) => `${p.seat}=${p.faceDown ? 'down' : p.card < 0 ? 'down' : cardToString(p.card)}`).join(' '))
    .join(' | ');
}

export function matchRow(rec: MatchRecord, sel: Selection, hands: number): string {
  const o = rec.config.options as unknown as Record<string, string | number | boolean>;
  const humans = rec.seats.filter((s) => s.kind === 'human').map((s) => s.seat);
  return csvRow([
    sel.code, sel.week, rec.config.variant, rec.config.players, rec.kind,
    ...OPTION_KEYS.map((k) => o[k] ?? null),
    humans.join(' '), rec.aiVersion, rec.partnerVersion, hands,
    rec.result.winner, rec.result.score[0], rec.result.score[1], rec.result.games[0], rec.result.games[1],
  ]);
}

export function decisionRowsOf(rec: MatchRecord, sel: Selection, binMs: number, maxS: number): { rows: string[]; hands: number } {
  const rows: string[] = [];
  let hands = 0;
  forEachDecision(rec, (obs, i, seat, action, move) => {
    hands = Math.max(hands, obs.handIndex + 1);
    const s = rec.seats[seat];
    const human = s.kind === 'human';
    const slotCard = action < A_RAISE ? obs.hand[(action - A_PLAY0) % 3] : null;
    rows.push(
      csvRow([
        sel.code, i, obs.handIndex, seat, seat & 1, human ? 'human' : 'ai', human ? null : s.persona,
        obs.kind, obs.phase, decisionType(obs), obs.round, obs.value, obs.step, obs.lastRaiseTeam,
        obs.dealer, obs.mao, obs.score[0], obs.score[1], obs.games[0], obs.games[1],
        cardToString(obs.vira), RANKS[obs.manilhaRank] ?? null,
        obs.hand.map(card).join(' '), obs.partnerHand ? obs.partnerHand.map(card).join(' ') : null,
        tableText(obs), obs.signals.map((g) => `${g.seat}=${SIGNALS[g.signal]}`).join(' '),
        obs.legal, action, actionName(action), slotCard === null ? null : card(slotCard), action >= A_SIGNAL0 ? SIGNALS[action - A_SIGNAL0] : null,
        human && !move.auto ? timeBand(move.ms, binMs, maxS) : null, move.auto,
      ]),
    );
  });
  return { rows, hands };
}

export function writePackageRows(opts: { records: string; selection: Selection[]; out: string; binMs?: number; maxS?: number }): { matches: number; decisions: number } {
  mkdirSync(opts.out, { recursive: true });
  const fm = openSync(join(opts.out, 'matches.csv'), 'w');
  const fd = openSync(join(opts.out, 'decisions.csv'), 'w');
  let decisions = 0;
  try {
    writeSync(fm, csvRow([...MATCH_COLUMNS]));
    writeSync(fd, csvRow([...DECISION_COLUMNS]));
    for (const sel of opts.selection) {
      const rec = loadRecord(opts.records, sel.key);
      const { rows, hands } = decisionRowsOf(rec, sel, opts.binMs ?? 500, opts.maxS ?? 120);
      writeSync(fm, matchRow(rec, sel, hands));
      if (rows.length) writeSync(fd, rows.join(''));
      decisions += rows.length;
    }
  } finally {
    closeSync(fm);
    closeSync(fd);
  }
  return { matches: opts.selection.length, decisions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = arg('records');
  const selection = arg('selection');
  const out = arg('out');
  if (!records || !selection || !out) {
    console.error('usage: opendata.ts --records DIR --selection FILE --out DIR [--time-bin-ms 500] [--max-time-s 120]');
    process.exit(1);
  }
  const sel = readFileSync(selection, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Selection);
  const r = writePackageRows({ records, selection: sel, out, binMs: Number(arg('time-bin-ms') ?? 500), maxS: Number(arg('max-time-s') ?? 120) });
  console.log(JSON.stringify(r));
}
