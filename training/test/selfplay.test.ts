// The self-play worker: record layout, evidence byte, determinism, and the same sequence of match
// setups for the adaptive network and its twin (the setup stream is separate from the actions).

import { mkdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchConfig } from '../../engine/src/config.ts';
import { NUM_CRITIC_EXTRA, NUM_FEATURES, encoderInfo } from '../../ai/src/features.ts';
import { TEST_PRIORS, randomLayers, widen } from '../../ai/test/model-helpers.ts';
import { modelBytes } from '../../ai/test/model-helpers.ts';
import { writeFileSync } from 'node:fs';
import { RECORD_EXTRA, runJob, type Job } from '../src/selfplay.ts';
import type { FeatureVersion } from '../../ai/src/features.ts';

const DIR = '.cache/tmp/selfplay-test';
mkdirSync(DIR, { recursive: true });
const layers = widen(randomLayers(21, NUM_FEATURES, [32, 16]), 4);
writeFileSync(`${DIR}/v2.zapw`, modelBytes(layers, 'v2'));
writeFileSync(`${DIR}/v2-empty.zapw`, modelBytes(layers, 'v2-empty'));
writeFileSync(`${DIR}/v1.zapw`, modelBytes(randomLayers(21, NUM_FEATURES, [32, 16]), 'v1'));
writeFileSync(`${DIR}/v2-self.zapw`, modelBytes(layers, 'v2-self' as FeatureVersion));
writeFileSync(`${DIR}/v2-net.zapw`, modelBytes(layers, 'v2', 'f32', { adapt: { bmax: 0.5, nHalf: 1 } }));

const job = (model: string, out: string, seed = '6a'.repeat(32)): Job => ({
  model: `${DIR}/${model}.zapw`,
  out: `${DIR}/${out}.bin`,
  decisions: 1500,
  seed,
  league: [],
  mix: 'current=0.30,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.14,switching=0.10',
  twoStyles: 0.5,
  partnerSwap: 0.2,
  fourPlayers: 0.5,
  mineiro: 0.5,
  randomOptions: 0.25,
  v1Model: 'ai/models/bootstrap/zap-v1.zapw',
  v1Manifest: 'ai/models/bootstrap/manifest.json',
  switchHands: [1, 6],
});

