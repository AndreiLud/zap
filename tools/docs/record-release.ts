// Records in facts.json what the training cycle serves, so the READMEs and the data page's build say
// the truth about the version in play and about the reading during the match (tools/docs/releases.ts
// describes the keys). Run it after an adoption, a promotion, the end of a test window or a
// rollback, then render the READMEs and the data page's view again (DEPLOY.md section 9.6).
//
// Sources, read only:
//   --status <file>      what `cycle.py --json status` printed on the server: the manifest's current
//                        version, control, control share and window end, the cycle's state, profile
//                        and storage mode;
//   --bucket <dir>       or a copy of the models bucket instead (manifest.json, cards/, models/), or
//                        the local S3 stand-in's folder of that bucket (.cache/minio/<bucket>, with
//                        meta/ and data/); give --mode then;
//   --cycle-data <dir>   the cycle's data folder (training/cycle/data/prod on the server): the model
//                        cards (cards/<v>.json), the files of each version (versions/<v>/model.zapw)
//                        and the pairs behind its characters (versions/<v>/persona-pairs.json).
// The cards of --bucket win over those of --cycle-data, so a copy of the bucket taken at one moment
// is read as that moment.
//
// Other options:
//   --facts <path>       the facts file to update (default facts.json);
//   --mode minio|r2      the cycle's storage mode when --status does not give it (minio is a local
//                        copy of the cycle, r2 the owner's server);
//   --ai-adapt on|off    AI_ADAPT of the deploy, by default the one of wrangler.jsonc;
//   --dry-run            print what would be written, write nothing;
//   --judged <file>      a copy of the file the explorer criterion judged (checked by its SHA-256),
//                        when facts.json has no criterionNetwork and the file is not at its path.
//
//   --criterion-network [--judged <file>]
//                        records ai.adaptation.explorer.criterionNetwork, the network digest of the
//                        file the explorer criterion judged (ai.adaptation.explorer.criterion.
//                        servedModel), read at its path or from --judged, checked by its SHA-256.
//
// Every write re-reads facts.json and replaces it through a temporary file and a rename.
//
// Usage on the server (DEPLOY.md section 9.6):
//   $C --json status > training/cycle/data/prod/status-now.json
//   docker compose --profile cycle run --rm -T cycle node tools/docs/record-release.ts \
//     --status training/cycle/data/prod/status-now.json --cycle-data training/cycle/data/prod

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wranglerAiAdapt } from '../data/facts-view.ts';
import { DEFAULT_FACTS, formatFacts, ROOT, writeAtomic } from './facts-docs.ts';
import { networkSha256, sha256Bytes, type CycleRelease, type InPlay, type ReleaseState, type WindowResult } from './releases.ts';

// -----------------------------------------------------------------------------------------------
// Reading the cycle

/** The manifest's fields the record needs; times as ISO. */
export interface ManifestView {
  current: string;
  control: string | null;
  controlShare: number | null;
  controlUntil: string | null;
  /** Versions the manifest holds. */
  models: string[];
  /** createdAt of each manifest entry, when the source holds them (the bucket's manifest.json). */
  createdAt: Record<string, string>;
}

/** What one reading of the cycle gives. */
export interface CycleSnapshot {
  manifest: ManifestView;
  /** state.json promotions: when each version was promoted (ISO). */
  promotions: Record<string, string>;
  cards: Record<string, Record<string, any>>;
  /** Model file bytes by version, when found. */
  files: Record<string, { bytes: Uint8Array; path: string }>;
  /** versions/<v>/persona-pairs.json pairsPerSegment. */
  personaPairs: Record<string, number>;
  profile: string | null;
  mode: string | null;
  sources: Record<string, string | null>;
}

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  throw new Error(`not a time: ${JSON.stringify(v)}`);
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const rel = (p: string) => relative(ROOT, resolve(p)) || '.';

