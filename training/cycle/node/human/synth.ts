// Synthetic people and bots for the human layer tests (no real person anywhere): the rules engine
// plays whole matches where each "person" keeps one betting style of training/cycle/sim/styles.ts
// and a log-normal decision time of their own, and a few bots show one automation pattern each.
// Writes the records (zap-match/2, test: true), the daily export that links seats to random groups
// (zap-export/1) and an answer key, people.json, that only tests read.
//
// Usage: node training/cycle/node/human/synth.ts --out DIR [--people 30] [--matches 3] [--seed HEX8]
//          [--start ISO] [--bots metronome,clock,volume,script] [--bot-matches 12]
//          [--opt-out 0.2] [--no-adapt 0.2] [--unlinked 0.1] [--flagged 0] [--segment paulista-2]
//
// Bots: metronome (every decision 700 ms within 1%), clock (one match in each of 24 hours in a row), volume
// (--bot-matches matches within two days of ten hours), script (3 matches with the same deal,
// moves and times).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeConfig, type Variant } from '../../../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch } from '../../../../engine/src/engine.ts';
import { observe } from '../../../../engine/src/observe.ts';
import { deriveSeed, mulberry32 } from '../../../../engine/src/rng.ts';
import { BASE_PARAMS, HeuristicAgent } from '../../../../ai/src/heuristic.ts';
import { agentContext } from '../../../../ai/src/agent.ts';
import { styleMove, type Style } from '../../sim/styles.ts';
import { recordKey } from '../simulate.ts';
import { arg } from './tables.ts';

export const PEOPLE_STYLES: readonly Style[] = ['cautious', 'bluffer', 'aggressive', 'caller', 'coverer', 'random'];
export const BOTS = ['metronome', 'clock', 'volume', 'script'] as const;
export type Bot = (typeof BOTS)[number];

export interface Person {
  group: string;
  style: Style;
  bot: Bot | null;
  medianMs: number;
  sigma: number;
  optOut: boolean;
  noAdapt: boolean;
  unlinked: boolean;
  flagged: boolean;
  matches: number;
}

