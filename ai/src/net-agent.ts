// The network as a player, with the personality knobs applied at decision time.
//
// A model with features v2 also reads public statistics of the other players in this match
// (opponent-stats.ts). Its decisions then go through the safety net (safety.ts): the policy that
// reads the opponent may move away from the policy with no evidence only as far as the evidence
// allows. The budget bounds the distribution each character actually plays: both policies get
// the character's knobs (offsets and temperature) first, and the net mixes those.

import { A_ACCEPT, A_RAISE, A_RUN, A_SIGNAL0, NUM_ACTIONS } from '../../engine/src/engine.ts';
import type { Observation } from '../../engine/src/observe.ts';
import { strengthTable } from '../../engine/src/cards.ts';
import type { Agent, AgentContext, Decision } from './agent.ts';
import { STATS_OFFSET, encoderFor, fromCanonical, quantize, toCanonical, type Canonical, type Encoder } from './features.ts';
import { BASE_PARAMS, handEstimate, heuristicDecision, type HeuristicParams } from './heuristic.ts';
import { forward, maskedSoftmax, sample, winProb, type Model } from './mlp.ts';
import { decisionEvidence, matchCounts, STATS_SIZE } from './opponent-stats.ts';
import { blend, budget, moved, type SafetyNet } from './safety.ts';

export { quantize };

export interface Knobs {
  /** Softmax temperature: above 1 plays more varied, below 1 more greedy. */
  temperature: number;
  /** Logit offsets by action type. */
  raise: number;
  accept: number;
  run: number;
  cover: number;
  /** Extra raise logit when the hand estimate is in the weak third (bluffs). */
  bluff: number;
  /** Chance of replacing the chosen signal with a random other one. */
  signalLie: number;
  /**
   * Betting style: in a share of the bet decisions (raise or not, accept, run, raise again,
   * mão de onze), the character follows this heuristic instead of the network. Card play always
   * comes from the network.
   */
  style: HeuristicParams | null;
  styleShare: number;
  /** Ravi: styles to switch among, one drawn at the start of each hand. */
  switchStyles: HeuristicParams[] | null;
  /** Conditioning vector given to the network (zeros for the base player). */
  persona: number[];
}

export const NEUTRAL_KNOBS: Knobs = { temperature: 1, raise: 0, accept: 0, run: 0, cover: 0, bluff: 0, signalLie: 0, style: null, styleShare: 0, switchStyles: null, persona: [] };

export interface NetOptions {
  /** 'live' (default): statistics from the context; 'empty': no evidence (ablation, or adaptation switched off in the room). */
  stats?: 'live' | 'empty';
  /** 'model' (default): the model's meta.adapt when present, else off. 'off': the raw network. */
  safety?: 'model' | 'off' | SafetyNet;
}

/** What the safety net did at one decision (for the benches). */
export interface AdaptInfo {
  /** Evidence behind the decision (opponent-stats.ts decisionEvidence). */
  n: number;
  /** KL budget for that evidence (nats). */
  budget: number;
  /**
   * KL of the policy with statistics from the policy without, both with the character's knobs and
   * temperature (nats); NaN when not computed.
   */
  kl: number;
  /** Weight of the policy with statistics after the net. */
  lambda: number;
  /** KL of the distribution played from the one the same character plays without statistics (nats). */
  klApplied: number;
  /** Total variation between the two (share of probability moved). */
  tv: number;
  /** The most likely action changed. */
  topChanged: boolean;
  /** Forward passes used. */
  passes: 1 | 2;
}

export interface PolicyOutput {
  canonical: Canonical;
  probs: Float64Array;
  winProb: number;
  /** Evidence behind the decision (0 for v1 models, which have no statistics block). */
  n: number;
  /** null for models that do not read live statistics. */
  adapt: AdaptInfo | null;
}

function safetyOf(model: Model, s: NetOptions['safety']): SafetyNet | null {
  if (s === 'off') return null;
  if (s === undefined || s === 'model') {
    const a = model.header.meta?.adapt;
    return a && a.bmax !== Infinity ? { bmax: a.bmax, nHalf: a.nHalf } : null;
  }
  return s.bmax === Infinity ? null : s;
}

function sameStats(x: Float32Array, x0: Float32Array): boolean {
  for (let i = STATS_OFFSET; i < STATS_OFFSET + STATS_SIZE; i++) if (x[i] !== x0[i]) return false;
  return true;
}

const scratch = new Map<number, Float32Array>();
function scratchOf(size: number): Float32Array {
  let x = scratch.get(size);
  if (!x) {
    x = new Float32Array(size);
    scratch.set(size, x);
  }
  return x;
}

/**
 * Runs the network on an observation, writing the quantized features into x (length of the
 * model's encoder). ctx carries the public history for models with statistics; x0 is scratch
 * space of the same length for the no-evidence pass.
 */
