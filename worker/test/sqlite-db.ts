// D1's interface over node:sqlite with the real migrations, for the unit tests of the SQL in
// worker/src. A batch is one transaction, like D1.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDb, SqlStatement } from '../src/privacy.ts';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

class Stmt implements SqlStatement {
  private readonly db: DatabaseSync;
  readonly sql: string;
  private readonly params: unknown[];
  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, values);
  }
  private args() {
    return this.params as (string | number | null)[];
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args()).changes) } };
  }
  exec(): { meta: { changes: number }; results?: unknown[] } {
    if (/^\s*SELECT/i.test(this.sql)) return { meta: { changes: 0 }, results: this.db.prepare(this.sql).all(...this.args()) };
    // Like D1, a statement with RETURNING gives its rows in a batch too.
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = this.db.prepare(this.sql).all(...this.args());
      return { meta: { changes: results.length }, results };
    }
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args()).changes) }, results: [] };
  }
}

export type TestDb = SqlDb & { raw: DatabaseSync };

export function testDb(): TestDb {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(MIGRATIONS + f, 'utf8'));
  return {
    raw,
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: SqlStatement[]) {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => (s as Stmt).exec());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
