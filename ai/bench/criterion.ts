// The explorer criterion judges the file that would be served (ai.adaptation.explorer.criterion).
// Each stored measurement names the adaptive file it played (models.adaptive.sha256 of its result).
// Only the measurements against the served file count; those against earlier files (another
// safety net, another export) are kept as history with their file and net and never count. With no
// measurement against the served file the criterion does not pass. Neither does it while an
// explorer that failed against an earlier file has no verdict against the served file
// (pendingRemeasure): a known exploiter must be measured again, a new search that passes is not
// enough.

/** A paired difference as the benches store it (score points: 0.01 is 1 point). */
export interface Diff {
  mean: number;
  se: number;
  ci95: number[];
  upper95: number;
  pairs: number;
}

/** One explorer's verdict: pass is the primary criterion (adaptation part), passTwinRule the rule of attempt 1. */
export interface Verdict {
  explorer: string;
  adaptationPart: Diff;
  gainOverTwin: Diff;
  basePart: Diff;
  pass: boolean;
  passTwinRule: boolean;
}

export type MeasuredKind = 'scripted' | 'trained' | 'control';

/** The explorers one result file measured against one adaptive file. */
export interface Measured {
  kind: MeasuredKind;
  /** The result file. */
  file: string;
  /** The adaptive file it measured (path and SHA-256 at measurement time). */
  model: { path: string; sha256: string } | null;
  /** That file's safety net (meta.adapt). */
  adapt: unknown;
  explorers: Verdict[];
  /** Scripted attempts only. */
  attempt?: number;
  searchRankedBy?: 'twin' | 'ablated';
  /** A re-measure of an earlier search's explorers (ai/bench/explorer.ts --remeasure). */
  remeasureOf?: unknown;
  /** Trained explorers only: the adaptive file it trained against (path, SHA-256, safety net). */
  against?: unknown;
}

/** A verdict from the stored parts; `requirement` is the 1 point bound (0.01). */
export function verdictOf(explorer: string, gainOverTwin: Diff, split: { adaptationPart: Diff; basePart: Diff }, requirement: number): Verdict {
  return {
    explorer,
    adaptationPart: split.adaptationPart,
    basePart: split.basePart,
    gainOverTwin,
    pass: split.adaptationPart.upper95 <= requirement,
    passTwinRule: gainOverTwin.upper95 <= requirement,
  };
}

/**
 * Splits the stored measurements by the served file. pass needs at least one verdict against it,
 * every one of them passing, and a verdict against it for every explorer that failed against an
 * earlier file (pendingRemeasure lists those that have none, in history order).
 */
export function judgeServed(all: readonly Measured[], servedSha: string) {
  const current = all.filter((m) => m.model?.sha256 === servedSha);
  const history = all.filter((m) => m.model?.sha256 !== servedSha);
  const verdicts = current.flatMap((m) => m.explorers);
  const measured = new Set(verdicts.map((v) => v.explorer));
  const pendingRemeasure = [...new Set(history.flatMap((m) => m.explorers.filter((v) => !v.pass && !measured.has(v.explorer)).map((v) => v.explorer)))];
  return {
    current,
    history,
    verdicts,
    pendingRemeasure,
    pass: verdicts.length > 0 && verdicts.every((v) => v.pass) && pendingRemeasure.length === 0,
    passTwinRule: verdicts.length > 0 && verdicts.every((v) => v.passTwinRule) && pendingRemeasure.length === 0,
  };
}
