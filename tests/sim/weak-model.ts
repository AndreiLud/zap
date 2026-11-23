// A deliberately weak model for the local end to end proof (tests/sim/cycle-e2e.sh): a small
// network with random weights (features v1, hidden 16 and 8), written as an f32 training snapshot
// in a run folder, so ai/bench/export-model.ts and the cycle's adopt command take it like any
// snapshot. It plays close to random moves. It only ever goes to the test buckets of the S3
// stand-in and to the local site.
//
//   node tests/sim/weak-model.ts .cache/e2e-cycle/weak     writes <dir>/league/it000001.zapw and <dir>/args.json

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NUM_FEATURES } from '../../ai/src/features.ts';
import { modelBytes, randomLayers } from '../../ai/test/model-helpers.ts';

const dir = process.argv[2];
if (!dir || !dir.startsWith('.cache/')) {
  console.error('usage: weak-model.ts .cache/<folder>');
  process.exit(2);
}
mkdirSync(join(dir, 'league'), { recursive: true });
const bytes = modelBytes(randomLayers(9001, NUM_FEATURES, [16, 8]), 'v1', 'f32', { iteration: 1 });
const file = join(dir, 'league', 'it000001.zapw');
writeFileSync(file, bytes);
// The run arguments the cycle's adopt command reads (training.args of the model card).
writeFileSync(join(dir, 'args.json'), JSON.stringify({ features: 'v1', hidden: '16,8', note: 'random weights, deliberately weak, local proof only' }, null, 2) + '\n');
console.log(JSON.stringify({ file, bytes: bytes.byteLength }));
