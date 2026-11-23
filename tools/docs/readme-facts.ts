// Keeps the numbers of README.md and README.pt-BR.md in step with facts.json.
//
// Each README holds named blocks:
//
//   <!-- facts-template:NAME
//   text with {key:format} placeholders and {?key=value}...{/?} sections
//   -->
//   <!-- facts:NAME -->
//   (the rendered text, written by this tool)
//   <!-- /facts:NAME -->
//
// The template sits in a hidden comment right before the block, so the words stay in the README of
// their language and this file holds no prose. The values come from facts.json (see readmeValues):
// measured keys, and under "docs" the documented values that no run measures (configuration,
// external limits). Until the integration merges them, docs values are also read from the pending
// files of _local/m9/facts-docs/ (tools/docs/facts-docs.ts merges them); facts.json wins.
//
// Formats: int, n0, n1, n2 (plain numbers), pct0, pct1 (a share as a percent), pts0, pts1, pts2 (a
// share or a difference of shares as points: 0.0123 is 1.23), kb (bytes as kilobytes), date (an ISO
// date or time). A string value takes no format. English writes 1,153.5 and Portuguese 1.153,5; a
// negative number takes the minus sign U+2212. Sections keep their text only when the value matches
// ({?reading.state=off-fails}...{/?}, or != to keep it when it does not).
//
// --check also fails when the two READMEs hold different blocks or a block reads other keys in one
// language than in the other, and when a docs value whose source names a setting of this repository
// ("training/cycle/config/prod.toml [section] key", "worker/src/brake.ts NAME") no longer equals it.
//
// Usage:
//   docker compose run --rm -T node node tools/docs/readme-facts.ts           (rewrites the blocks)
//   docker compose run --rm -T node node tools/docs/readme-facts.ts --check   (exit 1 on any difference)
//   options: --facts <path> reads another facts file; --out <dir> writes the rendered READMEs into
//   that folder instead of the repository's (a proof on a copy of facts.json).
//
// The version in play is the bundled model, or the training cycle's version once
// tools/docs/record-release.ts recorded it (tools/docs/releases.ts): its file, strength (its own
// table, or the panel of its promotion gate), gate, characters, decision time and the state of the
// reading (off, in a test with people, on, rolled back) follow it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToml, type TomlDoc } from '../data/lib/toml-lite.ts';
import { DEFAULT_FACTS, DEFAULT_INPUT_DIR, inputFiles, readDocValues, ROOT, type DocValue, type DocValues } from './facts-docs.ts';
import { carriesReading, servedView, type CycleRelease } from './releases.ts';

export type Lang = 'en' | 'pt';
export type Value = number | string;
export type Values = Record<string, Value>;

export const READMES: readonly { path: string; lang: Lang }[] = [
  { path: 'README.md', lang: 'en' },
  { path: 'README.pt-BR.md', lang: 'pt' },
];

// -----------------------------------------------------------------------------------------------
// Values

/** Reads paths of a JSON object and collects every path that is missing or of the wrong type. */
class Reader {
  readonly missing: string[] = [];
  private readonly root: unknown;
  constructor(root: unknown) {
    this.root = root;
  }

  get(path: string): unknown {
    let v: unknown = this.root;
    for (const part of path.split('.')) {
      if (v === null || typeof v !== 'object' || !(part in (v as object))) {
        this.missing.push(path);
        return undefined;
      }
      v = (v as Record<string, unknown>)[part];
    }
    return v;
  }

  /** Like get, with path segments given one by one (for keys that hold dots or dashes). */
  at(...parts: string[]): unknown {
    let v: unknown = this.root;
    for (const part of parts) {
      if (v === null || typeof v !== 'object' || !(part in (v as object))) {
        this.missing.push(parts.join(' > '));
        return undefined;
      }
      v = (v as Record<string, unknown>)[part];
    }
    return v;
  }

  num(v: unknown, path: string): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v !== undefined) this.missing.push(`${path} (a number)`);
    return Number.NaN;
  }

  str(v: unknown, path: string): string {
    if (typeof v === 'string') return v;
    if (v !== undefined) this.missing.push(`${path} (a string)`);
    return '';
  }
}

interface Interval {
  mean: number;
  lo: number;
  hi: number;
}

/** One verdict of the explorer criterion: an explorer measured against the file that would be served. */
interface Verdict {
  explorer: string;
  pass: boolean;
  part: { mean: number; ci95: [number, number]; upper95: number };
}

