// facts-view.json: the compact copy of facts.json that the data page reads (DATA-SPEC 2.1.1),
// keyed as in facts.json, with measuredAt kept for every block. A key absent from facts.json is
// written as null and listed in `missing`, so the page shows that figure's "not measured yet" state.
// An optional key (marked '?' below) is left out when absent and is never listed.
//
// Since the spec was written: the unversioned ai.strength, ai.personas and ai.decisionTime describe
// the v2 that ships, v1 lives in the *ByVersion keys, ai.releases.<v> holds each release, and the
// verdict of the explorer test is ai.adaptation.explorer.criterion.pass (_local/m6/claims.md). The
// old verdict ai.adaptation.explorer.pass (the rule of attempt 1) and perStyle.seedCheck's
// exceedsSeedFloor are left out on purpose: the page must not build a claim on them.
//
// Derived and added here:
//   model   the story model of tools/data/sources.json, read with parseModel: every weight and
//           bias counted, its bytes, inputs and hidden layers.
//   served  what the site serves about the reading at build time: the version in play (the bundled
//           model, or the cycle's version that tools/docs/record-release.ts recorded in ai.inPlay,
//           tools/docs/releases.ts), AI_ADAPT of wrangler.jsonc, the release's AI_ADAPT, whether
//           the file in play reads its opponents (the same rule as GET /api/live: AI_ADAPT on,
//           features v2 and a finite safety net), and the verdict of the explorer criterion. The
//           page prefers the live answer of /api/live when it has one. Also: carried, whether any
//           version the cycle published carried the reading (features v2 with a safety net), so
//           the page says "not live, only if the owner adopts it" only before any did; rolledBack,
//           the newest such version that was rolled back (its version, the version it went back
//           to and when); judged, whether the version in play is the network the explorer
//           criterion of facts.json judged (ai.releases.<v>.explorerTested and the network digest
//           equal to ai.adaptation.explorer.criterionNetwork), null when it cannot be told; and
//           criterionSha, the first 8 hex digits of the SHA-256 of the file that criterion judged,
//           so the page can name it when it judged another version.
//   derived facts the page needs but cannot compute, because the bundle drops every sha256:
//           twinServed, the twin of the reading test (perStyle.models.twin) is the served model
//           file (bootstrapModel), so the page may call that twin "the version that plays today";
//           evidenceModel, the version whose bet decisions ai.adaptation.evidence counted (its
//           method names the model file, ai/models/bootstrap/zap-<version>.zapw);
//           headToHeadJudged and controlJudged, the head to head rows and the control explorer's
//           comparison measured the file the explorer criterion judges, against the twin of
//           perStyle, so the page may set them next to its verdict; controlTrainedOnServed and
//           controlMeasuredOnOwn, the file the control explorer trained against is the served
//           model, and is the twin it was measured against.
//
// Usage: docker compose run --rm -T node node tools/data/facts-view.ts [--check]
//   --check  builds the view and compares it with web/src/data/generated/facts-view.json (the time,
//            machine and command of the run aside), writing nothing; exit code 1 when they differ.
// Any other argument is refused before anything is read or written.

import { readFileSync } from 'node:fs';
import { parseModel } from '../../ai/src/mlp.ts';
import { carriesReading, servedReads, servedView } from '../docs/releases.ts';
import { abs, isMain, provenance, readGenerated, readJson, readText, sha256File, stable, writeGenerated, type Provenance } from './lib/provenance.ts';
import { readSources, SOURCES_PATH } from './lib/sources.ts';

const SCRIPT = 'tools/data/facts-view.ts';
export const FACTS = 'facts.json';
export const WRANGLER = 'wrangler.jsonc';

/** true: copy the value; an object: pick its keys. Key '*' applies to every key of the source; a
 * key starting with '?' is optional. On an array, an object spec applies to every element. */
export type Spec = true | { [key: string]: Spec };

