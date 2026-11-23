// After a test run, looks inside the local storage of wrangler dev (D1, R2 and the rooms' Durable
// Object files) for what must never be there: IP addresses, device secrets, and device ids or
// pseudonyms outside the few D1 columns that hold them by design. Deleted devices must be gone
// from every D1 table, style counters and export group tokens included. Every object in zap-events must be a valid match record (marked test, on a
// local site), daily receipt or export, and every object in zap-models a model file or a valid
// file of the training cycle (shared/cycle-formats.ts), with no person in any of them.
//
// It reads the files directly, so it runs on the machine that holds them, after the suite:
//   BASE=http://dev:8787 npx vitest run tests/integration
//   STATE_DIR=.wrangler/state npx vitest run tests/integration/storage-scan.test.ts
// The devices to look for come from the trace file the helpers write during the suite.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { validateMatchRecord } from '../../shared/match-record.ts';
import { LIMITS, VALIDATORS } from '../../shared/cycle-formats.ts';
import { TRACE_FILE, deviceIdOf, type TraceEntry } from './helpers.ts';

const STATE = process.env.STATE_DIR ? resolve(process.env.STATE_DIR) : '';
const V3 = STATE ? join(STATE, 'v3') : '';

/**
 * The running site may delete a file between the listing and the reading (a room that expires
 * removes its storage): such a file is gone and holds nothing, so it is skipped.
 */
function gone(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT';
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) out.push(...files(p));
      else out.push(p);
    } catch (e) {
      if (!gone(e)) throw e;
    }
  }
  return out;
}

/** Bytes as text, one character per byte, so binary pages can be searched with regular expressions; '' for a file already gone. */
function text(path: string): string {
  try {
    return readFileSync(path).toString('latin1');
  } catch (e) {
    if (gone(e)) return '';
    throw e;
  }
}

const IPV4 = /(?<![0-9.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![0-9.])/g;
const IPV6_FULL = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g;
const IPV6_SHORT = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?(?![0-9A-Fa-f:])/g;

/** Everything that looks like an IP address in a file. */
function ipsIn(s: string): string[] {
  const out = [...s.matchAll(IPV4)].map((m) => m[0]);
  out.push(...[...s.matchAll(IPV6_FULL)].map((m) => m[0]));
  // A compressed IPv6 address with at least three groups ("2001:db8::1"); a lone "::" is not one.
  out.push(...[...s.matchAll(IPV6_SHORT)].map((m) => m[0]).filter((m) => m.split(':').filter(Boolean).length >= 3));
  return out;
}

/** Needles of one fixed length found in runs of their alphabet (every window, so neighbours do not hide them). */
function findAll(s: string, run: RegExp, len: number, needles: Set<string>): string[] {
  const found = new Set<string>();
  if (needles.size === 0) return [];
  for (const m of s.matchAll(run)) {
    const r = m[0];
    for (let i = 0; i + len <= r.length; i++) {
      const w = r.slice(i, i + len);
      if (needles.has(w)) found.add(w);
    }
  }
  return [...found];
}
const HEX_RUN = /[0-9a-f]{32,}/g;
const B64_RUN = /[A-Za-z0-9_-]{22,}/g;

function readTrace(): TraceEntry[] {
  if (!existsSync(TRACE_FILE)) return [];
  return readFileSync(TRACE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEntry);
}

function openD1(): DatabaseSync | null {
  for (const f of files(join(V3, 'd1'))) {
    if (!f.endsWith('.sqlite') || f.endsWith('metadata.sqlite')) continue;
    const db = new DatabaseSync(f, { readOnly: true });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'devices'").get()) return db;
    db.close();
  }
  return null;
}

/** Every text value in every table of the D1 database, with its table and column. */
function d1Values(db: DatabaseSync): { where: string; value: string }[] {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all() as { name: string }[]).map((t) => t.name);
  const out: { where: string; value: string }[] = [];
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
      for (const [k, v] of Object.entries(row)) if (typeof v === 'string') out.push({ where: `${t}.${k}`, value: v });
    }
  }
  return out;
}

