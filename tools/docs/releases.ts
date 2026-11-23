// The versions the training cycle served, as facts.json records them, and what the texts read from
// them: the version in play and the state of the reading during the match.
//
// tools/docs/record-release.ts writes, after an adoption, a promotion, the end of a test window or a
// rollback:
//
//   ai.inPlay        what the cycle's manifest said when the owner recorded it: the version in play
//                    (manifest.current), the control of an open window with its share and end,
//                    AI_ADAPT of wrangler.jsonc, the cycle's profile and storage mode, and the sources.
//   ai.releases.<v>  one entry per version the cycle published (origin "cycle"): the file, its
//                    SHA-256 and network digest, features, safety net, gate, characters, the window
//                    with people and the version's state (window, current, replaced or rolled-back).
//   ai.adaptation.explorer.criterionNetwork
//                    the network digest of the file the explorer criterion judged, so a version the
//                    cycle exported again from it (same weights, another version name) is known as
//                    the judged network.
//
// Without ai.inPlay the version in play is the bundled one (ai.bootstrapModel), as before any record.
// tools/docs/readme-facts.ts and tools/data/facts-view.ts read the version in play from here.

import { createHash } from 'node:crypto';
import { parseModel } from '../../ai/src/mlp.ts';
import { isSafetyNet } from '../../ai/src/safety.ts';

export type ReleaseState = 'window' | 'current' | 'replaced' | 'rolled-back';
export type Where = 'local' | 'server';

export interface SafetyNet {
  bmax: number;
  nHalf: number;
}

/** ai.inPlay. */
export interface InPlay {
  version: string;
  control: string | null;
  controlShare: number | null;
  /** ISO time the open window ends, null outside a window. */
  controlUntil: string | null;
  AI_ADAPT: 'on' | 'off';
  recordedAt: string;
  cycle: { profile: string | null; mode: string | null };
  source: Record<string, string | null>;
}

/** The A/B block of a model card (training/cycle/zapcycle/ab.py card_ab), times as ISO. */
export interface WindowResult {
  matches: { candidate: number; control: number };
  people: number | null;
  drop: number | null;
  lo: number | null;
  hi: number | null;
  detectablePoints: number | null;
  rolledBack: boolean;
}

/** ai.releases.<v> for a version the cycle published. */
export interface CycleRelease {
  date: string;
  version: string;
  origin: 'cycle';
  parent: string | null;
  cycleId: string | null;
  file: string;
  sha256: string;
  bytes: number;
  features: string;
  inputs: number;
  hidden: number[];
  adapt: SafetyNet | null;
  /** SHA-256 of the network without its version name (networkSha256); null when no file was read. */
  network: { sha256: string | null; file: string | null };
  /**
   * The explorer test passed for this network: it is the network the criterion of facts.json judged
   * (and that criterion passed), or its card carries a passing explorer step of the cycle; null when
   * neither can be told (no model file read and no explorer block on the card).
   */
  explorerTested: boolean | null;
  /** The card's explorer block (the cycle's explorer step, training/cycle/zapcycle/explorer.py), summed up; null without one. */
  explorer: {
    pass: boolean;
    source: string;
    limit: number;
    network: string | null;
    verdicts: number;
    passing: number;
    worst: { explorer: string; upper95: number } | null;
  } | null;
  card: { result: string; resultAt: string | null; reason: string | null };
  gate: Record<string, unknown> & { where: Where; pass: boolean };
  personas: { pairsPerSegment: number | null; orderHolds: boolean | null; vsZap: Record<string, number> } | null;
  training: { iterations: number | null; humanModel: boolean };
  data: { validMatches: number; people: number | null } | null;
  window: { control: string | null; share: number | null; from: string; until: string | null; result: WindowResult | null } | null;
  state: ReleaseState;
  rolledBack: { at: string; to: string | null } | null;
  adaptation: { AI_ADAPT: 'on' | 'off' };
  recordedAt: string;
}

// -----------------------------------------------------------------------------------------------
// The network of a model file

const HEADER_OFFSET = 12;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The SHA-256 of a model file's network: its header with sorted keys and without meta.version, then
 * every byte of its tensors. The cycle's adopt exports a snapshot again under the next version
 * name, so the published file differs from the file that passed only in meta.version: both give
 * the same digest. parseModel checks the file first.
 */
