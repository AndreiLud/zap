// Writes shared/profile-priors-default.json, the bundled population priors of the reading "Como o
// Zap te lê" (zap-priors/1, source "selfplay"), used until the training cycle imports priors
// fitted on people (control/priors.json).
//
// How: v1 Zap against v1 Zap (the bundled model, knobs "zap"), MATCHES matches per rules segment
// with a fixed seed, one thread. Every seat is counted as a person through profileCounts
// (shared/profile.ts) with no decision times. Each number's mean is the pooled x over the pooled n
// of every seat of every match, with strength 2 (a weak prior: a few of a person's own decisions
// already move it) and people null. readingSegments holds bluff per rules segment, the pooled x
// over n of that segment's seats. segments and alpha are copied from ai/models/opponent-priors.json (the
// in-match statistics' priors). The decision time prior {mu: ln 3000, tau: 1, sigma: 1} holds weak
// constants chosen by design, not a measure: self-play has no decision times. It is never shown to
// people: a time shows only once a person's own times narrow it down.
//
// It also prints shownCardVariance: the variance of one shown card's strength / 13 (a card shown
// face up in a hand where its seat raised, as countHands counts S and Q) around the mean of its
// rules segment, pooled over the segments. shared/profile.ts SHOWN_CARD_VARIANCE comes from it.
//
//   docker compose run --rm -T node node shared/make-default-priors.ts [--matches 200] [--seed 6d]

import { readFileSync, writeFileSync } from 'node:fs';
import { strengthTable } from '../engine/src/cards.ts';
import { makeConfig } from '../engine/src/config.ts';
import { publicHistory } from '../engine/src/public.ts';
import { applyAction, expectedActor, newMatch } from '../engine/src/engine.ts';
import { observe } from '../engine/src/observe.ts';
import { mulberry32 } from '../engine/src/rng.ts';
import { seriesSeed } from '../engine/src/simulate.ts';
import { agentContext } from '../ai/src/agent.ts';
import { parseModel } from '../ai/src/mlp.ts';
import { personaAgent, type CalibratedKnobs } from '../ai/src/personas.ts';
import { SEGMENTS } from '../ai/src/opponent-stats.ts';
import { READING_KEYS, SCHEMAS, validatePriorsFile, type PriorsFile } from './cycle-formats.ts';
import { addCounts, emptyProfile, observationCounts, profileCounts, readingCounts } from './profile.ts';
import type { MoveInfo } from './match-record.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const MATCHES = Number(arg('matches', '200'));
const SEED = arg('seed', '6d');
const OUT = arg('out', 'shared/profile-priors-default.json');

const manifest = JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8')) as { personas: CalibratedKnobs; sha256: string };
const model = parseModel(readFileSync('ai/models/bootstrap/zap-v1.zapw'));
const inMatch = JSON.parse(readFileSync('ai/models/opponent-priors.json', 'utf8')) as { alpha: number; segments: Record<string, Record<string, number>> };

const started = Date.now();
let total = emptyProfile();
const perSegment = SEGMENTS.map(() => emptyProfile());
let decisions = 0;
/** Per segment: count, sum and sum of squares of shown card values (strength / 13). */
const shownCards = SEGMENTS.map(() => ({ n: 0, s: 0, s2: 0 }));
for (const [si, seg] of SEGMENTS.entries()) {
  const [variant, players] = seg.split('-');
  for (let m = 0; m < MATCHES; m++) {
    const config = makeConfig(variant as 'paulista' | 'mineiro', Number(players) as 2 | 4);
    const seed = seriesSeed(SEED.padEnd(64, '0'), si * 100_000 + m);
    const s = newMatch(config, seed);
    const agents = Array.from({ length: s.n }, () => personaAgent(model, 'zap', manifest.personas));
    const rand = mulberry32(si * 100_000 + m);
    const log: number[] = [];
    const moves: MoveInfo[] = [];
    while (!s.over) {
      const seat = expectedActor(s);
      const a = agents[seat].act(observe(s, seat), rand, agentContext(s)).action;
      log.push(seat * 16 + a);
      moves.push({ ms: null, auto: false, winProb: null });
      applyAction(s, seat, a);
    }
    decisions += log.length;
    const h = publicHistory(s);
    for (const hand of h.hands) {
      const strength = strengthTable(h.variant, hand.manilhaRank);
      let raised = 0;
      for (const b of hand.bets) if (b.kind === 'raise') raised |= 1 << b.seat;
      for (const round of hand.rounds) {
        for (const play of round.plays) {
          if (play.faceDown || play.card < 0 || !((raised >> play.seat) & 1)) continue;
          const v = strength[play.card] / 13;
          shownCards[si].n++;
          shownCards[si].s += v;
          shownCards[si].s2 += v * v;
        }
      }
    }
    for (const p of profileCounts({ config, seed, log, moves, seats: Array.from({ length: s.n }, () => ({ kind: 'human' as const })) })) {
      total = addCounts(total, p.counts);
      perSegment[si] = addCounts(perSegment[si], p.counts);
    }
  }
}

const rc = readingCounts(total);
const out: PriorsFile = {
  schema: SCHEMAS.priors,
  createdAt: Date.now(),
  source: 'selfplay',
  people: null,
  numbers: Object.fromEntries(READING_KEYS.map((k) => [k, { mean: Math.round((rc[k].x / rc[k].n) * 1e6) / 1e6, strength: 2, people: null }])) as PriorsFile['numbers'],
  time: { mu: Math.log(3000), tau: 1, sigma: 1 },
  alpha: inMatch.alpha,
  segments: Object.fromEntries(
    SEGMENTS.map((seg) => {
      const p = inMatch.segments[seg];
      return [seg, { raise: p.raise, run: p.run, accept: p.accept, reraise: p.reraise, shown: p.shown, cover: p.cover }];
    }),
  ) as PriorsFile['segments'],
  readingSegments: Object.fromEntries(
    SEGMENTS.map((seg, si) => {
      const b = observationCounts(perSegment[si]).bluff;
      return [seg, { bluff: Math.round((b.x / b.n) * 1e6) / 1e6 }];
    }),
  ) as PriorsFile['readingSegments'],
};
const checked = validatePriorsFile(out);
if (!checked.ok) throw new Error(checked.errors.join('; '));
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(
  JSON.stringify({
    out: OUT,
    model: manifest.sha256,
    matchesPerSegment: MATCHES,
    seed: SEED,
    decisions,
    seats: total.matches,
    n: Object.fromEntries(READING_KEYS.map((k) => [k, observationCounts(total)[k].n])),
    bluffChances: Object.fromEntries(SEGMENTS.map((seg, si) => [seg, observationCounts(perSegment[si]).bluff.n])),
    shownCards: shownCards.reduce((a, c) => a + c.n, 0),
    shownCardVariance: Math.round((shownCards.reduce((a, c) => a + (c.n > 0 ? c.s2 - (c.s * c.s) / c.n : 0), 0) / shownCards.reduce((a, c) => a + c.n, 0)) * 1e4) / 1e4,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  }),
);