describe('the storage scan finds what it looks for', () => {
  it('IP addresses, also inside binary data, and not version-like or time-like numbers', () => {
    expect(ipsIn('\u0000\u0007198.18.3.4\u0001')).toEqual(['198.18.3.4']);
    expect(ipsIn('{"ip":"10.0.0.1"}')).toEqual(['10.0.0.1']);
    expect(ipsIn('2804:14c:5b73:8a4f:0:0:0:1')).toEqual(['2804:14c:5b73:8a4f:0:0:0:1']);
    expect(ipsIn('x 2001:db8::1 y')).toEqual(['2001:db8::1']);
    expect(ipsIn('::ffff:198.18.0.9')).toEqual(['198.18.0.9']);
    expect(ipsIn('v1.2.3 0.6123 1795282321523 "seat":0 a::b')).toEqual([]);
  });

  it('ids next to other characters of their alphabet', () => {
    const id = 'ab'.repeat(16);
    expect(findAll(`\u0001${id}\u0002`, HEX_RUN, 32, new Set([id]))).toEqual([id]);
    expect(findAll(`ff${id}0a`, HEX_RUN, 32, new Set([id]))).toEqual([id]);
    expect(findAll('f'.repeat(40), HEX_RUN, 32, new Set([id]))).toEqual([]);
  });
});

