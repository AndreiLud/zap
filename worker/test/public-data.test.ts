// The data page's public endpoints (worker/src/public-data.ts) and the counters behind them
// (migration 0008_live.sql, privacy.ts liveCountStatement), on node:sqlite with the real
// migrations: a match counts once with its people's moves however often its batch repeats, the
// answers hold aggregates only, summary.json passes only when valid, and the cache keeps only
// public answers and gives a stored one back with the Worker's own cache-control.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_SOLO, LIVE_COUNTER_ROWS } from '../src/brake.ts';
import { RECORD_PREFIX, flushPending, type PendingRecord, type RecordStore } from '../src/pending-records.ts';
import { matchRowStatements, newPseudonym, type MatchRow } from '../src/privacy.ts';
import {
  INTENDED_CACHE_CONTROL,
  LIVE_MAX_AGE_S,
  LIVE_SCHEMA,
  SUMMARY_MAX_AGE_S,
  checkSummaryBody,
  liveAnswer,
  liveCounts,
  publicCacheControl,
  servedNow,
  throughCache,
  warnSummaryOnce,
  type PublicCache,
} from '../src/public-data.ts';
import { LIMITS, SCHEMAS, type Manifest, type ModelEntry } from '../../shared/cycle-formats.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

const NOW = Date.UTC(2026, 10, 23, 12);
const dev = (c: string) => c.repeat(64);
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const FIXTURES = 'tests/fixtures/cycle/zap-summary';
const fixture = (kind: 'valid' | 'invalid', name: string) => readFileSync(join(FIXTURES, kind, `${name}.json`), 'utf8');

