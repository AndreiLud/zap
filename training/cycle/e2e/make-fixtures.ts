// Fixture records for the cycle's local end to end without a Worker: simulated matches in the
// zap-match/2 layout with test: true, the daily export that links their seats to random groups,
// and a receipt, written as the events bucket would hold them.
//
// Usage: node training/cycle/e2e/make-fixtures.ts --out DIR --matches N --seed HEX2 [--arms vNEW:vOLD] [--start ISO]
//   --arms  records of an A/B window: solo matches alternate candidate (opponents vNEW) and control.
// Nothing here is a person: groups are random tokens and every record is marked test.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mulberry32 } from '../../../engine/src/rng.ts';
import { recordKey, simulateRecord, type Kind } from '../node/simulate.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const out = arg('out');
if (!out) throw new Error('usage: make-fixtures.ts --out DIR --matches N --seed HEX2 [--arms vNEW:vOLD] [--start ISO]');
const n = Number(arg('matches', '40'));
const seed = arg('seed', '11')!;
if (!/^[0-9a-f]{2}$/.test(seed)) throw new Error('--seed takes two hex characters');
const arms = arg('arms')?.split(':');
const start = arg('start') ? Date.parse(arg('start')!) : Date.now() - n * 4 * 60_000;
const rand = mulberry32(parseInt(seed.repeat(4), 16));
const hex = (k: number) => Array.from({ length: k }, () => Math.floor(rand() * 16).toString(16)).join('');
const groups = Array.from({ length: 8 }, () => hex(16));
const flaggedGroup = groups[7];

const plans: { kind: Kind; players: 2 | 4; humans: number[] }[] = [
  { kind: 'solo1', players: 2, humans: [0] },
  { kind: 'solo2', players: 4, humans: [1] },
  { kind: 'solo1', players: 2, humans: [1] },
  { kind: 'solo2', players: 4, humans: [0] },
  { kind: 'friends', players: 4, humans: [0, 2] },
  { kind: 'mixed', players: 4, humans: [0, 1] },
];

const rows: object[] = [];
const keys: string[] = [];
for (let i = 0; i < n; i++) {
  const plan = plans[i % plans.length];
  const solo = plan.kind === 'solo1' || plan.kind === 'solo2';
  const arm = arms && solo ? (i % 2 ? 'control' : 'candidate') : null;
  const rec = simulateRecord({
    seed: createHash('sha256').update(`${seed}:${i}`).digest('hex'),
    variant: i % 4 < 2 ? 'paulista' : 'mineiro',
    players: plan.players,
    kind: plan.kind,
    humanSeats: plan.humans,
    schema: 2,
    test: true,
    startedAt: start + i * 4 * 60_000,
    aiVersion: arms ? (arm === 'control' ? arms[1] : arms[0]) : 'v1',
    partnerVersion: arms ? arms[1] : 'v1',
    arm,
    medianMs: 900 + 150 * (i % 5),
    autoShare: i % 9 === 0 ? 0.2 : 0,
    style: i % 3 === 0 ? 'random' : 'bold',
  });
  const key = recordKey(rec as { matchId: string; endedAt: number });
  mkdirSync(dirname(join(out, key)), { recursive: true });
  writeFileSync(join(out, key), JSON.stringify(rec));
  keys.push(key);
  for (const seat of plan.humans) {
    if ((i + seat) % 7 === 6) continue; // an unlinked seat (no export row)
    const group = groups[(i * 3 + seat) % groups.length];
    const flagged = group === flaggedGroup;
    rows.push({ matchId: rec.matchId, seat, weight: flagged ? 0 : i % 4 === 3 ? 0.5 : 1, flagged, openDataOptOut: i % 5 === 4, noAdapt: i % 6 === 5, group });
  }
}

const date = new Date().toISOString().slice(0, 10);
// The day's export holds every linked seat so far, as the Worker's export does: earlier rows stay.
const exportPath = join(out, 'exports', `${date}.json`);
const earlier = existsSync(exportPath) ? (JSON.parse(readFileSync(exportPath, 'utf8')) as { rows: object[] }).rows : [];
rows.unshift(...earlier);
const exportFile = { schema: 'zap-export/1', date, createdAt: Date.now(), partial: false, rows, reports: [{ id: 1, day: date, reason: 'nickname', matchId: null, seat: 1, group: groups[2] }] };
const exportBody = JSON.stringify(exportFile);
mkdirSync(join(out, 'exports'), { recursive: true });
writeFileSync(join(out, 'exports', `${date}.json`), exportBody);
const off = { status: 'off', error: null };
const receipt = {
  schema: 'zap-receipt/1',
  date,
  createdAt: Date.now(),
  jobs: {
    retention: { status: 'ok', error: null, counts: { devices: 0, reports: 0, flags: 0, rooms: 0, members: 0, calls: 0, exportGroups: 0, profiles: 0 } },
    calls: { status: 'ok', error: null, delivered: 0 },
    flags: { ...off, sha256: null, applied: [], ignored: [], unresolved: [], reviewed: [] },
    priors: { ...off, sha256: null, imported: false },
    export: { status: 'ok', error: null, key: `exports/${date}.json`, rows: rows.length, reports: 1, partial: false, sha256: createHash('sha256').update(exportBody).digest('hex') },
    alert: { status: 'ok', error: null, sent: false, reason: null },
  },
};
mkdirSync(join(out, 'receipts'), { recursive: true });
writeFileSync(join(out, 'receipts', `${date}.json`), JSON.stringify(receipt));
console.log(JSON.stringify({ out, matches: keys.length, rows: rows.length, groups: groups.length, date, arms: arms ?? null }));
