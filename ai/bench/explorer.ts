// Explorer test: can an opponent that fakes a pattern and then switches gain from the network's
// reading of it? The explorer team runs style a, then style b (ai/src/styles.ts), switching at
// hand k or once its seat has shown k betting events (what the network reads); in 2 against 2 its
// partner runs the same schedule or plays as v1 Zap.
//
// Gain of an explorer = score(explorer vs adaptive) minus score(explorer vs twin), pair by pair.
// Adaptation part = score(explorer vs adaptive) minus score(explorer vs ablated), pair by pair: the
// primary quantity of the explorer test since 2026-11-22 (ai.adaptation.explorer.criterion).
//
// --stage search  on selection deals (seed e5): --pool all (default) searches the original grid of
//                 1,008 explorers (8 styles for a, the 7 others for b, switch at hand 1, 2, 3, 4, 6
//                 or 8 or after 2, 4 or 8 betting events, two partner options) and the fresh family
//                 of 264 (three phases, back and forth, held-out styles, each seat on its own
//                 schedule: explorer-grid.ts); --pool grid only the first (attempts 1 to 4),
//                 --pool fresh only the second. Successive halving on the same two players: 4
//                 rounds of 64, 256, 1,024 and 4,096 pooled pairs per candidate per player, each
//                 round on new pairs, estimates adding up, the best quarter kept (then the best
//                 one). In 1 against 1 the partner option changes nothing, so the options share
//                 those games. Candidates inside the family of switching players the adaptive
//                 network met in training (styles.ts inTrainingFamily, with the family read from the
//                 run's args.json by league.ts trainingFamilyOf: since the feints fine-tune trains
//                 against feints, the whole original grid is inside) are marked, and the best
//                 explorer from outside it is reported apart.
//                 --baseline twin (attempt 1) ranks by the gain over the twin; --baseline ablated
//                 ranks by the adaptation part (the second player is the adaptive file with the
//                 statistics at no evidence). Each attempt's search starts after the last pair an
//                 earlier search in the same folder, or in a folder named by --after, played, so no
//                 two searches share deals.
// --stage fresh   the chosen explorer on fresh deals (seed f7), and the best explorer from outside
//                 the training family when the chosen one is inside it: three players (adaptive,
//                 twin, ablated). Each attempt plays deals no earlier attempt played (offsets
//                 after the last attempt's, in the same folder and in the folders of --after).
//                 For every explorer measured it also records playedOutsideTraining: of its fresh
//                 matches against each player, how many a training draw of the adaptive network's
//                 family does not play exactly, seat by seat and hand by hand (styles.ts
//                 explorerMatchInFamily). A label outside the family says little when the part
//                 that makes it so rarely plays. Pass under the rule of attempt 1 (pass, passTwinRule):
//                 for every explorer measured, one-sided 95% upper bound of the gain over the twin
//                 at most 1 point. passAdaptationPart: the same bound on the adaptation part (the
//                 criterion of ai.adaptation.explorer.criterion). The gain is split in an
//                 adaptation part (adaptive vs ablated) and a base part (ablated vs twin): the
//                 safety net can only shrink the first.
//                 --remeasure with --spec: the explorers of an earlier search, made against another
//                 adaptive file (another safety net, or another network), measured again against
//                 this file on fresh deals (no new search). The attempt records remeasureOf (the
//                 search, its attempt and its net), so the criterion can judge every explorer found
//                 so far against the file that would be served. Without --remeasure the search must
//                 have played this very file (SHA-256; the net for search files without provenance).
//
// The adaptive file must carry its safety net (meta.adapt). The fresh stage writes
// ai.adaptation.explorer in facts.json with --write-facts (every attempt in the same eval folder
// is listed).
//
// Usage:
//   node ai/bench/explorer.ts --stage search --adaptive A --twin T [--pool all|grid|fresh] [--baseline twin|ablated] [--seed e5] [--threads 4] [--round-pairs 64] [--grid-limit N] [--attempt 1] [--after <eval dir>[,...]] [--out file]
//   node ai/bench/explorer.ts --stage fresh --adaptive A --twin T [--spec <search.json>] [--remeasure] [--pairs 2000] [--seed f7] [--threads 4] [--attempt 1] [--after <eval dir>[,...]] [--out file] [--write-facts]

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pairedSummary } from '../src/evaluate.ts';
import { trainingFamilyOf } from '../src/league.ts';
import { EXPLORER_STYLES, explorerLabel, inTrainingFamily as inFamily, soloSpec, type ExplorerSpec, type TrainingFamily } from '../src/styles.ts';
import { ablatedArm, adaptiveArm, twinArm } from './arms.ts';
import { EVIDENCE_SWITCHES, FRESH_FAMILY, HAND_SWITCHES, freshFamily, grid, searchPool, type SearchPool } from './explorer-grid.ts';
import { SEGMENTS, arg, evalOut, flag, loadModel, machine, modelHashes, modelProvenance, numArg, provenance, readJson, requireSafetyNet, round, saveResult, seedArg, segmentConfig, sha256File } from './bench-util.ts';
import { runPairTasks, type AgentSpec, type PairJob, type RealizedCount } from './parallel.ts';

