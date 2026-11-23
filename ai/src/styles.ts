// Strongly styled opponents for training and for the tests of in-match adaptation. All play on
// the v1 network: the network plays the cards and a fixed betting style makes every bet decision.
// The extremes teach the adaptive network that styles differ; the switching agent changes style
// during a match; the explorer styles (rock, honest, trapper) appear in the explorer test and, since
// the feints fine-tune of milestone 6 (league kind 'feints', ai/src/league.ts), as the phases of
// training opponents that fake a pattern and then switch. The held-out styles (coversAll, coinFlip)
// never appear in training, so measurement (a) can show how the network reads a style unlike any it
// trained against. trapper was held out until that fine-tune: for a network trained without feints
// it still is (heldOutStyles).

import type { Observation } from '../../engine/src/observe.ts';
import type { PublicHistory } from '../../engine/src/public.ts';
import type { Agent, AgentContext, Decision } from './agent.ts';
import { BASE_PARAMS, type HeuristicParams } from './heuristic.ts';
import type { Model } from './mlp.ts';
import { NEUTRAL_KNOBS, NetAgent, type Knobs } from './net-agent.ts';
import { countHands, matchCounts, seatEvidence } from './opponent-stats.ts';
import { personaAgent, type CalibratedKnobs } from './personas.ts';

export type ExtremeId = 'raisesAll' | 'neverRaises' | 'neverRuns' | 'runsAll' | 'bluffer' | 'coversALot';
export type HeldOutId = 'coversAll' | 'coinFlip';
export type ExplorerStyleId = 'rock' | 'honest' | 'trapper' | 'bluffer' | 'raisesAll' | 'neverRaises' | 'neverRuns' | 'runsAll';
/** A phase of an explorer: an explorer style, or a held-out style (the fresh family only). */
export type ExplorerPhaseId = ExplorerStyleId | HeldOutId;
export type StyleId = ExtremeId | HeldOutId | 'rock' | 'honest' | 'trapper';

export const EXTREMES: readonly ExtremeId[] = ['raisesAll', 'neverRaises', 'neverRuns', 'runsAll', 'bluffer', 'coversALot'];
/**
 * Styles that never sit in a training match: measurement (a) reports them apart. trapper left this
 * list when the feints kind made it a training phase; coinFlip took its place (heldOutStyles gives
 * the list for a given training family).
 */
export const HELD_OUT_STYLES: readonly HeldOutId[] = ['coversAll', 'coinFlip'];
export const EXPLORER_STYLES: readonly ExplorerStyleId[] = ['rock', 'honest', 'trapper', 'bluffer', 'raisesAll', 'neverRaises', 'neverRuns', 'runsAll'];
/**
 * The styles of STYLE_KNOBS a 'feints' training opponent plays as phases: the explorer styles and
 * coversALot (ai/src/league.ts adds the five characters). Never a held-out style.
 */
export const FEINT_STYLES: readonly StyleId[] = [...EXPLORER_STYLES, 'coversALot'];

/** Cover offset of coversALot (and the most a mixture with it gets). */
export const COVERS_A_LOT = 6;

const style = (over: Partial<HeuristicParams>): HeuristicParams => ({ ...BASE_PARAMS, ...over });
const betting = (over: Partial<HeuristicParams>): Knobs => ({ ...NEUTRAL_KNOBS, style: style(over), styleShare: 1 });

