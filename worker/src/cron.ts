// The daily Cron Trigger (04:00 UTC), the only one the Worker has (Workers Free allows 5 per
// account, shared with other projects): every daily job runs inside it, in order, each in its own
// try, and the run leaves a receipt in R2 (receipts/YYYY-MM-DD.json in zap-events, zap-receipt/1)
// that the training cycle reads. The scheduled handler throws after the last step when any step
// failed, so the Cron log shows it.
//
//   1 retention  runRetention (privacy.ts)
//   2 calls      room calls still waiting (room-calls.ts)
//   3 flags      import control/flags.json (cycle-jobs.ts)
//   4 priors     import control/priors.json (cycle-jobs.ts)
//   5 alert      email the owner when the training status is failed, stale or missing
//   6 export     the day's export of linked seats (cycle-jobs.ts)
//   7 receipt    write the receipt, delete receipts older than 30 days
//
// Then the D1 rows the run read and wrote (as D1 reports them, d1-budget.ts) go to the day's brake
// ledger as spent rows, so the brake sees the cron as well as the matches (project_docs/brake.md).
// A failed write is added to the failures.
//
// The brake's configuration problems (worker/src/brake.ts) are not a step and not in the receipt:
// they are added to the failures, so the run fails with them in the Cron log.
//
// The alert reads status/training.json from zap-models. It mails only when the reason changes
// against the last receipt whose alert step ran (an "ok" alert): one email when the cycle fails,
// not one a day while it stays failed. At most one email per run, and only when the send_email
// binding, ALERT_EMAIL and ALERT_FROM are all set.

import { runRetention, type SqlDb } from './privacy.ts';
import {
  MANIFEST_KEY,
  RECEIPTS_PREFIX,
  RECEIPT_JOBS,
  RECEIPT_KEEP_DAYS,
  SCHEMAS,
  STALE_STATUS_MS,
  STATUS_KEY,
  MAX_ERROR_CHARS,
  MAX_MESSAGE_CHARS,
  parseChecked,
  receiptKey,
  utcDate,
  validateReceipt,
  validateStatus,
  type AlertReason,
  type Receipt,
  type ReceiptJob,
  type ReceiptJobs,
  type TrainingStatus,
} from '../../shared/cycle-formats.ts';
import { exportJob, flagsJob, priorsJob } from './cycle-jobs.ts';
import { dayKey, emptyUsage, settleStatement } from './brake.ts';
import { rowsUsed } from './d1-budget.ts';

/** The R2 calls the daily jobs make (an R2Bucket fits). */
export interface Bucket {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<unknown>;
}

/** Sends the training alert (worker/src/cf/index.ts adapts the send_email binding). */
export interface AlertMailer {
  send(subject: string, text: string): Promise<void>;
}

/** Texts of the alert (locales/pt-BR.json alert.training.*), with {state}, {updatedAt} and {message}. */
export interface AlertTexts {
  subject: string;
  failed: string;
  stale: string;
  missing: string;
}

export interface DailyDeps {
  db: SqlDb;
  /** zap-events: receipts, exports. */
  events: Bucket;
  /** zap-models: the training status, the manifest, the cycle's control files. Null without the binding. */
  models: Bucket | null;
  mailer: AlertMailer | null;
  texts: AlertTexts;
  /** Delivers the room calls still waiting; answers how many went through. */
  deliverCalls(): Promise<number>;
  /**
   * The brake's configuration problems (brake.ts brakeConfig): a value that fell back to a default,
   * or a paid ceiling that refuses every match. Listed among the failures, so the cron run fails
   * and the Cron log names them every day until the configuration is fixed.
   */
  brakeProblems?: string[];
}

export interface DailyResult {
  receipt: Receipt;
  /** Steps that failed (the receipt's jobs with status "failed", and the receipt itself). */
  failed: string[];
}

export const JSON_TYPE = 'application/json; charset=utf-8';
const DAY_MS = 86_400_000;
/** Receipts read to find the last alert state. */
const ALERT_LOOKBACK = 5;

/** An error as a receipt keeps it: one line, at most 200 characters. */
export function errorText(e: unknown): string {
  const s = String((e as Error)?.message ?? e).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return (s || 'error').slice(0, MAX_ERROR_CHARS);
}

/** The reason to alert for a status file, or null when all is well (contract 1.5). */
export function alertReason(status: TrainingStatus | 'missing' | null, now: number): AlertReason | null {
  if (status === null) return null;
  if (status === 'missing') return 'missing';
  if (status.state === 'failed') return 'failed';
  if (now - status.updatedAt > STALE_STATUS_MS) return 'stale';
  return null;
}

