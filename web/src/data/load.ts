// Where the data page gets its numbers (DATA-SPEC 2): the files made at build time by tools/data/
// (each with its provenance), the live counters (live-poll.ts, polled every minute) and the cycle's
// summary (GET /api/summary, fetched at load and again on every fifth live poll). The parts read
// them through useData(); nothing here holds a number typed by hand.
//
// The reading of the opponent has two sets of words (lead's change 2): `reads` is live.adapt once
// /api/live answers and, before that, what the build served (facts-view `served.readsOpponents`).

import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { AnySummary, SummaryV2 } from '../../../shared/cycle-formats.ts';
import { normalizeSummary } from '../../../shared/summary-view.ts';
import type { LiveState } from './live-poll.ts';
import type { Format } from './format.ts';
import curveJson from './generated/curve.json' with { type: 'json' };
import rulesJson from './generated/cycle-rules.json' with { type: 'json' };
import factsJson from './generated/facts-view.json' with { type: 'json' };

// ------------------------------------------------------------------------------------------------
// Build time files

/** facts-view.json as generated (keys of facts.json; `missing` lists what facts.json lacks). */
export const FACTS = factsJson;
/** One evaluation of a training run: `step` counts from the start of the lineage (DATA-SPEC 2.1.3). */
export interface CurvePointRow {
  iteration: number;
  step: number;
  mean: number;
  half95: number;
  phase: string;
}

/** One version's training run in curve.json; `from` names the version it started from. */
export interface CurveRow {
  version: string;
  run: string;
  from: string | null;
  snapshot: number;
  offset: number;
  pairs: number;
  evalEvery: number;
  decisionsPerIteration: number;
  imitationIterations: number;
  iterations: number;
  hands: number;
  trainedAt: string;
  nearSnapshot: CurvePointRow;
  points: CurvePointRow[];
}

/** curve.json: one row per version of the served lineage (tools/data/sources.json). */
export const CURVE = curveJson as unknown as { rows: CurveRow[] };
/** cycle-rules.json: the gate, the A/B window and the thresholds of training/cycle/config/prod.toml. */
export const RULES = rulesJson;
// exact.json and sim.json are read by the chapters that show them (Truco.tsx, Plays.tsx), which
// load in their own chunk after the first screen (parts/chapters-lazy.ts).


/** A difference the page shows with its 95% interval only (tools/data/page-keys.ts keeps no count for it). */
export type Span = Pick<Measured, 'mean' | 'ci95'>;

/** A measured difference or share with its 95% interval, as facts.json stores it. */
export interface Measured {
  mean: number;
  ci95: [number, number];
  upper95?: number;
  pairs: number;
}

/**
 * The reading facts the page uses, each block nullable: a block that has not landed renders its
 * figure's "not measured" state (DATA-SPEC 3.9) instead of failing the build.
 */
