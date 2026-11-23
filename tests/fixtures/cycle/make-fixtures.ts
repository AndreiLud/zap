// Writes the shared test files of every cycle format: tests/fixtures/cycle/<schema>/valid/*.json
// and .../invalid/<broken-rule>.json, one broken rule per invalid file. Both
// worker/test/cycle-formats.test.ts and training/cycle/tests/test_formats.py accept every valid
// file and refuse every invalid one. Run again after a change of shared/cycle-formats.ts:
//
//   docker compose run --rm -T node node tests/fixtures/cycle/make-fixtures.ts
//
// It checks each file against the TypeScript validators before writing it.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALIDATORS, SCHEMAS } from '../../../shared/cycle-formats.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const T = 1_763_800_000_000;
const DAY = 86_400_000;
const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(16);
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));

type Obj = Record<string, any>;
interface Format {
  schema: string;
  valid: Record<string, Obj>;
  /** Broken rule: [base valid file, mutation]. A string mutation is raw JSON text written as is. */
  invalid: Record<string, [string, (x: Obj) => void] | string>;
}

const bundled = JSON.parse(readFileSync(join(ROOT, '../../../ai/models/bootstrap/manifest.json'), 'utf8'));
const v1Entry = { sha256: bundled.sha256, bytes: bundled.bytes, arch: 'mlp-v1', features: 'v1', inputs: 431, hidden: [256, 256], adapt: null, personas: bundled.personas, createdAt: T - 10 * DAY };
const v2Entry = { sha256: H('a'), bytes: 190_000, arch: 'mlp-v1', features: 'v1', inputs: 431, hidden: [256, 256], adapt: null, personas: {}, createdAt: T - 7 * DAY };
const v3Entry = { sha256: H('b'), bytes: 200_123, arch: 'mlp-v1', features: 'v2', inputs: 461, hidden: [256, 256], adapt: { bmax: 0.1, nHalf: 2 }, personas: { zap: bundled.personas.zap }, createdAt: T };

const segments = ['paulista-2', 'paulista-4', 'mineiro-2', 'mineiro-4'];
const perSeg = <X>(f: (s: string, i: number) => X) => Object.fromEntries(segments.map((s, i) => [s, f(s, i)]));
const gatePass = {
  schema: SCHEMAS.gate,
  candidate: { version: 'v3', sha256: H('b') },
  current: { version: 'v2', sha256: H('a') },
  seed: H('c'),
  stats: 'empty',
  sprt: { decision: 'accept', llr: 3.1, lower: -2.944, upper: 2.944, pairs: 2400, mean: 0.531, perSegment: perSeg((_, i) => ({ pairs: 600, mean: 0.52 + i / 100 })) },
  segments: perSeg(() => ({ pairs: 2500, mean: 0.53, lo95: 0.012, pass: true })),
  panel: ['random', 'base', 'tuned', 'v1', 'v2'].map((member) => ({
    member,
    pairs: 4000,
    candidate: { mean: 0.7, lo: 0.68, hi: 0.72 },
    current: { mean: 0.69, lo: 0.67, hi: 0.71 },
    diff: { mean: 0.01, lo95: -0.004 },
    pass: true,
  })),
  personas: { orderHolds: true, source: 'work/20261121-0100/gate/personas.json' },
  pass: true,
  reasons: [],
  seconds: 3605.2,
};
const gateFail = { ...clone(gatePass), sprt: { ...gatePass.sprt, decision: 'inconclusive', llr: 0.4 }, pass: false, reasons: ['The sequential test reached its cap without a decision.'] };