export function policy(
  model: Model,
  obs: Observation,
  x: Float32Array,
  knobs: Knobs = NEUTRAL_KNOBS,
  removeMask = 0,
  ctx?: AgentContext,
  opts: NetOptions = {},
  x0?: Float32Array,
): PolicyOutput {
  const enc: Encoder = encoderFor(model.header);
  const stats = opts.stats ?? 'live';
  enc.encode(obs, x, ctx, stats, knobs.persona);
  const canonical = toCanonical(obs, strengthTable(obs.variant, obs.manilhaRank));
  canonical.mask &= ~removeMask;
  let logits: Float64Array;
  let wp: number;
  let n = 0;
  let adapt: AdaptInfo | null = null;
  // The evidence is a public fact of the match: it is reported for every model with the
  // statistics block (the twin too), so training records mean the same thing in both runs. A
  // table with a seat in the noStats mask reads no evidence at all (see features.ts).
  const masked = (ctx?.noStats ?? 0) !== 0;
  if (enc.size > STATS_OFFSET && ctx && !masked) n = decisionEvidence(obs, matchCounts(ctx.history), 0);
  if (enc.usesStats && stats === 'live' && ctx && !masked) {
    const net = safetyOf(model, opts.safety);
    if (!net) {
      // The raw network: one pass with the statistics.
      const f = forward(model, x);
      logits = Float64Array.from(f.logits);
      wp = winProb(f);
      adapt = { n, budget: Infinity, kl: NaN, lambda: 1, klApplied: NaN, tv: NaN, topChanged: false, passes: 1 };
    } else {
      const xs0 = x0 ?? scratchOf(enc.size);
      enc.emptyCopy(obs, x, xs0);
      const b = budget(n, net);
      if (b === 0 || sameStats(x, xs0)) {
        const f = forward(model, xs0);
        logits = Float64Array.from(f.logits);
        wp = winProb(f);
        adapt = { n, budget: b, kl: sameStats(x, xs0) ? 0 : NaN, lambda: 0, klApplied: 0, tv: 0, topChanged: false, passes: 1 };
      } else {
        // forward() reuses its buffers: copy the first pass before the second.
        const f1 = forward(model, x);
        const l1 = Float64Array.from(f1.logits);
        wp = winProb(f1);
        const l0 = Float64Array.from(forward(model, xs0).logits);
        // The net works on what this character plays: knob offsets added to both passes, then
        // divided by the temperature, so the budget bounds KL(played || played without statistics).
        addKnobs(l0, obs, canonical.mask, knobs);
        addKnobs(l1, obs, canonical.mask, knobs);
        const t = knobs.temperature;
        for (let a = 0; a < l0.length; a++) {
          l0[a] /= t;
          l1[a] /= t;
        }
        const r = blend(l0, l1, canonical.mask, b);
        const m = moved(r.logits, l0, canonical.mask);
        adapt = { n, budget: b, kl: r.klRaw, lambda: r.lambda, klApplied: r.kl, tv: m.tv, topChanged: m.topChanged, passes: 2 };
        return { canonical, probs: maskedSoftmax(r.logits, canonical.mask, 1), winProb: wp, n, adapt };
      }
    }
  } else {
    const f = forward(model, x);
    logits = Float64Array.from(f.logits);
    wp = winProb(f);
  }
  addKnobs(logits, obs, canonical.mask, knobs);
  const probs = maskedSoftmax(logits, canonical.mask, knobs.temperature);
  return { canonical, probs, winProb: wp, n, adapt };
}

/** Adds the logit offsets of a character's knobs for this decision (raise, accept, run, cover, bluff). */
function addKnobs(logits: Float64Array, obs: Observation, mask: number, knobs: Knobs): void {
  const { raise, accept, run, cover, bluff } = knobs;
  logits[A_RAISE] += raise;
  logits[A_ACCEPT] += accept;
  logits[A_RUN] += run;
  for (let k = 3; k < 6; k++) logits[k] += cover;
  if (bluff !== 0 && mask & (1 << A_RAISE) && obs.phase === 'play') {
    if (handEstimate(obs, BASE_PARAMS) < 0.33) logits[A_RAISE] += bluff;
  }
}

export class NetAgent implements Agent {
  readonly name: string;
  readonly model: Model;
  readonly knobs: Knobs;
  readonly opts: NetOptions;
  /** What the safety net did at the last decision (null when a style decided or the model has no statistics). */
  lastAdapt: AdaptInfo | null = null;
  private readonly x: Float32Array;
  private readonly x0: Float32Array;
  private handKey = '';
  private handStyle: HeuristicParams | null;
  constructor(model: Model, knobs: Knobs = NEUTRAL_KNOBS, name = 'net', opts: NetOptions = {}) {
    this.model = model;
    this.knobs = knobs;
    this.handStyle = knobs.style;
    this.name = name;
    this.opts = opts;
    const size = encoderFor(model.header).size;
    this.x = new Float32Array(size);
    this.x0 = new Float32Array(size);
  }
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision {
    const k = this.knobs;
    this.lastAdapt = null;
    if (k.switchStyles && k.switchStyles.length) {
      const key = `${obs.handIndex}:${obs.score[0]}:${obs.score[1]}:${obs.games[0]}:${obs.games[1]}`;
      if (key !== this.handKey) {
        this.handKey = key;
        this.handStyle = k.switchStyles[Math.floor(rand() * k.switchStyles.length)];
      }
    }
    let removeMask = 0;
    const betDecision = obs.phase === 'raise' || obs.phase === 'onze' || (obs.phase === 'play' && (obs.legal & (1 << A_RAISE)) !== 0 && (obs.legal & 0b111) !== 0);
    if (this.handStyle && k.styleShare > 0 && betDecision && rand() < k.styleShare) {
      const d = heuristicDecision(obs, this.handStyle, rand);
      if (obs.phase !== 'play' || d.action === A_RAISE) return { action: d.action };
      // The style chose not to raise now: the network plays, without the raise.
      removeMask = 1 << A_RAISE;
    }
    const out = policy(this.model, obs, this.x, k, removeMask, ctx, this.opts, this.x0);
    this.lastAdapt = out.adapt;
    let a = sample(out.probs, rand);
    if (a >= A_SIGNAL0 && this.knobs.signalLie > 0 && rand() < this.knobs.signalLie) {
      let other = A_SIGNAL0 + Math.floor(rand() * 5);
      if (other >= a) other++;
      if (other < NUM_ACTIONS) a = other;
    }
    return { action: fromCanonical(a, out.canonical), winProb: out.winProb };
  }
}