export const STYLE_KNOBS: Record<StyleId, Knobs> = {
  // Asks for truco and raises whenever it may.
  raisesAll: betting({ raise: [-1, -1, -1, -1], bluff: 0 }),
  // Never asks for truco and never raises again.
  neverRaises: betting({ raise: [2, 2, 2, 2], reraise: [2, 2, 2], bluff: 0 }),
  // Accepts every bet and plays every mão de onze.
  neverRuns: betting({ accept: [-1, -1, -1, -1], onze: -1 }),
  // Runs from every bet and every mão de onze.
  runsAll: betting({ accept: [2, 2, 2, 2], reraise: [2, 2, 2], onze: 2 }),
  // Raises with weak hands, almost never with strong ones.
  bluffer: betting({ raise: [0.97, 0.98, 0.99, 0.995], reraise: [0.9, 0.95, 0.98], bluff: 1, bluffBelow: 0.4 }),
  // Plays face down often: about 45% of the plays where covering is allowed, against v1 Zap.
  coversALot: { ...NEUTRAL_KNOBS, cover: COVERS_A_LOT },
  // Explorer only: raises only with very strong hands and runs often, never bluffs.
  rock: betting({ raise: [0.92, 0.94, 0.96, 0.98], accept: [0.7, 0.74, 0.78, 0.82], reraise: [0.96, 0.98, 0.99], onze: 0.65, bluff: 0 }),
  // Explorer only: the base heuristic's bets without bluffs.
  honest: betting({ bluff: 0 }),
  // Held out (and explorer): never asks for truco first and never runs; answers a raise by
  // raising again whenever the hand is fair. Hides strength, then punishes the raise.
  trapper: betting({ raise: [2, 2, 2, 2], accept: [-1, -1, -1, -1], reraise: [0.55, 0.6, 0.65], onze: 0.4, bluff: 0 }),
  // Held out: plays face down in about three plays out of four where covering is allowed.
  coversAll: { ...NEUTRAL_KNOBS, cover: 10 },
  // Held out (since the feints kind trains trapper): never raises for value; at each chance to ask
  // for truco or raise it does so with chance 0.3 whatever its cards, so its raises say nothing
  // about its hand. Answers and mão de onze as the base heuristic.
  coinFlip: betting({ raise: [2, 2, 2, 2], bluff: 0.3, bluffBelow: 2 }),
};

/** A styled player on the v1 network. */
export function styleAgent(v1: Model, id: StyleId, name: string = id): NetAgent {
  return new NetAgent(v1, STYLE_KNOBS[id], name);
}

const lerp = (a: number, b: number, t: number) => a + t * (b - a);
const lerpAll = (a: readonly number[], b: readonly number[], t: number) => a.map((x, i) => lerp(x, b[i], t));

/**
 * Mixture of two extremes with weight t on the second: thresholds, bluffs and the cover offset
 * interpolated element by element. A mixture with coversALot keeps the other style at full share
 * and covers with an offset of COVERS_A_LOT times the weight of coversALot.
 */
export function mixExtremes(a: ExtremeId, b: ExtremeId, t: number): Knobs {
  const ka = STYLE_KNOBS[a];
  const kb = STYLE_KNOBS[b];
  if (a === 'coversALot') return { ...kb, cover: COVERS_A_LOT * (1 - t) };
  if (b === 'coversALot') return { ...ka, cover: COVERS_A_LOT * t };
  const sa = ka.style!;
  const sb = kb.style!;
  return {
    ...NEUTRAL_KNOBS,
    styleShare: 1,
    cover: lerp(ka.cover, kb.cover, t),
    style: {
      ...BASE_PARAMS,
      raise: lerpAll(sa.raise, sb.raise, t),
      accept: lerpAll(sa.accept, sb.accept, t),
      reraise: lerpAll(sa.reraise, sb.reraise, t),
      onze: lerp(sa.onze, sb.onze, t),
      bluff: lerp(sa.bluff, sb.bluff, t),
      bluffBelow: lerp(sa.bluffBelow, sb.bluffBelow, t),
    },
  };
}

export interface SampledStyle {
  label: string;
  knobs: Knobs;
}

/** With chance 0.6 one of the six extremes, otherwise a mixture of two distinct extremes with weight from 0.25 to 0.75. */
export function sampleExtreme(rand: () => number): SampledStyle {
  if (rand() < 0.6) {
    const id = EXTREMES[Math.floor(rand() * EXTREMES.length)];
    return { label: id, knobs: STYLE_KNOBS[id] };
  }
  const i = Math.floor(rand() * EXTREMES.length);
  let j = Math.floor(rand() * (EXTREMES.length - 1));
  if (j >= i) j++;
  const t = 0.25 + 0.5 * rand();
  return { label: `${EXTREMES[i]}+${EXTREMES[j]}@${t.toFixed(2)}`, knobs: mixExtremes(EXTREMES[i], EXTREMES[j], t) };
}