function manifestView(m: Record<string, any>, where: string): ManifestView {
  if (!m || typeof m.current !== 'string') throw new Error(`${where}: no manifest with a current version`);
  const models = Array.isArray(m.models) ? (m.models as string[]) : Object.keys(m.models ?? {});
  const createdAt: Record<string, string> = {};
  if (m.models && !Array.isArray(m.models)) for (const [v, e] of Object.entries(m.models as Record<string, { createdAt?: unknown }>)) if (e?.createdAt !== undefined) createdAt[v] = toIso(e.createdAt)!;
  const share = m.controlShare;
  return {
    current: m.current,
    control: typeof m.control === 'string' ? m.control : null,
    controlShare: typeof share === 'number' && Number.isFinite(share) ? share : null,
    controlUntil: toIso(m.controlUntil),
    models,
    createdAt,
  };
}

/** A folder of the models bucket: a plain copy, or the S3 stand-in's meta/ and data/ layout. Key to path. */
export function bucketFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (existsSync(join(dir, 'meta')) && existsSync(join(dir, 'data'))) {
    for (const f of readdirSync(join(dir, 'meta'))) {
      if (!f.endsWith('.json')) continue;
      const key = readJson(join(dir, 'meta', f)).key;
      if (typeof key === 'string') out.set(key, join(dir, 'data', f.slice(0, -'.json'.length)));
    }
    return out;
  }
  const walk = (sub: string) => {
    for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const key = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(key);
      else out.set(key, join(dir, key));
    }
  };
  walk('');
  return out;
}

export interface ReadOptions {
  status?: string;
  bucket?: string;
  cycleData?: string;
  mode?: string;
}

export function readCycle(o: ReadOptions): CycleSnapshot {
  if (!!o.status === !!o.bucket) throw new Error('give the manifest once: --status <file> or --bucket <dir>');
  const snap: CycleSnapshot = { manifest: null as never, promotions: {}, cards: {}, files: {}, personaPairs: {}, profile: null, mode: o.mode ?? null, sources: {} };
  if (o.status) {
    const raw = readJson(o.status);
    const s = raw && typeof raw === 'object' && 'result' in raw && raw.command === 'status' ? raw.result : raw;
    if (!s?.manifest) throw new Error(`${o.status}: no manifest in the status (${s?.remote ?? 'the cycle printed none'})`);
    snap.manifest = manifestView(s.manifest, o.status);
    snap.profile = typeof s.profile === 'string' ? s.profile : null;
    snap.mode = typeof s.mode === 'string' ? s.mode : snap.mode;
    for (const p of s.state?.promotions ?? []) snap.promotions[p.version] = toIso(p.at)!;
    snap.sources.status = rel(o.status);
  }
  if (o.bucket) {
    const files = bucketFiles(o.bucket);
    const man = files.get('manifest.json');
    if (!man) throw new Error(`${o.bucket}: no manifest.json`);
    snap.manifest = manifestView(readJson(man), o.bucket);
    for (const [key, path] of files) {
      const c = /^cards\/(v\d+)\.json$/.exec(key);
      if (c) snap.cards[c[1]] = readJson(path);
      const m = /^models\/(v\d+)\.zapw$/.exec(key);
      if (m) snap.files[m[1]] = { bytes: readFileSync(path), path: rel(path) };
    }
    snap.sources.bucket = rel(o.bucket);
  }
  if (o.cycleData) {
    const d = o.cycleData;
    if (existsSync(join(d, 'cards'))) {
      for (const f of readdirSync(join(d, 'cards'))) {
        const v = /^(v\d+)\.json$/.exec(f)?.[1];
        if (v && !(v in snap.cards)) snap.cards[v] = readJson(join(d, 'cards', f));
      }
    }
    if (existsSync(join(d, 'versions'))) {
      for (const v of readdirSync(join(d, 'versions'))) {
        const model = join(d, 'versions', v, 'model.zapw');
        if (!(v in snap.files) && existsSync(model)) snap.files[v] = { bytes: readFileSync(model), path: rel(model) };
        const pairs = join(d, 'versions', v, 'persona-pairs.json');
        if (existsSync(pairs)) {
          const per = readJson(pairs).pairsPerSegment;
          if (Number.isInteger(per) && per > 0) snap.personaPairs[v] = per;
        }
      }
    }
    // state.json's promotions only add times: they never go away, so they hold for any moment.
    const state = join(d, 'state.json');
    if (existsSync(state)) for (const p of readJson(state).promotions ?? []) if (!(p.version in snap.promotions)) snap.promotions[p.version] = toIso(p.at)!;
    snap.sources.cycleData = rel(d);
  }
  if (snap.mode !== 'minio' && snap.mode !== 'r2') throw new Error('the cycle\'s storage mode is unknown: give --mode minio (a local copy of the cycle) or --mode r2 (the server)');
  return snap;
}

