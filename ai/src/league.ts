// The training league of milestone 6: who sits across from the learning network. Every member of
// the evaluation panel is in it (the network, its recent snapshots, v1, the tuned and base
// heuristics, random), plus strongly styled players to learn to read: the five characters,
// extreme styles and players that switch style during a match, and, once the training cycle's
// human behaviour model passed its test, that model (kind 'human', as opponent and as partner).
// The feints fine-tune adds 'feints' (M6R_MIX): players built like the explorer grid, which fake a
// pattern and then switch. Shared by self-play and the benches.

import type { Agent } from './agent.ts';
import { RandomAgent } from './agent.ts';
import { BASE_PARAMS, HeuristicAgent, type HeuristicParams } from './heuristic.ts';
import type { Model } from './mlp.ts';
import { NEUTRAL_KNOBS, NetAgent } from './net-agent.ts';
import { persona, personaAgent, type CalibratedKnobs, type PersonaId } from './personas.ts';
import { EXTREMES, EvidencePhaseAgent, FEINT_STYLES, PhaseAgent, STYLE_KNOBS, sampleExtreme, type StyleId, type TrainingFamily } from './styles.ts';

export type OpponentKind = 'current' | 'snapshots' | 'v1' | 'tuned' | 'base' | 'random' | 'characters' | 'extremes' | 'human' | 'switching' | 'feints';
export const OPPONENT_KINDS: readonly OpponentKind[] = ['current', 'snapshots', 'v1', 'tuned', 'base', 'random', 'characters', 'extremes', 'human', 'switching', 'feints'];
export type LeagueMix = Record<OpponentKind, number>;

/**
 * Shares per match for the opponent team. 'human' is 0 here: the training cycle moves a share from
 * 'current' to it for its candidate (training/cycle/zapcycle/train.py with_human). A zero share is
 * skipped, 'human' sits before 'switching' and 'feints' after it, so every run without them draws
 * exactly as before.
 */
export const M6_MIX: LeagueMix = { current: 0.3, snapshots: 0.1, v1: 0.08, tuned: 0.05, base: 0.05, random: 0.02, characters: 0.16, extremes: 0.14, human: 0, switching: 0.1, feints: 0 };

/**
 * The mix of the feints fine-tune (training/runs/m6-adaptive-r and m6-twin-r). The panel members
 * (current, snapshots, v1, tuned, base, random: 0.60) and the characters (0.16) keep the shares of
 * M6_MIX, so the network meets them as often as in the 390 iterations it continues. 'feints' gets
 * half of the 0.24 the other styled kinds had: the stationary extremes keep 0.08 (a stable style is
 * what makes reading pay) and 'switching' keeps 0.04 (its family, a switch at hand 1 to 6 between
 * extremes or characters, is inside the feints family anyway).
 */
export const M6R_MIX: LeagueMix = { ...M6_MIX, extremes: 0.08, switching: 0.04, feints: 0.12 };
export const M6R_MIX_TEXT = 'current=0.30,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.08,switching=0.04,feints=0.12';

/**
 * The characters used in training: all five (every training run meets every character). The
 * held-out styles of evaluation are ai/src/styles.ts HELD_OUT_STYLES, which never sit here.
 */
export const TRAINING_CHARACTERS: readonly PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara'];

/** Parses "current=0.30,snapshots=0.10,..."; kinds left out get 0; the shares must add up to 1 within 1e-9. */
export function parseMix(text: string): LeagueMix {
  const mix = Object.fromEntries(OPPONENT_KINDS.map((k) => [k, 0])) as LeagueMix;
  for (const part of text.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!(OPPONENT_KINDS as readonly string[]).includes(k)) throw new Error(`league mix: unknown kind ${k}`);
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new Error(`league mix: bad share for ${k}`);
    mix[k as OpponentKind] = x;
  }
  checkMix(mix);
  return mix;
}

export function checkMix(mix: LeagueMix): void {
  const sum = OPPONENT_KINDS.reduce((a, k) => a + (mix[k] ?? 0), 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`league mix adds up to ${sum}, not 1`);
}

export interface LeaguePlayers {
  v1: Model;
  v1Knobs: CalibratedKnobs;
  tuned: HeuristicParams;
  /** Recent snapshots of the run (same features as the learning network), then the fixed league files. */
  snapshots: Model[];
  /**
   * Play the 'snapshots' members as the room serves a model (Zap knobs, statistics live, the file's
   * own safety net) instead of as raw training opponents (neutral knobs, no net). The trained
   * explorer of the explorer test uses it to meet the frozen adaptive network as served.
   */
  snapshotsAsServed?: boolean;
  /** Hands before a switching player changes style: an integer from the first to the second number. Default [1, 6]. */
  switchHands?: [number, number];
  /** 'feints': hands of the first phase when the switch waits for a hand, from the first to the second number. Default FEINT_HANDS. */
  feintHands?: [number, number];
  /** 'feints': betting events of the seat before the switch when it waits for evidence. Default FEINT_EVIDENCE. */
  feintEvidence?: [number, number];
  /** The human behaviour model of the training cycle (features v1); without it, 'human' draws fall back like 'snapshots'. */
  human?: Model;
}

