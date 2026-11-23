// What the training cycle serves, recorded in facts.json (tools/docs/record-release.ts and
// tools/docs/releases.ts), and how the READMEs tell it (tools/docs/readme-facts.ts): the version in
// play, the reading in a test with people, on after its window, rolled back, or carried with
// AI_ADAPT off, and a network the explorer test never measured. Every case runs on a copy of
// facts.json with records built from synthetic cards; nothing here reads the cycle's real state.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFacts, ROOT } from '../../tools/docs/facts-docs.ts';
import { docsValues, readmeValues, renderTemplate, runReadmes } from '../../tools/docs/readme-facts.ts';
import { bucketFiles, buildRecords, mergeRecords, readCycle, updateFacts, type CycleSnapshot } from '../../tools/docs/record-release.ts';
import { servedBlock } from '../../tools/data/facts-view.ts';
import { networkSha256, servedReads, servedView } from '../../tools/docs/releases.ts';

const DIR = join(ROOT, '.cache', 'tmp', 'record-release-test');
const FACTS = JSON.parse(readFileSync(join(ROOT, 'facts.json'), 'utf8')) as Record<string, any>;
const V2 = new Uint8Array(readFileSync(join(ROOT, 'ai/models/bootstrap/zap-v2.zapw')));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A model file with its header changed: the same tensors, the header written again and padded. */
function reencode(bytes: Uint8Array, change: (h: Record<string, any>) => void, flip = false): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len)));
  change(header);
  const data = new Uint8Array(bytes.subarray(12 + len + ((4 - (len % 4)) % 4)));
  if (flip) data[100] ^= 1;
  const h = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - (h.length % 4)) % 4;
  const out = new Uint8Array(12 + h.length + pad + data.length);
  out.set(bytes.subarray(0, 8), 0);
  new DataView(out.buffer).setUint32(8, h.length, true);
  out.set(h, 12);
  out.set(data, 12 + h.length + pad);
  return out;
}

const NET = { bmax: 0.2, nHalf: 1 };
/** The adaptive network as the explorer criterion judged it (named v2) and as the cycle published it (v3). */
const JUDGED = reencode(V2, (h) => Object.assign(h, { features: 'v2', meta: { ...h.meta, version: 'v2', adapt: NET } }));
const V3 = reencode(JUDGED, (h) => (h.meta.version = 'v3'));
/** Another network (one weight differs), as an untested cycle version. */
const V4 = reencode(V3, (h) => (h.meta.version = 'v4'), true);

const T = { adopt: '2026-11-23T16:06:07.759Z', until: '2026-12-07T16:06:07.759Z', back: '2026-11-25T10:00:00.000Z', v4: '2026-12-08T10:00:00.000Z' };
const SEGS = ['paulista-2', 'paulista-4', 'mineiro-2', 'mineiro-4'];
const iv = (mean: number) => ({ mean, lo: mean - 0.005, hi: mean + 0.005 });

function card(version: string, parent: string, bytes: Uint8Array, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const member = (m: string, c: number, cur: number) => ({ member: m, pairs: 10000, candidate: iv(c), current: iv(cur), diff: { mean: c - cur, lo95: c - cur - 0.004 }, pass: true });
  return {
    schema: 'zap-card/1',
    version,
    parent,
    cycleId: '20261123-1551',
    result: 'promoted',
    resultAt: Date.parse(T.adopt),
    reason: 'Passed every rule of the gate.',
    model: { sha256: sha(bytes), bytes: bytes.length, arch: 'mlp-v1', features: 'v2', inputs: 461, hidden: [256, 256], adapt: NET },
    training: { iterations: 590, humanModel: null },
    data: null,
    gate: {
      stats: 'live',
      pass: true,
      reasons: [],
      seconds: 636.5,
      sprt: { decision: 'accept', pairs: 1200, mean: 0.533 },
      segments: Object.fromEntries(SEGS.map((s) => [s, { pairs: 2500, mean: 0.515, lo95: 0.006, pass: true }])),
      panel: [member('random', 0.957, 0.954), member('base', 0.799, 0.79), member('tuned', 0.894, 0.871), member('v1', 0.706, 0.7), member(parent, 0.529, 0.5025)],
      personas: { orderHolds: true },
    },
    personas: { orderHolds: true, stats: { otavio: { vsZap: 0.264 }, bento: { vsZap: 0.294 }, lia: { vsZap: 0.31 }, ravi: { vsZap: 0.303 }, iara: { vsZap: 0.417 }, zap: { vsZap: 0.494 } } },
    ab: null,
    ...extra,
  };
}