function addDevice(db: TestDb, id: string): void {
  db.raw.prepare('INSERT INTO devices (id, created_at, pseudonym, adult_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(id, NOW, newPseudonym(), NOW, NOW);
}

function row(id: string, over: Partial<MatchRow> = {}): MatchRow {
  return { matchId: id, startedAt: NOW - 60_000, endedAt: NOW, kind: 'solo2', variant: 'paulista', players: 4, aiVersion: 'v2', recordKey: `matches/v1/x/${id}.json`, seats: [], ...over };
}

const counts = (db: TestDb) => db.raw.prepare('SELECT id, matches, decisions, updated_at FROM live_counts').all();

describe('live counters (0008_live.sql, liveCountStatement)', () => {
  it('the migration counts the matches already in D1, with no moves, and runs again without change', () => {
    const raw = new DatabaseSync(':memory:');
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    expect(files.at(-1)).toBe('0008_live.sql');
    for (const f of files.slice(0, -1)) raw.exec(readFileSync(MIGRATIONS + f, 'utf8'));
    const insert = raw.prepare('INSERT INTO matches (id, started_at, ended_at, kind, variant, players, ai_version, record_key) VALUES (?, 0, 0, ?, ?, ?, ?, ?)');
    for (const id of ['m1', 'm2', 'm3']) insert.run(id, 'solo1', 'paulista', 2, 'v1', `k/${id}`);
    const live = readFileSync(MIGRATIONS + files.at(-1)!, 'utf8');
    raw.exec(live);
    expect(raw.prepare('SELECT id, matches, decisions, updated_at FROM live_counts').all()).toEqual([{ id: 1, matches: 3, decisions: 0, updated_at: 0 }]);
    raw.exec(live);
    expect(raw.prepare('SELECT COUNT(*) AS n, MAX(matches) AS m FROM live_counts').get()).toEqual({ n: 1, m: 3 });
    // One row only: the table holds no person, nothing per match.
    expect(() => raw.prepare('INSERT INTO live_counts (id) VALUES (2)').run()).toThrow();
  });

  it('a finished match adds 1 and its people\'s moves, once however often its batch repeats', async () => {
    const db = testDb();
    expect(counts(db)).toEqual([{ id: 1, matches: 0, decisions: 0, updated_at: 0 }]);
    addDevice(db, dev('a'));
    const m = row('m1', { seats: [{ seat: 0, device: dev('a'), verified: true }], humanDecisions: 23 });
    for (let i = 0; i < 3; i++) await db.batch(matchRowStatements(db, m));
    expect(counts(db)).toEqual([{ id: 1, matches: 1, decisions: 23, updated_at: NOW }]);
    // With the brake's swap in front, the same.
    await db.batch(matchRowStatements(db, row('m2', { humanDecisions: 7, endedAt: NOW + 1, brake: { key: '2026-11-23', reserved: null, spent: { workerRequests: 1, doRequests: 1, doWsMessages: 1, doRowsWritten: 1, doActiveMs: 1, d1RowsWritten: 1, d1RowsRead: 1 } } })));
    await db.batch(matchRowStatements(db, row('m2', { humanDecisions: 7, endedAt: NOW + 1 })));
    expect(counts(db)).toEqual([{ id: 1, matches: 2, decisions: 30, updated_at: NOW + 1 }]);
    expect(await liveCounts(db)).toEqual({ matches: 2, decisions: 30 });
  });

  it('a pending row saved before the counters (no humanDecisions) or with a bad count adds the match and no moves', async () => {
    const db = testDb();
    await db.batch(matchRowStatements(db, row('old')));
    await db.batch(matchRowStatements(db, row('neg', { humanDecisions: -4 })));
    await db.batch(matchRowStatements(db, row('nan', { humanDecisions: Number.NaN })));
    await db.batch(matchRowStatements(db, row('frac', { humanDecisions: 2.5 })));
    expect(await liveCounts(db)).toEqual({ matches: 4, decisions: 0 });
  });

  it('a seat the room retries later (pending-records.ts) does not count the match again', async () => {
    const db = testDb();
    const kv = new Map<string, unknown>();
    const store: RecordStore = {
      get: (k) => kv.get(k),
      put: (k, v) => void kv.set(k, v),
      delete: (k) => kv.delete(k),
      list: ({ prefix }) => [...kv].filter(([k]) => k.startsWith(prefix)),
    };
    // The second person's device is not in D1 yet (a recovery on its way): that seat waits.
    addDevice(db, dev('a'));
    const p: PendingRecord = { body: '{}', row: row('m1', { seats: [{ seat: 0, device: dev('a'), verified: true }, { seat: 2, device: dev('b'), verified: true }], humanDecisions: 11 }) };
    kv.set(RECORD_PREFIX + 'm1', JSON.stringify(p));
    let t = NOW;
    await flushPending(store, db, async () => undefined, () => t);
    expect((JSON.parse(kv.get(RECORD_PREFIX + 'm1') as string) as PendingRecord).seatsOnly).toBe(true);
    addDevice(db, dev('b'));
    t += 120_000;
    await flushPending(store, db, async () => undefined, () => t);
    expect(kv.size).toBe(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM match_seats').get()).toEqual({ n: 2 });
    expect(await liveCounts(db)).toEqual({ matches: 1, decisions: 11 });
  });

  it('the brake\'s solo estimate carries the counter\'s row on top of the measured spend (facts.json worker.brake)', () => {
    const facts = JSON.parse(readFileSync('facts.json', 'utf8'));
    const measured = facts.worker.brake.measured.solo.room;
    expect(DEFAULT_COST_SOLO.d1RowsWritten).toBe(measured.d1RowsWritten + LIVE_COUNTER_ROWS.d1RowsWritten);
    expect(DEFAULT_COST_SOLO.d1RowsRead).toBe(measured.d1RowsRead + LIVE_COUNTER_ROWS.d1RowsRead);
  });
});

describe('GET /api/live and GET /api/summary answers', () => {
  it('summary.json passes only when valid and within its size: both schemas', () => {
    for (const name of ['start', 'full', 'v2-start', 'v2-full', 'v2-few-people']) {
      const r = checkSummaryBody(fixture('valid', name));
      expect(r.ok, name).toBe(true);
      if (r.ok) expect(r.body).toBe(fixture('valid', name));
    }
    for (const f of readdirSync(join(FIXTURES, 'invalid'))) {
      const r = checkSummaryBody(fixture('invalid', f.replace(/\.json$/, '')));
      expect(r.ok, f).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invalid');
    }
    expect(checkSummaryBody(null)).toEqual({ ok: false, reason: 'missing', errors: [] });
    expect(checkSummaryBody('{')).toMatchObject({ ok: false, reason: 'invalid' });
    const big = fixture('valid', 'v2-full').replace(/\n$/, ' '.repeat(LIMITS.summary));
    expect(checkSummaryBody(big)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('the live answer: counters, the version in play, its reading, and humansVsZap from a valid summary only', async () => {
    const db = testDb();
    await db.batch(matchRowStatements(db, row('m1', { humanDecisions: 40 })));
    const full = JSON.parse(fixture('valid', 'v2-full'));
    const live = await liveAnswer(db, fixture('valid', 'v2-full'), 'v2', false, NOW);
    expect(live).toEqual({ schema: LIVE_SCHEMA, at: NOW, matches: 1, decisions: 40, current: 'v2', adapt: false, humansVsZap: { matches: full.humansVsZap.matches, humanWins: full.humansVsZap.humanWins } });
    // A /1 summary serves the same field.
    expect((await liveAnswer(db, fixture('valid', 'full'), 'v3', true, NOW)).humansVsZap).toEqual({ matches: 1500, humanWins: 600 });
    expect((await liveAnswer(db, null, 'v2', false, NOW)).humansVsZap).toBeNull();
    expect((await liveAnswer(db, fixture('invalid', 'v2-scoreboard-below-20'), 'v2', false, NOW)).humansVsZap).toBeNull();
    // Aggregates only: exactly these keys, and no text but the schema and the version label.
    expect(Object.keys(live).sort()).toEqual(['adapt', 'at', 'current', 'decisions', 'humansVsZap', 'matches', 'schema']);
  });

  it('the version in play and its reading follow the rooms\' rule', () => {
    const bundled = { label: 'v2', features: 'v2-empty', adapt: null };
    const entry = (features: ModelEntry['features'], adapt: ModelEntry['adapt']): ModelEntry => ({ sha256: 'a'.repeat(64), bytes: 10, arch: 'mlp-v1', features, inputs: 461, hidden: [8], adapt, personas: {}, createdAt: NOW });
    const manifest = (current: string, e: ModelEntry): Manifest => ({ schema: SCHEMAS.manifest, current, control: null, controlShare: 0.3, controlUntil: null, updatedAt: NOW, models: { v1: entry('v1', null), [current]: e } });
    const adaptive = manifest('v3', entry('v2', { bmax: 0.1, nHalf: 2 }));
    expect(servedNow('net', 'on', null, bundled)).toEqual({ current: 'v2', adapt: false });
    expect(servedNow('net', 'on', null, { label: 'v2', features: 'v2', adapt: { bmax: 0.1, nHalf: 2 } })).toEqual({ current: 'v2', adapt: true });
    expect(servedNow('net', 'on', adaptive, bundled)).toEqual({ current: 'v3', adapt: true });
    expect(servedNow('net', 'off', adaptive, bundled)).toEqual({ current: 'v3', adapt: false });
    expect(servedNow('net', undefined, adaptive, bundled)).toEqual({ current: 'v3', adapt: false });
    expect(servedNow('net', 'on', manifest('v3', entry('v2', { bmax: 0, nHalf: 2 })), bundled)).toEqual({ current: 'v3', adapt: false });
    expect(servedNow('net', 'on', manifest('v3', entry('v2-empty', null)), bundled)).toEqual({ current: 'v3', adapt: false });
    expect(servedNow('heuristic', 'on', adaptive, bundled)).toEqual({ current: 'heuristic', adapt: false });
  });

  it('the cache keeps public answers for their period and makes a failure again', async () => {
    const stored = new Map<string, Response>();
    const cache: PublicCache = {
      match: async (k) => stored.get(k.url)?.clone(),
      put: async (k, r) => void stored.set(k.url, r),
    };
    const kept: Promise<unknown>[] = [];
    let made = 0;
    const answer = (cc: string) => async () => {
      made++;
      return new Response(`{"n":${made}}`, { headers: { 'cache-control': cc } });
    };
    const key = new Request('https://zap.example/api/live');
    const a = await throughCache(cache, key, answer(publicCacheControl(LIVE_MAX_AGE_S)), (p) => kept.push(p));
    await Promise.all(kept);
    const b = await throughCache(cache, key, answer(publicCacheControl(LIVE_MAX_AGE_S)), (p) => kept.push(p));
    expect([await a.text(), await b.text(), made]).toEqual(['{"n":1}', '{"n":1}', 1]);
    expect(b.headers.get('cache-control')).toBe('public, max-age=60');
    // A failure is not kept; without a cache (local test sites) every request is fresh.
    const fail = new Request('https://zap.example/api/summary');
    await throughCache(cache, fail, answer('no-store'), (p) => kept.push(p));
    await throughCache(cache, fail, answer('no-store'), (p) => kept.push(p));
    expect(made).toBe(3);
    await throughCache(null, key, answer(publicCacheControl(SUMMARY_MAX_AGE_S)), (p) => kept.push(p));
    expect(made).toBe(4);
    expect(publicCacheControl(SUMMARY_MAX_AGE_S)).toBe('public, max-age=300');
  });

  it('a stored answer reaches the browser with the Worker\'s cache-control, not the zone\'s', async () => {
    const stored = new Map<string, Response>();
    // As measured on the live site: the zone's Browser Cache TTL rewrites what the Cache API returns
    // (DEPLOY.md's checks after a release confirm that a hit then goes out with the Worker's value).
    // In Workers the headers of a cached Response may be immutable, so these throw on any change: a
    // hit edited in place instead of rebuilt would become a 500 there and fails here.
    const cache: PublicCache = {
      match: async (k) => {
        const r = stored.get(k.url)?.clone();
        if (!r) return undefined;
        const h = new Headers(r.headers);
        h.set('cache-control', 'public, max-age=14400');
        h.set('cf-cache-status', 'HIT');
        const hit = new Response(r.body, { status: r.status, headers: h });
        const immutable = () => {
          throw new TypeError("Can't modify immutable headers.");
        };
        Object.assign(hit.headers, { set: immutable, delete: immutable, append: immutable });
        return hit;
      },
      put: async (k, r) => void stored.set(k.url, r),
    };
    const kept: Promise<unknown>[] = [];
    let made = 0;
    let fresh: Response | null = null;
    const answer = (cc: string, status = 200) => async () => {
      made++;
      fresh = new Response(`{"n":${made}}`, { status, headers: { 'cache-control': cc, 'x-content-type-options': 'nosniff' } });
      return fresh;
    };
    const live = new Request('https://zap.example/api/live');
    const miss = await throughCache(cache, live, answer(publicCacheControl(LIVE_MAX_AGE_S)), (p) => kept.push(p));
    await Promise.all(kept);
    // The miss goes out as made; the stored copy keeps its own period for the location.
    expect(miss).toBe(fresh);
    expect([miss.headers.get('cache-control'), miss.headers.has(INTENDED_CACHE_CONTROL)]).toEqual(['public, max-age=60', false]);
    expect(stored.get(live.url)!.headers.get('cache-control')).toBe('public, max-age=60');
    expect(stored.get(live.url)!.headers.get(INTENDED_CACHE_CONTROL)).toBe('public, max-age=60');
    // The fake hit really refuses a change, as the Cache API's may.
    expect((await cache.match(live))!.headers.delete).toThrow(/immutable/);
    const hit = await throughCache(cache, live, answer(publicCacheControl(LIVE_MAX_AGE_S)), (p) => kept.push(p));
    expect([await hit.text(), made, hit.status]).toEqual(['{"n":1}', 1, 200]);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60');
    expect(hit.headers.has(INTENDED_CACHE_CONTROL)).toBe(false);
    expect(hit.headers.get('cf-cache-status')).toBe('HIT');
    expect(hit.headers.get('x-content-type-options')).toBe('nosniff');
    // The 404 of a missing summary is public too, with its own period and status.
    const summary = new Request('https://zap.example/api/summary');
    await throughCache(cache, summary, answer(publicCacheControl(SUMMARY_MAX_AGE_S), 404), (p) => kept.push(p));
    await Promise.all(kept);
    const again = await throughCache(cache, summary, answer(publicCacheControl(SUMMARY_MAX_AGE_S), 404), (p) => kept.push(p));
    expect([again.status, again.headers.get('cache-control'), again.headers.has(INTENDED_CACHE_CONTROL), made]).toEqual([404, 'public, max-age=300', false, 2]);
    // A failure is never stored, so no copy of it can come back with a period.
    const failing = new Request('https://zap.example/api/live?failing');
    const failed = await throughCache(cache, failing, answer('no-store', 503), (p) => kept.push(p));
    await Promise.all(kept);
    expect([stored.has(failing.url), failed.headers.get('cache-control'), failed.headers.has(INTENDED_CACHE_CONTROL)]).toEqual([false, 'no-store', false]);
    // A copy stored by a Worker without the internal header: the browser asks again each time.
    stored.set(live.url, new Response('{"n":0}', { headers: { 'cache-control': 'public, max-age=60' } }));
    const old = await throughCache(cache, live, answer(publicCacheControl(LIVE_MAX_AGE_S)), (p) => kept.push(p));
    expect([await old.text(), old.headers.get('cache-control')]).toEqual(['{"n":0}', 'no-cache']);
  });

  it('a refused summary.json is logged once per file', () => {
    const lines: string[] = [];
    warnSummaryOnce('etag-1', ['scoreboard[0].people: out of range'], (m) => lines.push(m));
    warnSummaryOnce('etag-1', ['scoreboard[0].people: out of range'], (m) => lines.push(m));
    warnSummaryOnce('etag-2', [], (m) => lines.push(m));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/summary\.json refused \(scoreboard\[0\]\.people/);
  });
});
