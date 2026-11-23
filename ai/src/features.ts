// Turns what one seat sees (an Observation) into the fixed-size input vector of the network,
// and maps between engine actions (by hand slot) and canonical actions (by card strength).
//
// Everything is relative to the seat: "me", the next seat in play order, the partner, the
// previous seat. Cards are described by strength class (0 to 13, see engine/src/cards.ts),
// since suits only matter for manilhas, which already have their own classes.

import { strengthTable } from '../../engine/src/cards.ts';
import { A_COVER0, A_PLAY0, NUM_ACTIONS } from '../../engine/src/engine.ts';
import { HIDDEN, type Observation } from '../../engine/src/observe.ts';
import type { AgentContext } from './agent.ts';
import type { ModelHeader } from './mlp.ts';
import { SEGMENTS, STATS_SIZE, encodeStats, matchCounts, segmentOf, validatePriors, type Priors, type Segment } from './opponent-stats.ts';

export const NUM_CLASSES = 14;
/** Strength classes plus face down. */
const CARD_SLOTS = NUM_CLASSES + 1;
export const PERSONA_DIMS = 8;

/** Cards of each strength class in the whole deck, per variant (paulista has no plain cards of the manilha rank). */
function classSizes(variant: string, manilhaRank: number): number[] {
  const sizes = new Array<number>(NUM_CLASSES).fill(0);
  const t = strengthTable(variant as 'paulista' | 'mineiro', manilhaRank);
  for (const st of t) sizes[st]++;
  return sizes;
}

const layout: [string, number][] = [
  ['options', 13],
  ['myScore', 12],
  ['oppScore', 12],
  ['games', 4],
  ['kind', 4],
  ['step', 5],
  ['value', 1],
  ['lastRaise', 3],
  ['phase', 3],
  ['proposal', 5],
  ['raiser', 4],
  ['round', 3],
  ['tablePos', 4],
  ['isMao', 1],
  ['dealer', 4],
  ['myHand', 3 * (NUM_CLASSES + 2)],
  ['partnerHand', 3 * (NUM_CLASSES + 1)],
  ['table', 4 * (CARD_SLOTS + 1)],
  ['past', 2 * (3 + 4 + 4 * (CARD_SLOTS + 1))],
  ['seen', NUM_CLASSES],
  ['signals', 4 * 7],
  ['handCounts', 4],
  ['persona', PERSONA_DIMS],
];

export const FEATURE_OFFSETS: Record<string, number> = {};
let total = 0;
for (const [name, size] of layout) {
  FEATURE_OFFSETS[name] = total;
  total += size;
}
export const NUM_FEATURES = total;

/** Extra inputs of the training critic: the hidden cards of the three other seats. */
export const NUM_CRITIC_EXTRA = 3 * 3 * (NUM_CLASSES + 1);

export interface Canonical {
  /** slotOf[k] = hand slot of the k-th strongest remaining card (or -1). */
  slotOf: number[];
  /** Legal mask in canonical action space. */
  mask: number;
}

/**
 * Orders the remaining cards by strength, strongest first (ties keep slot order). In a blind
 * hand the cards are unknown, so slot order is used.
 */
export function canonicalOrder(obs: Observation, strength: readonly number[]): number[] {
  const slots: number[] = [];
  for (let i = 0; i < 3; i++) if (obs.hand[i] !== -1) slots.push(i);
  if (obs.hand.some((c) => c === HIDDEN)) return slots;
  slots.sort((a, b) => strength[obs.hand[b]] - strength[obs.hand[a]] || a - b);
  return slots;
}

export function toCanonical(obs: Observation, strength: readonly number[]): Canonical {
  const order = canonicalOrder(obs, strength);
  const slotOf = [-1, -1, -1];
  order.forEach((slot, k) => (slotOf[k] = slot));
  let mask = obs.legal & ~0b111111;
  for (let k = 0; k < 3; k++) {
    const slot = slotOf[k];
    if (slot < 0) continue;
    if (obs.legal & (1 << (A_PLAY0 + slot))) mask |= 1 << (A_PLAY0 + k);
    if (obs.legal & (1 << (A_COVER0 + slot))) mask |= 1 << (A_COVER0 + k);
  }
  return { slotOf, mask };
}

/** Canonical action (play or cover the k-th strongest card) back to the engine action (by slot). */
export function fromCanonical(action: number, c: Canonical): number {
  if (action < A_COVER0) return A_PLAY0 + c.slotOf[action];
  if (action < A_COVER0 + 3) return A_COVER0 + c.slotOf[action - A_COVER0];
  return action;
}