// card.explorer of a file that can read (training/cycle/zapcycle/explorer.py card_block).
const trainedLabel = 'training/cycle/data/prod/explorer/20261128-2200/1/explorer-run/explorer.zapw';
// [explorer] of training/cycle/config/prod.toml, as a step records it (zapcycle/explorer.py settings).
const explorerSettings = { check_pairs: 200, fresh_pairs: 2000, grid_limit: 0, limit: 0.01, measure_pairs: 2000, on: true, pool: 'all', reserve_hours: 6, round_pairs: 64, seeds: 'cycle', style_matches: 500, threads: 4, trained_critic_warmup: 5, trained_decisions: 120000, trained_eval_every: 10, trained_eval_pairs: 200, trained_hours: 3, trained_iters: 103, trained_threads: 3, trained_workers: 3, twin: 'ai/models/bootstrap/zap-v2.zapw', twin2: 'ai/models/bootstrap/zap-v2.zapw' };
const explorerPass = {
  network: H('e'),
  sha256: H('b'),
  pass: true,
  limit: 0.01,
  source: 'measured',
  reusedFrom: null,
  verdicts: [
    { explorer: 'neverRaises>bluffer@3/same', kind: 'scripted', sha256: H('b'), mean: 0.00488, upper95: 0.00773, pairs: 8000, pass: true },
    { explorer: 'trapper>bluffer@3/v1', kind: 'scripted', sha256: H('b'), mean: 0.00256, upper95: 0.00501, pairs: 8000, pass: true },
    { explorer: trainedLabel, kind: 'trained', sha256: H('b'), mean: -0.01, upper95: -0.00569, pairs: 8000, pass: true },
  ],
  failuresOnRecord: ['trapper>bluffer@3/v1'],
  pending: [],
  reasons: [],
  measuredOnRecord: ['neverRaises>bluffer@3/same'],
  settings: explorerSettings,
  ppo: { iterations: 103, wanted: 103 },
  lifted: null,
};
const explorerFail = {
  ...clone(explorerPass),
  pass: false,
  verdicts: [{ ...explorerPass.verdicts[0], mean: 0.0083, upper95: 0.0112, pass: false }, ...clone(explorerPass.verdicts.slice(1))],
  reasons: ['neverRaises>bluffer@3/same (scripted): adaptation part 0.83 points, one-sided 95% upper bound 1.12, above the limit of 1.00.'],
};
const explorerNotRun = { ...clone(explorerPass), pass: false, source: 'none', verdicts: [], pending: ['trapper>bluffer@3/v1', 'neverRaises>bluffer@3/same'], reasons: ['Not run: the config turns the explorer step off ([explorer] on is not true).'], ppo: null };
const explorerReused = { ...clone(explorerPass), source: 'reused', reusedFrom: { source: 'facts.json ai.adaptation.explorer.criterion', sha256: H('c'), at: T - DAY }, verdicts: explorerPass.verdicts.map((v) => ({ ...v, sha256: H('c') })), ppo: null };
const explorerLifted = { ...clone(explorerPass), lifted: { reason: 'A rounding error in the earlier measure, checked by hand.', at: T, failedIn: ['cycle 20261121-2200'] } };
// A card written before milestone 10: none of the optional fields.
const explorerBefore = (({ measuredOnRecord, settings, ppo, lifted, ...rest }) => rest)(clone(explorerPass));

const card = (over: Obj): Obj => ({
  schema: SCHEMAS.card,
  version: 'v1',
  parent: null,
  cycleId: null,
  createdAt: T - 10 * DAY,
  result: 'bootstrap',
  resultAt: T - 10 * DAY,
  reason: 'First model, shipped in the Worker bundle.',
  model: { sha256: v1Entry.sha256, bytes: v1Entry.bytes, arch: 'mlp-v1', features: 'v1', inputs: 431, hidden: [256, 256], adapt: null },
  training: null,
  data: null,
  gate: null,
  personas: null,
  twin: null,
  ab: null,
  ...over,
});
const promoted = card({
  version: 'v3',
  parent: 'v2',
  cycleId: '20261121-0100',
  createdAt: T,
  result: 'promoted',
  resultAt: T + 3600_000,
  reason: 'Passed every rule of the gate.',
  model: { sha256: H('b'), bytes: 200_123, arch: 'mlp-v1', features: 'v2', inputs: 461, hidden: [256, 256], adapt: { bmax: 0.1, nHalf: 2 } },
  training: { args: ['--iters', '390'], iterations: 390, seconds: 30_000.5, seedBase: 'c4', leagueFiles: ['zz-v2.zapw'], humanModel: null, commit: '9f20bbe' },
  data: {
    records: 1200,
    valid: 1190,
    invalid: 10,
    test: 0,
    validMatches: 1100,
    linkedSeats: 1500,
    people: 64,
    recordsSha256: H('d'),
    exportDate: '2026-11-21',
    exportSha256: H('e'),
    excluded: { unlinked: 3, flagged: 1, friends: 20, auto: 40, forced: 900, capped: 0 },
  },
  gate: gatePass,
  personas: { knobsSha256: H('f'), orderHolds: true, stats: { zap: { trucoRate: 0.4, bluffRate: 0.1, runRate: 0.3, reraiseRate: 0.05, signalTruth: 0.9, vsZap: 0.5 } } },
  twin: { sha256: H('1'), headToHead: { pairs: 2000, mean: 0.51, lo: 0.49, hi: 0.53 }, seedFloor: { pairs: 2000, mean: 0.502, lo: 0.48, hi: 0.52 }, seedFloorCycle: '20261107-2200', seedNoise: { floors: 2, rms: 0.0035 } },
  ab: { from: T + 3600_000, until: T + 15 * DAY, matches: { candidate: 140, control: 60 }, people: 46, drop: 0.004, lo: -0.03, hi: 0.04, detectablePoints: 4.5, rolledBack: false },
});

const status = (over: Obj = {}): Obj => ({
  schema: SCHEMAS.status,
  state: 'ok',
  startedAt: T,
  finishedAt: T + 3600_000,
  updatedAt: T + 3600_000,
  cycleId: '20261121-0100',
  step: 'idle',
  lastPromotion: { version: 'v3', at: T + 3600_000 },
  message: 'Cycle 20261121-0100 done: v3 promoted.',
  ...over,
});