const INTERVAL: Spec = { mean: true, ci95: true, pairs: true };
const GAIN: Spec = { mean: true, ci95: true, upper95: true, pairs: true };
const STRENGTH: Spec = {
  measuredAt: true,
  pairsPerSegment: true,
  model: true,
  table: { '*': { overall: INTERVAL, segments: { '*': INTERVAL } } },
};
const PERSONAS: Spec = {
  measuredAt: true,
  model: true,
  pairsPerSegment: true,
  stats: { '*': { trucoRate: true, bluffRate: true, runRate: true, reraiseRate: true, signalTruth: true, vsZap: true, vsZapSe: true, '?vsZapCi95': true, hands: true } },
  order: true,
  '?margin': { required: true, otavio: true, iara: true, holds: true },
  '?freshCheck': { pairsPerSegment: true, order: true, margins: true, vsZap: { '*': { mean: true, ci95: true } } },
  '?styleSeparationCi95': { measuredAt: true, target: true, atTarget: true },
};
const VERDICT: Spec = { explorer: true, adaptationPart: GAIN, gainOverTwin: GAIN, basePart: GAIN, pass: true, passTwinRule: true };
/** An explorer trained for an earlier file and measured against the judged one: its verdict and the net it trained against. */
const OTHER_VERDICT: Spec = { ...VERDICT, '?trainedAgainst': { adapt: true } };
const GATE: Spec = {
  stats: true,
  pass: true,
  sprt: { decision: true, pairs: true, mean: true },
  segments: { '*': { pairs: true, mean: true } },
  panel: { member: true, pairs: true, candidate: true, current: true, diff: true, pass: true },
};

export const KEYS: Spec = {
  ai: {
    strength: STRENGTH,
    strengthByVersion: { '*': STRENGTH },
    personas: PERSONAS,
    personasByVersion: { '*': PERSONAS },
    bootstrapModel: { version: true, bytes: true, sha256: true, inputs: true, hidden: true, features: true, adapt: true, createdAt: true, previous: { version: true, bytes: true, inputs: true, hidden: true } },
    decisionTime: { measuredAt: true, model: true, features: true, decisionMs: { p50: true, p99: true }, roomEventMs: { p99: true } },
    decisionTimeByVersion: { '*': { measuredAt: true, model: true, decisionMs: { p50: true, p99: true }, '?roomEventMs': { p99: true } } },
    releases: {
      '*': {
        date: true,
        version: true,
        file: true,
        sha256: true,
        features: true,
        gate: GATE,
        // A version the cycle published (tools/docs/record-release.ts) has no head to head row of
        // its own against v1: the You page then reads its anchors from the cycle's summary.
        '?headToHeadV1': true,
        adaptation: { AI_ADAPT: true },
      },
    },
    adaptation: {
      design: { measuredAt: true, inputs: true, statsPerSeat: true, statsSlots: true, rates: true, alpha: true, countingRule: true },
      matchLength: { measuredAt: true, segments: { '*': { mean: true, p50: true, p90: true, matches: true } } },
      evidence: {
        measuredAt: true,
        pooled: { betDecisions: true, share: true, medianPositive: true },
        segments: { '*': { betDecisions: true, medianByHand: true } },
        nW: true,
      },
      priors: { measuredAt: true, alpha: true, matchesPerSegment: true, file: true, segments: { '*': { raise: true, run: true, accept: true, reraise: true, shown: true, cover: true } } },
      safetyNet: { measuredAt: true, model: true, bmax: true, nHalf: true, flagged: true, stage2: { setting: true, bmax: true, nHalf: true, lambdaBelow1Share: true, topChangedShare: true, decisions: true } },
      perStyle: {
        measuredAt: true,
        pairsPerSegment: true,
        styles: { '*': { gainVsAblated: GAIN, gainVsTwin: GAIN, ablatedVsTwin: GAIN, heldOut: true } },
        pooled: { '*': { gainVsAblated: GAIN, gainVsTwin: GAIN, ablatedVsTwin: GAIN, seedFloor: GAIN } },
        seedCheck: { note: true },
        // Training iterations of the twin and of the second twin: a seed floor only when they match.
        '?twinIterations': true,
      },
      headToHead: { measuredAt: true, rows: { '*': INTERVAL } },
      ablation: {
        measuredAt: true,
        pooledGain: GAIN,
        headToHead: INTERVAL,
        offPolicy: { pooledAblatedMinusTwin: GAIN, headToHead: INTERVAL, servesAdaptiveWhileOff: true },
      },
      explorer: {
        measuredAt: true,
        grid: { size: true, searched: true, styles: true, handSwitches: true, evidenceSwitches: true, partner: true },
        chosen: true,
        chosenInTraining: true,
        searchRankedBy: true,
        freshGain: GAIN,
        split: { adaptationPart: GAIN, basePart: GAIN },
        outsideTraining: true,
        requirement: true,
        passTwinRule: true,
        passAdaptationPart: true,
        attempts: {
          attempt: true,
          explorer: true,
          searchRankedBy: true,
          adapt: true,
          pairsPerSegment: true,
          gain: GAIN,
          adaptationPart: GAIN,
          passTwinRule: true,
          passAdaptationPart: true,
          '?outside': { explorer: true, gain: GAIN, adaptationPart: GAIN, passTwinRule: true, passAdaptationPart: true },
        },
        criterion: {
          measuredAt: true,
          primary: true,
          requirement: true,
          '?servedModel': { adapt: true },
          pass: true,
          passTwinRule: true,
          verdicts: {
            scripted: { attempt: true, searchRankedBy: true, adapt: true, '?remeasureOf': { attempt: true }, explorers: VERDICT },
            trained: VERDICT,
            control: VERDICT,
            '?otherTrained': OTHER_VERDICT,
          },
        },
        trained: {
          measuredAt: true,
          training: { iterations: true, ppoIterations: true, minutes: true, checks: { iteration: true, vsAdaptive: true }, '?against': { adapt: true } },
          fresh: { pairsPerSegment: true, adaptationPart: GAIN, gainOverTwin: GAIN, basePart: GAIN, seedFloorSeenByExplorer: GAIN },
        },
        control: {
          measuredAt: true,
          training: { ppoIterations: true, minutes: true },
          fresh: {
            pairsPerSegment: true,
            control: { scores: { vsAdaptive: INTERVAL, vsTwin: INTERVAL } },
            trained: { scores: { vsAdaptive: INTERVAL, vsAblated: INTERVAL, vsTwin: INTERVAL } },
            asServed: GAIN,
            base: GAIN,
            crossControlVsAdaptiveMinusTwin: GAIN,
          },
        },
      },
      readingCurve: { measuredAt: true, model: true, matchesPerSegment: true, styles: { '*': { bet: { '*': { changedShare: true, meanN: true, decisions: true } } } } },
      personasV2: { measuredAt: true, model: true, orderHolds: true, vsZap: { '*': { mean: true, se: true } }, note: true },
      decisionTime: { measuredAt: true, model: true, decisionMs: { p50: true, p99: true }, roomEventMs: { p99: true }, targetEventP99Ms: true, meetsTarget: true },
      warmStart: { measuredAt: true, pass: true, v2: { matches: true, decisions: true, mismatches: true, maxLogitDiff: true } },
      training: { runs: { '*': { run: true, features: true, iterations: true, hours: true } } },
      switchOnCheck: {
        date: true,
        measuredAt: true,
        decision: true,
        explorerCriterionPass: true,
        gate: GATE,
        personas: { orderHolds: true, freshCheck: { pairsPerSegment: true, vsZap: { '*': { mean: true, ci95: true } } } },
      },
    },
  },
  // Pending from the cycle (_local/m6/PENDING-AFTER-RUNS.md, P1 wait 5): absent until measured.
  cycle: { gate: { seconds: true }, ab: { detectablePoints: true }, train: { secondsPerIteration: true } },
  worker: {
    brake: {
      budget: true,
      ledgerRows: true,
      measured: { date: true, solo: { matches: true, handsMean: true, match: true }, room4: { matches: true, handsMean: true, match: true } },
    },
  },
};

