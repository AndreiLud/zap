// "How Zap reads you" in the Worker (worker/src/reading.ts) on node:sqlite with the real
// migrations: the person's counters summed over the segments, read against the imported or the
// bundled priors at the person's own mix of segments; a number shows only after 10 observations
// when its 80% interval is narrower than 30 points, and nothing shows with "Don't adapt to me".

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { READING_KEYS, validateReading, type PriorsFile } from '../../shared/cycle-formats.ts';
import { MIN_SHOWN_N, Z80, observationCounts, readingCounts, referenceMeans } from '../../shared/profile.ts';
import { newPseudonym } from '../src/privacy.ts';
import { PROFILE_COLUMNS, rowCounts, sumRows } from '../src/profiles.ts';
import { priorsFrom, readingFor } from '../src/reading.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const NOW = Date.UTC(2026, 10, 22, 12);
const DEFAULT: PriorsFile = JSON.parse(readFileSync('shared/profile-priors-default.json', 'utf8'));
const dev = (c: string) => c.repeat(64);

function addDevice(db: TestDb, id: string, over: Record<string, unknown> = {}): string {
  const pseudonym = newPseudonym();
  const row = { id, created_at: NOW, pseudonym, adult_at: NOW, last_seen: NOW, ...over };
  const cols = Object.keys(row);
  db.raw.prepare(`INSERT INTO devices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number)[]));
  return pseudonym;
}

type Row = Record<(typeof PROFILE_COLUMNS)[number], number>;
const zero = (): Row => Object.fromEntries(PROFILE_COLUMNS.map((c) => [c, 0])) as Row;

function addProfile(db: TestDb, pseudonym: string, segment: string, r: Partial<Row>): void {
  const row = { ...zero(), ...r };
  db.raw
    .prepare(`INSERT INTO profiles (pseudonym, segment, ${PROFILE_COLUMNS.join(', ')}, updated_at) VALUES (?, ?, ${PROFILE_COLUMNS.map(() => '?').join(', ')}, ?)`)
    .run(pseudonym, segment, ...PROFILE_COLUMNS.map((c) => row[c]), NOW);
}

/** The interval of contract 1.13 for one number, written out again. */
function interval(x: number, n: number, m: number, k: number) {
  const a = m * k + x;
  const b = (1 - m) * k + n - x;
  const mean = a / (a + b);
  const sd = Math.sqrt((mean * (1 - mean)) / (a + b + 1));
  return { mean, low: Math.max(0, mean - Z80 * sd), high: Math.min(1, mean + Z80 * sd) };
}

describe('How Zap reads you', () => {
  it('a device D1 does not have gets nothing; a person with no matches sees every number hidden, with the population value', async () => {
    const db = testDb();
    expect(await readingFor(db, dev('z'), NOW)).toBeNull();
    addDevice(db, dev('a'));
    const r = (await readingFor(db, dev('a'), NOW))!;
    expect(validateReading(r).ok).toBe(true);
    expect(r).toMatchObject({ schema: 'zap-reading/1', generatedAt: NOW, noAdapt: false, matches: 0, decisions: 0, priors: 'selfplay' });
    expect(r.numbers.map((x) => x.key)).toEqual([...READING_KEYS]);
    for (const x of r.numbers) expect(x).toEqual({ key: x.key, n: 0, shown: false, value: null, low: null, high: null, population: Math.round(DEFAULT.numbers[x.key].mean * 1000) / 1000, source: 'selfplay' });
    expect(r.time).toEqual({ n: 0, shown: false, medianMs: null, lowMs: null, highMs: null });
  });

  it('sums the segments, reads them against the person\'s mix, and shows a number exactly after 10 observations with an 80% interval narrower than 30 points', async () => {
    const db = testDb();
    const p = addDevice(db, dev('a'));
    // raise: 30 of 60 hands over two segments; bluff: 1 of 3 chances (too few); signals: 9 of 10.
    addProfile(db, p, 'paulista-2', { matches: 3, decisions: 70, h: 40, k: 20, bc: 2, br: 1, g: 10, gt: 9, tn: 70, tl: 70 * Math.log(1800), tl2: 70 * Math.log(1800) ** 2 + 70 * 0.25 });
    addProfile(db, p, 'mineiro-4', { matches: 2, decisions: 45, h: 20, k: 10, bc: 1, tn: 45, tl: 45 * Math.log(1800), tl2: 45 * Math.log(1800) ** 2 + 45 * 0.25 });
    const r = (await readingFor(db, dev('a'), NOW))!;
    expect(validateReading(r).ok).toBe(true);
    expect(r).toMatchObject({ matches: 5, decisions: 115 });
    const rows = db.raw.prepare('SELECT * FROM profiles').all() as (Row & { segment: string })[];
    const counts = readingCounts(sumRows(rows));
    const seen = observationCounts(sumRows(rows));
    const ref = referenceMeans(Object.fromEntries(rows.map((row) => [row.segment, rowCounts(row)])), DEFAULT);
    // raise is read at this person's mix: 40 hands in paulista-2 and 20 in mineiro-4.
    expect(ref.raise).toBeCloseTo(Math.min(0.999, (40 * DEFAULT.segments['paulista-2'].raise + 20 * DEFAULT.segments['mineiro-4'].raise) / 60), 12);
    for (const x of r.numbers) {
      const { x: k, n } = counts[x.key];
      const want = interval(k, n, ref[x.key], DEFAULT.numbers[x.key].strength);
      const shown = seen[x.key].n >= MIN_SHOWN_N && want.high - want.low < 0.3;
      expect(x.shown, x.key).toBe(shown);
      expect(x.n).toBe(seen[x.key].n);
      expect(x.population).toBe(Math.round(ref[x.key] * 1000) / 1000);
      if (shown) expect([x.value, x.low, x.high]).toEqual([want.mean, want.low, want.high].map((v) => Math.round(v * 1000) / 1000));
    }
    expect(r.numbers.find((x) => x.key === 'raise')).toMatchObject({ n: 60, shown: true });
    expect(r.numbers.find((x) => x.key === 'bluff')).toMatchObject({ n: 3, shown: false, value: null });
    // The decision time: 115 decisions around 1.8 s.
    expect(r.time.shown).toBe(true);
    expect(r.time.n).toBe(115);
    expect(Math.abs(r.time.medianMs! - 1800)).toBeLessThan(60);
    expect(r.time.lowMs! < r.time.medianMs! && r.time.medianMs! < r.time.highMs!).toBe(true);
  });

  it('the threshold: more observations narrow the interval until the number shows', async () => {
    const db = testDb();
    const p = addDevice(db, dev('a'));
    let first = -1;
    for (let h = 1; h <= 40; h++) {
      db.raw.prepare('DELETE FROM profiles').run();
      addProfile(db, p, 'paulista-2', { matches: 1, h, k: Math.round(h / 2) });
      const raise = (await readingFor(db, dev('a'), NOW))!.numbers[0];
      const want = interval(Math.round(h / 2), h, DEFAULT.segments['paulista-2'].raise, DEFAULT.numbers.raise.strength);
      expect(raise.shown, `h=${h}`).toBe(h >= MIN_SHOWN_N && want.high - want.low < 0.3);
      if (raise.shown && first < 0) first = h;
      if (first > 0) expect(raise.shown, `stays shown at h=${h}`).toBe(true);
    }
    expect(first).toBeGreaterThanOrEqual(MIN_SHOWN_N);
    expect(first).toBeLessThan(30);
  });

  it('with "Don\'t adapt to me" nothing is shown and the decisions read 0', async () => {
    const db = testDb();
    const p = addDevice(db, dev('a'), { no_adapt: 1 });
    addProfile(db, p, 'paulista-2', { matches: 9, decisions: 300, h: 90, k: 40, tn: 300, tl: 300 * 7.5 });
    const r = (await readingFor(db, dev('a'), NOW))!;
    expect(validateReading(r).ok).toBe(true);
    expect(r).toMatchObject({ noAdapt: true, matches: 0, decisions: 0 });
    expect(r.numbers.every((x) => !x.shown && x.value === null)).toBe(true);
    expect(r.time.shown).toBe(false);
  });

  it('imported priors replace the bundled ones; a body that does not pass the checks is ignored', () => {
    const people: PriorsFile = { ...DEFAULT, source: 'people', people: 120, numbers: { ...DEFAULT.numbers, run: { mean: 0.3, strength: 12, people: 120 } } };
    expect(priorsFrom(JSON.stringify(people)).numbers.run).toEqual({ mean: 0.3, strength: 12, people: 120 });
    expect(priorsFrom(null)).toEqual(DEFAULT);
    expect(priorsFrom('{"schema":"zap-priors/1"}')).toEqual(DEFAULT);
    expect(priorsFrom('not json')).toEqual(DEFAULT);
  });
});
