// Merges documented and measured values that no training run produces (a Cloudflare price, the size
// of a GIF) into facts.json under the top-level key "docs".
//
// Input files hold one object per key, in the format of _local/m9/facts-docs/<area>.json:
//   { "<key>": { "value": <number|string>, "unit": "...", "source": "<URL or command>",
//                "readAt" or "measuredAt": "<ISO date>", "kind": "documented" | "measured" } }
//
// The tool reads facts.json again right before it writes, sets only facts.docs (keys already there
// stay, a key given again is replaced), and never touches any other key. The write is atomic: a
// temporary file in the same folder, then a rename. When facts.json changed between the read and the
// rename (a training run writes it), the merge starts again from the new content.
//
// Usage:
//   docker compose run --rm -T node node tools/docs/facts-docs.ts [--facts <path>] [--check] [file|dir ...]
// With no file or folder, it reads every *.json in _local/m9/facts-docs/. --check writes nothing and
// exits 1 when facts.json lacks a value of the inputs or holds a different one.

import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, from this file's place (tools/docs). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_INPUT_DIR = join(ROOT, '_local', 'm9', 'facts-docs');
export const DEFAULT_FACTS = join(ROOT, 'facts.json');

export interface DocValue {
  value: number | string;
  unit: string;
  source: string;
  readAt?: string;
  measuredAt?: string;
  kind: 'documented' | 'measured';
  [extra: string]: unknown;
}

export type DocValues = Record<string, DocValue>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function isIsoDate(s: unknown): boolean {
  return typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));
}

/** Checks one input file's content and returns its values; throws with every problem found. */
export function validateDocValues(input: unknown, name: string): DocValues {
  const problems: string[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${name}: the file must hold one JSON object`);
  const out: DocValues = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const at = `${name}: "${key}"`;
    if (!KEY.test(key)) problems.push(`${at}: a key starts with a letter and holds letters, digits, ".", "_" or "-"`);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at}: the value must be an object`);
      continue;
    }
    const v = raw as Record<string, unknown>;
    if (!(typeof v.value === 'string' || (typeof v.value === 'number' && Number.isFinite(v.value)))) problems.push(`${at}: value must be a finite number or a string`);
    if (typeof v.unit !== 'string') problems.push(`${at}: unit must be a string`);
    if (typeof v.source !== 'string' || v.source.trim() === '') problems.push(`${at}: source must name a URL or a command`);
    if (v.kind !== 'documented' && v.kind !== 'measured') problems.push(`${at}: kind must be "documented" or "measured"`);
    const hasRead = v.readAt !== undefined;
    const hasMeasured = v.measuredAt !== undefined;
    if (!hasRead && !hasMeasured) problems.push(`${at}: readAt or measuredAt is required`);
    if (hasRead && !isIsoDate(v.readAt)) problems.push(`${at}: readAt must be an ISO date`);
    if (hasMeasured && !isIsoDate(v.measuredAt)) problems.push(`${at}: measuredAt must be an ISO date`);
    out[key] = v as DocValue;
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return out;
}

/** The input files: each path given, or each *.json of a folder given, sorted by name. */
export function inputFiles(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const full = resolve(p);
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full).filter((n) => n.endsWith('.json')).sort()) files.push(join(full, f));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** Reads and checks every input file; a key given twice with different content is an error. */
export function readDocValues(files: readonly string[]): DocValues {
  const all: DocValues = {};
  const from: Record<string, string> = {};
  for (const file of files) {
    const values = validateDocValues(JSON.parse(readFileSync(file, 'utf8')), basename(file));
    for (const [key, v] of Object.entries(values)) {
      if (key in all && JSON.stringify(all[key]) !== JSON.stringify(v)) {
        throw new Error(`"${key}" has different values in ${from[key]} and ${basename(file)}`);
      }
      all[key] = v;
      from[key] = basename(file);
    }
  }
  return all;
}

/**
 * facts with docs merged in: a new object whose every key but "docs" is the same value, in the same
 * order. Keys of facts.docs not in `values` stay as they were.
 */
export function mergeDocs(facts: Record<string, unknown>, values: DocValues): Record<string, unknown> {
  const old = facts.docs;
  if (old !== undefined && (old === null || typeof old !== 'object' || Array.isArray(old))) throw new Error('facts.json: "docs" exists and is not an object');
  const docs = { ...((old as Record<string, unknown> | undefined) ?? {}), ...values };
  const sorted = Object.fromEntries(Object.keys(docs).sort().map((k) => [k, docs[k]]));
  return { ...facts, docs: sorted };
}

/** The keys of `values` that facts.docs lacks or holds with other content. */
export function missingDocs(facts: Record<string, unknown>, values: DocValues): string[] {
  const docs = (facts.docs ?? {}) as Record<string, unknown>;
  return Object.keys(values).filter((k) => JSON.stringify(docs[k]) !== JSON.stringify(values[k]));
}

/** facts.json's own layout (the benches write it with two spaces and a final newline). */
export function formatFacts(facts: unknown): string {
  return JSON.stringify(facts, null, 2) + '\n';
}

function readFactsText(path: string): { text: string; facts: Record<string, unknown> } {
  // A bench rewrites facts.json in place; a read during its write may see a partial file.
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    const text = readFileSync(path, 'utf8');
    try {
      const facts = JSON.parse(text) as Record<string, unknown>;
      if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) throw new Error(`${path} is not a JSON object`);
      return { text, facts };
    } catch (e) {
      lastError = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw lastError;
}

/** Writes text to path through a temporary file in the same folder and a rename. */
export function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', statSync(path, { throwIfNoEntry: false })?.mode ?? 0o644);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/**
 * Re-reads facts.json, merges `values` under "docs" and writes it atomically. When the file changed
 * while the new content was being written, it starts again (up to five times). Returns the keys
 * written. Nothing is written when facts.docs already holds every value.
 */
export function writeFactsDocs(factsPath: string, values: DocValues): string[] {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { text, facts } = readFactsText(factsPath);
    const changed = missingDocs(facts, values);
    if (changed.length === 0) return [];
    const next = formatFacts(mergeDocs(facts, values));
    // Compare and swap as closely as a plain file allows: give up this attempt when facts.json moved on.
    if (readFileSync(factsPath, 'utf8') !== text) continue;
    writeAtomic(factsPath, next);
    const after = readFactsText(factsPath).facts;
    if (missingDocs(after, values).length === 0) return changed;
  }
  throw new Error(`${factsPath} kept changing while docs were merged: run again when the training run is between writes`);
}

function main(argv: readonly string[]): number {
  let factsPath = DEFAULT_FACTS;
  let check = false;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--facts') factsPath = resolve(argv[++i] ?? '');
    else if (a === '--check') check = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else paths.push(a);
  }
  if (paths.length === 0) paths.push(DEFAULT_INPUT_DIR);
  const files = inputFiles(paths);
  if (files.length === 0) {
    console.log('facts-docs: no input files');
    return 0;
  }
  const values = readDocValues(files);
  if (check) {
    const missing = missingDocs(readFactsText(factsPath).facts, values);
    if (missing.length) {
      console.error(`facts-docs: ${factsPath} lacks or differs on: ${missing.join(', ')}`);
      return 1;
    }
    console.log(`facts-docs: ${Object.keys(values).length} values in step`);
    return 0;
  }
  const written = writeFactsDocs(factsPath, values);
  console.log(written.length ? `facts-docs: wrote docs.${written.join(', docs.')} to ${factsPath}` : `facts-docs: ${factsPath} already holds every value`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`facts-docs: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