export function networkSha256(bytes: Uint8Array): string {
  parseModel(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLen))) as { meta?: Record<string, unknown> };
  if (header.meta) delete header.meta.version;
  const dataStart = HEADER_OFFSET + headerLen + ((4 - (headerLen % 4)) % 4);
  return createHash('sha256').update(canonical(header)).update(bytes.subarray(dataStart)).digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// -----------------------------------------------------------------------------------------------
// The version in play

/** A model reads its opponents when its features are v2 and it carries a safety net (GET /api/live's rule, with AI_ADAPT on). */
export function carriesReading(features: unknown, adapt: unknown): boolean {
  return features === 'v2' && isSafetyNet(adapt);
}

export interface ServedView {
  /** The version in play. */
  version: string;
  /** ai.inPlay, null before the first record. */
  inPlay: InPlay | null;
  /** The cycle's record of the version in play; null for a bundled version. */
  cycle: CycleRelease | null;
  /** Every version the cycle published, as recorded, oldest first. */
  cycleReleases: CycleRelease[];
}

const num = (v: string) => Number(/^v(\d+)$/.exec(v)?.[1] ?? Number.NaN);

/** The cycle releases of facts.json, oldest first. */
export function cycleReleases(facts: Record<string, unknown>): CycleRelease[] {
  const releases = ((facts.ai as Record<string, unknown> | undefined)?.releases ?? {}) as Record<string, unknown>;
  return Object.values(releases)
    .filter((r): r is CycleRelease => !!r && typeof r === 'object' && (r as { origin?: unknown }).origin === 'cycle')
    .sort((a, b) => num(a.version) - num(b.version));
}

/**
 * The version in play: ai.inPlay.version when the owner recorded the cycle's manifest, else the
 * bundled model. Throws when ai.inPlay names a version facts.json has no release for.
 */
export function servedView(facts: Record<string, unknown>): ServedView {
  const ai = (facts.ai ?? {}) as Record<string, unknown>;
  const inPlay = (ai.inPlay ?? null) as InPlay | null;
  const boot = (ai.bootstrapModel ?? {}) as { version?: string };
  const all = cycleReleases(facts);
  if (!inPlay) return { version: boot.version ?? '', inPlay: null, cycle: null, cycleReleases: all };
  const releases = (ai.releases ?? {}) as Record<string, unknown>;
  const rel = releases[inPlay.version] as { origin?: string } | undefined;
  const bundled = inPlay.version === boot.version || inPlay.version === (boot as { previous?: { version?: string } }).previous?.version;
  if (!rel && !bundled) throw new Error(`ai.inPlay names ${inPlay.version}, and facts.json has no ai.releases.${inPlay.version}: record it with tools/docs/record-release.ts`);
  return { version: inPlay.version, inPlay, cycle: rel?.origin === 'cycle' ? (rel as CycleRelease) : null, cycleReleases: all };
}

/**
 * Whether the version in play reads its opponents under a given AI_ADAPT: the rule of GET /api/live
 * (AI_ADAPT on, features v2 and a finite safety net) on the file in play. A build passes the
 * AI_ADAPT of its wrangler.jsonc, which is what it deploys.
 */
export function servedReads(facts: Record<string, unknown>, aiAdapt: 'on' | 'off'): boolean {
  const view = servedView(facts);
  if (view.cycle) return aiAdapt === 'on' && carriesReading(view.cycle.features, view.cycle.adapt);
  const boot = ((facts.ai as Record<string, unknown> | undefined)?.bootstrapModel ?? {}) as { version?: string; features?: unknown; adapt?: unknown };
  if (view.inPlay && view.version !== boot.version) return false;
  return aiAdapt === 'on' && carriesReading(boot.features, boot.adapt);
}

/** The SHA-256 of the file in play: the cycle's record, else the bundled model of that version. */
export function servedSha256(facts: Record<string, unknown>): string | null {
  const view = servedView(facts);
  if (view.cycle) return view.cycle.sha256;
  const boot = ((facts.ai as Record<string, unknown> | undefined)?.bootstrapModel ?? {}) as { version?: string; sha256?: string; previous?: { version?: string; sha256?: string } };
  if (view.version === boot.version) return boot.sha256 ?? null;
  if (view.version === boot.previous?.version) return boot.previous?.sha256 ?? null;
  return null;
}