export interface SynthOptions {
  out: string;
  people: number;
  matches: number;
  seed: number;
  start: number;
  bots: Bot[];
  botMatches: number;
  optOut: number;
  noAdapt: number;
  unlinked: number;
  flagged: number;
  /** Every match in this segment ("paulista-2" and so on); otherwise the four segments in turn. */
  segment?: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function uuid(rand: () => number): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  h[12] = '4';
  h[16] = '89ab'[Math.floor(rand() * 4)];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const hex = (rand: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');

interface Plan {
  person: Person;
  variant: Variant;
  players: 2 | 4;
  humanSeat: number;
  startedAt: number;
  dealSeed: string;
  moveSeed: number;
  idSeed: number;
}

/** One match of one person against heuristic AIs, as a zap-match/2 test record. */
function play(p: Plan): Record<string, unknown> {
  const config = makeConfig(p.variant, p.players);
  const rand = mulberry32(p.moveSeed);
  const timeRand = mulberry32(p.moveSeed ^ 0x5bd1e995);
  const idRand = mulberry32(p.idSeed);
  const s = newMatch(config, p.dealSeed);
  const ai = new HeuristicAgent(BASE_PARAMS, 'ai');
  const moves: { ms: number | null; auto: boolean; winProb: number | null }[] = [];
  let t = p.startedAt;
  let guard = 0;
  while (!s.over) {
    const seat = expectedActor(s);
    const obs = observe(s, seat);
    let action: number;
    if (seat === p.humanSeat) {
      action = p.person.bot === 'metronome' || p.person.bot === 'script' ? styleMove('caller', obs, rand) : styleMove(p.person.style, obs, rand);
      let ms: number;
      if (p.person.bot === 'metronome') ms = Math.round(700 * (1 + 0.01 * (2 * timeRand() - 1)));
      else if (p.person.bot === 'script') ms = 1000;
      else {
        const z = Math.sqrt(-2 * Math.log(1 - timeRand())) * Math.cos(2 * Math.PI * timeRand());
        ms = Math.max(260, Math.round(p.person.medianMs * Math.exp(p.person.sigma * z)));
      }
      moves.push({ ms, auto: false, winProb: null });
      t += ms;
    } else {
      action = ai.act(obs, rand, agentContext(s)).action;
      moves.push({ ms: null, auto: false, winProb: Math.round(timeRand() * 1000) / 1000 });
      t += 700;
    }
    applyAction(s, seat, action);
    if (++guard > 100_000) throw new Error('match did not end');
  }
  const seats = Array.from({ length: p.players }, (_, i) => {
    const human = i === p.humanSeat;
    return { seat: i, kind: human ? 'human' : 'ai', verified: human, persona: human ? null : 'zap', aiVersion: human ? null : 'v1' };
  });
  return {
    schema: 'zap-match/2',
    engine: 1,
    matchId: uuid(idRand),
    startedAt: p.startedAt,
    endedAt: t,
    kind: p.players === 2 ? 'solo1' : 'solo2',
    turnSeconds: 30,
    aiVersion: 'v1',
    partnerVersion: 'v1',
    arm: null,
    test: true,
    config: { variant: config.variant, players: config.players, options: { ...config.options } },
    seed: s.seed,
    log: [...s.log],
    moves,
    seats,
    abandoned: [],
    result: { winner: s.winner, score: [s.score[0], s.score[1]], games: [s.games[0], s.games[1]] },
  };
}

const SEGMENTS: [Variant, 2 | 4][] = [['paulista', 2], ['paulista', 4], ['mineiro', 2], ['mineiro', 4]];

export function synthesize(o: SynthOptions): { people: Person[]; records: number; exportRows: number } {
  const rand = mulberry32(o.seed);
  const people: Person[] = [];
  for (let i = 0; i < o.people; i++) {
    people.push({
      group: hex(rand, 16),
      style: PEOPLE_STYLES[i % PEOPLE_STYLES.length],
      bot: null,
      medianMs: Math.round(600 * Math.exp(rand() * Math.log(4))),
      sigma: 0.5 + 0.3 * rand(),
      optOut: rand() < o.optOut,
      noAdapt: rand() < o.noAdapt,
      unlinked: rand() < o.unlinked,
      flagged: rand() < o.flagged,
      matches: o.matches,
    });
  }
  for (const bot of o.bots) {
    // Only the metronome and the script keep fixed times; the others vary like people.
    const n = bot === 'clock' ? 24 : bot === 'script' ? 3 : o.botMatches;
    people.push({ group: hex(rand, 16), style: 'caller', bot, medianMs: 900, sigma: 0.6, optOut: false, noAdapt: false, unlinked: false, flagged: false, matches: n });
  }
  const recordsDir = join(o.out, 'records');
  const rows: Record<string, unknown>[] = [];
  let records = 0;
  let k = 0;
  const fixedSeg = o.segment ? SEGMENTS.find(([v, n]) => `${v}-${n}` === o.segment) : undefined;
  for (const person of people) {
    const scriptSeed = hex(rand, 64);
    for (let j = 0; j < person.matches; j++, k++) {
      const [variant, players] = fixedSeg ?? SEGMENTS[(k + j) % 4];
      let startedAt: number;
      // One match an hour, day and night, within one day.
      if (person.bot === 'clock') startedAt = o.start + 2 * DAY + j * HOUR;
      else if (person.bot === 'volume') {
        // Two days, ten hours each: many matches, but not around the clock.
        const perDay = Math.ceil(person.matches / 2);
        startedAt = o.start + (j % 2) * DAY + 10 * HOUR + Math.floor(j / 2) * Math.floor((10 * HOUR) / perDay);
      }
      else startedAt = o.start + Math.floor(rand() * 6) * DAY + (12 + Math.floor(rand() * 8)) * HOUR + Math.floor(rand() * 50) * 60_000;
      const script = person.bot === 'script';
      const rec = play({
        person,
        variant: script ? 'paulista' : variant,
        players: script ? 2 : players,
        humanSeat: script ? 0 : players === 2 ? j % 2 : j % 4,
        startedAt,
        dealSeed: script ? deriveSeed(scriptSeed, 0x73696d31, 0) : deriveSeed(hex(rand, 64), 0x73696d31, 0),
        moveSeed: script ? 0x51c0ffee : Math.floor(rand() * 0xffffffff),
        idSeed: Math.floor(rand() * 0xffffffff),
      });
      const key = recordKey(rec as { matchId: string; endedAt: number });
      mkdirSync(dirname(join(recordsDir, key)), { recursive: true });
      writeFileSync(join(recordsDir, key), JSON.stringify(rec));
      records++;
      if (!person.unlinked) {
        const seat = (rec.seats as { seat: number; kind: string }[]).find((s) => s.kind === 'human')!.seat;
        rows.push({ matchId: rec.matchId, seat, weight: person.flagged ? 0 : 1, flagged: person.flagged, openDataOptOut: person.optOut, noAdapt: person.noAdapt, group: person.group });
      }
    }
  }
  const date = new Date(o.start + 7 * DAY).toISOString().slice(0, 10);
  const ex = { schema: 'zap-export/1', date, createdAt: o.start + 7 * DAY, partial: false, rows, reports: [] as unknown[] };
  const target = people.find((p) => !p.unlinked && !p.bot);
  if (target) ex.reports.push({ id: 1, day: date, reason: 'nickname', matchId: null, seat: 0, group: target.group });
  writeFileSync(join(o.out, 'export.json'), JSON.stringify(ex));
  writeFileSync(join(o.out, 'people.json'), JSON.stringify(people, null, 2) + '\n');
  return { people, records, exportRows: rows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = arg('out');
  if (!out) {
    console.error('usage: synth.ts --out DIR [--people N] [--matches M] [--seed HEX8] [--start ISO] [--bots LIST] [--bot-matches N] [--opt-out P] [--no-adapt P] [--unlinked P] [--flagged P] [--segment SEG]');
    process.exit(1);
  }
  const bots = (arg('bots') ?? '').split(',').filter(Boolean) as Bot[];
  for (const b of bots) if (!BOTS.includes(b)) throw new Error(`unknown bot ${b}`);
  const r = synthesize({
    out,
    people: Number(arg('people') ?? 30),
    matches: Number(arg('matches') ?? 3),
    seed: parseInt(arg('seed') ?? '5eed0001', 16),
    start: Date.parse(arg('start') ?? '2026-11-02T00:00:00Z'),
    bots,
    botMatches: Number(arg('bot-matches') ?? 12),
    optOut: Number(arg('opt-out') ?? 0.2),
    noAdapt: Number(arg('no-adapt') ?? 0.2),
    unlinked: Number(arg('unlinked') ?? 0.1),
    flagged: Number(arg('flagged') ?? 0),
    segment: arg('segment'),
  });
  console.log(JSON.stringify({ people: r.people.length, records: r.records, exportRows: r.exportRows }));
}