/** Copies the keys of `spec` from `src`; absent keys become null and are listed in `missing`. */
export function pick(src: unknown, spec: Spec, path: string, missing: string[]): unknown {
  if (spec === true) {
    if (src === undefined) {
      missing.push(path);
      return null;
    }
    return structuredClone(src);
  }
  const entries = Object.entries(spec);
  if (src === undefined) {
    if (entries.some(([k]) => k === '*')) {
      missing.push(path);
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const [k, sub] of entries) if (!k.startsWith('?')) out[k] = pick(undefined, sub, `${path}.${k}`, missing);
    return out;
  }
  if (src === null) return null;
  if (Array.isArray(src)) return src.map((x, i) => pick(x, spec, `${path}[${i}]`, missing));
  if (typeof src !== 'object') throw new Error(`facts-view: ${path} is ${JSON.stringify(src)}, expected an object`);
  const obj = src as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, sub] of entries) {
    if (k === '*') {
      for (const [sk, sv] of Object.entries(obj)) if (!(sk in spec) && !(`?${sk}` in spec)) out[sk] = pick(sv, sub, `${path}.${sk}`, missing);
    } else if (k.startsWith('?')) {
      const key = k.slice(1);
      if (obj[key] !== undefined) out[key] = pick(obj[key], sub, `${path}.${key}`, missing);
    } else out[k] = pick(obj[k], sub, `${path}.${k}`, missing);
  }
  return out;
}