// -----------------------------------------------------------------------------------------------
// The records

export interface JudgedNetwork {
  sha256: string;
  networkSha256: string;
}

/**
 * The network of the file the explorer criterion judged, when the criterion passed: the recorded
 * digest (criterionNetwork) when it belongs to that file, else the file at servedModel.path when its
 * SHA-256 matches. Null when neither is at hand or the criterion did not pass.
 */
export function judgedNetwork(facts: Record<string, any>, root = ROOT, judgedFile?: string): JudgedNetwork | null {
  const explorer = facts.ai?.adaptation?.explorer;
  const c = explorer?.criterion;
  const served = c?.servedModel;
  if (c?.pass !== true || typeof served?.sha256 !== 'string') return null;
  if (judgedFile) {
    const bytes = readFileSync(judgedFile);
    const sha = sha256Bytes(bytes);
    if (sha !== served.sha256) throw new Error(`${rel(judgedFile)} has SHA-256 ${sha}, the criterion judged ${served.sha256}`);
    return { sha256: sha, networkSha256: networkSha256(bytes) };
  }
  const kept = explorer.criterionNetwork;
  if (kept && kept.sha256 === served.sha256 && typeof kept.networkSha256 === 'string') return { sha256: kept.sha256, networkSha256: kept.networkSha256 };
  const path = typeof served.path === 'string' ? join(root, served.path) : null;
  if (path && existsSync(path)) {
    const bytes = readFileSync(path);
    if (sha256Bytes(bytes) === served.sha256) return { sha256: served.sha256, networkSha256: networkSha256(bytes) };
  }
  return null;
}

function windowResult(ab: any): WindowResult | null {
  if (!ab || typeof ab !== 'object') return null;
  return {
    matches: { candidate: ab.matches?.candidate ?? 0, control: ab.matches?.control ?? 0 },
    people: ab.people ?? null,
    drop: ab.drop ?? null,
    lo: ab.lo ?? null,
    hi: ab.hi ?? null,
    detectablePoints: ab.detectablePoints ?? null,
    rolledBack: !!ab.rolledBack,
  };
}

const GATE_KEYS = ['stats', 'pass', 'reasons', 'seconds', 'seed', 'sprt', 'segments', 'panel', 'personas'] as const;

