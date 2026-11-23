// Trained explorer of the explorer test. The scripted explorers of ai/bench/explorer.ts follow a
// fixed schedule; this one is a network trained with PPO as a best response against the frozen
// adaptive network as the room serves it (statistics live, its safety net, Zap knobs). It starts
// from the twin (training/explorer_init.py), reads its own public statistics, the next seat's and
// its partner's (features v2-self, so it knows what the adaptive network reads about it and how many
// hands have gone by), and learns with one episode per match, so what it shows in early hands is
// credited with what it earns later (training/train.py --league-as-served --episode match).
//
// --stage measure
//   1. The start against the adaptive network with statistics live and at no evidence, on the deals
//      of the training's periodic check (seed 3e, --check-pairs per segment): the iteration 0 row of
//      the checks that train.py --eval-served wrote to <run>/metrics.jsonl.
//   2. Fresh deals (seed --seed, default f8, used by no other bench), duplicate format, --pairs per
//      segment: the explorer against the adaptive network, the ablated network (the same file with
//      the statistics at no evidence), the twin and the second twin.
//        adaptation part = score vs adaptive minus score vs ablated, pair by pair: the gain that only
//          the reading can give the explorer. Primary criterion: one-sided 95% upper bound at most
//          1 point.
//        gain over the twin = score vs adaptive minus score vs twin, with its two parts (adaptation
//          and base = ablated vs twin), next to the seed floor seen by this explorer: score vs
//          second twin minus score vs twin (two training runs of the same recipe, no statistics).
//   3. Style: --style-matches matches per segment of the explorer, and of its start, against the
//      adaptive network. The public statistics of the explorer's seats (what the adaptive network
//      reads) per hand of the match, early (hands 1 to 3), middle (4 to 6) and late (7 on), and how
//      the adaptive network answered its raises.
//   Writes <adaptive run>/eval/explorer-trained.json with facts for "explorer.trained" and
//   "explorer.criterion". --trained-against names the adaptive file the explorer trained against
//   (default: the run's league_fixed path; pass the kept copy when that path now holds another
//   file). A result measured against another adaptive file is first copied to
//   <eval>/history/explorer-trained-<sha8>.json (the control likewise). An explorer trained for an
//   earlier file, measured against this one, goes elsewhere with --out (in <eval>/history/, under a
//   name that does not start with explorer-trained-): the criterion counts it as a trained
//   explorer measured against this file (verdicts.otherTrained), next to the main one.
// --stage control
//   The control: an explorer trained the same way (same start, seeds, options and number of PPO
//   iterations) against the twin as served instead of the adaptive network. On new deals (seed
//   --seed, default fa, used by no other bench), both the control and the trained explorer play
//   the adaptive network, the ablated network, the twin and the second twin. The control's score
//   against the twin next to the trained explorer's score against the adaptive network, pair by
//   pair, says whether a best response of the same budget gains more against the adaptive file
//   (what switching adaptation on would serve) than against the twin (what is served today), or
//   whether the trained explorer's base part is only the specialization of a best response. The
//   twin the control trained against (its league_fixed) is recorded; when it is not the --twin
//   measured here, the texts say so.
//   Writes <adaptive run>/eval/explorer-control.json with facts for "explorer.control".
// --stage facts [--words "..."]
//   Adds the description in words of what the explorer learned (written after reading the style
//   numbers) to the result file, rebuilds "explorer.criterion" from every stored result (scripted
//   attempts, the trained explorer, the control when measured, the results kept in <eval>/history/),
//   and with --write-facts writes the keys to facts.json.
//
// The criterion judges the file that would be served, --adaptive A (ai/bench/criterion.ts): only
// results whose models.adaptive.sha256 is A's count (verdicts, pass); results measured against
// earlier files are listed in history with their result file, model file and safety net.
// --history <eval dir>[,...] adds the results stored in other eval folders (another run's, such as
// training/runs/m6-adaptive/eval for the feints fine-tune): they measured other files, so they are
// history, and an explorer that failed there is pending until it is measured against A.
//
// Usage:
//   node ai/bench/explorer-trained.ts --stage measure --explorer E --start S --adaptive A --twin T --twin2 T2
//        [--run training/runs/m6-explorer] [--trained-against F] [--pairs 2000] [--seed f8] [--check-pairs 200] [--style-matches 500] [--threads 3]
//   node ai/bench/explorer-trained.ts --stage control --control C --explorer E --adaptive A --twin T --twin2 T2
//        [--run training/runs/m6-explorer-twin] [--pairs 2000] [--seed fa] [--threads 3]
//   node ai/bench/explorer-trained.ts --stage facts --adaptive A [--words "..." | --words auto] [--history <eval dir>[,...]] [--write-facts]
// (--words auto writes the style numbers in words, marked as not yet described by a person.)
// (--history works with the measure stage too.)

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeConfig } from '../../engine/src/config.ts';
import { publicHistory, type PublicHistory } from '../../engine/src/public.ts';
import { deriveSeed } from '../../engine/src/rng.ts';
import { pairedSummary, playAgents } from '../src/evaluate.ts';
import { NEUTRAL_KNOBS } from '../src/net-agent.ts';
import { countHands, emptyCounts, type SeatCounts } from '../src/opponent-stats.ts';
import { ablatedArm, adaptiveArm, twinArm } from './arms.ts';
import { SEGMENTS, arg, evalOut, flag, loadModel, machine, modelHashes, numArg, provenance, readJson, requireSafetyNet, round, saveResult, seedArg, segmentConfig, sha256File, writeJson, type Segment } from './bench-util.ts';
import { judgeServed, verdictOf, type Diff, type Measured, type Verdict } from './criterion.ts';
import { factory, runPairTasks, type AgentSpec, type PairJob } from './parallel.ts';

const stage = arg('stage');
const A = arg('adaptive');
if (!A) throw new Error('--adaptive is required');
const OUT = arg('out', evalOut(A, 'explorer-trained'))!;
const CONTROL_OUT = arg('control-out', evalOut(A, 'explorer-control'))!;
const REQUIREMENT = 0.01;
/** Other eval folders whose stored results count as history (--history). */
const HISTORY_DIRS = (arg('history', '') ?? '').split(',').filter(Boolean);
for (const d of HISTORY_DIRS) if (!existsSync(d)) throw new Error(`--history ${d}: no such folder`);
const fmt = (p: ReturnType<typeof pairedSummary>): Diff => ({ mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), upper95: round(p.upper95, 5), pairs: p.pairs });
const t0 = performance.now();
/**
 * A stored share with `digits` decimals once multiplied by 100, a half away from zero as the texts
 * round (the stored -0.00035 is -0.04, where toFixed on the binary value gives -0.03). The 1e-9
 * absorbs the binary error of values stored with 5 decimals.
 */
