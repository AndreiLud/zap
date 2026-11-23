// A slice of the events a local site wrote, for the human layer step of the end to end proof
// (tests/sim/cycle-e2e.sh): only the match records of the given simulated player runs, plus the
// export and receipt files, copied from the bridge folder of a site (.cache/bridge/<from>/events)
// into the fixtures folder of the bridge (.cache/bridge/fixtures/events), which the cycle's
// `bridge push --state fixtures` sends to the stand-in.
//
//   node tests/sim/slice-events.ts --from dev --sim .cache/e2e-cycle/sim-1.json --sim .cache/e2e-cycle/sim-metronome.json

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const from = process.argv[process.argv.indexOf('--from') + 1];
if (from !== 'dev' && from !== 'e2e') {
  console.error('--from must be dev or e2e');
  process.exit(2);
}
const sims = process.argv.flatMap((a, i) => (a === '--sim' ? [process.argv[i + 1]] : []));
const ids = new Set(sims.flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { matchIds: string[] }).matchIds));
const src = join('.cache', 'bridge', from, 'events');
const dst = join('.cache', 'bridge', 'fixtures', 'events');

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

rmSync(dst, { recursive: true, force: true });
let records = 0;
let other = 0;
for (const f of files(src)) {
  const key = relative(src, f).split(sep).join('/');
  const isRecord = key.startsWith('matches/');
  if (isRecord && !ids.has(key.slice(key.lastIndexOf('/') + 1).replace(/\.json$/, ''))) continue;
  mkdirSync(dirname(join(dst, key)), { recursive: true });
  copyFileSync(f, join(dst, key));
  if (isRecord) records++;
  else other++;
}
console.log(JSON.stringify({ from, matchIds: ids.size, records, otherFiles: other }));
process.exit(records === ids.size ? 0 : 1);
