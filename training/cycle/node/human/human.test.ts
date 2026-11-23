import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { NUM_FEATURES } from '../../../../ai/src/features.ts';
import { readPriorsDefault } from './test-support.ts';
import { build } from '../build.ts';
import { writeFeatures } from './features.ts';
import { counts, fitFromGroups, groupProfiles, readings } from './profiles.ts';
import { DECISION_COLUMNS, MATCH_COLUMNS, csvField, timeBand, writePackageRows } from './opendata.ts';
import { synthesize, type Person } from './synth.ts';
import { decisionRows, loadRecord, readRecordLines, type DecisionRow } from './tables.ts';
import { profileCounts } from '../../../../shared/profile.ts';

let dir = '';
let people: Person[] = [];
let rows: DecisionRow[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zap-human-'));
  people = synthesize({
    out: dir, people: 8, matches: 2, seed: 0x5eed0003, start: Date.UTC(2026, 10, 2), bots: ['metronome'], botMatches: 2,
    optOut: 0.3, noAdapt: 0.3, unlinked: 0.2, flagged: 0.15,
  }).people;
  await build({ records: join(dir, 'records'), out: join(dir, 'tables'), exportFile: join(dir, 'export.json'), config: { mode: 'minio', deviceCap: 0.02 }, decisions: true });
  for await (const d of decisionRows(join(dir, 'tables'))) rows.push(d);
});

describe('human model rows', () => {
  it('writes one row per weighted decision, in canonical actions that are legal', async () => {
    const out = join(dir, 'features');
    const s = await writeFeatures({ records: join(dir, 'records'), tables: join(dir, 'tables'), out });
    const weighted = rows.filter((d) => d.w > 0 && d.group !== null);
    expect(s.rows).toBe(weighted.length);
    expect(s.skipped).toBe(0);
    const y = readFileSync(join(out, 'human-y.u8'));
    const m = new Uint16Array(new Uint8Array(readFileSync(join(out, 'human-mask.u16'))).buffer);
    expect(readFileSync(join(out, 'human-x.f32')).byteLength).toBe(s.rows * NUM_FEATURES * 4);
    for (let r = 0; r < s.rows; r++) expect((m[r] >> y[r]) & 1).toBe(1);
    const meta = readFileSync(join(out, 'human-meta.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { group: string; type: string });
    const bad = new Set(people.filter((p) => p.unlinked || p.flagged).map((p) => p.group));
    expect(meta.some((x) => bad.has(x.group))).toBe(false);
    expect(new Set(meta.map((x) => x.type)).has('card')).toBe(true);
  });

  it('leaves out excluded groups and samples down to max rows', async () => {
    const first = rows.find((d) => d.w > 0 && d.group !== null)!.group!;
    const s = await writeFeatures({ records: join(dir, 'records'), tables: join(dir, 'tables'), out: join(dir, 'f2'), exclude: new Set([first]), maxRows: 50 });
    expect(s.sampledShare).toBeLessThan(1);
    expect(s.rows).toBeLessThan(120);
    const meta = readFileSync(join(dir, 'f2', 'human-meta.jsonl'), 'utf8');
    expect(meta.includes(first)).toBe(false);
  });
});

describe('profiles and priors', () => {
  it('sums profileCounts per group over counted seats only', () => {
    const lines = readRecordLines(join(dir, 'tables'));
    const { groups } = groupProfiles(join(dir, 'records'), lines, new Set());
    const skip = new Set(people.filter((p) => p.unlinked || p.flagged || p.noAdapt).map((p) => p.group));
    for (const g of groups.keys()) expect(skip.has(g)).toBe(false);
    const g = [...groups.keys()][0];
    let matches = 0;
    let D = 0;
    for (const line of lines) {
      const h = line.humans.find((x) => x.group === g);
      if (!h || !counts(line, h, new Set())) continue;
      const c = profileCounts(loadRecord(join(dir, 'records'), line.key)).find((x) => x.seat === h.seat)!.counts;
      matches += c.matches;
      D += c.D;
    }
    expect(groups.get(g)!.total.matches).toBe(matches);
    expect(groups.get(g)!.total.D).toBe(D);
  });

  it('keeps the self-play priors below the threshold and uses people above it', () => {
    const { groups } = groupProfiles(join(dir, 'records'), readRecordLines(join(dir, 'tables')), new Set());
    const fallback = readPriorsDefault();
    const off = fitFromGroups(groups, fallback, 100, 1_800_000_000_000);
    expect(off.source).toBe('selfplay');
    expect(off.numbers).toEqual(fallback.numbers);
    expect(off.createdAt).toBe(1_800_000_000_000);
    // Never from fewer than 20 people, whatever the threshold says.
    expect(fitFromGroups(groups, fallback, 1, 1_800_000_000_000).source).toBe('selfplay');
    const many = new Map([...Array(20).keys()].flatMap((k) => [...groups.entries()].map(([g, v]) => [`${k}:${g}`, v] as const)));
    const on = fitFromGroups(many, fallback, 1, 1_800_000_000_000);
    expect(on.source).toBe('people');
    expect(on.people).toBeGreaterThanOrEqual(20);
    const r = readings(groups, on);
    expect(r.length).toBe(groups.size);
    expect(r[0].values.length).toBe(8);
    expect(r[0].population.length).toBe(8);
  });
});

describe('open data rows', () => {
  it('names no match id, seed or group, and bands decision times', () => {
    const lines = readRecordLines(join(dir, 'tables')).slice(0, 3);
    const sel = lines.map((l, i) => ({ key: l.key, code: `${i + 1}`.padStart(16, 'a'), week: '2026-W45' }));
    const out = join(dir, 'od');
    const r = writePackageRows({ records: join(dir, 'records'), selection: sel, out });
    const m = readFileSync(join(out, 'matches.csv'), 'utf8');
    const d = readFileSync(join(out, 'decisions.csv'), 'utf8');
    expect(m.trim().split('\n').length).toBe(4);
    expect(m.split('\n')[0].split(',')).toEqual([...MATCH_COLUMNS]);
    const dl = d.trim().split('\n');
    expect(dl.length - 1).toBe(r.decisions);
    const header = dl[0].split(',');
    expect(header).toEqual([...DECISION_COLUMNS]);
    const tb = header.indexOf('time_band_s');
    const who = header.indexOf('decider');
    for (const line of dl.slice(1)) {
      const f = line.split(',');
      if (f.length !== header.length) continue; // a quoted field with a comma; checked by csvField below
      if (f[who] === 'ai') expect(f[tb]).toBe('');
      else if (f[tb] !== '') expect((Number(f[tb]) * 2) % 1).toBe(0);
    }
    const text = m + d;
    for (const l of lines) {
      expect(text.includes(l.matchId)).toBe(false);
      expect(text.includes(loadRecord(join(dir, 'records'), l.key).seed)).toBe(false);
      for (const h of l.humans) if (h.group) expect(text.includes(h.group)).toBe(false);
    }
  });

  it('bands and quotes', () => {
    expect(timeBand(0)).toBe(0);
    expect(timeBand(499)).toBe(0);
    expect(timeBand(500)).toBe(0.5);
    expect(timeBand(1999)).toBe(1.5);
    expect(timeBand(10_000_000)).toBe(120);
    expect(timeBand(null)).toBeNull();
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField(true)).toBe('1');
    expect(csvField(null)).toBe('');
  });
});
