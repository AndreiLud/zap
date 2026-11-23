// Readers shared by the human layer tools (contract 3.11): the decision tables that build.ts writes
// (records.jsonl, decisions.jsonl.gz) and the mirrored match records they point to.

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { normalizeRecord, validateMatchRecord, type MatchRecord } from '../../../../shared/match-record.ts';

export interface HumanSeat {
  seat: number;
  group: string | null;
  weight: number | null;
  flagged: boolean;
  openDataOptOut: boolean;
  noAdapt: boolean;
  verified: boolean;
  abandoned: boolean;
}

/** One line of tables/records.jsonl; its position in the file is the `m` of the decision rows. */
export interface RecordLine {
  key: string;
  matchId: string;
  kind: string;
  segment: string;
  startedAt: number;
  endedAt: number;
  test: boolean;
  arm: string | null;
  aiVersion: string;
  partnerVersion: string;
  winner: number;
  humans: HumanSeat[];
}

/** One line of tables/decisions.jsonl.gz: a decision of a person. */
export interface DecisionRow {
  m: number;
  i: number;
  seat: number;
  hand: number;
  type: 'answer' | 'onze' | 'bet' | 'card';
  legal: number;
  a: number;
  ms: number | null;
  auto: boolean;
  group: string | null;
  w: number;
}

export function readRecordLines(tables: string): RecordLine[] {
  const p = join(tables, 'records.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordLine);
}

export async function* decisionRows(tables: string): AsyncGenerator<DecisionRow> {
  const p = join(tables, 'decisions.jsonl.gz');
  if (!existsSync(p)) return;
  const lines = createInterface({ input: createReadStream(p).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as DecisionRow;
}

/** A mirrored record, checked again with a full replay and seen as zap-match/2. Throws when invalid. */
export function loadRecord(recordsDir: string, key: string): MatchRecord {
  const v = validateMatchRecord(JSON.parse(readFileSync(join(recordsDir, key), 'utf8')));
  if (!v.ok) throw new Error(`${key}: ${v.errors.slice(0, 2).join('; ')}`);
  return normalizeRecord(v.record);
}

/** Groups listed one per line (or a JSON array) in a file; empty when the file is not given. */
export function readGroupSet(file: string | undefined): Set<string> {
  if (!file || !existsSync(file)) return new Set();
  const text = readFileSync(file, 'utf8').trim();
  if (text.startsWith('[')) return new Set(JSON.parse(text) as string[]);
  return new Set(text.split('\n').map((s) => s.trim()).filter(Boolean));
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** 32 bit FNV-1a of a string: a stable hash for sampling rows. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