const away = (x: number, digits: number) => {
  const k = 10 ** digits;
  const v = Math.round(Math.abs(x) * 100 * k + 1e-9) / k;
  return `${x < 0 && v !== 0 ? '-' : ''}${v.toFixed(digits)}`;
};
/** Points, as the texts write them: 1 point is 0.01 of the mean match score. */
const pts = (x: number) => away(x, 2);
const pct = (x: number) => away(x, 1);
const range = (d: Diff) => `${pts(d.mean)} (from ${pts(d.ci95[0])} to ${pts(d.ci95[1])})`;

interface Bucket extends SeatCounts {
  /** Answers of the adaptive seats to the explorer's raises: run, accept, raise again. */
  oppRun: number;
  oppAccept: number;
  oppReraise: number;
  /** Normal hands of the adaptive seats, and those in which they raised unprompted. */
  oppH: number;
  oppK: number;
}
const BUCKETS = ['1-3', '4-6', '7+'] as const;
const bucketOf = (hand: number) => (hand <= 3 ? '1-3' : hand <= 6 ? '4-6' : '7+');
const emptyBucket = (): Bucket => ({ ...emptyCounts(), oppRun: 0, oppAccept: 0, oppReraise: 0, oppH: 0, oppK: 0 });

/** Rates a person can read: per seat and hand, per answer, per card. */
function view(b: Bucket) {
  const T = b.U + b.A + b.X;
  const oT = b.oppRun + b.oppAccept + b.oppReraise;
  const r = (x: number, n: number) => (n ? round(x / n, 4) : null);
  return {
    seatHands: b.H,
    raiseRate: r(b.K, b.H),
    answers: T,
    runRate: r(b.U, T),
    acceptRate: r(b.A, T),
    reraiseRate: r(b.X, T),
    shownStrength: r(b.S, b.Q),
    coverRate: r(b.V, b.W),
    adaptive: { raiseRate: r(b.oppK, b.oppH), answers: oT, runRate: r(b.oppRun, oT), acceptRate: r(b.oppAccept, oT), reraiseRate: r(b.oppReraise, oT) },
  };
}

/** Matches of `who` against the adaptive network; public counts per hand bucket for both teams. */
function styleOf(who: AgentSpec, adaptive: AgentSpec, seed: string, matches: number): Record<string, ReturnType<typeof view>> {
  const acc: Record<string, Bucket> = Object.fromEntries(BUCKETS.map((b) => [b, emptyBucket()]));
  for (const seg of SEGMENTS) {
    const { variant, players } = segmentConfig(seg);
    const config = makeConfig(variant, players);
    const me = factory(who);
    const opp = factory(adaptive);
    for (let i = 0; i < matches; i++) {
      const team = i & 1;
      const agents = Array.from({ length: players }, (_, s) => ((s & 1) === team ? me(s) : opp(s)));
      const m = playAgents(config, deriveSeed(seed, 0x7374796c, SEGMENTS.indexOf(seg) * 1_000_000 + i), agents, 7 * i + 3, true);
      const h: PublicHistory = publicHistory(m.state!);
      h.hands.forEach((hand, k) => {
        const c = countHands({ ...h, hands: [hand] });
        const b = acc[bucketOf(k + 1)];
        for (let s = 0; s < players; s++) {
          const x = c.seats[s];
          if ((s & 1) === team) for (const key of Object.keys(x) as (keyof SeatCounts)[]) b[key] += x[key];
          else {
            b.oppRun += x.U;
            b.oppAccept += x.A;
            b.oppReraise += x.X;
            b.oppH += x.H;
            b.oppK += x.K;
          }
        }
      });
    }
  }
  return Object.fromEntries(BUCKETS.map((b) => [b, view(acc[b])]));
}

