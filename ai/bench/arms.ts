// The players compared in the milestone 6 measurements, as agent specs for ai/bench/parallel.ts.
//
//   adaptive  the v2 network with the Zap knobs, statistics live, safety net from the model file
//   twin      the network trained the same way without statistics (features v2-empty), Zap knobs
//   ablated   the adaptive network with the statistics forced to no evidence
//   v1        v1 Zap with its shipped knobs
// Characters and extreme styles are always on v1 with the v1 manifest knobs (fixed opponents).

import type { NetOptions } from '../src/net-agent.ts';
import type { PersonaId } from '../src/personas.ts';
import { EXTREMES, HELD_OUT_STYLES, PROXY_EXPLORERS, explorerLabel, type StyleId } from '../src/styles.ts';
import type { AgentSpec } from './parallel.ts';

export function adaptiveArm(model: string, opts: NetOptions = {}, track = false): AgentSpec {
  return { kind: 'net', model, knobs: 'zap', name: 'adaptive', opts, track };
}
export function twinArm(model: string, name = 'twin'): AgentSpec {
  return { kind: 'net', model, knobs: 'zap', name };
}
export function ablatedArm(model: string): AgentSpec {
  return { kind: 'net', model, knobs: 'zap', name: 'ablated', opts: { stats: 'empty' } };
}

const character = (id: PersonaId): AgentSpec => ({ kind: 'character', id });
const style = (id: StyleId): AgentSpec => ({ kind: 'style', id });

/** The 11 styles seen in training: the five characters and six extremes. */
export const TRAINING_STYLES: Record<string, AgentSpec> = {
  otavio: character('otavio'),
  bento: character('bento'),
  lia: character('lia'),
  ravi: character('ravi'),
  iara: character('iara'),
  ...Object.fromEntries(EXTREMES.map((id) => [id, style(id)])),
};

/** Styles never met in training (ai/src/styles.ts HELD_OUT_STYLES): coversAll and coinFlip. */
export const HELD_OUT: Record<string, AgentSpec> = Object.fromEntries(HELD_OUT_STYLES.map((id) => [id, style(id)]));

/**
 * Measurement (a): the training styles, trapper and the held-out styles. trapper was held out until
 * the feints fine-tune made it a phase of the feints; it stays measured, so its row compares the two
 * networks. Which styles count as held out for a given network: styles.ts heldOutStyles.
 */
export const EVAL_STYLES: Record<string, AgentSpec> = { ...TRAINING_STYLES, trapper: style('trapper'), ...HELD_OUT };

/** The fixed proxy explorers (ai/src/styles.ts PROXY_EXPLORERS). */
export const PROXIES: Record<string, AgentSpec> = Object.fromEntries(PROXY_EXPLORERS.map((e) => [explorerLabel(e), { kind: 'explorer', spec: e } as AgentSpec]));

/** Panel members for head to head rows. */
export const PANEL: Record<string, AgentSpec> = {
  v1: character('zap'),
  random: { kind: 'random' },
  heuristic: { kind: 'heuristic', params: 'base' },
  tuned: { kind: 'heuristic', params: 'tuned' },
};