/** Plays as `first` while the hand number is below switchAtHand, then as `second`. */
export class PhaseAgent implements Agent {
  readonly name: string;
  readonly first: Agent;
  readonly second: Agent;
  readonly switchAtHand: number;
  constructor(first: Agent, second: Agent, switchAtHand: number, name = `${first.name}>${second.name}@${switchAtHand}`) {
    this.first = first;
    this.second = second;
    this.switchAtHand = switchAtHand;
    this.name = name;
  }
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision {
    return (obs.handIndex < this.switchAtHand ? this.first : this.second).act(obs, rand, ctx);
  }
}

/**
 * Plays as `first` until its own seat has shown `evidence` betting events in finished hands of
 * the match (hands in which it asked for truco plus raises it answered, the evidence n the
 * adaptive network reads, opponent-stats.ts seatEvidence), then as `second`. It fakes a pattern
 * until the reader has seen enough of it. The original training league never switched this way;
 * the 'feints' kind of the feints fine-tune does (ai/src/league.ts).
 */
export class EvidencePhaseAgent implements Agent {
  readonly name: string;
  readonly first: Agent;
  readonly second: Agent;
  readonly evidence: number;
  private switched = false;
  constructor(first: Agent, second: Agent, evidence: number, name = `${first.name}>${second.name}@e${evidence}`) {
    this.first = first;
    this.second = second;
    this.evidence = evidence;
    this.name = name;
  }
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision {
    if (!this.switched && ctx && seatEvidence(matchCounts(ctx.history).seats[obs.seat]) >= this.evidence) this.switched = true;
    return (this.switched ? this.second : this.first).act(obs, rand, ctx);
  }
}

/**
 * A schedule of more than two phases. The measure is the hand index (trigger 'hand') or the seat's
 * own betting events in finished hands of the match (trigger 'evidence'); both only grow during a
 * match. With `at` (increasing), the agent plays phases[i] while the measure is below at[i] and the
 * last phase after the last switch point. With `every`, it goes back and forth through the phases,
 * changing every `every` units (a, b, a, b, ...).
 */
export class ScheduleAgent implements Agent {
  readonly name: string;
  readonly phases: readonly Agent[];
  readonly trigger: 'hand' | 'evidence';
  readonly at: readonly number[] | null;
  readonly every: number | null;
  constructor(phases: readonly Agent[], trigger: 'hand' | 'evidence', when: { at: readonly number[] } | { every: number }, name: string) {
    if ('at' in when) {
      if (when.at.length !== phases.length - 1) throw new Error('ScheduleAgent: one switch point less than phases');
      for (let i = 1; i < when.at.length; i++) if (!(when.at[i] > when.at[i - 1])) throw new Error('ScheduleAgent: switch points must increase');
    } else if (!(when.every >= 1)) throw new Error('ScheduleAgent: every must be at least 1');
    this.phases = phases;
    this.trigger = trigger;
    this.at = 'at' in when ? when.at : null;
    this.every = 'every' in when ? when.every : null;
    this.name = name;
  }
  /** The phase played at this measure. */
  phaseAt(x: number): number {
    if (this.every !== null) return Math.floor(x / this.every) % this.phases.length;
    let i = 0;
    while (i < this.at!.length && x >= this.at![i]) i++;
    return i;
  }
  act(obs: Observation, rand: () => number, ctx?: AgentContext): Decision {
    const x = this.trigger === 'hand' ? obs.handIndex : ctx ? seatEvidence(matchCounts(ctx.history).seats[obs.seat]) : 0;
    return this.phases[this.phaseAt(x)].act(obs, rand, ctx);
  }
}

/**
 * The schedule one seat of an explorer team plays: style a, then style b at hand k or once its seat
 * has shown k betting events (trigger 'evidence'). The fresh family adds two shapes: three phases
 * (back to a, or on to c, once the measure reaches k2) and back and forth (cycle: a, b, a, b, ...
 * changing every k).
 */