export interface Draw {
  kind: OpponentKind;
  label: string;
  /** A fresh agent with the parameters drawn, or 'learn' for the learning network itself. */
  make(): Agent | 'learn';
  /**
   * 2 against 2: the second opponent, when the draw decides it ('feints': the same schedule, v1 Zap
   * or a schedule of its own). seatMatch then skips its own rule for the second seat.
   */
  mate?: { label: string; make(): Agent };
}

type StyledId = PersonaId | StyleId;
const SWITCH_POOL: readonly StyledId[] = [...TRAINING_CHARACTERS, ...EXTREMES];
/** Phases of a 'feints' player: the explorer styles, coversALot and the five characters (14). Never a held-out style. */
export const FEINT_POOL: readonly StyledId[] = [...FEINT_STYLES, ...TRAINING_CHARACTERS];
/** Switch points of the 'feints' kind: the ranges of the explorer grid (hands 1 to 8, evidence 2 to 8), filled in. */
export const FEINT_HANDS: [number, number] = [1, 8];
export const FEINT_EVIDENCE: [number, number] = [2, 8];

function styled(p: LeaguePlayers, id: StyledId): Agent {
  if (id in STYLE_KNOBS) return new NetAgent(p.v1, STYLE_KNOBS[id as StyleId], id);
  return personaAgent(p.v1, id as PersonaId, p.v1Knobs);
}

/**
 * One schedule of the 'feints' kind: two distinct phases from FEINT_POOL; the switch point uniform
 * over the hand settings and the evidence settings together (hands 1 to 8 and evidence 2 to 8 by
 * default: 15 settings, 8 of them by hand, as the grid has more hand switches than evidence ones).
 */
function drawFeint(p: LeaguePlayers, rand: () => number): { label: string; make(): Agent } {
  const i = Math.floor(rand() * FEINT_POOL.length);
  let j = Math.floor(rand() * (FEINT_POOL.length - 1));
  if (j >= i) j++;
  const [hlo, hhi] = p.feintHands ?? FEINT_HANDS;
  const [elo, ehi] = p.feintEvidence ?? FEINT_EVIDENCE;
  const nh = hhi - hlo + 1;
  const u = Math.floor(rand() * (nh + ehi - elo + 1));
  const byHand = u < nh;
  const k = byHand ? hlo + u : elo + u - nh;
  const a = FEINT_POOL[i];
  const b = FEINT_POOL[j];
  const label = `${a}>${b}@${byHand ? '' : 'e'}${k}`;
  return { label, make: () => (byHand ? new PhaseAgent(styled(p, a), styled(p, b), k, label) : new EvidencePhaseAgent(styled(p, a), styled(p, b), k, label)) };
}

/**
 * Draws one opponent. All randomness is drawn here, so make() builds the same player each time.
 * excludeCurrent: draw from the mix without 'current' (renormalized).
 */
export function drawOpponent(mix: LeagueMix, rand: () => number, p: LeaguePlayers, excludeCurrent = false): Draw {
  const kinds = OPPONENT_KINDS.filter((k) => !(excludeCurrent && k === 'current'));
  const total = kinds.reduce((a, k) => a + mix[k], 0);
  let u = rand() * total;
  // Fallback for rounding at the top end: the last kind with a share (as before 'feints' existed).
  let kind: OpponentKind = [...kinds].reverse().find((k) => mix[k] > 0) ?? kinds[kinds.length - 1];
  for (const k of kinds) {
    if (mix[k] <= 0) continue;
    if (u < mix[k]) {
      kind = k;
      break;
    }
    u -= mix[k];
  }
  if (kind === 'snapshots' && p.snapshots.length === 0) kind = excludeCurrent ? 'v1' : 'current';
  if (kind === 'human' && !p.human) kind = excludeCurrent ? 'v1' : 'current';
  switch (kind) {
    case 'current':
      return { kind, label: 'current', make: () => 'learn' };
    case 'snapshots': {
      const i = Math.floor(rand() * p.snapshots.length);
      if (p.snapshotsAsServed) return { kind, label: `served${i}`, make: () => new NetAgent(p.snapshots[i], persona('zap').knobs, `served${i}`) };
      return { kind, label: `snapshot${i}`, make: () => new NetAgent(p.snapshots[i], NEUTRAL_KNOBS, `snapshot${i}`, { safety: 'off' }) };
    }
    case 'v1':
      return { kind, label: 'v1', make: () => personaAgent(p.v1, 'zap', p.v1Knobs) };
    case 'tuned':
      return { kind, label: 'tuned', make: () => new HeuristicAgent(p.tuned, 'tuned') };
    case 'base':
      return { kind, label: 'base', make: () => new HeuristicAgent(BASE_PARAMS, 'base') };
    case 'random':
      return { kind, label: 'random', make: () => new RandomAgent() };
    case 'characters': {
      const id = TRAINING_CHARACTERS[Math.floor(rand() * TRAINING_CHARACTERS.length)];
      return { kind, label: id, make: () => personaAgent(p.v1, id, p.v1Knobs) };
    }
    case 'extremes': {
      const s = sampleExtreme(rand);
      return { kind, label: s.label, make: () => new NetAgent(p.v1, s.knobs, s.label) };
    }
    case 'human': {
      const human = p.human!;
      return { kind, label: 'human', make: () => new NetAgent(human, NEUTRAL_KNOBS, 'human', { safety: 'off' }) };
    }
    case 'switching': {
      const i = Math.floor(rand() * SWITCH_POOL.length);
      let j = Math.floor(rand() * (SWITCH_POOL.length - 1));
      if (j >= i) j++;
      const [lo, hi] = p.switchHands ?? [1, 6];
      const k = lo + Math.floor(rand() * (hi - lo + 1));
      const a = SWITCH_POOL[i];
      const b = SWITCH_POOL[j];
      const label = `${a}>${b}@${k}`;
      return { kind, label, make: () => new PhaseAgent(styled(p, a), styled(p, b), k, label) };
    }
    case 'feints': {
      // Built like the explorer grid: a schedule, and in 2 against 2 a partner with the same
      // schedule, v1 Zap or a schedule of its own (both opponents on one schedule or on two).
      const f = drawFeint(p, rand);
      const r = rand();
      const partner = r < 1 / 3 ? 'same' : r < 2 / 3 ? 'v1' : 'own';
      const own = partner === 'own' ? drawFeint(p, rand) : null;
      const mate =
        partner === 'same'
          ? { label: f.label, make: f.make }
          : partner === 'v1'
            ? { label: 'v1', make: () => personaAgent(p.v1, 'zap', p.v1Knobs) }
            : own!;
      return { kind, label: `${f.label}/${partner === 'own' ? `own:${own!.label}` : partner}`, make: f.make, mate };
    }
  }
}

