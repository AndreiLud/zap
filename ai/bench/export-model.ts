// Converts a training snapshot (f32) into the file the site loads (int8 weights) and writes a
// manifest with its size and SHA-256. The Durable Object only accepts a model whose hash
// matches the manifest. The features version and the meta (priors of the opponent statistics)
// travel with the model; --adapt writes the decision-time safety net chosen by the sweep.
//
// A model with features v2 needs --adapt: without a safety net it would move on the statistics
// with no budget at all. --no-safety-net exports one anyway, only as the input of the safety
// sweep (which sets the net itself for every setting); the room plays such a file with the
// statistics at no evidence (worker/src/ai-select.ts) and the measurement benches refuse it.
//
// Usage: node ai/bench/export-model.ts <snapshot.zapw> <out-dir> --version vN [--personas calibrated.json] [--adapt bmax,nHalf | --no-safety-net] [--note text]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encoderFor } from '../src/features.ts';
import { buildModelFile, parseModel, type ModelMeta, type RawLayer } from '../src/mlp.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const [input, outDir] = process.argv.slice(2);
const version = arg('version');
if (!input || !outDir || !version || !/^v\d+$/.test(version)) throw new Error('usage: export-model.ts <snapshot.zapw> <out-dir> --version vN');
const model = parseModel(readFileSync(input));
encoderFor(model.header);
const layers: RawLayer[] = [];
const take = (name: string, l: { rows: number; cols: number; wf?: Float32Array; bias: Float32Array }) => {
  if (!l.wf) throw new Error('snapshot must have f32 weights');
  layers.push({ name, rows: l.rows, cols: l.cols, weight: l.wf, bias: l.bias });
};
model.trunk.forEach((l, i) => take(`trunk.${i}`, l));
take('policy', model.policy);
take('value', model.value);
const { tensors: _t, ...base } = model.header;
void _t;
const meta: ModelMeta = { ...(base.meta ?? {}), version };
const adapt = arg('adapt');
const noSafetyNet = process.argv.includes('--no-safety-net');
if (adapt !== undefined && noSafetyNet) throw new Error('--adapt and --no-safety-net exclude each other');
if (model.header.features === 'v2' && adapt === undefined && !noSafetyNet) {
  throw new Error('features v2 need --adapt bmax,nHalf (the safety net); --no-safety-net only for the input of the safety sweep');
}
if (adapt !== undefined) {
  const [bmax, nHalf] = adapt.split(',').map((v) => (v.trim() === 'inf' ? Infinity : Number(v)));
  if (!(bmax > 0) || !(nHalf > 0) || bmax === Infinity) throw new Error('--adapt takes bmax,nHalf with finite positive numbers');
  if (model.header.features !== 'v2') throw new Error('--adapt applies only to features v2');
  meta.adapt = { bmax, nHalf };
}
const bytes = buildModelFile({ ...base, meta }, layers, 'i8');
if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('model file over 2 MB');
// Check that it parses back and that its features are known.
const back = parseModel(bytes);
encoderFor(back.header);
mkdirSync(outDir, { recursive: true });
const file = `zap-${version}.zapw`;
writeFileSync(join(outDir, file), bytes);
const personasPath = arg('personas');
const manifest = {
  version,
  file,
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  arch: back.header.arch,
  features: back.header.features,
  inputs: back.header.inputs,
  hidden: back.header.hidden,
  adapt: meta.adapt ?? null,
  createdAt: new Date().toISOString(),
  source: input,
  note: arg('note') ?? '',
  personas: personasPath ? JSON.parse(readFileSync(personasPath, 'utf8')).knobs : undefined,
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ file: join(outDir, file), bytes: manifest.bytes, sha256: manifest.sha256, features: manifest.features, adapt: manifest.adapt }));