/** The release record of one version the cycle published, merged over what facts.json already holds. */
export function releaseRecord(v: string, snap: CycleSnapshot, judged: JudgedNetwork | null, aiAdapt: 'on' | 'off', now: string, before?: Partial<CycleRelease>): CycleRelease {
  const card = snap.cards[v];
  if (!card) throw new Error(`no card for ${v}: give --cycle-data or a --bucket that holds cards/${v}.json`);
  const model = card.model ?? {};
  if (!card.gate) throw new Error(`the card of ${v} has no gate`);
  const m = snap.manifest;
  const promotedAt = snap.promotions[v] ?? before?.window?.from ?? m.createdAt[v] ?? toIso(card.ab?.from) ?? (card.result === 'promoted' ? toIso(card.resultAt) : null);
  if (!promotedAt) throw new Error(`no promotion time for ${v}`);
  const inWindow = m.current === v && m.control !== null;
  const state: ReleaseState = inWindow ? 'window' : m.current === v ? 'current' : card.result === 'rolled-back' ? 'rolled-back' : 'replaced';
  const file = snap.files[v];
  let network: CycleRelease['network'] = { sha256: before?.network?.sha256 ?? null, file: before?.network?.file ?? null };
  if (file) {
    const sha = sha256Bytes(file.bytes);
    if (sha !== model.sha256) throw new Error(`${file.path} has SHA-256 ${sha}, the card of ${v} says ${model.sha256}`);
    network = { sha256: networkSha256(file.bytes), file: file.path };
  }
  // The cycle's own explorer step, when the card has one (cards of reading files, once the step exists).
  const ce = card.explorer && typeof card.explorer === 'object' ? card.explorer : null;
  const verdicts = Array.isArray(ce?.verdicts) ? (ce.verdicts as { explorer: string; upper95: number; pass: boolean }[]) : [];
  const worst = [...verdicts].sort((a, b) => b.upper95 - a.upper95)[0];
  const explorer: CycleRelease['explorer'] = ce
    ? {
        pass: ce.pass === true,
        source: String(ce.source ?? ''),
        limit: ce.limit,
        network: typeof ce.network === 'string' ? ce.network : null,
        verdicts: verdicts.length,
        passing: verdicts.filter((x) => x.pass).length,
        worst: worst ? { explorer: worst.explorer, upper95: worst.upper95 } : null,
      }
    : null;
  const judgedMatch = network.sha256 && judged ? network.sha256 === judged.networkSha256 : null;
  const explorerTested = judgedMatch === true || explorer?.pass === true ? true : judgedMatch === false || explorer ? false : (before?.explorerTested ?? null);
  // A file that reads must never be told as untested only because the tool could not compare it.
  if (explorerTested === null && model.features === 'v2' && model.adapt) {
    throw new Error(
      `cannot tell whether ${v} is the network the explorer test judged: ${file ? 'facts.json has no ai.adaptation.explorer.criterionNetwork for the judged file and the file is not at its path' : `no model file for ${v} (give --cycle-data, whose versions/${v}/model.zapw holds it)`}; give --judged <a copy of the judged file>`,
    );
  }
  const gate: Record<string, unknown> = {};
  for (const k of GATE_KEYS) if (card.gate[k] !== undefined) gate[k] = card.gate[k];
  const stats = card.personas?.stats as Record<string, { vsZap?: number }> | undefined;
  const rolledTo = typeof card.reason === 'string' ? (/rolled back to (v\d+)/i.exec(card.reason)?.[1] ?? null) : null;
  const result = windowResult(card.ab);
  return {
    date: promotedAt.slice(0, 10),
    version: v,
    origin: 'cycle',
    parent: card.parent ?? null,
    cycleId: card.cycleId ?? null,
    file: `models/${v}.zapw`,
    sha256: model.sha256,
    bytes: model.bytes,
    features: model.features,
    inputs: model.inputs,
    hidden: model.hidden,
    adapt: model.adapt ?? null,
    network,
    explorerTested,
    explorer,
    card: { result: card.result, resultAt: toIso(card.resultAt), reason: card.reason ?? null },
    gate: { ...gate, where: snap.mode === 'r2' ? 'server' : 'local' } as CycleRelease['gate'],
    personas: stats
      ? {
          pairsPerSegment: snap.personaPairs[v] ?? before?.personas?.pairsPerSegment ?? null,
          orderHolds: typeof card.personas.orderHolds === 'boolean' ? card.personas.orderHolds : null,
          vsZap: Object.fromEntries(Object.entries(stats).filter(([, s]) => typeof s?.vsZap === 'number').map(([id, s]) => [id, s.vsZap as number])),
        }
      : null,
    training: { iterations: Number.isInteger(card.training?.iterations) ? card.training.iterations : null, humanModel: !!card.training?.humanModel },
    data: card.data ? { validMatches: card.data.validMatches ?? 0, people: card.data.people ?? null } : null,
    window: {
      control: inWindow ? m.control : (before?.window?.control ?? card.parent ?? null),
      share: inWindow ? m.controlShare : (before?.window?.share ?? m.controlShare),
      from: promotedAt,
      until: inWindow ? m.controlUntil : (toIso(card.ab?.until) ?? before?.window?.until ?? null),
      result,
    },
    state,
    rolledBack: card.result === 'rolled-back' ? { at: toIso(card.resultAt)!, to: rolledTo } : null,
    adaptation: { AI_ADAPT: aiAdapt },
    recordedAt: now,
  };
}

