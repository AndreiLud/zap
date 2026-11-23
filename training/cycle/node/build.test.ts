import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { build, decisionType, deviceCap, exclusion } from './build.ts';
import { forEachDecision } from './replay.ts';
import { recordKey, simulateRecord, type SimOptions } from './simulate.ts';

const T0 = Date.UTC(2026, 10, 20, 12);

function hex(i: number): string {
  return (i.toString(16).padStart(8, '0') + 'c0ffee00').repeat(4).slice(0, 64);
}

function writeRecords(dir: string, recs: Record<string, unknown>[]): string[] {
  return recs.map((r) => {
    const key = recordKey(r as { matchId: string; endedAt: number });
    mkdirSync(dirname(join(dir, key)), { recursive: true });
    writeFileSync(join(dir, key), JSON.stringify(r));
    return key;
  });
}

function sim(i: number, o: Partial<SimOptions> = {}): Record<string, unknown> {
  return simulateRecord({ seed: hex(i), variant: i % 2 ? 'mineiro' : 'paulista', players: 2, kind: 'solo1', humanSeats: [i % 2], schema: 1, startedAt: T0 + i * 60_000, ...o });
}

describe('decision table pieces', () => {
  it('names decision types from the phase and the legal moves', () => {
    const rec = sim(1) as unknown as Parameters<typeof forEachDecision>[0];
    const types = new Set<string>();
    forEachDecision(rec, (obs) => types.add(decisionType(obs)));
    expect(types.has('card')).toBe(true);
    expect(types.has('bet')).toBe(true);
  });

  it('excludes friends, unlinked, flagged, automatic and forced decisions in that order', () => {
    const row = { matchId: 'x', seat: 0, weight: 1, flagged: false, openDataOptOut: false, noAdapt: false, group: 'a'.repeat(16) };
    expect(exclusion('friends', row, false, 0b11)).toBe('friends');
    expect(exclusion('solo1', undefined, false, 0b11)).toBe('unlinked');
    expect(exclusion('solo1', { ...row, flagged: true }, false, 0b11)).toBe('flagged');
    expect(exclusion('solo1', { ...row, weight: 0 }, false, 0b11)).toBe('flagged');
    expect(exclusion('solo1', row, true, 0b11)).toBe('auto');
    expect(exclusion('solo1', row, false, 0b100)).toBe('forced');
    expect(exclusion('solo1', row, false, 0b101)).toBeNull();
  });

  it('caps each device at its share of the total, and not below 1 / cap devices', () => {
    const few = new Map([['a', 100], ['b', 1]]);
    expect([...deviceCap(few, 0.02).values()]).toEqual([1, 1]);
    const sums = new Map<string, number>([['big', 1000]]);
    for (let i = 0; i < 60; i++) sums.set(`g${i}`, 10);
    const f = deviceCap(sums, 0.02);
    const after = new Map([...sums].map(([g, v]) => [g, v * f.get(g)!]));
    const total = [...after.values()].reduce((a, b) => a + b, 0);
    expect(after.get('big')! / total).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(f.get('g0')).toBe(1);
  });
});