export function toCanonicalAction(action: number, c: Canonical): number {
  if (action < A_COVER0) return c.slotOf.indexOf(action - A_PLAY0);
  if (action < A_COVER0 + 3) return A_COVER0 + c.slotOf.indexOf(action - A_COVER0);
  return action;
}

function oneHot(out: Float32Array, offset: number, index: number, size: number): void {
  if (index >= 0 && index < size) out[offset + index] = 1;
}

/**
 * Writes the features of an observation into out (length NUM_FEATURES), from the seat's
 * point of view. persona is an optional vector of PERSONA_DIMS numbers.
 */
export function encode(obs: Observation, out: Float32Array, persona?: ArrayLike<number>): void {
  out.fill(0);
  const n = obs.players;
  const me = obs.seat;
  const myTeam = me & 1;
  const rel = (seat: number) => (seat - me + n) % n;
  // In 1 against 1 the opponent is shown in the "next seat" position.
  const relPos = (seat: number) => rel(seat);
  const strength = strengthTable(obs.variant, obs.manilhaRank);
  const F = FEATURE_OFFSETS;
  const o = obs.options;

  // Room configuration.
  let k = F.options;
  out[k++] = obs.variant === 'mineiro' ? 1 : 0;
  out[k++] = n === 4 ? 1 : 0;
  out[k++] = o.ladder === 'mineiro8' ? 1 : 0;
  out[k++] = o.raiseAnyTime ? 1 : 0;
  out[k++] = o.faceDownFirstRound ? 1 : 0;
  out[k++] = o.onzeSeesPartner ? 1 : 0;
  out[k++] = o.onzeTieToOpponents ? 1 : 0;
  out[k++] = o.ironHand === 'normal' ? 1 : 0;
  out[k++] = o.allTieToMao ? 1 : 0;
  out[k + (o.signals === 'secret' ? 0 : o.signals === 'p25' ? 1 : 2)] = n === 4 ? 1 : 0;
  k += 3;
  out[k++] = o.bestOf === 3 ? 1 : 0;

  // Score.
  oneHot(out, F.myScore, Math.min(obs.score[myTeam], 11), 12);
  oneHot(out, F.oppScore, Math.min(obs.score[1 - myTeam], 11), 12);
  oneHot(out, F.games, Math.min(obs.games[myTeam], 1), 2);
  oneHot(out, F.games + 2, Math.min(obs.games[1 - myTeam], 1), 2);

  // Hand state.
  const kind = obs.kind === 'normal' ? 0 : obs.kind === 'iron' ? 3 : obs.onzeTeam === myTeam ? 1 : 2;
  oneHot(out, F.kind, kind, 4);
  oneHot(out, F.step, obs.step, 5);
  out[F.value] = obs.value / 12;
  oneHot(out, F.lastRaise, obs.lastRaiseTeam < 0 ? 0 : obs.lastRaiseTeam === myTeam ? 1 : 2, 3);
  oneHot(out, F.phase, obs.phase === 'play' ? 0 : obs.phase === 'raise' ? 1 : 2, 3);
  if (obs.phase === 'raise') {
    oneHot(out, F.proposal, obs.step + 1, 5);
    oneHot(out, F.raiser, relPos(obs.raiser), 4);
  }

  // Position.
  oneHot(out, F.round, obs.round, 3);
  const cur = obs.rounds[obs.round];
  oneHot(out, F.tablePos, cur ? cur.plays.length : 0, 4);
  out[F.isMao] = obs.mao === me ? 1 : 0;
  oneHot(out, F.dealer, relPos(obs.dealer), 4);

  // My cards, strongest first.
  const order = canonicalOrder(obs, strength);
  const handSize = NUM_CLASSES + 2;
  order.forEach((slot, i) => {
    const base = F.myHand + i * handSize;
    const c = obs.hand[slot];
    if (c === HIDDEN) out[base + NUM_CLASSES + 1] = 1;
    else {
      out[base + strength[c]] = 1;
      out[base + NUM_CLASSES] = 1;
    }
  });

  // Partner's cards when visible (mão de onze).
  if (obs.partnerHand) {
    const p = obs.partnerHand.filter((c) => c >= 0).sort((a, b) => strength[b] - strength[a]);
    p.forEach((c, i) => {
      const base = F.partnerHand + i * (NUM_CLASSES + 1);
      out[base + strength[c]] = 1;
      out[base + NUM_CLASSES] = 1;
    });
  }

  // Current round on the table, by relative seat.
  const cardSlot = CARD_SLOTS + 1;
  if (cur) {
    for (const p of cur.plays) {
      const base = F.table + relPos(p.seat) * cardSlot;
      out[base + (p.faceDown ? NUM_CLASSES : strength[p.card])] = 1;
      out[base + CARD_SLOTS] = 1;
    }
  }

  // Finished rounds of this hand.
  const pastSize = 3 + 4 + 4 * cardSlot;
  for (let r = 0; r < Math.min(obs.round, 2); r++) {
    const pr = obs.rounds[r];
    const base = F.past + r * pastSize;
    oneHot(out, base, pr.result === 2 ? 2 : pr.result === myTeam ? 0 : 1, 3);
    oneHot(out, base + 3, relPos(pr.leader), 4);
    for (const p of pr.plays) {
      const b = base + 7 + relPos(p.seat) * cardSlot;
      out[b + (p.faceDown ? NUM_CLASSES : strength[p.card])] = 1;
      out[b + CARD_SLOTS] = 1;
    }
  }

  // Cards seen face up this hand (vira and plays), as a share of each class.
  const sizes = classSizes(obs.variant, obs.manilhaRank);
  const seen = new Array<number>(NUM_CLASSES).fill(0);
  if (obs.vira >= 0) seen[strength[obs.vira]]++;
  for (const r of obs.rounds) for (const p of r.plays) if (!p.faceDown && p.card >= 0) seen[strength[p.card]]++;
  for (let c = 0; c < NUM_CLASSES; c++) out[F.seen + c] = sizes[c] ? seen[c] / sizes[c] : 0;

  // Signals seen, by relative seat (me, next, partner, previous); 6 means none.
  for (let r = 0; r < 4; r++) out[F.signals + r * 7 + 6] = 1;
  for (const s of obs.signals) {
    const base = F.signals + relPos(s.seat) * 7;
    out[base + 6] = 0;
    out[base + s.signal] = 1;
  }

  for (let s = 0; s < n; s++) out[F.handCounts + relPos(s)] = obs.handCounts[s] / 3;

  if (persona) for (let i = 0; i < PERSONA_DIMS; i++) out[F.persona + i] = persona[i] ?? 0;
}

