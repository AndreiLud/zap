// The network's forward pass, the same code in training, in the promotion gate and in the
// Durable Object. Weights travel in one binary file:
//
//   "ZAPW" | u32 version | u32 header bytes | header JSON (utf8, padded to 4 bytes) | tensors
//
// The header lists the architecture and every tensor (name, shape, dtype, byte offset from the
// start of the tensor area, and per-row scales for int8). Weight matrices are row major
// [outputs][inputs]. int8 tensors use one symmetric scale per output row.

import type { FeatureVersion } from './features.ts';
import type { Priors } from './opponent-stats.ts';

export interface TensorInfo {
  name: string;
  shape: number[];
  dtype: 'f32' | 'i8';
  offset: number;
  /** Byte offset of the f32 per-row scales, for i8 tensors. */
  scaleOffset?: number;
}

/** Decision-time safety net of an adaptive model (ai/src/safety.ts), chosen by the sweep and written at export. */
export interface AdaptMeta {
  bmax: number;
  nHalf: number;
}

export interface ModelMeta {
  iteration?: number;
  version?: string;
  /** Population priors of the opponent statistics (features v2 and v2-empty). A model carries its own. */
  priors?: Priors;
  priorsSha256?: string;
  adapt?: AdaptMeta;
  [key: string]: unknown;
}

export interface ModelHeader {
  arch: 'mlp-v1';
  /**
   * Input layout: ai/src/features.ts (encoderFor). The type lists the versions a served model may
   * carry; the trained explorer's files say 'v2-self', which only encoderFor and the benches read.
   */
  features: FeatureVersion;
  inputs: number;
  hidden: number[];
  policy: number;
  value: number;
  tensors: TensorInfo[];
  meta?: ModelMeta;
}

interface Layer {
  rows: number;
  cols: number;
  /** f32 weights, or i8 weights with per-row scales. */
  wf?: Float32Array;
  wq?: Int8Array;
  scale?: Float32Array;
  bias: Float32Array;
}

export interface Model {
  header: ModelHeader;
  trunk: Layer[];
  policy: Layer;
  value: Layer;
  /** Scratch buffers, reused between calls. */
  buf: Float32Array[];
}

const MAGIC = 0x5750415a; // "ZAPW" little endian

export function parseModel(bytes: ArrayBuffer | Uint8Array): Model {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a Zap model file');
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`unknown model file version ${version}`);
  const headerLen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + headerLen))) as ModelHeader;
  if (header.arch !== 'mlp-v1') throw new Error(`unknown architecture ${header.arch}`);
  const dataStart = 12 + headerLen + ((4 - (headerLen % 4)) % 4);
  // Copy the tensor area so typed arrays are aligned. (A Node Buffer's slice() is a view, not a copy.)
  const data = new Uint8Array(u8.subarray(dataStart)).buffer;
  const byName = new Map(header.tensors.map((t) => [t.name, t]));
  const layer = (name: string): Layer => {
    const w = byName.get(`${name}.weight`);
    const b = byName.get(`${name}.bias`);
    if (!w || !b) throw new Error(`missing tensor ${name}`);
    const [rows, cols] = w.shape;
    const bias = new Float32Array(data, b.offset, rows);
    if (w.dtype === 'f32') return { rows, cols, wf: new Float32Array(data, w.offset, rows * cols), bias };
    return { rows, cols, wq: new Int8Array(data, w.offset, rows * cols), scale: new Float32Array(data, w.scaleOffset!, rows), bias };
  };
  const trunk = header.hidden.map((_, i) => layer(`trunk.${i}`));
  const model: Model = {
    header,
    trunk,
    policy: layer('policy'),
    value: layer('value'),
    buf: [...header.hidden.map((h) => new Float32Array(h)), new Float32Array(header.policy), new Float32Array(header.value)],
  };
  let prev = header.inputs;
  for (const l of trunk) {
    if (l.cols !== prev) throw new Error('layer shapes do not chain');
    prev = l.rows;
  }
  if (model.policy.cols !== prev || model.value.cols !== prev) throw new Error('head shapes do not match');
  return model;
}

