// The human layers of the Worker against a running site (BASE=http://dev:8787): "How Zap reads you"
// before and after enough matches, the style counters the room adds at the end of each match,
// "Don't adapt to me" deleting them, a recovery adding them up, the daily export the cron writes
// to the local R2 (one random group per person, no person in the file), and a deletion removing
// the counters and the group mapping from D1.
//
// The export runs only once the training cycle exists, so the test puts the bootstrap manifest in
// the local zap-models when there is none, and takes it away again at the end.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MANIFEST_KEY, READING_KEYS, SCHEMAS, exportKey, receiptKey, utcDate, validateExport, validateReading, validateReceipt, type ExportFile, type Manifest, type Reading, type Receipt } from '../../shared/cycle-formats.ts';
import { openLocalR2, type LocalR2 } from '../../worker/dev/local-r2.ts';
import { BASE, DUMMY_TOKEN, Device, lockManifest, playToEnd, sleep, trace } from './helpers.ts';

const STATE = process.env.STATE_DIR ?? (BASE.endsWith(':8788') ? '.wrangler/e2e-state' : '.wrangler/state');
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_MATCHES = 7;

/** Plays one quick 1 against 1 match to the end and waits until the room wrote it (it shows in /api/me/data). */
async function playMatch(d: Device, before: number): Promise<void> {
  const code = await d.play({ players: 2, variant: 'paulista', opponents: ['zap'] });
  const c = await d.connect(code);
  await playToEnd(c, { paceMs: 300, timeoutMs: 120_000 });
  c.close();
  for (let i = 0; i < 60; i++) {
    if ((await d.get('/api/me/data')).body.matches.length > before) return;
    await sleep(250);
  }
  throw new Error(`the match of room ${code} was not written`);
}

async function reading(d: Device): Promise<Reading> {
  const r = await d.get('/api/me/reading');
  expect(r.status, r.text).toBe(200);
  const checked = validateReading(r.body);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  return r.body as Reading;
}

/** Fires the daily Cron Trigger of the local site (wrangler dev answers it only for a localhost Host header). */
function fireCron(): Promise<number> {
  const u = new URL(BASE);
  return new Promise((done, fail) => {
    const req = request({ host: u.hostname, port: u.port || 80, path: '/cdn-cgi/handler/scheduled?cron=0+4+*+*+*', headers: { host: `localhost:${u.port || 80}` } }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode ?? 0));
    });
    req.on('error', fail);
    req.end();
  });
}

/** The local D1 database of the site, read only. */
function openD1(): DatabaseSync {
  const files = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])) : [];
  for (const f of files(join(STATE, 'v3', 'd1'))) {
    if (!f.endsWith('.sqlite') || f.endsWith('metadata.sqlite')) continue;
    const db = new DatabaseSync(f, { readOnly: true });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profiles'").get()) return db;
    db.close();
  }
  throw new Error(`no D1 database with the profiles table under ${STATE}`);
}