/** Pooled scores per arm (segment order, then pair order), and per segment. */
async function measure(me: AgentSpec, arms: Record<string, AgentSpec>, seed: string, pairs: number, threads: number) {
  const jobs: PairJob[] = [];
  for (const [name, spec] of Object.entries(arms)) for (const segment of SEGMENTS) jobs.push({ key: `${name}|${segment}`, segment, baseSeed: seed, offset: 0, pairs, a: me, b: spec });
  const res = await runPairTasks(jobs, threads, 25, (d, n) => {
    if (d % 50 === 0 || d === n) process.stderr.write(`explorer-trained: ${d}/${n} chunks, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
  });
  const seg = (name: string, g: Segment) => res.get(`${name}|${g}`)!.scores;
  const pooled = (name: string) => SEGMENTS.flatMap((g) => seg(name, g));
  return { seg, pooled };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** What a training run of an explorer did, from its metrics.jsonl and args.json. */
function trainingOf(run: string) {
  const metrics = readFileSync(join(run, 'metrics.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const ppo = metrics.filter((m) => m.mode === 'ppo').length;
  const args = readJson<Record<string, unknown>>(join(run, 'args.json'));
  const seconds = metrics.reduce((a, m) => a + (m.selfplay_seconds ?? 0) + (m.learn_seconds ?? 0) + (m.eval_seconds ?? 0), 0);
  const checks = metrics.filter((m) => m.vs_served !== undefined).map((m) => ({ iteration: m.iteration + 1, model: 'current', vsServed: m.vs_served, vsServedAblated: m.vs_served_ablated, reading: m.served_reading }));
  return { metrics, ppo, args, seconds, checks };
}

/** Every scripted attempt stored in the eval folder: the explorers it measured and the file it measured them against. */
function scriptedMeasured(dir: string): Measured[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^explorer-fresh-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(([f]) => {
      const r = readJson<{ attempt?: any; facts: { explorer: any } }>(join(dir, f));
      const e = r.facts.explorer;
      const own = r.attempt ?? e.attempts[e.attempts.length - 1];
      const out = [verdictOf(own.explorer, e.freshGain, e.split, REQUIREMENT)];
      if (e.outsideTraining) out.push(verdictOf(own.outside.explorer, e.outsideTraining.freshGain, e.outsideTraining.split, REQUIREMENT));
      return {
        kind: 'scripted' as const,
        file: join(dir, f),
        model: e.models?.adaptive ?? null,
        adapt: own.adapt,
        attempt: own.attempt,
        searchRankedBy: (e.searchRankedBy ?? 'twin') as 'twin' | 'ablated',
        ...(own.remeasureOf ? { remeasureOf: own.remeasureOf } : {}),
        explorers: out,
      };
    });
}

/** The trained explorer's result as a measurement (with the adaptive file it trained against). */
const trainedMeasured = (file: string, t: any, adapt: unknown): Measured => ({ kind: 'trained', file, model: t.models?.adaptive ?? null, adapt, ...(t.training?.against ? { against: t.training.against } : {}), explorers: [verdictOf(t.explorer, t.fresh.gainOverTwin, t.fresh, REQUIREMENT)] });
/** The control's result as a measurement (its own verdict: the control explorer against the four networks). */
const controlMeasured = (file: string, c: ControlFacts, adapt: unknown): Measured => ({ kind: 'control', file, model: c.models?.adaptive ?? null, adapt, explorers: [verdictOf(c.explorer, c.fresh.control.gainOverTwin, c.fresh.control, REQUIREMENT)] });

/** The safety net of the adaptive file a result measured, from its provenance. */
const adaptOfResult = (r: any): unknown => r?.adapt ?? r?.provenance?.models?.adaptive?.adapt ?? null;

/**
 * Earlier results of the trained explorer and of the control, kept in <eval>/history/ when a
 * measurement against another adaptive file replaced them (see archive()).
 */
function historyMeasured(dir: string): Measured[] {
  const h = join(dir, 'history');
  if (!existsSync(h)) return [];
  return readdirSync(h)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const r = readJson<any>(join(h, f));
      const out: Measured[] = [];
      if (r.facts?.['explorer.trained']) out.push(trainedMeasured(join(h, f), r.facts['explorer.trained'], adaptOfResult(r)));
      if (r.facts?.['explorer.control']) out.push(controlMeasured(join(h, f), r.facts['explorer.control'], adaptOfResult(r)));
      return out;
    });
}

/**
 * Before a result file is replaced by a measurement against another adaptive file, a copy goes to
 * <eval>/history/<name>-<first 8 hex of the old file's SHA-256>.json, so the criterion keeps the
 * older verdict as history.
 */
function archive(path: string, key: 'explorer.trained' | 'explorer.control', servedSha: string): string | null {
  if (!existsSync(path)) return null;
  const r = readJson<any>(path);
  const sha: string | undefined = r.facts?.[key]?.models?.adaptive?.sha256;
  if (!sha || sha === servedSha) return null;
  const to = join(dirname(path), 'history', `${basename(path, '.json')}-${sha.slice(0, 8)}.json`);
  mkdirSync(dirname(to), { recursive: true });
  if (!existsSync(to)) writeJson(to, { archivedAt: new Date().toISOString(), from: path, adapt: adaptOfResult(r), ...r });
  return to;
}

/** Every result stored in another eval folder (--history): scripted attempts, trained and control explorers, its history/. */
function otherFolderMeasured(dir: string): Measured[] {
  const file = (name: string) => join(dir, `${name}.json`);
  const t = existsSync(file('explorer-trained')) ? readJson<any>(file('explorer-trained')) : null;
  const c = existsSync(file('explorer-control')) ? readJson<any>(file('explorer-control')) : null;
  return [
    ...scriptedMeasured(dir),
    ...(t?.facts?.['explorer.trained'] ? [trainedMeasured(file('explorer-trained'), t.facts['explorer.trained'], adaptOfResult(t))] : []),
    ...(c?.facts?.['explorer.control'] ? [controlMeasured(file('explorer-control'), c.facts['explorer.control'], adaptOfResult(c))] : []),
    ...historyMeasured(dir),
  ];
}

/** The control's result as explorer-control.json stores it (the parts the criterion reads). */
interface ControlFacts {
  explorer: string;
  training: { ppoIterations: number; minutes: number; against?: { path: string; sha256: string } };
  fresh: {
    seed: string;
    control: { scores: Record<string, { mean: number }>; adaptationPart: Diff; gainOverTwin: Diff; basePart: Diff };
    trained: { scores: Record<string, { mean: number }> };
    asServed: Diff;
    base: Diff;
    crossControlVsAdaptiveMinusTwin: Diff;
  };
  models?: { adaptive?: { path: string; sha256: string }; twin?: { path: string; sha256: string } };
}

const AUTO_WORDS = 'Not described by a person yet';
/** The style numbers in words, for --words auto: no reading of them, only what was measured. */
function autoWords(style: { explorer: Record<string, ReturnType<typeof view>>; start: Record<string, ReturnType<typeof view>> }): string {
  const list = (who: 'explorer' | 'start', key: 'raiseRate' | 'runRate' | 'reraiseRate' | 'coverRate') => BUCKETS.map((b) => (style[who][b][key] === null ? 'none' : pct(style[who][b][key]!))).join(', ');
  const row = (name: string, key: 'raiseRate' | 'runRate' | 'reraiseRate' | 'coverRate') => `${name} ${list('explorer', key)}% (its start: ${list('start', key)}%)`;
  return `${AUTO_WORDS}; the style numbers only, against the adaptive network, for hands 1 to 3, 4 to 6 and 7 on: ${row('asked for truco in', 'raiseRate')} of its hands; ${row('ran from', 'runRate')} of the bets it answered; ${row('raised again in', 'reraiseRate')} of them; ${row('covered', 'coverRate')} of the plays where covering was allowed.`;
}

const net = (a: any) => (a && typeof a === 'object' ? `Bmax ${a.bmax}, nHalf ${a.nHalf}` : 'none');

/** The net tightening checks stored in the eval folder (ai/bench/explorer-tightening.ts), the parts the criterion's text reads. */
interface TighteningFacts {
  explorer: string;
  fresh: { seed: string; offset: number; pairsPerSegment: number };
  adaptive: { sha256: string; adapt: unknown; adaptationPart: Diff };
  other: { sha256: string; adapt: unknown; adaptationPart: Diff };
  diff: Diff;
  ablatedSame: boolean;
}
function tighteningMeasured(dir: string): TighteningFacts[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^explorer-tightening-\d+\.json$/.test(f))
    .sort()
    .map((f) => readJson<{ facts: { 'explorer.netTightening': TighteningFacts } }>(join(dir, f)).facts['explorer.netTightening']);
}
const who = (m: Measured) => (m.kind === 'scripted' ? `explorer of attempt ${m.attempt}` : m.kind === 'trained' ? 'trained explorer' : 'control explorer');

/**
 * Why the adaptation part is the criterion, written from the verdicts: the history (set after
 * attempt 1 failed the rule written before it), which file it judges and what failed against
 * earlier files, what the old rule gives, the seed floors, what the control explorer says about
 * the trained explorer's base part, and what tightening the net did on the same deals.
 */
function whyText(j: ReturnType<typeof judgeServed>, served: { sha256: string; adapt: unknown }, trained: { v: Verdict; facts: any } | null, otherTrained: Measured[], control: ControlFacts | null, seedFloorStyles: Diff | null, tightening: TighteningFacts[]): string {
  const s = ['This criterion was set on 2026-11-22 after attempt 1 failed the rule written before it (gain over the twin, one-sided 95% upper bound at most 1 point), and before the trained explorer was measured.'];
  const nHist = j.history.flatMap((m) => m.explorers).length;
  s.push(
    `It judges the file that would be served (SHA-256 ${served.sha256.slice(0, 8)}, safety net ${net(served.adapt)}): only the ${j.verdicts.length} verdicts measured against that file count${nHist ? `; the ${nHist} measured against earlier files are listed in explorer.criterion.history with their file and net, and do not count` : ''}.`,
  );
  const failedBefore = j.history.flatMap((m) => m.explorers.filter((x) => !x.pass).map((x) => ({ m, x })));
  for (const { m, x } of failedBefore) s.push(`Against the file with safety net ${net(m.adapt)} (SHA-256 ${m.model?.sha256.slice(0, 8)}), the ${who(m)}, ${x.explorer}, has an adaptation part of ${range(x.adaptationPart)} points, one-sided 95% upper bound ${pts(x.adaptationPart.upper95)}: above 1 point, so that file fails the criterion.`);
  if (failedBefore.length) {
    // An explorer that failed against several earlier files has one verdict against this one: said once.
    const failedNames = [...new Set(failedBefore.map(({ x }) => x.explorer))];
    const again = failedNames.filter((name) => j.verdicts.some((v) => v.explorer === name));
    s.push(
      again.length === failedNames.length
        ? `Every explorer that failed against an earlier file was measured again against this one, on fresh deals: ${again.map((name) => `${name} ${range(j.verdicts.find((v) => v.explorer === name)!.adaptationPart)} points, upper bound ${pts(j.verdicts.find((v) => v.explorer === name)!.adaptationPart.upper95)}`).join('; ')}.`
        : `${failedNames.length - again.length} of the ${failedNames.length} explorers that failed against an earlier file were not measured against this one (pendingRemeasure: ${j.pendingRemeasure.join(', ')}), so the criterion does not pass until they are.`,
    );
  }
  const scriptedNow = j.current.filter((m) => m.kind === 'scripted');
  const all: Verdict[] = [...scriptedNow.flatMap((a) => a.explorers), ...(trained ? [trained.v] : []), ...otherTrained.flatMap((m) => m.explorers)];
  const nFail = all.filter((x) => !x.passTwinRule).length;
  s.push(`Under the old rule ${nFail === all.length ? `all ${all.length} explorers aimed at the adaptive network and measured against this file fail` : `${nFail} of the ${all.length} explorers aimed at the adaptive network and measured against this file fail`} (upper bounds of the gain over the twin ${all.map((x) => pts(x.gainOverTwin.upper95)).join(', ')} points, in the order of explorer.criterion.verdicts: scripted attempts, then the trained explorer${otherTrained.length ? ', then the explorers trained for earlier files' : ''}; the control explorer trained against the twin and is left out).`);
  const twinRanked = [...j.current, ...j.history].filter((m) => m.kind === 'scripted' && m.searchRankedBy === 'twin').sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  if (twinRanked.length)
    s.push(
      `For the scripted explorers of ${twinRanked.map((a) => `attempt ${a.attempt} (safety net ${net(a.adapt)})`).join(' and ')}, searched for the gain over the twin, that gain (${twinRanked
        .flatMap((a) => a.explorers)
        .map((x) => pts(x.gainOverTwin.mean))
        .join(', ')} points) is about the size of the seed floor${seedFloorStyles ? ` (against the styles the second twin lands ${pts(seedFloorStyles.mean)} points from the twin, from ${pts(seedFloorStyles.ci95[0])} to ${pts(seedFloorStyles.ci95[1])})` : ''}.`,
    );
  if (trained) {
    const tf = trained.facts;
    const against = tf.training?.against;
    s.push(`For the trained explorer it is not: its seed floor is ${range(tf.fresh.seedFloorSeenByExplorer)}, and its ${pts(trained.v.basePart.mean)} point base part is play learned against the adaptive network's weights.`);
    if (against?.sha256 && against.sha256 !== served.sha256)
      s.push(`It trained against the adaptive file with safety net ${net(against.adapt)} (SHA-256 ${against.sha256.slice(0, 8)}) and was measured against this one: no explorer was trained against this file.`);
  }
  for (const m of otherTrained) {
    const x = m.explorers[0];
    const a = m.against as { path?: string; sha256?: string; adapt?: unknown } | undefined;
    s.push(`The explorer trained for an earlier file${a?.sha256 ? ` (${a.path}, SHA-256 ${a.sha256.slice(0, 8)}, safety net ${net(a.adapt)})` : ''}, ${x.explorer}, was measured against this one too (${m.file}): adaptation part ${range(x.adaptationPart)} points, upper bound ${pts(x.adaptationPart.upper95)}${x.pass ? '' : ', above 1 point'}.`);
  }
  if (!control) {
    s.push('Without an explorer trained the same way against the twin we cannot say whether it shows a weaker base or only the specialization of a best response.');
  } else {
    const f = control.fresh;
    const d = f.asServed;
    const special = `the control in turn scores ${range(f.crossControlVsAdaptiveMinusTwin)} points against the adaptive network as served relative to the twin, so each best response is specialized to the network it trained against`;
    const ca = control.training.against;
    const otherTwin = !!(ca?.sha256 && control.models?.twin?.sha256 && ca.sha256 !== control.models.twin.sha256);
    const verdict =
      d.ci95[0] > 0
        ? `so a best response of the same budget takes more from the adaptive file as served than from the twin: by this measure the adaptive base is more exploitable, and switching adaptation on would serve it${otherTwin ? '. This comparison is less clean: the trained explorer was measured against the file it trained on, the control against a twin it never trained on' : ''}`
        : d.ci95[1] < 0
          ? `so a best response of the same budget takes less from the adaptive file as served than from the twin, and the trained explorer's base part shows no weaker base: ${special}`
          : `a difference within noise: a best response of the same budget takes about as much from either network, so the trained explorer's base part shows no weaker base: ${special}`;
    const trainedPpo: number | undefined = trained?.facts?.training?.ppoIterations;
    const iterNote = trainedPpo === undefined || trainedPpo === control.training.ppoIterations ? ', as the trained explorer' : `, against ${trainedPpo} for the trained explorer`;
    const twinNote = otherTwin ? ` It trained against the twin file ${ca!.path} (SHA-256 ${ca!.sha256.slice(0, 8)}), not the twin measured here (${control.models!.twin!.path}, SHA-256 ${control.models!.twin!.sha256.slice(0, 8)}).` : '';
    s.push(
      `An explorer trained the same way against the twin (explorer.control: same start, seeds and options, ${control.training.ppoIterations} PPO iterations${iterNote}) scored ${pct(f.control.scores.vsTwin.mean)}% against the twin on new deals (seed ${f.seed}); on the same deals the trained explorer scored ${pct(f.trained.scores.vsAdaptive.mean)}% against the adaptive network as served and ${pct(f.trained.scores.vsAblated.mean)}% against the ablated one.${twinNote} The trained explorer's score against the adaptive network as served minus the control's against the twin is ${range(d)} points (against the ablated network: ${pts(f.base.mean)}, from ${pts(f.base.ci95[0])} to ${pts(f.base.ci95[1])}), ${verdict}.`,
    );
  }
  s.push('The ablated network is the same file with the statistics at no evidence, so the adaptation part (score against the adaptive network minus score against the ablated one, on the same deals) holds only what the reading changes. It is also the only part the safety net acts on: without evidence the net lets nothing move, so the ablated network, and with it the base part, is the same whatever the net.');
  for (const t of tightening)
    s.push(
      `Measured on the same deals (explorer.netTightening, seed ${t.fresh.seed}, pairs ${t.fresh.offset} to ${t.fresh.offset + t.fresh.pairsPerSegment - 1} per segment), ${t.explorer} has an adaptation part of ${range(t.other.adaptationPart)} points, upper bound ${pts(t.other.adaptationPart.upper95)}, against the file with safety net ${net(t.other.adapt)} and ${range(t.adaptive.adaptationPart)}, upper bound ${pts(t.adaptive.adaptationPart.upper95)}, against the file with safety net ${net(t.adaptive.adapt)}: from the first to the second it changed by ${range(t.diff)} points, pair by pair${t.ablatedSame ? ', and the two ablated networks scored the same on every pair, so the base part did not change' : ''}.`,
    );
  return s.join(' ');
}

/** A measurement as the criterion lists it. */
const listed = (m: Measured) => ({
  kind: m.kind,
  file: m.file,
  model: m.model,
  adapt: m.adapt,
  ...(m.kind === 'scripted' ? { attempt: m.attempt, searchRankedBy: m.searchRankedBy } : {}),
  ...(m.remeasureOf ? { remeasureOf: m.remeasureOf } : {}),
  ...(m.against ? { trainedAgainst: m.against } : {}),
  explorers: m.explorers,
});

/**
 * explorer.criterion from every stored result (scripted attempts, the trained explorer, the control,
 * and the earlier results kept in <eval>/history/), judged against the served file A only.
 */
function criterionOf(dir: string, trainedResult: { file: string; facts: any; adapt: unknown }, controlResult: { file: string; facts: ControlFacts; adapt: unknown } | null, measuredAt: string) {
  const servedSha = sha256File(A!);
  const servedAdapt = loadModel(A!).header.meta?.adapt ?? null;
  const all: Measured[] = [
    ...scriptedMeasured(dir),
    trainedMeasured(trainedResult.file, trainedResult.facts, trainedResult.adapt),
    ...(controlResult ? [controlMeasured(controlResult.file, controlResult.facts, controlResult.adapt)] : []),
    ...historyMeasured(dir),
    ...HISTORY_DIRS.flatMap(otherFolderMeasured),
  ];
  const j = judgeServed(all, servedSha);
  const now = (k: Measured['kind']) => j.current.filter((m) => m.kind === k);
  const scripted = now('scripted').map(({ file, attempt, adapt, searchRankedBy, remeasureOf, model, explorers }) => ({ file, attempt, adapt, model, searchRankedBy, ...(remeasureOf ? { remeasureOf } : {}), explorers }));
  // The main trained explorer is the one of trainedResult; others measured against A (explorers
  // trained for earlier files) count too and are listed apart.
  const trainedNow = now('trained');
  const mainTrained = trainedNow.find((m) => m.file === trainedResult.file) ?? null;
  const otherTrained = trainedNow.filter((m) => m !== mainTrained);
  const trainedV = mainTrained?.explorers[0] ?? null;
  const controlNow = now('control');
  const controlV = (controlNow.find((m) => m.file === controlResult?.file) ?? controlNow[0])?.explorers[0] ?? null;
  const searchedAll = [...j.current, ...j.history].filter((m) => m.kind === 'scripted').sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  const searches = searchedAll
    .map((a) =>
      a.remeasureOf
        ? `attempt ${a.attempt} measured the explorer of attempt ${(a.remeasureOf as { attempt: number | null }).attempt} again, with no new search (safety net ${net(a.adapt)})`
        : `attempt ${a.attempt} ranked its candidates by ${a.searchRankedBy === 'ablated' ? 'the adaptation part' : 'the gain over the twin'} (safety net ${net(a.adapt)})`,
    )
    .join('; ');
  const tr = trainedResult.facts.training;
  const against = tr.against;
  // Planned iterations: stored with the result since 2026-11-23, else from the run's args.json.
  const planned = tr.args?.iters ?? (tr.run && existsSync(join(tr.run, 'args.json')) ? readJson<Record<string, unknown>>(join(tr.run, 'args.json')).iters : undefined);
  const method =
    'Primary criterion of the explorer test: for every explorer measured on fresh deals against the file that would be served, the one-sided 95% upper bound of the adaptation part (score against the adaptive network minus score against the ablated network, the same file with the statistics at no evidence, pair by pair) is at most 1 point. The gain over the twin is reported next to it with the seed floor, for context. Verdicts recomputed from the stored fresh results of every attempt, of the trained explorer and of the control explorer when it was measured. ' +
    `Only the results whose adaptive file (models.adaptive.sha256) is the served file (servedModel) count, in verdicts; the results measured against earlier files are listed in history with their result file, model file and safety net, and do not count. pass is false while no explorer was measured against the served file, and while an explorer that failed against an earlier file has no verdict against the served file (pendingRemeasure lists them: a new search that passes does not replace measuring a known exploiter again). ` +
    `What was searched: the scripted search of ${searches}${searchedAll.some((a) => a.searchRankedBy === 'ablated') ? '' : '; no search maximized the adaptation part'}. The trained explorer stopped after ${tr.iterations ?? tr.ppoIterations} iterations (${tr.ppoIterations} of them PPO), ${tr.minutes} minutes (max-hours ${tr.args?.max_hours})${planned !== undefined ? `, of the ${planned} planned` : ''}${against?.sha256 ? `; it trained against ${against.path} (SHA-256 ${String(against.sha256).slice(0, 8)}, safety net ${net(against.adapt)})` : ''}.` +
    (otherTrained.length ? ` ${otherTrained.length === 1 ? 'An explorer trained for an earlier file and measured against the served file counts' : `${otherTrained.length} explorers trained for earlier files and measured against the served file count`} too (verdicts.otherTrained).` : '') +
    (controlV ? ' The control explorer (trained against the twin, explorer.control) is an explorer measured too, so its verdict counts.' : '');
  const verdicts = {
    scripted,
    ...(trainedV ? { trained: trainedV } : {}),
    ...(otherTrained.length ? { otherTrained: otherTrained.map((m) => ({ file: m.file, ...(m.against ? { trainedAgainst: m.against } : {}), ...m.explorers[0] })) } : {}),
    ...(controlV ? { control: controlV } : {}),
  };
  return {
    measuredAt,
    method,
    primary: 'adaptationPart',
    requirement: REQUIREMENT,
    servedModel: { path: A!, sha256: servedSha, adapt: servedAdapt },
    why: whyText(j, { sha256: servedSha, adapt: servedAdapt }, trainedV ? { v: trainedV, facts: trainedResult.facts } : null, otherTrained, controlV && controlResult ? controlResult.facts : null, trainedResult.facts.fresh.seedFloorPerStyle ?? null, tighteningMeasured(dir)),
    verdicts,
    pass: j.pass,
    passTwinRule: j.passTwinRule,
    pendingRemeasure: j.pendingRemeasure,
    history: j.history.map(listed),
    models: modelHashes({ adaptive: A! }),
  };
}

if (stage === 'measure') {
  const E = arg('explorer');
  const S = arg('start');
  const T = arg('twin');
  const T2 = arg('twin2');
  if (!E || !S || !T || !T2) throw new Error('--explorer, --start, --twin and --twin2 are required');
  requireSafetyNet(A);
  for (const p of [E, S]) if ((loadModel(p).header.features as string) !== 'v2-self') throw new Error(`${p} is not a v2-self explorer`);
  const run = arg('run', 'training/runs/m6-explorer')!;
  const pairs = numArg('pairs', 2000);
  const checkPairs = numArg('check-pairs', 200);
  const styleMatches = numArg('style-matches', 500);
  const threads = numArg('threads', 3);
  const seedHex = arg('seed', 'f8')!;
  const seed = seedArg('seed', 'f8');
  const measuredAt = new Date().toISOString();
  const explorer: AgentSpec = { kind: 'net', model: E, knobs: NEUTRAL_KNOBS, name: 'explorer' };
  const start: AgentSpec = { kind: 'net', model: S, knobs: NEUTRAL_KNOBS, name: 'start' };

  // 1. The start on the periodic check's deals (training/src/eval.ts --served, seed 3e).
  const c0 = await measure(start, { on: adaptiveArm(A), ablated: ablatedArm(A) }, '3e'.repeat(32), checkPairs, threads);
  const { metrics, ppo, args, seconds, checks: served } = trainingOf(run);
  const checks = [
    { iteration: 0, model: 'start', vsAdaptive: round(mean(c0.pooled('on')), 4), vsAblated: round(mean(c0.pooled('ablated')), 4), reading: { mean: round(pairedSummary(c0.pooled('on'), c0.pooled('ablated')).mean, 5), se: round(pairedSummary(c0.pooled('on'), c0.pooled('ablated')).se, 5) } },
    ...served.map((c) => ({ iteration: c.iteration, model: c.model, vsAdaptive: c.vsServed, vsAblated: c.vsServedAblated, reading: c.reading })),
  ];
  // The adaptive file the explorer trained against: the run's league_fixed unless that path now holds another file.
  const against = arg('trained-against', String(args.league_fixed))!;
  const againstAdapt = loadModel(against).header.meta?.adapt ?? null;
  const initDir = dirname(String(args.init_actor));
  const startFold = existsSync(join(initDir, 'start-fold.json')) ? readJson(join(initDir, 'start-fold.json')) : null;
  const startCheck = existsSync(join(initDir, 'start-check.json')) ? readJson(join(initDir, 'start-check.json')) : null;

  // 2. Fresh deals.
  const arms = { adaptive: adaptiveArm(A), ablated: ablatedArm(A), twin: twinArm(T), twin2: twinArm(T2, 'twin2') };
  const m = await measure(explorer, arms, seed, pairs, threads);
  const score = (name: string) => {
    const s = m.pooled(name);
    const p = pairedSummary(s, new Array<number>(s.length).fill(0));
    return { mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), pairs: p.pairs };
  };
  const diff = (a: string, b: string) => fmt(pairedSummary(m.pooled(a), m.pooled(b)));
  const adaptationPart = diff('adaptive', 'ablated');
  const perSegment = Object.fromEntries(SEGMENTS.map((g) => [g, { adaptationPart: fmt(pairedSummary(m.seg('adaptive', g), m.seg('ablated', g))), vsAdaptive: round(mean(m.seg('adaptive', g)), 4) }]));

  // 3. Style, early and late.
  const styleSeed = seedArg('style-seed', 'f9');
  const style = { explorer: styleOf(explorer, adaptiveArm(A), styleSeed, styleMatches), start: styleOf(start, adaptiveArm(A), styleSeed, styleMatches) };

  // The adaptive run's eval folder: the scripted attempts and the per style seed floor live there.
  const dir = dirname(evalOut(A, 'x'));
  // Only a floor from two twins with the same training counts (adaptation-eval.ts twinIterations).
  const stylesFile = existsSync(join(dir, 'eval-styles.json')) ? readJson<any>(join(dir, 'eval-styles.json')) : null;
  const stylesTwins = stylesFile?.facts?.perStyle?.twinIterations;
  const seedFloorStyles = stylesFile && (!stylesTwins || stylesTwins.twin === stylesTwins.twin2) ? (stylesFile.facts?.perStyle?.pooled?.allStyles?.seedFloor ?? null) : null;
  const models = { explorer: E, start: S, adaptive: A, twin: T, twin2: T2 };
  const pass = adaptationPart.upper95 <= REQUIREMENT;
  // After the feints fine-tune the second twin may have trained fewer iterations than the twin.
  const twinIterations = { twin: loadModel(T).header.meta?.iteration ?? null, twin2: loadModel(T2).header.meta?.iteration ?? null };
  const twinsNote = twinIterations.twin === twinIterations.twin2 ? '' : ` The twin has ${twinIterations.twin} training iterations and the second twin ${twinIterations.twin2}, so score against the second twin minus score against the twin mixes the seeds with that extra training: it is not a seed floor here.`;
  // The network the start was folded from (training/explorer_init.py --twin, start-fold.json).
  const startFrom: string = (startFold as any)?.startFrom ?? T;
  const startNote = startFrom === T ? 'the twin measured below' : `not the twin measured below (${T})`;
  const trained = {
    measuredAt,
    method: `A network trained with PPO as a best response against the adaptive network as served when it trained (${against}: statistics live, safety net ${JSON.stringify(againstAdapt)}, Zap knobs), holding the other team; the explorer holds both seats of its team in 2 against 2. Start: ${S}, folded from the twin file ${startFrom}, ${startNote} (training/explorer_init.py moves its weights on the statistics into the bias, so it starts by playing as that file, exactly except for a small interaction term in mineiro 2 against 2: training.startFold and training.startCheck). Features v2-self: its own public statistics, the next seat's and its partner's, so it sees what the adaptive network reads about it and how many hands have gone by. One episode per match, so early play is credited with later hands. ${ppo} PPO iterations after ${metrics.length - ppo} of critic warm-up, ${metrics.reduce((a, x) => a + x.decisions, 0)} decisions, ${String(args.workers)} workers and ${String(args.threads)} learner threads, ${round(seconds / 60, 1)} minutes. Periodic check every ${String(args.eval_every)} iterations: ${String(args.eval_pairs)} pairs per segment (seed 3e) against the adaptive network and the ablated one. Measured on fresh deals (seed ${seedHex}, pairs 0 to ${pairs - 1} per segment, a seed no other bench uses), duplicate format, the explorer with neutral knobs against the adaptive network (${A}, safety net ${JSON.stringify(loadModel(A).header.meta?.adapt ?? null)}), the ablated network (same file, statistics at no evidence), the twin and the second twin, all with the Zap knobs. Adaptation part: score against the adaptive network minus score against the ablated one, pair by pair (primary criterion: one-sided 95% upper bound at most 1 point). Gain over the twin: score against the adaptive network minus score against the twin; seed floor seen by this explorer: score against the second twin minus score against the twin. Style: ${styleMatches} matches per segment (seed f9) of the explorer and of its start against the adaptive network, public statistics of the explorer's seats by hand of the match.${twinsNote}`,
    explorer: E,
    start: S,
    training: {
      run,
      features: 'v2-self',
      startFrom,
      against: { path: against, sha256: sha256File(against), adapt: againstAdapt },
      startFold,
      startCheck,
      iterations: metrics.length,
      ppoIterations: ppo,
      criticWarmup: metrics.length - ppo,
      decisions: metrics.reduce((a, x) => a + x.decisions, 0),
      matches: metrics.reduce((a, x) => a + x.matches, 0),
      minutes: round(seconds / 60, 1),
      workers: args.workers,
      threads: args.threads,
      args: Object.fromEntries(['iters', 'decisions', 'lr', 'entropy', 'magnet_kl', 'magnet_every', 'episode', 'league_mix', 'league_fixed', 'league_as_served', 'two_styles', 'partner_swap', 'four_players', 'mineiro', 'random_options', 'no_stats_share', 'adapt_beta', 'seed_base', 'max_hours'].map((k) => [k, args[k]])),
      checks,
    },
    fresh: {
      seed: seedHex,
      pairsPerSegment: pairs,
      scores: { vsAdaptive: score('adaptive'), vsAblated: score('ablated'), vsTwin: score('twin'), vsTwin2: score('twin2') },
      adaptationPart,
      gainOverTwin: diff('adaptive', 'twin'),
      basePart: diff('ablated', 'twin'),
      seedFloorSeenByExplorer: diff('twin2', 'twin'),
      twinIterations,
      seedFloorPerStyle: seedFloorStyles,
      perSegment,
    },
    requirement: REQUIREMENT,
    pass,
    style: { buckets: 'hands 1 to 3, 4 to 6, 7 on', matchesPerSegment: styleMatches, seed: 'f9', ...style, words: null as string | null },
    models: modelHashes(models),
  };
  const controlFile = existsSync(CONTROL_OUT) ? readJson<any>(CONTROL_OUT) : null;
  const control = controlFile ? { file: CONTROL_OUT, facts: controlFile.facts['explorer.control'] as ControlFacts, adapt: adaptOfResult(controlFile) } : null;
  const archived = archive(OUT, 'explorer.trained', sha256File(A));
  const criterion = criterionOf(dir, { file: OUT, facts: trained, adapt: loadModel(A).header.meta?.adapt ?? null }, control, measuredAt);
  saveResult(OUT, { stage: 'measure', measuredAt, seconds: (performance.now() - t0) / 1000, ...machine(), provenance: provenance(models), facts: { 'explorer.trained': trained, 'explorer.criterion': criterion } }, false);
  console.log(JSON.stringify({ out: OUT, archived, checks, fresh: trained.fresh, pass, criterionPass: criterion.pass, style }, null, 2));
} else if (stage === 'control') {
  const C = arg('control');
  const E = arg('explorer');
  const T = arg('twin');
  const T2 = arg('twin2');
  if (!C || !E || !T || !T2) throw new Error('--control, --explorer, --twin and --twin2 are required');
  requireSafetyNet(A);
  for (const p of [C, E]) if ((loadModel(p).header.features as string) !== 'v2-self') throw new Error(`${p} is not a v2-self explorer`);
  const run = arg('run', 'training/runs/m6-explorer-twin')!;
  const pairs = numArg('pairs', 2000);
  const threads = numArg('threads', 3);
  const seedHex = arg('seed', 'fa')!;
  const seed = seedArg('seed', 'fa');
  const measuredAt = new Date().toISOString();
  const t = trainingOf(run);
  const arms = { adaptive: adaptiveArm(A), ablated: ablatedArm(A), twin: twinArm(T), twin2: twinArm(T2, 'twin2') };
  const mc = await measure({ kind: 'net', model: C, knobs: NEUTRAL_KNOBS, name: 'control' }, arms, seed, pairs, threads);
  const me = await measure({ kind: 'net', model: E, knobs: NEUTRAL_KNOBS, name: 'explorer' }, arms, seed, pairs, threads);
  const score = (m: typeof mc, name: string) => {
    const p = pairedSummary(m.pooled(name), new Array<number>(m.pooled(name).length).fill(0));
    return { mean: round(p.mean, 5), se: round(p.se, 5), ci95: p.ci95.map((v) => round(v, 5)), pairs: p.pairs };
  };
  const side = (m: typeof mc) => ({
    scores: { vsAdaptive: score(m, 'adaptive'), vsAblated: score(m, 'ablated'), vsTwin: score(m, 'twin'), vsTwin2: score(m, 'twin2') },
    adaptationPart: fmt(pairedSummary(m.pooled('adaptive'), m.pooled('ablated'))),
    gainOverTwin: fmt(pairedSummary(m.pooled('adaptive'), m.pooled('twin'))),
    basePart: fmt(pairedSummary(m.pooled('ablated'), m.pooled('twin'))),
    seedFloorSeenByExplorer: fmt(pairedSummary(m.pooled('twin2'), m.pooled('twin'))),
  });
  const models = { control: C, explorer: E, adaptive: A, twin: T, twin2: T2 };
  const ta = t.args;
  // The twin the control trained against (its league_fixed), next to the twin measured here.
  const trainedAgainst = typeof ta.league_fixed === 'string' && existsSync(ta.league_fixed) ? { path: ta.league_fixed, sha256: sha256File(ta.league_fixed) } : null;
  const otherTwin = trainedAgainst && trainedAgainst.sha256 !== sha256File(T) ? ` It trained against the twin file ${trainedAgainst.path} (SHA-256 ${trainedAgainst.sha256.slice(0, 8)}); the twin measured here is ${T}, another file.` : '';
  const control = {
    measuredAt,
    method: `Control of the trained explorer: a network trained exactly as explorer.trained (start ${dirname(String(ta.init_actor))}, features v2-self, one episode per match, seeds ${String(ta.seed_base)}, the same options) but with the twin as served in the league (Zap knobs; the twin reads nothing) instead of the adaptive network, for the same number of PPO iterations: ${t.ppo} after ${t.metrics.length - t.ppo} of critic warm-up, ${t.metrics.reduce((a: number, x: any) => a + x.decisions, 0)} decisions, ${String(ta.workers)} workers and ${String(ta.threads)} learner threads, ${round(t.seconds / 60, 1)} minutes. Periodic check every ${String(ta.eval_every)} iterations: ${String(ta.eval_pairs)} pairs per segment (seed 3e) against the twin. Measured on new deals (seed ${seedHex}, pairs 0 to ${pairs - 1} per segment, a seed no other bench uses), duplicate format, the control and the trained explorer (explorer.trained) each with neutral knobs against the adaptive network as served, the ablated network, the twin and the second twin, all with the Zap knobs. asServed: the trained explorer's score against the adaptive network minus the control's score against the twin, pair by pair on the same deals (how much more a best response of this budget takes from the adaptive file as served than from the twin as served). base: the trained explorer's score against the ablated network minus the control's score against the twin.${otherTwin}`,
    explorer: C,
    training: {
      run,
      features: 'v2-self',
      iterations: t.metrics.length,
      ppoIterations: t.ppo,
      criticWarmup: t.metrics.length - t.ppo,
      decisions: t.metrics.reduce((a: number, x: any) => a + x.decisions, 0),
      matches: t.metrics.reduce((a: number, x: any) => a + x.matches, 0),
      minutes: round(t.seconds / 60, 1),
      workers: ta.workers,
      threads: ta.threads,
      against: trainedAgainst,
      args: Object.fromEntries(['iters', 'decisions', 'lr', 'entropy', 'magnet_kl', 'magnet_every', 'episode', 'league_mix', 'league_fixed', 'league_as_served', 'eval_served', 'two_styles', 'partner_swap', 'four_players', 'mineiro', 'random_options', 'no_stats_share', 'adapt_beta', 'seed_base', 'init_actor', 'max_hours'].map((k) => [k, ta[k]])),
      checks: t.checks.map((c) => ({ iteration: c.iteration, vsTwin: c.vsServed })),
    },
    fresh: {
      seed: seedHex,
      pairsPerSegment: pairs,
      control: side(mc),
      trained: side(me),
      asServed: fmt(pairedSummary(me.pooled('adaptive'), mc.pooled('twin'))),
      base: fmt(pairedSummary(me.pooled('ablated'), mc.pooled('twin'))),
      crossControlVsAdaptiveMinusTwin: fmt(pairedSummary(mc.pooled('adaptive'), mc.pooled('twin'))),
      crossTrainedVsTwinMinusControlVsTwin: fmt(pairedSummary(me.pooled('twin'), mc.pooled('twin'))),
    },
    models: modelHashes(models),
  };
  const archived = archive(CONTROL_OUT, 'explorer.control', sha256File(A));
  if (archived) process.stderr.write(`kept the earlier control result as ${archived}\n`);
  saveResult(CONTROL_OUT, { stage: 'control', measuredAt, seconds: (performance.now() - t0) / 1000, ...machine(), provenance: provenance(models), facts: { 'explorer.control': control } }, false);
  console.log(JSON.stringify({ out: CONTROL_OUT, training: { ppo: t.ppo, minutes: control.training.minutes, checks: control.training.checks }, fresh: control.fresh }, null, 2));
} else if (stage === 'facts') {
  const r = readJson<any>(OUT);
  // --words auto (unattended runs): the style numbers in words, said to be numbers only, until a
  // person describes them; words a person wrote are kept.
  const stored: string | null = r.facts['explorer.trained'].style.words ?? null;
  const words = arg('words') === 'auto' ? (stored && !stored.startsWith(AUTO_WORDS) ? stored : autoWords(r.facts['explorer.trained'].style)) : arg('words');
  if (words) r.facts['explorer.trained'].style.words = words;
  if (!r.facts['explorer.trained'].style.words) throw new Error('--words is required: the result file has no description yet');
  const control = existsSync(CONTROL_OUT) ? readJson<any>(CONTROL_OUT) : null;
  const ctl = control ? (control.facts['explorer.control'] as ControlFacts) : null;
  r.facts['explorer.criterion'] = criterionOf(dirname(OUT), { file: OUT, facts: r.facts['explorer.trained'], adapt: adaptOfResult(r) }, ctl && control ? { file: CONTROL_OUT, facts: ctl, adapt: adaptOfResult(control) } : null, new Date().toISOString());
  writeJson(OUT, r);
  saveResult(OUT, r, flag('write-facts'));
  if (control) saveResult(CONTROL_OUT, control, flag('write-facts'));
  console.log(JSON.stringify({ out: OUT, words: r.facts['explorer.trained'].style.words, criterion: { pass: r.facts['explorer.criterion'].pass, why: r.facts['explorer.criterion'].why, method: r.facts['explorer.criterion'].method }, control: CONTROL_OUT && control ? CONTROL_OUT : null, wroteFacts: flag('write-facts') }, null, 2));
} else {
  throw new Error('--stage measure|control|facts');
}