export const CANONICAL_ACTIONS = NUM_ACTIONS;

// ---------------------------------------------------------------------------------------------
// Feature versions
//
//   v1        431 inputs (the layout above).
//   v2        v1, then 30 public statistics of the other seats in this match (opponent-stats.ts):
//             461 inputs. Live from the agent context; the no-evidence block when the context is
//             absent or masks any seat (noStats).
//   v2-empty  the same layout with the statistics always at no evidence: the twin used to measure
//             what reading the opponent adds. Feeding it live statistics would be out of its
//             training distribution, so the version itself carries the rule.
//   v2-self   the same layout, but the three slots describe the seat itself, the next seat and the
//             partner: what an opponent reads about this seat, and through the count of hands how
//             far the match has gone. Only for the trained explorer of the explorer test
//             (ai/bench/explorer-trained.ts), which needs to know what it has shown. It is not a
//             FeatureVersion: no manifest, room or cycle accepts it (shared/cycle-formats.ts).

/** Versions a served model may carry (ModelHeader.features, the cycle's manifests). */
export type FeatureVersion = 'v1' | 'v2' | 'v2-empty';
export const FEATURE_VERSIONS: readonly FeatureVersion[] = ['v1', 'v2', 'v2-empty'];
/** Every layout encoderFor knows: the served versions and the trained explorer's v2-self. */
export type EncoderVersion = FeatureVersion | 'v2-self';
export const STATS_OFFSET = NUM_FEATURES;
export const NUM_FEATURES_V2 = NUM_FEATURES + STATS_SIZE;

/** Rounds features to multiples of 1/255, the precision stored in training files, so play and training see the same inputs. */
export function quantize(x: Float32Array): void {
  for (let i = 0; i < x.length; i++) x[i] = Math.round(x[i] * 255) / 255;
}

export interface Encoder {
  version: EncoderVersion;
  size: number;
  /** True only for 'v2': the statistics come from the context. */
  usesStats: boolean;
  priors: Priors | null;
  /** v1 part, then the statistics block (live from ctx, or empty), then quantize(out). */
  encode(obs: Observation, out: Float32Array, ctx: AgentContext | undefined, stats: 'live' | 'empty', persona?: ArrayLike<number>): void;
  /** Copies x into x0 and overwrites the statistics block with the quantized no-evidence block of obs's segment. */
  emptyCopy(obs: Observation, x: Float32Array, x0: Float32Array): void;
}

