// Decision tables of one cycle, from the match records mirrored by sync (contract 3.6).
//
// Usage: node training/cycle/node/build.ts --records DIR --out TABLES [--export FILE] [--config JSON] [--no-decisions]
//   --config '{"mode":"minio","deviceCap":0.02}'  mode r2 refuses test records, mode minio refuses
//                                                   records that are not test records.
//   --no-decisions  only records.jsonl and summary.json (the daily A/B check).
//
// Writes TABLES/records.jsonl (one line per valid record), TABLES/decisions.jsonl.gz (one line per
// decision of a person), TABLES/invalid.jsonl ({key, error}) and TABLES/summary.json (counts).
// Prints the summary as one JSON line.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { A_RAISE } from '../../../engine/src/engine.ts';
import type { Observation } from '../../../engine/src/observe.ts';
import { segmentOf } from '../../../ai/src/opponent-stats.ts';
import { normalizeRecord, validateMatchRecord, type MatchRecord } from '../../../shared/match-record.ts';
import { forEachDecision, type ReplayInput } from './replay.ts';

export const MAX_RECORD_BYTES = 256 * 1024;

export interface ExportRow {
  matchId: string;
  seat: number;
  weight: number;
  flagged: boolean;
  openDataOptOut: boolean;
  noAdapt: boolean;
  group: string;
}

export type DecisionType = 'answer' | 'onze' | 'bet' | 'card';

export function decisionType(obs: Observation): DecisionType {
  if (obs.phase === 'raise') return 'answer';
  if (obs.phase === 'onze') return 'onze';
  return (obs.legal & (1 << A_RAISE)) !== 0 ? 'bet' : 'card';
}