function snapshot(manifest: Partial<CycleSnapshot['manifest']>, cards: Record<string, Record<string, unknown>>, files: Record<string, Uint8Array>): CycleSnapshot {
  return {
    manifest: { current: 'v2', control: null, controlShare: 0.3, controlUntil: null, models: ['v1', 'v2', ...Object.keys(cards)], createdAt: {}, ...manifest },
    promotions: { v3: T.adopt, v4: T.v4 },
    cards,
    files: Object.fromEntries(Object.entries(files).map(([v, b]) => [v, { bytes: b, path: `models/${v}.zapw` }])),
    personaPairs: { v3: 200, v4: 200 },
    profile: 'local',
    mode: 'minio',
    sources: {},
  };
}

/** facts.json with the judged file's network recorded (criterionNetwork), as record-release --criterion-network leaves it. */
function baseFacts(): Record<string, any> {
  const f = copy(FACTS);
  const served = f.ai.adaptation.explorer.criterion.servedModel;
  f.ai.adaptation.explorer.criterionNetwork = { sha256: served.sha256, networkSha256: networkSha256(JUDGED) };
  return f;
}

const NOW = '2026-11-23T20:00:00.000Z';
const values = (facts: Record<string, any>) => readmeValues(facts, docsValues(facts).docs);