/** Reads the training family of a run from its args.json (train.py arguments); M6_FAMILY without one. */
export function trainingFamilyOf(args: Record<string, unknown> | null | undefined): TrainingFamily {
  if (!args) return { switching: { hands: [1, 6] }, feints: null, extremes: true };
  const mix = typeof args.league_mix === 'string' ? parseMix(args.league_mix) : M6_MIX;
  const range = (v: unknown, d: [number, number]): [number, number] => {
    if (typeof v !== 'string') return d;
    const [lo, hi] = v.split(',').map(Number);
    return [lo, hi];
  };
  return {
    switching: mix.switching > 0 ? { hands: range(args.switch_hands, [1, 6]) } : null,
    feints: mix.feints > 0 ? { hands: range(args.feint_hands, FEINT_HANDS), evidence: range(args.feint_evidence, FEINT_EVIDENCE) } : null,
    extremes: mix.extremes > 0,
  };
}

export interface MatchSetup {
  /** Agent per seat, 'learn' for the learning network. */
  seats: (Agent | 'learn')[];
  /** Kind and label of every drawn opponent or partner, for the setup counts in the logs. */
  labels: string[];
}

/**
 * Seats one match: the learning team on its seats, the opponent team drawn from the mix. 2 against
 * 2: when the first draw is 'current', both opponents are the network; when the draw decides the
 * second opponent itself ('feints', Draw.mate), that one; otherwise the second opponent is the same
 * player (a separate instance) with chance twoStyles, else its own draw without 'current'. Partner swap (2 against 2, chance partnerSwap): one learning seat is replaced
 * by a draw without 'current'. Every random number comes from `rand`, the setup stream.
 */
export function seatMatch(n: 2 | 4, learnTeam: number, mix: LeagueMix, rand: () => number, p: LeaguePlayers, twoStyles: number, partnerSwap: number): MatchSetup {
  const seats: (Agent | 'learn')[] = new Array(n).fill('learn');
  const labels: string[] = [];
  const d1 = drawOpponent(mix, rand, p);
  labels.push(`${d1.kind}:${d1.label}`);
  const opp = [...Array(n).keys()].filter((s) => (s & 1) !== learnTeam);
  if (d1.kind !== 'current') {
    seats[opp[0]] = d1.make();
    if (n === 4 && d1.mate) {
      seats[opp[1]] = d1.mate.make();
      labels.push(`${d1.kind}:${d1.mate.label}`);
    } else if (n === 4) {
      if (rand() < twoStyles) {
        seats[opp[1]] = d1.make();
        labels.push(`${d1.kind}:${d1.label}`);
      } else {
        const d2 = drawOpponent(mix, rand, p, true);
        seats[opp[1]] = d2.make();
        labels.push(`${d2.kind}:${d2.label}`);
      }
    }
  }
  if (n === 4 && rand() < partnerSwap) {
    const swapSeat = learnTeam + 2 * Math.floor(rand() * 2);
    const d = drawOpponent(mix, rand, p, true);
    seats[swapSeat] = d.make();
    labels.push(`partner:${d.kind}:${d.label}`);
  }
  return { seats, labels };
}
