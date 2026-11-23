// The keys of facts-view.json the two data pages read (DATA-SPEC 1.3). facts-view.json keeps every
// key the method doc and the tests need; the bundle gets only these (web/vite.config.ts,
// generatedForPages), so a phone does not download measurements no figure shows. A key the page
// starts to read goes here too: web/test/data-generated.test.ts checks that the trimmed copy gives
// every page function the same answers as the full file.
//
// The spec works like facts-view's: true copies the value, an object picks its keys, '*' applies
// to every key of the source, and on an array an object applies to every element. A key absent
// from the source stays absent (facts-view.json already wrote it as null where the page needs one).

export type PageSpec = true | { [key: string]: PageSpec };

const INTERVAL: PageSpec = { mean: true, ci95: true, pairs: true };
const GAIN: PageSpec = { mean: true, ci95: true, upper95: true, pairs: true };
// A verdict as F9 shows it: the reading part with its interval and bound, the old rule's bound.
const VERDICT: PageSpec = { explorer: true, adaptationPart: { mean: true, ci95: true, upper95: true }, gainOverTwin: { upper95: true }, pass: true, passTwinRule: true };
/** A difference the page shows with its interval only (no bound, no count). */
const SPAN: PageSpec = { mean: true, ci95: true };

export const PAGE_KEYS: PageSpec = {
  provenance: { measuredAt: true },
  missing: true,
  model: { version: true, features: true, inputs: true, hidden: true, bytes: true, weights: true },
  served: { version: true, readsOpponents: true, carried: true, rolledBack: { version: true, to: true, at: true }, judged: true, criterionSha: true },
  derived: { twinServed: true, evidenceModel: true, headToHeadJudged: true, controlJudged: true, controlTrainedOnServed: true, controlMeasuredOnOwn: true },
  ai: {
    strengthByVersion: { '*': { measuredAt: true, pairsPerSegment: true, table: { '*': { overall: INTERVAL } } } },
    personasByVersion: {
      '*': {
        measuredAt: true,
        pairsPerSegment: true,
        stats: { '*': { trucoRate: true, bluffRate: true, runRate: true, signalTruth: true, vsZap: true, vsZapSe: true, vsZapCi95: true } },
        freshCheck: { pairsPerSegment: true, vsZap: true },
      },
    },
    releases: { '*': { date: true, version: true, gate: { pass: true }, headToHeadV1: { mean: true } } },
    bootstrapModel: { version: true, createdAt: true, features: true, adapt: true, previous: { version: true, createdAt: true } },
    decisionTime: { measuredAt: true, decisionMs: { p50: true } },
    adaptation: {
      design: { alpha: true },
      priors: { measuredAt: true, alpha: true, matchesPerSegment: true, file: true, segments: { '*': { raise: true } } },
      evidence: { measuredAt: true, nW: true, pooled: true },
      safetyNet: { measuredAt: true, bmax: true, nHalf: true },
      readingCurve: { measuredAt: true, matchesPerSegment: true, styles: true },
      perStyle: {
        measuredAt: true,
        pairsPerSegment: true,
        styles: { '*': { gainVsAblated: INTERVAL, gainVsTwin: SPAN, ablatedVsTwin: SPAN, heldOut: true } },
        pooled: { allStyles: { '*': INTERVAL } },
        twinIterations: true,
      },
      headToHead: { rows: { 'adaptive-twin': SPAN, 'ablated-twin': SPAN } },
      explorer: {
        measuredAt: true,
        requirement: true,
        grid: { size: true },
        attempts: { attempt: true, pairsPerSegment: true },
        criterion: {
          measuredAt: true,
          requirement: true,
          servedModel: true,
          pass: true,
          verdicts: { scripted: { attempt: true, adapt: true, remeasureOf: true, explorers: VERDICT }, trained: VERDICT, control: VERDICT, otherTrained: { ...VERDICT, trainedAgainst: true } },
        },
        control: { fresh: { asServed: true } },
        trained: { training: { against: true } },
      },
      decisionTime: { measuredAt: true, decisionMs: { p50: true } },
      switchOnCheck: { measuredAt: true, personas: { freshCheck: { pairsPerSegment: true, vsZap: true } } },
    },
  },
  cycle: true,
};

/** The keys of `spec` that `src` has; nothing is added. */
export function pickPresent(src: unknown, spec: PageSpec): unknown {
  if (spec === true || src === null || src === undefined || typeof src !== 'object') return src;
  if (Array.isArray(src)) return src.map((x) => pickPresent(x, spec));
  const obj = src as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(spec)) {
    if (k === '*') {
      for (const [sk, sv] of Object.entries(obj)) if (!(sk in spec)) out[sk] = pickPresent(sv, sub);
    } else if (obj[k] !== undefined) out[k] = pickPresent(obj[k], sub);
  }
  return out;
}

/** facts-view.json as the pages get it. */
export function factsForPages(view: unknown): unknown {
  return pickPresent(view, PAGE_KEYS);
}