describe.skipIf(!BASE)('How Zap reads you, the style counters and the daily export', () => {
  let models: LocalR2;
  let events: LocalR2;
  let savedManifest: Uint8Array | null = null;
  const ana = new Device();
  const bia = new Device();

  let unlock: (() => void) | null = null;

  beforeAll(async () => {
    // models.test.ts changes the same manifest: one file at a time.
    unlock = await lockManifest(STATE);
    models = await openLocalR2(STATE, 'zap-models');
    events = await openLocalR2(STATE, 'zap-events');
    savedManifest = await models.get(MANIFEST_KEY);
    await ensureManifest();
  }, 330_000);

  /** Puts the bootstrap manifest when there is none (also right before the cron run that needs it). */
  async function ensureManifest(): Promise<void> {
    if (await models.get(MANIFEST_KEY)) return;
    const b = JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8'));
    const manifest: Manifest = {
      schema: SCHEMAS.manifest,
      current: 'v1',
      control: null,
      controlShare: 0.3,
      controlUntil: null,
      updatedAt: Date.now(),
      models: { v1: { sha256: b.sha256, bytes: b.bytes, arch: 'mlp-v1', features: 'v1', inputs: 431, hidden: [256, 256], adapt: null, personas: {}, createdAt: Date.now() } },
    };
    await models.put(MANIFEST_KEY, JSON.stringify(manifest), JSON_TYPE);
  }

  afterAll(async () => {
    try {
      if (!savedManifest) await models?.delete(MANIFEST_KEY);
      await models?.close();
      await events?.close();
    } finally {
      unlock?.();
    }
  });

  it('needs a credential; a person with no match sees every number hidden', async () => {
    expect((await new Device().get('/api/me/reading')).status).toBe(401);
    await ana.verified();
    const r = await reading(ana);
    expect(r).toMatchObject({ noAdapt: false, matches: 0, decisions: 0 });
    expect(r.numbers.map((x) => x.key)).toEqual([...READING_KEYS]);
    expect(r.numbers.every((x) => !x.shown && x.n === 0 && x.value === null)).toBe(true);
    expect((await ana.get('/api/me/data')).body.profile).toEqual([]);
  });

  it('the room adds each match to the counters; after enough matches a number shows, with an 80% interval narrower than 30 points', async () => {
    let r = await reading(ana);
    let played = 0;
    while (played < MAX_MATCHES && !r.numbers.some((x) => x.shown)) {
      await playMatch(ana, played);
      played++;
      r = await reading(ana);
      // Every match counts once, also when the room writes it again.
      expect(r.matches).toBe(played);
      const profile = (await ana.get('/api/me/data')).body.profile as { segment: string; matches: number; decisions: number; H: number; TN: number }[];
      expect(profile.map((p) => [p.segment, p.matches])).toEqual([['paulista-2', played]]);
      expect(r.decisions).toBe(profile[0].decisions);
      expect(r.numbers[0].n).toBe(profile[0].H);
      expect(r.time.n).toBe(profile[0].TN);
    }
    const shown = r.numbers.filter((x) => x.shown);
    expect(shown.length, `nothing shown after ${played} matches: ${JSON.stringify(r.numbers.map((x) => [x.key, x.n]))}`).toBeGreaterThan(0);
    for (const x of shown) {
      expect(x.high! - x.low!).toBeLessThan(0.3 + 0.002);
      expect(x.low! <= x.value! && x.value! <= x.high!).toBe(true);
    }
    // Nothing about anyone else, and no id, in the answer.
    const text = JSON.stringify(r);
    expect(text).not.toContain((await ana.get('/api/me/data')).body.pseudonym);
    expect(text).not.toContain(ana.id!);
  }, (MAX_MATCHES + 1) * 130_000);

  it('"Don\'t adapt to me" deletes the counters at once and the room adds no more; switched off, counting starts again', async () => {
    const d = await new Device().verified();
    await playMatch(d, 0);
    expect((await reading(d)).matches).toBe(1);
    expect((await d.post('/api/me/prefs', { noAdapt: true })).status).toBe(200);
    expect((await d.get('/api/me/data')).body.profile).toEqual([]);
    const off = await reading(d);
    expect(off).toMatchObject({ noAdapt: true, matches: 0, decisions: 0 });
    expect(off.numbers.every((x) => !x.shown)).toBe(true);
    await playMatch(d, 1);
    expect((await d.get('/api/me/data')).body.profile).toEqual([]);
    expect((await d.post('/api/me/prefs', { noAdapt: false })).status).toBe(200);
    expect(await reading(d)).toMatchObject({ noAdapt: false, matches: 0 });
  }, 300_000);

  it('the cron writes the export: one random group per person, listed in their download, and no person in the file', async () => {
    await ensureManifest();
    expect(await fireCron()).toBe(200);
    const date = utcDate(Date.now());
    const body = await events.get(exportKey(date));
    expect(body, 'the export of today').not.toBeNull();
    const text = new TextDecoder().decode(body!);
    const file = JSON.parse(text) as ExportFile;
    const checked = validateExport(file);
    expect(checked.ok, JSON.stringify(checked).slice(0, 500)).toBe(true);
    expect(file).toMatchObject({ date, partial: false });
    const data = (await ana.get('/api/me/data')).body as { pseudonym: string; matches: { matchId: string; seat: number }[]; exportGroups: { exportDate: string; group: string }[] };
    const mine = file.rows.filter((row) => data.matches.some((m) => m.matchId === row.matchId && m.seat === row.seat));
    expect(mine).toHaveLength(data.matches.length);
    expect(new Set(mine.map((row) => row.group)).size).toBe(1);
    expect(mine.every((row) => row.weight > 0 && !row.flagged && !row.noAdapt)).toBe(true);
    expect(data.exportGroups).toContainEqual({ exportDate: date, group: mine[0].group });
    // No other person shares the group.
    expect(file.rows.filter((row) => row.group === mine[0].group)).toHaveLength(mine.length);
    for (const hidden of [data.pseudonym, ana.id!]) expect(text).not.toContain(hidden);
    const receipt = JSON.parse(new TextDecoder().decode((await events.get(receiptKey(date)))!)) as Receipt;
    expect(validateReceipt(receipt).ok).toBe(true);
    expect(receipt.jobs.export).toMatchObject({ status: 'ok', key: exportKey(date), partial: false });
    expect(receipt.jobs.flags.status).not.toBe('failed');
    expect(receipt.jobs.priors.status).not.toBe('failed');
  }, 120_000);

  it('a recovery adds this browser\'s counters into the recovered history; a deletion removes the counters and the group mapping', async () => {
    await bia.verified();
    await playMatch(bia, 0);
    const before = (await reading(ana)).matches;
    const code = (await ana.post('/api/me/recovery')).body.code as string;
    const pseudonym = (await ana.get('/api/me/data')).body.pseudonym as string;
    const r = await bia.post('/api/recover', { code, token: DUMMY_TOKEN, adult: true });
    expect(r.status, r.text).toBe(200);
    const merged = await reading(bia);
    expect(merged.matches).toBe(before + 1);
    const data = (await bia.get('/api/me/data')).body;
    expect(data.pseudonym).toBe(pseudonym);
    expect(data.profile.map((p: { segment: string; matches: number }) => [p.segment, p.matches])).toEqual([['paulista-2', before + 1]]);
    expect(data.exportGroups.length).toBeGreaterThan(0);

    const id = bia.id!;
    const del = await bia.post('/api/me/delete', { token: DUMMY_TOKEN });
    expect(del.status).toBe(200);
    trace({ t: 'deleted', id, pseudonym });
    const db = openD1();
    try {
      for (const table of ['profiles', 'export_groups', 'flags', 'match_seats']) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE pseudonym = ?`).get(pseudonym), table).toEqual({ n: 0 });
      }
    } finally {
      db.close();
    }
  }, 200_000);
});
