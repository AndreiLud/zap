// Node part of training/tests/check_warm_start.py: the warm start network (features v2 or
// v2-empty, f32) must play exactly as v1 (int8). Every seat is v1 Zap with its shipped knobs in
// one match and the warm network with the same knobs in the same match (same deal and policy
// seeds), played in lockstep with the public match context passed. Action logs must be identical;
// raw logits and value head must agree within 1e-4 on every visited state.
//
// With "seat-priors" (features v2 only), the warm network's context also carries a prior per seat
// far from the population one (the profile hook of ai/src/opponent-stats.ts, off in the room): the
// statistics inputs must change on many states and the play must still be exactly v1's, since the
// warm start has zero weights on them.
//
// Usage: node training/tests/warm_start_check.ts <v1.zapw> <warm.zapw> [matches per segment] [seed hex2] [seat-priors]

import { readFileSync } from 'node:fs';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { deriveSeed, mulberry32 } from '../../engine/src/rng.ts';
import { agentContext } from '../../ai/src/agent.ts';
import { encoderFor } from '../../ai/src/features.ts';
import { forward, parseModel } from '../../ai/src/mlp.ts';
import { policy } from '../../ai/src/net-agent.ts';
import { personaAgent, type CalibratedKnobs } from '../../ai/src/personas.ts';
import { STATS_SIZE, type SegmentPriors } from '../../ai/src/opponent-stats.ts';
import { SEGMENTS, segmentConfig } from '../../ai/bench/bench-util.ts';

const [v1Path, warmPath] = process.argv.slice(2);
const matches = Number(process.argv[4] ?? 100);
const seedHex = process.argv[5] ?? '75';
const withSeatPriors = process.argv[6] === 'seat-priors';
/** One prior per seat, each far from the population prior and different from the others; answers add up to 1. */
const SEAT_PRIORS: SegmentPriors[] = [0, 1, 2, 3].map((k) => ({ raise: 0.15 + 0.2 * k, run: 0.1 + 0.2 * k, accept: 0.85 - 0.2 * k, reraise: 0.05, shown: 0.2 + 0.2 * k, cover: 0.7 - 0.15 * k }));
const base = seedHex.repeat(32);
const v1 = parseModel(readFileSync(v1Path));
const warm = parseModel(readFileSync(warmPath));
const knobs = (JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8')).personas ?? {}) as CalibratedKnobs;
const e1 = encoderFor(v1.header);
const e2 = encoderFor(warm.header);
const x1 = new Float32Array(e1.size);
const x2 = new Float32Array(e2.size);
const p1 = new Float32Array(e1.size);
const p2 = new Float32Array(e2.size);

/** A random stream that remembers its last draw. */
function recorded(seed: number) {
  const r = mulberry32(seed);
  const f = () => (f.last = r());
  f.last = 0;
  return f;
}

let decisions = 0;
let maxLogit = 0;
let maxValue = 0;
let maxProb = 0;
let mismatches = 0;
let hookedStates = 0;
const traced: { segment: string; match: number; boundaryDistance: number }[] = [];
let k = 0;
for (const seg of SEGMENTS) {
  const { variant, players } = segmentConfig(seg);
  const config = makeConfig(variant, players);
  for (let m = 0; m < matches; m++) {
    const seed = deriveSeed(base, 0x7761726d, k++);
    const s1 = newMatch(config, seed);
    const s2 = newMatch(config, seed);
    const a1 = Array.from({ length: players }, () => personaAgent(v1, 'zap', knobs));
    const a2 = Array.from({ length: players }, () => personaAgent(warm, 'zap', knobs));
    const r1 = recorded(k);
    const r2 = recorded(k);
    while (!s1.over) {
      const seat = expectedActor(s1);
      const o1 = observe(s1, seat);
      const o2 = observe(s2, seat);
      const c1 = agentContext(s1);
      const c2 = withSeatPriors ? { ...agentContext(s2), seatPriors: SEAT_PRIORS.slice(0, players) } : agentContext(s2);
      if (withSeatPriors) {
        e2.encode(o2, x2, agentContext(s2), 'live');
        const plain = x2.slice(e1.size, e1.size + STATS_SIZE);
        e2.encode(o2, x2, c2, 'live');
        if (plain.some((v, i) => v !== x2[e1.size + i])) hookedStates++;
      }
      // Raw outputs on this state.
      e1.encode(o1, x1, c1, 'live');
      const f1 = forward(v1, x1);
      const l1 = Array.from(f1.logits);
      const v1v = f1.value[0];
      e2.encode(o2, x2, c2, 'live');
      const f2 = forward(warm, x2);
      for (let i = 0; i < 15; i++) maxLogit = Math.max(maxLogit, Math.abs(l1[i] - f2.logits[i]));
      maxValue = Math.max(maxValue, Math.abs(v1v - f2.value[0]));
      const q1 = policy(v1, o1, p1, knobs.zap, 0, c1).probs;
      const q2 = policy(warm, o2, p2, knobs.zap, 0, c2).probs;
      for (let i = 0; i < 15; i++) maxProb = Math.max(maxProb, Math.abs(q1[i] - q2[i]));
      const d1 = a1[seat].act(o1, r1, c1);
      const d2 = a2[seat].act(o2, r2, c2);
      decisions++;
      if (d1.action !== d2.action) {
        // Trace: the shared random draw must sit within 1e-6 of a boundary of the cumulative distribution.
        let acc = 0;
        let dist = Infinity;
        for (let i = 0; i < 15; i++) {
          acc += q1[i];
          dist = Math.min(dist, Math.abs(r1.last - acc));
        }
        mismatches++;
        traced.push({ segment: seg, match: m, boundaryDistance: dist });
        break;
      }
      applyAction(s1, seat, d1.action);
      applyAction(s2, seat, d2.action);
    }
  }
}
const untraced = traced.filter((t) => t.boundaryDistance > 1e-6).length;
const ok = maxLogit <= 1e-4 && maxValue <= 1e-4 && untraced === 0 && (!withSeatPriors || hookedStates > 0);
console.log(
  JSON.stringify({
    features: warm.header.features,
    seatPriors: withSeatPriors,
    hookedStates,
    matches: matches * SEGMENTS.length,
    decisions,
    mismatches,
    untracedMismatches: untraced,
    traced,
    maxLogitDiff: maxLogit,
    maxValueDiff: maxValue,
    maxProbDiff: maxProb,
    ok,
  }),
);