const row = (i: number, over: Obj = {}) => ({
  matchId: `3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a${String(i).padStart(2, '0')}`,
  seat: i % 4,
  weight: 0.875,
  flagged: false,
  openDataOptOut: false,
  noAdapt: i % 2 === 1,
  group: G(String(i % 10)),
  ...over,
});
const exportFull = {
  schema: SCHEMAS.export,
  date: '2026-11-21',
  createdAt: Date.UTC(2026, 10, 21, 4, 0, 5),
  partial: false,
  rows: [row(0), row(1, { weight: 1 }), row(2, { weight: 0, flagged: true }), row(3, { weight: 0.5, openDataOptOut: true })],
  reports: [
    { id: 7, day: '2026-11-20', reason: 'cheating', matchId: row(0).matchId, seat: 1, group: G('1') },
    { id: 8, day: '2026-11-21', reason: 'nickname', matchId: null, seat: 2, group: null },
  ],
};

const offJobs = {
  retention: { status: 'ok', error: null, counts: { devices: 0, reports: 0, flags: 0, rooms: 3, members: 4, calls: 0, exportGroups: 0, profiles: 0 } },
  calls: { status: 'ok', error: null, delivered: 0 },
  flags: { status: 'off', error: null, sha256: null, applied: [], ignored: [], unresolved: [], reviewed: [] },
  priors: { status: 'off', error: null, sha256: null, imported: false },
  export: { status: 'off', error: null, key: null, rows: 0, reports: 0, partial: false, sha256: null },
  alert: { status: 'off', error: null, sent: false, reason: null },
};
const receipt = (jobs: Obj): Obj => ({ schema: SCHEMAS.receipt, date: '2026-11-21', createdAt: Date.UTC(2026, 10, 21, 4, 0, 9), jobs });
const busyJobs = {
  ...clone(offJobs),
  calls: { status: 'ok', error: null, delivered: 2 },
  flags: { status: 'ok', error: null, sha256: H('2'), applied: [`2026-11-20:${G('a')}`], ignored: [], unresolved: [`2026-11-19:${G('b')}`], reviewed: [] },
  priors: { status: 'skipped', error: null, sha256: H('3'), imported: false },
  export: { status: 'ok', error: null, key: 'exports/2026-11-21.json', rows: 4, reports: 2, partial: false, sha256: H('4') },
  alert: { status: 'ok', error: null, sent: true, reason: 'failed' },
};

const readingKeys = ['raise', 'run', 'accept', 'reraise', 'shown', 'cover', 'bluff', 'signalTruth'];
const priorsSegments = perSeg(() => ({ raise: 0.4, run: 0.45, accept: 0.5, reraise: 0.05, shown: 0.5, cover: 0.15 }));
const priors = (over: Obj = {}): Obj => ({
  schema: SCHEMAS.priors,
  createdAt: T,
  source: 'selfplay',
  people: null,
  numbers: Object.fromEntries(readingKeys.map((k, i) => [k, { mean: 0.1 + i / 10, strength: 2, people: null }])),
  time: { mu: Math.log(3000), tau: 1, sigma: 1 },
  alpha: 2,
  segments: priorsSegments,
  readingSegments: perSeg(() => ({ bluff: 0.2 })),
  ...over,
});

const flags = (ops: Obj[]): Obj => ({ schema: SCHEMAS.flags, createdAt: T, ops });
const flagOp = { ref: `2026-11-20:${G('a')}`, op: 'flag', reason: 'regular-times', evidence: 'cv 0.04 over 260 decisions', at: T - DAY };

const layers = Object.fromEntries(
  ['humanModel', 'priors', 'adaptation', 'playerTypes', 'ranking', 'openData', 'flags'].map((k) => [k, { on: false, why: 'Waits for more matches.', progress: { matches: 120, people: null } }]),
);
const summary = (over: Obj = {}): Obj => ({
  schema: SCHEMAS.summary,
  generatedAt: T,
  minPeople: 20,
  training: { state: 'ok', finishedAt: null, current: 'v1', nextAfter: null },
  humansVsZap: { matches: 0, humanWins: 0, since: null },
  versions: [{ version: 'v1', promotedAt: T - 10 * DAY, result: 'bootstrap', anchors: null }],
  ab: null,
  layers,
  cells: [],
  playerTypes: null,
  ...over,
});
const anchors = Object.fromEntries(['random', 'base', 'tuned', 'v1'].map((a) => [a, { mean: 0.7, lo: 0.68, hi: 0.72 }]));
const summaryFull = summary({
  training: { state: 'ok', finishedAt: T + 3600_000, current: 'v3', nextAfter: T + 15 * DAY },
  humansVsZap: { matches: 1500, humanWins: 600, since: T - 9 * DAY },
  versions: [
    { version: 'v1', promotedAt: T - 10 * DAY, result: 'bootstrap', anchors: null },
    { version: 'v3', promotedAt: T + 3600_000, result: 'promoted', anchors },
  ],
  ab: { version: 'v3', control: 'v2', share: 0.3, from: T + 3600_000, until: T + 15 * DAY, detectablePoints: null, result: null },
  cells: [{ week: '2026-W47', variant: 'paulista', players: 4, people: 31, matches: 400, humanWinRate: 0.41 }],
  playerTypes: { k: 2, ari: 0.82, types: [0.6, 0.4].map((share) => ({ share, center: Object.fromEntries(readingKeys.map((k) => [k, 0.5])) })) },
});