export interface ExplorerSchedule {
  a: ExplorerPhaseId;
  b: ExplorerPhaseId;
  k: number;
  trigger?: 'hand' | 'evidence';
  k2?: number;
  c?: ExplorerPhaseId;
  cycle?: boolean;
}

/**
 * An explorer: a schedule for the lower seat of the team and, in 2 against 2, its partner: the
 * same schedule ('same'), v1 Zap ('v1') or a schedule of its own ('own', with `mate`).
 */
export interface ExplorerSpec extends ExplorerSchedule {
  partner: 'same' | 'v1' | 'own';
  mate?: ExplorerSchedule;
}

/** a>b@k, a>b@ek (evidence), a>b>a@k,k2 (three phases), a<>b@k (back and forth). */
export function scheduleLabel(e: ExplorerSchedule): string {
  const at = e.trigger === 'evidence' ? 'e' : '';
  if (e.cycle) return `${e.a}<>${e.b}@${at}${e.k}`;
  if (e.k2 !== undefined) return `${e.a}>${e.b}>${e.c ?? e.a}@${at}${e.k},${e.k2}`;
  return `${e.a}>${e.b}@${at}${e.k}`;
}

/** The label of an explorer: schedule/partner, or schedule/own:mate. The labels of the original grid are unchanged. */
export function explorerLabel(e: ExplorerSpec): string {
  return `${scheduleLabel(e)}/${e.partner === 'own' ? `own:${scheduleLabel(e.mate!)}` : e.partner}`;
}

/** The schedule part of a spec (no partner fields). */
export function scheduleOf(e: ExplorerSchedule): ExplorerSchedule {
  const { a, b, k, trigger, k2, c, cycle } = e;
  return { a, b, k, ...(trigger ? { trigger } : {}), ...(k2 !== undefined ? { k2 } : {}), ...(c ? { c } : {}), ...(cycle ? { cycle } : {}) };
}

/** The explorer as it plays in 1 against 1, where it has no partner: its schedule with partner 'same'. */
export function soloSpec(e: ExplorerSpec): ExplorerSpec {
  return { ...scheduleOf(e), partner: 'same' };
}

/**
 * What a network's training league could draw, for inTrainingFamily: the 'switching' kind (a
 * switch at a hand in `hands` between two extremes or characters) and the 'feints' kind of the
 * feints fine-tune (two phases from FEINT_STYLES and the characters, a switch at a hand in `hands`
 * or once the seat has shown a number of betting events in `evidence`; partner the same schedule,
 * v1 Zap or a schedule of its own). null: the kind had no share. extremes: the 'extremes' kind had
 * a share (an extreme, or a mixture of two, for the whole match; only explorerMatchInFamily reads
 * it, since no explorer schedule keeps one style by its label). ai/src/league.ts
 * trainingFamilyOf reads it from a run's args.json.
 */
export interface TrainingFamily {
  switching: { hands: readonly [number, number] } | null;
  feints: { hands: readonly [number, number]; evidence: readonly [number, number] } | null;
  extremes: boolean;
}

/** The league of the milestone 6 runs (m6-adaptive, m6-twin, m6-twin-b): switching at hands 1 to 6, stable extremes, no feints. */
export const M6_FAMILY: TrainingFamily = { switching: { hands: [1, 6] }, feints: null, extremes: true };

const inRange = (k: number, r: readonly [number, number]) => k >= r[0] && k <= r[1];

/** Whether one seat's schedule is something the family's league could draw. */
export function scheduleInFamily(e: ExplorerSchedule, family: TrainingFamily = M6_FAMILY): boolean {
  if (e.cycle || e.k2 !== undefined) return false;
  const trigger = e.trigger ?? 'hand';
  const extreme = (id: string) => (EXTREMES as readonly string[]).includes(id);
  const feint = (id: string) => (FEINT_STYLES as readonly string[]).includes(id);
  if (family.switching && trigger === 'hand' && extreme(e.a) && extreme(e.b) && inRange(e.k, family.switching.hands)) return true;
  if (family.feints && feint(e.a) && feint(e.b) && inRange(e.k, trigger === 'hand' ? family.feints.hands : family.feints.evidence)) return true;
  return false;
}