/**
 * Rounds every number to 5 decimals, except that a value that would round to 0 keeps 3 significant
 * digits, so no interval end changes sign. DATA-SPEC 2.1 says 4, but the page shows differences of
 * mean score as games per 100 with one decimal (0.0001 of a share is 0.01 of a game): at 4 decimals
 * the page rounded twice, and a one sided bound of 0.01046 became 0.0105, said as 1.1 instead of 1.0.
 */
export function roundDeep(v: unknown): unknown {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Number.isInteger(v)) return v;
    const r = Math.round(v * 1e5) / 1e5;
    if (r === 0) return Number(v.toPrecision(3));
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
  return v;
}

/** AI_ADAPT of wrangler.jsonc: exactly one `"AI_ADAPT": "on" | "off"` line. */
export function wranglerAiAdapt(): 'on' | 'off' {
  const found = [...readText(WRANGLER).matchAll(/"AI_ADAPT"\s*:\s*"([a-z]+)"/g)].map((m) => m[1]);
  if (found.length !== 1 || (found[0] !== 'on' && found[0] !== 'off')) throw new Error(`${WRANGLER}: expected one AI_ADAPT of "on" or "off", found ${JSON.stringify(found)}`);
  return found[0];
}

export interface ModelView {
  version: string;
  path: string;
  sha256: string;
  features: string;
  inputs: number;
  hidden: number[];
  bytes: number;
  /** Every weight and bias of the network. */
  weights: number;
}

export function modelView(): ModelView {
  const { storyModel } = readSources();
  const bytes = readFileSync(abs(storyModel.path));
  const m = parseModel(bytes);
  const layers = [...m.trunk, m.policy, m.value];
  const weights = layers.reduce((n, l) => n + l.rows * l.cols + l.bias.length, 0);
  return { version: storyModel.version, path: storyModel.path, sha256: sha256File(storyModel.path), features: m.header.features, inputs: m.header.inputs, hidden: [...m.header.hidden], bytes: bytes.byteLength, weights };
}

export interface FactsView {
  provenance: Provenance;
  missing: string[];
  model: ModelView;
  served: {
    version: string | null;
    AI_ADAPT: 'on' | 'off';
    releaseAI_ADAPT: string | null;
    readsOpponents: boolean;
    explorerCriterionPass: boolean | null;
    /** Some version the cycle published carried the reading (features v2 with a safety net). */
    carried: boolean;
    /** The newest version carrying the reading that was rolled back (at: ms), null when none was. */
    rolledBack: { version: string; to: string | null; at: number } | null;
    /** The version in play is the network the explorer criterion judged; null when it cannot be told. */
    judged: boolean | null;
    /** The first 8 hex digits of the SHA-256 of the file the explorer criterion judged. */
    criterionSha: string | null;
  };
  derived: {
    twinServed: boolean | null;
    evidenceModel: string | null;
    /** The head to head rows measured the file the explorer criterion judges, against the twin of perStyle. */
    headToHeadJudged: boolean | null;
    /** The control explorer's comparison measured the judged file, against the twin of perStyle. */
    controlJudged: boolean | null;
    /** The control explorer trained against the served model file (bootstrapModel). */
    controlTrainedOnServed: boolean | null;
    /** The control explorer was measured against the file it trained against. */
    controlMeasuredOnOwn: boolean | null;
  };
  ai: Record<string, unknown>;
  cycle: Record<string, unknown>;
  worker: Record<string, unknown>;
}

/** The version named by the model file in a method text (ai/models/bootstrap/zap-v1.zapw is v1), or null. */
export function modelInMethod(method: unknown): string | null {
  if (typeof method !== 'string') return null;
  const found = [...new Set([...method.matchAll(/ai\/models\/bootstrap\/zap-(v\d+)\.zapw/g)].map((m) => m[1]))];
  return found.length === 1 ? found[0] : null;
}