// zap-summary/2 (milestone 7): the /1 fields, a wider version entry, the seed noise, the scoreboard
// and the place kept for disagreements. Stored in the same folder: validateSummary reads both.
const summaryV2 = (over: Obj = {}): Obj => ({
  ...summary(),
  schema: SCHEMAS.summary2,
  versions: [{ version: 'v1', promotedAt: T - 10 * DAY, result: 'bootstrap', anchors: null, twin: null, personas: null, data: null }],
  seedNoise: null,
  scoreboard: [],
  disagreements: null,
  ...over,
});
const personaStats = { trucoRate: 0.4, bluffRate: 0.1, runRate: 0.3, reraiseRate: 0.05, signalTruth: 0.9, vsZap: 0.5 };
const summaryV2Full = summaryV2({
  training: summaryFull.training,
  humansVsZap: summaryFull.humansVsZap,
  versions: [
    { version: 'v1', promotedAt: T - 10 * DAY, result: 'bootstrap', anchors: null, twin: null, personas: null, data: null },
    { version: 'v2', promotedAt: T - 7 * DAY, result: 'promoted', anchors, twin: null, personas: { pairs: 1600, stats: { zap: { ...personaStats }, otavio: { ...personaStats, vsZap: 0.27 } } }, data: null },
    {
      version: 'v3',
      promotedAt: T + 3600_000,
      result: 'promoted',
      anchors,
      twin: { pairs: 2000, mean: 0.51, lo: 0.49, hi: 0.53 },
      personas: { pairs: 1600, stats: { zap: { ...personaStats } } },
      data: { validMatches: 1100, people: 64 },
    },
  ],
  ab: summaryFull.ab,
  cells: summaryFull.cells,
  playerTypes: summaryFull.playerTypes,
  seedNoise: { floors: 2, rms: 0.0035 },
  scoreboard: [
    { variant: 'paulista', players: 2, aiVersion: 'v3', partnerVersion: null, people: 22, matches: 180, humanWins: 61 },
    { variant: 'paulista', players: 4, aiVersion: 'v3', partnerVersion: 'v2', people: 31, matches: 260, humanWins: 104 },
    { variant: 'paulista', players: 4, aiVersion: 'v2', partnerVersion: 'v2', people: 40, matches: 300, humanWins: 117 },
  ],
  disagreements: { types: [{ type: 'answer', people: 25, decisions: 900, share: 0.031 }] },
});
// A first summary written right after a version trained with a few people's games: their count
// stays hidden (people null under 20), and nothing from people has a row yet.
const summaryV2Few = summaryV2({
  versions: [
    { version: 'v1', promotedAt: T - 10 * DAY, result: 'bootstrap', anchors: null, twin: null, personas: null, data: null },
    { version: 'v2', promotedAt: T, result: 'promoted', anchors, twin: { pairs: 400, mean: 0.5, lo: 0.47, hi: 0.53 }, personas: null, data: { validMatches: 40, people: null } },
  ],
  training: { state: 'ok', finishedAt: T, current: 'v2', nextAfter: T + 14 * DAY },
  humansVsZap: { matches: 40, humanWins: 12, since: T - 2 * DAY },
});

const hidden = (key: string) => ({ key, n: 0, shown: false, value: null, low: null, high: null, population: 0.4, source: 'selfplay' });
const reading = (over: Obj = {}): Obj => ({
  schema: SCHEMAS.reading,
  generatedAt: T,
  noAdapt: false,
  matches: 3,
  decisions: 120,
  priors: 'selfplay',
  numbers: readingKeys.map((k, i) => (i === 0 ? { key: k, n: 60, shown: true, value: 0.42, low: 0.31, high: 0.53, population: 0.4, source: 'selfplay' } : hidden(k))),
  time: { n: 100, shown: true, medianMs: 2900, lowMs: 2600, highMs: 3300 },
  ...over,
});

