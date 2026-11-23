// CPU time of one AI decision (observe, public history, encode, forward, safety net, sample) and
// of a Durable Object event, on this machine: one action of the person, then every AI decision
// that follows until the person acts again (signals included), up to the room's cap of
// MAX_AI_MOVES_PER_EVENT (worker/src/room-core.ts). The older measure with at most three AI
// decisions per event is kept beside it. The Workers Free plan allows 10 ms of CPU per
// invocation; the target is a p99 of 6 ms per room event.
//
// Usage: node ai/bench/decision-time.ts [model.zapw] [--features v1|v2] [--write-facts] [--adaptive-facts]
//   Without a model file: a synthetic int8 network with the production shape (--features v2 uses
//   ai/models/opponent-priors.json).
//   --write-facts     stores the result under ai.decisionTime in facts.json.
//   --adaptive-facts  also measures v1 in the same run as a reference and stores both under
//                     ai.adaptation.decisionTime (with the share of decisions that needed two passes).

import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, newMatch } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { seriesSeed } from '../../engine/src/simulate.ts';
import { agentContext } from '../src/agent.ts';
import { NUM_FEATURES, NUM_FEATURES_V2 } from '../src/features.ts';
import { buildModelFile, parseModel, type Model, type RawLayer } from '../src/mlp.ts';
import { NetAgent } from '../src/net-agent.ts';
import { validatePriors } from '../src/opponent-stats.ts';
import { persona } from '../src/personas.ts';
import { MAX_AI_MOVES_PER_EVENT } from '../../worker/src/room-core.ts';
import { PRIORS_FILE, V1_MODEL, arg, evalOut, flag, modelHashes, requireSafetyNet, saveResult } from './bench-util.ts';