/** The alert email for a reason: the subject and the text with the status fields filled in. */
export function alertMail(texts: AlertTexts, reason: AlertReason, status: TrainingStatus | null): { subject: string; text: string } {
  const fill = (s: string) =>
    s
      .replaceAll('{state}', status?.state ?? '-')
      .replaceAll('{updatedAt}', status ? new Date(status.updatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-')
      .replaceAll('{message}', (status?.message ?? '').slice(0, MAX_MESSAGE_CHARS));
  return { subject: fill(texts.subject), text: fill(texts[reason]) };
}

/** Every key under a prefix (receipts and exports are few: one per day). */
export async function listKeys(b: Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await b.list({ prefix, cursor, limit: 1000 });
    keys.push(...res.objects.map((o) => o.key));
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  return keys;
}

const RECEIPT_KEY = /^receipts\/(\d{4}-\d{2}-\d{2})\.json$/;

/** The alert reason of the newest receipt whose alert step ran ("ok"), today's included; null when none. */
async function lastAlertState(events: Bucket): Promise<AlertReason | null> {
  const keys = (await listKeys(events, RECEIPTS_PREFIX)).filter((k) => RECEIPT_KEY.test(k)).sort().reverse();
  for (const key of keys.slice(0, ALERT_LOOKBACK)) {
    const obj = await events.get(key);
    if (!obj) continue;
    const r = parseChecked('receipt', await obj.text(), validateReceipt);
    if (r.ok && r.value.jobs.alert.status === 'ok') return r.value.jobs.alert.reason;
  }
  return null;
}

/** Step 6: the training alert. */
export async function alertJob(deps: DailyDeps, now: number): Promise<ReceiptJobs['alert']> {
  if (!deps.models) return { status: 'off', error: null, sent: false, reason: null };
  let status: TrainingStatus | 'missing' | null;
  const obj = await deps.models.get(STATUS_KEY);
  if (obj) {
    const checked = parseChecked('status', await obj.text(), validateStatus);
    // A status file that cannot be read counts as missing.
    status = checked.ok ? checked.value : 'missing';
  } else {
    // Before the cycle's first run (no manifest yet) there is nothing to watch.
    status = (await deps.models.head(MANIFEST_KEY)) ? 'missing' : null;
  }
  const reason = alertReason(status, now);
  if (!deps.mailer) return { status: 'off', error: null, sent: false, reason };
  if (reason === null || reason === (await lastAlertState(deps.events))) return { status: 'ok', error: null, sent: false, reason };
  const mail = alertMail(deps.texts, reason, typeof status === 'object' ? status : null);
  try {
    await deps.mailer.send(mail.subject, mail.text);
  } catch (e) {
    return { status: 'failed', error: errorText(e), sent: false, reason };
  }
  return { status: 'ok', error: null, sent: true, reason };
}

/** What a step reports when it threw. */
const FAILED: { [K in ReceiptJob]: Omit<ReceiptJobs[K], 'status' | 'error'> } = {
  retention: { counts: { devices: 0, reports: 0, flags: 0, rooms: 0, members: 0, calls: 0, exportGroups: 0, profiles: 0 } },
  calls: { delivered: 0 },
  flags: { sha256: null, applied: [], ignored: [], unresolved: [], reviewed: [] },
  priors: { sha256: null, imported: false },
  export: { key: null, rows: 0, reports: 0, partial: false, sha256: null },
  alert: { sent: false, reason: null },
};

async function step<K extends ReceiptJob>(job: K, run: () => Promise<ReceiptJobs[K]>): Promise<ReceiptJobs[K]> {
  try {
    return await run();
  } catch (e) {
    return { status: 'failed', error: errorText(e), ...FAILED[job] } as ReceiptJobs[K];
  }
}

/** Every daily job in order (see the top of this file). Never throws: failures are in the result. */
export async function runDaily(deps: DailyDeps, now: number): Promise<DailyResult> {
  const date = utcDate(now);
  const ctx = { deps, now, date };
  const jobs = {} as ReceiptJobs;
  jobs.retention = await step('retention', async () => {
    const r = (await runRetention(deps.db, now)) as Partial<ReceiptJobs['retention']['counts']>;
    const counts = { ...FAILED.retention.counts };
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) if (typeof r[k] === 'number') counts[k] = r[k];
    return { status: 'ok', error: null, counts };
  });
  jobs.calls = await step('calls', async () => ({ status: 'ok', error: null, delivered: await deps.deliverCalls() }));
  jobs.flags = await step('flags', () => flagsJob(ctx));
  jobs.priors = await step('priors', () => priorsJob(ctx));
  // The alert goes before the export, the run's largest step: a run killed during the export (CPU
  // or memory) has still sent the alert it owed.
  jobs.alert = await step('alert', () => alertJob(deps, now));
  jobs.export = await step('export', () => exportJob(ctx));
  const receipt: Receipt = { schema: SCHEMAS.receipt, date, createdAt: now, jobs: Object.fromEntries(RECEIPT_JOBS.map((j) => [j, jobs[j]])) as unknown as ReceiptJobs };
  const failed: string[] = RECEIPT_JOBS.filter((j) => jobs[j].status === 'failed');
  if (deps.brakeProblems?.length) failed.push(`brake config: ${deps.brakeProblems.join('; ')}`);
  try {
    const checked = validateReceipt(receipt);
    if (!checked.ok) throw new Error(`receipt invalid: ${checked.errors.slice(0, 3).join('; ')}`);
    await deps.events.put(receiptKey(date), JSON.stringify(receipt), { httpMetadata: { contentType: JSON_TYPE } });
    const cutoff = utcDate(now - RECEIPT_KEEP_DAYS * DAY_MS);
    const old = (await listKeys(deps.events, RECEIPTS_PREFIX)).filter((k) => {
      const m = RECEIPT_KEY.exec(k);
      return m !== null && m[1] < cutoff;
    });
    if (old.length > 0) await deps.events.delete(old);
  } catch (e) {
    failed.push(`receipt: ${errorText(e)}`);
  }
  const rows = rowsUsed(deps.db);
  if (rows && (rows.read > 0 || rows.written > 0)) {
    try {
      await settleStatement(deps.db, { key: dayKey(now), reserved: null, spent: { ...emptyUsage(), d1RowsRead: rows.read, d1RowsWritten: rows.written } }, now).run();
    } catch (e) {
      failed.push(`brake ledger: ${errorText(e)}`);
    }
  }
  return { receipt, failed };
}
