// Provenance of every generated file of the data page (DATA-SPEC 2.1): which script made it, with
// which command, when, on which machine, from which commit, and the hash of every input. Also the
// paths of the repository and the writer that keeps the files small and readable.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, from this file's place (tools/data/lib), so scripts and tests may run from anywhere. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Where the generated files live: imported by the web client. */
export const OUT_DIR = join(ROOT, 'web', 'src', 'data', 'generated');

/** Absolute path of a repository path. */
export function abs(path: string): string {
  return resolve(ROOT, path);
}

/** Repository path (forward slashes) of an absolute or relative path. */
export function repoPath(path: string): string {
  return relative(ROOT, resolve(ROOT, path)).split('\\').join('/');
}

export function readText(path: string): string {
  return readFileSync(abs(path), 'utf8');
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(abs(path))).digest('hex');
}

/** The commit the working tree started from, read from .git without running git; null when absent. */
export function gitHead(): string | null {
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = join(ROOT, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = join(ROOT, '.git', 'packed-refs');
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

export interface InputHash {
  path: string;
  sha256: string;
}

export interface Provenance {
  script: string;
  command: string;
  measuredAt: string;
  node: string;
  cpu: string;
  commit: string | null;
  inputs: InputHash[];
  [extra: string]: unknown;
}

/** Fields that change from one run to the next without any change in the data. */
export const VOLATILE: readonly string[] = ['command', 'measuredAt', 'node', 'cpu', 'commit', 'seconds', 'threads'];

export function provenance(script: string, inputs: readonly string[], extra: Record<string, unknown> = {}): Provenance {
  const argv = process.argv.slice(2).join(' ');
  return {
    script: repoPath(script),
    command: `docker compose run --rm -T node node ${repoPath(script)}${argv ? ` ${argv}` : ''}`,
    measuredAt: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    commit: gitHead(),
    inputs: [...new Set(inputs.map(repoPath))].sort().map((path) => ({ path, sha256: sha256File(path) })),
    ...extra,
  };
}

/** A copy without the volatile provenance fields and the input hashes, for "regenerate and compare". */
export function stable<T extends { provenance?: Provenance }>(file: T): unknown {
  const copy = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
  const p = copy.provenance as Record<string, unknown> | undefined;
  if (p) {
    for (const k of VOLATILE) delete p[k];
    p.inputs = (p.inputs as InputHash[]).map((i) => i.path);
  }
  return copy;
}

/** True when this module is the script node was started with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return !!entry && resolve(entry) === fileURLToPath(metaUrl);
}

/**
 * JSON with two spaces per level, but arrays of plain values and small objects of plain values on
 * one line, so the files stay short and their diffs readable.
 */
export function formatJson(value: unknown): string {
  const plain = (v: unknown) => v === null || typeof v !== 'object';
  const inline = (v: unknown): boolean => {
    if (plain(v)) return true;
    if (Array.isArray(v)) return v.every(plain);
    const vals = Object.values(v as object);
    return vals.length <= 6 && vals.every(plain);
  };
  const out = (v: unknown, indent: string): string => {
    if (inline(v)) return JSON.stringify(v);
    const next = indent + '  ';
    if (Array.isArray(v)) return `[\n${v.map((x) => next + out(x, next)).join(',\n')}\n${indent}]`;
    const entries = Object.entries(v as object).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${out(x, next)}`).join(',\n')}\n${indent}}`;
  };
  return out(value, '') + '\n';
}

/** Writes web/src/data/generated/<name> and returns its repository path. */
export function writeGenerated(name: string, value: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, name);
  writeFileSync(file, formatJson(value));
  return repoPath(file);
}

/** Reads a generated file, or null when it does not exist yet. */
export function readGenerated<T = unknown>(name: string): T | null {
  const file = join(OUT_DIR, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}