export interface Records {
  inPlay: InPlay;
  releases: Record<string, CycleRelease>;
}

/** The records of every version the cycle published (bundled versions keep their own facts). */
export function buildRecords(facts: Record<string, any>, snap: CycleSnapshot, aiAdapt: 'on' | 'off', now: string, judgedFile?: string): Records {
  const boot = facts.ai?.bootstrapModel ?? {};
  const bundled = new Set([boot.version, boot.previous?.version].filter((x) => typeof x === 'string'));
  const judged = judgedNetwork(facts, ROOT, judgedFile);
  const m = snap.manifest;
  const versions = [...new Set([...m.models, ...Object.keys(snap.promotions)])].filter((v) => !bundled.has(v));
  const releases: Record<string, CycleRelease> = {};
  for (const v of versions.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const card = snap.cards[v];
    if (!card || !['promoted', 'rolled-back'].includes(card.result)) continue;
    releases[v] = releaseRecord(v, snap, judged, aiAdapt, now, facts.ai?.releases?.[v]);
  }
  if (!bundled.has(m.current) && !releases[m.current]) throw new Error(`the manifest's current version ${m.current} has no card that says it was promoted`);
  if (m.control !== null && m.controlShare === null) throw new Error('a test window is open and the status gives no control share: update the cycle (its status prints manifest.controlShare) or record from --bucket');
  return {
    inPlay: {
      version: m.current,
      control: m.control,
      controlShare: m.controlShare,
      controlUntil: m.control !== null ? m.controlUntil : null,
      AI_ADAPT: aiAdapt,
      recordedAt: now,
      cycle: { profile: snap.profile, mode: snap.mode },
      source: snap.sources,
    },
    releases,
  };
}

/** facts with the records merged: ai.inPlay replaced, ai.releases.<v> replaced, every other key kept in place. */
export function mergeRecords(facts: Record<string, any>, records: Records): Record<string, any> {
  const ai = { ...(facts.ai ?? {}) };
  ai.releases = { ...(ai.releases ?? {}), ...records.releases };
  ai.inPlay = records.inPlay;
  return { ...facts, ai };
}

// -----------------------------------------------------------------------------------------------
// facts.json

function readFacts(path: string): { text: string; facts: Record<string, any> } {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    const text = readFileSync(path, 'utf8');
    try {
      return { text, facts: JSON.parse(text) };
    } catch (e) {
      last = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw last;
}

/** Re-reads facts.json, applies `change` and writes it atomically; starts again when the file moved meanwhile. */
export function updateFacts(path: string, change: (facts: Record<string, any>) => Record<string, any>): Record<string, any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { text, facts } = readFacts(path);
    const next = change(facts);
    const out = formatFacts(next);
    if (readFileSync(path, 'utf8') !== text) continue;
    if (out !== text) writeAtomic(path, out);
    return next;
  }
  throw new Error(`${path} kept changing while the records were written: run again`);
}