function syntheticModel(hidden: number[], features: 'v1' | 'v2'): Model {
  const rand = mulberry32(7);
  const inputs = features === 'v2' ? NUM_FEATURES_V2 : NUM_FEATURES;
  const dims = [inputs, ...hidden];
  const layers: RawLayer[] = [];
  const mk = (name: string, rows: number, cols: number): RawLayer => ({
    name,
    rows,
    cols,
    weight: Float32Array.from({ length: rows * cols }, () => (rand() - 0.5) * 0.2),
    bias: new Float32Array(rows),
  });
  hidden.forEach((h, i) => layers.push(mk(`trunk.${i}`, h, dims[i])));
  layers.push(mk('policy', 15, hidden[hidden.length - 1]), mk('value', 1, hidden[hidden.length - 1]));
  const meta = features === 'v2' ? { priors: validatePriors(JSON.parse(readFileSync(PRIORS_FILE, 'utf8'))), adapt: { bmax: 0.1, nHalf: 2 } } : undefined;
  return parseModel(buildModelFile({ arch: 'mlp-v1', features, inputs, hidden, policy: 15, value: 1, meta }, layers, 'i8'));
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Plays 60 matches per segment: seat 0 is the person; an event is their action plus the AI decisions that follow it. */
function measure(model: Model, zapKnobs: boolean) {
  const knobs = zapKnobs ? persona('zap').knobs : undefined;
  const agent = new NetAgent(model, knobs, 'zap');
  const rand = mulberry32(11);
  const decision: number[] = [];
  const events: number[] = [];
  const roomEvents: number[] = [];
  let twoPass = 0;
  let adaptive = 0;
  for (let warm = 0; warm < 2; warm++) {
    decision.length = 0;
    events.length = 0;
    roomEvents.length = 0;
    twoPass = 0;
    adaptive = 0;
    let k = 0;
    for (const variant of ['paulista', 'mineiro'] as const) {
      for (const players of [2, 4] as const) {
        const config = makeConfig(variant, players);
        for (let m = 0; m < 60; m++) {
          const s = newMatch(config, seriesSeed('9d'.repeat(32), k++));
          while (!s.over) {
            const seat = expectedActor(s);
            if (seat === 0) {
              applyAction(s, 0, new NetAgent(model, knobs).act(observe(s, 0), rand, agentContext(s)).action);
              const e0 = performance.now();
              let ai = 0;
              let three = -1;
              while (!s.over && expectedActor(s) !== 0 && ai < MAX_AI_MOVES_PER_EVENT) {
                const t0 = performance.now();
                const st = expectedActor(s);
                // The room builds the context for every AI decision, so it is part of the time.
                applyAction(s, st, agent.act(observe(s, st), rand, agentContext(s)).action);
                decision.push(performance.now() - t0);
                if (agent.lastAdapt) {
                  adaptive++;
                  if (agent.lastAdapt.passes === 2) twoPass++;
                }
                ai++;
                if (ai === 3) three = performance.now() - e0;
              }
              const total = performance.now() - e0;
              events.push(three >= 0 ? three : total);
              roomEvents.push(total);
            } else {
              applyAction(s, seat, agent.act(observe(s, seat), rand, agentContext(s)).action);
            }
          }
        }
      }
    }
  }
  return {
    features: model.header.features,
    hidden: model.header.hidden,
    decisions: decision.length,
    decisionMs: { p50: q(decision, 0.5), p99: q(decision, 0.99), max: Math.max(...decision) },
    eventsWithUpToThreeAiDecisions: events.length,
    eventMs: { p50: q(events, 0.5), p99: q(events, 0.99), max: Math.max(...events) },
    roomEvents: roomEvents.length,
    roomEventMs: { p50: q(roomEvents, 0.5), p99: q(roomEvents, 0.99), max: Math.max(...roomEvents) },
    twoPassShare: adaptive ? twoPass / decision.length : 0,
  };
}

const path = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const features = (arg('features', 'v1') === 'v2' ? 'v2' : 'v1') as 'v1' | 'v2';
const model = path ? parseModel(readFileSync(path)) : syntheticModel([256, 256], features);
const adaptiveFacts = flag('adaptive-facts');
// The adaptive measurement times the model as served: it needs its safety net.
if (path && adaptiveFacts) requireSafetyNet(path);
const main = measure(model, adaptiveFacts);
const report = {
  measuredAt: new Date().toISOString(),
  cpu: cpus()[0]?.model ?? 'unknown',
  node: process.version,
  model: path ?? `synthetic int8 network with the production shape (features ${features})`,
  ...main,
};
console.log(JSON.stringify(report, null, 2));
if (flag('write-facts')) {
  const p = new URL('../../facts.json', import.meta.url);
  let facts: Record<string, any> = {};
  try {
    facts = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    facts = {};
  }
  const { twoPassShare: _t, features: _f, ...plain } = report;
  void _t;
  void _f;
  facts.ai = { ...(facts.ai ?? {}), decisionTime: plain };
  writeFileSync(p, JSON.stringify(facts, null, 2) + '\n');
}
if (adaptiveFacts) {
  const v1 = measure(parseModel(readFileSync(V1_MODEL)), true);
  console.log(JSON.stringify({ v1Reference: v1 }, null, 2));
  const facts = {
    decisionTime: {
    measuredAt: report.measuredAt,
    method: `Zap knobs, 60 matches per segment (seed 9d), seat 0 played by the same network as the person; each AI decision includes observe, the public history, encoding, the forward passes and the safety net. A room event is one action of the person plus every AI decision that follows until the person acts again (signals included), at most ${MAX_AI_MOVES_PER_EVENT} as in the room; eventUpToThreeMs counts only the first three AI decisions. v1 measured in the same run as a reference.`,
    model: report.model,
    cpu: report.cpu,
    node: report.node,
    decisions: report.decisions,
    decisionMs: report.decisionMs,
    roomEventMs: report.roomEventMs,
    eventUpToThreeMs: report.eventMs,
    twoPassShare: report.twoPassShare,
    targetEventP99Ms: 6,
    meetsTarget: report.roomEventMs.p99 <= 6,
    v1Reference: { model: V1_MODEL, decisionMs: v1.decisionMs, roomEventMs: v1.roomEventMs, eventUpToThreeMs: v1.eventMs },
    models: path ? modelHashes({ adaptive: path }) : null,
    },
  };
  saveResult(arg('out', evalOut(path ?? 'training/runs/m6-adaptive/export/x', 'decision-time'))!, { facts }, true);
}
