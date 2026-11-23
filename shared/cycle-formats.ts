// Every JSON format shared by the Worker and the training cycle (milestone 6), with exact-key
// validators. The contract is _local/m6/CONTRACT.md section 1; training/cycle/zapcycle/formats.py
// mirrors these checks, and tests/fixtures/cycle/ holds files both sides must accept or refuse.
//
// Rules common to every format:
// * every object has exactly its keys (an unknown or a missing key is an error);
// * null only where a type below says so;
// * times are integer ms since 1970 UTC (`ms`), dates are UTC "YYYY-MM-DD";
// * a version id matches VERSION_ID; a version label (records, summaries) matches AI_VERSION_LABEL;
// * SHA-256 values are 64 lowercase hex characters;
// * sizes are checked before parsing (LIMITS).
//
// This file imports no node:* module and uses no Node global: the Worker bundles it and both
// TypeScript projects compile it.

import { PERSONAS, type CalibratedKnobs, type PersonaId } from '../ai/src/personas.ts';
import { NEUTRAL_KNOBS } from '../ai/src/net-agent.ts';
import { PERSONA_DIMS } from '../ai/src/features.ts';
import { BASE_PARAMS } from '../ai/src/heuristic.ts';
import { SEGMENTS, validatePriors, type Segment } from '../ai/src/opponent-stats.ts';

// -----------------------------------------------------------------------------------------------
// Constants

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const SCHEMAS = {
  manifest: 'zap-manifest/1',
  card: 'zap-card/1',
  gate: 'zap-gate/1',
  status: 'zap-status/1',
  export: 'zap-export/1',
  receipt: 'zap-receipt/1',
  priors: 'zap-priors/1',
  flags: 'zap-flags/1',
  summary: 'zap-summary/1',
  /** summary.json since milestone 7; validateSummary accepts both, normalizeSummary gives a /2 view. */
  summary2: 'zap-summary/2',
  reading: 'zap-reading/1',
} as const;

const KB = 1024;
/** Largest body accepted for each format, in bytes, checked before parsing. */
export const LIMITS = {
  record: 256 * KB,
  manifest: 256 * KB,
  card: 1024 * KB,
  status: 16 * KB,
  export: 100 * KB * KB,
  receipt: 1024 * KB,
  priors: 64 * KB,
  flags: 512 * KB,
  summary: 1024 * KB,
  model: 2_097_152,
} as const;
export type LimitKind = keyof typeof LIMITS;

export const BUCKETS = { events: 'zap-events', models: 'zap-models', public: 'zap-public' } as const;
export const MANIFEST_KEY = 'manifest.json';
export const STATUS_KEY = 'status/training.json';
export const PRIORS_KEY = 'control/priors.json';
export const FLAGS_KEY = 'control/flags.json';
export const SUMMARY_KEY = 'summary.json';
export const EXPORTS_PREFIX = 'exports/';
export const RECEIPTS_PREFIX = 'receipts/';
export const MODELS_PREFIX = 'models/';
export const CARDS_PREFIX = 'cards/';
export const exportKey = (date: string): string => `${EXPORTS_PREFIX}${date}.json`;
export const receiptKey = (date: string): string => `${RECEIPTS_PREFIX}${date}.json`;
export const modelKey = (v: string): string => `${MODELS_PREFIX}${v}.zapw`;
export const cardKey = (v: string): string => `${CARDS_PREFIX}${v}.json`;

/** Manifest cache in the rooms (MANIFEST_TTL_S may shorten it only on a test site). */
export const MANIFEST_TTL_MS = 300_000;
/** The Worker alerts when status/training.json was not updated for longer than this. */
export const STALE_STATUS_MS = 8 * 86_400_000;
export const EXPORT_KEEP_DAYS = 7;
export const RECEIPT_KEEP_DAYS = 30;
/** A number built from human data appears only for a cell with at least this many people. */
export const MIN_PEOPLE = 20;
export const MAX_MODELS = 500;
export const MAX_FLAG_OPS = 5000;
export const FLAG_OP_MAX_AGE_MS = 400 * 86_400_000;
export const MAX_REASON_CHARS = 500;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_ERROR_CHARS = 200;
export const MAX_EVIDENCE_CHARS = 200;

export const VERSION_ID = /^v[1-9][0-9]{0,5}$/;
/** Version labels in records and pages: a version id, "heuristic", or any older label (shared/match-record.ts). */
export const AI_VERSION_LABEL = /^[A-Za-z0-9._:-]{1,40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const CYCLE_ID = /^\d{8}-\d{4}$/;
export const GROUP = /^[0-9a-f]{16}$/;
export const FLAG_REF = /^\d{4}-\d{2}-\d{2}:[0-9a-f]{16}$/;
export const ISO_WEEK = /^\d{4}-W\d{2}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Flag evidence: printable ASCII, numbers and words with plain punctuation, nothing that could hold a name. */
export const EVIDENCE = /^[A-Za-z0-9 .,:;=%()/+_-]{0,200}$/;

export const READING_KEYS = ['raise', 'run', 'accept', 'reraise', 'shown', 'cover', 'bluff', 'signalTruth'] as const;
export type ReadingKey = (typeof READING_KEYS)[number];
export const LAYER_KEYS = ['humanModel', 'priors', 'adaptation', 'playerTypes', 'ranking', 'openData', 'flags'] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];
export const RECEIPT_JOBS = ['retention', 'calls', 'flags', 'priors', 'export', 'alert'] as const;
export type ReceiptJob = (typeof RECEIPT_JOBS)[number];
export const FLAG_REASONS = ['regular-times', 'around-the-clock', 'volume', 'identical-sequences'] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];
export const REPORT_REASONS = ['nickname', 'phrases', 'cheating', 'other'] as const;
export const CARD_RESULTS = ['bootstrap', 'promoted', 'rejected', 'rolled-back'] as const;
export type CardResult = (typeof CARD_RESULTS)[number];
export const STATUS_STEPS = ['sync', 'build', 'human', 'train', 'gate', 'publish', 'ab', 'idle'] as const;
export type StatusStep = (typeof STATUS_STEPS)[number];
export const ALERT_REASONS = ['failed', 'stale', 'missing'] as const;
export type AlertReason = (typeof ALERT_REASONS)[number];
export const FEATURES = ['v1', 'v2', 'v2-empty'] as const;
export const PANEL_ANCHORS = ['random', 'base', 'tuned', 'v1'] as const;
export { SEGMENTS, type Segment };

const PERSONA_IDS = PERSONAS.map((p) => p.id) as readonly string[];
const KNOB_KEYS = Object.keys(NEUTRAL_KNOBS);
const STYLE_KEYS = Object.keys(BASE_PARAMS);

