// Counts the D1 statements of one invocation. Workers Free allows 50 D1 queries per invocation,
// and the daily job counts every statement of a batch as one query to stay on the safe side: the
// export stops before the run passes 45 (cycle-jobs.ts). The scheduled handler wraps env.DB once,
// so every daily step is counted. It also adds up the rows D1 reports for each statement
// (meta.rows_read and meta.rows_written), which the daily run writes to the day's brake ledger
// (cron.ts), so the brake sees what the cron spends of the account's D1 rows.

import type { SqlDb, SqlStatement } from './privacy.ts';

/** A database that counts the statements sent through it, and the D1 rows they read and wrote. */
export interface CountingDb extends SqlDb {
  readonly statements: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** The rows D1 reports in a result's meta (D1 meta.rows_read and meta.rows_written; absent elsewhere). */
type Meter = (r: unknown) => void;

const INNER = Symbol('inner');

class Counted implements SqlStatement {
  readonly [INNER]: SqlStatement;
  private readonly tick: () => void;
  private readonly meter: Meter;
  constructor(inner: SqlStatement, tick: () => void, meter: Meter) {
    this[INNER] = inner;
    this.tick = tick;
    this.meter = meter;
  }
  bind(...values: unknown[]): SqlStatement {
    return new Counted(this[INNER].bind(...values), this.tick, this.meter);
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    // D1's first() has no meta: all() runs the same query and reports its rows.
    this.tick();
    const r = await this[INNER].all<T>();
    this.meter(r);
    return r.results[0] ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    this.tick();
    const r = await this[INNER].all<T>();
    this.meter(r);
    return r;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    this.tick();
    const r = await this[INNER].run();
    this.meter(r);
    return r;
  }
}

class Counting implements CountingDb {
  statements = 0;
  rowsRead = 0;
  rowsWritten = 0;
  private readonly db: SqlDb;
  constructor(db: SqlDb) {
    this.db = db;
  }
  private readonly meter: Meter = (r) => {
    const m = (r as { meta?: { rows_read?: unknown; rows_written?: unknown } } | null)?.meta;
    if (typeof m?.rows_read === 'number' && Number.isFinite(m.rows_read)) this.rowsRead += m.rows_read;
    if (typeof m?.rows_written === 'number' && Number.isFinite(m.rows_written)) this.rowsWritten += m.rows_written;
  };
  prepare(query: string): SqlStatement {
    return new Counted(this.db.prepare(query), () => this.statements++, this.meter);
  }
  async batch(statements: SqlStatement[]): ReturnType<SqlDb['batch']> {
    this.statements += statements.length;
    // D1 takes only its own statement objects in a batch.
    const out = await this.db.batch(statements.map((s) => (s instanceof Counted ? s[INNER] : s)));
    for (const r of out) this.meter(r);
    return out;
  }
}

/** Wraps a database so it counts statements (a database already counting is returned as it is). */
export function countingDb(db: SqlDb): CountingDb {
  return db instanceof Counting ? db : new Counting(db);
}

/** Statements counted so far, or null when the database does not count. */
export function statementsUsed(db: SqlDb): number | null {
  return db instanceof Counting ? db.statements : null;
}

/** The D1 rows read and written so far, or null when the database does not count. */
export function rowsUsed(db: SqlDb): { read: number; written: number } | null {
  return db instanceof Counting ? { read: db.rowsRead, written: db.rowsWritten } : null;
}