function dense(l: Layer, x: Float32Array, out: Float32Array, relu: boolean): void {
  const { rows, cols, bias } = l;
  if (l.wf) {
    const w = l.wf;
    for (let r = 0; r < rows; r++) {
      let acc = 0;
      const base = r * cols;
      for (let c = 0; c < cols; c++) acc += w[base + c] * x[c];
      acc += bias[r];
      out[r] = relu && acc < 0 ? 0 : acc;
    }
  } else {
    const w = l.wq!;
    const scale = l.scale!;
    for (let r = 0; r < rows; r++) {
      let acc = 0;
      const base = r * cols;
      for (let c = 0; c < cols; c++) acc += w[base + c] * x[c];
      acc = acc * scale[r] + bias[r];
      out[r] = relu && acc < 0 ? 0 : acc;
    }
  }
}

export interface Forward {
  logits: Float32Array;
  /** Raw value head output; winProb() maps it to a probability. */
  value: Float32Array;
}

/** Runs the network on one feature vector. The returned arrays are reused by the next call. */
export function forward(m: Model, x: Float32Array): Forward {
  let h = x;
  for (let i = 0; i < m.trunk.length; i++) {
    dense(m.trunk[i], h, m.buf[i], true);
    h = m.buf[i];
  }
  const logits = m.buf[m.trunk.length];
  const value = m.buf[m.trunk.length + 1];
  dense(m.policy, h, logits, false);
  dense(m.value, h, value, false);
  return { logits, value };
}

export function winProb(f: Forward): number {
  return 1 / (1 + Math.exp(-f.value[0]));
}

/** Masked softmax with temperature; returns probabilities over all actions (0 where illegal). */
export function maskedSoftmax(logits: ArrayLike<number>, mask: number, temperature = 1, out = new Float64Array(logits.length)): Float64Array {
  let max = -Infinity;
  for (let a = 0; a < logits.length; a++) if (mask & (1 << a) && logits[a] > max) max = logits[a];
  let sum = 0;
  for (let a = 0; a < logits.length; a++) {
    if (mask & (1 << a)) {
      const e = Math.exp((logits[a] - max) / temperature);
      out[a] = e;
      sum += e;
    } else out[a] = 0;
  }
  for (let a = 0; a < logits.length; a++) out[a] /= sum;
  return out;
}

export function sample(probs: ArrayLike<number>, rand: () => number): number {
  let u = rand();
  let last = -1;
  for (let a = 0; a < probs.length; a++) {
    if (probs[a] > 0) {
      last = a;
      if (u < probs[a]) return a;
      u -= probs[a];
    }
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// Writing model files (training side and tests)

export interface RawLayer {
  name: string;
  rows: number;
  cols: number;
  weight: Float32Array;
  bias: Float32Array;
}

export function buildModelFile(base: Omit<ModelHeader, 'tensors'>, layers: RawLayer[], dtype: 'f32' | 'i8'): Uint8Array {
  const tensors: TensorInfo[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    chunks.push(bytes);
    if (pad) chunks.push(new Uint8Array(pad));
    const at = offset;
    offset += bytes.byteLength + pad;
    return at;
  };
  for (const l of layers) {
    if (dtype === 'f32') {
      tensors.push({ name: `${l.name}.weight`, shape: [l.rows, l.cols], dtype: 'f32', offset: push(new Uint8Array(l.weight.buffer.slice(l.weight.byteOffset, l.weight.byteOffset + l.weight.byteLength))) });
    } else {
      const q = new Int8Array(l.rows * l.cols);
      const scale = new Float32Array(l.rows);
      for (let r = 0; r < l.rows; r++) {
        let max = 0;
        for (let c = 0; c < l.cols; c++) max = Math.max(max, Math.abs(l.weight[r * l.cols + c]));
        const s = max > 0 ? max / 127 : 1;
        scale[r] = s;
        for (let c = 0; c < l.cols; c++) q[r * l.cols + c] = Math.round(l.weight[r * l.cols + c] / s);
      }
      const info: TensorInfo = { name: `${l.name}.weight`, shape: [l.rows, l.cols], dtype: 'i8', offset: push(new Uint8Array(q.buffer)) };
      info.scaleOffset = push(new Uint8Array(scale.buffer));
      tensors.push(info);
    }
    tensors.push({ name: `${l.name}.bias`, shape: [l.rows], dtype: 'f32', offset: push(new Uint8Array(l.bias.buffer.slice(l.bias.byteOffset, l.bias.byteOffset + l.bias.byteLength))) });
  }
  const header = new TextEncoder().encode(JSON.stringify({ ...base, tensors }));
  const headerPad = (4 - (header.byteLength % 4)) % 4;
  const total = 12 + header.byteLength + headerPad + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, header.byteLength, true);
  out.set(header, 12);
  let p = 12 + header.byteLength + headerPad;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}
