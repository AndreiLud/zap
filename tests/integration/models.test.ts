// Models served from local R2 by a running site (BASE=http://dev:8787): the local R2 helper
// (worker/dev/local-r2.ts) works in both directions while the site runs, records carry test: true
// and the versions per seat, and a manifest put by the helper is served, with the versions of a
// match pinned while the manifest changes. Needs MANIFEST_TTL_S (from .dev.vars) at most 5.
//
// The test puts a tiny model with random weights as v2 and puts the previous objects back after.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NUM_FEATURES } from '../../ai/src/features.ts';
import { parseModel } from '../../ai/src/mlp.ts';
import { modelBytes, randomLayers } from '../../ai/test/model-helpers.ts';
import { MANIFEST_KEY, SCHEMAS, modelKey, type Manifest, type ModelEntry } from '../../shared/cycle-formats.ts';
import { validateMatchRecord, type MatchRecord } from '../../shared/match-record.ts';
import { openLocalR2, type LocalR2 } from '../../worker/dev/local-r2.ts';
import { BASE, Device, lockManifest, playToEnd, sleep } from './helpers.ts';
import { createHash } from 'node:crypto';

const STATE = process.env.STATE_DIR ?? (BASE.endsWith(':8788') ? '.wrangler/e2e-state' : '.wrangler/state');
const TTL_WAIT_MS = 6_500;
const JSON_TYPE = 'application/json; charset=utf-8';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function entry(bytes: Uint8Array, personas: ModelEntry['personas'] = {}): ModelEntry {
  const h = parseModel(bytes).header;
  return { sha256: sha(bytes), bytes: bytes.byteLength, arch: 'mlp-v1', features: h.features, inputs: h.inputs, hidden: h.hidden, adapt: null, personas, createdAt: Date.now() };
}

/** The record of the device's newest match (newest first in /api/me/data), once the room wrote it. */
async function finishedRecord(d: Device, code: string, seen: Set<string>): Promise<{ id: string; rec: MatchRecord; seat: number }> {
  for (let i = 0; i < 40; i++) {
    const data = await d.get('/api/me/data');
    const m = (data.body as { matches: { matchId: string }[] }).matches[0];
    if (m && !seen.has(m.matchId)) {
      seen.add(m.matchId);
      const res = await d.get(`/api/me/matches/${m.matchId}`);
      expect(res.status, `record of ${code}`).toBe(200);
      const body = res.body as { yourSeat: number; record: MatchRecord };
      return { id: m.matchId, rec: body.record, seat: body.yourSeat };
    }
    await sleep(250);
  }
  throw new Error(`no new record for room ${code}`);
}

describe.skipIf(!BASE)('models served from local R2', () => {
  let models: LocalR2;
  let events: LocalR2;
  const saved = new Map<string, Uint8Array | null>();
  const bundled = JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8'));
  const v1: ModelEntry = { sha256: bundled.sha256, bytes: bundled.bytes, arch: 'mlp-v1', features: 'v1', inputs: 431, hidden: [256, 256], adapt: null, personas: {}, createdAt: Date.now() };
  const tiny = modelBytes(randomLayers(4242, NUM_FEATURES, [16, 8]), 'v1', 'i8');
  const manifest = (over: Partial<Manifest>): Manifest => ({
    schema: SCHEMAS.manifest,
    current: 'v1',
    control: null,
    controlShare: 0.3,
    controlUntil: null,
    updatedAt: Date.now(),
    models: { v1, v2: entry(tiny) },
    ...over,
  });

  let unlock: (() => void) | null = null;

  beforeAll(async () => {
    // reading.test.ts changes the same manifest: one file at a time.
    unlock = await lockManifest(STATE);
    models = await openLocalR2(STATE, 'zap-models');
    events = await openLocalR2(STATE, 'zap-events');
    for (const key of [MANIFEST_KEY, modelKey('v2')]) saved.set(key, await models.get(key));
  }, 330_000);

  afterAll(async () => {
    try {
      for (const [key, body] of saved) {
        if (body) await models.put(key, body, key.endsWith('.json') ? JSON_TYPE : 'application/octet-stream');
        else await models.delete(key);
      }
      await models?.close();
      await events?.close();
    } finally {
      unlock?.();
    }
  });

  it('a record written by the site is listed by the helper, marked test, with the version of each seat', async () => {
    const d = await new Device().verified();
    const code = await d.play({ players: 2, variant: 'paulista', opponents: ['zap'] });
    const c = await d.connect(code);
    await playToEnd(c, { paceMs: 300, timeoutMs: 90_000 });
    c.close();
    const { id, rec, seat } = await finishedRecord(d, code, new Set());
    expect(validateMatchRecord(rec).ok).toBe(true);
    expect(rec.schema).toBe('zap-match/2');
    expect(rec.test).toBe(true);
    expect(rec.seats[seat].aiVersion).toBeNull();
    expect(rec.seats[1 - seat].aiVersion).toBe(rec.aiVersion);
    const listed = await events.list('matches/v1/');
    const mine = listed.find((o) => o.key.endsWith(`/${id}.json`));
    expect(mine, 'the helper lists the record the site wrote').toBeDefined();
    const body = JSON.parse(new TextDecoder().decode((await events.get(mine!.key))!));
    expect(body).toEqual(rec);
  }, 120_000);

  it('a manifest put by the helper is served: the candidate faces the person, the previous version partners them, for the whole match', async () => {
    await models.put(modelKey('v2'), tiny, 'application/octet-stream');
    await models.put(MANIFEST_KEY, JSON.stringify(manifest({ current: 'v2', control: 'v1', controlShare: 0, controlUntil: Date.now() + 3600_000 })), JSON_TYPE);
    await sleep(TTL_WAIT_MS);
    const d = await new Device().verified();
    const seen = new Set<string>();
    const code = await d.play({ players: 4, variant: 'paulista', opponents: ['zap', 'lia'], partner: 'iara' });
    // The room shows the partners version, the same in both groups.
    expect((await d.get(`/api/rooms/${code}`)).body).toMatchObject({ aiVersion: 'v1' });
    const c = await d.connect(code);
    // Mid-match, the test is rolled back: the running match keeps its versions.
    const rollback = sleep(1_000).then(() => models.put(MANIFEST_KEY, JSON.stringify(manifest({ current: 'v1' })), JSON_TYPE));
    await playToEnd(c, { paceMs: 300, timeoutMs: 110_000 });
    await rollback;
    c.close();
    const { rec, seat } = await finishedRecord(d, code, seen);
    expect(validateMatchRecord(rec).ok).toBe(true);
    expect(rec).toMatchObject({ schema: 'zap-match/2', aiVersion: 'v2', partnerVersion: 'v1', arm: 'candidate', test: true });
    expect(rec.seats.map((s) => s.aiVersion)).toEqual(rec.seats.map((s, i) => (i === seat ? null : (i ^ 2) === seat ? 'v1' : 'v2')));

    // The next match reads the rolled-back manifest: v1 everywhere, no group.
    await sleep(TTL_WAIT_MS);
    const code2 = await d.play({ players: 2, variant: 'mineiro', opponents: ['otavio'] });
    const c2 = await d.connect(code2);
    await playToEnd(c2, { paceMs: 300, timeoutMs: 90_000 });
    c2.close();
    const next = await finishedRecord(d, code2, seen);
    expect(next.rec).toMatchObject({ aiVersion: 'v1', partnerVersion: 'v1', arm: null, test: true });
  }, 240_000);
});
