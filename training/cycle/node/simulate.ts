// Simulated match records for the cycle's tests and the local end to end run with fixtures: the
// rules engine plays a whole match with heuristic players (the "people" vary their style), and
// the record is written in the zap-match/1 or zap-match/2 layout of shared/match-record.ts.
// Nothing here is a real person: every record made for MinIO carries test: true.

import { makeConfig, type MatchConfig, type Variant } from '../../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch } from '../../../engine/src/engine.ts';
import { observe } from '../../../engine/src/observe.ts';
import { deriveSeed, mulberry32 } from '../../../engine/src/rng.ts';
import { RandomAgent, agentContext, type Agent } from '../../../ai/src/agent.ts';
import { BASE_PARAMS, HeuristicAgent, type HeuristicParams } from '../../../ai/src/heuristic.ts';

export type Kind = 'solo1' | 'solo2' | 'friends' | 'humans' | 'mixed';

export interface SimOptions {
  /** 64 hex characters; everything (deal, players, times, match id) follows from it. */
  seed: string;
  variant: Variant;
  players: 2 | 4;
  kind: Kind;
  humanSeats: number[];
  schema: 1 | 2;
  startedAt: number;
  test?: boolean;
  aiVersion?: string;
  partnerVersion?: string;
  arm?: 'candidate' | 'control' | null;
  /** Median decision time of the people, in ms. */
  medianMs?: number;
  /** Share of a person's moves made by the AI for them (auto). */
  autoShare?: number;
  /** Style of the people: 'random' or a share in (0, 1) of extra aggression. */
  style?: 'random' | 'cautious' | 'bold';
  abandoned?: number[];
}

function uuidFrom(rand: () => number): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  h[12] = '4';
  h[16] = '89ab'[Math.floor(rand() * 4)];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function personAgent(style: SimOptions['style']): Agent {
  if (style === 'random') return new RandomAgent();
  const p: HeuristicParams = { ...BASE_PARAMS };
  return new HeuristicAgent(p, style ?? 'base');
}

export function simulateRecord(o: SimOptions): Record<string, unknown> {
  const config: MatchConfig = makeConfig(o.variant, o.players);
  const rand = mulberry32(parseInt(o.seed.slice(0, 8), 16));
  const timeRand = mulberry32(parseInt(o.seed.slice(8, 16), 16));
  const human = new Set(o.humanSeats);
  const agents: Agent[] = Array.from({ length: o.players }, (_, s) => (human.has(s) ? personAgent(o.style) : new HeuristicAgent(BASE_PARAMS, 'ai')));
  const s = newMatch(config, deriveSeed(o.seed, 0x73696d31, 0));
  const moves: { ms: number | null; auto: boolean; winProb: number | null }[] = [];
  const median = o.medianMs ?? 1500;
  let t = o.startedAt;
  let guard = 0;
  while (!s.over) {
    const seat = expectedActor(s);
    const obs = observe(s, seat);
    const d = agents[seat].act(obs, rand, agentContext(s));
    if (human.has(seat)) {
      const auto = timeRand() < (o.autoShare ?? 0);
      const ms = auto ? null : Math.max(150, Math.round(median * Math.exp(0.6 * (timeRand() + timeRand() + timeRand() - 1.5))));
      moves.push({ ms, auto, winProb: auto ? 0.5 : null });
      t += ms ?? 15000;
    } else {
      moves.push({ ms: null, auto: false, winProb: Math.round(timeRand() * 1000) / 1000 });
      t += 700;
    }
    applyAction(s, seat, d.action);
    if (++guard > 100_000) throw new Error('match did not end');
  }
  const aiVersion = o.aiVersion ?? 'v1';
  const partnerVersion = o.partnerVersion ?? aiVersion;
  const seats = Array.from({ length: o.players }, (_, i) => {
    const isHuman = human.has(i);
    const base = { seat: i, kind: isHuman ? 'human' : 'ai', verified: isHuman, persona: isHuman ? null : 'zap' };
    if (o.schema === 1) return base;
    const partnerHuman = o.players === 4 && human.has(i ^ 2);
    return { ...base, aiVersion: isHuman ? null : partnerHuman ? partnerVersion : aiVersion };
  });
  const rec: Record<string, unknown> = {
    schema: o.schema === 1 ? 'zap-match/1' : 'zap-match/2',
    engine: 1,
    matchId: uuidFrom(rand),
    startedAt: o.startedAt,
    endedAt: t,
    kind: o.kind,
    turnSeconds: 30,
    aiVersion,
    config: { variant: config.variant, players: config.players, options: { ...config.options } },
    seed: s.seed,
    log: [...s.log],
    moves,
    seats,
    abandoned: [...(o.abandoned ?? [])].sort((a, b) => a - b),
    result: { winner: s.winner, score: [s.score[0], s.score[1]], games: [s.games[0], s.games[1]] },
  };
  if (o.schema === 2) {
    rec.partnerVersion = partnerVersion;
    rec.arm = o.arm ?? null;
    rec.test = o.test ?? false;
  }
  return rec;
}

/** R2 key of a record, as shared/match-record.ts matchRecordKey. */
export function recordKey(rec: { matchId: unknown; endedAt: unknown }): string {
  const d = new Date(rec.endedAt as number);
  const p = (n: number) => String(n).padStart(2, '0');
  return `matches/v1/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${rec.matchId as string}.json`;
}
