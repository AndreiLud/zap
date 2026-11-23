// The daily Cron Trigger (worker/src/cron.ts): the receipt in R2, the stubs for the cycle's
// imports and export, and the training alert, which mails once per change of the training status
// (no email a day while it stays failed).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_KEY,
  SCHEMAS,
  STATUS_KEY,
  receiptKey,
  utcDate,
  validateReceipt,
  type Receipt,
  type TrainingStatus,
} from '../../shared/cycle-formats.ts';
import { alertMail, alertReason, runDaily, type AlertTexts, type Bucket, type DailyDeps } from '../src/cron.ts';
import { brakeConfig, dayKey } from '../src/brake.ts';
import { countingDb } from '../src/d1-budget.ts';
import type { SqlDb, SqlStatement } from '../src/privacy.ts';
import { testDb, type TestDb } from './sqlite-db.ts';

/** A database whose every statement reports `read` rows read and `written` rows written in its meta, as D1 does. */
function withRows(db: SqlDb, read: number, written: number): SqlDb {
  const inner = new WeakMap<object, SqlStatement>();
  const meta = <R,>(r: R): R => ({ ...r, meta: { ...((r as { meta?: object }).meta ?? {}), rows_read: read, rows_written: written } });
  const wrap = (s: SqlStatement): SqlStatement => {
    const w: SqlStatement = {
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      first: <T,>() => s.first<T>(),
      all: async <T,>() => meta(await s.all<T>()),
      run: async () => meta(await s.run()),
    };
    inner.set(w, s);
    return w;
  };
  return { prepare: (q: string) => wrap(db.prepare(q)), batch: async (ss: SqlStatement[]) => (await db.batch(ss.map((s) => inner.get(s) ?? s))).map(meta) };
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 22, 4);
const pt = JSON.parse(readFileSync('locales/pt-BR.json', 'utf8')) as Record<string, string>;
const TEXTS: AlertTexts = {
  subject: pt['alert.training.subject'],
  failed: pt['alert.training.failed'],
  stale: pt['alert.training.stale'],
  missing: pt['alert.training.missing'],
};

/** An in-memory bucket with the R2 calls the daily jobs make. */
class Mem implements Bucket {
  readonly data = new Map<string, string>();
  readonly types = new Map<string, string | undefined>();
  async get(key: string) {
    const v = this.data.get(key);
    return v === undefined ? null : { size: v.length, text: async () => v };
  }
  async head(key: string) {
    const v = this.data.get(key);
    return v === undefined ? null : { size: v.length };
  }
  async put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }) {
    this.data.set(key, body);
    this.types.set(key, opts?.httpMetadata?.contentType);
  }
  async list(opts: { prefix: string }) {
    return { objects: [...this.data.keys()].filter((k) => k.startsWith(opts.prefix)).sort().map((key) => ({ key })), truncated: false };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}

function status(over: Partial<TrainingStatus> = {}): TrainingStatus {
  return { schema: SCHEMAS.status, state: 'ok', startedAt: T0 - DAY, finishedAt: T0 - DAY / 2, updatedAt: T0 - DAY / 2, cycleId: '20261121-0100', step: 'idle', lastPromotion: null, message: 'cycle done', ...over };
}

function setup(opts: { mailer?: boolean; models?: boolean; failMail?: () => boolean } = {}) {
  const events = new Mem();
  const models = new Mem();
  const sent: { subject: string; text: string }[] = [];
  const deps: DailyDeps = {
    db: testDb(),
    events,
    models: opts.models === false ? null : models,
    mailer:
      opts.mailer === false
        ? null
        : {
            send: async (subject, text) => {
              if (opts.failMail?.()) throw new Error('send_email: destination not verified');
              sent.push({ subject, text });
            },
          },
    texts: TEXTS,
    deliverCalls: async () => 2,
  };
  return { deps, events, models, sent };
}

const receiptOf = (events: Mem, t: number): Receipt => JSON.parse(events.data.get(receiptKey(utcDate(t)))!);