/**
 * Whether the explorer belongs to the family of switching players met in training: every seat of
 * its team plays a schedule the league could draw (the partner v1 Zap or the same schedule always
 * could; a partner with a schedule of its own only when that schedule is in the family too). For
 * M6_FAMILY: a switch at hand 1 to 6 between two extremes. Anything else (three phases, back and
 * forth, a held-out style, a switch outside the trained range) is a schedule training never showed.
 */
export function inTrainingFamily(e: ExplorerSpec, family: TrainingFamily = M6_FAMILY): boolean {
  return scheduleInFamily(e, family) && (e.partner !== 'own' || (e.mate !== undefined && scheduleInFamily(e.mate, family)));
}

/** The style a schedule plays in hand `hand` (0 for the first) when its seat has shown `evidence` betting events before it (the rule of the agents below). */
export function schedulePhase(e: ExplorerSchedule, hand: number, evidence: number): ExplorerPhaseId {
  const x = (e.trigger ?? 'hand') === 'hand' ? hand : evidence;
  if (e.cycle) return Math.floor(x / e.k) % 2 === 0 ? e.a : e.b;
  if (e.k2 !== undefined) return x < e.k ? e.a : x < e.k2 ? e.b : (e.c ?? e.a);
  return x < e.k ? e.a : e.b;
}

/**
 * Whether some training draw of `family` plays exactly what one seat played in a match, hand by
 * hand: `phases[i]` is the style it played in hand i and `evidence[i]` the betting events it had
 * shown in the hands before (opponent-stats.ts seatEvidence). Labels can say an explorer is outside
 * training while the part that makes it so never played: a switch planned for hand 11 in a match of
 * 7 hands plays like a stable style. The draws that count:
 *   one style all match  an extreme ('extremes'); a 'feints' schedule whose switch never came (a
 *                        switch hand of at least the match length, or an evidence switch above the
 *                        seat's evidence in the last hand); a 'switching' schedule between extremes
 *                        whose switch hand is at least the match length
 *   two styles           'feints' with both in FEINT_STYLES and the switch at hand t in its hand
 *                        range, or set off by evidence in its range (before hand t below it, at hand
 *                        t at or above it); 'switching' with both extremes and t in its hand range
 *   three or more        none (no training draw switches twice)
 * A held-out style is in no pool, so a seat that played one is always outside. The partner of a
 * team is checked as its own seat: the 'feints' kind also draws a partner on a schedule of its own.
 */
export function realizedInFamily(phases: readonly string[], evidence: readonly number[], family: TrainingFamily): boolean {
  const L = phases.length;
  if (L === 0) return true;
  const starts = [0];
  for (let i = 1; i < L; i++) if (phases[i] !== phases[i - 1]) starts.push(i);
  if (starts.length > 2) return false;
  const extreme = (id: string) => (EXTREMES as readonly string[]).includes(id);
  const feint = (id: string) => (FEINT_STYLES as readonly string[]).includes(id);
  const f = family.feints;
  const sw = family.switching;
  if (starts.length === 1) {
    const s = phases[0];
    if (family.extremes && extreme(s)) return true;
    if (f && feint(s) && (f.hands[1] >= L || evidence[L - 1] < f.evidence[1])) return true;
    return !!sw && extreme(s) && sw.hands[1] >= L;
  }
  const t = starts[1];
  const [a, b] = [phases[0], phases[t]];
  if (f && feint(a) && feint(b)) {
    if (inRange(t, f.hands)) return true;
    for (let k = f.evidence[0]; k <= f.evidence[1]; k++) if (evidence[t - 1] < k && k <= evidence[t]) return true;
  }
  return !!sw && extreme(a) && extreme(b) && inRange(t, sw.hands);
}

