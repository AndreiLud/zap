// Small helpers shared by the milestone 6 benches: arguments, seeds, model loading, result files
// and the facts.json section ai.adaptation.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseModel, type Model } from '../src/mlp.ts';
import { isSafetyNet } from '../src/safety.ts';
import type { CalibratedKnobs } from '../src/personas.ts';
import type { HeuristicParams } from '../src/heuristic.ts';
import { SEGMENTS, type Segment } from '../src/opponent-stats.ts';

export const V1_MODEL = 'ai/models/bootstrap/zap-v1.zapw';
export const V1_MANIFEST = 'ai/models/bootstrap/manifest.json';
export const TUNED_PARAMS = 'ai/models/heuristic-tuned.json';
export const PRIORS_FILE = 'ai/models/opponent-priors.json';
/** facts.json; ZAP_FACTS points the benches at another file (the smoke run writes to a copy). */
export const FACTS_FILE = process.env.ZAP_FACTS || 'facts.json';

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function numArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`--${name} must be a number`);
  return x;
}

/** Seed flags take two hex characters, repeated to the 64 the engine needs (like '5d'.repeat(32)). */
export function seedArg(name: string, fallback: string): string {
  const s = arg(name, fallback)!;
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  if (!/^[0-9a-f]{2}$/.test(s)) throw new Error(`--${name} takes two hex characters`);
  return s.repeat(32);
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const models = new Map<string, Model>();
/** Parsed models, cached by path. */
export function loadModel(path: string): Model {
  let m = models.get(path);
  if (!m) {
    m = parseModel(readFileSync(path));
    models.set(path, m);
  }
  return m;
}

export function v1Knobs(): CalibratedKnobs {
  return (readJson(V1_MANIFEST).personas ?? {}) as CalibratedKnobs;
}

export function tunedParams(): HeuristicParams {
  const raw = readJson(TUNED_PARAMS);
  return (raw.params ?? raw) as HeuristicParams;
}

/**
 * The run folder a model belongs to: training/runs/<run>/export/x.zapw, .../league/x.zapw and
 * .../current.zapw all give training/runs/<run>.
 */
export function runOf(modelPath: string): string {
  const d = dirname(modelPath);
  const b = basename(d);
  return b === 'export' || b === 'league' ? dirname(d) : d;
}

/** Default result file: <run>/eval/<name>.json. */
export function evalOut(modelPath: string, name: string): string {
  return join(runOf(modelPath), 'eval', `${name}.json`);
}

export function machine(): { cpu: string; node: string } {
  return { cpu: cpus()[0]?.model ?? 'unknown', node: process.version };
}

/** Where a model file came from: its hash and header facts, and the arguments of its training run. */
export interface ModelProvenance {
  path: string;
  sha256: string;
  bytes: number;
  features: string;
  weights: 'f32' | 'i8' | 'mixed';
  iteration: number | null;
  version: string | null;
  adapt: { bmax: number; nHalf: number } | null;
  priorsSha256: string | null;
  /** training/runs/<run>/args.json when present (seeds, regularizer, share of matches without statistics). */
  run: { folder: string; args: Record<string, unknown> | null };
}

export function modelProvenance(path: string): ModelProvenance {
  const m = loadModel(path);
  const meta = (m.header.meta ?? {}) as Record<string, unknown>;
  const layers = [...m.trunk, m.policy, m.value];
  const f32 = layers.filter((l) => l.wf).length;
  const run = runOf(path);
  const argsPath = join(run, 'args.json');
  return {
    path,
    sha256: sha256File(path),
    bytes: readFileSync(path).byteLength,
    features: m.header.features,
    weights: f32 === layers.length ? 'f32' : f32 === 0 ? 'i8' : 'mixed',
    iteration: typeof meta.iteration === 'number' ? meta.iteration : null,
    version: typeof meta.version === 'string' ? meta.version : null,
    adapt: (meta.adapt as ModelProvenance['adapt']) ?? null,
    priorsSha256: typeof meta.priorsSha256 === 'string' ? meta.priorsSha256 : null,
    run: { folder: run, args: existsSync(argsPath) ? readJson<Record<string, unknown>>(argsPath) : null },
  };
}

/** The commit the working tree started from, read from .git without running git (null when absent). */
function gitHead(): string | null {
  try {
    const head = readFileSync('.git/HEAD', 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    if (existsSync(join('.git', ref))) return readFileSync(join('.git', ref), 'utf8').trim();
    const packed = existsSync('.git/packed-refs') ? readFileSync('.git/packed-refs', 'utf8') : '';
    return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Provenance block for a result file: every model by role, the command line, the commit and the
 * time. The working tree may differ from that commit; the model hashes are what tie a number to
 * the files that produced it.
 */
export function provenance(models: Record<string, string>): { models: Record<string, ModelProvenance>; argv: string[]; gitHead: string | null; at: string } {
  return {
    models: Object.fromEntries(Object.entries(models).map(([role, p]) => [role, modelProvenance(p)])),
    argv: process.argv.slice(2),
    gitHead: gitHead(),
    at: new Date().toISOString(),
  };
}

/** Short form for facts.json values: role to model path and sha256. */
export function modelHashes(models: Record<string, string>): Record<string, { path: string; sha256: string }> {
  return Object.fromEntries(Object.entries(models).map(([role, p]) => [role, { path: p, sha256: sha256File(p) }]));
}

/**
 * The benches that measure the adaptive network as served need the safety net in the file
 * (meta.adapt): without it a v2 model plays the raw network, which is not what the room plays.
 */
export function requireSafetyNet(path: string): void {
  const m = loadModel(path);
  if (m.header.features === 'v2' && !isSafetyNet(m.header.meta?.adapt)) {
    throw new Error(`${path} has no safety net (meta.adapt): export it with --adapt bmax,nHalf first`);
  }
}

export { SEGMENTS, type Segment };

export function segmentConfig(seg: Segment): { variant: 'paulista' | 'mineiro'; players: 2 | 4 } {
  const [variant, players] = seg.split('-');
  return { variant: variant as 'paulista' | 'mineiro', players: Number(players) as 2 | 4 };
}

/** Keys whose `rows` come from several benches and are merged row by row. */
const ROW_KEYS = new Set(['headToHead']);

/**
 * Child keys another bench writes inside a key ("explorer.trained", "explorer.criterion" and "explorer.control" from
 * ai/bench/explorer-trained.ts, "explorer.netTightening" from ai/bench/explorer-tightening.ts):
 * a full write of the parent (ai/bench/explorer.ts --stage fresh) keeps them.
 */
const CHILD_KEYS: Record<string, readonly string[]> = { explorer: ['trained', 'criterion', 'control', 'netTightening'] };

/** SHA-256 of the adaptive file a facts value measured (models.adaptive.sha256), or null. */
export function adaptiveShaOf(v: unknown): string | null {
  const sha = v && typeof v === 'object' ? (v as { models?: { adaptive?: { sha256?: unknown } } }).models?.adaptive?.sha256 : undefined;
  return typeof sha === 'string' ? sha : null;
}

/**
 * Keeps a value about an earlier adaptive file before a value about another file replaces it:
 * ai.adaptation.history[<sha256>] = { model: { path, sha256 }, keys: { <key>: value } }, the way
 * ai/bench/criterion.ts keeps the verdicts measured against earlier files. One value per file and
 * key: a later move of the same key for the same file replaces it.
 */
function keepHistory(adaptation: Record<string, any>, key: string, old: Record<string, any>): void {
  const sha = adaptiveShaOf(old)!;
  const history = (adaptation.history ??= {});
  const entry = (history[sha] ??= { model: { path: old.models.adaptive.path ?? null, sha256: sha }, keys: {} });
  entry.keys[key] = { ...old, keptAt: new Date().toISOString() };
}

/**
 * Writes one key of facts.json under ai.adaptation. Every value carries measuredAt and method.
 * For headToHead, rows already there from another bench are kept. A key "parent.child" writes only
 * that child of the parent (one of CHILD_KEYS), and a full write of the parent keeps its children.
 * Values carry the adaptive file they measured (models.adaptive.sha256). When the value already
 * there measured another adaptive file, it moves to ai.adaptation.history (keepHistory) instead of
 * being lost, with its children; rows and children about the other file are not carried into the
 * new value. Only one bench writes at a time (see the runbook).
 */
export function writeAdaptationFacts(key: string, value: Record<string, unknown>, path = FACTS_FILE): void {
  if (typeof value.method !== 'string' || !value.measuredAt) throw new Error(`facts ${key}: method and measuredAt are required`);
  const facts = existsSync(path) ? readJson<Record<string, any>>(path) : {};
  facts.ai ??= {};
  facts.ai.adaptation ??= {};
  const ad = facts.ai.adaptation;
  const newSha = adaptiveShaOf(value);
  /** The old value measured another adaptive file than the new one. */
  const otherFile = (old: unknown) => newSha !== null && adaptiveShaOf(old) !== null && adaptiveShaOf(old) !== newSha;
  const [parent, child, ...rest] = key.split('.');
  if (parent === 'history') throw new Error('facts history: written only by moving a replaced value');
  if (child !== undefined) {
    if (rest.length || !CHILD_KEYS[parent]?.includes(child)) throw new Error(`facts ${key}: unknown child key`);
    const p = ad[parent];
    if (p && typeof p === 'object' && otherFile(p[child])) keepHistory(ad, key, p[child]);
    ad[parent] = { ...(p && typeof p === 'object' ? p : {}), [child]: value };
  } else {
    const old = ad[key];
    if (old && typeof old === 'object' && otherFile(old)) {
      keepHistory(ad, key, old);
    } else {
      if (ROW_KEYS.has(key) && old && typeof old === 'object' && old.rows && value.rows) {
        value = { ...value, rows: { ...old.rows, ...(value.rows as object) } };
      }
      if (old && typeof old === 'object') for (const c of CHILD_KEYS[key] ?? []) if (old[c] !== undefined && value[c] === undefined) value = { ...value, [c]: old[c] };
    }
    ad[key] = value;
  }
  writeFileSync(path, JSON.stringify(facts, null, 2) + '\n');
}

/**
 * A result file under <run>/eval/: whatever the bench reports, plus `facts`, the values for
 * facts.json ai.adaptation by key. ai/bench/adaptation-facts.ts merges these files.
 */
export interface FactsResult {
  facts: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/** Writes a result file and, with --write-facts, its facts. */
export function saveResult(path: string, result: FactsResult, writeFacts: boolean): void {
  writeJson(path, result);
  if (writeFacts) for (const [k, v] of Object.entries(result.facts)) writeAdaptationFacts(k, v);
}

export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/** Rounds every number in a JSON-like value to `digits` significant decimals, for result files people read. */
export function round(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