describe('self-play worker', () => {
  it('writes records of the encoder size plus the critic inputs and a 20 byte tail, with the evidence byte', () => {
    const r = runJob(job('v2', 'a'));
    const meta = JSON.parse(readFileSync(`${DIR}/a.bin.json`, 'utf8'));
    const size = 461 + NUM_CRITIC_EXTRA + RECORD_EXTRA;
    expect(meta).toMatchObject({ records: r.decisions, recordSize: size, features: 461, featureVersion: 'v2', critic: NUM_CRITIC_EXTRA, extra: 20, statsOffset: 431, statsSize: 30 });
    const buf = readFileSync(`${DIR}/a.bin`);
    expect(buf.byteLength).toBe(r.decisions * size);
    let positive = 0;
    for (let i = 0; i < r.decisions; i++) {
      const tail = i * size + 461 + NUM_CRITIC_EXTRA;
      const nev = buf[tail + 16];
      expect(nev >= 0 && nev <= 255).toBe(true);
      if (nev > 0) positive++;
      expect([buf[tail + 17], buf[tail + 18], buf[tail + 19]]).toEqual([0, 0, 0]);
      expect(buf[tail + 2]).toBeLessThan(15);
    }
    expect(positive).toBeGreaterThan(0);
    expect(r.meanEvidence).toBeGreaterThan(0);
  });

  it('gives the same output for the same seed', () => {
    runJob(job('v2', 'b1'));
    runJob(job('v2', 'b2'));
    expect(readFileSync(`${DIR}/b1.bin`).equals(readFileSync(`${DIR}/b2.bin`))).toBe(true);
  });

  it('meets the same sequence of setups with the adaptive network and with its twin', () => {
    const seen: Record<string, string[]> = { v2: [], 'v2-empty': [] };
    const outs: Record<string, Buffer> = {};
    for (const m of ['v2', 'v2-empty'] as const) {
      runJob(job(m, `c-${m}`), { onMatch: (config: MatchConfig, labels: string[]) => seen[m].push(JSON.stringify({ config, labels })) });
      outs[m] = readFileSync(`${DIR}/c-${m}.bin`);
    }
    const k = Math.min(seen.v2.length, seen['v2-empty'].length);
    expect(k).toBeGreaterThan(5);
    expect(seen.v2.slice(0, k)).toEqual(seen['v2-empty'].slice(0, k));
    // The actions differ: the twin never reads the statistics.
    expect(outs.v2.equals(outs['v2-empty'])).toBe(false);
  });

  it('blind matches: the learning seats read no statistics (x equals x0, evidence 0), and setups stay aligned', () => {
    const info = encoderInfo('v2', TEST_PRIORS);
    const empty = Object.values(info.empty).map((b) => b.map((v) => Math.round(v * 255)).join(','));
    const size = 461 + NUM_CRITIC_EXTRA + RECORD_EXTRA;
    const seen: Record<string, string[]> = { all: [], none: [] };
    const r = runJob({ ...job('v2', 'e-all'), noStatsShare: 1 }, { onMatch: (c: MatchConfig, l: string[]) => seen.all.push(JSON.stringify({ c, l })) });
    expect(r.blindMatches).toBe(r.matches);
    const buf = readFileSync(`${DIR}/e-all.bin`);
    for (let i = 0; i < r.decisions; i++) {
      const base = i * size;
      expect(buf[base + 461 + NUM_CRITIC_EXTRA + 16]).toBe(0);
      expect(empty).toContain(Array.from(buf.subarray(base + 431, base + 461)).join(','));
    }
    const r0 = runJob({ ...job('v2', 'e-none'), noStatsShare: 0 }, { onMatch: (c: MatchConfig, l: string[]) => seen.none.push(JSON.stringify({ c, l })) });
    expect(r0.blindMatches).toBe(0);
    expect(r0.meanEvidence).toBeGreaterThan(0);
    // The blind draw comes from the setup stream for every share: the same setups either way.
    const k = Math.min(seen.all.length, seen.none.length);
    expect(seen.all.slice(0, k)).toEqual(seen.none.slice(0, k));
    const some = runJob({ ...job('v2', 'e-some'), noStatsShare: 0.5 });
    expect(some.blindMatches).toBeGreaterThan(0);
    expect(some.blindMatches).toBeLessThan(some.matches);
  });

  it('match episodes: the same games, one episode per seat per match, closed at its last decision, rewards adding up to the result', () => {
    const size = 431 + NUM_CRITIC_EXTRA + RECORD_EXTRA;
    const hand = runJob(job('v1', 'm-hand'));
    const match = runJob({ ...job('v1', 'm-match'), episode: 'match' });
    expect(match.decisions).toBe(hand.decisions);
    expect(match.matches).toBe(hand.matches);
    const a = readFileSync(`${DIR}/m-hand.bin`);
    const b = readFileSync(`${DIR}/m-match.bin`);
    const ep = new Map<number, { last: number; sum: number; won: boolean; done: number }>();
    for (let i = 0; i < match.decisions; i++) {
      const base = i * size;
      const tail = base + 431 + NUM_CRITIC_EXTRA;
      // Inputs, mask and action are those of the hand episode run: only the tail's bookkeeping differs.
      expect(b.subarray(base, tail + 3).equals(a.subarray(base, tail + 3))).toBe(true);
      const id = b.readUInt32LE(tail + 12);
      const e = ep.get(id) ?? { last: -1, sum: 0, won: (b[tail + 3] & 2) !== 0, done: 0 };
      e.last = i;
      e.sum += b.readFloatLE(tail + 8);
      if (b[tail + 3] & 1) e.done++;
      ep.set(id, e);
    }
    expect(ep.size).toBeLessThan(hand.hands);
    for (const e of ep.values()) {
      expect(e.done).toBe(1);
      expect(b[e.last * size + 431 + NUM_CRITIC_EXTRA + 3] & 1).toBe(1);
      // The hand rewards telescope: final result minus the chance of winning when the seat first acted.
      expect(e.sum > 0).toBe(e.won);
      expect(Math.abs(e.sum)).toBeLessThan(1);
    }
    expect(() => runJob({ ...job('v1', 'm-bad'), episode: 'set' as never })).toThrow(/episode/);
  });

  it('league as served: the league file sits on the other team with the Zap knobs and its safety net', () => {
    const labels: string[] = [];
    const r = runJob({ ...job('v2-self', 's'), league: [`${DIR}/v2-net.zapw`], mix: 'snapshots=1', twoStyles: 1, partnerSwap: 0, leagueAsServed: true, episode: 'match' }, { onMatch: (_c: MatchConfig, l: string[]) => labels.push(...l) });
    expect(new Set(labels)).toEqual(new Set(['snapshots:served0']));
    expect(r.setups).toEqual({ snapshots: labels.length });
    const meta = JSON.parse(readFileSync(`${DIR}/s.bin.json`, 'utf8'));
    expect(meta).toMatchObject({ featureVersion: 'v2-self', features: 461, statsOffset: 431, statsSize: 30 });
    const raw: string[] = [];
    runJob({ ...job('v2-self', 's2'), league: [`${DIR}/v2-net.zapw`], mix: 'snapshots=1' }, { onMatch: (_c: MatchConfig, l: string[]) => raw.push(...l) });
    expect(raw.filter((l) => l.startsWith('snapshots:')).every((l) => l === 'snapshots:snapshot0')).toBe(true);
  });

  it('feints fine-tune mix: the job ranges reach the league, setups stay aligned between the adaptive network and its twin', () => {
    const labels: string[] = [];
    const mix = 'current=0.30,snapshots=0.10,v1=0.08,tuned=0.05,base=0.05,random=0.02,characters=0.16,extremes=0.08,switching=0.04,feints=0.12';
    const r = runJob({ ...job('v2', 'f'), mix, feintHands: [5, 5], feintEvidence: [7, 7] }, { onMatch: (_c: MatchConfig, l: string[]) => labels.push(...l) });
    const feints = labels.filter((l) => l.startsWith('feints:'));
    expect(r.setups.feints).toBeGreaterThan(0);
    expect(feints.length).toBeGreaterThan(0);
    // The second opponent of a feint with partner v1 is logged as feints:v1.
    for (const l of feints) if (l !== 'feints:v1') expect(l).toMatch(/@(5|e7)(\/|$)/);
    const twin: string[] = [];
    runJob({ ...job('v2-empty', 'f2'), mix, feintHands: [5, 5], feintEvidence: [7, 7] }, { onMatch: (_c: MatchConfig, l: string[]) => twin.push(...l) });
    expect(twin.slice(0, labels.length)).toEqual(labels.slice(0, twin.length));
  });

  it('a v1 model writes 431 inputs and the same tail', () => {
    const r = runJob(job('v1', 'd'));
    const meta = JSON.parse(readFileSync(`${DIR}/d.bin.json`, 'utf8'));
    expect(meta.recordSize).toBe(431 + NUM_CRITIC_EXTRA + RECORD_EXTRA);
    expect(meta.statsSize).toBe(0);
    expect(r.meanEvidence).toBe(0);
  });
});