/** The view's `served` block for a facts.json and the AI_ADAPT of the wrangler.jsonc a build deploys. */
export function servedBlock(facts: Record<string, any>, aiAdapt: 'on' | 'off'): FactsView['served'] {
  const view = servedView(facts);
  const version: string | null = view.version ? view.version : null;
  const release = version ? facts.ai?.releases?.[version] : undefined;
  const ex = facts.ai?.adaptation?.explorer;
  const pass = ex?.criterion?.pass;
  const carrying = view.cycleReleases.filter((r) => carriesReading(r.features, r.adapt));
  const rolled = carrying.filter((r) => r.state === 'rolled-back' && typeof r.rolledBack?.at === 'string').sort((a, b) => Date.parse(b.rolledBack!.at) - Date.parse(a.rolledBack!.at))[0];
  const judgedNet = ex?.criterionNetwork?.networkSha256;
  const inPlayNet = release?.network?.sha256;
  const servedSha = ex?.criterion?.servedModel?.sha256;
  return {
    version,
    AI_ADAPT: aiAdapt,
    releaseAI_ADAPT: typeof release?.adaptation?.AI_ADAPT === 'string' ? release.adaptation.AI_ADAPT : null,
    readsOpponents: servedReads(facts, aiAdapt),
    explorerCriterionPass: typeof pass === 'boolean' ? pass : null,
    carried: carrying.length > 0,
    rolledBack: rolled ? { version: rolled.version, to: rolled.rolledBack!.to, at: Date.parse(rolled.rolledBack!.at) } : null,
    judged: release?.origin === 'cycle' ? (typeof judgedNet === 'string' && typeof inPlayNet === 'string' ? release.explorerTested === true && inPlayNet === judgedNet : null) : null,
    criterionSha: typeof servedSha === 'string' ? servedSha.slice(0, 8) : null,
  };
}

export function buildFactsView(): FactsView {
  const { storyModel } = readSources();
  const facts = readJson<Record<string, any>>(FACTS);
  const missing: string[] = [];
  const picked = roundDeep(pick(facts, KEYS, '', missing)) as Record<string, Record<string, unknown>>;
  const model = modelView();
  const boot = facts.ai?.bootstrapModel ?? null;
  const inPlay = servedView(facts).version;
  const version: string | null = inPlay ? inPlay : null;
  const aiAdapt = wranglerAiAdapt();
  const ad = facts.ai?.adaptation;
  const perStyle = ad?.perStyle;
  const twinSha = perStyle?.models?.twin?.sha256;
  const h2h = ad?.headToHead;
  const control = ad?.explorer?.control;
  const servedPath = ad?.explorer?.criterion?.servedModel?.path;
  const servedSha = ad?.explorer?.criterion?.servedModel?.sha256;
  /** a === b for two strings; null when either is missing. */
  const same = (a: unknown, b: unknown): boolean | null => (typeof a === 'string' && typeof b === 'string' ? a === b : null);
  /** Both checks hold; null when either could not be made. */
  const both = (a: boolean | null, b: boolean | null): boolean | null => (a === null || b === null ? null : a && b);
  return {
    provenance: provenance(SCRIPT, [FACTS, WRANGLER, storyModel.path, storyModel.manifest, SOURCES_PATH, SCRIPT]),
    missing: missing.map((p) => p.replace(/^\./, '')),
    model,
    served: servedBlock(facts, aiAdapt),
    derived: {
      twinServed: typeof twinSha === 'string' && typeof boot?.sha256 === 'string' ? twinSha === boot.sha256 : null,
      evidenceModel: modelInMethod(facts.ai?.adaptation?.evidence?.method),
      headToHeadJudged: both(same(h2h?.adaptive, servedPath), same(h2h?.twin, perStyle?.twin)),
      controlJudged: both(same(control?.models?.adaptive?.sha256, servedSha), same(control?.models?.twin?.sha256, twinSha)),
      controlTrainedOnServed: same(control?.training?.against?.sha256, boot?.sha256),
      controlMeasuredOnOwn: same(control?.training?.against?.sha256, control?.models?.twin?.sha256),
    },
    ai: picked.ai,
    cycle: picked.cycle,
    worker: picked.worker,
  };
}

/** The arguments of the command line: --check alone, or nothing. */
export function parseArgs(argv: readonly string[]): { check: boolean } {
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length) throw new Error(`unknown argument ${unknown.join(' ')} (usage: tools/data/facts-view.ts [--check])`);
  return { check: argv.includes('--check') };
}

if (isMain(import.meta.url)) {
  let args: { check: boolean };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const view = buildFactsView();
  if (args.check) {
    const same = JSON.stringify(stable(view)) === JSON.stringify(stable(readGenerated<FactsView>('facts-view.json') ?? { provenance: undefined }));
    console.log(same ? 'facts-view.json agrees with facts.json' : 'facts-view.json differs from what facts.json gives: run tools/data/facts-view.ts');
    process.exit(same ? 0 : 1);
  }
  console.log(`wrote ${writeGenerated('facts-view.json', view)}`);
  if (view.missing.length) console.log(`missing in facts.json (written as null): ${view.missing.join(', ')}`);
}