/** Betting events each seat had shown before each hand of a match: out[seat][i] for hand i (0 for the first). */
export function evidenceBeforeHands(h: PublicHistory): number[][] {
  const out = Array.from({ length: h.players }, () => [0]);
  for (const hand of h.hands) {
    const c = countHands({ ...h, hands: [hand] });
    for (let s = 0; s < h.players; s++) out[s].push(out[s][out[s].length - 1] + seatEvidence(c.seats[s]));
  }
  for (const row of out) row.length = h.hands.length;
  return out;
}

/**
 * Whether some training draw of `family` plays exactly what the explorer team played in one
 * finished match (`h`, the explorer on the seats of parity `team`): every seat of the team with a
 * schedule (the lower seat; in 2 against 2 the partner too, unless it is v1 Zap, which training
 * always draws) passes realizedInFamily. In 1 against 1 pass the solo spec (soloSpec).
 */
export function explorerMatchInFamily(e: ExplorerSpec, h: PublicHistory, team: number, family: TrainingFamily): boolean {
  const E = evidenceBeforeHands(h);
  const L = h.hands.length;
  for (let seat = team; seat < h.players; seat += 2) {
    const sched: ExplorerSchedule | null = seat < 2 ? e : e.partner === 'v1' ? null : e.partner === 'own' ? e.mate! : e;
    if (!sched) continue;
    const phases = Array.from({ length: L }, (_, i) => schedulePhase(sched, i, E[seat][i]));
    if (!realizedInFamily(phases, E[seat], family)) return false;
  }
  return true;
}

/**
 * The held-out styles for a network trained on `family`: HELD_OUT_STYLES, plus trapper when the
 * family has no feints (trapper sat in no training match before the feints fine-tune).
 */
export function heldOutStyles(family: TrainingFamily = M6_FAMILY): StyleId[] {
  return family.feints ? [...HELD_OUT_STYLES] : ['trapper', ...HELD_OUT_STYLES];
}

/** One seat's schedule as an agent on v1. The two-phase schedules keep their original classes. */
export function scheduleAgent(v1: Model, e: ExplorerSchedule, name = scheduleLabel(e)): Agent {
  const st = (id: ExplorerPhaseId) => styleAgent(v1, id);
  const trigger = e.trigger ?? 'hand';
  if (e.cycle) return new ScheduleAgent([st(e.a), st(e.b)], trigger, { every: e.k }, name);
  if (e.k2 !== undefined) return new ScheduleAgent([st(e.a), st(e.b), st(e.c ?? e.a)], trigger, { at: [e.k, e.k2] }, name);
  if (trigger === 'evidence') return new EvidencePhaseAgent(st(e.a), st(e.b), e.k, name);
  return new PhaseAgent(st(e.a), st(e.b), e.k, name);
}

/** The explorer's team: the lower seat of the team runs the schedule; the partner follows `partner`. */
export function explorerFactory(v1: Model, v1Knobs: CalibratedKnobs | undefined, e: ExplorerSpec): (seat: number) => Agent {
  if (e.partner === 'own' && !e.mate) throw new Error(`explorer ${scheduleLabel(e)}/own needs a mate schedule`);
  return (seat: number) => {
    if (seat >= 2 && e.partner === 'v1') return personaAgent(v1, 'zap', v1Knobs);
    if (seat >= 2 && e.partner === 'own') return scheduleAgent(v1, e.mate!, explorerLabel(e));
    return scheduleAgent(v1, e, explorerLabel(e));
  };
}

/** The fixed proxy explorers used in the sweeps and in the training panel. */
export const PROXY_EXPLORERS: readonly ExplorerSpec[] = [
  { a: 'rock', b: 'bluffer', k: 2, partner: 'same' },
  { a: 'rock', b: 'bluffer', k: 4, partner: 'same' },
  { a: 'honest', b: 'raisesAll', k: 3, partner: 'same' },
  { a: 'neverRaises', b: 'raisesAll', k: 3, partner: 'same' },
  { a: 'bluffer', b: 'rock', k: 2, partner: 'same' },
  { a: 'neverRuns', b: 'runsAll', k: 3, partner: 'same' },
];