function popcount(x: number): number {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

export type Exclusion = 'friends' | 'unlinked' | 'flagged' | 'auto' | 'forced';

/** Why a decision gets weight 0, or null when it counts. */
export function exclusion(kind: string, row: ExportRow | undefined, auto: boolean, legal: number): Exclusion | null {
  if (kind === 'friends') return 'friends';
  if (!row) return 'unlinked';
  if (row.flagged || row.weight <= 0) return 'flagged';
  if (auto) return 'auto';
  if (popcount(legal) <= 1) return 'forced';
  return null;
}

/**
 * The device cap: each group's share of the total weight at most `cap`. Groups over the cap are
 * scaled down, the total is computed again, and so on, at most `passes` times. With fewer than
 * 1 / cap groups the cap is not applied. Returns the factor per group (1 when untouched).
 */
export function deviceCap(sums: ReadonlyMap<string, number>, cap: number, passes = 20): Map<string, number> {
  const factor = new Map<string, number>([...sums.keys()].map((g) => [g, 1]));
  if (sums.size < Math.ceil(1 / cap - 1e-9)) return factor;
  const cur = new Map(sums);
  for (let p = 0; p < passes; p++) {
    let total = 0;
    for (const v of cur.values()) total += v;
    const limit = cap * total;
    let changed = false;
    for (const [g, v] of cur) {
      if (v > limit * (1 + 1e-12)) {
        const f = limit / v;
        cur.set(g, limit);
        factor.set(g, factor.get(g)! * f);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return factor;
}

export interface BuildConfig {
  mode: 'r2' | 'minio';
  deviceCap: number;
}

export interface BuildSummary {
  records: number;
  valid: number;
  invalid: number;
  test: number;
  validMatches: number;
  linkedSeats: number;
  people: number | null;
  devices: number;
  decisions: number;
  weighted: number;
  excluded: Record<Exclusion | 'capped', number>;
}

function listRecords(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.map((p) => relative(dir, p).split(sep).join('/')).sort();
}

function readExport(file: string | undefined): Map<string, ExportRow> {
  const rows = new Map<string, ExportRow>();
  if (!file || !existsSync(file)) return rows;
  const ex = JSON.parse(readFileSync(file, 'utf8')) as { rows: ExportRow[]; partial: boolean };
  if (ex.partial) return rows;
  for (const r of ex.rows) rows.set(`${r.matchId}:${r.seat}`, r);
  return rows;
}

export async function build(opts: { records: string; out: string; exportFile?: string; config: BuildConfig; decisions: boolean }): Promise<BuildSummary> {
  mkdirSync(opts.out, { recursive: true });
  const rows = readExport(opts.exportFile);
  const keys = listRecords(opts.records);
  const recLines: string[] = [];
  const invalid: string[] = [];
  const excluded: BuildSummary['excluded'] = { friends: 0, unlinked: 0, flagged: 0, auto: 0, forced: 0, capped: 0 };
  const groupSums = new Map<string, number>();
  const tmp = join(opts.out, 'decisions.tmp.jsonl');
  const decLines: string[] = [];
  let tmpWritten = false;
  const flushTmp = () => {
    if (!decLines.length) return;
    writeFileSync(tmp, decLines.join(''), { flag: tmpWritten ? 'a' : 'w' });
    tmpWritten = true;
    decLines.length = 0;
  };
  let valid = 0;
  let test = 0;
  let linkedSeats = 0;
  let decisions = 0;
  const matchesWithWeight = new Set<number>();
  const peopleOf = new Map<number, Set<string>>();

  for (const key of keys) {
    const path = join(opts.records, key);
    const fail = (error: string) => invalid.push(JSON.stringify({ key, error }) + '\n');
    if (statSync(path).size > MAX_RECORD_BYTES) {
      fail('over 256 KB');
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      fail('not JSON');
      continue;
    }
    const v = validateMatchRecord(json);
    if (!v.ok) {
      fail(v.errors.slice(0, 3).join('; '));
      continue;
    }
    const r: MatchRecord = normalizeRecord(v.record);
    if (opts.config.mode === 'minio' && !r.test) {
      fail('not a test record');
      continue;
    }
    if (opts.config.mode === 'r2' && r.test) {
      fail('test record in production');
      continue;
    }
    const m = valid++;
    if (r.test) test++;
    const humans = r.seats
      .filter((s) => s.kind === 'human')
      .map((s) => {
        const row = rows.get(`${r.matchId}:${s.seat}`);
        if (row) linkedSeats++;
        return {
          seat: s.seat,
          group: row ? row.group : null,
          weight: row ? row.weight : null,
          flagged: row ? row.flagged : false,
          openDataOptOut: row ? row.openDataOptOut : false,
          noAdapt: row ? row.noAdapt : false,
          verified: s.verified,
          abandoned: r.abandoned.includes(s.seat),
        };
      });
    recLines.push(
      JSON.stringify({
        key,
        matchId: r.matchId,
        kind: r.kind,
        segment: segmentOf(r.config.variant, r.config.players),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        test: r.test,
        arm: r.arm,
        aiVersion: r.aiVersion,
        partnerVersion: r.partnerVersion,
        winner: r.result.winner,
        humans,
      }) + '\n',
    );
    if (!opts.decisions && r.kind !== 'friends') {
      // Without the decision table, a match counts as valid when a linked seat has weight.
      for (const s of r.seats) {
        const row = rows.get(`${r.matchId}:${s.seat}`);
        if (s.kind === 'human' && row && !row.flagged && row.weight > 0) {
          matchesWithWeight.add(m);
          (peopleOf.get(m) ?? peopleOf.set(m, new Set()).get(m)!).add(row.group);
        }
      }
      continue;
    }
    const humanSeats = new Set(humans.map((h) => h.seat));
    forEachDecision(r, (obs, i, seat, action, move, hand) => {
      if (!humanSeats.has(seat)) return;
      decisions++;
      const row = rows.get(`${r.matchId}:${seat}`);
      const why = exclusion(r.kind, row, move.auto, obs.legal);
      let w = 0;
      if (why) excluded[why]++;
      else {
        w = row!.weight;
        groupSums.set(row!.group, (groupSums.get(row!.group) ?? 0) + w);
        matchesWithWeight.add(m);
        (peopleOf.get(m) ?? peopleOf.set(m, new Set()).get(m)!).add(row!.group);
      }
      if (opts.decisions) {
        decLines.push(JSON.stringify({ m, i, seat, hand, type: decisionType(obs), legal: obs.legal, a: action, ms: move.ms, auto: move.auto, group: row ? row.group : null, w }) + '\n');
        if (decLines.length >= 20000) flushTmp();
      }
    });
  }

  writeFileSync(join(opts.out, 'records.jsonl'), recLines.join(''));
  writeFileSync(join(opts.out, 'invalid.jsonl'), invalid.join(''));

  const factor = deviceCap(groupSums, opts.config.deviceCap);
  let weighted = 0;
  if (opts.decisions) {
    flushTmp();
    if (!tmpWritten) writeFileSync(tmp, '');
    const gz = createGzip();
    const sink = createWriteStream(join(opts.out, 'decisions.jsonl.gz'));
    const lines = createInterface({ input: createReadStream(tmp), crlfDelay: Infinity });
    async function* rescaled() {
      for await (const line of lines) {
        if (!line) continue;
        const d = JSON.parse(line) as { group: string | null; w: number };
        if (d.w > 0 && d.group !== null) {
          const f = factor.get(d.group) ?? 1;
          if (f < 1) {
            excluded.capped++;
            d.w = Math.round(d.w * f * 1e6) / 1e6;
          }
          weighted++;
        }
        yield JSON.stringify(d) + '\n';
      }
    }
    await pipeline(Readable.from(rescaled()), gz, sink);
    rmSync(tmp, { force: true });
  } else {
    weighted = 0;
  }

  const groups = new Set<string>();
  let validMatches = 0;
  for (const m of matchesWithWeight) {
    validMatches++;
    for (const g of peopleOf.get(m) ?? []) groups.add(g);
  }
  const summary: BuildSummary = {
    records: keys.length,
    valid,
    invalid: keys.length - valid,
    test,
    validMatches,
    linkedSeats,
    people: groups.size >= 20 ? groups.size : null,
    devices: groups.size,
    decisions,
    weighted,
    excluded,
  };
  writeFileSync(join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = arg('records');
  const out = arg('out');
  if (!records || !out) {
    console.error('usage: build.ts --records DIR --out TABLES [--export FILE] [--config JSON] [--no-decisions]');
    process.exit(1);
  }
  const config = { mode: 'r2', deviceCap: 0.02, ...(JSON.parse(arg('config') ?? '{}') as Partial<BuildConfig>) } as BuildConfig;
  if (config.mode !== 'r2' && config.mode !== 'minio') throw new Error('mode must be r2 or minio');
  const summary = await build({ records, out, exportFile: arg('export'), config, decisions: !process.argv.includes('--no-decisions') });
  console.log(JSON.stringify(summary));
}