/** The quantized no-evidence block (STATS_SIZE values) for each segment. */
function emptyBlocks(priors: Priors): Record<Segment, Float32Array> {
  const out = {} as Record<Segment, Float32Array>;
  for (const seg of SEGMENTS) {
    const [variant, players] = seg.split('-');
    const block = new Float32Array(STATS_SIZE);
    const obs = { players: Number(players), variant, seat: 0 } as Observation;
    encodeStats(block, 0, obs, null, 0, priors);
    quantize(block);
    out[seg] = block;
  }
  return out;
}

const V1_ENCODER: Encoder = {
  version: 'v1',
  size: NUM_FEATURES,
  usesStats: false,
  priors: null,
  encode(obs, out, _ctx, _stats, persona) {
    encode(obs, out, persona);
    quantize(out);
  },
  emptyCopy(_obs, x, x0) {
    x0.set(x);
  },
};

function v2Encoder(version: 'v2' | 'v2-empty' | 'v2-self', priors: Priors): Encoder {
  const empty = emptyBlocks(priors);
  const live = version !== 'v2-empty';
  // v2-self: encodeStats fills the slots after its seat, so it is given the previous seat; the
  // slots then hold this seat, the next seat and the partner (in 1 against 1, this seat only).
  const shift = version === 'v2-self' ? (obs: Observation): Observation => ({ ...obs, seat: (obs.seat + obs.players - 1) % obs.players }) : (obs: Observation) => obs;
  return {
    version,
    size: NUM_FEATURES_V2,
    usesStats: live,
    priors,
    encode(obs, out, ctx, stats, persona) {
      encode(obs, out, persona);
      // A table with any seat in the noStats mask ("Don't adapt to me") reads no evidence about
      // anyone for the whole match: a block with some slots empty and others filled never occurs
      // in training, while the all-empty block does (self-play plays a share of its matches so).
      if (live && stats === 'live' && ctx && !(ctx.noStats ?? 0)) {
        encodeStats(out, STATS_OFFSET, shift(obs), matchCounts(ctx.history), 0, priors, version === 'v2' ? ctx.seatPriors : undefined);
        quantize(out);
      } else {
        quantize(out);
        out.set(empty[segmentOf(obs.variant, obs.players)], STATS_OFFSET);
      }
    },
    emptyCopy(obs, x, x0) {
      x0.set(x);
      x0.set(empty[segmentOf(obs.variant, obs.players)], STATS_OFFSET);
    },
  };
}

const encoders = new WeakMap<object, Encoder>();

/**
 * The encoder of a model. Throws on an unknown version, on missing or invalid meta.priors for v2
 * versions, or when header.inputs differs from the size. Cached per header object.
 */
export function encoderFor(header: Pick<ModelHeader, 'features' | 'inputs' | 'meta'>): Encoder {
  const hit = encoders.get(header);
  if (hit) return hit;
  let enc: Encoder;
  const v = header.features as string;
  if (v === 'v1') enc = V1_ENCODER;
  else if (v === 'v2' || v === 'v2-empty' || v === 'v2-self') {
    if (!header.meta || header.meta.priors === undefined) throw new Error(`features ${v} need meta.priors`);
    enc = v2Encoder(v, validatePriors(header.meta.priors));
  } else throw new Error(`unknown features version ${String(v)}`);
  if (header.inputs !== enc.size) throw new Error(`features ${v} have ${enc.size} inputs, the model has ${header.inputs}`);
  encoders.set(header, enc);
  return enc;
}

/** For train.py and learner.py: sizes, the statistics offset, and the quantized empty block per segment. */
export function encoderInfo(version: EncoderVersion, priors: Priors | null): { size: number; critic: number; statsOffset: number; statsSize: number; empty: Record<Segment, number[]> } {
  if (version === 'v1') {
    return { size: NUM_FEATURES, critic: NUM_CRITIC_EXTRA, statsOffset: NUM_FEATURES, statsSize: 0, empty: {} as Record<Segment, number[]> };
  }
  if (!priors) throw new Error(`features ${version} need priors`);
  const blocks = emptyBlocks(validatePriors(priors));
  const empty = {} as Record<Segment, number[]>;
  for (const seg of SEGMENTS) empty[seg] = Array.from(blocks[seg]);
  return { size: NUM_FEATURES_V2, critic: NUM_CRITIC_EXTRA, statsOffset: STATS_OFFSET, statsSize: STATS_SIZE, empty };
}