const stage = arg('stage');
const A = arg('adaptive');
const T = arg('twin');
if (!A || !T) throw new Error('--adaptive and --twin are required');
requireSafetyNet(A);
const threads = numArg('threads', 4);
const attempt = numArg('attempt', 1);
const t0 = performance.now();
const progress = (d: number, n: number) => {
  if (d % 100 === 0 || d === n) process.stderr.write(`explorer ${stage}: ${d}/${n} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
};
const fmt = (p: ReturnType<typeof pairedSummary>) => ({ mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), upper95: round(p.upper95, 5), pairs: p.pairs });
const adaptOf = (path: string) => loadModel(path).header.meta?.adapt ?? null;
const models = { adaptive: A, twin: T };
/** What the adaptive network met in training, from its run's args.json (styles.ts TrainingFamily). */
const family = trainingFamilyOf(modelProvenance(A).run.args);
const inTrainingFamily = (e: ExplorerSpec) => inFamily(e, family);
/** Earlier eval folders (another adaptive file's) whose searches and attempts this one must not reuse deals from. */
const afterDirs = (arg('after', '') ?? '').split(',').filter(Boolean);
for (const d of afterDirs) if (!existsSync(d)) throw new Error(`--after ${d}: no such folder`);

const ROUNDS = 4;
const REQUIREMENT = 0.01;
type Baseline = 'twin' | 'ablated';
const baselineArg = (): Baseline => {
  const b = arg('baseline', 'twin');
  if (b !== 'twin' && b !== 'ablated') throw new Error('--baseline twin|ablated');
  return b;
};

/** Pairs per segment a search played: the sum of its rounds (each round on new pairs). */
const searchPairsPerSegment = (s: { rounds: { pairsPerCandidatePerArm: number }[] }) => s.rounds.reduce((a, r) => a + Math.max(1, Math.round(r.pairsPerCandidatePerArm / SEGMENTS.length)), 0);

/** In 1 against 1 there is no partner: every partner option plays the games of its schedule with 'same'. */
const jobLabel = (e: ExplorerSpec, players: number) => explorerLabel(players === 2 ? soloSpec(e) : e);

/**
 * Scores of each explorer against each arm, pooled over segments (segment order, then pair order).
 * With `realized`, also the count of its matches per arm and segment that a training draw of that
 * family plays exactly, into `realizedOut` (explorer label, then arm, then segment).
 */
async function play(
  cands: ExplorerSpec[],
  arms: Record<string, AgentSpec>,
  seed: string,
  offset: number,
  perSegment: number,
  realized?: TrainingFamily,
  realizedOut?: Map<string, Record<string, Record<string, RealizedCount>>>,
): Promise<Map<string, Record<string, number[]>>> {
  const jobs = new Map<string, PairJob>();
  for (const e of cands)
    for (const [arm, spec] of Object.entries(arms))
      for (const segment of SEGMENTS) {
        const label = jobLabel(e, segmentConfig(segment).players);
        const key = `${label}|${arm}|${segment}`;
        if (!jobs.has(key)) jobs.set(key, { key, segment, baseSeed: seed, offset, pairs: perSegment, a: { kind: 'explorer', spec: label === explorerLabel(e) ? e : soloSpec(e) }, b: spec, ...(realized ? { realized } : {}) });
      }
  const res = await runPairTasks([...jobs.values()], threads, Math.max(8, Math.min(32, perSegment)), progress);
  const out = new Map<string, Record<string, number[]>>();
  for (const e of cands) {
    const r: Record<string, number[]> = {};
    for (const arm of Object.keys(arms)) r[arm] = SEGMENTS.flatMap((g) => res.get(`${jobLabel(e, segmentConfig(g).players)}|${arm}|${g}`)!.scores);
    out.set(explorerLabel(e), r);
    if (realized && realizedOut)
      realizedOut.set(
        explorerLabel(e),
        Object.fromEntries(Object.keys(arms).map((arm) => [arm, Object.fromEntries(SEGMENTS.map((g) => [g, res.get(`${jobLabel(e, segmentConfig(g).players)}|${arm}|${g}`)!.realized!]))])),
      );
  }
  return out;
}

/**
 * playedOutsideTraining of one explorer: per player and segment, its fresh matches and those whose
 * realized play left every training draw of the family; share is that count over the matches,
 * pooled over the segments (adaptive: the matches against the adaptive network, the headline).
 */
function outsideSummary(r: Record<string, Record<string, RealizedCount>>) {
  const cell = (c: RealizedCount) => ({ matches: c.matches, outside: c.matches - c.inFamily, share: c.matches ? round((c.matches - c.inFamily) / c.matches, 4) : null });
  const byArm = Object.fromEntries(
    Object.entries(r).map(([arm, segs]) => {
      const all = Object.values(segs).reduce((a, c) => ({ matches: a.matches + c.matches, inFamily: a.inFamily + c.inFamily }), { matches: 0, inFamily: 0 });
      return [arm, { ...cell(all), perSegment: Object.fromEntries(Object.entries(segs).map(([g, c]) => [g, cell(c)])) }];
    }),
  );
  return { rule: 'styles.ts explorerMatchInFamily', share: byArm.adaptive?.share ?? null, byArm };
}

const measuredAt = new Date().toISOString();

interface RoundView {
  round: number;
  candidates: number;
  pairsPerCandidatePerArm: number;
  kept: number;
  top: { explorer: string; inTraining: boolean; gain: ReturnType<typeof fmt> }[];
  bestOutside: { explorer: string; spec: ExplorerSpec; gain: ReturnType<typeof fmt> } | null;
}

if (stage === 'search') {
  const seedHex = arg('seed', 'e5')!;
  const seed = seedArg('seed', 'e5');
  const base = numArg('round-pairs', 64);
  const limit = numArg('grid-limit', 0);
  const out = arg('out', evalOut(A, `explorer-search-${attempt}`))!;
  const baseline = baselineArg();
  const pool = arg('pool', 'all') as SearchPool;
  if (!['all', 'grid', 'fresh'].includes(pool)) throw new Error('--pool all|grid|fresh');
  // New selection deals for every attempt: start after the last pair an earlier search played,
  // in this folder or in the folders of --after.
  const sdir = dirname(out);
  const earlierSearches = [sdir, ...afterDirs].flatMap((d) =>
    existsSync(d)
      ? readdirSync(d)
          .filter((f) => /^explorer-search-\d+\.json$/.test(f) && join(d, f) !== out)
          .map((f) => readJson<{ seed: string; offset?: number; rounds: { pairsPerCandidatePerArm: number }[] }>(join(d, f)))
          .filter((s) => s.seed === seedHex)
      : [],
  );
  const startOffset = Math.max(0, ...earlierSearches.map((s) => (s.offset ?? 0) + searchPairsPerSegment(s)));
  let cands = searchPool(pool);
  const gridSize = cands.length;
  const inTrainingCount = cands.filter(inTrainingFamily).length;
  if (limit > 0) cands = cands.filter((_, i) => i % Math.ceil(gridSize / limit) === 0).slice(0, limit);
  const searched = cands.length;
  const arms = { adaptive: adaptiveArm(A), baseline: baseline === 'ablated' ? ablatedArm(A) : twinArm(T) };
  const acc = new Map<string, Record<string, number[]>>();
  const rounds: RoundView[] = [];
  let offset = startOffset;
  let pairsPlayed = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const pooled = base * 4 ** r;
    const perSegment = Math.max(1, Math.round(pooled / SEGMENTS.length));
    const res = await play(cands, arms, seed, offset, perSegment);
    offset += perSegment;
    for (const [k, v] of res) {
      const prev = acc.get(k);
      if (!prev) acc.set(k, { adaptive: [...v.adaptive], baseline: [...v.baseline] });
      else {
        prev.adaptive.push(...v.adaptive);
        prev.baseline.push(...v.baseline);
      }
    }
    pairsPlayed += cands.length * 2 * perSegment * SEGMENTS.length;
    const ranked = cands.map((e) => ({ e, g: pairedSummary(acc.get(explorerLabel(e))!.adaptive, acc.get(explorerLabel(e))!.baseline) })).sort((x, y) => y.g.mean - x.g.mean);
    const keep = r < ROUNDS - 1 ? Math.max(1, Math.floor(cands.length / 4)) : 1;
    const outside = ranked.find((x) => !inTrainingFamily(x.e));
    rounds.push({
      round: r + 1,
      candidates: cands.length,
      pairsPerCandidatePerArm: perSegment * SEGMENTS.length,
      kept: keep,
      top: ranked.slice(0, 10).map((x) => ({ explorer: explorerLabel(x.e), inTraining: inTrainingFamily(x.e), gain: fmt(x.g) })),
      bestOutside: outside ? { explorer: explorerLabel(outside.e), spec: outside.e, gain: fmt(outside.g) } : null,
    });
    cands = ranked.slice(0, keep).map((x) => x.e);
    process.stderr.write(`round ${r + 1}: best ${explorerLabel(ranked[0].e)} ${baseline === 'ablated' ? 'adaptation part' : 'gain'} ${ranked[0].g.mean.toFixed(4)}\n`);
  }
  const chosen = cands[0];
  const sel = acc.get(explorerLabel(chosen))!;
  // The best explorer from outside the training family, from the latest round that had one.
  const outside = [...rounds].reverse().find((r) => r.bestOutside)?.bestOutside ?? null;
  const result = {
    stage: 'search',
    measuredAt,
    adaptive: A,
    twin: T,
    adapt: adaptOf(A),
    seed: seedHex,
    baseline,
    pool,
    poolSizes: { grid: pool === 'fresh' ? 0 : grid().length, fresh: pool === 'grid' ? 0 : freshFamily().length },
    trainingFamily: family,
    after: afterDirs,
    ranking: baseline === 'ablated' ? 'adaptation part: score against the adaptive network minus score against the ablated network' : 'gain over the twin: score against the adaptive network minus score against the twin',
    offset: startOffset,
    gridSize,
    gridInTrainingFamily: inTrainingCount,
    gridSearched: searched,
    roundPairs: base,
    pairsPlayedUpperBound: pairsPlayed,
    rounds,
    chosen,
    chosenLabel: explorerLabel(chosen),
    chosenInTraining: inTrainingFamily(chosen),
    selectionGain: fmt(pairedSummary(sel.adaptive, sel.baseline)),
    bestOutside: outside,
    seconds: (performance.now() - t0) / 1000,
    ...machine(),
    provenance: provenance(models),
    facts: {},
  };
  saveResult(out, result, false);
  console.log(JSON.stringify({ out, baseline, offset: startOffset, chosen: result.chosenLabel, inTraining: result.chosenInTraining, selectionGain: result.selectionGain, bestOutside: outside?.explorer ?? null }, null, 2));
} else if (stage === 'fresh') {
  const seedHex = arg('seed', 'f7')!;
  const seed = seedArg('seed', 'f7');
  const pairs = numArg('pairs', 2000);
  const specPath = arg('spec', evalOut(A, `explorer-search-${attempt}`))!;
  const search = readJson<{
    chosen: ExplorerSpec;
    chosenInTraining: boolean;
    selectionGain: unknown;
    bestOutside: { spec: ExplorerSpec; gain: unknown } | null;
    rounds: unknown[];
    gridSize: number;
    gridSearched: number;
    seed: string;
    adapt: unknown;
    baseline?: Baseline;
    offset?: number;
    pool?: SearchPool;
    poolSizes?: { grid: number; fresh: number };
    provenance?: { models?: { adaptive?: { sha256?: string } } };
  }>(specPath);
  const baseline: Baseline = search.baseline ?? 'twin';
  const remeasure = flag('remeasure');
  // The same adaptive file: by SHA-256 when the search file has provenance, by safety net otherwise.
  const searchSha = search.provenance?.models?.adaptive?.sha256;
  const sameFile = searchSha ? searchSha === sha256File(A) : JSON.stringify(search.adapt) === JSON.stringify(adaptOf(A));
  if (!sameFile && !remeasure) throw new Error(`${specPath} searched against another adaptive file (SHA-256 ${searchSha?.slice(0, 8) ?? 'unknown'}, safety net ${JSON.stringify(search.adapt)}); run the search for this file first, or pass --remeasure to measure that search's explorers again`);
  if (remeasure && sameFile) throw new Error(`--remeasure: ${specPath} searched against this file already; run a plain fresh stage`);
  const searchAttempt = Number(/explorer-search-(\d+)\.json$/.exec(specPath)?.[1] ?? NaN);
  const remeasureOf = remeasure ? { attempt: Number.isFinite(searchAttempt) ? searchAttempt : null, search: specPath, adapt: search.adapt } : null;
  const out = arg('out', join(dirname(specPath), `explorer-fresh-${attempt}.json`))!;
  const dir = dirname(out);
  interface ExplorerView {
    explorer: string;
    gain: ReturnType<typeof fmt>;
    adaptationPart?: ReturnType<typeof fmt>;
    pass: boolean;
    passTwinRule?: boolean;
    passAdaptationPart?: boolean;
    /** Share of its fresh matches against the adaptive network that no training draw plays exactly. */
    playedOutsideTraining?: number | null;
  }
  interface AttemptView extends ExplorerView {
    attempt: number;
    adapt: unknown;
    searchRankedBy?: Baseline;
    offset: number;
    pairsPerSegment: number;
    outside?: ExplorerView | null;
    /** A re-measure of an earlier search's explorers against this file (--remeasure). */
    remeasureOf?: { attempt: number | null; search: string; adapt: unknown } | null;
  }
  /** An attempt as stored, completed with the adaptation part of its result file (attempt 1 predates those fields). */
  const stored = (f: string): AttemptView | null => {
    const r = readJson<{ attempt: AttemptView; facts?: { explorer?: { split?: { adaptationPart: ReturnType<typeof fmt> }; outsideTraining?: { split: { adaptationPart: ReturnType<typeof fmt> } } | null } } }>(join(dir, f));
    if (!r.attempt) return null;
    const e = r.facts?.explorer;
    const fill = (x: ExplorerView, part: ReturnType<typeof fmt> | undefined): ExplorerView => {
      const adaptationPart = x.adaptationPart ?? part;
      return { ...x, adaptationPart, passTwinRule: x.passTwinRule ?? x.gain.upper95 <= REQUIREMENT, passAdaptationPart: x.passAdaptationPart ?? (adaptationPart ? adaptationPart.upper95 <= REQUIREMENT : undefined) };
    };
    const a = r.attempt;
    return { ...a, ...fill(a, e?.split?.adaptationPart), searchRankedBy: a.searchRankedBy ?? 'twin', outside: a.outside ? fill(a.outside, e?.outsideTraining?.split.adaptationPart) : (a.outside ?? null) };
  };
  const earlier: AttemptView[] = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^explorer-fresh-\d+\.json$/.test(f) && f !== `explorer-fresh-${attempt}.json`)
        .map(stored)
        .filter((x): x is AttemptView => x !== null)
    : [];
  // Attempts in the folders of --after (another adaptive file's): their deals are not reused either.
  const before = afterDirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => /^explorer-fresh-\d+\.json$/.test(f))
      .map((f) => readJson<{ attempt?: { attempt: number; offset?: number; pairsPerSegment?: number }; seed?: string }>(join(d, f)))
      .filter((r) => r.attempt && (r.seed ?? seedHex) === seedHex)
      .map((r) => r.attempt!),
  );
  // Fresh deals for every attempt: start after the last pair any earlier attempt played.
  const offset = Math.max((attempt - 1) * pairs, ...[...earlier, ...before].map((x) => (x.offset ?? (x.attempt - 1) * pairs) + (x.pairsPerSegment ?? pairs)));
  const arms = { adaptive: adaptiveArm(A), twin: twinArm(T), ablated: ablatedArm(A) };
  const measure = [search.chosen];
  const outsideSpec = search.chosenInTraining && search.bestOutside ? search.bestOutside.spec : null;
  if (outsideSpec) measure.push(outsideSpec);
  const realized = new Map<string, Record<string, Record<string, RealizedCount>>>();
  const res = await play(measure, arms, seed, offset, pairs, family, realized);
  const verdict = (e: ExplorerSpec) => {
    const s = res.get(explorerLabel(e))!;
    const gain = pairedSummary(s.adaptive, s.twin);
    const adaptationPart = fmt(pairedSummary(s.adaptive, s.ablated));
    const passTwinRule = gain.upper95 <= REQUIREMENT;
    return {
      explorer: explorerLabel(e),
      inTraining: inTrainingFamily(e),
      gain: fmt(gain),
      split: { adaptationPart, basePart: fmt(pairedSummary(s.ablated, s.twin)) },
      pass: passTwinRule,
      passTwinRule,
      passAdaptationPart: adaptationPart.upper95 <= REQUIREMENT,
      playedOutsideTraining: outsideSummary(realized.get(explorerLabel(e))!),
    };
  };
  const main = verdict(search.chosen);
  const outside = outsideSpec ? verdict(outsideSpec) : null;
  const pass = main.pass && (outside?.pass ?? true);
  const passAdaptationPart = main.passAdaptationPart && (outside?.passAdaptationPart ?? true);
  const view = (v: ReturnType<typeof verdict>): ExplorerView => ({ explorer: v.explorer, gain: v.gain, adaptationPart: v.split.adaptationPart, pass: v.pass, passTwinRule: v.passTwinRule, passAdaptationPart: v.passAdaptationPart, playedOutsideTraining: v.playedOutsideTraining.share });
  const thisAttempt: AttemptView = { attempt, adapt: adaptOf(A), searchRankedBy: baseline, ...view(main), pass, passTwinRule: pass, passAdaptationPart, offset, pairsPerSegment: pairs, outside: outside ? view(outside) : null, ...(remeasureOf ? { remeasureOf } : {}) };
  const attempts = [...earlier, thisAttempt].sort((x, y) => x.attempt - y.attempt);
  const facts = {
    explorer: {
      measuredAt,
      method: `${remeasureOf ? `Re-measure, no new search: the explorer${outside ? 's' : ''} chosen by the search of attempt ${remeasureOf.attempt} (${specPath}, made against another adaptive file with the safety net ${JSON.stringify(remeasureOf.adapt)}) played again against this file (safety net ${JSON.stringify(adaptOf(A))}) on fresh deals. ` : ''}Explorer: style a, then style b, on v1, switching at a hand or once its seat has shown a number of betting events (partner in 2 against 2: the same schedule or v1 Zap)${search.poolSizes?.fresh ? `; the fresh family adds three phases, back and forth, held-out styles and a partner on its own schedule, none of which any training league kind draws` : ''}. Search on selection deals (seed ${search.seed}${search.offset ? `, pairs from ${search.offset} per segment, after the earlier searches` : ''}) over ${search.gridSearched} of ${search.gridSize} candidates${search.poolSizes ? ` (original grid ${search.poolSizes.grid}, fresh family ${search.poolSizes.fresh})` : ''} by successive halving against the adaptive network and the ${baseline === 'ablated' ? 'ablated network, ranked by the adaptation part' : 'twin, ranked by the gain over the twin'}. The chosen explorer${outside ? ', and the best one from outside the family of switching players the adaptive network met in training,' : ''} then played ${pairs} fresh duplicate pairs per segment (seed ${seedHex}, pairs ${offset} to ${offset + pairs - 1}, never played by an earlier attempt) against the adaptive network, the twin and the ablated network, with the Zap knobs. Gain: score of the explorer against the adaptive network minus its score against the twin, pair by pair; adaptation part: score against the adaptive network minus score against the ablated network. playedOutsideTraining: of the explorer's fresh matches against each player, the share whose realized play no training draw of the adaptive network's family plays exactly, seat by seat and hand by hand given the betting events each seat had shown (styles.ts explorerMatchInFamily: a feint in its hand or evidence range, a switching player in its hand range, a stable extreme, or a feint whose switch never came; three phases or a held-out style that played are outside); share is the one against the adaptive network. An explorer outside the training family by its label is scored mostly on play a training draw also plays when that share is small. Pass under the rule of attempt 1 (superseded on 2026-11-22 by explorer.criterion; pass and passTwinRule): every explorer measured has a one-sided 95% upper bound of the gain over the twin of at most 1 point. passAdaptationPart: the same bound on the adaptation part, the rule of explorer.criterion.`,
      adaptive: A,
      twin: T,
      grid: { styles: EXPLORER_STYLES, handSwitches: HAND_SWITCHES, evidenceSwitches: EVIDENCE_SWITCHES, partner: ['same', 'v1'], size: search.gridSize, searched: search.gridSearched, pool: search.pool ?? 'grid', poolSizes: search.poolSizes ?? { grid: search.gridSize, fresh: 0 }, ...(search.poolSizes?.fresh ? { freshFamily: FRESH_FAMILY } : {}) },
      trainingFamily: family,
      rounds: search.rounds,
      chosen: search.chosen,
      chosenInTraining: main.inTraining,
      ...(remeasureOf ? { remeasureOf } : {}),
      searchRankedBy: baseline,
      selectionGain: search.selectionGain,
      freshGain: main.gain,
      split: main.split,
      playedOutsideTraining: main.playedOutsideTraining,
      outsideTraining: outside ? { chosen: outsideSpec, selectionGain: search.bestOutside!.gain, freshGain: outside.gain, split: outside.split, playedOutsideTraining: outside.playedOutsideTraining, pass: outside.pass, passTwinRule: outside.passTwinRule, passAdaptationPart: outside.passAdaptationPart } : null,
      requirement: REQUIREMENT,
      pass,
      passTwinRule: pass,
      passAdaptationPart,
      attempts,
      models: modelHashes(models),
    },
  };
  saveResult(out, { stage: 'fresh', measuredAt, attempt: thisAttempt, pairsPerSegment: pairs, offset, seed: seedHex, seconds: (performance.now() - t0) / 1000, ...machine(), provenance: provenance(models), facts }, flag('write-facts'));
  const line = (v: ReturnType<typeof verdict>) =>
    `${v.explorer}${v.inTraining ? '' : ' (outside the training family by its label)'}: adaptation part ${(100 * v.split.adaptationPart.mean).toFixed(2)} points, upper bound ${(100 * v.split.adaptationPart.upper95).toFixed(2)}, ${v.passAdaptationPart ? 'pass' : 'fail'}; ${v.playedOutsideTraining.share === null ? 'no matches' : `${(100 * v.playedOutsideTraining.share).toFixed(1)}%`} of its fresh matches against the adaptive network left every training draw (${v.playedOutsideTraining.byArm.adaptive.outside} of ${v.playedOutsideTraining.byArm.adaptive.matches})`;
  for (const v of [main, ...(outside ? [outside] : [])]) process.stderr.write(`${line(v)}\n`);
  console.log(JSON.stringify({ out, searchRankedBy: baseline, explorer: main.explorer, gain: main.gain, split: main.split, playedOutsideTraining: main.playedOutsideTraining.share, outside, offset, pass, passAdaptationPart, verdicts: [main, ...(outside ? [outside] : [])].map(line) }, null, 2));
} else {
  throw new Error('--stage search|fresh');
}