describe('daily cron', () => {
  it("adds the D1 rows the run read and wrote to the day's brake ledger, so the brake sees the cron", async () => {
    const { deps } = setup({ models: false });
    const raw = deps.db as TestDb;
    const db = countingDb(withRows(raw, 3, 2));
    const r = await runDaily({ ...deps, db }, T0);
    expect(r.failed).toEqual([]);
    // Every statement before the ledger's own reported 3 rows read and 2 written.
    const before = db.statements - 1;
    expect(before).toBeGreaterThan(0);
    expect(raw.raw.prepare('SELECT s_d1r AS r, s_d1w AS w FROM brake_days WHERE day = ?').get(dayKey(T0))).toEqual({ r: 3 * before, w: 2 * before });
    // A database that reports no rows (node:sqlite here) leaves the ledger alone.
    const plain = setup({ models: false });
    await runDaily({ ...plain.deps, db: countingDb(plain.deps.db) }, T0);
    expect((plain.deps.db as TestDb).raw.prepare('SELECT COUNT(*) AS n FROM brake_days').get()).toEqual({ n: 0 });
  });

  it('writes a full receipt, with the cycle jobs off until they are built', async () => {
    const { deps, events } = setup({ models: false });
    const r = await runDaily(deps, T0);
    expect(r.failed).toEqual([]);
    const rec = receiptOf(events, T0);
    expect(validateReceipt(rec).ok).toBe(true);
    expect(rec).toEqual(r.receipt);
    expect(rec.date).toBe('2026-11-22');
    expect(events.types.get(receiptKey('2026-11-22'))).toBe('application/json; charset=utf-8');
    expect(rec.jobs.retention.status).toBe('ok');
    expect(rec.jobs.calls).toEqual({ status: 'ok', error: null, delivered: 2 });
    expect(rec.jobs.flags.status).toBe('off');
    expect(rec.jobs.priors.status).toBe('off');
    expect(rec.jobs.export.status).toBe('off');
    expect(rec.jobs.alert).toEqual({ status: 'off', error: null, sent: false, reason: null });
  });

  it('the brake\'s configuration problems fail the run (the Cron log names them), and the receipt stays as it is', async () => {
    const { deps, events } = setup({ models: false });
    deps.brakeProblems = brakeConfig({ BRAKE_MODE: 'paid', BRAKE_MONTHLY_USD: '5' }).problems;
    const r = await runDaily(deps, T0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatch(/^brake config: .*every match refused/);
    expect(validateReceipt(receiptOf(events, T0)).ok).toBe(true);
    deps.brakeProblems = [];
    expect((await runDaily(deps, T0)).failed).toEqual([]);
  });

  it('a failing step is in the receipt and in the result, and the others still run', async () => {
    const { deps, events } = setup();
    deps.db = { prepare: deps.db.prepare, batch: async () => Promise.reject(new Error('D1_ERROR: too many queries\nsecond line')) };
    const r = await runDaily(deps, T0);
    expect(r.failed).toEqual(['retention']);
    const rec = receiptOf(events, T0);
    expect(rec.jobs.retention).toMatchObject({ status: 'failed', error: 'D1_ERROR: too many queries second line' });
    expect(rec.jobs.calls.status).toBe('ok');
  });

  it('keeps receipts for 30 days', async () => {
    const { deps, events } = setup({ models: false });
    for (const d of [31, 30, 2]) await runDaily(deps, T0 - d * DAY);
    events.data.set('receipts/notes.txt', 'x');
    await runDaily(deps, T0);
    expect([...events.data.keys()].sort()).toEqual(['receipts/2026-10-23.json', 'receipts/2026-11-20.json', 'receipts/2026-11-22.json', 'receipts/notes.txt']);
  });
});

describe('training alert', () => {
  it('the rule: failed, older than 8 days, or missing while the manifest exists', () => {
    expect(alertReason(null, T0)).toBeNull();
    expect(alertReason('missing', T0)).toBe('missing');
    expect(alertReason(status(), T0)).toBeNull();
    expect(alertReason(status({ state: 'failed' }), T0)).toBe('failed');
    expect(alertReason(status({ state: 'running', updatedAt: T0 - 8 * DAY }), T0)).toBeNull();
    expect(alertReason(status({ state: 'running', updatedAt: T0 - 8 * DAY - 1 }), T0)).toBe('stale');
    const m = alertMail(TEXTS, 'failed', status({ state: 'failed', message: 'gate: time limit '.repeat(60) }));
    expect(m.subject).toBe(TEXTS.subject);
    expect(m.text).toContain('Estado: failed');
    expect(m.text).toContain('2026-11-21 16:00 UTC');
    expect(m.text).not.toContain('{');
    expect(m.text.length).toBeLessThan(TEXTS.failed.length + 520);
  });

  it('mails once per change of state, never once a day while the state stays', async () => {
    const { deps, events, models, sent } = setup();
    const day = (n: number) => T0 + n * DAY;
    // No manifest yet: nothing to watch.
    await runDaily(deps, day(0));
    expect(sent).toHaveLength(0);
    // The manifest exists but no status: one email.
    models.data.set(MANIFEST_KEY, '{}');
    await runDaily(deps, day(1));
    await runDaily(deps, day(2));
    expect(sent.map((m) => m.text.slice(0, 30))).toEqual([TEXTS.missing.slice(0, 30)]);
    expect(receiptOf(events, day(2)).jobs.alert).toEqual({ status: 'ok', error: null, sent: false, reason: 'missing' });
    // The cycle runs and ends ok: no email.
    models.data.set(STATUS_KEY, JSON.stringify(status({ updatedAt: day(3) })));
    await runDaily(deps, day(3));
    expect(sent).toHaveLength(1);
    // It fails: one email, also when the cron runs twice that day, and none on the days after.
    models.data.set(STATUS_KEY, JSON.stringify(status({ state: 'failed', updatedAt: day(4), message: 'train: exit code 1' })));
    await runDaily(deps, day(4));
    await runDaily(deps, day(4) + 3600_000);
    for (let n = 5; n < 12; n++) await runDaily(deps, day(n));
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('train: exit code 1');
    // Failed and now also old: the reason stays "failed", still no email.
    expect(receiptOf(events, day(11)).jobs.alert.reason).toBe('failed');
    // A later cycle ends ok, then the status goes stale: one email for that.
    models.data.set(STATUS_KEY, JSON.stringify(status({ updatedAt: day(12) })));
    await runDaily(deps, day(12));
    for (let n = 13; n < 25; n++) await runDaily(deps, day(n));
    expect(sent).toHaveLength(3);
    expect(sent[2].text.slice(0, 30)).toBe(TEXTS.stale.slice(0, 30));
    // An unreadable status file counts as missing: a new state, one email.
    models.data.set(STATUS_KEY, '{"schema":"zap-status/1"}');
    await runDaily(deps, day(25));
    await runDaily(deps, day(26));
    expect(sent).toHaveLength(4);
  });

  it('a failed send is tried again the next day; without a mailer the alert is off', async () => {
    let fail = true;
    const { deps, events, models, sent } = setup({ failMail: () => fail });
    models.data.set(MANIFEST_KEY, '{}');
    models.data.set(STATUS_KEY, JSON.stringify(status({ state: 'failed' })));
    const r = await runDaily(deps, T0);
    expect(r.failed).toEqual(['alert']);
    expect(receiptOf(events, T0).jobs.alert).toEqual({ status: 'failed', error: 'send_email: destination not verified', sent: false, reason: 'failed' });
    fail = false;
    await runDaily(deps, T0 + DAY);
    expect(sent).toHaveLength(1);
    const off = setup({ mailer: false });
    off.models.data.set(STATUS_KEY, JSON.stringify(status({ state: 'failed' })));
    await runDaily(off.deps, T0);
    expect(receiptOf(off.events, T0).jobs.alert).toEqual({ status: 'off', error: null, sent: false, reason: 'failed' });
  });
});
