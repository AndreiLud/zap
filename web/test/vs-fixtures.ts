// Fixture records for the tests of "You against Zap" (rating, best hands, records cache): whole
// matches played by the engine with a seeded policy, written as "zap-match/2" records. AI seats
// carry a winProb that is a plain function of the score before their move, so the tests know
// every estimate; the person's moves carry none, as real records do.

import type { PersonaId } from '../../ai/src/personas.ts';
import { makeConfig, type Variant } from '../../engine/src/config.ts';
import { applyAction, legalActions, newMatch, teamOf, type MatchState } from '../../engine/src/engine.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import type { MatchKind, MatchRecord, MoveInfo, RecordSeat } from '../../shared/match-record.ts';
import type { PersonMatch } from '../src/you-vs-zap/history.ts';

/** Picks one of the legal actions (signals left out) for a seat. */
export type Policy = (s: MatchState, seat: number, legal: number[], rng: () => number) => number;

export const randomPolicy: Policy = (_s, _seat, legal, rng) => legal[Math.floor(rng() * legal.length)];

/** The estimate an AI seat gives in these fixtures: its team's lead in points, as a share. */
export function fixtureWinProb(s: MatchState, seat: number): number {
  const mine = teamOf(seat);
  const lead = s.score[mine] - s.score[1 - mine] + 12 * (s.games[mine] - s.games[1 - mine]);
  return Math.min(0.95, Math.max(0.05, 0.5 + lead / 30));
}

export interface FixtureOpts {
  variant?: Variant;
  players?: 2 | 4;
  /** One hex character, repeated for the deal seed. */
  seedChar?: string;
  rng?: number;
  yourSeat?: number;
  kind?: MatchKind;
  /** Version and character of each seat that is not the person (people where `humans` says so). */
  version?: string;
  partnerVersion?: string;
  personas?: Partial<Record<number, PersonaId | null>>;
  humans?: number[];
  /** Policies per seat; random for any seat without one. */
  policy?: Partial<Record<number, Policy>>;
  /** AI seats whose moves carry no estimate (the rules fallback). */
  noEstimate?: boolean;
  abandoned?: number[];
  endedAt?: number;
  matchId?: string;
}

let counter = 0;

/** A valid UUID v4 for a fixture match. */
export function fixtureId(n: number): string {
  const hex = n.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

/** Plays a whole match and returns it as the person's match. */
export function playMatch(o: FixtureOpts = {}): PersonMatch {
  const players = o.players ?? 2;
  const variant = o.variant ?? 'paulista';
  const config = makeConfig(variant, players);
  const seed = (o.seedChar ?? 'a').repeat(64);
  const yourSeat = o.yourSeat ?? 0;
  const humans = new Set([yourSeat, ...(o.humans ?? [])]);
  const rng = mulberry32(o.rng ?? 7);
  const s = newMatch(config, seed);
  const moves: MoveInfo[] = [];
  let guard = 0;
  while (!s.over && guard++ < 20_000) {
    let moved = false;
    for (let seat = 0; seat < s.n && !moved; seat++) {
      const legal = legalActions(s, seat).filter((a) => a < 9);
      if (!legal.length) continue;
      const pick = o.policy?.[seat] ?? randomPolicy;
      const a = pick(s, seat, legal, rng);
      const human = humans.has(seat);
      moves.push({ ms: human ? 1500 : null, auto: false, winProb: human || o.noEstimate ? null : fixtureWinProb(s, seat) });
      applyAction(s, seat, a);
      moved = true;
    }
    if (!moved) throw new Error('no seat could move');
  }
  const version = o.version ?? 'v2';
  const partnerVersion = o.partnerVersion ?? version;
  const seats: RecordSeat[] = Array.from({ length: players }, (_, seat) => {
    if (humans.has(seat)) return { seat, kind: 'human', verified: true, persona: null, aiVersion: null };
    const partnerOfPerson = players === 4 && (seat ^ 2) === yourSeat;
    return { seat, kind: 'ai', verified: false, persona: o.personas?.[seat] === undefined ? 'zap' : o.personas[seat]!, aiVersion: partnerOfPerson ? partnerVersion : version };
  });
  const endedAt = o.endedAt ?? Date.UTC(2026, 10, 1) + ++counter * 60_000;
  const record: MatchRecord = {
    schema: 'zap-match/2',
    engine: 1,
    matchId: o.matchId ?? fixtureId(++counter),
    startedAt: endedAt - 600_000,
    endedAt,
    kind: o.kind ?? (humans.size > 1 ? 'mixed' : players === 2 ? 'solo1' : 'solo2'),
    turnSeconds: 30,
    aiVersion: version,
    partnerVersion,
    arm: null,
    test: true,
    config,
    seed,
    log: [...s.log],
    moves,
    seats,
    abandoned: [...(o.abandoned ?? [])],
    result: { winner: s.winner as 0 | 1, score: [s.score[0], s.score[1]], games: [s.games[0], s.games[1]] },
  };
  return { matchId: record.matchId, yourSeat, record };
}
