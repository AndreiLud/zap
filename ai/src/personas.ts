// The AI characters. They all share the same network; each one is a set of knobs applied at
// decision time (see net-agent.ts). Their profile cards on the site show numbers measured in
// self-play (ai/bench/persona-stats.ts), never these knob values.

import { BASE_PARAMS, type HeuristicParams } from './heuristic.ts';
import type { Model } from './mlp.ts';
import { NEUTRAL_KNOBS, NetAgent, type Knobs, type NetOptions } from './net-agent.ts';

export type PersonaId = 'otavio' | 'bento' | 'lia' | 'ravi' | 'iara' | 'zap';

export interface Persona {
  id: PersonaId;
  /** Display name (the same in both languages). Style and lines live in the locale files. */
  name: string;
  knobs: Knobs;
}

const k = (over: Partial<Knobs>): Knobs => ({ ...NEUTRAL_KNOBS, ...over });
const style = (over: Partial<HeuristicParams>): HeuristicParams => ({ ...BASE_PARAMS, ...over });

/** Betting styles, as heuristic parameters. Card play always comes from the network. */
export const STYLES = {
  cautious: style({ raise: [0.9, 0.93, 0.95, 0.97], accept: [0.68, 0.72, 0.76, 0.8], reraise: [0.95, 0.97, 0.99], onze: 0.62, bluff: 0 }),
  // Raises with weak hands and holds the bluff when the other side raises back.
  bluffer: style({ raise: [0.72, 0.78, 0.84, 0.9], accept: [0.36, 0.4, 0.45, 0.5], reraise: [0.82, 0.88, 0.94], bluff: 0.6, bluffBelow: 0.4, signalTruth: 0.75 }),
  // Raises with almost anything and almost never runs.
  aggressive: style({ raise: [0.35, 0.4, 0.45, 0.5], accept: [0.12, 0.15, 0.2, 0.25], reraise: [0.5, 0.55, 0.6], onze: 0.3, bluff: 0.25 }),
  calculating: style({ bluff: 0, raise: [0.76, 0.8, 0.86, 0.92], accept: [0.5, 0.52, 0.55, 0.6], reraise: [0.84, 0.9, 0.95] }),
};

// Default knobs; ai/bench/calibrate-personas.ts sets the shares for each model version.
export const PERSONAS: readonly Persona[] = [
  // Cautious: asks for truco only with strong hands and runs early.
  { id: 'otavio', name: 'Otávio', knobs: k({ temperature: 1.2, style: STYLES.cautious, styleShare: 0.7 }) },
  // Bluffer: raises with weak hands and keeps the pressure.
  { id: 'bento', name: 'Bento', knobs: k({ style: STYLES.bluffer, styleShare: 0.6, signalLie: 0.2 }) },
  // Aggressive: raises and re-raises a lot, almost never runs.
  { id: 'lia', name: 'Lia', knobs: k({ style: STYLES.aggressive, styleShare: 0.6 }) },
  // Unpredictable: changes style from one hand to the next.
  { id: 'ravi', name: 'Ravi', knobs: k({ switchStyles: [STYLES.cautious, STYLES.aggressive], styleShare: 1 }) },
  // Calculating: bluffs little, accepts and runs by the numbers.
  { id: 'iara', name: 'Iara', knobs: k({ temperature: 0.6, style: STYLES.calculating, styleShare: 0.35 }) },
  // The main agent, at full strength.
  { id: 'zap', name: 'Zap', knobs: k({ temperature: 0.6 }) },
];

export function persona(id: PersonaId): Persona {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown persona ${id}`);
  return p;
}

/**
 * Knobs calibrated for one model version (ai/bench/calibrate-personas.ts) travel with that
 * model; without them, the defaults above are used.
 */
export type CalibratedKnobs = Partial<Record<PersonaId, Knobs>>;

export function personaAgent(model: Model, id: PersonaId, calibrated?: CalibratedKnobs, opts?: NetOptions): NetAgent {
  const p = persona(id);
  return new NetAgent(model, calibrated?.[id] ?? p.knobs, p.id, opts);
}