/** ai.adaptation.explorer.criterionNetwork from the judged file (its path, or `judgedFile`). */
export function criterionNetwork(facts: Record<string, any>, judgedFile: string | undefined, now: string): Record<string, unknown> {
  const served = facts.ai?.adaptation?.explorer?.criterion?.servedModel;
  if (typeof served?.sha256 !== 'string') throw new Error('facts.json has no ai.adaptation.explorer.criterion.servedModel.sha256');
  const path = judgedFile ?? join(ROOT, served.path);
  const bytes = readFileSync(path);
  const sha = sha256Bytes(bytes);
  if (sha !== served.sha256) throw new Error(`${rel(path)} has SHA-256 ${sha}, the criterion judged ${served.sha256}`);
  return {
    sha256: sha,
    networkSha256: networkSha256(bytes),
    method: 'tools/docs/releases.ts networkSha256: SHA-256 of the header with sorted keys and without meta.version, then the tensor bytes',
    file: rel(path),
    computedAt: now,
  };
}

// -----------------------------------------------------------------------------------------------
// Command line

function main(argv: readonly string[]): number {
  const o: ReadOptions & { facts: string; aiAdapt?: 'on' | 'off'; dryRun: boolean; criterion: boolean; judged?: string } = { facts: DEFAULT_FACTS, dryRun: false, criterion: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--status') o.status = resolve(next());
    else if (a === '--bucket') o.bucket = resolve(next());
    else if (a === '--cycle-data') o.cycleData = resolve(next());
    else if (a === '--mode') o.mode = next();
    else if (a === '--facts') o.facts = resolve(next());
    else if (a === '--ai-adapt') {
      const v = next();
      if (v !== 'on' && v !== 'off') throw new Error('--ai-adapt is on or off');
      o.aiAdapt = v;
    } else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--criterion-network') o.criterion = true;
    else if (a === '--judged') o.judged = resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  const now = new Date().toISOString();
  if (o.criterion) {
    const write = (facts: Record<string, any>) => {
      const value = criterionNetwork(facts, o.judged, now);
      const explorer = facts.ai?.adaptation?.explorer;
      if (!explorer) throw new Error('facts.json has no ai.adaptation.explorer');
      const keep = explorer.criterionNetwork;
      if (keep && keep.sha256 === value.sha256 && keep.networkSha256 === value.networkSha256) return facts;
      return { ...facts, ai: { ...facts.ai, adaptation: { ...facts.ai.adaptation, explorer: { ...explorer, criterionNetwork: value } } } };
    };
    if (o.dryRun) console.log(JSON.stringify(write(readFacts(o.facts).facts).ai.adaptation.explorer.criterionNetwork, null, 2));
    else console.log(`record-release: ai.adaptation.explorer.criterionNetwork ${updateFacts(o.facts, write).ai.adaptation.explorer.criterionNetwork.networkSha256} in ${rel(o.facts)}`);
    return 0;
  }
  const snap = readCycle(o);
  const aiAdapt = o.aiAdapt ?? wranglerAiAdapt();
  if (o.dryRun) {
    console.log(JSON.stringify(buildRecords(readFacts(o.facts).facts, snap, aiAdapt, now, o.judged), null, 2));
    return 0;
  }
  let records: Records | null = null;
  updateFacts(o.facts, (facts) => {
    records = buildRecords(facts, snap, aiAdapt, now, o.judged);
    return mergeRecords(facts, records);
  });
  const r = records as unknown as Records;
  const list = Object.values(r.releases).map((x) => `${x.version} ${x.state}`);
  console.log(`record-release: ${rel(o.facts)}: in play ${r.inPlay.version}${r.inPlay.control ? ` (window with ${r.inPlay.control} until ${r.inPlay.controlUntil})` : ''}, AI_ADAPT ${aiAdapt}; ${list.length ? list.join(', ') : 'no version from the cycle'}`);
  console.log('record-release: now render the READMEs (tools/docs/readme-facts.ts) and the data page\'s view (tools/data/facts-view.ts)');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`record-release: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