/** Every verdict under criterion.verdicts, wherever it sits (scripted attempts, trained, control, others). */
export function collectVerdicts(node: unknown, out: Verdict[] = []): Verdict[] {
  if (Array.isArray(node)) {
    for (const x of node) collectVerdicts(x, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const part = o.adaptationPart as Verdict['part'] | undefined;
    if (part && typeof part.upper95 === 'number' && typeof o.pass === 'boolean') {
      out.push({ explorer: typeof o.explorer === 'string' ? o.explorer : '?', pass: o.pass, part });
    } else {
      for (const v of Object.values(o)) collectVerdicts(v, out);
    }
  }
  return out;
}

/** The short name of an explorer: a file path gives its folder (training/runs/m6-explorer/explorer.zapw is m6-explorer). */
function explorerName(e: string): string {
  const m = /^training\/runs\/([^/]+)\//.exec(e);
  return m ? m[1] : e;
}

/** A bound near a limit, rounded to 0.01 point away from the limit so it never reads as the limit. */
function awayFromLimit(v: number, limit: number): number {
  const points = v * 100;
  const r = v > limit ? Math.ceil(points * 100 - 1e-9) / 100 : Math.floor(points * 100 + 1e-9) / 100;
  return r / 100;
}

/**
 * The flat table of values the templates may use, from facts.json and its docs values. Throws one
 * error listing every missing key.
 */
export function readmeValues(facts: Record<string, unknown>, docs: DocValues): Values {
  const r = new Reader(facts);
  const v: Values = {};
  const iso: string[] = [];
  const date = (key: string, value: unknown, path: string) => {
    const s = r.str(value, path);
    if (s) {
      v[key] = s;
      iso.push(s);
    }
  };

  // The version in play and its file: the bundled model, or the version of the training cycle that
  // tools/docs/record-release.ts recorded (ai.inPlay and ai.releases.<v>, tools/docs/releases.ts).
  const boot = 'ai.bootstrapModel';
  const view = servedView(facts);
  const cyc = view.cycle;
  const version = view.inPlay ? view.version : r.str(r.get(`${boot}.version`), `${boot}.version`);
  if (view.inPlay && !cyc && version !== r.get(`${boot}.version`)) r.missing.push(`ai.releases.${version} (ai.inPlay names ${version}: only the bundled ${String(r.get(`${boot}.version`))} or a recorded cycle version can be told)`);
  if (view.inPlay) iso.push(view.inPlay.recordedAt);
  v['served.version'] = version;
  const fileOf = cyc ? `ai.releases.${version}` : boot;
  v['served.previous'] = cyc ? r.str(cyc.parent, `${fileOf}.parent`) : r.str(r.get(`${boot}.previous.version`), `${boot}.previous.version`);
  v['model.features'] = r.str(r.get(`${fileOf}.features`), `${fileOf}.features`);
  v['model.inputs'] = r.num(r.get(`${fileOf}.inputs`), `${fileOf}.inputs`);
  v['model.bytes'] = r.num(r.get(`${fileOf}.bytes`), `${fileOf}.bytes`);
  const hidden = r.get(`${fileOf}.hidden`);
  if (Array.isArray(hidden) && hidden.length > 0 && hidden.every((h) => h === hidden[0])) {
    v['model.layers'] = hidden.length;
    v['model.hidden'] = hidden[0] as number;
  } else {
    r.missing.push(`${fileOf}.hidden (layers of one size)`);
  }
  const release = `ai.releases.${version}`;
  date('model.date', r.at('ai', 'releases', version, 'date'), `${release}.date`);
  // The file the explorer criterion judged, as a network: a cycle version exported again from it
  // has the same digest (record-release.ts, judgedNetwork).
  const judgedNet = (() => {
    const e = (facts as { ai?: { adaptation?: { explorer?: Record<string, any> } } }).ai?.adaptation?.explorer;
    const kept = e?.criterionNetwork;
    return kept && typeof kept.networkSha256 === 'string' && kept.sha256 === e?.criterion?.servedModel?.sha256 ? (kept.networkSha256 as string) : null;
  })();
  const isJudged = (x: CycleRelease | null | undefined) => !!x && !!judgedNet && x.network?.sha256 === judgedNet;

  // Rules engine.
  const results = r.get('engine.speed.results');
  if (Array.isArray(results) && results.length) {
    const hps = results.map((x) => (x as { handsPerSecond: number }).handsPerSecond);
    v['engine.min'] = Math.min(...hps);
    v['engine.max'] = Math.max(...hps);
  } else {
    r.missing.push('engine.speed.results');
  }
  date('engine.date', r.get('engine.speed.measuredAt'), 'engine.speed.measuredAt');

  // Decision time of the version in play: its own row, or for a cycle version with the network the
  // explorer criterion judged, the time measured on that file (ai.adaptation.decisionTime, whose
  // model is the judged path). Otherwise the row says it was not measured.
  const ad = (facts as { ai?: { adaptation?: Record<string, any> } }).ai?.adaptation ?? {};
  const byVersion = (facts as { ai?: { decisionTimeByVersion?: Record<string, unknown> } }).ai?.decisionTimeByVersion?.[version];
  const judgedTime = cyc && isJudged(cyc) && ad.decisionTime?.model === ad.explorer?.criterion?.servedModel?.path ? ad.decisionTime : null;
  v['decision.state'] = byVersion || !cyc ? 'measured' : judgedTime ? 'measured' : 'unmeasured';
  v['decision.source'] = byVersion || !cyc ? 'own' : judgedTime ? 'judged' : 'none';
  if (v['decision.state'] === 'measured') {
    const base = byVersion || !cyc ? ['ai', 'decisionTimeByVersion', version] : ['ai', 'adaptation', 'decisionTime'];
    const dt = (...p: string[]) => r.num(r.at(...base, ...p), `${base.join('.')}.${p.join('.')}`);
    v['decision.p50'] = dt('decisionMs', 'p50');
    v['decision.p99'] = dt('decisionMs', 'p99');
    v['decision.eventP99'] = dt('roomEventMs', 'p99');
    date('decision.date', r.at(...base, 'measuredAt'), `${base.join('.')}.measuredAt`);
  }

  // Strength of the version in play, and of the previous one on the same deals.
  const row = (ver: string, key: string): Interval & { pairs: number } => {
    const path = `ai.strengthByVersion.${ver}.table.${key}.overall`;
    const o = r.at('ai', 'strengthByVersion', ver, 'table', key, 'overall') as { mean?: number; ci95?: number[]; pairs?: number } | undefined;
    const mean = r.num(o?.mean, `${path}.mean`);
    const ciRaw = o?.ci95;
    const ci = Array.isArray(ciRaw) ? ciRaw : [Number.NaN, Number.NaN];
    if (o && !Array.isArray(ciRaw)) r.missing.push(`${path}.ci95`);
    return { mean, lo: ci[0], hi: ci[1], pairs: r.num(o?.pairs, `${path}.pairs`) };
  };
  const prev = v['served.previous'] as string;
  // A cycle version has no strength table of its own: its promotion gate played the same rivals,
  // the frozen panel, with the previous version on the same deals (candidate and current).
  const ownTable = (facts as { ai?: { strengthByVersion?: Record<string, unknown> } }).ai?.strengthByVersion?.[version];
  v['strength.source'] = cyc && !ownTable ? 'gate' : 'table';
  if (v['strength.source'] === 'table') {
    const rows = { random: row(version, 'zap-random'), base: row(version, 'zap-heuristic'), tuned: row(version, 'zap-tuned'), previous: row(version, `zap-${prev}`) };
    for (const [k, x] of Object.entries(rows)) {
      v[`strength.${k}`] = x.mean;
      v[`strength.${k}Lo`] = x.lo;
      v[`strength.${k}Hi`] = x.hi;
    }
    const pairs = new Set(Object.values(rows).map((x) => x.pairs));
    if (pairs.size === 1) v['strength.pairs'] = [...pairs][0];
    else r.missing.push(`ai.strengthByVersion.${version}.table: one number of pairs for every row`);
    v['strength.prevRandom'] = row(prev, 'zap-random').mean;
    v['strength.prevBase'] = row(prev, 'zap-heuristic').mean;
    v['strength.prevTuned'] = row(prev, 'zap-tuned').mean;
    date('strength.date', r.at('ai', 'strengthByVersion', version, 'measuredAt'), `ai.strengthByVersion.${version}.measuredAt`);
  } else {
    type Member = { member: string; pairs: number; candidate: { mean: number; lo: number; hi: number }; current: { mean: number } };
    const panel = (cyc!.gate.panel ?? []) as Member[];
    const member = (m: string) => panel.find((x) => x.member === m) ?? (r.missing.push(`${release}.gate.panel member ${m}`), undefined);
    const rows = { random: member('random'), base: member('base'), tuned: member('tuned'), previous: member(prev) };
    for (const [k, x] of Object.entries(rows)) {
      v[`strength.${k}`] = r.num(x?.candidate?.mean, `${release}.gate.panel ${k}.candidate.mean`);
      v[`strength.${k}Lo`] = r.num(x?.candidate?.lo, `${release}.gate.panel ${k}.candidate.lo`);
      v[`strength.${k}Hi`] = r.num(x?.candidate?.hi, `${release}.gate.panel ${k}.candidate.hi`);
    }
    const pairs = new Set(Object.values(rows).map((x) => x?.pairs));
    if (pairs.size === 1 && typeof rows.random?.pairs === 'number') v['strength.pairs'] = rows.random.pairs;
    else r.missing.push(`${release}.gate.panel: one number of pairs for every member`);
    v['strength.prevRandom'] = r.num(rows.random?.current?.mean, `${release}.gate.panel random.current.mean`);
    v['strength.prevBase'] = r.num(rows.base?.current?.mean, `${release}.gate.panel base.current.mean`);
    v['strength.prevTuned'] = r.num(rows.tuned?.current?.mean, `${release}.gate.panel tuned.current.mean`);
    date('strength.date', cyc!.date, `${release}.date`);
  }

  // The gate the version in play passed.
  const gate = (...p: string[]) => r.at('ai', 'releases', version, 'gate', ...p);
  const gpath = `${release}.gate`;
  const pass = gate('pass');
  v['gate.result'] = pass === true ? 'pass' : pass === false ? 'fail' : (r.missing.push(`${gpath}.pass`), '');
  v['gate.sprtPairs'] = r.num(gate('sprt', 'pairs'), `${gpath}.sprt.pairs`);
  v['gate.sprtMean'] = r.num(gate('sprt', 'mean'), `${gpath}.sprt.mean`);
  const seg = (s: string) => r.num(gate('segments', s, 'mean'), `${gpath}.segments.${s}.mean`);
  v['gate.paulista1'] = seg('paulista-2');
  v['gate.paulista2'] = seg('paulista-4');
  v['gate.mineiro1'] = seg('mineiro-2');
  v['gate.mineiro2'] = seg('mineiro-4');
  v['gate.segPairs'] = r.num(gate('segments', 'paulista-2', 'pairs'), `${gpath}.segments.paulista-2.pairs`);
  const panel = gate('panel');
  if (Array.isArray(panel) && panel.length) {
    const members = panel as { member: string; pairs: number; diff: { mean: number; lo95: number } }[];
    v['gate.panelPairs'] = members[0].pairs;
    const lowest = Math.min(...members.map((m) => m.diff.lo95));
    v['gate.panelLowest'] = lowest;
    v['gate.panelLowestAbs'] = Math.abs(lowest);
    v['gate.panelSide'] = lowest >= 0 ? 'above' : 'below';
    for (const m of members) v[`gate.panel.${m.member}`] = m.diff.mean;
  } else {
    r.missing.push(`${gpath}.panel`);
  }
  date('gate.date', r.at('ai', 'releases', version, 'date'), `${release}.date`);
  // Where the gate ran: a cycle record says (minio is a local copy of the cycle, r2 the server); the
  // bundled releases were gated on a local copy (their gate.method).
  v['gate.where'] = cyc ? cyc.gate.where : 'local';
  v['gate.stats'] = r.str(gate('stats'), `${gpath}.stats`);
  // The window with people of the version in play, and whether any version of the cycle had one.
  const w = cyc?.window ?? null;
  v['window.any'] = view.cycleReleases.some((x) => x.window) ? 'yes' : 'no';
  v['window.state'] = !w ? 'none' : cyc!.state === 'window' ? 'open' : w.until && w.result ? 'closed' : 'none';
  // A planned end is not a measurement: it stays out of the snapshot's date.
  if (w && v['window.state'] !== 'none') v['window.until'] = r.str(w.until, `${release}.window.until`);
  // Gaps of the cycle that the texts must not paper over: a release trained with the human model
  // needs words this README does not have yet.
  if (cyc?.training?.humanModel) r.missing.push(`words for ${version}, trained with the human behaviour model (README "human" block)`);
  // A window on the server had people in it; a local copy of the cycle (a proof) had scripted players.
  v['prod.state'] = view.cycleReleases.some((x) => x.gate?.where === 'server') ? 'server' : v['window.any'] === 'yes' ? 'local-window' : 'none';
  v['human.state'] = v['prod.state'] === 'server' ? 'window' : 'none';

  // The characters of the version in play, on the gate's fresh deals: its own measurement, or for a
  // cycle version the numbers of its model card (the gate's order check on fresh deals).
  const ownChars = (facts as { ai?: { personasByVersion?: Record<string, unknown> } }).ai?.personasByVersion?.[version];
  if (ownChars || !cyc) {
    const pv = (...p: string[]) => r.at('ai', 'personasByVersion', version, ...p);
    const ppath = `ai.personasByVersion.${version}`;
    for (const c of ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap']) v[`chars.${c}`] = r.num(pv('freshCheck', 'vsZap', c, 'mean'), `${ppath}.freshCheck.vsZap.${c}.mean`);
    v['chars.pairs'] = r.num(pv('freshCheck', 'pairsPerSegment'), `${ppath}.freshCheck.pairsPerSegment`);
    for (const [c, key] of [['otavio', 'otavioGap'], ['iara', 'iaraGap']] as const) {
      const m = pv('freshCheck', 'margins', c) as { diff?: number; ci95?: number[] } | undefined;
      const d = r.num(m?.diff, `${ppath}.freshCheck.margins.${c}.diff`);
      v[`chars.${key}`] = -d;
      if (m && Array.isArray(m.ci95)) {
        v[`chars.${key}Lo`] = -m.ci95[1];
        v[`chars.${key}Hi`] = -m.ci95[0];
      } else {
        r.missing.push(`${ppath}.freshCheck.margins.${c}.ci95`);
      }
    }
    date('chars.date', pv('measuredAt'), `${ppath}.measuredAt`);
  } else {
    const p = cyc.personas;
    if (!p) r.missing.push(`${release}.personas`);
    else if (typeof p.pairsPerSegment !== 'number') r.missing.push(`${release}.personas.pairsPerSegment (record again with --cycle-data, which holds versions/${version}/persona-pairs.json)`);
    else {
      for (const c of ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap']) v[`chars.${c}`] = r.num(p.vsZap?.[c] ?? null, `${release}.personas.vsZap.${c}`);
      v['chars.pairs'] = p.pairsPerSegment;
    }
    date('chars.date', cyc.date, `${release}.date`);
  }
  // How well the characters' styles separate: measured per version; for a version without the
  // measurement, the bundled version's, named in the text.
  const sepVersion = (facts as { ai?: { personasByVersion?: Record<string, { styleSeparationCi95?: unknown }> } }).ai?.personasByVersion?.[version]?.styleSeparationCi95
    ? version
    : r.str(r.get(`${boot}.version`), `${boot}.version`);
  v['chars.sepVersion'] = sepVersion;
  v['chars.sepOther'] = sepVersion === version ? 'no' : 'yes';
  const sv = (...p: string[]) => r.at('ai', 'personasByVersion', sepVersion, 'styleSeparationCi95', ...p);
  const spath = `ai.personasByVersion.${sepVersion}.styleSeparationCi95`;
  v['chars.sepTarget'] = r.num(sv('target'), `${spath}.target`);
  v['chars.sepPairs'] = r.num(sv('atTarget', 'pairs'), `${spath}.atTarget.pairs`);
  v['chars.sepAtTarget'] = r.num(sv('atTarget', 'lowerBoundAtLeast80'), `${spath}.atTarget.lowerBoundAtLeast80`);
  v['chars.sepBelow'] = r.num(sv('atTarget', 'upperBoundBelow80'), `${spath}.atTarget.upperBoundBelow80`);
  v['chars.iaraZap'] = r.num(sv('pairs', 'iara-zap', 'accuracy'), `${spath}.pairs.iara-zap.accuracy`);

  // The client.
  const perf = 'client.performance';
  v['client.lcp'] = r.num(r.get(`${perf}.lcp.medianMs`), `${perf}.lcp.medianMs`);
  v['client.lcpBudget'] = r.num(r.get(`${perf}.lcp.budgetMs`), `${perf}.lcp.budgetMs`);
  v['client.tableDrawn'] = r.num(r.get(`${perf}.lcp.tableDrawnMedianMs`), `${perf}.lcp.tableDrawnMedianMs`);
  v['client.js'] = r.num(r.get(`${perf}.tablePath.build.jsGzip9Bytes`), `${perf}.tablePath.build.jsGzip9Bytes`);
  v['client.jsBudget'] = r.num(r.get(`${perf}.tablePath.budgetBytes.js`), `${perf}.tablePath.budgetBytes.js`);
  v['client.css'] = r.num(r.get(`${perf}.tablePath.build.cssGzip9Bytes`), `${perf}.tablePath.build.cssGzip9Bytes`);
  v['client.cssBudget'] = r.num(r.get(`${perf}.tablePath.budgetBytes.css`), `${perf}.tablePath.budgetBytes.css`);
  v['client.tapMax'] = Math.max(r.num(r.get(`${perf}.tap.guided.maxMs`), `${perf}.tap.guided.maxMs`), r.num(r.get(`${perf}.tap.solo.maxMs`), `${perf}.tap.solo.maxMs`));
  v['client.tapBudget'] = r.num(r.get(`${perf}.tap.budgetMs`), `${perf}.tap.budgetMs`);
  v['client.fpsDesktop'] = r.num(r.get(`${perf}.fps.desktop.meanFps`), `${perf}.fps.desktop.meanFps`);
  v['client.fpsPhone'] = r.num(r.get(`${perf}.fps.phone4x.meanFps`), `${perf}.fps.phone4x.meanFps`);
  const perfDates = ['lcp', 'tablePath', 'tap', 'fps'].map((k) => r.str(r.get(`${perf}.${k}.measuredAt`), `${perf}.${k}.measuredAt`)).filter(Boolean).sort();
  if (perfDates.length) date('client.date', perfDates[perfDates.length - 1], `${perf}.*.measuredAt`);

  // The brake.
  const brake = 'worker.brake';
  v['brake.maxSoloRows'] = r.num(r.get(`${brake}.measured.maxRoomDoRowsWritten.solo`), `${brake}.measured.maxRoomDoRowsWritten.solo`);
  v['brake.maxRoomRows'] = r.num(r.get(`${brake}.measured.maxRoomDoRowsWritten.room4`), `${brake}.measured.maxRoomDoRowsWritten.room4`);
  v['brake.budgetSolo'] = r.num(r.get(`${brake}.budget.soloDoRowsWritten`), `${brake}.budget.soloDoRowsWritten`);
  v['brake.budgetRoom'] = r.num(r.get(`${brake}.budget.room4DoRowsWritten`), `${brake}.budget.room4DoRowsWritten`);
  date('brake.measuredDate', r.get(`${brake}.measured.date`), `${brake}.measured.date`);

  // The reading of the opponent during a match.
  const crit = 'ai.adaptation.explorer.criterion';
  const aiAdapt = r.str(r.at('ai', 'releases', version, 'adaptation', 'AI_ADAPT'), `${release}.adaptation.AI_ADAPT`);
  v['reading.aiAdapt'] = aiAdapt;
  const criterion = (facts as { ai?: { adaptation?: { explorer?: { criterion?: Record<string, unknown> } } } }).ai?.adaptation?.explorer?.criterion;
  const critPass = criterion?.pass;
  // The file in play carries the reading (features v2 and a safety net); it reads only with AI_ADAPT
  // on, the rule of GET /api/live. Without it, the text tells the newest cycle version that carried
  // the reading and was rolled back, if any.
  const readsFile = cyc ? carriesReading(cyc.features, cyc.adapt) : carriesReading(v['model.features'], r.get(`${boot}.adapt`));
  const rolled = readsFile ? undefined : [...view.cycleReleases].reverse().find((x) => x.state === 'rolled-back' && carriesReading(x.features, x.adapt));
  const told: CycleRelease | null = cyc && readsFile ? cyc : (rolled ?? null);
  let state: string;
  if (readsFile) state = aiAdapt !== 'on' ? 'noevidence' : cyc ? (cyc.state === 'window' ? 'window' : 'on') : 'on-bundled';
  else if (rolled) state = 'rolled-back';
  else state = critPass === true ? 'off-passes' : critPass === false ? 'off-fails' : 'off-unmeasured';
  v['reading.state'] = state;
  // The window with people of the version in play is open, whatever AI_ADAPT says: with AI_ADAPT off
  // its matches still split into the control group and the test group until the window ends.
  v['reading.windowOpen'] = readsFile && cyc?.state === 'window' ? 'yes' : 'no';
  // The status line of a reading version played at no evidence adds its open window (sections do not nest).
  v['reading.offWindow'] = state === 'noevidence' && v['reading.windowOpen'] === 'yes' ? 'yes' : 'no';
  v['reading.live'] = state === 'window' ? 'window' : state === 'on' || state === 'on-bundled' ? 'on' : 'no';
  // Whether the explorer criterion judged the network the text tells, and passed.
  const servedCrit = criterion?.servedModel as { sha256?: unknown } | undefined;
  const toldJudged = told ? isJudged(told) : readsFile && r.get(`${boot}.sha256`) === servedCrit?.sha256;
  const tells = readsFile || !!rolled;
  // "yes": the network the criterion of facts.json judged; "card": another network, which the
  // cycle's own explorer step passed before its promotion (its card); "no": neither, "none": no
  // verdict anywhere.
  const cardExplorer = told?.explorer?.pass ? told.explorer : null;
  v['reading.tested'] = !tells ? 'n/a' : toldJudged && critPass === true ? 'yes' : cardExplorer ? 'card' : !criterion ? 'none' : 'no';
  if (v['reading.tested'] === 'card') {
    const worst = cardExplorer!.worst;
    v['reading.cardExplorers'] = cardExplorer!.verdicts;
    v['reading.cardLimit'] = r.num(cardExplorer!.limit, `ai.releases.${told!.version}.explorer.limit`);
    if (worst) {
      v['reading.cardWorst'] = explorerName(worst.explorer);
      v['reading.cardWorstUpper'] = awayFromLimit(worst.upper95, cardExplorer!.limit);
    } else r.missing.push(`ai.releases.${told!.version}.explorer.worst (a passing step with no verdict)`);
  }
  v['reading.version'] = told?.version ?? version;
  v['reading.result'] = 'none';
  if (told) {
    const tw = told.window;
    const tpath = `ai.releases.${told.version}.window`;
    v['reading.from'] = r.str(tw?.from, `${tpath}.from`);
    if (state === 'window' || v['reading.windowOpen'] === 'yes') {
      v['reading.control'] = r.str(tw?.control, `${tpath}.control`);
      v['reading.share'] = r.num(tw?.share, `${tpath}.share`);
      v['reading.until'] = r.str(tw?.until, `${tpath}.until`);
    }
    if (state === 'rolled-back') {
      date('reading.rolledAt', told.rolledBack?.at, `ai.releases.${told.version}.rolledBack.at`);
      v['reading.rolledTo'] = told.rolledBack?.to ?? version;
    }
    // The comparison with people once the window ended (or was cut short by the rollback): public
    // only with enough people in each group (the card keeps drop null below that).
    const res = tw?.result;
    if ((state === 'on' || state === 'rolled-back') && res) {
      v['reading.control'] = r.str(tw?.control, `${tpath}.control`);
      if (state === 'on') date('reading.windowEnd', tw?.until, `${tpath}.until`);
      else v['reading.windowEnd'] = v['reading.rolledAt'];
      v['reading.result'] = typeof res.drop === 'number' && typeof res.lo === 'number' && typeof res.hi === 'number' ? 'public' : 'few';
      if (v['reading.result'] === 'public') {
        v['reading.drop'] = res.drop as number;
        v['reading.dropLo'] = res.lo as number;
        v['reading.dropHi'] = res.hi as number;
      }
    }
  }
  v['reading.controlVersion'] = r.str(r.get(`${boot}.version`), `${boot}.version`);
  v['reading.gainSameFile'] = 'no';
  v['reading.caveats'] = 'no';
  v['reading.offPolicy'] = 'no';
  // Measurements of the judged file may be said of the network the text tells only when it is that network.
  const aboutJudged = !tells || v['reading.tested'] === 'yes';
  if (criterion) {
    v['reading.limit'] = r.num(criterion.requirement, `${crit}.requirement`);
    const served = criterion.servedModel as { path?: unknown; sha256?: unknown; adapt?: { bmax?: unknown; nHalf?: unknown } } | undefined;
    v['reading.candidate'] = r.str(served?.sha256, `${crit}.servedModel.sha256`).slice(0, 8);
    v['reading.bmax'] = r.num(served?.adapt?.bmax, `${crit}.servedModel.adapt.bmax`);
    v['reading.nHalf'] = r.num(served?.adapt?.nHalf, `${crit}.servedModel.adapt.nHalf`);
    date('reading.date', criterion.measuredAt, `${crit}.measuredAt`);
    const verdicts = collectVerdicts(criterion.verdicts);
    v['reading.explorers'] = verdicts.length;
    v['reading.explorersPass'] = verdicts.filter((x) => x.pass).length;
    const worst = [...verdicts].sort((a, b) => b.part.upper95 - a.part.upper95)[0];
    if (worst) {
      v['reading.worst'] = explorerName(worst.explorer);
      v['reading.worstMean'] = worst.part.mean;
      v['reading.worstLo'] = worst.part.ci95[0];
      v['reading.worstHi'] = worst.part.ci95[1];
      v['reading.worstUpper'] = awayFromLimit(worst.part.upper95, v['reading.limit'] as number);
    } else if (critPass !== undefined) {
      r.missing.push(`${crit}.verdicts (at least one explorer)`);
    }
    // What reading adds, when it was measured on the file the criterion judges.
    const gainSha = r.get('ai.adaptation.ablation.models.adaptive.sha256');
    const sameFile = typeof gainSha === 'string' && gainSha === served?.sha256;
    // "yes": said of the candidate file (the reading is not live); "told": of the network the status
    // tells, once it is the judged one (in a window, on, or rolled back).
    v['reading.gainSameFile'] = sameFile && aboutJudged ? (tells ? 'told' : 'yes') : 'no';
    if (sameFile && aboutJudged) {
      const g = r.get('ai.adaptation.ablation.pooledGain') as { mean?: number; ci95?: number[] } | undefined;
      const ci = g?.ci95;
      v['reading.gain'] = r.num(g?.mean, 'ai.adaptation.ablation.pooledGain.mean');
      v['reading.gainLo'] = Array.isArray(ci) ? ci[0] : Number.NaN;
      v['reading.gainHi'] = Array.isArray(ci) ? ci[1] : Number.NaN;
    }
    // Two measurements of the same candidate file that weigh against it, said next to the verdict:
    // head to head against its twin (the same training without the statistics), and how much more a
    // trained explorer takes from it as served than a control explorer, trained the same way, takes
    // from the version in play. Each only when it measured the file the criterion judges, and the
    // second only when the control trained against the file in play.
    type Row = { mean?: number; ci95?: number[] };
    const adaptation = (facts as { ai?: { adaptation?: Record<string, any> } }).ai?.adaptation ?? {};
    const h2h = adaptation.headToHead as { adaptive?: string; rows?: Record<string, Row> } | undefined;
    const twinRow = h2h?.rows?.['adaptive-twin'];
    const control = adaptation.explorer?.control as { models?: { adaptive?: { sha256?: string } }; training?: { against?: { sha256?: string } }; fresh?: { asServed?: Row } } | undefined;
    const exploit = control?.fresh?.asServed;
    const bootSha = r.get(`${boot}.sha256`);
    const h2hSame = !!twinRow && Array.isArray(twinRow.ci95) && typeof served?.sha256 === 'string' && h2h?.adaptive === served?.path;
    const exploitSame = !!exploit && Array.isArray(exploit.ci95) && control?.models?.adaptive?.sha256 === served?.sha256 && control?.training?.against?.sha256 === bootSha;
    // The trained explorer's own adaptation part says whether the reading is what it exploits.
    const trained = (criterion.verdicts as { trained?: { adaptationPart?: { mean?: number; upper95?: number } } } | undefined)?.trained?.adaptationPart;
    const readingCosts = typeof trained?.mean === 'number' && typeof trained.upper95 === 'number' && trained.upper95 < 0;
    v['reading.caveats'] = h2hSame && exploitSame && aboutJudged ? (readingCosts ? 'yes-costs' : 'yes') : 'no';
    if (h2hSame && exploitSame && aboutJudged) {
      v['reading.vsTwin'] = r.num(twinRow!.mean, 'ai.adaptation.headToHead.rows.adaptive-twin.mean');
      v['reading.vsTwinLo'] = twinRow!.ci95![0];
      v['reading.vsTwinHi'] = twinRow!.ci95![1];
      v['reading.exploit'] = r.num(exploit!.mean, 'ai.adaptation.explorer.control.fresh.asServed.mean');
      v['reading.exploitLo'] = exploit!.ci95![0];
      v['reading.exploitHi'] = exploit!.ci95![1];
      if (readingCosts) v['reading.trainedCost'] = -trained!.mean!;
    }
    // While the candidate is not live: after an adoption, a table with "Don't adapt to me" plays the
    // same file with the reading off, head to head against its twin; and when runbook step 10 keeps
    // that network from serving while AI_ADAPT is off (servesAdaptiveWhileOff false), the reading is
    // switched off by rolling the cycle back, not with AI_ADAPT. Only for the file the criterion judges.
    // Once that network is in play: "live", what a table with "Don't adapt to me" plays; "all", what
    // every table plays while AI_ADAPT is off. "Weaker" only when the whole interval is under even.
    const off = adaptation.ablation?.offPolicy as { headToHead?: Row; servesAdaptiveWhileOff?: unknown } | undefined;
    const offH2h = off?.headToHead;
    // 'all-window': played at no evidence everywhere but the control group of its open window.
    const offKind = state === 'off-passes' ? 'yes' : !aboutJudged ? 'no' : state === 'window' || state === 'on' ? 'live' : state === 'noevidence' ? (v['reading.windowOpen'] === 'yes' ? 'all-window' : 'all') : 'no';
    if (offKind !== 'no' && sameFile && off?.servesAdaptiveWhileOff === false && typeof offH2h?.mean === 'number' && Array.isArray(offH2h.ci95) && offH2h.ci95[1] < 0.5) {
      v['reading.offPolicy'] = offKind;
      v['reading.offH2h'] = offH2h.mean;
      v['reading.offH2hLo'] = offH2h.ci95[0];
      v['reading.offH2hHi'] = offH2h.ci95[1];
    }
  }

  // Documented values: the cycle's configuration and the brake's settings and capacity.
  const doc = (key: string): DocValue | undefined => {
    const d = docs[key];
    if (!d) r.missing.push(`docs.${key}`);
    return d;
  };
  const docNum = (out: string, key: string) => {
    const d = doc(key);
    if (d) v[out] = r.num(d.value, `docs.${key}.value`);
  };
  const cfg: [string, string][] = [
    ['rule.p0', 'gate.p0'], ['rule.p1', 'gate.p1'], ['rule.alpha', 'gate.alpha'], ['rule.beta', 'gate.beta'],
    ['rule.batchPairs', 'gate.batch_pairs'], ['rule.capPairs', 'gate.cap_pairs'], ['rule.segmentPairs', 'gate.segment_pairs'],
    ['rule.segmentMargin', 'gate.segment_margin'], ['rule.panelPairs', 'gate.panel_pairs'], ['rule.panelMargin', 'gate.panel_margin'],
    ['rule.panelVersions', 'gate.panel_versions'], ['ab.share', 'ab.share'], ['ab.days', 'ab.days'], ['ab.rollbackDrop', 'ab.rollback_drop'],
    ['ab.minMatches', 'ab.min_matches_per_arm'], ['cycle.newMatches', 'schedule.new_matches'], ['cycle.deviceCap', 'data.device_cap'],
    ['th.humanModelMatches', 'thresholds.human_model_matches'], ['th.humanModelDevices', 'thresholds.human_model_devices'],
    ['th.priorsPeople', 'thresholds.priors_people'], ['th.adaptDecisions', 'thresholds.adapt_decisions'],
    ['th.playerTypes', 'thresholds.player_types_devices'], ['th.rankingPeople', 'thresholds.ranking_people'],
    ['th.rankingMatches', 'thresholds.ranking_matches_each'], ['th.openDataMatches', 'thresholds.open_data_matches'],
    ['th.minCellPeople', 'thresholds.min_cell_people'],
  ];
  for (const [out, key] of cfg) docNum(out, `readme.cycle.${key}`);
  if (typeof v['rule.p1'] === 'number' && typeof v['rule.p0'] === 'number') v['rule.gain'] = v['rule.p1'] - v['rule.p0'];
  docNum('brake.headroom', 'readme.brake.headroom');
  docNum('brake.reserve', 'readme.brake.defaultReserve');
  docNum('brake.soloPerDay', 'readme.brake.freeSoloPerDay');
  docNum('brake.soloPerDayLong', 'readme.brake.freeSoloPerDayThreeTimesAsLong');
  const capacity = doc('readme.brake.freeSoloPerDay');
  if (capacity) date('brake.date', capacity.measuredAt ?? capacity.readAt, 'docs.readme.brake.freeSoloPerDay.measuredAt');

  if (r.missing.length) throw new Error(`facts.json lacks what the READMEs need:\n  ${[...new Set(r.missing)].join('\n  ')}`);
  for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`value ${k} is not a finite number`);
  v['snapshot.date'] = iso.map((s) => s.slice(0, 10)).sort()[iso.length - 1];
  return v;
}

// -----------------------------------------------------------------------------------------------
// Formats

const MINUS = '−';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatters = new Map<string, Intl.NumberFormat>();

/**
 * A number with `digits` decimals in the language's separators. Rounding is done by Intl on the
 * decimal value (en-US, the same rounding the data page gets), and the separators are swapped for
 * Portuguese here, so no locale data beyond en-US is needed.
 */
export function formatNumber(v: number, digits: number, lang: Lang, percent = false): string {
  const key = `${digits}|${percent}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { style: percent ? 'percent' : 'decimal', minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true });
    formatters.set(key, f);
  }
  let s = f.format(v).replace('%', '');
  let negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (/^[0.,]+$/.test(s)) negative = false;
  if (lang === 'pt') s = s.replace(/[.,]/g, (c) => (c === ',' ? '.' : ','));
  return (negative ? MINUS : '') + s;
}

export function formatDate(isoText: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoText);
  if (!m) throw new Error(`not an ISO date: ${isoText}`);
  const [, y, mo, d] = m;
  return lang === 'en' ? `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}` : `${d}/${mo}/${y}`;
}

export function formatValue(value: Value, format: string | undefined, lang: Lang, key: string): string {
  if (format === 'date') {
    if (typeof value !== 'string') throw new Error(`{${key}:date}: not a date`);
    return formatDate(value, lang);
  }
  if (typeof value === 'string') {
    if (format) throw new Error(`{${key}:${format}}: a string takes no format`);
    return value;
  }
  const m = /^(int|n|pct|pts)(\d?)$/.exec(format ?? '');
  if (format === 'kb') return formatNumber(value / 1000, 0, lang);
  if (!m) throw new Error(`{${key}}: a number needs a format (int, n0 to n2, pct0, pct1, pts0 to pts2, kb)`);
  const digits = m[1] === 'int' ? 0 : Number(m[2] || 0);
  if (m[1] === 'pct') return `${formatNumber(value, digits, lang, true)}%`;
  if (m[1] === 'pts') return formatNumber(value, digits, lang, true);
  return formatNumber(value, digits, lang);
}

// -----------------------------------------------------------------------------------------------
// Templates and blocks

const TEMPLATE = /<!-- facts-template:([a-z0-9-]+)\n([\s\S]*?)\n-->/g;
const BLOCK = /<!-- facts:([a-z0-9-]+) -->\n([\s\S]*?)<!-- \/facts:\1 -->/g;
// A section opened on its own line ("{?k=v}\n...{/?}\n") takes its closing line break with it; an
// inline one keeps the line break after it, so a section that ends a line or a list item does not
// glue that line to the next.
const SECTION = /\{\?([A-Za-z][\w.]*)(!?=)([\w.-]+)\}(\n?)([\s\S]*?)\{\/\?\}(\n?)/g;
const PLACEHOLDER = /\{([A-Za-z][\w.]*)(?::(\w+))?\}/g;

export interface Parsed {
  templates: Map<string, string>;
  blocks: Map<string, string>;
}

export function parseReadme(text: string, name: string): Parsed {
  const templates = new Map<string, string>();
  const blocks = new Map<string, string>();
  for (const m of text.matchAll(TEMPLATE)) {
    if (templates.has(m[1])) throw new Error(`${name}: template "${m[1]}" appears twice`);
    templates.set(m[1], m[2]);
  }
  for (const m of text.matchAll(BLOCK)) {
    if (blocks.has(m[1])) throw new Error(`${name}: block "${m[1]}" appears twice`);
    blocks.set(m[1], m[2]);
  }
  const opened = [...text.matchAll(/<!-- facts:([a-z0-9-]+) -->/g)].map((m) => m[1]);
  for (const b of opened) if (!blocks.has(b)) throw new Error(`${name}: block "${b}" has no closing <!-- /facts:${b} -->`);
  for (const t of templates.keys()) if (!blocks.has(t)) throw new Error(`${name}: template "${t}" has no block`);
  for (const b of blocks.keys()) if (!templates.has(b)) throw new Error(`${name}: block "${b}" has no template`);
  return { templates, blocks };
}

/** The keys a template reads, in placeholders and in section conditions. */
export function templateKeys(template: string): string[] {
  const keys = new Set<string>();
  for (const m of template.matchAll(SECTION)) keys.add(m[1]);
  for (const m of template.matchAll(PLACEHOLDER)) keys.add(m[1]);
  return [...keys].sort();
}

export function renderTemplate(template: string, values: Values, lang: Lang, name = 'template'): string {
  const missing = (k: string) => new Error(`${name}: no value "${k}"`);
  const kept = template.replace(SECTION, (_all, key: string, op: string, want: string, open: string, body: string, close: string) => {
    if (!(key in values)) throw missing(key);
    const keep = (String(values[key]) === want) === (op === '=');
    return (keep ? body : '') + (open ? '' : close);
  });
  if (/\{\?|\{\/\?\}/.test(kept)) throw new Error(`${name}: a section is not closed or is nested`);
  const out = kept.replace(PLACEHOLDER, (_all, key: string, format: string | undefined) => {
    if (!(key in values)) throw missing(key);
    return formatValue(values[key], format, lang, key);
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** The block content as the README holds it: a blank line on each side, so tables and lists end. */
export function blockContent(rendered: string): string {
  return `\n${rendered}\n\n`;
}

export interface ReadmeResult {
  path: string;
  text: string;
  changed: string[];
}

/** Renders every block of one README; `changed` names the blocks whose content differs. */
export function renderReadme(text: string, lang: Lang, values: Values, name: string): ReadmeResult {
  const { templates } = parseReadme(text, name);
  const changed: string[] = [];
  const next = text.replace(BLOCK, (all, block: string, content: string) => {
    const want = blockContent(renderTemplate(templates.get(block)!, values, lang, `${name} ${block}`));
    if (want === content) return all;
    changed.push(block);
    return `<!-- facts:${block} -->\n${want}<!-- /facts:${block} -->`;
  });
  return { path: name, text: next, changed };
}

/** Both READMEs must hold the same blocks, each reading the same keys. */
export function compareLanguages(a: Parsed, b: Parsed, names: [string, string]): string[] {
  const problems: string[] = [];
  const ka = [...a.templates.keys()].sort();
  const kb = [...b.templates.keys()].sort();
  if (ka.join() !== kb.join()) problems.push(`${names[0]} and ${names[1]} hold different blocks: ${ka.join(', ')} / ${kb.join(', ')}`);
  for (const k of ka) {
    if (!b.templates.has(k)) continue;
    const x = templateKeys(a.templates.get(k)!).join();
    const y = templateKeys(b.templates.get(k)!).join();
    if (x !== y) problems.push(`block "${k}" reads other keys in ${names[0]} (${x}) than in ${names[1]} (${y})`);
  }
  return problems;
}

// -----------------------------------------------------------------------------------------------
// Docs values and their sources

/**
 * The docs values: facts.json "docs" first, then the pending files of _local/m9/facts-docs/ for
 * keys facts.json does not hold yet (before the integration merges them). Each pending file is read
 * on its own, and a file that does not parse or check is skipped with a warning: other areas write
 * there too, and the merge (tools/docs/facts-docs.ts) refuses such a file anyway.
 */
export function docsValues(facts: Record<string, unknown>, pendingDir = DEFAULT_INPUT_DIR): { docs: DocValues; pending: string[]; warnings: string[] } {
  const merged = { ...((facts.docs as DocValues | undefined) ?? {}) };
  const pending: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(pendingDir)) return { docs: merged, pending, warnings };
  for (const file of inputFiles([pendingDir])) {
    let values: DocValues;
    try {
      values = readDocValues([file]);
    } catch (e) {
      warnings.push(`skipped ${file}: ${(e as Error).message}`);
      continue;
    }
    for (const [k, val] of Object.entries(values)) {
      if (k in merged) {
        if (!pending.includes(k)) continue;
        if (JSON.stringify(merged[k]) !== JSON.stringify(val)) warnings.push(`docs.${k} differs between pending files; the first one read is used`);
        continue;
      }
      merged[k] = val;
      pending.push(k);
    }
  }
  return { docs: merged, pending, warnings };
}

/**
 * Docs values whose source names a configuration value of this repository must still equal it:
 * "training/cycle/config/prod.toml [section] key" and "worker/src/brake.ts NAME". Returns the
 * differences.
 */
export function checkDocSources(docs: DocValues, root = ROOT): string[] {
  const problems: string[] = [];
  let toml: TomlDoc | null = null;
  let brake: string | null = null;
  for (const [key, d] of Object.entries(docs)) {
    const t = /^training\/cycle\/config\/prod\.toml \[(\w+)\] (\w+)$/.exec(d.source);
    if (t) {
      toml ??= parseToml(readFileSync(join(root, 'training/cycle/config/prod.toml'), 'utf8'));
      const actual = toml[t[1]]?.[t[2]];
      if (actual !== d.value) problems.push(`docs.${key} is ${d.value}, ${d.source} is ${JSON.stringify(actual)}`);
      continue;
    }
    const b = /^worker\/src\/brake\.ts ([A-Z_]+)$/.exec(d.source);
    if (b) {
      // Read as text: the Worker's code is not loaded into this Node tool.
      brake ??= readFileSync(join(root, 'worker/src/brake.ts'), 'utf8');
      const m = new RegExp(`^export const ${b[1]} = ([0-9.]+);$`, 'm').exec(brake);
      const actual = m ? Number(m[1]) : undefined;
      if (actual !== d.value) problems.push(`docs.${key} is ${d.value}, ${d.source} is ${JSON.stringify(actual)}`);
    }
  }
  return problems;
}

// -----------------------------------------------------------------------------------------------
// Both READMEs

export interface RunResult {
  problems: string[];
  results: ReadmeResult[];
  pending: string[];
  warnings: string[];
}

/** Renders both READMEs from facts.json; writes nothing. `problems` lists every difference or error. */
export function runReadmes(opts: { root?: string; factsPath?: string; pendingDir?: string } = {}): RunResult {
  const root = opts.root ?? ROOT;
  const facts = JSON.parse(readFileSync(opts.factsPath ?? DEFAULT_FACTS, 'utf8')) as Record<string, unknown>;
  const { docs, pending, warnings } = docsValues(facts, opts.pendingDir);
  const values = readmeValues(facts, docs);
  const problems = checkDocSources(docs, root);
  const parsed: Parsed[] = [];
  const results: ReadmeResult[] = [];
  for (const { path, lang } of READMES) {
    const text = readFileSync(join(root, path), 'utf8');
    parsed.push(parseReadme(text, path));
    const res = renderReadme(text, lang, values, path);
    results.push(res);
    for (const b of res.changed) problems.push(`${path}: block "${b}" differs from facts.json (run tools/docs/readme-facts.ts)`);
  }
  problems.push(...compareLanguages(parsed[0], parsed[1], [READMES[0].path, READMES[1].path]));
  return { problems, results, pending, warnings };
}

function main(argv: readonly string[]): number {
  let check = false;
  let factsPath: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--facts') factsPath = resolve(argv[++i] ?? '');
    else if (argv[i] === '--out') out = resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const { problems, results, pending, warnings } = runReadmes({ factsPath });
  if (out) {
    // Rendered copies elsewhere (a proof on a copy of facts.json); the READMEs stay as they are.
    const blocking = problems.filter((p) => !p.includes('differs from facts.json'));
    for (const p of blocking) console.error(`readme-facts: ${p}`);
    mkdirSync(out, { recursive: true });
    for (const res of results) {
      writeFileSync(join(out, res.path), res.text);
      console.log(`readme-facts: ${join(out, res.path)}${res.changed.length ? `: ${res.changed.join(', ')} differ from the repository's` : ': same as the repository\'s'}`);
    }
    return blocking.length ? 1 : 0;
  }
  for (const w of warnings) console.error(`readme-facts: ${w}`);
  if (pending.length) console.error(`readme-facts: ${pending.length} docs values read from _local/m9/facts-docs/, not yet in facts.json (merge them with tools/docs/facts-docs.ts)`);
  if (check) {
    for (const p of problems) console.error(`readme-facts: ${p}`);
    if (problems.length === 0) console.log('readme-facts: both READMEs are in step with facts.json');
    return problems.length ? 1 : 0;
  }
  const blocking = problems.filter((p) => !p.includes('differs from facts.json'));
  for (const p of blocking) console.error(`readme-facts: ${p}`);
  for (const res of results) {
    if (res.changed.length === 0) continue;
    writeFileSync(join(ROOT, res.path), res.text);
    console.log(`readme-facts: ${res.path}: ${res.changed.join(', ')}`);
  }
  return blocking.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`readme-facts: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