describe('build', () => {
  it('writes records, decisions with weights and exclusions, and the counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zap-build-'));
    const recs = [sim(1), sim(2), sim(3, { kind: 'solo2', players: 4, humanSeats: [1] }), sim(4, { kind: 'friends', players: 4, humanSeats: [0, 2] }), sim(5, { autoShare: 0.5 })];
    const keys = writeRecords(join(dir, 'records'), recs);
    mkdirSync(join(dir, 'records', 'matches', 'v1', '2026', '11', '19'), { recursive: true });
    writeFileSync(join(dir, 'records', 'matches', 'v1', '2026', '11', '19', 'broken.json'), '{not json');
    const row = (r: Record<string, unknown>, seat: number, group: string, extra = {}) => ({ matchId: r.matchId, seat, weight: 0.5, flagged: false, openDataOptOut: false, noAdapt: false, group, ...extra });
    const exportFile = join(dir, 'export.json');
    writeFileSync(
      exportFile,
      JSON.stringify({
        schema: 'zap-export/1',
        date: '2026-11-21',
        createdAt: T0,
        partial: false,
        rows: [row(recs[0], 1, '1'.repeat(16)), row(recs[1], 0, '2'.repeat(16), { flagged: true, weight: 0 }), row(recs[2], 1, '1'.repeat(16)), row(recs[3], 0, '3'.repeat(16)), row(recs[4], 1, '4'.repeat(16))],
        reports: [],
      }),
    );
    const out = join(dir, 'tables');
    const s = await build({ records: join(dir, 'records'), out, exportFile, config: { mode: 'r2', deviceCap: 0.02 }, decisions: true });
    expect(s.records).toBe(6);
    expect(s.valid).toBe(5);
    expect(s.invalid).toBe(1);
    expect(s.linkedSeats).toBe(5);
    // Match 2 is flagged and match 4 is friends: three matches keep weight, from 2 devices
    // (matches 1 and 3 share one); people stays null below 20.
    expect(s.validMatches).toBe(3);
    expect(s.devices).toBe(2);
    expect(s.people).toBeNull();
    expect(s.excluded.friends).toBeGreaterThan(0);
    expect(s.excluded.flagged).toBeGreaterThan(0);
    expect(s.excluded.auto).toBeGreaterThan(0);
    expect(s.excluded.capped).toBe(0);

    const lines = readFileSync(join(out, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.key).sort()).toEqual([...keys].sort());
    const first = lines.find((l) => l.matchId === recs[0].matchId);
    expect(first.humans).toEqual([{ seat: 1, group: '1'.repeat(16), weight: 0.5, flagged: false, openDataOptOut: false, noAdapt: false, verified: true, abandoned: false }]);
    expect(first.test).toBe(false);
    expect(first.partnerVersion).toBe('v1');
    expect(first.segment).toBe('mineiro-2');

    const decisions = gunzipSync(readFileSync(join(out, 'decisions.jsonl.gz'))).toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(decisions.length).toBe(s.decisions);
    expect(Object.keys(decisions[0])).toEqual(['m', 'i', 'seat', 'hand', 'type', 'legal', 'a', 'ms', 'auto', 'group', 'w']);
    expect(decisions.every((d) => d.w === 0 || d.w === 0.5)).toBe(true);
    expect(decisions.filter((d) => d.w > 0).length).toBe(s.weighted);
    expect(decisions.filter((d) => d.auto).every((d) => d.w === 0)).toBe(true);
    const invalid = readFileSync(join(out, 'invalid.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(invalid).toEqual([{ key: 'matches/v1/2026/11/19/broken.json', error: 'not JSON' }]);
  });

  it('takes only test records in minio mode, and refuses them in r2 mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zap-build-'));
    const v2 = sim(9, { schema: 2, test: true, kind: 'solo2', players: 4, humanSeats: [0], aiVersion: 'v3', partnerVersion: 'v2', arm: 'candidate' });
    writeRecords(join(dir, 'records'), [sim(7), sim(8, { schema: 2, test: false }), v2]);
    const s = await build({ records: join(dir, 'records'), out: join(dir, 'tables'), config: { mode: 'minio', deviceCap: 0.02 }, decisions: false });
    expect(s.valid).toBe(1);
    expect(s.invalid).toBe(2);
    expect(s.test).toBe(1);
    const invalid = readFileSync(join(dir, 'tables', 'invalid.jsonl'), 'utf8');
    expect(invalid.match(/not a test record/g)).toHaveLength(2);
    const rec = JSON.parse(readFileSync(join(dir, 'tables', 'records.jsonl'), 'utf8'));
    expect([rec.arm, rec.aiVersion, rec.partnerVersion, rec.test]).toEqual(['candidate', 'v3', 'v2', true]);
    const r2 = await build({ records: join(dir, 'records'), out: join(dir, 'tables2'), config: { mode: 'r2', deviceCap: 0.02 }, decisions: false });
    expect(r2.valid).toBe(2);
    expect(readFileSync(join(dir, 'tables2', 'invalid.jsonl'), 'utf8')).toContain('test record in production');
  });
});