const FORMATS: Format[] = [
  {
    schema: 'zap-manifest',
    valid: {
      init: { schema: SCHEMAS.manifest, current: 'v1', control: null, controlShare: 0.3, controlUntil: null, updatedAt: T - 10 * DAY, models: { v1: v1Entry } },
      'test-window': { schema: SCHEMAS.manifest, current: 'v3', control: 'v2', controlShare: 0.3, controlUntil: T + 14 * DAY, updatedAt: T, models: { v1: v1Entry, v2: v2Entry, v3: v3Entry } },
    },
    invalid: {
      'unexpected-field': ['init', (x) => (x.note = 'x')],
      'missing-updatedAt': ['init', (x) => delete x.updatedAt],
      'current-not-in-models': ['init', (x) => (x.current = 'v2')],
      'control-equals-current': ['test-window', (x) => (x.control = 'v3')],
      'control-until-without-control': ['init', (x) => (x.controlUntil = T)],
      'control-without-until': ['test-window', (x) => (x.controlUntil = null)],
      'share-above-half': ['init', (x) => (x.controlShare = 0.6)],
      'models-empty': ['init', (x) => (x.models = {})],
      'bad-version-id': ['init', (x) => (x.models.v01 = clone(v1Entry))],
      'bad-sha256': ['init', (x) => (x.models.v1.sha256 = H('A'))],
      'bytes-over-limit': ['init', (x) => (x.models.v1.bytes = 2_097_153)],
      'unknown-arch': ['init', (x) => (x.models.v1.arch = 'mlp-v2')],
      'unknown-features': ['init', (x) => (x.models.v1.features = 'v3')],
      'v2-without-adapt': ['test-window', (x) => (x.models.v3.adapt = null)],
      'adapt-on-v1': ['init', (x) => (x.models.v1.adapt = { bmax: 0.1, nHalf: 2 })],
      'adapt-not-positive': ['test-window', (x) => (x.models.v3.adapt.bmax = 0)],
      'unknown-persona': ['init', (x) => (x.models.v1.personas.nobody = x.models.v1.personas.zap)],
      'knobs-missing-field': ['init', (x) => delete x.models.v1.personas.zap.temperature],
      'knob-not-a-number': ['init', (x) => (x.models.v1.personas.zap.temperature = '0.6')],
      'knob-temperature-zero': ['init', (x) => (x.models.v1.personas.zap.temperature = 0)],
      'knob-temperature-negative': ['init', (x) => (x.models.v1.personas.zap.temperature = -1)],
      'knob-signal-lie-above-one': ['init', (x) => (x.models.v1.personas.bento.signalLie = 7)],
      'knob-style-share-negative': ['init', (x) => (x.models.v1.personas.lia.styleShare = -0.1)],
      'knob-offset-out-of-range': ['init', (x) => (x.models.v1.personas.zap.raise = 1e6)],
      'knob-persona-too-long': ['init', (x) => (x.models.v1.personas.zap.persona = Array(9).fill(0))],
      'knob-infinite': JSON.stringify({ schema: SCHEMAS.manifest, current: 'v1', control: null, controlShare: 0.3, controlUntil: null, updatedAt: T, models: { v1: { ...v1Entry, personas: { zap: { ...bundled.personas.zap, temperature: 12345 } } } } }).replace('12345', '1e999'),
    },
  },
  {
    schema: 'zap-card',
    valid: {
      'v1-bootstrap': card({}),
      'v3-promoted': promoted,
      'v4-rejected': card({ ...clone(promoted), version: 'v4', parent: 'v3', result: 'rejected', reason: 'The sequential test reached its cap.', gate: gateFail, ab: null }),
      'v3-promoted-explorer': { ...clone(promoted), explorer: explorerPass },
      'v4-rejected-explorer': card({ ...clone(promoted), version: 'v4', parent: 'v3', result: 'rejected', reason: 'Passed the gate. Not promoted by the explorer test: neverRaises>bluffer@3/same (scripted): adaptation part 0.83 points, one-sided 95% upper bound 1.12, above the limit of 1.00.', ab: null, explorer: explorerFail }),
      'v5-rejected-not-run': card({ ...clone(promoted), version: 'v5', parent: 'v3', result: 'rejected', reason: 'Refused by the explorer guard.', ab: null, explorer: explorerNotRun }),
      'v6-promoted-reused': { ...clone(promoted), version: 'v6', explorer: explorerReused },
      'v7-promoted-lifted': { ...clone(promoted), version: 'v7', explorer: explorerLifted },
      'v3-promoted-explorer-before-m10': { ...clone(promoted), explorer: explorerBefore },
    },
    invalid: {
      'explorer-limit-above-one-point': ['v3-promoted-explorer', (x) => (x.explorer.limit = 0.02)],
      'explorer-verdict-pass-above-limit': ['v3-promoted-explorer', (x) => (x.explorer.verdicts[0].upper95 = 0.0125)],
      'explorer-pending-not-on-record': ['v4-rejected-explorer', (x) => (x.explorer.pending = ['rock>runsAll@1/same'])],
      'explorer-promoted-without-pass': ['v3-promoted-explorer', (x) => Object.assign(x.explorer, { pass: false, reasons: ['Failed.'] })],
      'explorer-pass-with-pending': ['v3-promoted-explorer', (x) => (x.explorer.pending = ['trapper>bluffer@3/v1'])],
      'explorer-failing-without-reasons': ['v4-rejected-explorer', (x) => (x.explorer.reasons = [])],
      'explorer-reused-without-source': ['v6-promoted-reused', (x) => (x.explorer.reusedFrom = null)],
      'explorer-verdicts-when-not-run': ['v5-rejected-not-run', (x) => (x.explorer.verdicts = clone(explorerPass.verdicts))],
      'explorer-unexpected-field': ['v3-promoted-explorer', (x) => (x.explorer.extra = 1)],
      'explorer-pass-with-short-ppo': ['v3-promoted-explorer', (x) => (x.explorer.ppo.iterations = 98)],
      'explorer-measured-pass-without-ppo': ['v3-promoted-explorer', (x) => (x.explorer.ppo = null)],
      'explorer-setting-not-scalar': ['v3-promoted-explorer', (x) => (x.explorer.settings.pool = ['all'])],
      'explorer-lift-without-reason': ['v7-promoted-lifted', (x) => (x.explorer.lifted.reason = ' ')],
      'explorer-lift-without-failure': ['v7-promoted-lifted', (x) => (x.explorer.lifted.failedIn = [])],
      'explorer-pending-not-on-either-record': ['v5-rejected-not-run', (x) => (x.explorer.pending = ['rock>runsAll@1/same'])],
      'unexpected-field': ['v1-bootstrap', (x) => (x.extra = 1)],
      'gate-on-bootstrap': ['v1-bootstrap', (x) => (x.gate = gatePass)],
      'bad-result': ['v1-bootstrap', (x) => (x.result = 'accepted')],
      'reason-too-long': ['v1-bootstrap', (x) => (x.reason = 'x'.repeat(501))],
      'bad-cycle-id': ['v3-promoted', (x) => (x.cycleId = '2026-11-21')],
      'people-below-20': ['v3-promoted', (x) => (x.data.people = 19)],
      'export-sha-without-date': ['v3-promoted', (x) => (x.data.exportDate = null)],
      'data-unexpected-field': ['v3-promoted', (x) => (x.data.devices = 3)],
      'model-v2-without-adapt': ['v3-promoted', (x) => (x.model.adapt = null)],
      'twin-lo-above-hi': ['v3-promoted', (x) => (x.twin.headToHead.lo = 0.6)],
      'twin-floor-without-cycle': ['v3-promoted', (x) => (x.twin.seedFloorCycle = null)],
      'twin-noise-without-floors': ['v3-promoted', (x) => (x.twin.seedNoise.floors = 0)],
      'ab-people-below-20': ['v3-promoted', (x) => (x.ab.people = 5)],
      'ab-drop-without-people': ['v3-promoted', (x) => (x.ab.people = null)],
    },
  },
  {
    schema: 'zap-gate',
    valid: { pass: gatePass, inconclusive: gateFail },
    invalid: {
      'pass-without-sprt-accept': ['pass', (x) => (x.sprt.decision = 'reject')],
      'pass-with-failing-segment': ['pass', (x) => (x.segments['mineiro-2'].pass = false)],
      'pass-with-reasons': ['pass', (x) => (x.reasons = ['x'])],
      'fail-without-reasons': ['inconclusive', (x) => (x.reasons = [])],
      'missing-segment': ['pass', (x) => delete x.segments['mineiro-4']],
      'panel-member-twice': ['pass', (x) => x.panel.push(clone(x.panel[0]))],
      'bad-seed': ['pass', (x) => (x.seed = 'c4')],
      'bad-stats': ['pass', (x) => (x.stats = 'on')],
    },
  },
  {
    schema: 'zap-status',
    valid: { ok: status(), running: status({ state: 'running', finishedAt: null, step: 'train', message: 'Training the candidate.' }), failed: status({ state: 'failed', step: 'gate', lastPromotion: null, message: 'gate: time limit' }) },
    invalid: {
      'bad-state': ['ok', (x) => (x.state = 'done')],
      'bad-step': ['ok', (x) => (x.step = 'deploy')],
      'message-too-long': ['ok', (x) => (x.message = 'x'.repeat(501))],
      'message-control-characters': ['ok', (x) => (x.message = 'line one\nline two')],
      'running-without-start': ['running', (x) => (x.startedAt = null)],
      'unexpected-field': ['ok', (x) => (x.host = 'server')],
      'updated-at-not-integer': ['ok', (x) => (x.updatedAt = 1.5)],
    },
  },
  {
    schema: 'zap-export',
    valid: { full: exportFull, 'empty-partial': { ...clone(exportFull), partial: true, rows: [], reports: [] } },
    invalid: {
      'weight-four-decimals': ['full', (x) => (x.rows[0].weight = 0.8751)],
      'flagged-with-weight': ['full', (x) => (x.rows[2].weight = 0.5)],
      'same-seat-twice': ['full', (x) => x.rows.push(clone(x.rows[0]))],
      'group-not-hex': ['full', (x) => (x.rows[0].group = 'zzzzzzzzzzzzzzzz')],
      'seat-out-of-range': ['full', (x) => (x.rows[0].seat = 4)],
      'pseudonym-in-row': ['full', (x) => (x.rows[0].pseudonym = H('9').slice(0, 32))],
      'bad-date': ['full', (x) => (x.date = '2026-02-30')],
      'report-bad-reason': ['full', (x) => (x.reports[0].reason = 'spam')],
    },
  },
  {
    schema: 'zap-receipt',
    valid: { 'jobs-off': receipt(clone(offJobs)), busy: receipt(clone(busyJobs)), 'one-failed': receipt({ ...clone(offJobs), calls: { status: 'failed', error: 'D1_ERROR: timeout', delivered: 0 } }) },
    invalid: {
      'missing-job': ['jobs-off', (x) => delete x.jobs.alert],
      'failed-without-error': ['one-failed', (x) => (x.jobs.calls.error = null)],
      'ok-with-error': ['jobs-off', (x) => (x.jobs.calls.error = 'x')],
      'sent-without-reason': ['busy', (x) => (x.jobs.alert.reason = null)],
      'export-key-other-date': ['busy', (x) => (x.jobs.export.key = 'exports/2026-11-20.json')],
      'bad-ref': ['busy', (x) => (x.jobs.flags.applied = ['2026-11-20:abc'])],
      'error-too-long': ['one-failed', (x) => (x.jobs.calls.error = 'x'.repeat(201))],
      'retention-missing-count': ['jobs-off', (x) => delete x.jobs.retention.counts.profiles],
    },
  },
  {
    schema: 'zap-priors',
    valid: { selfplay: priors(), people: priors({ source: 'people', people: 140, numbers: { ...priors().numbers, raise: { mean: 0.37, strength: 41.5, people: 140 } } }) },
    invalid: {
      'selfplay-with-people': ['selfplay', (x) => (x.people = 3)],
      'people-without-count': ['people', (x) => (x.people = null)],
      'mean-out-of-range': ['selfplay', (x) => (x.numbers.raise.mean = 1)],
      'strength-below-2': ['selfplay', (x) => (x.numbers.cover.strength = 1.5)],
      'strength-above-50': ['people', (x) => (x.numbers.shown.strength = 51)],
      'people-below-20': ['people', (x) => (x.people = 19)],
      'mu-out-of-range': ['selfplay', (x) => (x.time.mu = 1)],
      'answers-not-summing': ['selfplay', (x) => (x.segments['paulista-2'].run = 0.5)],
      'missing-reading-key': ['selfplay', (x) => delete x.numbers.signalTruth],
      'alpha-zero': ['selfplay', (x) => (x.alpha = 0)],
      'selfplay-number-with-people': ['selfplay', (x) => (x.numbers.raise.people = 40)],
      'number-people-above-file': ['people', (x) => (x.numbers.raise.people = 141)],
      'reading-segment-out-of-range': ['selfplay', (x) => (x.readingSegments['mineiro-4'].bluff = 1)],
      'missing-reading-segments': ['selfplay', (x) => delete x.readingSegments],
    },
  },
  {
    schema: 'zap-flags',
    valid: { empty: flags([]), reviewed: flags([flagOp, { ref: flagOp.ref, op: 'confirm', at: T - DAY / 2 }, { ref: `2026-11-19:${G('b')}`, op: 'clear', at: T }]) },
    invalid: {
      'bad-ref': ['reviewed', (x) => (x.ops[0].ref = '2026-11-20:ABCDEFABCDEFABCD')],
      'evidence-with-at-sign': ['reviewed', (x) => (x.ops[0].evidence = 'mail me at x@y')],
      'flag-without-reason': ['reviewed', (x) => delete x.ops[0].reason],
      'confirm-with-reason': ['reviewed', (x) => (x.ops[1].reason = 'volume')],
      'op-after-created': ['reviewed', (x) => (x.ops[2].at = T + 1)],
      'op-older-than-400-days': ['reviewed', (x) => (x.ops[0].at = T - 401 * DAY)],
      'unknown-reason': ['reviewed', (x) => (x.ops[0].reason = 'bot')],
      'ref-not-a-date': ['reviewed', (x) => (x.ops[0].ref = `2026-13-40:${G('a')}`)],
    },
  },
  {
    schema: 'zap-summary',
    valid: { start: summary(), full: summaryFull, 'v2-start': summaryV2(), 'v2-full': summaryV2Full, 'v2-few-people': summaryV2Few },
    invalid: {
      'min-people-not-20': ['start', (x) => (x.minPeople = 10)],
      'cell-below-20': ['full', (x) => (x.cells[0].people = 19)],
      'wins-above-matches': ['full', (x) => (x.humansVsZap.humanWins = 1501)],
      'since-without-matches': ['start', (x) => (x.humansVsZap.since = T)],
      'versions-not-oldest-first': ['full', (x) => x.versions.reverse()],
      'missing-layer': ['start', (x) => delete x.layers.ranking],
      'types-count-not-k': ['full', (x) => (x.playerTypes.k = 3)],
      'bad-week': ['full', (x) => (x.cells[0].week = '2026-47')],
      'unknown-schema': ['v2-start', (x) => (x.schema = 'zap-summary/3')],
      'v1-with-scoreboard': ['full', (x) => (x.scoreboard = [])],
      'v2-missing-scoreboard': ['v2-start', (x) => delete x.scoreboard],
      'v2-version-without-twin': ['v2-full', (x) => delete x.versions[0].twin],
      'v2-scoreboard-below-20': ['v2-full', (x) => (x.scoreboard[0].people = 19)],
      'v2-partner-in-one-against-one': ['v2-full', (x) => (x.scoreboard[0].partnerVersion = 'v2')],
      'v2-no-partner-in-two-against-two': ['v2-full', (x) => (x.scoreboard[1].partnerVersion = null)],
      'v2-scoreboard-wins-above-matches': ['v2-full', (x) => (x.scoreboard[0].humanWins = 181)],
      'v2-scoreboard-row-twice': ['v2-full', (x) => x.scoreboard.push({ ...x.scoreboard[2] })],
      'v2-data-people-below-20': ['v2-few-people', (x) => (x.versions[1].data.people = 12)],
      'v2-persona-pairs-zero': ['v2-full', (x) => (x.versions[1].personas.pairs = 0)],
      'v2-persona-unknown': ['v2-full', (x) => (x.versions[1].personas.stats.maria = { ...personaStats })],
      'v2-seed-noise-above-half': ['v2-full', (x) => (x.seedNoise.rms = 0.6)],
      'v2-disagreement-below-20': ['v2-full', (x) => (x.disagreements.types[0].people = 5)],
      'v2-twin-lo-above-hi': ['v2-few-people', (x) => (x.versions[1].twin.lo = 0.6)],
    },
  },
  {
    schema: 'zap-reading',
    valid: {
      shown: reading(),
      'no-adapt': reading({ noAdapt: true, decisions: 0, numbers: readingKeys.map(hidden), time: { n: 0, shown: false, medianMs: null, lowMs: null, highMs: null } }),
    },
    invalid: {
      'shown-with-no-adapt': ['no-adapt', (x) => (x.numbers[0] = { key: 'raise', n: 60, shown: true, value: 0.42, low: 0.31, high: 0.53, population: 0.4, source: 'selfplay' })],
      'bad-source': ['no-adapt', (x) => (x.numbers[1].source = 'zap')],
      'hidden-with-value': ['no-adapt', (x) => (x.numbers[1].value = 0.4)],
      'keys-out-of-order': ['shown', (x) => ([x.numbers[0], x.numbers[1]] = [x.numbers[1], x.numbers[0]])],
      'decisions-with-no-adapt': ['no-adapt', (x) => (x.decisions = 5)],
      'time-shown-without-median': ['shown', (x) => (x.time.medianMs = null)],
      'value-above-one': ['shown', (x) => (x.numbers[0].high = 1.2)],
    },
  },
];