describe.skipIf(!STATE)('what the local storage keeps', () => {
  const trace = readTrace();
  const secrets = new Set(trace.flatMap((e) => (e.t === 'device' ? [e.secret] : [])));
  const testIps = new Set(trace.flatMap((e) => (e.t === 'ip' ? [e.ip] : [])));
  const deletedIds = new Set(trace.flatMap((e) => (e.t === 'deleted' ? [e.id] : [])));
  const deletedPseudonyms = new Set(trace.flatMap((e) => (e.t === 'deleted' && e.pseudonym ? [e.pseudonym] : [])));
  const nicknames = new Set(trace.flatMap((e) => (e.t === 'nickname' ? [e.value] : [])));
  const db = STATE ? openD1() : null;
  const devices = db ? (db.prepare('SELECT id, pseudonym, nickname FROM devices').all() as { id: string; pseudonym: string | null; nickname: string | null }[]) : [];
  const ids = new Set([...[...secrets].map(deviceIdOf), ...deletedIds, ...devices.map((d) => d.id)]);
  const pseudonyms = new Set([...deletedPseudonyms, ...devices.flatMap((d) => (d.pseudonym ? [d.pseudonym] : []))]);
  for (const d of devices) if (d.nickname && [...d.nickname].length >= 5) nicknames.add(d.nickname);

  it('has a D1 database and devices from the test run to look for', () => {
    expect(db, `no D1 database under ${V3}`).not.toBeNull();
    expect(secrets.size, `no devices in ${TRACE_FILE}: run the integration suite first`).toBeGreaterThan(0);
    expect(devices.length).toBeGreaterThan(0);
  });

  it('no IP address in any D1, R2 or room file (the per-IP limit only ever sees a salted hash)', () => {
    const problems: string[] = [];
    const all = [...files(join(V3, 'd1')), ...files(join(V3, 'r2')), ...files(join(V3, 'do'))];
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) {
      const s = text(f);
      for (const ip of ipsIn(s)) problems.push(`${f.slice(STATE.length)}: ${ip}${testIps.has(ip) ? ' (a test IP)' : ''}`);
    }
    expect(problems).toEqual([]);
  });

  it('no device secret in any D1, R2 or room file, and no pseudonym in the rooms', () => {
    const problems: string[] = [];
    for (const f of [...files(join(V3, 'd1')), ...files(join(V3, 'r2')), ...files(join(V3, 'do'))]) {
      const s = text(f);
      for (const x of findAll(s, B64_RUN, 22, secrets)) problems.push(`${f.slice(STATE.length)}: device secret ${x.slice(0, 6)}...`);
      if (f.includes(`${join('v3', 'do')}`)) {
        for (const x of findAll(s, HEX_RUN, 32, pseudonyms)) problems.push(`${f.slice(STATE.length)}: pseudonym ${x.slice(0, 6)}...`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('R2 holds only valid records, receipts, exports and training files, with no device id, pseudonym, nickname or room code', () => {
    const r2 = files(join(V3, 'r2'));
    const inBucket = (b: string) => r2.filter((f) => f.includes(join(b, 'blobs', '')));
    const blobs = inBucket('zap-events');
    expect(blobs.length, 'no match record in R2: did a match finish during the run?').toBeGreaterThan(0);
    const codes = db
      ? new Set([
          ...(db.prepare('SELECT code FROM open_rooms').all() as { code: string }[]).map((r) => r.code),
          ...(db.prepare('SELECT room_code AS code FROM reports WHERE room_code IS NOT NULL').all() as { code: string }[]).map((r) => r.code),
        ])
      : new Set<string>();
    const problems: string[] = [];
    const validators = VALIDATORS as Record<string, (j: unknown) => { ok: boolean; errors?: string[] }>;
    let records = 0;
    for (const f of blobs) {
      const s = readFileSync(f, 'utf8');
      const json = JSON.parse(s);
      if (json.schema === 'zap-receipt/1' || json.schema === 'zap-export/1') {
        const v = validators[json.schema](json);
        if (!v.ok) problems.push(`${f.slice(STATE.length)}: ${v.errors!.join('; ')}`);
        continue;
      }
      records++;
      const v = validateMatchRecord(json);
      if (!v.ok) problems.push(`${f.slice(STATE.length)}: ${v.errors.join('; ')}`);
      // A local site marks every record it writes since milestone 6 (TEST_RECORDS in .dev.vars).
      else if (json.schema === 'zap-match/2' && json.test !== true) problems.push(`${f.slice(STATE.length)}: a local record without test: true`);
      for (const n of nicknames) if (s.includes(n)) problems.push(`${f.slice(STATE.length)}: nickname ${n}`);
      for (const c of codes) if (s.includes(`"${c}"`) || (/[A-Z]/.test(c) && s.includes(c))) problems.push(`${f.slice(STATE.length)}: room code ${c}`);
    }
    expect(records, 'no match record in R2').toBeGreaterThan(0);
    // zap-models: model files (ZAPW, at most 2 MB) and the cycle's JSON files, each valid.
    for (const f of inBucket('zap-models')) {
      const bytes = readFileSync(f);
      if (bytes.subarray(0, 4).toString('latin1') === 'ZAPW') {
        if (bytes.byteLength > LIMITS.model) problems.push(`${f.slice(STATE.length)}: model file of ${bytes.byteLength} bytes`);
        continue;
      }
      let json: { schema?: string } | null = null;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        problems.push(`${f.slice(STATE.length)}: neither a model file nor JSON`);
        continue;
      }
      const validate = validators[String(json?.schema)];
      if (!validate) problems.push(`${f.slice(STATE.length)}: unknown schema ${String(json?.schema)}`);
      else {
        const v = validate(json);
        if (!v.ok) problems.push(`${f.slice(STATE.length)}: ${v.errors!.slice(0, 3).join('; ')}`);
      }
    }
    // zap-public: only a summary.json the Worker would serve (no number from fewer than 20 people).
    for (const f of inBucket('zap-public')) {
      let json: { schema?: string } | null = null;
      try {
        json = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        problems.push(`${f.slice(STATE.length)}: not JSON`);
        continue;
      }
      const v = String(json?.schema).startsWith('zap-summary/') ? validators[String(json?.schema)]?.(json) : undefined;
      if (!v) problems.push(`${f.slice(STATE.length)}: not a summary (${String(json?.schema)})`);
      else if (!v.ok) problems.push(`${f.slice(STATE.length)}: ${v.errors!.slice(0, 3).join('; ')}`);
    }
    for (const f of r2) {
      const s = text(f);
      for (const x of findAll(s, HEX_RUN, 64, ids)) problems.push(`${f.slice(STATE.length)}: device id ${x.slice(0, 8)}...`);
      for (const x of findAll(s, HEX_RUN, 32, pseudonyms)) problems.push(`${f.slice(STATE.length)}: pseudonym ${x.slice(0, 6)}...`);
    }
    expect(problems).toEqual([]);
  });

  it('in D1, device ids appear only as the device key, the creator of an open room and a room member; pseudonyms only where they link', () => {
    expect(db).not.toBeNull();
    const idPlaces = new Set(['devices.id', 'open_rooms.device', 'room_members.device']);
    const pseudonymPlaces = new Set(['devices.pseudonym', 'match_seats.pseudonym', 'reports.reporter', 'reports.target', 'flags.pseudonym', 'profiles.pseudonym', 'export_groups.pseudonym']);
    const problems: string[] = [];
    let keys = 0;
    for (const { where, value } of d1Values(db!)) {
      if (where === 'devices.id' && ids.has(value)) keys++;
      for (const x of findAll(value, HEX_RUN, 64, ids)) if (!idPlaces.has(where) || value !== x) problems.push(`${where}: device id ${x.slice(0, 8)}...`);
      for (const x of findAll(value, HEX_RUN, 32, pseudonyms)) if (!pseudonymPlaces.has(where) || value !== x) problems.push(`${where}: pseudonym ${x.slice(0, 6)}...`);
      for (const x of findAll(value, B64_RUN, 22, secrets)) problems.push(`${where}: device secret ${x.slice(0, 6)}...`);
    }
    expect(problems).toEqual([]);
    // The search does find the ids where they belong.
    expect(keys).toBe(devices.length);
  });

  it('the training cycle tables: counters and group tokens only for people D1 still has, imports with no person', () => {
    expect(db).not.toBeNull();
    const orphans = (table: string) =>
      (db!.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE pseudonym NOT IN (SELECT pseudonym FROM devices WHERE pseudonym IS NOT NULL)`).get() as { n: number }).n;
    expect(orphans('profiles'), 'counters of a person D1 no longer has').toBe(0);
    expect(orphans('export_groups'), 'group tokens of a person D1 no longer has').toBe(0);
    // Nobody with "Don't adapt to me" on has counters.
    expect((db!.prepare('SELECT COUNT(*) AS n FROM profiles WHERE pseudonym IN (SELECT pseudonym FROM devices WHERE no_adapt = 1)').get() as { n: number }).n).toBe(0);
    for (const row of db!.prepare('SELECT grp FROM export_groups').all() as { grp: string }[]) expect(row.grp).toMatch(/^[0-9a-f]{16}$/);
    for (const row of db!.prepare('SELECT name, body FROM cycle_imports').all() as { name: string; body: string | null }[]) {
      for (const x of findAll(row.body ?? '', HEX_RUN, 32, pseudonyms)) throw new Error(`cycle_imports.${row.name}: pseudonym ${x.slice(0, 6)}...`);
    }
  });

  it('the public counters (live_counts, GET /api/live) are one row of numbers, no person in it', () => {
    expect(db).not.toBeNull();
    const rows = db!.prepare('SELECT * FROM live_counts').all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['decisions', 'id', 'matches', 'updated_at']);
    for (const v of Object.values(rows[0])) expect(Number.isSafeInteger(v)).toBe(true);
    expect(rows[0].id).toBe(1);
  });

  it('deleted and recovered-away devices are gone from every D1 table', () => {
    expect(deletedIds.size, 'the privacy tests trace their deletions').toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { where, value } of d1Values(db!)) {
      for (const id of deletedIds) if (value.includes(id)) problems.push(`${where}: deleted device ${id.slice(0, 8)}...`);
      for (const p of deletedPseudonyms) if (value.includes(p)) problems.push(`${where}: deleted pseudonym ${p.slice(0, 6)}...`);
    }
    expect(problems).toEqual([]);
  });
});