/** UTC date of a time in ms. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Cycle id of a start time: UTC "YYYYMMDD-HHMM". */
export function cycleIdOf(ms: number): string {
  const s = new Date(ms).toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}`;
}

/** The number of a version id ("v12" is 12), or 0 for anything else. */
export function versionNumber(v: string): number {
  return VERSION_ID.test(v) ? Number(v.slice(1)) : 0;
}

/** The next version id after every id given (manifest keys and card keys): numbers are never reused. */
export function nextVersion(ids: Iterable<string>): string {
  let max = 0;
  for (const v of ids) max = Math.max(max, versionNumber(v));
  return `v${max + 1}`;
}

/** Whether a UTF-8 body of this many bytes may be parsed as this format. */
export function withinLimit(kind: LimitKind, bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= LIMITS[kind];
}

/** Size check, JSON parse and validation in one step, for text read from storage. */
export function parseChecked<T>(kind: Exclude<LimitKind, 'model'>, body: string, validate: (json: unknown) => Checked<T>): Checked<T> {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (!withinLimit(kind, bytes)) return { ok: false, errors: [`${kind}: ${bytes} bytes, over ${LIMITS[kind]}`] };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, errors: [`${kind}: not JSON`] };
  }
  return validate(json);
}

// -----------------------------------------------------------------------------------------------
// Types

export type VersionId = string;

/** The versions one match plays (pinned at its start; worker/src/ai-select.ts pick). */
export interface MatchAi {
  /** The version on AI seats that face people. */
  opponents: string;
  /** The version on AI seats whose partner is a person, and of the AI that plays for a person. */
  partners: string;
  arm: 'candidate' | 'control' | null;
}

export interface AdaptEntry {
  bmax: number;
  nHalf: number;
}

export interface ModelInfo {
  sha256: string;
  bytes: number;
  arch: 'mlp-v1';
  features: (typeof FEATURES)[number];
  inputs: number;
  hidden: number[];
  /** Required for features "v2" (the safety net), null otherwise; equals the file's meta.adapt. */
  adapt: AdaptEntry | null;
}

export interface ModelEntry extends ModelInfo {
  personas: CalibratedKnobs;
  createdAt: number;
}

export interface Manifest {
  schema: typeof SCHEMAS.manifest;
  current: VersionId;
  control: VersionId | null;
  controlShare: number;
  controlUntil: number | null;
  updatedAt: number;
  models: Record<VersionId, ModelEntry>;
}

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
}

export interface PairsInterval extends Interval {
  pairs: number;
}

export interface GateResult {
  schema: typeof SCHEMAS.gate;
  candidate: { version: VersionId; sha256: string };
  current: { version: VersionId; sha256: string };
  seed: string;
  stats: 'empty' | 'live';
  sprt: {
    decision: 'accept' | 'reject' | 'inconclusive';
    llr: number;
    lower: number;
    upper: number;
    pairs: number;
    mean: number;
    perSegment: Record<Segment, { pairs: number; mean: number }>;
  };
  segments: Record<Segment, { pairs: number; mean: number; lo95: number; pass: boolean }>;
  panel: { member: string; pairs: number; candidate: Interval; current: Interval; diff: { mean: number; lo95: number }; pass: boolean }[];
  personas: { orderHolds: boolean; source: string };
  pass: boolean;
  reasons: string[];
  seconds: number;
}

/** Human A/B window result. drop, lo, hi and detectablePoints are null until both arms have 20 people; people is null below 20 in all. */
export interface AbResult {
  from: number;
  until: number;
  matches: { candidate: number; control: number };
  people: number | null;
  drop: number | null;
  lo: number | null;
  hi: number | null;
  detectablePoints: number | null;
  rolledBack: boolean;
}

export interface Card {
  schema: typeof SCHEMAS.card;
  version: VersionId;
  parent: VersionId | null;
  cycleId: string | null;
  createdAt: number;
  result: CardResult;
  resultAt: number;
  reason: string;
  model: ModelInfo;
  training: {
    args: string[];
    iterations: number;
    seconds: number;
    seedBase: string;
    leagueFiles: string[];
    humanModel: { sha256: string; pass: boolean } | null;
    commit: string | null;
  } | null;
  data: {
    records: number;
    valid: number;
    invalid: number;
    test: number;
    validMatches: number;
    linkedSeats: number;
    people: number | null;
    recordsSha256: string;
    exportDate: string | null;
    exportSha256: string | null;
    excluded: { unlinked: number; flagged: number; friends: number; auto: number; forced: number; capped: number };
  } | null;
  gate: GateResult | null;
  personas: {
    knobsSha256: string;
    orderHolds: boolean;
    stats: Partial<Record<PersonaId, { trucoRate: number; bluffRate: number; runRate: number; reraiseRate: number; signalTruth: number; vsZap: number }>>;
  } | null;
  /**
   * seedFloor: twin against a second twin with the seed base plus 1, measured in cycle
   * seedFloorCycle (this cycle, or an earlier one whose floor is carried); seedNoise: how far the
   * floors measured so far sit from 0.5 (root mean square), over `floors` of them.
   */
  twin: { sha256: string; headToHead: PairsInterval; seedFloor: PairsInterval | null; seedFloorCycle: string | null; seedNoise: { floors: number; rms: number } | null } | null;
  ab: AbResult | null;
  /** Only on cards of files that can read the in-match statistics (features v2 with a safety net). */
  explorer?: CardExplorer;
}

export const EXPLORER_KINDS = ['scripted', 'trained', 'control'] as const;
export const EXPLORER_SOURCES = ['measured', 'reused', 'none'] as const;
/** The owner's 1 point: no explorer may gain more from the reading (training/cycle/zapcycle/explorer.py LIMIT_MAX). */
export const EXPLORER_LIMIT_MAX = 0.01;

/**
 * The explorer test of a candidate that can read (training/cycle/zapcycle/explorer.py): every
 * verdict that counts (one-sided 95% upper bound of the adaptation part, at most `limit` to pass),
 * the explorers on record as failing against an earlier file, those of them still without a verdict
 * against this network (pending), and why it failed. source: measured by this cycle, reused from a
 * passing verdict for the same network (with the explorers recorded after it measured again), or
 * none when the step did not run. Optional, added in milestone 10 (cards written before have none):
 * measuredOnRecord, the explorers on record that never failed (every one is measured again for a
 * new network); settings, the [explorer] values the step ran with; ppo, the iterations the PPO
 * explorer reached and the ones it needed; lifted, the owner's lift of an earlier failure of this
 * very network (training/cycle/zapcycle/explorer.py LIFT_FLAG).
 */
export interface CardExplorer {
  network: string;
  sha256: string;
  pass: boolean;
  limit: number;
  source: (typeof EXPLORER_SOURCES)[number];
  reusedFrom: { source: string; sha256: string; at: number } | null;
  verdicts: { explorer: string; kind: (typeof EXPLORER_KINDS)[number]; sha256: string; mean: number; upper95: number; pairs: number; pass: boolean }[];
  failuresOnRecord: string[];
  pending: string[];
  reasons: string[];
  measuredOnRecord?: string[];
  settings?: Record<string, string | number | boolean>;
  ppo?: { iterations: number; wanted: number } | null;
  lifted?: { reason: string; at: number; failedIn: string[] } | null;
}

/** The optional fields of card.explorer (CardExplorer). */
export const EXPLORER_OPTIONAL = ['measuredOnRecord', 'settings', 'ppo', 'lifted'] as const;

export interface TrainingStatus {
  schema: typeof SCHEMAS.status;
  state: 'ok' | 'running' | 'failed';
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  cycleId: string | null;
  step: StatusStep;
  lastPromotion: { version: VersionId; at: number } | null;
  message: string;
}

export interface ExportRow {
  matchId: string;
  seat: number;
  weight: number;
  flagged: boolean;
  openDataOptOut: boolean;
  noAdapt: boolean;
  group: string;
}

export interface ExportReport {
  id: number;
  day: string;
  reason: (typeof REPORT_REASONS)[number];
  matchId: string | null;
  seat: number;
  group: string | null;
}

export interface ExportFile {
  schema: typeof SCHEMAS.export;
  date: string;
  createdAt: number;
  partial: boolean;
  rows: ExportRow[];
  reports: ExportReport[];
}

export type JobStatus = 'ok' | 'off' | 'skipped' | 'failed';
interface JobBase {
  status: JobStatus;
  error: string | null;
}
export interface ReceiptJobs {
  retention: JobBase & { counts: { devices: number; reports: number; flags: number; rooms: number; members: number; calls: number; exportGroups: number; profiles: number } };
  calls: JobBase & { delivered: number };
  flags: JobBase & { sha256: string | null; applied: string[]; ignored: string[]; unresolved: string[]; reviewed: string[] };
  priors: JobBase & { sha256: string | null; imported: boolean };
  export: JobBase & { key: string | null; rows: number; reports: number; partial: boolean; sha256: string | null };
  alert: JobBase & { sent: boolean; reason: AlertReason | null };
}

export interface Receipt {
  schema: typeof SCHEMAS.receipt;
  date: string;
  createdAt: number;
  jobs: ReceiptJobs;
}

export interface PriorsFile {
  schema: typeof SCHEMAS.priors;
  createdAt: number;
  source: 'selfplay' | 'people';
  people: number | null;
  /** people: how many people the number came from, null when it keeps the self-play value. */
  numbers: Record<ReadingKey, { mean: number; strength: number; people: number | null }>;
  time: { mu: number; tau: number; sigma: number };
  alpha: number;
  segments: Record<Segment, { raise: number; run: number; accept: number; reraise: number; shown: number; cover: number }>;
  /** Per rules segment values of the reading numbers the in-match priors do not carry (bluff). */
  readingSegments: Record<Segment, { bluff: number }>;
}

export type FlagOp = { ref: string; op: 'flag'; reason: FlagReason; evidence: string; at: number } | { ref: string; op: 'confirm' | 'clear'; at: number };

export interface FlagsFile {
  schema: typeof SCHEMAS.flags;
  createdAt: number;
  ops: FlagOp[];
}

export interface Layer {
  on: boolean;
  why: string;
  /** Match counts and people counts; a people count under MIN_PEOPLE is null. */
  progress: Record<string, number | null>;
}

export interface Summary {
  schema: typeof SCHEMAS.summary;
  generatedAt: number;
  minPeople: typeof MIN_PEOPLE;
  training: { state: TrainingStatus['state']; finishedAt: number | null; current: VersionId; nextAfter: number | null };
  humansVsZap: { matches: number; humanWins: number; since: number | null };
  versions: { version: VersionId; promotedAt: number; result: CardResult; anchors: Record<(typeof PANEL_ANCHORS)[number], Interval> | null }[];
  ab: {
    version: VersionId;
    control: VersionId;
    share: number;
    from: number;
    until: number;
    detectablePoints: number | null;
    result: { drop: number; lo: number; hi: number } | null;
  } | null;
  layers: Record<LayerKey, Layer>;
  cells: { week: string; variant: 'paulista' | 'mineiro'; players: 2 | 4; people: number; matches: number; humanWinRate: number }[];
  playerTypes: { k: number; ari: number; types: { share: number; center: Record<ReadingKey, number> }[] } | null;
}

/** The statistics of one character (Card['personas'].stats). */
export type PersonaStats = { trucoRate: number; bluffRate: number; runRate: number; reraiseRate: number; signalTruth: number; vsZap: number };
export const PERSONA_STAT_KEYS = ['trucoRate', 'bluffRate', 'runRate', 'reraiseRate', 'signalTruth', 'vsZap'] as const;
export const DISAGREEMENT_TYPES = ['answer', 'onze', 'bet', 'card'] as const;

/** One served version in zap-summary/2: the /1 entry plus what the data page reads from its card. */
export interface SummaryVersionV2 {
  version: VersionId;
  promotedAt: number;
  result: CardResult;
  anchors: Record<(typeof PANEL_ANCHORS)[number], Interval> | null;
  /** card.twin.headToHead: this version against its twin (the same training without people's games). */
  twin: PairsInterval | null;
  /** card.personas.stats with the duplicate pairs behind each vsZap (all segments pooled). */
  personas: { pairs: number; stats: Partial<Record<PersonaId, PersonaStats>> } | null;
  /** card.data: valid matches with people in its training data; people null under MIN_PEOPLE. */
  data: { validMatches: number; people: number | null } | null;
}

/**
 * People against Zap by mode (kinds solo1 and solo2), the version facing them and, in 2 against 2,
 * the version of their AI partner (null in 1 against 1). A row only with MIN_PEOPLE people or more.
 */
export interface ScoreboardRow {
  variant: 'paulista' | 'mineiro';
  players: 2 | 4;
  aiVersion: string;
  partnerVersion: string | null;
  people: number;
  matches: number;
  humanWins: number;
}

/**
 * summary.json since milestone 7 (_local/m7/DATA-SPEC.md 2.2.3). Every field of zap-summary/1 with
 * a wider version entry, plus the seed noise of the twin comparison, the scoreboard by mode and a
 * place reserved for the human layer's disagreements (null until that layer exists).
 */
export interface SummaryV2 extends Omit<Summary, 'schema' | 'versions'> {
  schema: typeof SCHEMAS.summary2;
  versions: SummaryVersionV2[];
  /** card.twin.seedNoise of the newest card that has it. */
  seedNoise: { floors: number; rms: number } | null;
  scoreboard: ScoreboardRow[];
  disagreements: { types: { type: (typeof DISAGREEMENT_TYPES)[number]; people: number; decisions: number; share: number }[] } | null;
}

/** Either schema of summary.json, as validateSummary accepts it. */
export type AnySummary = Summary | SummaryV2;

/**
 * normalizeSummary(s): the zap-summary/2 view of either schema. It lives in shared/summary-view.ts,
 * which imports types only, so the pages use it without this module's AI imports.
 */
export { normalizeSummary } from './summary-view.ts';

/** "How Zap reads you" (GET /api/me/reading); the math is shared/profile.ts readProfile. */
export interface Reading {
  schema: typeof SCHEMAS.reading;
  generatedAt: number;
  noAdapt: boolean;
  matches: number;
  decisions: number;
  priors: 'selfplay' | 'people';
  /** source: where the population value of the number comes from (numbers[k].people of the priors). */
  numbers: { key: ReadingKey; n: number; shown: boolean; value: number | null; low: number | null; high: number | null; population: number; source: 'selfplay' | 'people' }[];
  time: { n: number; shown: boolean; medianMs: number | null; lowMs: number | null; highMs: number | null };
}

// -----------------------------------------------------------------------------------------------
// Checking helpers

type R = Record<string, unknown>;

class Check {
  readonly errors: string[] = [];
  fail(path: string, what: string): false {
    this.errors.push(`${path}: ${what}`);
    return false;
  }
  /** An object with exactly these keys (each missing or extra key is reported). */
  obj(x: unknown, path: string, keys: readonly string[]): x is R {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return this.fail(path, 'not an object');
    let ok = true;
    for (const k of Object.keys(x)) if (!keys.includes(k)) ok = this.fail(path, `unexpected field ${k}`);
    for (const k of keys) if (!(k in x)) ok = this.fail(path, `missing field ${k}`);
    return ok;
  }
  /** A plain object whose keys are checked by the caller. */
  map(x: unknown, path: string): x is R {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return this.fail(path, 'not an object');
    return true;
  }
  arr(x: unknown, path: string, max = Infinity): x is unknown[] {
    if (!Array.isArray(x)) return this.fail(path, 'not an array');
    if (x.length > max) return this.fail(path, `more than ${max} entries`);
    return true;
  }
  lit(x: unknown, path: string, value: unknown): boolean {
    return x === value || this.fail(path, `must be ${JSON.stringify(value)}`);
  }
  oneOf(x: unknown, path: string, values: readonly unknown[]): boolean {
    return values.includes(x) || this.fail(path, `must be one of ${values.join(', ')}`);
  }
  bool(x: unknown, path: string): x is boolean {
    return typeof x === 'boolean' || this.fail(path, 'not a boolean');
  }
  num(x: unknown, path: string, lo = -Infinity, hi = Infinity): x is number {
    if (typeof x !== 'number' || !Number.isFinite(x)) return this.fail(path, 'not a finite number');
    if (x < lo || x > hi) return this.fail(path, `out of range ${lo} to ${hi}`);
    return true;
  }
  int(x: unknown, path: string, lo = 0, hi = Number.MAX_SAFE_INTEGER): x is number {
    if (!Number.isSafeInteger(x)) return this.fail(path, 'not an integer');
    if ((x as number) < lo || (x as number) > hi) return this.fail(path, `out of range ${lo} to ${hi}`);
    return true;
  }
  ms(x: unknown, path: string): x is number {
    return this.int(x, path, 0, 8.64e15);
  }
  str(x: unknown, path: string, re?: RegExp, maxChars = Infinity): x is string {
    if (typeof x !== 'string') return this.fail(path, 'not a string');
    if (x.length > maxChars) return this.fail(path, `longer than ${maxChars} characters`);
    if (re && !re.test(x)) return this.fail(path, `does not match ${re.source}`);
    return true;
  }
  date(x: unknown, path: string): x is string {
    if (!this.str(x, path, DATE)) return false;
    const d = new Date(`${x}T00:00:00Z`);
    return (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === x) || this.fail(path, 'not a calendar date');
  }
  /** Plain text: no control characters. */
  text(x: unknown, path: string, maxChars: number): x is string {
    if (!this.str(x, path, undefined, maxChars)) return false;
    return !/[\u0000-\u001f\u007f]/.test(x) || this.fail(path, 'control characters');
  }
  nullable<T>(x: unknown, path: string, f: (x: unknown, path: string) => T): T | true {
    return x === null ? true : f(x, path);
  }
  result<T>(value: unknown): Checked<T> {
    return this.errors.length ? { ok: false, errors: this.errors } : { ok: true, value: value as T };
  }
}

function checkAdapt(c: Check, x: unknown, path: string): void {
  if (x === null) return;
  if (!c.obj(x, path, ['bmax', 'nHalf'])) return;
  if (c.num(x.bmax, `${path}.bmax`) && x.bmax <= 0) c.fail(`${path}.bmax`, 'must be positive');
  if (c.num(x.nHalf, `${path}.nHalf`) && x.nHalf <= 0) c.fail(`${path}.nHalf`, 'must be positive');
}

/** Every number anywhere inside is finite. */
function allFinite(c: Check, x: unknown, path: string): void {
  if (typeof x === 'number') c.num(x, path);
  else if (Array.isArray(x)) x.forEach((v, i) => allFinite(c, v, `${path}[${i}]`));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) allFinite(c, v, `${path}.${k}`);
}

function checkStyle(c: Check, x: unknown, path: string): void {
  if (!c.obj(x, path, STYLE_KEYS)) return;
  for (const k of STYLE_KEYS) {
    const v = x[k];
    if (Array.isArray(v)) v.forEach((n, i) => c.num(n, `${path}.${k}[${i}]`));
    else c.num(v, `${path}.${k}`);
  }
}

/**
 * Ranges of the persona knobs a manifest may carry. A temperature of 0 makes the network's choice
 * NaN and a negative one plays the least likely action; a lie share or a style share outside 0 to 1
 * means nothing; a logit offset or a persona input far out of range drowns the network.
 */
export const KNOB_RANGES = {
  temperature: [0.05, 10],
  raise: [-20, 20],
  accept: [-20, 20],
  run: [-20, 20],
  cover: [-20, 20],
  bluff: [-20, 20],
  signalLie: [0, 1],
  styleShare: [0, 1],
  persona: [-10, 10],
} as const;

/** CalibratedKnobs (ai/src/personas.ts): keys among the persona ids, each a full Knobs with numbers in KNOB_RANGES. */
function checkPersonas(c: Check, x: unknown, path: string): void {
  if (!c.map(x, path)) return;
  for (const [id, k] of Object.entries(x)) {
    const p = `${path}.${id}`;
    if (!PERSONA_IDS.includes(id)) {
      c.fail(path, `unknown persona ${id}`);
      continue;
    }
    if (!c.obj(k, p, KNOB_KEYS)) continue;
    for (const key of ['temperature', 'raise', 'accept', 'run', 'cover', 'bluff', 'signalLie', 'styleShare'] as const) c.num(k[key], `${p}.${key}`, KNOB_RANGES[key][0], KNOB_RANGES[key][1]);
    if (k.style !== null) checkStyle(c, k.style, `${p}.style`);
    if (k.switchStyles !== null && c.arr(k.switchStyles, `${p}.switchStyles`)) k.switchStyles.forEach((s, i) => checkStyle(c, s, `${p}.switchStyles[${i}]`));
    if (c.arr(k.persona, `${p}.persona`, PERSONA_DIMS)) k.persona.forEach((n, i) => c.num(n, `${p}.persona[${i}]`, KNOB_RANGES.persona[0], KNOB_RANGES.persona[1]));
    allFinite(c, k, p);
  }
}

const MODEL_INFO_KEYS = ['sha256', 'bytes', 'arch', 'features', 'inputs', 'hidden', 'adapt'] as const;

function checkModelInfo(c: Check, x: R, path: string): void {
  c.str(x.sha256, `${path}.sha256`, SHA256);
  c.int(x.bytes, `${path}.bytes`, 1, LIMITS.model);
  c.lit(x.arch, `${path}.arch`, 'mlp-v1');
  c.oneOf(x.features, `${path}.features`, FEATURES);
  c.int(x.inputs, `${path}.inputs`, 1, 1_000_000);
  if (c.arr(x.hidden, `${path}.hidden`, 16)) {
    if (x.hidden.length === 0) c.fail(`${path}.hidden`, 'empty');
    x.hidden.forEach((h, i) => c.int(h, `${path}.hidden[${i}]`, 1, 1_000_000));
  }
  checkAdapt(c, x.adapt, `${path}.adapt`);
  if (x.features === 'v2' && x.adapt === null) c.fail(`${path}.adapt`, 'required for features v2');
  if (x.features !== 'v2' && x.adapt !== null) c.fail(`${path}.adapt`, 'only for features v2');
}

// -----------------------------------------------------------------------------------------------
// Validators

/** manifest.json in zap-models (1.3). */
export function validateManifest(json: unknown): Checked<Manifest> {
  const c = new Check();
  if (!c.obj(json, 'manifest', ['schema', 'current', 'control', 'controlShare', 'controlUntil', 'updatedAt', 'models'])) return c.result(json);
  const m = json;
  c.lit(m.schema, 'schema', SCHEMAS.manifest);
  c.str(m.current, 'current', VERSION_ID);
  if (m.control !== null) c.str(m.control, 'control', VERSION_ID);
  c.num(m.controlShare, 'controlShare', 0, 0.5);
  if (m.controlUntil !== null) c.ms(m.controlUntil, 'controlUntil');
  if ((m.control === null) !== (m.controlUntil === null)) c.fail('controlUntil', 'null exactly when control is null');
  c.ms(m.updatedAt, 'updatedAt');
  if (c.map(m.models, 'models')) {
    const ids = Object.keys(m.models);
    if (ids.length < 1 || ids.length > MAX_MODELS) c.fail('models', `from 1 to ${MAX_MODELS} entries`);
    for (const id of ids) {
      const p = `models.${id}`;
      if (!VERSION_ID.test(id)) c.fail('models', `bad version id ${id}`);
      const e = m.models[id];
      if (!c.obj(e, p, [...MODEL_INFO_KEYS, 'personas', 'createdAt'])) continue;
      checkModelInfo(c, e, p);
      checkPersonas(c, e.personas, `${p}.personas`);
      c.ms(e.createdAt, `${p}.createdAt`);
    }
    if (typeof m.current === 'string' && !(m.current in m.models)) c.fail('current', 'not a key of models');
    if (typeof m.control === 'string' && !(m.control in m.models)) c.fail('control', 'not a key of models');
  }
  if (m.control !== null && m.control === m.current) c.fail('control', 'equals current');
  return c.result(json);
}

function checkInterval(c: Check, x: unknown, path: string, pairs = false): void {
  if (!c.obj(x, path, pairs ? ['pairs', 'mean', 'lo', 'hi'] : ['mean', 'lo', 'hi'])) return;
  if (pairs) c.int(x.pairs, `${path}.pairs`);
  c.num(x.mean, `${path}.mean`);
  c.num(x.lo, `${path}.lo`);
  c.num(x.hi, `${path}.hi`);
  if (typeof x.lo === 'number' && typeof x.hi === 'number' && x.lo > x.hi) c.fail(path, 'lo above hi');
}

function checkSegmentsMap(c: Check, x: unknown, path: string, each: (v: unknown, p: string) => void): void {
  if (!c.obj(x, path, SEGMENTS)) return;
  for (const s of SEGMENTS) each(x[s], `${path}.${s}`);
}

function checkGate(c: Check, g: unknown, path: string): void {
  if (!c.obj(g, path, ['schema', 'candidate', 'current', 'seed', 'stats', 'sprt', 'segments', 'panel', 'personas', 'pass', 'reasons', 'seconds'])) return;
  c.lit(g.schema, `${path}.schema`, SCHEMAS.gate);
  for (const side of ['candidate', 'current'] as const) {
    const v = g[side];
    if (c.obj(v, `${path}.${side}`, ['version', 'sha256'])) {
      c.str(v.version, `${path}.${side}.version`, VERSION_ID);
      c.str(v.sha256, `${path}.${side}.sha256`, SHA256);
    }
  }
  c.str(g.seed, `${path}.seed`, SHA256);
  c.oneOf(g.stats, `${path}.stats`, ['empty', 'live']);
  let accept = false;
  if (c.obj(g.sprt, `${path}.sprt`, ['decision', 'llr', 'lower', 'upper', 'pairs', 'mean', 'perSegment'])) {
    const s = g.sprt;
    c.oneOf(s.decision, `${path}.sprt.decision`, ['accept', 'reject', 'inconclusive']);
    accept = s.decision === 'accept';
    for (const k of ['llr', 'lower', 'upper', 'mean']) c.num(s[k], `${path}.sprt.${k}`);
    c.int(s.pairs, `${path}.sprt.pairs`);
    checkSegmentsMap(c, s.perSegment, `${path}.sprt.perSegment`, (v, p) => {
      if (c.obj(v, p, ['pairs', 'mean'])) {
        c.int(v.pairs, `${p}.pairs`);
        c.num(v.mean, `${p}.mean`);
      }
    });
  }
  let allPass = true;
  checkSegmentsMap(c, g.segments, `${path}.segments`, (v, p) => {
    if (!c.obj(v, p, ['pairs', 'mean', 'lo95', 'pass'])) return;
    c.int(v.pairs, `${p}.pairs`);
    c.num(v.mean, `${p}.mean`);
    c.num(v.lo95, `${p}.lo95`);
    c.bool(v.pass, `${p}.pass`);
    if (v.pass !== true) allPass = false;
  });
  if (c.arr(g.panel, `${path}.panel`, 64)) {
    const members = new Set<string>();
    g.panel.forEach((e, i) => {
      const p = `${path}.panel[${i}]`;
      if (!c.obj(e, p, ['member', 'pairs', 'candidate', 'current', 'diff', 'pass'])) return;
      if (c.str(e.member, `${p}.member`, AI_VERSION_LABEL)) {
        if (members.has(e.member)) c.fail(`${p}.member`, 'listed twice');
        members.add(e.member);
      }
      c.int(e.pairs, `${p}.pairs`);
      checkInterval(c, e.candidate, `${p}.candidate`);
      checkInterval(c, e.current, `${p}.current`);
      if (c.obj(e.diff, `${p}.diff`, ['mean', 'lo95'])) {
        c.num(e.diff.mean, `${p}.diff.mean`);
        c.num(e.diff.lo95, `${p}.diff.lo95`);
      }
      c.bool(e.pass, `${p}.pass`);
      if (e.pass !== true) allPass = false;
    });
  }
  let order = false;
  if (c.obj(g.personas, `${path}.personas`, ['orderHolds', 'source'])) {
    c.bool(g.personas.orderHolds, `${path}.personas.orderHolds`);
    c.str(g.personas.source, `${path}.personas.source`, undefined, 500);
    order = g.personas.orderHolds === true;
  }
  if (c.bool(g.pass, `${path}.pass`) && c.errors.length === 0 && g.pass !== (accept && allPass && order)) {
    c.fail(`${path}.pass`, 'must be SPRT accept, every segment and panel entry passing, and the persona order holding');
  }
  if (c.arr(g.reasons, `${path}.reasons`, 64)) {
    g.reasons.forEach((r, i) => c.text(r, `${path}.reasons[${i}]`, MAX_REASON_CHARS));
    if (g.pass === true && g.reasons.length > 0) c.fail(`${path}.reasons`, 'a passing gate has no reasons');
    if (g.pass === false && g.reasons.length === 0) c.fail(`${path}.reasons`, 'a failing gate names its reasons');
  }
  c.num(g.seconds, `${path}.seconds`, 0);
}

/** Persona knobs of one model (a manifest entry's personas), checked on their own. */
export function validatePersonas(json: unknown): Checked<CalibratedKnobs> {
  const c = new Check();
  checkPersonas(c, json, 'personas');
  return c.result(json);
}

/** The gate result file (training/cycle/gate/gate.ts output, 1.4). */
export function validateGateResult(json: unknown): Checked<GateResult> {
  const c = new Check();
  checkGate(c, json, 'gate');
  return c.result(json);
}

function checkAb(c: Check, x: unknown, path: string): void {
  if (!c.obj(x, path, ['from', 'until', 'matches', 'people', 'drop', 'lo', 'hi', 'detectablePoints', 'rolledBack'])) return;
  c.ms(x.from, `${path}.from`);
  c.ms(x.until, `${path}.until`);
  if (typeof x.from === 'number' && typeof x.until === 'number' && x.until < x.from) c.fail(`${path}.until`, 'before from');
  if (c.obj(x.matches, `${path}.matches`, ['candidate', 'control'])) {
    c.int(x.matches.candidate, `${path}.matches.candidate`);
    c.int(x.matches.control, `${path}.matches.control`);
  }
  if (x.people !== null) c.int(x.people, `${path}.people`, MIN_PEOPLE);
  for (const k of ['drop', 'lo', 'hi', 'detectablePoints']) {
    if (x[k] === null) continue;
    // The comparison's numbers appear only once both arms have 20 people (contract 1.10).
    if (x.people === null) c.fail(`${path}.${k}`, 'null while people is null');
    else c.num(x[k], `${path}.${k}`);
  }
  c.bool(x.rolledBack, `${path}.rolledBack`);
}

function checkCardExplorer(c: Check, x: unknown, path: string, result: unknown): void {
  const base = ['network', 'sha256', 'pass', 'limit', 'source', 'reusedFrom', 'verdicts', 'failuresOnRecord', 'pending', 'reasons'];
  const keys = typeof x === 'object' && x !== null ? [...base, ...EXPLORER_OPTIONAL.filter((k) => k in x)] : base;
  if (!c.obj(x, path, keys)) return;
  c.str(x.network, `${path}.network`, SHA256);
  c.str(x.sha256, `${path}.sha256`, SHA256);
  c.bool(x.pass, `${path}.pass`);
  if (c.num(x.limit, `${path}.limit`, 0, EXPLORER_LIMIT_MAX) && (x.limit as number) <= 0) c.fail(`${path}.limit`, 'must be above 0');
  c.oneOf(x.source, `${path}.source`, EXPLORER_SOURCES);
  const r = x.reusedFrom;
  if (r !== null && c.obj(r, `${path}.reusedFrom`, ['source', 'sha256', 'at'])) {
    c.text(r.source, `${path}.reusedFrom.source`, 200);
    c.str(r.sha256, `${path}.reusedFrom.sha256`, SHA256);
    c.ms(r.at, `${path}.reusedFrom.at`);
  }
  if ((x.source === 'reused') !== (r !== null)) c.fail(`${path}.reusedFrom`, 'present exactly when source is reused');
  const verdicts = Array.isArray(x.verdicts) ? (x.verdicts as unknown[]) : [];
  if (c.arr(x.verdicts, `${path}.verdicts`, 500)) {
    verdicts.forEach((v, i) => {
      const p = `${path}.verdicts[${i}]`;
      if (!c.obj(v, p, ['explorer', 'kind', 'sha256', 'mean', 'upper95', 'pairs', 'pass'])) return;
      c.text(v.explorer, `${p}.explorer`, 300);
      c.oneOf(v.kind, `${p}.kind`, EXPLORER_KINDS);
      c.str(v.sha256, `${p}.sha256`, SHA256);
      c.num(v.mean, `${p}.mean`);
      const ok = c.num(v.upper95, `${p}.upper95`);
      c.int(v.pairs, `${p}.pairs`);
      if (c.bool(v.pass, `${p}.pass`) && ok && typeof x.limit === 'number' && Number.isFinite(x.limit) && v.pass !== ((v.upper95 as number) <= (x.limit as number))) c.fail(`${p}.pass`, 'must be true exactly when upper95 is at most the limit');
    });
  }
  const lists: Record<string, unknown[]> = { measuredOnRecord: [] };
  for (const key of ['failuresOnRecord', 'pending', 'reasons', ...('measuredOnRecord' in x ? ['measuredOnRecord'] : [])]) {
    const items = Array.isArray(x[key]) ? (x[key] as unknown[]) : [];
    lists[key] = items;
    if (c.arr(x[key], `${path}.${key}`, key === 'reasons' ? 64 : 500)) items.forEach((s, i) => c.text(s, `${path}.${key}[${i}]`, 500));
  }
  for (const s of lists.pending) if (!lists.failuresOnRecord.includes(s) && !lists.measuredOnRecord.includes(s)) c.fail(`${path}.pending`, `${String(s)} is not on record`);
  if ('settings' in x && c.map(x.settings, `${path}.settings`)) {
    const st = x.settings;
    if (Object.keys(st).length > 40) c.fail(`${path}.settings`, 'more than 40 entries');
    for (const [k, v] of Object.entries(st)) {
      if (k.length > 64) c.fail(`${path}.settings`, `key longer than 64 characters: ${k.slice(0, 64)}`);
      if (typeof v === 'string') c.text(v, `${path}.settings.${k}`, 200);
      else if (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) c.fail(`${path}.settings.${k}`, 'must be a string, a finite number or a boolean');
    }
  }
  const ppo = x.ppo;
  if (ppo !== undefined && ppo !== null && c.obj(ppo, `${path}.ppo`, ['iterations', 'wanted'])) {
    const okp = c.int(ppo.iterations, `${path}.ppo.iterations`) && c.int(ppo.wanted, `${path}.ppo.wanted`, 1);
    if (okp && x.pass === true && (ppo.iterations as number) < (ppo.wanted as number)) c.fail(`${path}.ppo`, "a passing test's PPO explorer reached its iterations");
  }
  if (x.source === 'measured' && x.pass === true && 'ppo' in x && ppo === null) c.fail(`${path}.ppo`, "a passing measured test names its PPO explorer's iterations");
  const lift = x.lifted;
  if (lift !== undefined && lift !== null && c.obj(lift, `${path}.lifted`, ['reason', 'at', 'failedIn'])) {
    if (c.text(lift.reason, `${path}.lifted.reason`, 300) && !lift.reason.trim()) c.fail(`${path}.lifted.reason`, 'the owner names a reason');
    c.ms(lift.at, `${path}.lifted.at`);
    if (c.arr(lift.failedIn, `${path}.lifted.failedIn`, 20)) {
      if (!lift.failedIn.length) c.fail(`${path}.lifted.failedIn`, 'names the earlier failure it lifts');
      lift.failedIn.forEach((s, i) => c.text(s, `${path}.lifted.failedIn[${i}]`, 200));
    }
  }
  if (x.source === 'none' && verdicts.length) c.fail(`${path}.verdicts`, 'empty when the step did not run');
  if (x.pass === true) {
    if (!verdicts.length || !verdicts.every((v) => typeof v === 'object' && v !== null && (v as R).pass === true)) c.fail(`${path}.pass`, 'a passing test has verdicts, every one passing');
    if (lists.pending.length || lists.reasons.length || x.source === 'none') c.fail(`${path}.pass`, 'a passing test ran, with nothing pending and no reasons');
  }
  if (x.pass === false && !lists.reasons.length) c.fail(`${path}.reasons`, 'a failing test names its reasons');
  if ((result === 'promoted' || result === 'rolled-back') && x.pass !== true) c.fail(`${path}.pass`, "a promoted card's explorer test passes");
}

/** cards/vN.json in zap-models (1.4). */
export function validateCard(json: unknown): Checked<Card> {
  const c = new Check();
  const base = ['schema', 'version', 'parent', 'cycleId', 'createdAt', 'result', 'resultAt', 'reason', 'model', 'training', 'data', 'gate', 'personas', 'twin', 'ab'];
  // explorer is optional: only the cards of files that can read the in-match statistics have it.
  const keys = typeof json === 'object' && json !== null && 'explorer' in json ? [...base, 'explorer'] : base;
  if (!c.obj(json, 'card', keys)) return c.result(json);
  const k = json;
  c.lit(k.schema, 'schema', SCHEMAS.card);
  c.str(k.version, 'version', VERSION_ID);
  if (k.parent !== null) c.str(k.parent, 'parent', VERSION_ID);
  if (k.cycleId !== null) c.str(k.cycleId, 'cycleId', CYCLE_ID);
  c.ms(k.createdAt, 'createdAt');
  c.oneOf(k.result, 'result', CARD_RESULTS);
  c.ms(k.resultAt, 'resultAt');
  c.text(k.reason, 'reason', MAX_REASON_CHARS);
  if (c.obj(k.model, 'model', MODEL_INFO_KEYS)) checkModelInfo(c, k.model, 'model');
  if (k.training !== null && c.obj(k.training, 'training', ['args', 'iterations', 'seconds', 'seedBase', 'leagueFiles', 'humanModel', 'commit'])) {
    const t = k.training;
    if (c.arr(t.args, 'training.args', 1000)) t.args.forEach((a, i) => c.str(a, `training.args[${i}]`, undefined, 4096));
    c.int(t.iterations, 'training.iterations');
    c.num(t.seconds, 'training.seconds', 0);
    c.str(t.seedBase, 'training.seedBase', /^[0-9a-f]{1,16}$/);
    if (c.arr(t.leagueFiles, 'training.leagueFiles', 1000)) t.leagueFiles.forEach((a, i) => c.str(a, `training.leagueFiles[${i}]`, undefined, 4096));
    if (t.humanModel !== null && c.obj(t.humanModel, 'training.humanModel', ['sha256', 'pass'])) {
      c.str(t.humanModel.sha256, 'training.humanModel.sha256', SHA256);
      c.bool(t.humanModel.pass, 'training.humanModel.pass');
    }
    if (t.commit !== null) c.str(t.commit, 'training.commit', /^[0-9a-f]{7,64}$/);
  }
  const dataKeys = ['records', 'valid', 'invalid', 'test', 'validMatches', 'linkedSeats', 'people', 'recordsSha256', 'exportDate', 'exportSha256', 'excluded'];
  if (k.data !== null && c.obj(k.data, 'data', dataKeys)) {
    const d = k.data;
    for (const f of ['records', 'valid', 'invalid', 'test', 'validMatches', 'linkedSeats']) c.int(d[f], `data.${f}`);
    if (d.people !== null) c.int(d.people, 'data.people', MIN_PEOPLE);
    c.str(d.recordsSha256, 'data.recordsSha256', SHA256);
    if (d.exportDate !== null) c.date(d.exportDate, 'data.exportDate');
    if (d.exportSha256 !== null) c.str(d.exportSha256, 'data.exportSha256', SHA256);
    if ((d.exportDate === null) !== (d.exportSha256 === null)) c.fail('data.exportSha256', 'null exactly when exportDate is null');
    const ex = ['unlinked', 'flagged', 'friends', 'auto', 'forced', 'capped'];
    if (c.obj(d.excluded, 'data.excluded', ex)) for (const f of ex) c.int(d.excluded[f], `data.excluded.${f}`);
    if (typeof d.valid === 'number' && typeof d.invalid === 'number' && typeof d.records === 'number' && d.valid + d.invalid > d.records) c.fail('data', 'valid plus invalid above records');
  }
  if (k.gate !== null) checkGate(c, k.gate, 'gate');
  if (k.result === 'bootstrap' && k.gate !== null) c.fail('gate', 'null for bootstrap');
  if (k.personas !== null && c.obj(k.personas, 'personas', ['knobsSha256', 'orderHolds', 'stats'])) {
    c.str(k.personas.knobsSha256, 'personas.knobsSha256', SHA256);
    c.bool(k.personas.orderHolds, 'personas.orderHolds');
    const statKeys = ['trucoRate', 'bluffRate', 'runRate', 'reraiseRate', 'signalTruth', 'vsZap'];
    if (c.map(k.personas.stats, 'personas.stats')) {
      for (const [id, s] of Object.entries(k.personas.stats)) {
        if (!PERSONA_IDS.includes(id)) c.fail('personas.stats', `unknown persona ${id}`);
        else if (c.obj(s, `personas.stats.${id}`, statKeys)) for (const f of statKeys) c.num(s[f], `personas.stats.${id}.${f}`);
      }
    }
  }
  if (k.twin !== null && c.obj(k.twin, 'twin', ['sha256', 'headToHead', 'seedFloor', 'seedFloorCycle', 'seedNoise'])) {
    c.str(k.twin.sha256, 'twin.sha256', SHA256);
    checkInterval(c, k.twin.headToHead, 'twin.headToHead', true);
    if (k.twin.seedFloor !== null) checkInterval(c, k.twin.seedFloor, 'twin.seedFloor', true);
    if (k.twin.seedFloorCycle !== null) c.str(k.twin.seedFloorCycle, 'twin.seedFloorCycle', CYCLE_ID);
    if ((k.twin.seedFloor === null) !== (k.twin.seedFloorCycle === null)) c.fail('twin.seedFloorCycle', 'null exactly when seedFloor is null');
    if (k.twin.seedNoise !== null && c.obj(k.twin.seedNoise, 'twin.seedNoise', ['floors', 'rms'])) {
      c.int(k.twin.seedNoise.floors, 'twin.seedNoise.floors', 1);
      c.num(k.twin.seedNoise.rms, 'twin.seedNoise.rms', 0, 0.5);
    }
  }
  if (k.ab !== null) checkAb(c, k.ab, 'ab');
  if ('explorer' in k) checkCardExplorer(c, k.explorer, 'explorer', k.result);
  return c.result(json);
}

/** status/training.json in zap-models (1.5). */
export function validateStatus(json: unknown): Checked<TrainingStatus> {
  const c = new Check();
  if (!c.obj(json, 'status', ['schema', 'state', 'startedAt', 'finishedAt', 'updatedAt', 'cycleId', 'step', 'lastPromotion', 'message'])) return c.result(json);
  const s = json;
  c.lit(s.schema, 'schema', SCHEMAS.status);
  c.oneOf(s.state, 'state', ['ok', 'running', 'failed']);
  if (s.startedAt !== null) c.ms(s.startedAt, 'startedAt');
  if (s.finishedAt !== null) c.ms(s.finishedAt, 'finishedAt');
  c.ms(s.updatedAt, 'updatedAt');
  if (s.cycleId !== null) c.str(s.cycleId, 'cycleId', CYCLE_ID);
  c.oneOf(s.step, 'step', STATUS_STEPS);
  if (s.lastPromotion !== null && c.obj(s.lastPromotion, 'lastPromotion', ['version', 'at'])) {
    c.str(s.lastPromotion.version, 'lastPromotion.version', VERSION_ID);
    c.ms(s.lastPromotion.at, 'lastPromotion.at');
  }
  c.text(s.message, 'message', MAX_MESSAGE_CHARS);
  if (s.state === 'running' && s.startedAt === null) c.fail('startedAt', 'required while running');
  return c.result(json);
}

/** exports/YYYY-MM-DD.json in zap-events (1.6). */
export function validateExport(json: unknown): Checked<ExportFile> {
  const c = new Check();
  if (!c.obj(json, 'export', ['schema', 'date', 'createdAt', 'partial', 'rows', 'reports'])) return c.result(json);
  const x = json;
  c.lit(x.schema, 'schema', SCHEMAS.export);
  c.date(x.date, 'date');
  c.ms(x.createdAt, 'createdAt');
  c.bool(x.partial, 'partial');
  const seen = new Set<string>();
  if (c.arr(x.rows, 'rows')) {
    for (let i = 0; i < x.rows.length && c.errors.length < 50; i++) {
      const r = x.rows[i];
      const p = `rows[${i}]`;
      if (!c.obj(r, p, ['matchId', 'seat', 'weight', 'flagged', 'openDataOptOut', 'noAdapt', 'group'])) continue;
      c.str(r.matchId, `${p}.matchId`, UUID);
      c.int(r.seat, `${p}.seat`, 0, 3);
      if (c.num(r.weight, `${p}.weight`, 0, 1) && Math.round(r.weight * 1000) / 1000 !== r.weight) c.fail(`${p}.weight`, 'more than 3 decimals');
      c.bool(r.flagged, `${p}.flagged`);
      c.bool(r.openDataOptOut, `${p}.openDataOptOut`);
      c.bool(r.noAdapt, `${p}.noAdapt`);
      c.str(r.group, `${p}.group`, GROUP);
      if (r.flagged === true && r.weight !== 0) c.fail(`${p}.weight`, 'must be 0 for a flagged device');
      const key = `${String(r.matchId)}:${String(r.seat)}`;
      if (seen.has(key)) c.fail(p, 'the same match and seat twice');
      seen.add(key);
    }
  }
  if (c.arr(x.reports, 'reports')) {
    x.reports.forEach((r, i) => {
      const p = `reports[${i}]`;
      if (!c.obj(r, p, ['id', 'day', 'reason', 'matchId', 'seat', 'group'])) return;
      c.int(r.id, `${p}.id`, 1);
      c.date(r.day, `${p}.day`);
      c.oneOf(r.reason, `${p}.reason`, REPORT_REASONS);
      if (r.matchId !== null) c.str(r.matchId, `${p}.matchId`, UUID);
      c.int(r.seat, `${p}.seat`, 0, 3);
      if (r.group !== null) c.str(r.group, `${p}.group`, GROUP);
    });
  }
  return c.result(json);
}

const JOB_EXTRA: Record<ReceiptJob, readonly string[]> = {
  retention: ['counts'],
  calls: ['delivered'],
  flags: ['sha256', 'applied', 'ignored', 'unresolved', 'reviewed'],
  priors: ['sha256', 'imported'],
  export: ['key', 'rows', 'reports', 'partial', 'sha256'],
  alert: ['sent', 'reason'],
};
const RETENTION_COUNTS = ['devices', 'reports', 'flags', 'rooms', 'members', 'calls', 'exportGroups', 'profiles'] as const;

/** receipts/YYYY-MM-DD.json in zap-events (1.7). */
export function validateReceipt(json: unknown): Checked<Receipt> {
  const c = new Check();
  if (!c.obj(json, 'receipt', ['schema', 'date', 'createdAt', 'jobs'])) return c.result(json);
  const x = json;
  c.lit(x.schema, 'schema', SCHEMAS.receipt);
  c.date(x.date, 'date');
  c.ms(x.createdAt, 'createdAt');
  if (!c.obj(x.jobs, 'jobs', RECEIPT_JOBS)) return c.result(json);
  for (const job of RECEIPT_JOBS) {
    const j = x.jobs[job];
    const p = `jobs.${job}`;
    if (!c.obj(j, p, ['status', 'error', ...JOB_EXTRA[job]])) continue;
    c.oneOf(j.status, `${p}.status`, ['ok', 'off', 'skipped', 'failed']);
    if (j.error !== null) c.text(j.error, `${p}.error`, MAX_ERROR_CHARS);
    if (j.status === 'failed' && (typeof j.error !== 'string' || j.error === '')) c.fail(`${p}.error`, 'a failed job says why');
    if ((j.status === 'ok' || j.status === 'off') && j.error !== null) c.fail(`${p}.error`, 'only a failed or skipped job has an error');
    const refs = (k: string) => {
      if (c.arr(j[k], `${p}.${k}`, MAX_FLAG_OPS)) (j[k] as unknown[]).forEach((r, i) => c.str(r, `${p}.${k}[${i}]`, FLAG_REF));
    };
    switch (job) {
      case 'retention':
        if (c.obj(j.counts, `${p}.counts`, RETENTION_COUNTS)) for (const k of RETENTION_COUNTS) c.int(j.counts[k], `${p}.counts.${k}`);
        break;
      case 'calls':
        c.int(j.delivered, `${p}.delivered`);
        break;
      case 'flags':
        if (j.sha256 !== null) c.str(j.sha256, `${p}.sha256`, SHA256);
        for (const k of ['applied', 'ignored', 'unresolved', 'reviewed']) refs(k);
        break;
      case 'priors':
        if (j.sha256 !== null) c.str(j.sha256, `${p}.sha256`, SHA256);
        c.bool(j.imported, `${p}.imported`);
        break;
      case 'export':
        if (j.key !== null && c.str(j.key, `${p}.key`, /^exports\/\d{4}-\d{2}-\d{2}\.json$/) && typeof x.date === 'string' && j.key !== exportKey(x.date)) c.fail(`${p}.key`, 'not the key of the receipt date');
        c.int(j.rows, `${p}.rows`);
        c.int(j.reports, `${p}.reports`);
        c.bool(j.partial, `${p}.partial`);
        if (j.sha256 !== null) c.str(j.sha256, `${p}.sha256`, SHA256);
        if ((j.key === null) !== (j.sha256 === null)) c.fail(`${p}.sha256`, 'null exactly when key is null');
        break;
      case 'alert':
        c.bool(j.sent, `${p}.sent`);
        if (j.reason !== null) c.oneOf(j.reason, `${p}.reason`, ALERT_REASONS);
        if (j.sent === true && j.reason === null) c.fail(`${p}.reason`, 'an email sent has a reason');
        break;
    }
  }
  return c.result(json);
}

const SEGMENT_PRIOR_KEYS = ['raise', 'run', 'accept', 'reraise', 'shown', 'cover'] as const;
/** The reading numbers with per segment values in readingSegments (the in-match priors lack them). */
export const READING_SEGMENT_KEYS = ['bluff'] as const;
export const TIME_MU_RANGE = [Math.log(100), Math.log(120_000)] as const;
export const TIME_SCALE_RANGE = [0.05, 5] as const;
/** A prior is never worth more than 50 observations, so a person's own play always shows through. */
export const STRENGTH_RANGE = [2, 50] as const;

/** control/priors.json in zap-models, and shared/profile-priors-default.json (1.8). */
export function validatePriorsFile(json: unknown): Checked<PriorsFile> {
  const c = new Check();
  if (!c.obj(json, 'priors', ['schema', 'createdAt', 'source', 'people', 'numbers', 'time', 'alpha', 'segments', 'readingSegments'])) return c.result(json);
  const x = json;
  c.lit(x.schema, 'schema', SCHEMAS.priors);
  c.ms(x.createdAt, 'createdAt');
  c.oneOf(x.source, 'source', ['selfplay', 'people']);
  if (x.source === 'selfplay' && x.people !== null) c.fail('people', 'null for selfplay');
  // A number from people needs at least 20 of them (the floor of every number built from people).
  if (x.source === 'people') c.int(x.people, 'people', MIN_PEOPLE);
  if (c.obj(x.numbers, 'numbers', READING_KEYS)) {
    for (const k of READING_KEYS) {
      const n = x.numbers[k];
      const p = `numbers.${k}`;
      if (!c.obj(n, p, ['mean', 'strength', 'people'])) continue;
      if (c.num(n.mean, `${p}.mean`) && !(n.mean > 0 && n.mean < 1)) c.fail(`${p}.mean`, 'must be in (0, 1)');
      c.num(n.strength, `${p}.strength`, STRENGTH_RANGE[0], STRENGTH_RANGE[1]);
      if (n.people !== null) {
        if (x.source !== 'people') c.fail(`${p}.people`, 'null for selfplay');
        else if (c.int(n.people, `${p}.people`, MIN_PEOPLE) && typeof x.people === 'number' && n.people > x.people) c.fail(`${p}.people`, 'above the file people');
      }
    }
  }
  if (c.obj(x.time, 'time', ['mu', 'tau', 'sigma'])) {
    c.num(x.time.mu, 'time.mu', TIME_MU_RANGE[0], TIME_MU_RANGE[1]);
    c.num(x.time.tau, 'time.tau', TIME_SCALE_RANGE[0], TIME_SCALE_RANGE[1]);
    c.num(x.time.sigma, 'time.sigma', TIME_SCALE_RANGE[0], TIME_SCALE_RANGE[1]);
  }
  if (c.num(x.alpha, 'alpha') && x.alpha <= 0) c.fail('alpha', 'must be positive');
  let shapes = true;
  if (c.obj(x.segments, 'segments', SEGMENTS)) {
    for (const s of SEGMENTS) if (!c.obj(x.segments[s], `segments.${s}`, SEGMENT_PRIOR_KEYS)) shapes = false;
  } else shapes = false;
  if (c.obj(x.readingSegments, 'readingSegments', SEGMENTS)) {
    for (const s of SEGMENTS) {
      if (!c.obj(x.readingSegments[s], `readingSegments.${s}`, READING_SEGMENT_KEYS)) continue;
      for (const k of READING_SEGMENT_KEYS) {
        const v = x.readingSegments[s][k];
        if (c.num(v, `readingSegments.${s}.${k}`) && !(v > 0 && v < 1)) c.fail(`readingSegments.${s}.${k}`, 'must be in (0, 1)');
      }
    }
  }
  if (shapes) {
    try {
      validatePriors({ version: 1, alpha: x.alpha, segments: x.segments });
    } catch (e) {
      c.fail('segments', (e as Error).message);
    }
  }
  return c.result(json);
}

/** control/flags.json in zap-models (1.9). */
export function validateFlags(json: unknown): Checked<FlagsFile> {
  const c = new Check();
  if (!c.obj(json, 'flags', ['schema', 'createdAt', 'ops'])) return c.result(json);
  const x = json;
  c.lit(x.schema, 'schema', SCHEMAS.flags);
  c.ms(x.createdAt, 'createdAt');
  if (c.arr(x.ops, 'ops', MAX_FLAG_OPS)) {
    for (let i = 0; i < x.ops.length && c.errors.length < 50; i++) {
      const o = x.ops[i];
      const p = `ops[${i}]`;
      const isFlag = typeof o === 'object' && o !== null && (o as R).op === 'flag';
      if (!c.obj(o, p, isFlag ? ['ref', 'op', 'reason', 'evidence', 'at'] : ['ref', 'op', 'at'])) continue;
      if (c.str(o.ref, `${p}.ref`, FLAG_REF)) c.date(o.ref.slice(0, 10), `${p}.ref`);
      c.oneOf(o.op, `${p}.op`, ['flag', 'confirm', 'clear']);
      if (isFlag) {
        c.oneOf(o.reason, `${p}.reason`, FLAG_REASONS);
        c.str(o.evidence, `${p}.evidence`, EVIDENCE, MAX_EVIDENCE_CHARS);
      }
      if (c.ms(o.at, `${p}.at`) && typeof x.createdAt === 'number') {
        if (o.at > x.createdAt) c.fail(`${p}.at`, 'after createdAt');
        if (o.at < x.createdAt - FLAG_OP_MAX_AGE_MS) c.fail(`${p}.at`, 'older than 400 days');
      }
    }
  }
  return c.result(json);
}

const SUMMARY_KEYS_V1 = ['schema', 'generatedAt', 'minPeople', 'training', 'humansVsZap', 'versions', 'ab', 'layers', 'cells', 'playerTypes'] as const;
const SUMMARY_KEYS_V2 = [...SUMMARY_KEYS_V1, 'seedNoise', 'scoreboard', 'disagreements'] as const;
const SUMMARY_VERSION_KEYS_V1 = ['version', 'promotedAt', 'result', 'anchors'] as const;
const SUMMARY_VERSION_KEYS_V2 = [...SUMMARY_VERSION_KEYS_V1, 'twin', 'personas', 'data'] as const;
/** Scoreboard rows a summary may hold (modes times version pairs; far above any real count). */
export const MAX_SCOREBOARD_ROWS = 10_000;

/** The fields zap-summary/2 adds to each version entry. */
function checkSummaryVersionV2(c: Check, v: R, p: string): void {
  if (v.twin !== null) {
    checkInterval(c, v.twin, `${p}.twin`, true);
    if (typeof (v.twin as R)?.pairs === 'number' && ((v.twin as R).pairs as number) < 1) c.fail(`${p}.twin.pairs`, 'at least 1');
  }
  if (v.personas !== null && c.obj(v.personas, `${p}.personas`, ['pairs', 'stats'])) {
    c.int(v.personas.pairs, `${p}.personas.pairs`, 1);
    if (c.map(v.personas.stats, `${p}.personas.stats`)) {
      for (const [id, s] of Object.entries(v.personas.stats)) {
        if (!PERSONA_IDS.includes(id)) c.fail(`${p}.personas.stats`, `unknown persona ${id}`);
        else if (c.obj(s, `${p}.personas.stats.${id}`, PERSONA_STAT_KEYS)) for (const f of PERSONA_STAT_KEYS) c.num(s[f], `${p}.personas.stats.${id}.${f}`, 0, 1);
      }
    }
  }
  if (v.data !== null && c.obj(v.data, `${p}.data`, ['validMatches', 'people'])) {
    c.int(v.data.validMatches, `${p}.data.validMatches`);
    // The count of people is public only from MIN_PEOPLE on (contract 1.10).
    if (v.data.people !== null) c.int(v.data.people, `${p}.data.people`, MIN_PEOPLE);
  }
}

/** The blocks zap-summary/2 adds at the top level. */
function checkSummaryV2(c: Check, x: R): void {
  if (x.seedNoise !== null && c.obj(x.seedNoise, 'seedNoise', ['floors', 'rms'])) {
    c.int(x.seedNoise.floors, 'seedNoise.floors', 1);
    c.num(x.seedNoise.rms, 'seedNoise.rms', 0, 0.5);
  }
  if (c.arr(x.scoreboard, 'scoreboard', MAX_SCOREBOARD_ROWS)) {
    const seen = new Set<string>();
    x.scoreboard.forEach((row, i) => {
      const p = `scoreboard[${i}]`;
      if (!c.obj(row, p, ['variant', 'players', 'aiVersion', 'partnerVersion', 'people', 'matches', 'humanWins'])) return;
      c.oneOf(row.variant, `${p}.variant`, ['paulista', 'mineiro']);
      c.oneOf(row.players, `${p}.players`, [2, 4]);
      c.str(row.aiVersion, `${p}.aiVersion`, AI_VERSION_LABEL);
      // 1 against 1 has no partner; in 2 against 2 the partner is an AI with its own version.
      if (row.players === 2 && row.partnerVersion !== null) c.fail(`${p}.partnerVersion`, 'null in 1 against 1');
      if (row.players === 4) c.str(row.partnerVersion, `${p}.partnerVersion`, AI_VERSION_LABEL);
      c.int(row.people, `${p}.people`, MIN_PEOPLE);
      c.int(row.matches, `${p}.matches`, 1);
      c.int(row.humanWins, `${p}.humanWins`);
      if (typeof row.humanWins === 'number' && typeof row.matches === 'number' && row.humanWins > row.matches) c.fail(`${p}.humanWins`, 'above matches');
      // One person per match in these kinds, so never more people than matches.
      if (typeof row.people === 'number' && typeof row.matches === 'number' && row.people > row.matches) c.fail(`${p}.people`, 'above matches');
      const key = `${String(row.variant)}|${String(row.players)}|${String(row.aiVersion)}|${String(row.partnerVersion)}`;
      if (seen.has(key)) c.fail(p, 'the same mode and versions twice');
      seen.add(key);
    });
  }
  if (x.disagreements !== null && c.obj(x.disagreements, 'disagreements', ['types'])) {
    if (c.arr(x.disagreements.types, 'disagreements.types', DISAGREEMENT_TYPES.length)) {
      const seen = new Set<unknown>();
      x.disagreements.types.forEach((t, i) => {
        const p = `disagreements.types[${i}]`;
        if (!c.obj(t, p, ['type', 'people', 'decisions', 'share'])) return;
        c.oneOf(t.type, `${p}.type`, DISAGREEMENT_TYPES);
        if (seen.has(t.type)) c.fail(`${p}.type`, 'listed twice');
        seen.add(t.type);
        c.int(t.people, `${p}.people`, MIN_PEOPLE);
        c.int(t.decisions, `${p}.decisions`);
        c.num(t.share, `${p}.share`, 0, 1);
      });
    }
  }
}

/**
 * summary.json in zap-public (1.10): zap-summary/1, or zap-summary/2 since milestone 7. Every
 * number built from people's games comes from a group of at least MIN_PEOPLE people (cells,
 * scoreboard rows, people counts, disagreements); humansVsZap is the owner's one exception.
 */
export function validateSummary(json: unknown): Checked<AnySummary> {
  const c = new Check();
  const v2 = typeof json === 'object' && json !== null && (json as R).schema === SCHEMAS.summary2;
  if (!c.obj(json, 'summary', v2 ? SUMMARY_KEYS_V2 : SUMMARY_KEYS_V1)) return c.result(json);
  const x = json;
  c.oneOf(x.schema, 'schema', [SCHEMAS.summary, SCHEMAS.summary2]);
  c.ms(x.generatedAt, 'generatedAt');
  c.lit(x.minPeople, 'minPeople', MIN_PEOPLE);
  if (c.obj(x.training, 'training', ['state', 'finishedAt', 'current', 'nextAfter'])) {
    c.oneOf(x.training.state, 'training.state', ['ok', 'running', 'failed']);
    if (x.training.finishedAt !== null) c.ms(x.training.finishedAt, 'training.finishedAt');
    c.str(x.training.current, 'training.current', VERSION_ID);
    if (x.training.nextAfter !== null) c.ms(x.training.nextAfter, 'training.nextAfter');
  }
  if (c.obj(x.humansVsZap, 'humansVsZap', ['matches', 'humanWins', 'since'])) {
    const h = x.humansVsZap;
    c.int(h.matches, 'humansVsZap.matches');
    c.int(h.humanWins, 'humansVsZap.humanWins');
    if (typeof h.matches === 'number' && typeof h.humanWins === 'number' && h.humanWins > h.matches) c.fail('humansVsZap.humanWins', 'above matches');
    if (h.since !== null) c.ms(h.since, 'humansVsZap.since');
    if ((h.since === null) !== (h.matches === 0)) c.fail('humansVsZap.since', 'null exactly when there are no matches');
  }
  if (c.arr(x.versions, 'versions', MAX_MODELS)) {
    let last = -1;
    x.versions.forEach((v, i) => {
      const p = `versions[${i}]`;
      if (!c.obj(v, p, v2 ? SUMMARY_VERSION_KEYS_V2 : SUMMARY_VERSION_KEYS_V1)) return;
      c.str(v.version, `${p}.version`, VERSION_ID);
      if (c.ms(v.promotedAt, `${p}.promotedAt`)) {
        if (v.promotedAt < last) c.fail(`${p}.promotedAt`, 'versions are listed oldest first');
        last = v.promotedAt;
      }
      c.oneOf(v.result, `${p}.result`, CARD_RESULTS);
      if (v.anchors !== null && c.obj(v.anchors, `${p}.anchors`, PANEL_ANCHORS)) for (const a of PANEL_ANCHORS) checkInterval(c, v.anchors[a], `${p}.anchors.${a}`);
      if (v2) checkSummaryVersionV2(c, v, p);
    });
  }
  if (v2) checkSummaryV2(c, x);
  if (x.ab !== null && c.obj(x.ab, 'ab', ['version', 'control', 'share', 'from', 'until', 'detectablePoints', 'result'])) {
    const a = x.ab;
    c.str(a.version, 'ab.version', VERSION_ID);
    c.str(a.control, 'ab.control', VERSION_ID);
    c.num(a.share, 'ab.share', 0, 0.5);
    c.ms(a.from, 'ab.from');
    c.ms(a.until, 'ab.until');
    if (a.detectablePoints !== null) c.num(a.detectablePoints, 'ab.detectablePoints', 0);
    if (a.result !== null && c.obj(a.result, 'ab.result', ['drop', 'lo', 'hi'])) for (const k of ['drop', 'lo', 'hi']) c.num(a.result[k], `ab.result.${k}`);
  }
  if (c.obj(x.layers, 'layers', LAYER_KEYS)) {
    for (const k of LAYER_KEYS) {
      const l = x.layers[k];
      const p = `layers.${k}`;
      if (!c.obj(l, p, ['on', 'why', 'progress'])) continue;
      c.bool(l.on, `${p}.on`);
      c.text(l.why, `${p}.why`, MAX_REASON_CHARS);
      // A people count is public only from MIN_PEOPLE on: under it the cycle writes null (contract 1.10).
      if (c.map(l.progress, `${p}.progress`)) for (const [pk, pv] of Object.entries(l.progress)) if (pv !== null) c.int(pv, `${p}.progress.${pk}`, pk === 'people' ? MIN_PEOPLE : 0);
    }
  }
  if (c.arr(x.cells, 'cells', 100_000)) {
    x.cells.forEach((cell, i) => {
      const p = `cells[${i}]`;
      if (!c.obj(cell, p, ['week', 'variant', 'players', 'people', 'matches', 'humanWinRate'])) return;
      c.str(cell.week, `${p}.week`, ISO_WEEK);
      c.oneOf(cell.variant, `${p}.variant`, ['paulista', 'mineiro']);
      c.oneOf(cell.players, `${p}.players`, [2, 4]);
      c.int(cell.people, `${p}.people`, MIN_PEOPLE);
      c.int(cell.matches, `${p}.matches`, 1);
      c.num(cell.humanWinRate, `${p}.humanWinRate`, 0, 1);
    });
  }
  if (x.playerTypes !== null && c.obj(x.playerTypes, 'playerTypes', ['k', 'ari', 'types'])) {
    const t = x.playerTypes;
    c.int(t.k, 'playerTypes.k', 1, 6);
    c.num(t.ari, 'playerTypes.ari', -1, 1);
    if (c.arr(t.types, 'playerTypes.types', 6)) {
      if (t.types.length !== t.k) c.fail('playerTypes.types', 'one entry per type (k)');
      t.types.forEach((ty, i) => {
        const p = `playerTypes.types[${i}]`;
        if (!c.obj(ty, p, ['share', 'center'])) return;
        c.num(ty.share, `${p}.share`, 0, 1);
        if (c.obj(ty.center, `${p}.center`, READING_KEYS)) for (const k of READING_KEYS) c.num(ty.center[k], `${p}.center.${k}`, 0, 1);
      });
    }
  }
  return c.result(json);
}

/** The answer of GET /api/me/reading (1.13). */
export function validateReading(json: unknown): Checked<Reading> {
  const c = new Check();
  if (!c.obj(json, 'reading', ['schema', 'generatedAt', 'noAdapt', 'matches', 'decisions', 'priors', 'numbers', 'time'])) return c.result(json);
  const x = json;
  c.lit(x.schema, 'schema', SCHEMAS.reading);
  c.ms(x.generatedAt, 'generatedAt');
  c.bool(x.noAdapt, 'noAdapt');
  c.int(x.matches, 'matches');
  c.int(x.decisions, 'decisions');
  c.oneOf(x.priors, 'priors', ['selfplay', 'people']);
  if (c.arr(x.numbers, 'numbers', READING_KEYS.length)) {
    if (x.numbers.length !== READING_KEYS.length) c.fail('numbers', 'one entry per reading key');
    x.numbers.forEach((n, i) => {
      const p = `numbers[${i}]`;
      if (!c.obj(n, p, ['key', 'n', 'shown', 'value', 'low', 'high', 'population', 'source'])) return;
      c.lit(n.key, `${p}.key`, READING_KEYS[i]);
      c.int(n.n, `${p}.n`);
      c.bool(n.shown, `${p}.shown`);
      for (const k of ['value', 'low', 'high']) {
        if (n.shown === true) c.num(n[k], `${p}.${k}`, 0, 1);
        else if (n[k] !== null) c.fail(`${p}.${k}`, 'null while hidden');
      }
      c.num(n.population, `${p}.population`, 0, 1);
      c.oneOf(n.source, `${p}.source`, ['selfplay', 'people']);
      if (x.priors === 'selfplay' && n.source === 'people') c.fail(`${p}.source`, 'self-play priors have no number from people');
      if (x.noAdapt === true && n.shown === true) c.fail(`${p}.shown`, 'nothing is shown with noAdapt');
    });
  }
  if (c.obj(x.time, 'time', ['n', 'shown', 'medianMs', 'lowMs', 'highMs'])) {
    const t = x.time;
    c.int(t.n, 'time.n');
    c.bool(t.shown, 'time.shown');
    for (const k of ['medianMs', 'lowMs', 'highMs']) {
      if (t.shown === true) c.int(t[k], `time.${k}`);
      else if (t[k] !== null) c.fail(`time.${k}`, 'null while hidden');
    }
    if (x.noAdapt === true && t.shown === true) c.fail('time.shown', 'nothing is shown with noAdapt');
  }
  if (x.noAdapt === true && x.decisions !== 0) c.fail('decisions', 'zero with noAdapt');
  return c.result(json);
}

/** Every format by schema name, for tools that find the schema inside the file. */
export const VALIDATORS = {
  [SCHEMAS.manifest]: validateManifest,
  [SCHEMAS.card]: validateCard,
  [SCHEMAS.gate]: validateGateResult,
  [SCHEMAS.status]: validateStatus,
  [SCHEMAS.export]: validateExport,
  [SCHEMAS.receipt]: validateReceipt,
  [SCHEMAS.priors]: validatePriorsFile,
  [SCHEMAS.flags]: validateFlags,
  [SCHEMAS.summary]: validateSummary,
  [SCHEMAS.summary2]: validateSummary,
  [SCHEMAS.reading]: validateReading,
} as const satisfies Record<string, (json: unknown) => Checked<unknown>>;