export interface ReadingFacts {
  design: { alpha: number } | null;
  priors: { measuredAt: string; alpha: number; matchesPerSegment: number; file: string; segments: Record<string, { raise: number }> } | null;
  evidence: { measuredAt: string; nW: number; pooled: { betDecisions: number; share: number[]; medianPositive: number } } | null;
  safetyNet: { measuredAt: string; bmax: number; nHalf: number } | null;
  readingCurve: {
    measuredAt: string;
    matchesPerSegment: number;
    styles: Record<string, { bet: Record<string, { changedShare: number; meanN: number; decisions: number }> }>;
  } | null;
  perStyle: {
    measuredAt: string;
    pairsPerSegment: number;
    styles: Record<string, { gainVsAblated: Measured; gainVsTwin: Span; ablatedVsTwin: Span; heldOut: boolean }>;
    pooled: { allStyles: { gainVsAblated: Measured; gainVsTwin: Measured; ablatedVsTwin: Measured; seedFloor?: Measured } };
    /** Training iterations of the twin and the second twin: seedFloor is a seed floor only when they match. */
    twinIterations?: { twin: number; twin2: number };
  } | null;
  /** Head to head rows (adaptive-twin, ablated-twin, ...): a share of the first player's mean score. */
  headToHead: { rows: Record<string, Span> } | null;
  explorer: {
    measuredAt: string;
    /** The rule set before the first search: the gain over the twin, one sided bound at most this. */
    requirement: number;
    grid: { size: number };
    chosen: { a: string; b: string; k: number; trigger: 'hand' | 'evidence'; partner: string };
    attempts: { attempt: number; pairsPerSegment: number }[];
    criterion: {
      measuredAt: string;
      requirement: number;
      /** The safety net of the file the criterion judges (the one that would be served). */
      servedModel?: { adapt: { bmax: number; nHalf: number } };
      pass: boolean;
      verdicts: {
        /** remeasureOf: an earlier search's explorer measured again on a later file (its rows keep that search's number). */
        scripted: { attempt: number; adapt?: { bmax: number; nHalf: number }; remeasureOf?: { attempt: number }; explorers: ExplorerVerdict[] }[];
        trained: ExplorerVerdict | null;
        control: ExplorerVerdict | null;
        /** Explorers trained against an earlier file, measured against the judged one. */
        otherTrained?: (ExplorerVerdict & { trainedAgainst?: { adapt: { bmax: number; nHalf: number } } })[];
      };
    } | null;
    /** The trained explorer's training, with the safety net of the file it trained against. */
    trained?: { training?: { against?: { adapt: { bmax: number; nHalf: number } } } };
    /**
     * The control explorer, trained the same way against a twin: asServed, on the same new deals, the
     * trained explorer's score against the adaptive network as served minus the control's against the
     * twin, pair by pair.
     */
    control?: {
      fresh: {
        asServed: Measured;
      };
    };
  } | null;
  decisionTime: { measuredAt: string; decisionMs: { p50: number } } | null;
}

export interface ExplorerVerdict {
  explorer: string;
  adaptationPart: Span & { upper95?: number };
  /** The old rule (attempt 1) reads the one sided bound of the gain over the twin. */
  gainOverTwin: { upper95: number };
  pass: boolean;
  passTwinRule: boolean;
}

export const READING = factsJson.ai.adaptation as unknown as ReadingFacts;

type Criterion = NonNullable<NonNullable<ReadingFacts['explorer']>['criterion']>;

/** Every verdict the criterion judges: the scripted explorers, the trained ones and the control. */
export function allVerdicts(c: Criterion): ExplorerVerdict[] {
  return [...c.verdicts.scripted.flatMap((a) => a.explorers), ...(c.verdicts.trained ? [c.verdicts.trained] : []), ...(c.verdicts.otherTrained ?? []), ...(c.verdicts.control ? [c.verdicts.control] : [])];
}

/** The one sided 95% upper bound of a verdict's adaptation part (the two sided end when it is missing). */
export function upperOf(v: ExplorerVerdict): number {
  return v.adaptationPart.upper95 ?? v.adaptationPart.ci95[1];
}

/** The model file and the build's view of what the site serves (facts-view `model` and `served`). */
export interface ServedFacts {
  version: string;
  readsOpponents: boolean;
  /** Some version the cycle published carried the reading. */
  carried?: boolean;
  /** The newest version carrying the reading that was rolled back. */
  rolledBack?: { version: string; to: string | null; at: number } | null;
  /** The version in play is the network the explorer criterion judged; null when it cannot be told. */
  judged?: boolean | null;
  /** The first 8 hex digits of the SHA-256 of the file the criterion judged. */
  criterionSha?: string | null;
}
export const SERVED = factsJson.served as ServedFacts;

/**
 * Facts derived at build time from hashes the bundle drops (tools/data/facts-view.ts): whether the
 * twin of the reading test is the served file, the version whose decisions F6 counted, and whether
 * the head to head rows and the control explorer measured the file the explorer
 * criterion judges (and which file the control trained against).
 */