/** Both READMEs rendered from a facts copy (the rendered texts, the repository untouched). */
function renderBoth(facts: Record<string, any>, name: string): { en: string; pt: string } {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${name}.json`);
  writeFileSync(path, formatFacts(facts));
  const { problems, results } = runReadmes({ factsPath: path });
  expect(problems.filter((p) => !p.includes('differs from facts.json'))).toEqual([]);
  return { en: results[0].text, pt: results[1].text };
}

/** The rendered block `name` of a README text. */
const block = (text: string, name: string) => new RegExp(`<!-- facts:${name} -->\\n([\\s\\S]*?)<!-- /facts:${name} -->`).exec(text)![1];

describe('the network of a model file', () => {
  it('ignores the version name and nothing else', () => {
    expect(sha(V3)).not.toBe(sha(JUDGED));
    expect(networkSha256(V3)).toBe(networkSha256(JUDGED));
    expect(networkSha256(V4)).not.toBe(networkSha256(V3));
    expect(networkSha256(JUDGED)).not.toBe(networkSha256(V2));
    expect(() => networkSha256(new Uint8Array(16))).toThrow(/not a Zap model/);
  });
});

describe('record-release', () => {
  const window = () => {
    const facts = baseFacts();
    const snap = snapshot({ current: 'v3', control: 'v2', controlUntil: T.until }, { v3: card('v3', 'v2', V3) }, { v3: V3 });
    return { facts, records: buildRecords(facts, snap, 'on', NOW) };
  };

  it('records a version in its test window, the judged network and the window', () => {
    const { records } = window();
    expect(records.inPlay).toMatchObject({ version: 'v3', control: 'v2', controlShare: 0.3, controlUntil: T.until, AI_ADAPT: 'on', cycle: { mode: 'minio' } });
    const v3 = records.releases.v3;
    expect(v3).toMatchObject({ version: 'v3', origin: 'cycle', parent: 'v2', state: 'window', explorerTested: true, date: '2026-11-23', file: 'models/v3.zapw', features: 'v2', adapt: NET });
    expect(v3.window).toMatchObject({ control: 'v2', share: 0.3, from: T.adopt, until: T.until, result: null });
    expect(v3.gate.where).toBe('local');
    expect(v3.personas).toMatchObject({ pairsPerSegment: 200, vsZap: { otavio: 0.264, zap: 0.494 } });
    expect(Object.keys(records.releases)).toEqual(['v3']);
  });

  it('keeps every other key of facts.json and the bundled releases as they were', () => {
    const { facts, records } = window();
    const merged = mergeRecords(facts, records);
    const back = copy(merged);
    delete back.ai.inPlay;
    delete back.ai.releases.v3;
    expect(formatFacts(back)).toBe(formatFacts(facts));
    expect(Object.keys(merged.ai.releases)).toEqual([...Object.keys(facts.ai.releases), 'v3']);
  });

  it('marks a rollback and keeps the window it cut short', () => {
    const { facts, records } = window();
    const after = mergeRecords(facts, records);
    const rolled = card('v3', 'v2', V3, { result: 'rolled-back', resultAt: Date.parse(T.back), reason: 'Rolled back to v2 by the owner.' });
    const r = buildRecords(after, snapshot({ current: 'v2' }, { v3: rolled }, { v3: V3 }), 'on', NOW);
    expect(r.inPlay).toMatchObject({ version: 'v2', control: null, controlUntil: null });
    expect(r.releases.v3).toMatchObject({ state: 'rolled-back', rolledBack: { at: T.back, to: 'v2' }, window: { share: 0.3, from: T.adopt, until: T.until, control: 'v2' } });
  });

  it('records the result of a window that closed with the version kept', () => {
    const ab = { from: Date.parse(T.adopt), until: Date.parse(T.until), matches: { candidate: 400, control: 180 }, people: 60, drop: 0.012, lo: -0.01, hi: 0.031, detectablePoints: 6.1, rolledBack: false };
    const r = buildRecords(baseFacts(), snapshot({ current: 'v3' }, { v3: card('v3', 'v2', V3, { ab }) }, { v3: V3 }), 'on', NOW);
    expect(r.releases.v3).toMatchObject({ state: 'current', window: { until: T.until, result: { drop: 0.012, people: 60, rolledBack: false } } });
  });

  it('refuses a file that is not the card\'s, a current version without a card and a window without its share', () => {
    expect(() => buildRecords(baseFacts(), snapshot({ current: 'v3', control: 'v2', controlUntil: T.until }, { v3: card('v3', 'v2', V3) }, { v3: V4 }), 'on', NOW)).toThrow(/the card of v3 says/);
    expect(() => buildRecords(baseFacts(), snapshot({ current: 'v5' }, {}, {}), 'on', NOW)).toThrow(/v5 has no card/);
    expect(() => buildRecords(baseFacts(), snapshot({ current: 'v3', control: 'v2', controlShare: null, controlUntil: T.until }, { v3: card('v3', 'v2', V3) }, { v3: V3 }), 'on', NOW)).toThrow(/control share/);
  });

  it('reads the status the cycle prints, a copy of the bucket and the S3 stand-in\'s folder', () => {
    rmSync(DIR, { recursive: true, force: true });
    const plain = join(DIR, 'bucket');
    mkdirSync(join(plain, 'cards'), { recursive: true });
    mkdirSync(join(plain, 'models'), { recursive: true });
    const manifest = { schema: 'zap-manifest/1', current: 'v3', control: 'v2', controlShare: 0.3, controlUntil: Date.parse(T.until), models: { v1: {}, v2: {}, v3: { createdAt: Date.parse(T.adopt) } } };
    writeFileSync(join(plain, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(plain, 'cards', 'v3.json'), JSON.stringify(card('v3', 'v2', V3)));
    writeFileSync(join(plain, 'models', 'v3.zapw'), V3);
    // The stand-in keeps each object under a hash with its key in meta/.
    const s3 = join(DIR, 's3');
    mkdirSync(join(s3, 'meta'), { recursive: true });
    mkdirSync(join(s3, 'data'), { recursive: true });
    for (const [key, body] of [['manifest.json', JSON.stringify(manifest)], ['cards/v3.json', JSON.stringify(card('v3', 'v2', V3))], ['models/v3.zapw', V3]] as const) {
      const id = sha(new TextEncoder().encode(key));
      writeFileSync(join(s3, 'meta', `${id}.json`), JSON.stringify({ key }));
      writeFileSync(join(s3, 'data', id), body);
    }
    expect([...bucketFiles(s3).keys()].sort()).toEqual(['cards/v3.json', 'manifest.json', 'models/v3.zapw']);
    // The cycle's data folder adds the pairs behind the characters and the promotion times.
    const data = join(DIR, 'data');
    mkdirSync(join(data, 'versions', 'v3'), { recursive: true });
    writeFileSync(join(data, 'versions', 'v3', 'persona-pairs.json'), JSON.stringify({ pairs: 800, pairsPerSegment: 200 }));
    writeFileSync(join(data, 'state.json'), JSON.stringify({ promotions: [{ version: 'v3', at: Date.parse(T.adopt), parent: 'v2' }] }));
    for (const bucket of [plain, s3]) {
      const snap = readCycle({ bucket, cycleData: data, mode: 'minio' });
      expect(snap.manifest).toMatchObject({ current: 'v3', control: 'v2', controlShare: 0.3, controlUntil: T.until });
      expect(snap.promotions.v3).toBe(T.adopt);
      expect(snap.personaPairs.v3).toBe(200);
      expect(buildRecords(baseFacts(), snap, 'on', NOW).releases.v3.state).toBe('window');
    }
    const status = join(DIR, 'status.json');
    const printed = { profile: 'prod', mode: 'r2', state: { promotions: [{ version: 'v3', at: Date.parse(T.adopt) }], ab: null }, manifest: { current: 'v3', control: 'v2', controlShare: 0.3, controlUntil: T.until, models: ['v1', 'v2', 'v3'] } };
    writeFileSync(status, JSON.stringify({ ok: true, command: 'status', result: printed }));
    mkdirSync(join(data, 'cards'), { recursive: true });
    writeFileSync(join(data, 'cards', 'v3.json'), JSON.stringify(card('v3', 'v2', V3)));
    // No model file in that folder: a file that reads is never told as untested for want of a comparison.
    expect(() => buildRecords(baseFacts(), readCycle({ status, cycleData: data }), 'on', NOW)).toThrow(/cannot tell whether v3 is the network the explorer test judged/);
    // Nor when the judged network is unknown (no criterionNetwork and no judged file at its path)...
    writeFileSync(join(data, 'versions', 'v3', 'model.zapw'), V3);
    const snap = readCycle({ status, cycleData: data });
    expect(snap.mode).toBe('r2');
    const unknown = baseFacts();
    delete unknown.ai.adaptation.explorer.criterionNetwork;
    unknown.ai.adaptation.explorer.criterion.servedModel.path = 'nowhere/judged.zapw';
    expect(() => buildRecords(unknown, snap, 'on', NOW)).toThrow(/give --judged/);
    // ...unless a copy of the judged file is given, checked by its SHA-256.
    const judged = join(DIR, 'judged.zapw');
    writeFileSync(judged, JUDGED);
    expect(() => buildRecords(unknown, snap, 'on', NOW, judged)).toThrow(/the criterion judged/);
    unknown.ai.adaptation.explorer.criterion.servedModel.sha256 = sha(JUDGED);
    expect(buildRecords(unknown, snap, 'on', NOW, judged).releases.v3.explorerTested).toBe(true);
    const v3 = buildRecords(baseFacts(), snap, 'on', NOW).releases.v3;
    expect(v3.gate.where).toBe('server');
    expect(v3.network.sha256).toBe(networkSha256(V3));
    expect(v3.explorerTested).toBe(true);
    expect(() => readCycle({ bucket: plain })).toThrow(/--mode/);
    expect(() => readCycle({ status, bucket: plain })).toThrow(/once/);
  });

  it('writes facts.json through a temporary file, re-reading it first, and leaves nothing behind', () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const path = join(DIR, 'facts.json');
    writeFileSync(path, formatFacts(baseFacts()));
    const { records } = window();
    updateFacts(path, (f) => mergeRecords(f, records));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.ai.inPlay.version).toBe('v3');
    expect(readdirSync(DIR)).toEqual(['facts.json']);
    const before = readFileSync(path, 'utf8');
    updateFacts(path, (f) => f);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('the version in play and the READMEs', () => {
  const inWindow = (aiAdapt: 'on' | 'off' = 'on', bytes = V3, v = 'v3') => {
    const facts = baseFacts();
    const snap = snapshot({ current: v, control: 'v2', controlUntil: T.until }, { [v]: card(v, 'v2', bytes) }, { [v]: bytes });
    return mergeRecords(facts, buildRecords(facts, snap, aiAdapt, NOW));
  };

  it('without a record, the bundled model is in play and the reading follows the old rule', () => {
    expect(servedView(FACTS)).toMatchObject({ version: FACTS.ai.bootstrapModel.version, inPlay: null, cycle: null });
    expect(servedReads(FACTS, 'on')).toBe(FACTS.ai.bootstrapModel.features === 'v2' && !!FACTS.ai.bootstrapModel.adapt);
    const v = values(FACTS);
    expect(['off-fails', 'off-passes', 'off-unmeasured', 'on-bundled']).toContain(v['reading.state']);
    expect([v['strength.source'], v['gate.where'], v['window.any'], v['prod.state'], v['human.state']]).toEqual(['table', 'local', 'no', 'none', 'none']);
  });

  it('in the test window: v3 in play, its gate panel as strength, the decision time of the judged file', () => {
    const facts = inWindow();
    expect(servedView(facts).version).toBe('v3');
    expect(servedReads(facts, 'on')).toBe(true);
    expect(servedReads(facts, 'off')).toBe(false);
    const v = values(facts);
    expect(v).toMatchObject({
      'served.version': 'v3',
      'served.previous': 'v2',
      'model.features': 'v2',
      'strength.source': 'gate',
      'strength.pairs': 10000,
      'strength.previous': 0.529,
      'strength.prevTuned': 0.871,
      'decision.source': 'judged',
      'chars.pairs': 200,
      'chars.sepVersion': FACTS.ai.bootstrapModel.version,
      'chars.sepOther': 'yes',
      'gate.where': 'local',
      'gate.stats': 'live',
      'window.state': 'open',
      'reading.state': 'window',
      'reading.live': 'window',
      'reading.tested': 'yes',
      'reading.share': 0.3,
      'reading.control': 'v2',
      'reading.gainSameFile': 'told',
      'prod.state': 'local-window',
    });
    expect(v['decision.p99']).toBe(FACTS.ai.adaptation.decisionTime.decisionMs.p99);
    // A planned end is not a measurement: the snapshot's date is the record's day, not the window's end.
    expect(v['snapshot.date']).toBe(NOW.slice(0, 10));
    const { en, pt } = renderBoth(facts, 'window');
    expect(block(en, 'reading')).toMatch(/^\n\*\*Status: in a test with people\.\*\* The version in play, v3 /);
    expect(block(en, 'reading')).toMatch(/30% of quick play matches keep v2 on every AI seat/);
    expect(block(en, 'reading')).toMatch(/The explorer test passed for the network of v3/);
    expect(block(pt, 'reading')).toMatch(/^\n\*\*Situação: em teste com pessoas\.\*\* A versão em jogo, v3 /);
    expect(block(en, 'limits')).toMatch(/\* \*\*The reading is still in its test with people\*\*[^\n]*\n\* \*\*The characters' styles overlap\.\*\* In a test that tells two characters apart from windows of their play, measured on v2,/);
    expect(block(en, 'snapshot')).toMatch(/\| v3 against v2, head to head \| 52\.9% \(from 52\.4% to 53\.4%\) \|/);
    expect(block(en, 'gate')).toMatch(/Its window with people runs until 7 Dec 2026\.\n/);
  });

  it('with AI_ADAPT off, a version that carries the reading plays without it, and its open window still splits the matches', () => {
    const facts = inWindow('off');
    const v = values(facts);
    expect(servedBlock(facts, 'off')).toMatchObject({ version: 'v3', readsOpponents: false, carried: true, rolledBack: null, judged: true });
    expect([v['reading.state'], v['reading.live'], v['reading.offPolicy'], v['reading.offWindow']]).toEqual(['noevidence', 'no', 'all-window', 'yes']);
    const { en, pt } = renderBoth(facts, 'window-off');
    expect(block(en, 'reading')).toMatch(/as if it had seen nothing from anyone\. Its window with people still runs until 7 Dec 2026: 30% of quick play matches keep v2 on every AI seat/);
    expect(block(en, 'reading')).toMatch(/the matches of the test group now face a network weaker than the twin, while the control group plays v2\./);
    expect(block(en, 'reading')).not.toMatch(/every table now plays/);
    expect(block(pt, 'reading')).toMatch(/A janela com pessoas dela ainda vai até 07\/12\/2026/);
  });

  it('a network the explorer test never measured is said so, and none of the judged file\'s numbers are given to it', () => {
    const facts = inWindow('on', V4, 'v4');
    const v = values(facts);
    // The data page's F9 then says its verdicts are of the judged file, not of v4.
    expect(servedBlock(facts, 'on')).toMatchObject({ version: 'v4', readsOpponents: true, judged: false, criterionSha: facts.ai.adaptation.explorer.criterion.servedModel.sha256.slice(0, 8) });
    expect(v).toMatchObject({ 'reading.state': 'window', 'reading.tested': 'no', 'reading.gainSameFile': 'no', 'reading.caveats': 'no', 'reading.offPolicy': 'no', 'decision.state': 'unmeasured' });
    const { en, pt } = renderBoth(facts, 'untested');
    expect(block(en, 'reading')).toMatch(/No explorer test measured the network of v4/);
    expect(block(en, 'reading')).not.toMatch(/passed for the network/);
    expect(block(en, 'snapshot')).toMatch(/\| Decision time of v4 \| not measured for this version yet \|  \|/);
    expect(block(pt, 'snapshot')).toMatch(/\| Tempo de decisão da v4 \| ainda não medido para esta versão \|  \|/);
  });

  it('another network that passed the cycle\'s own explorer step is told with the numbers of its card', () => {
    const facts = baseFacts();
    const verdict = (explorer: string, upper95: number) => ({ explorer, kind: 'scripted', sha256: 'a'.repeat(64), mean: upper95 - 0.003, upper95, pairs: 8000, pass: upper95 <= 0.01 });
    const explorer = { network: 'b'.repeat(64), sha256: sha(V4), pass: true, limit: 0.01, source: 'measured', reusedFrom: null, verdicts: [verdict('raisesAll>trapper@2/same', 0.0042), verdict('training/runs/m7-explorer/explorer.zapw', -0.002)], failuresOnRecord: [], pending: [], reasons: [] };
    const snap = snapshot({ current: 'v4', control: 'v2', controlUntil: T.until }, { v4: card('v4', 'v2', V4, { explorer }) }, { v4: V4 });
    const merged = mergeRecords(facts, buildRecords(facts, snap, 'on', NOW));
    expect(merged.ai.releases.v4).toMatchObject({ explorerTested: true, explorer: { pass: true, source: 'measured', verdicts: 2, passing: 2, worst: { explorer: 'raisesAll>trapper@2/same', upper95: 0.0042 } } });
    const v = values(merged);
    expect([v['reading.tested'], v['reading.caveats'], v['reading.gainSameFile'], v['decision.state']]).toEqual(['card', 'no', 'no', 'unmeasured']);
    const { en, pt } = renderBoth(merged, 'card');
    expect(block(en, 'reading')).toMatch(/The explorer test of the training cycle passed for the network of v4 before its promotion: all 2 explorers measured against it stay within the limit of 1 point; the largest upper bound is 0\.42 points, for `raisesAll>trapper@2\/same`\./);
    expect(block(pt, 'reading')).toMatch(/O teste do explorador do ciclo de treino passou para a rede da v4 antes da promoção: os 2 exploradores/);
  });

  it('after the window closed with the version kept: on, with the comparison with people', () => {
    const facts = baseFacts();
    const ab = { from: Date.parse(T.adopt), until: Date.parse(T.until), matches: { candidate: 400, control: 180 }, people: 60, drop: 0.012, lo: -0.01, hi: 0.031, detectablePoints: 6.1, rolledBack: false };
    const merged = mergeRecords(facts, buildRecords(facts, snapshot({ current: 'v3' }, { v3: card('v3', 'v2', V3, { ab }) }, { v3: V3 }), 'on', NOW));
    const v = values(merged);
    expect([v['reading.state'], v['reading.live'], v['reading.result'], v['window.state'], v['reading.offPolicy']]).toEqual(['on', 'on', 'public', 'closed', 'live']);
    const { en, pt } = renderBoth(merged, 'kept');
    expect(block(en, 'reading')).toMatch(/\*\*Status: on\.\*\* The version in play, v3 /);
    expect(block(en, 'reading')).toMatch(/from 23 Nov 2026 to 7 Dec 2026, v2 won 1\.2 points more of its matches against people than v3 did \(90% interval from −1\.0 to 3\.1\)/);
    expect(block(pt, 'reading')).toMatch(/de 23\/11\/2026 a 07\/12\/2026, a v2 ganhou 1,2 pontos a mais[^\n]*\(intervalo de 90% de −1,0 a 3,1\)/);
    expect(block(en, 'limits')).toMatch(/\* \*\*The reading forgets between matches\.\*\*/);
    expect(block(en, 'gate')).toMatch(/Its window with people ended on 7 Dec 2026, and it stayed\./);
  });

  it('after a rollback: the bundled version again, and the reading off again with the version that carried it', () => {
    const win = inWindow();
    const rolled = card('v3', 'v2', V3, { result: 'rolled-back', resultAt: Date.parse(T.back), reason: 'Rolled back to v2 by the owner.' });
    const facts = mergeRecords(win, buildRecords(win, snapshot({ current: 'v2' }, { v3: rolled }, { v3: V3 }), 'on', NOW));
    const v = values(facts);
    expect(v).toMatchObject({ 'served.version': 'v2', 'strength.source': 'table', 'reading.state': 'rolled-back', 'reading.live': 'no', 'reading.version': 'v3', 'reading.rolledTo': 'v2', 'reading.tested': 'yes', 'reading.result': 'none', 'window.any': 'yes', 'window.state': 'none' });
    const { en, pt } = renderBoth(facts, 'rolled-back');
    expect(block(en, 'reading')).toMatch(/\*\*Status: off again\.\*\* The version in play, v2 \(features `v2-empty`\), reads nothing about anyone\. v3 carried the reading: it was adopted through the training cycle on 23 Nov 2026 and rolled back to v2 on 25 Nov 2026\./);
    expect(block(pt, 'reading')).toMatch(/\*\*Situação: desligada de novo\.\*\*/);
    expect(block(en, 'gate')).not.toMatch(/No window with people has run yet/);
    // The data page's status line says which version was rolled back and when, never "only if the owner adopts it".
    expect(servedBlock(facts, 'on')).toMatchObject({ version: 'v2', readsOpponents: false, carried: true, rolledBack: { version: 'v3', to: 'v2', at: Date.parse(T.back) }, judged: null });
    expect(block(en, 'limits')).toMatch(/\* \*\*The reading is off\*\*/);
  });

  it('a window on the server: the texts stop saying that no window ran and that nobody played', () => {
    const facts = inWindow();
    facts.ai.releases.v3.gate.where = 'server';
    const v = values(facts);
    expect([v['prod.state'], v['human.state'], v['gate.where']]).toEqual(['server', 'window', 'server']);
    const { en } = renderBoth(facts, 'server');
    expect(block(en, 'gate')).toMatch(/on the training server, with the reading live, and passed every rule/);
    expect(block(en, 'human')).toMatch(/^\nPeople have played against a version of Zap in a test window, but no match with people has trained Zap yet: v3 was trained by self-play alone\./);
    expect(block(en, 'limits')).toMatch(/\* \*\*Numbers from programs\.\*\*/);
  });

  it('refuses words for a version trained with the human behaviour model, which no template has yet', () => {
    const facts = inWindow();
    facts.ai.releases.v3.training.humanModel = true;
    expect(() => values(facts)).toThrow(/human behaviour model/);
  });

  it('an inline section that ends a line keeps the line break; one on its own lines takes it', () => {
    expect(renderTemplate('* {?a=x}A{/?}{?a=y}B{/?}\n* C', { a: 'x' }, 'en')).toBe('* A\n* C');
    expect(renderTemplate('* {?a=x}A{/?}{?a=y}B{/?}\n* C', { a: 'z' }, 'en')).toBe('* \n* C');
    expect(renderTemplate('X\n{?a=x}\nA\n{/?}\nY', { a: 'y' }, 'en')).toBe('X\nY');
  });

  it('leaves no file behind in the repository', () => {
    expect(existsSync(join(ROOT, 'facts.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(ROOT, 'facts.json'), 'utf8')).ai.inPlay).toBeUndefined();
  });
});