let written = 0;
for (const f of FORMATS) {
  const validate = (VALIDATORS as Record<string, (j: unknown) => { ok: boolean; errors?: string[] }>)[`${f.schema}/1`];
  const dir = join(ROOT, f.schema);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'valid'), { recursive: true });
  mkdirSync(join(dir, 'invalid'), { recursive: true });
  for (const [name, obj] of Object.entries(f.valid)) {
    const r = validate(clone(obj));
    if (!r.ok) throw new Error(`${f.schema}/valid/${name}: ${r.errors!.join('; ')}`);
    writeFileSync(join(dir, 'valid', `${name}.json`), JSON.stringify(obj, null, 2) + '\n');
    written++;
  }
  for (const [rule, spec] of Object.entries(f.invalid)) {
    let text: string;
    if (typeof spec === 'string') text = spec;
    else {
      const x = clone(f.valid[spec[0]]);
      spec[1](x);
      text = JSON.stringify(x, null, 2) + '\n';
    }
    const r = validate(JSON.parse(text));
    if (r.ok) throw new Error(`${f.schema}/invalid/${rule} is accepted`);
    writeFileSync(join(dir, 'invalid', `${rule}.json`), text);
    written++;
  }
}
console.log(`${written} fixture files in ${FORMATS.length} formats`);