export const DERIVED = factsJson.derived as {
  twinServed: boolean | null;
  evidenceModel: string | null;
  headToHeadJudged?: boolean | null;
  controlJudged?: boolean | null;
  controlTrainedOnServed?: boolean | null;
  controlMeasuredOnOwn?: boolean | null;
};

// ------------------------------------------------------------------------------------------------
// The training lineage of a version (F2, F3)

/**
 * The rows of curve.json that lead to `version`, oldest first (each row's `from` names its parent).
 * Empty when no row names that version (the heuristic fallback, an unknown label).
 */
export function lineage(rows: readonly CurveRow[], version: string): CurveRow[] {
  const out: CurveRow[] = [];
  let at: string | null = version;
  for (let guard = 0; at && guard < rows.length; guard++) {
    const row = rows.find((r) => r.version === at);
    if (!row) break;
    out.unshift(row);
    at = row.from;
  }
  return out;
}

/** The version whose training the page tells: the one in play when it has a row, else the newest row. */
export function storyVersion(rows: readonly CurveRow[], served: string): string {
  return rows.some((r) => r.version === served) ? served : (rows[rows.length - 1]?.version ?? served);
}

// ------------------------------------------------------------------------------------------------
// The cycle's summary, at run time

export type SummaryState = { kind: 'loading' } | { kind: 'none' } | { kind: 'unavailable' } | { kind: 'ready'; summary: SummaryV2 };

/** Reads one answer of /api/summary: the file (either schema) as a zap-summary/2 view. */
export function summaryFrom(status: number, json: unknown): SummaryState {
  if (status === 404) return { kind: 'none' };
  if (status !== 200 || !json || typeof json !== 'object') return { kind: 'unavailable' };
  const s = json as { schema?: unknown; versions?: unknown; training?: unknown };
  if ((s.schema !== 'zap-summary/1' && s.schema !== 'zap-summary/2') || !Array.isArray(s.versions) || !s.training) return { kind: 'unavailable' };
  try {
    return { kind: 'ready', summary: normalizeSummary(json as AnySummary) };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function fetchSummary(): Promise<SummaryState> {
  try {
    const r = await fetch('/api/summary', { headers: { accept: 'application/json' } });
    return summaryFrom(r.status, r.status === 200 ? await r.json() : null);
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Fetched at load and on every fifth live poll; a failed refresh keeps the summary already shown. */
export function useSummary(polls: number): SummaryState {
  const [state, setState] = useState<SummaryState>({ kind: 'loading' });
  const round = Math.floor(polls / 5);
  useEffect(() => {
    let live = true;
    void fetchSummary().then((next) => {
      if (live) setState((prev) => (next.kind === 'unavailable' && prev.kind === 'ready' ? prev : next));
    });
    return () => {
      live = false;
    };
  }, [round]);
  return state;
}

// ------------------------------------------------------------------------------------------------
// What every part reads

export interface DataModel {
  f: Format;
  live: LiveState & { resume(): void };
  summary: SummaryState;
  /** The version in play: live.current, or the build's served version before /api/live answers. */
  served: string;
  /** The version in play reads its opponents during the match. */
  reads: boolean;
}

export function readsNow(live: LiveState): boolean {
  return live.live ? live.live.adapt : SERVED.readsOpponents;
}

export function servedNow(live: LiveState): string {
  return live.live?.aiVersion ?? SERVED.version;
}

export const DataCtx = createContext<DataModel | null>(null);

export function useData(): DataModel {
  const d = useContext(DataCtx);
  if (!d) throw new Error('useData() outside the data page');
  return d;
}

/** A date stored as an ISO string or ms, as ms. */
export function ms(at: string | number): number {
  return typeof at === 'number' ? at : Date.parse(at);
}
