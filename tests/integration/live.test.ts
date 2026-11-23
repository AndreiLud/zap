// The data page's public endpoints on a running site (BASE=http://dev:8787): GET /api/live answers
// without a credential and with aggregates only, and a finished match adds 1 to its matches and
// the moves its person made to its decisions; GET /api/summary serves the summary.json that
// worker/dev/local-r2.ts puts in the local public bucket, as stored, and refuses an invalid one.
// A local test site (TEST_RECORDS) skips the Cache API, so every answer is fresh.
//
// The test puts summary fixtures in the local zap-public and puts the previous object back at the
// end. Other files play matches at the same time, so the counters are compared with "at least".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_VERSION_LABEL, SUMMARY_KEY } from '../../shared/cycle-formats.ts';
import type { MatchRecord } from '../../shared/match-record.ts';
import { openLocalR2, type LocalR2 } from '../../worker/dev/local-r2.ts';
import { BASE, Device, playToEnd, sleep } from './helpers.ts';

const STATE = process.env.STATE_DIR ?? (BASE.endsWith(':8788') ? '.wrangler/e2e-state' : '.wrangler/state');
const JSON_TYPE = 'application/json; charset=utf-8';
const FIXTURES = 'tests/fixtures/cycle/zap-summary';
const fixture = (kind: 'valid' | 'invalid', name: string) => `${FIXTURES}/${kind}/${name}.json`;

interface Live {
  schema: string;
  at: number;
  matches: number;
  decisions: number;
  current: string;
  adapt: boolean;
  humansVsZap: { matches: number; humanWins: number } | null;
}

async function live(d: Device): Promise<Live> {
  const r = await d.get('/api/live');
  expect(r.status, r.text).toBe(200);
  return r.body as Live;
}

describe.skipIf(!BASE)('GET /api/live and GET /api/summary', () => {
  let pub: LocalR2;
  let saved: Uint8Array | null = null;

  beforeAll(async () => {
    pub = await openLocalR2(STATE, 'zap-public');
    saved = await pub.get(SUMMARY_KEY);
  }, 120_000);

  afterAll(async () => {
    try {
      if (saved) await pub?.put(SUMMARY_KEY, saved, JSON_TYPE);
      else await pub?.delete(SUMMARY_KEY);
    } finally {
      await pub?.close();
    }
  });

  it('/api/live answers anyone with the site\'s totals, the version in play and nothing else', async () => {
    const anon = new Device();
    const r = await anon.get('/api/live');
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect(r.headers.get('content-type')).toBe(JSON_TYPE);
    expect(r.setCookies).toEqual([]);
    const body = r.body as Live;
    expect(Object.keys(body).sort()).toEqual(['adapt', 'at', 'current', 'decisions', 'humansVsZap', 'matches', 'schema']);
    expect(body.schema).toBe('zap-live/1');
    expect(Number.isSafeInteger(body.matches) && body.matches >= 0).toBe(true);
    expect(Number.isSafeInteger(body.decisions) && body.decisions >= 0).toBe(true);
    expect(body.current).toMatch(AI_VERSION_LABEL);
    // AI_ADAPT is off on the local sites, as in production today.
    expect(body.adapt).toBe(false);
    expect(Math.abs(body.at - Date.now())).toBeLessThan(60_000);
    // Only GET.
    expect((await anon.post('/api/live', {})).status).not.toBe(200);
  });

  it('a finished match adds 1 to matches and the moves its person made to decisions', async () => {
    const d = await new Device().verified();
    const before = await live(d);
    const code = await d.play({ players: 2, variant: 'paulista', opponents: ['zap'] });
    const c = await d.connect(code);
    await playToEnd(c, { paceMs: 300, timeoutMs: 120_000 });
    c.close();
    let id: string | null = null;
    for (let i = 0; i < 60 && !id; i++) {
      id = ((await d.get('/api/me/data')).body as { matches: { matchId: string }[] }).matches[0]?.matchId ?? null;
      if (!id) await sleep(250);
    }
    expect(id, `the match of room ${code} was not written`).not.toBeNull();
    const rec = (await d.get(`/api/me/matches/${id}`)).body as { record: MatchRecord };
    const mine = rec.record.moves.filter((m) => m.ms !== null).length;
    expect(mine).toBeGreaterThan(0);
    const after = await live(d);
    expect(after.matches).toBeGreaterThanOrEqual(before.matches + 1);
    expect(after.decisions).toBeGreaterThanOrEqual(before.decisions + mine);
    expect(after.at).toBeGreaterThanOrEqual(before.at);
  }, 180_000);

  it('/api/summary serves the file the local R2 helper put, as stored; an invalid or missing one is no_summary', async () => {
    const anon = new Device();
    // The helper's command line, as the e2e suite uses it.
    execFileSync('node', ['worker/dev/local-r2.ts', 'put-summary', fixture('valid', 'v2-full'), '--state', STATE], { stdio: 'pipe' });
    const text = readFileSync(fixture('valid', 'v2-full'), 'utf8');
    const r = await anon.get('/api/summary');
    expect(r.status, r.text).toBe(200);
    expect(r.text).toBe(text);
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('content-type')).toBe(JSON_TYPE);
    // /api/live carries the summary's humansVsZap, so the Play page needs one request only.
    const full = JSON.parse(text);
    expect((await live(anon)).humansVsZap).toEqual({ matches: full.humansVsZap.matches, humanWins: full.humansVsZap.humanWins });

    // The schema of milestone 6 is served too.
    await pub.put(SUMMARY_KEY, readFileSync(fixture('valid', 'full'), 'utf8'), JSON_TYPE);
    expect((await anon.get('/api/summary')).text).toBe(readFileSync(fixture('valid', 'full'), 'utf8'));

    // A file with a number from fewer than 20 people never leaves the server.
    expect(() => execFileSync('node', ['worker/dev/local-r2.ts', 'put-summary', fixture('invalid', 'v2-scoreboard-below-20'), '--state', STATE], { stdio: 'pipe' })).toThrow();
    await pub.put(SUMMARY_KEY, readFileSync(fixture('invalid', 'v2-scoreboard-below-20'), 'utf8'), JSON_TYPE);
    const bad = await anon.get('/api/summary');
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ error: 'no_summary' });
    expect(bad.text).not.toContain('"people":19');
    expect((await live(anon)).humansVsZap).toBeNull();

    await pub.delete(SUMMARY_KEY);
    const none = await anon.get('/api/summary');
    expect(none.status).toBe(404);
    expect(none.body).toEqual({ error: 'no_summary' });
    expect((await live(anon)).humansVsZap).toBeNull();
  }, 120_000);
});
