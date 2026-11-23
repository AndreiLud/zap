// Synthetic models and priors for tests.

import { readFileSync } from 'node:fs';
import { NUM_FEATURES, NUM_FEATURES_V2, type FeatureVersion } from '../src/features.ts';
import { buildModelFile, parseModel, type Model, type ModelMeta, type RawLayer } from '../src/mlp.ts';
import type { Priors } from '../src/opponent-stats.ts';
import { mulberry32 } from '../../engine/src/rng.ts';

/** Plausible priors, fixed for tests (the real ones are measured by ai/bench/opponent-priors.ts). */
export const TEST_PRIORS: Priors = {
  version: 1,
  alpha: 2,
  segments: {
    'paulista-2': { raise: 0.3, run: 0.35, accept: 0.55, reraise: 0.1, shown: 0.6, cover: 0.05 },
    'paulista-4': { raise: 0.35, run: 0.3, accept: 0.6, reraise: 0.1, shown: 0.58, cover: 0.06 },
    'mineiro-2': { raise: 0.28, run: 0.4, accept: 0.5, reraise: 0.1, shown: 0.62, cover: 0.04 },
    'mineiro-4': { raise: 0.33, run: 0.32, accept: 0.58, reraise: 0.1, shown: 0.6, cover: 0.05 },
  },
};

export function randomLayers(seed: number, inputs: number, hidden = [32, 16]): RawLayer[] {
  const rand = mulberry32(seed);
  const dims = [inputs, ...hidden];
  const layers: RawLayer[] = [];
  const mk = (name: string, rows: number, cols: number): RawLayer => ({
    name,
    rows,
    cols,
    weight: Float32Array.from({ length: rows * cols }, () => (rand() - 0.5) * 0.4),
    bias: Float32Array.from({ length: rows }, () => (rand() - 0.5) * 0.1),
  });
  for (let i = 0; i < hidden.length; i++) layers.push(mk(`trunk.${i}`, dims[i + 1], dims[i]));
  layers.push(mk('policy', 15, hidden[hidden.length - 1]));
  layers.push(mk('value', 1, hidden[hidden.length - 1]));
  return layers;
}

/** v1 layers widened to 461 inputs: the statistics columns of the first layer are `fill` (0 by default) or random. */
export function widen(layers: RawLayer[], seed: number | null = null): RawLayer[] {
  const rand = seed === null ? null : mulberry32(seed);
  return layers.map((l, i) => {
    if (i !== 0) return l;
    const cols = NUM_FEATURES_V2;
    const w = new Float32Array(l.rows * cols);
    for (let r = 0; r < l.rows; r++) {
      for (let c = 0; c < l.cols; c++) w[r * cols + c] = l.weight[r * l.cols + c];
      if (rand) for (let c = l.cols; c < cols; c++) w[r * cols + c] = (rand() - 0.5) * 4;
    }
    return { ...l, cols, weight: w };
  });
}

export function makeModel(layers: RawLayer[], features: FeatureVersion, dtype: 'f32' | 'i8' = 'f32', meta: ModelMeta = {}): Model {
  return parseModel(modelBytes(layers, features, dtype, meta));
}

export function modelBytes(layers: RawLayer[], features: FeatureVersion, dtype: 'f32' | 'i8' = 'f32', meta: ModelMeta = {}): Uint8Array {
  const inputs = features === 'v1' ? NUM_FEATURES : NUM_FEATURES_V2;
  const hidden = layers.filter((l) => l.name.startsWith('trunk.')).map((l) => l.rows);
  const m: ModelMeta = features === 'v1' ? meta : { priors: TEST_PRIORS, ...meta };
  return buildModelFile({ arch: 'mlp-v1', features, inputs, hidden, policy: 15, value: 1, meta: m }, layers, dtype);
}

/** The layers of a model file with f32 weights, or dequantized int8 weights (q * scale per row). */
export function layersOf(m: Model): RawLayer[] {
  const take = (name: string, l: Model['policy']): RawLayer => {
    let weight: Float32Array;
    if (l.wf) weight = Float32Array.from(l.wf);
    else {
      weight = new Float32Array(l.rows * l.cols);
      for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) weight[r * l.cols + c] = l.wq![r * l.cols + c] * l.scale![r];
    }
    return { name, rows: l.rows, cols: l.cols, weight, bias: Float32Array.from(l.bias) };
  };
  return [...m.trunk.map((l, i) => take(`trunk.${i}`, l)), take('policy', m.policy), take('value', m.value)];
}

export const V1_PATH = 'ai/models/bootstrap/zap-v1.zapw';
export const loadV1 = (): Model => parseModel(readFileSync(V1_PATH));
