// Every number the project's texts state comes from facts.json, from a setting of the repository, or
// is on an allowlist below with its reason (tests/docs/texts.ts has the rules).
//
// Texts: README.md, README.pt-BR.md, DEPLOY.md, CREDITS.md, project_docs/data-page.md, and the
// Portuguese copy of the deploy guide in _local/ when it exists (it is not part of the repository).
//   (a) tools/docs/readme-facts.ts finds both READMEs in step with facts.json;
//   (b) every number in prose is stated by facts.json at the precision shown, or allowed here, one
//       entry per number and file; an entry with `is` also checks its value against the code or
//       configuration it comes from, so a changed setting fails here until the text follows it;
//   (c) a copy of a README with a planted wrong number fails.
// It also checks the relative links and anchors of the texts, and that the site's locale files hold
// no digit outside the allowlist at the end of this file.
//
// When facts.json changes (a training run writes ai.adaptation), the README blocks may differ: render
// them again with `docker compose run --rm -T node node tools/docs/readme-facts.ts`.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DECK_SIZE, RANKS } from '../../engine/src/cards.ts';
import { TARGET_POINTS, ladderOf, makeConfig, onzeThreshold, onzeValue } from '../../engine/src/config.ts';
import { parseToml, type TomlDoc } from '../../tools/data/lib/toml-lite.ts';
import { docsValues, readmeValues, runReadmes } from '../../tools/docs/readme-facts.ts';
import {
  anchorsOf,
  checkText,
  factAt,
  FactIndex,
  factNumbers,
  linksOf,
  localeNumbers,
  localeStrings,
  plainValue,
  statesNumber,
  tokenOf,
  type Lang,
} from './texts.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** facts.json; a training run rewrites it in place, so a read during its write is tried again. */
function readFacts(): Record<string, unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(read('facts.json')) as Record<string, unknown>;
    } catch (e) {
      if (attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
// The docs values still pending in _local/m9/facts-docs/ count too, as tools/docs/readme-facts.ts
// reads them (facts.json wins); tools/docs/facts-docs.ts merges them into facts.json.
const facts = ((f) => ({ ...f, docs: docsValues(f).docs }))(readFacts());
const index = new FactIndex(factNumbers(facts));

// -----------------------------------------------------------------------------------------------
// Where allowed values come from

type Value = number | string;

/** A value of facts.json; a docs entry gives its value. */
function fact(path: string): Value {
  const f = factAt(facts, path);
  const v = plainValue(f.value);
  if (!f.found || (typeof v !== 'number' && typeof v !== 'string')) throw new Error(`facts.json has no number or string at ${path}`);
  return v;
}

/** wrangler.jsonc without its comments (strings may hold "//"). */
function wrangler(): Record<string, any> {
  const text = read('wrangler.jsonc');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else {
      out += c;
    }
  }
  return JSON.parse(out) as Record<string, any>;
}
const rateLimit = (name: string): number => wrangler().ratelimits.find((r: { name: string }) => r.name === name).simple.limit;

let tomlDoc: TomlDoc | null = null;
function prod(section: string, key: string): Value {
  tomlDoc ??= parseToml(read('training/cycle/config/prod.toml'));
  const v = tomlDoc[section]?.[key];
  if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`prod.toml has no [${section}] ${key}`);
  return v;
}

/** `const NAME = <arithmetic>;` of a source file, evaluated. */
function constant(file: string, name: string): number {
  const m = new RegExp(`^(?:export )?const ${name} = ([0-9_ .*+/()]+);`, 'm').exec(read(file));
  if (!m) throw new Error(`${file} has no numeric const ${name}`);
  return Function(`return (${m[1].replace(/_/g, '')});`)() as number;
}

/** One value of the scheduler service in docker-compose.yml. */
function scheduler(key: 'cpus' | 'mem_limit'): number {
  const block = /\n {2}scheduler:\n([\s\S]*?)(?=\n {2}[a-z-]+:\n|\n# |$)/.exec(read('docker-compose.yml'))?.[1] ?? '';
  const m = new RegExp(`\\n {4}${key}: (\\d+)`).exec(block);
  if (!m) throw new Error(`docker-compose.yml: scheduler has no ${key}`);
  return Number(m[1]);
}

/** The dates the docs values of a prefix were read or measured on. */
function docsDates(prefix: string): string[] {
  const docs = facts.docs as Record<string, { readAt?: string; measuredAt?: string }>;
  return [...new Set(Object.entries(docs).filter(([k]) => k.startsWith(prefix)).map(([, d]) => (d.readAt ?? d.measuredAt ?? '').slice(0, 10)))];
}

/** Version strings the repository names: lock files, package files, images, .node-version, font sources. */
function versionSources(): Set<string> {
  const out = new Set<string>();
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };
  for (const p of Object.values(lock.packages)) if (p.version) out.add(p.version);
  const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string>>;
  for (const deps of [pkg.dependencies, pkg.devDependencies]) for (const v of Object.values(deps ?? {})) out.add(v);
  out.add(read('.node-version').trim());
  for (const f of ['training/requirements.lock', 'training/cycle/requirements.lock']) for (const m of read(f).matchAll(/^[\w.-]+==([^\s;\\]+)/gm)) out.add(m[1]);
  for (const f of ['docker-compose.yml', 'docker/dev/Dockerfile', 'docker/audio/Dockerfile']) for (const m of read(f).matchAll(/(?:image:|FROM)\s+[\w./-]+:v?(\d+(?:\.\d+)*)/g)) out.add(m[1]);
  for (const m of read('web/src/fonts/SOURCE.md').matchAll(/^\| `[^`]+` \| (\d+\.\d+\.\d+) \|/gm)) out.add(m[1]);
  return out;
}
const VERSIONS = versionSources();
const version = (v: string): string => {
  if (!VERSIONS.has(v)) throw new Error(`no lock file or image of the repository names version ${v}`);
  return v;
};

const served = () => String(fact('ai.bootstrapModel.version'));
const nextVersion = () => {
  const bundled = read('training/cycle/config/prod.toml').match(/^bundled = \[([^\]]*)\]/m)?.[1].match(/v(\d+)/g) ?? [];
  return `v${Math.max(...bundled.map((v) => Number(v.slice(1)))) + 1}`;
};
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// -----------------------------------------------------------------------------------------------
// The allowlists of the Markdown texts

interface Allow {
  /** The number exactly as the English text writes it. */
  token: string;
  why: string;
  /** Values the number must state; each one is checked. */
  is?: () => Value | Value[];
  /** The Portuguese copy writes it the same way (versions, years), not with swapped separators. */
  asIs?: boolean;
}

const README: Allow[] = [
  { token: '1', why: 'table size: "1 against 1" (a match of two players)', is: () => makeConfig('paulista', 2).players / 2 },
  { token: '2', why: 'table size: "2 against 2" (a match of four players)', is: () => makeConfig('paulista', 4).players / 2 },
  { token: '4.0', why: 'license name: CC BY 4.0', asIs: true },
];

const DEPLOY: Allow[] = [
  { token: '0', why: 'zero as a count or share: the ledger row after a good match ("refused" 0), "0 or more", a project that uses none of a line, the other projects at 0' },
  { token: '0%', why: 'a row of the brake table of section 11: the other projects\' reserve at 0 (worker/dev/brake-table.ts)' },
  { token: '20%', why: 'a row of the brake table of section 11: the other projects\' reserve at 20%' },
  { token: '30%', why: 'a row of the brake table of section 11: the other projects\' reserve at 30%' },
  {
    token: '50%',
    why: 'the brake\'s default reserve for the other projects',
    // The code's default, not the live BRAKE_RESERVE: the owner puts the other projects' real shares there (section 11).
    is: () => [fact('docs.readme.brake.defaultReserve'), constant('worker/src/brake.ts', 'DEFAULT_RESERVE')],
  },
  { token: '0.5', why: 'the brake\'s default reserve, as BRAKE_RESERVE writes it', is: () => constant('worker/src/brake.ts', 'DEFAULT_RESERVE') },
  { token: '80%', why: 'the brake\'s headroom on each daily limit', is: () => [fact('docs.readme.brake.headroom'), constant('worker/src/brake.ts', 'HEADROOM')] },
  { token: '0.8', why: 'the brake\'s headroom, as a BRAKE_RESERVE share', is: () => constant('worker/src/brake.ts', 'HEADROOM') },
  { token: '0.15', why: 'US$ 0.15 a million Durable Object requests, repeated in the rounding note', is: () => fact('docs.deploy.cf.paid.doRequestsUsdPerMillion') },
  { token: '1', why: 'a count of one: privacy-lia.md "Open points", 1; "matches" and "settled" 1 or more; the checks of section 4 numbered from 1; the explorer limit of 1 point', is: () => Number(fact('ai.adaptation.explorer.criterion.requirement')) * 100 },
  { token: '2', why: 'the human check\'s 2 hour credential; exit code 2 of the cycle; step 2 of section 10; "option 2" in Google\'s CSP page', is: () => constant('worker/src/auth.ts', 'CRED_TTL_MS') / HOUR_MS },
  { token: '3', why: 'exit code 3 of the cycle (another command holds the lock)' },
  { token: '4', why: 'the scheduler\'s cores; a room of 4 people; privacy-lia.md "Open points", 4', is: () => [scheduler('cpus'), makeConfig('paulista', 4).players] },
  { token: '5', why: 'the manifest cache of 5 minutes; 5 Cron Triggers per account on Workers Free', is: () => [constant('shared/cycle-formats.ts', 'MANIFEST_TTL_MS') / 60_000, fact('docs.deploy.cf.free.cronTriggersPerAccount')] },
  { token: '6', why: 'the scheduler\'s memory limit in GB', is: () => scheduler('mem_limit') },
  { token: '8', why: 'days without news before the training alert says "stale"', is: () => constant('shared/cycle-formats.ts', 'STALE_STATUS_MS') / DAY_MS },
  {
    token: '10',
    why: 'RL_VERIFY\'s 10 a minute; the scheduler\'s tick of 10 minutes; the WAF rule\'s 10 second period and block (the only ones on Free); checks 1 to 10 of section 4; the download\'s batches of 10 records (web/src/my-data.ts); the US$ 10 ceiling, the committed default of BRAKE_MONTHLY_USD and a row of worker/dev/brake-table.ts',
    is: () => [rateLimit('RL_VERIFY'), Number(prod('schedule', 'tick_seconds')) / 60, fact('docs.deploy.cf.waf.free.periodSeconds'), fact('docs.deploy.cf.waf.free.mitigationSeconds'), constant('web/src/my-data.ts', 'DOWNLOAD_BATCH')],
  },
  { token: '12', why: 'the plan\'s assumption of about 12 hands per solo match, quoted next to the measured mean' },
  { token: '14', why: 'the 14 day window with people after a promotion; the 14 days of the other projects\' use read for BRAKE_RESERVE', is: () => prod('ab', 'days') },
  { token: '15', why: 'the answer to a privacy request within 15 days, as the privacy texts promise (locales/legal.*.json)' },
  { token: '16', why: 'digits of an AdSense publisher id (worker/src/ads.ts CLIENT)', is: () => Number(/ca-pub-\(\\d\{(\d+)\}\)/.exec(read('worker/src/ads.ts'))?.[1]) },
  { token: '18', why: 'the minimum age of the terms (the owner\'s decision; locales/legal.*.json)' },
  { token: '19', why: 'LGPD art. 19, a legal reference' },
  { token: '20', why: 'the US$ 20 ceiling, a row of worker/dev/brake-table.ts' },
  { token: '24', why: 'hours a room keeps its old code after a deploy (code_update_strategy.max_delay)', is: () => wrangler().durable_objects.code_update_strategy.max_delay / 3600 },
  { token: '30', why: 'days a daily receipt is kept; the 30 day month of the paid estimates (worker/src/brake.ts)', is: () => constant('shared/cycle-formats.ts', 'RECEIPT_KEEP_DAYS') },
  { token: '32', why: 'the shortest SESSION_SECRET the Worker accepts (worker/src/site-guard.ts)', is: () => Number(/SESSION_SECRET\.length < (\d+)/.exec(read('worker/src/site-guard.ts'))?.[1]) },
  { token: '36', why: 'hours before a cycle is stopped (prod.toml max_cycle_hours); also the plan\'s assumption of about 36 messages per solo match', is: () => prod('schedule', 'max_cycle_hours') },
  { token: '48', why: 'random bytes the command of section 3 draws for SESSION_SECRET', is: () => Number(/randomBytes\((\d+)\)/.exec(read('DEPLOY.md'))?.[1]) },
  { token: '50', why: 'the suggested WAF rule: 50 requests per 10 seconds; the US$ 50 ceiling, a row of worker/dev/brake-table.ts' },
  { token: '60', why: 'RL_API\'s 60 a minute; the 60 seconds a Cloudflare location may keep an /api/live answer (LIVE_MAX_AGE_S)', is: () => [rateLimit('RL_API'), constant('worker/src/public-data.ts', 'LIVE_MAX_AGE_S')] },
  { token: '95%', why: 'the one sided 95% bound of the explorer rule, a method constant' },
  { token: '100', why: 'the 100 solo matches a day row of the brake table' },
  { token: '200', why: 'HTTP status 200' },
  { token: '300', why: 'RL_DATA\'s 300 a minute', is: () => rateLimit('RL_DATA') },
  { token: '301', why: 'HTTP status 301 of the redirects' },
  { token: '308', why: 'HTTP status 308, the other permanent redirect' },
  { token: '404', why: 'HTTP status 404' },
  { token: '1,000', why: 'new matches that start a cycle early; valid human matches before open data; the 1,000 solo matches a day row', is: () => [prod('schedule', 'new_matches'), prod('thresholds', 'open_data_matches')] },
  { token: '10,000', why: 'the 10,000 solo matches a day row of the brake table' },
  { token: '2.24', why: 'the oldest Docker Compose that reads `env_file` entries with `required` (docker-compose.yml)', asIs: true },
  { token: '00:00', why: 'the paid month starts on the 1st at 00:00 UTC (worker/src/brake.ts)' },
  { token: '04:00', why: 'the daily cron (wrangler.jsonc triggers)', is: () => { const [m, h] = String(wrangler().triggers.crons[0]).split(' '); return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`; } },
  { token: '01:00', why: '04:00 UTC in Brasília (UTC minus 3 hours)' },
  { token: '06:00', why: 'the daily check of the scheduler (prod.toml ab_check_utc)', is: () => prod('schedule', 'ab_check_utc') },
  { token: '22:00', why: 'the weekly start of a cycle (prod.toml [schedule] time)', is: () => prod('schedule', 'time') },
  { token: '2026-11-23', why: 'the day the guide\'s sources were read and its numbers measured (readAt and measuredAt of docs.deploy.*)', is: () => docsDates('deploy.') },
  { token: 'v1', why: 'the bundled model behind the one in play', is: () => fact('ai.bootstrapModel.previous.version') },
  { token: 'v2', why: 'the bundled model in play', is: () => fact('ai.bootstrapModel.version') },
  { token: 'v3', why: 'the first version the cycle numbers itself, after the bundled ones of prod.toml', is: nextVersion },
  { token: 'v2.3', why: 'IAB TCF version, also in the sources table', is: () => `v${fact('docs.deploy.google.tcf.version')}` },
];

const CREDITS: Allow[] = [
  { token: '1', why: 'table size: "1 against 1"' },
  { token: '1.1', why: 'license name: SIL Open Font License 1.1' },
  { token: '2.0', why: 'license names: GPL 2.0, LGPL 2.0' },
  { token: '2.1', why: 'license name: LGPL 2.1' },
  { token: '3.0', why: 'license name: GPL 3.0' },
  { token: '4.0', why: 'license name: CC BY 4.0' },
  { token: '3.12', why: 'the Python of the training images', is: () => version('3.12') },
  { token: '3.7', why: 'the networkx version of training/requirements.lock', is: () => version('3.7') },
  { token: '2017', why: 'year of a rules source (Sindicato dos Bancários de São Paulo)' },
  { token: '2019', why: 'year of a rules source (ASFO, Unesp ICT)' },
  { token: '2022', why: 'copyright year of both fonts' },
  { token: '2024', why: 'year of a rules source (UFFS)' },
  { token: '2026', why: 'year of a cited paper (ICLR 2026)' },
  { token: '2026-11-23', why: 'the day the versions and licenses were read' },
];

const DATA_PAGE: Allow[] = [
  { token: '0', why: 'a pair scores 1, 0.5 or 0 in the duplicate format' },
  { token: '0.5', why: 'a pair scores 1, 0.5 or 0 in the duplicate format' },
  { token: '1', why: 'a pair scores 1; "1 game in every 100"; part 1, chapter 1, hand 1, round 1' },
  { token: '0.01', why: 'a difference of 0.01 in mean score is said as 1 game in 100' },
  { token: '0.1', why: 'boundValue shows a bound within 0.1 game per 100 of the limit with two decimals' },
  { token: '1.046', why: 'an example of the rounding rule (boundValue), not a measurement' },
  { token: '1,05', why: 'the same example as the page writes it in Portuguese' },
  { token: '2', why: 'step 2 of F1; hand 2 of F7; chapter 2' },
  { token: '3', why: '3 significant digits kept near zero; chapter 3' },
  { token: '4', why: 'the 4 decimals of the generated files; the 4 manilhas; bins 4 to 6 of F21; chapter 4' },
  { token: '5', why: 'the 5 decimals of facts-view.json' },
  { token: '6', why: 'hand 6 of F7; bins 4 to 6 of F21' },
  { token: '39', why: 'cards left after the vira', is: () => DECK_SIZE - 1 },
  { token: '40', why: 'cards in the deck', is: () => DECK_SIZE },
  { token: '20', why: 'the smallest group of people a published figure covers', is: () => [constant('shared/cycle-formats.ts', 'MIN_PEOPLE'), prod('thresholds', 'min_cell_people')] },
  { token: '30', why: 'polls without a pointer, key or scroll before the live strip pauses', is: () => constant('web/src/data/live-poll.ts', 'LIVE_IDLE_POLLS') },
  { token: '60', why: 'seconds /api/live is cached', is: () => constant('worker/src/public-data.ts', 'LIVE_MAX_AGE_S') },
  { token: '100', why: '"1 game in every 100" and the games per 100 axis' },
  { token: '100%', why: 'text size of the end to end test' },
  { token: '200%', why: 'text size of the end to end test' },
  { token: '200', why: 'observations under which a cell of F21 is hatched' },
  { token: '500', why: 'observations a class of F12 needs' },
  { token: '800', why: 'pixels before a chapter of the data page loads' },
  { token: '50%', why: 'the even line of F13' },
  { token: '80%', why: 'the level of the intervals of a person\'s reading' },
  { token: '95%', why: 'the level of the intervals of the data page' },
  { token: '4,000', why: 'duplicate pairs per rival in the strength table of the version in play', is: () => fact(`ai.strengthByVersion.${served()}.table.zap-random.overall.pairs`) },
  { token: 'v1', why: 'the first version, in the lineage of F3 and in F16', is: () => fact('ai.bootstrapModel.previous.version') },
  { token: 'v2', why: 'the version in play, in the lineage of F3', is: () => fact('ai.bootstrapModel.version') },
];

/** The Portuguese copy of a text holds the same numbers with swapped separators. */
function inPortuguese(list: readonly Allow[]): Allow[] {
  return list.map((a) => (a.asIs || !/^\d/.test(a.token) || /^\d{4}-|:/.test(a.token) ? a : { ...a, token: a.token.replace(/[.,]/g, (c) => (c === ',' ? '.' : ',')) }));
}

interface Text {
  path: string;
  lang: Lang;
  allow: Allow[];
  /** Not part of the repository: checked when present. */
  optional?: boolean;
}

const TEXTS: Text[] = [
  { path: 'README.md', lang: 'en', allow: README },
  { path: 'README.pt-BR.md', lang: 'pt', allow: inPortuguese(README) },
  { path: 'DEPLOY.md', lang: 'en', allow: DEPLOY },
  { path: 'CREDITS.md', lang: 'en', allow: CREDITS },
  { path: 'project_docs/data-page.md', lang: 'en', allow: DATA_PAGE },
  { path: '_local/DEPLOY.pt-BR.md', lang: 'pt', allow: inPortuguese(DEPLOY), optional: true },
];
const present = TEXTS.filter((t) => !t.optional || existsSync(join(ROOT, t.path)));
const textOf = (path: string): Text => TEXTS.find((t) => t.path === path)!;

function check(text: string, t: Text) {
  return checkText(text, { lang: t.lang, facts, index, allowed: new Set(t.allow.map((a) => a.token)), versions: VERSIONS });
}

const report = (path: string, findings: { line: number; token: string; problem: string }[]) => findings.map((f) => `${path}:${f.line} ${f.token}: ${f.problem}`);

/** The problems of the `is` values of one entry. */
function checkIs(a: Allow, lang: Lang): string[] {
  if (!a.is) return [];
  const values = [a.is()].flat();
  const t = tokenOf(a.token, lang);
  const ok = (v: Value) => String(v) === a.token || (t.kind === 'number' && typeof v === 'number' && statesNumber(t, v));
  return values.filter((v) => !ok(v)).map((v) => `${a.token} is allowed as "${a.why}", but its source now says ${v}`);
}

// -----------------------------------------------------------------------------------------------

describe('numbers in the texts', () => {
  it('(a) both READMEs are in step with facts.json (tools/docs/readme-facts.ts --check)', () => {
    expect(runReadmes().problems).toEqual([]);
  });

  for (const t of present) {
    it(`(b) ${t.path}: every number is in facts.json, named by a comment, or allowed with a reason`, () => {
      const r = check(read(t.path), t);
      expect(report(t.path, r.findings)).toEqual([]);
      const unused = t.allow.filter((a) => !r.usedAllowed.has(a.token)).map((a) => `${a.token} (${a.why})`);
      expect(unused, 'allowlist entries the text no longer needs').toEqual([]);
      expect(t.allow.flatMap((a) => checkIs(a, t.lang))).toEqual([]);
      expect(new Set(t.allow.map((a) => a.token)).size, 'one entry per number').toBe(t.allow.length);
    });
  }

  it('the Portuguese texts hold the same numbers as the English ones', () => {
    const pairs: [string, string][] = [['README.md', 'README.pt-BR.md']];
    if (existsSync(join(ROOT, '_local/DEPLOY.pt-BR.md'))) pairs.push(['DEPLOY.md', '_local/DEPLOY.pt-BR.md']);
    for (const [en, pt] of pairs) {
      const values = (path: string) =>
        check(read(path), textOf(path))
          .tokens.filter((x) => x.kind === 'number' && !(x.decimals === 0 && x.value !== undefined && x.value <= 12))
          .map((x) => `${x.value}${x.percent ? '%' : ''}`)
          .sort();
      expect(values(pt), `${pt} against ${en}`).toEqual(values(en));
    }
  });

  it('(c) a planted wrong number in a copy of a README fails', () => {
    const dir = join(ROOT, '.cache', 'tmp', 'facts-in-texts');
    rmSync(dir, { recursive: true, force: true });
    for (const f of ['README.md', 'README.pt-BR.md', 'training/cycle/config/prod.toml', 'worker/src/brake.ts']) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), read(f));
    }
    const readme = textOf('README.md');
    const original = read('README.md');

    // In prose: a number no fact states, and a small integer nothing names.
    const wrong = '4,321,987';
    expect(index.has(tokenOf(wrong, 'en'))).toBe(false);
    const planted = original.replace('## How Zap learns\n\n', `## How Zap learns\n\nIt played ${wrong} matches against itself in 7 weeks.\n\n`);
    expect(planted).not.toBe(original);
    const found = check(planted, readme).findings.map((f) => f.token);
    expect(found).toContain(wrong);
    expect(found).toContain('7');

    // A measured value with a wrong last digit is wrong too (the nearest value no fact states).
    const lcp = Number(fact('client.performance.lcp.medianMs'));
    let near = lcp + 1;
    while (index.has(tokenOf(near.toLocaleString('en-US'), 'en'))) near++;
    const nearText = `## How Zap learns\n\nThe page loads in ${near.toLocaleString('en-US')} ms.\n\n`;
    expect(check(original.replace('## How Zap learns\n\n', nearText), readme).findings.map((f) => f.token)).toContain(near.toLocaleString('en-US'));

    // In a block written by readme-facts: the copy no longer renders from facts.json.
    const values = readmeValues(facts, docsValues(facts).docs);
    const shown = Number(values['client.lcp']).toLocaleString('en-US');
    const inBlock = original.replace(`(LCP) ${shown} ms`, `(LCP) ${(Number(values['client.lcp']) - 100).toLocaleString('en-US')} ms`);
    expect(inBlock).not.toBe(original);
    writeFileSync(join(dir, 'README.md'), inBlock);
    expect(runReadmes({ root: dir }).problems.join('\n')).toContain('README.md: block "snapshot" differs from facts.json');

    // A number with a facts comment that names another value.
    const deploy = read('DEPLOY.md');
    const bytes = Number(fact('docs.deploy.bundle.workerBytes')).toLocaleString('en-US');
    const changed = deploy.replace(`${bytes} bytes`, `${(Number(fact('docs.deploy.bundle.workerBytes')) + 63).toLocaleString('en-US')} bytes`);
    expect(changed).not.toBe(deploy);
    const problems = check(changed, textOf('DEPLOY.md')).findings.map((f) => f.problem).join('\n');
    expect(problems).toContain('no number before the comment states docs.deploy.bundle.workerBytes');
    rmSync(dir, { recursive: true, force: true });
  });
});

// -----------------------------------------------------------------------------------------------
// Links

describe('links and anchors', () => {
  const docs = ['README.md', 'README.pt-BR.md', 'DEPLOY.md', 'CREDITS.md', ...(existsSync(join(ROOT, '_local/DEPLOY.pt-BR.md')) ? ['_local/DEPLOY.pt-BR.md'] : [])];
  for (const doc of docs) {
    it(`${doc}: every relative link and anchor resolves`, () => {
      const text = read(doc);
      const bad: string[] = [];
      for (const l of linksOf(text)) {
        if (/^(https?:|mailto:)/.test(l.target)) continue;
        const [path, anchor] = l.target.split('#');
        const file = path ? join(dirname(join(ROOT, doc)), decodeURIComponent(path)) : join(ROOT, doc);
        if (!existsSync(file)) {
          bad.push(`${doc}:${l.line} ${l.target}: no such file`);
          continue;
        }
        if (anchor !== undefined && !anchorsOf(readFileSync(file, 'utf8')).has(decodeURIComponent(anchor))) bad.push(`${doc}:${l.line} ${l.target}: no such anchor`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('the README GIFs are linked from both READMEs and exist', () => {
    for (const [doc, gif] of [['README.md', 'project_docs/media/zap-en.gif'], ['README.pt-BR.md', 'project_docs/media/zap-pt.gif']]) {
      expect(linksOf(read(doc)).some((l) => l.target === gif)).toBe(true);
      expect(readFileSync(join(ROOT, gif)).subarray(0, 6).toString('latin1')).toMatch(/^GIF8[79]a$/);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// Locale files: no digit in a string outside this allowlist

interface LocaleAllow {
  keys: string[];
  /** The numbers the strings may hold, without grouping ("1000"). */
  numbers: string[];
  why: string;
  /** Values that must be among `numbers`. */
  is?: () => Value | Value[];
  /** Only these languages hold the numbers (a translation that says it in words). */
  langs?: Lang[];
}

const ranks = ['rank.0', 'rank.1', 'rank.2', 'rank.3', 'rank.8', 'rank.9'];
const LOCALES: LocaleAllow[] = [
  {
    keys: ['board.first.tentos', 'board.score.goal', 'glossary.queda.def', 'glossary.tento.def', 'guide.handLost', 'guide.handTie', 'guide.handWon', 'rulebook.lead', 'rulebook.t.s3p'],
    numbers: ['12'],
    why: 'the points of a game',
    is: () => TARGET_POINTS,
  },
  { keys: ['rulebook.match.p'], numbers: ['12', '0'], why: 'a game to 12, and the score back to 0 after each queda', is: () => TARGET_POINTS },
  { keys: ['glossary.onze.def'], numbers: ['11', '3'], why: 'the mão de onze: its score and the hand value', is: () => [onzeThreshold(makeConfig('paulista', 4)), onzeValue(makeConfig('paulista', 4))] },
  { keys: ['glossary.dez.def'], numbers: ['10', '4'], why: 'the mão de dez: its score and the hand value', is: () => [onzeThreshold(makeConfig('mineiro', 4)), onzeValue(makeConfig('mineiro', 4))] },
  { keys: ['house.ladder8', 'rulebook.house.ladder8', 'rulebook.t.ladder8'], numbers: ['2', '4', '8', '10', '12'], why: 'the mineiro ladder with eight', is: () => [...ladderOf(makeConfig('mineiro', 4, { ladder: 'mineiro8' }))] },
  { keys: ['glossary.sinal.def', 'house.signals.p25', 'rulebook.house.signals', 'rulebook.signals.p'], numbers: ['25'], why: 'the chance that an opponent catches a signal (option p25)' },
  {
    keys: ['mode.2', 'mode.4', 'play.mode.dupla', 'play.mode.solo', 'play.sum.dupla', 'play.sum.solo', 'legal.you.matches.kind.solo1', 'legal.you.matches.kind.solo2', 'shell.meta.play.description', 'rulebook.signals.h', 'rulebook.onze.p'],
    numbers: ['1', '2'],
    why: 'table sizes: 1 against 1 and 2 against 2',
  },
  {
    keys: [...ranks, ...ranks.map((k) => k.replace('rank.', 'rank.the.')), ...ranks.map((k) => `rulebook.${k.replace('rank.', 'rank.from.')}`), ...ranks.map((k) => `rulebook.${k.replace('rank.', 'rank.the.')}`)],
    numbers: ['2', '3', '4', '5', '6', '7'],
    why: 'the card ranks with digits',
    is: () => RANKS.filter((r) => /\d/.test(r)),
  },
  { keys: ['rulebook.order.p'], numbers: ['8', '9', '10'], why: 'the ranks the deck leaves out', is: () => ['8', '9', '10'].filter((r) => !(RANKS as readonly string[]).includes(r)) },
  { keys: ['rulebook.m.wrap'], numbers: ['3'], why: 'the 3, after which the manilha order wraps' },
  { keys: ['rulebook.rounds.col.1', 'rulebook.rounds.col.2', 'rulebook.rounds.col.3'], numbers: ['1', '2', '3'], why: 'the three rounds of a hand' },
  { keys: ['rulebook.dialog.keys', 'shell.keys.hint'], numbers: ['1', '2', '3'], why: 'keyboard keys that play the cards' },
  { keys: ['rulebook.time.p', 'rulebook.time.ring'], numbers: ['30'], why: 'seconds per move of quick play' },
  { keys: ['rulebook.time.rooms', 'rulebook.house.time'], numbers: ['15', '30', '60'], why: 'the time options of a room (shared/match-record.ts)' },
  {
    keys: ['legal.age.note', 'legal.age.under.text', 'legal.age.under.title', 'legal.notice.age.text', 'legal.privacy.browser.li2', 'legal.privacy.collected.li2', 'legal.privacy.minors.p1', 'legal.privacy.minors.p2', 'legal.privacy.minors.title', 'legal.terms.age.p1', 'legal.you.stored.adult'],
    numbers: ['18'],
    why: 'the minimum age of the terms',
  },
  { keys: ['legal.notice.rights.text', 'legal.privacy.rights.p1'], numbers: ['18'], why: 'LGPD art. 18, a legal reference' },
  { keys: ['legal.notice.why.text', 'legal.privacy.purposes.li1'], numbers: ['7'], why: 'LGPD art. 7, a legal reference' },
  { keys: ['legal.notice.contact.ifContact', 'legal.privacy.rights.ifContact'], numbers: ['15'], why: 'days to answer a privacy request' },
  { keys: ['legal.privacy.collected.li9', 'legal.terms.consequences.p1', 'problem.blocked.text'], numbers: ['15'], why: 'minutes a browser is paused for too many messages', is: () => constant('worker/src/cf/room.ts', 'BLOCK_MS') / 60_000 },
  { keys: ['legal.verify.limits.li1'], numbers: ['4', '15'], why: 'messages a second a connection may send, and the pause after', is: () => [constant('worker/src/cf/room.ts', 'REFILL_PER_S'), constant('worker/src/cf/room.ts', 'BLOCK_MS') / 60_000] },
  { keys: ['legal.notice.keep.text', 'legal.privacy.retention.li1', 'legal.privacy.retention.li5', 'legal.privacy.retention.li6'], numbers: ['12'], why: 'months of retention', is: () => (constant('worker/src/privacy.ts', 'RETENTION_MS') / DAY_MS / 365) * 12 },
  { keys: ['legal.privacy.retention.li7', 'legal.terms.service.p1', 'problem.expired.text', 'problem.not_found.text'], numbers: ['24'], why: 'hours an unused room lives', is: () => constant('worker/src/room-core.ts', 'ROOM_TTL_MS') / HOUR_MS },
  { keys: ['legal.privacy.retention.li9', 'legal.you.delete.more'], numbers: ['30'], why: 'days of D1 Time Travel on Workers Paid, the longest a backup lives', is: () => fact('docs.deploy.cf.d1.timeTravelDaysPaid') },
  {
    keys: ['legal.privacy.retention.li4'],
    numbers: ['30', '7', '400'],
    why: 'days the export codes, the exports and the training server\'s flag list are kept',
    is: () => [constant('worker/src/privacy.ts', 'EXPORT_GROUP_DAYS'), constant('worker/src/privacy.ts', 'FLAG_REF_DAYS'), constant('shared/cycle-formats.ts', 'EXPORT_KEEP_DAYS'), constant('shared/cycle-formats.ts', 'FLAG_OP_MAX_AGE_MS') / DAY_MS],
  },
  { keys: ['legal.privacy.purposes.li4'], numbers: ['20'], why: 'the smallest group a figure of the window with people covers', is: () => [constant('shared/cycle-formats.ts', 'MIN_PEOPLE'), prod('thresholds', 'min_cell_people')] },
  {
    keys: ['legal.privacy.sharing.p2'],
    numbers: ['1000', '4.0', '20', '50'],
    why: 'open data: matches before the first release, the CC BY 4.0 license, people per cell, matches per person for style figures',
    is: () => [prod('thresholds', 'open_data_matches'), prod('thresholds', 'min_cell_people'), prod('thresholds', 'open_data_style_matches')],
  },
  { keys: ['legal.notice.share.text'], numbers: ['1000'], why: 'matches with people before open data', is: () => prod('thresholds', 'open_data_matches') },
  { keys: ['legal.terms.service.p2'], numbers: ['4.0'], why: 'license name: CC BY 4.0' },
  { keys: ['legal.privacy.updated', 'legal.terms.updated'], numbers: ['21', '25', '2026'], why: 'the date of each text\'s version' },
  { keys: ['legal.terms.report.p2'], numbers: ['3'], why: 'an example seat number ("Player 3")' },
  { keys: ['legal.privacy.browser.p1', 'check.text'], numbers: ['2'], why: 'hours of the human check\'s pass', is: () => constant('worker/src/auth.ts', 'CRED_TTL_MS') / HOUR_MS },
  { keys: ['legal.verify.check.p3', 'legal.verify.seal.p1'], numbers: ['2', '10'], why: 'the pass lasts 2 hours or 10 matches (worker/src/allowance.ts)', is: () => constant('worker/src/auth.ts', 'CRED_TTL_MS') / HOUR_MS },
  { keys: ['legal.verify.check.p2'], numbers: ['5'], why: 'minutes a Turnstile result is valid, as Cloudflare documents it' },
  { keys: ['legal.verify.limits.li2'], numbers: ['5'], why: 'seconds between two canned phrases', is: () => constant('worker/src/room-core.ts', 'PHRASE_INTERVAL_MS') / 1000 },
  { keys: ['legal.verify.limits.li3', 'error.too_many_rooms'], numbers: ['3'], why: 'rooms one browser may have open', is: () => constant('worker/src/room-create.ts', 'MAX_OPEN_ROOMS') },
  { keys: ['legal.verify.signs.p1'], numbers: ['24'], why: 'Portuguese says "nas 24 horas do dia" where English says "around the clock"', langs: ['pt'] },
  { keys: ['legal.verify.signs.p2'], numbers: ['90'], why: 'days before the same sign can mark a browser again after a review' },
  { keys: ['legal.verify.training.p1'], numbers: ['2'], why: 'the largest share of the training data one browser may weigh, in percent', is: () => Math.round(Number(prod('data', 'device_cap')) * 100) },
  { keys: ['legal.you.nickname.help'], numbers: ['2', '20'], why: 'the length of a nickname', is: () => [constant('worker/src/nickname.ts', 'NICKNAME_MIN'), constant('worker/src/nickname.ts', 'NICKNAME_MAX')] },
  { keys: ['legal.you.recover.hint'], numbers: ['20', '5'], why: 'the recovery code: 20 characters in groups of 5', is: () => constant('worker/src/privacy.ts', 'RECOVERY_LENGTH') },
  { keys: ['error.bad_code', 'play.room.err.short'], numbers: ['5'], why: 'characters of a room code', is: () => constant('shared/protocol.ts', 'CODE_LENGTH') },
  { keys: ['play.room.err.short1'], numbers: ['5', '1'], why: 'characters of a room code, and one left to type', is: () => constant('shared/protocol.ts', 'CODE_LENGTH') },
  { keys: ['play.room.code.hint'], numbers: ['5', '0', '1'], why: 'characters of a room code, and the characters it never uses (0 and 1)', is: () => constant('shared/protocol.ts', 'CODE_LENGTH') },
  { keys: ['play.room.err.chars'], numbers: ['0', '1'], why: 'characters a room code never uses' },
  { keys: ['alert.training.stale'], numbers: ['8'], why: 'days without news before the training alert', is: () => constant('shared/cycle-formats.ts', 'STALE_STATUS_MS') / DAY_MS },
  {
    keys: ['reading.rule'],
    numbers: ['10', '80', '30', '1', '2'],
    why: 'a reading shows from 10 observations with an 80% range narrower than 30 points; table sizes 1 against 1 and 2 against 2',
    is: () => [constant('shared/profile.ts', 'MIN_SHOWN_N'), Math.round(constant('shared/profile.ts', 'SHOW_WIDTH') * 100)],
  },
  { keys: ['reading.scale'], numbers: ['100'], why: 'the reading\'s scale, out of 100' },
  { keys: ['reading.n.shown.help'], numbers: ['0', '100'], why: 'the ends of the reading\'s scale' },
  { keys: ['data.term.ic.name'], numbers: ['95'], why: 'the level of the intervals of the data page' },
  { keys: ['data.term.ic.def'], numbers: ['100', '95'], why: 'what a 95% interval means: about 95 of 100 repeats' },
  { keys: ['data.term.ic80.name'], numbers: ['80'], why: 'the level of a person\'s reading' },
  { keys: ['data.term.ic80.def', 'data.u.likely80'], numbers: ['8', '10'], why: 'an 80% range said as 8 times out of 10' },
  { keys: ['rulebook.src.asfo'], numbers: ['2019'], why: 'year of a rules source' },
  { keys: ['rulebook.src.banc'], numbers: ['2017'], why: 'year of a rules source' },
  { keys: ['rulebook.src.uffs'], numbers: ['2024'], why: 'year of a rules source' },
];

/** Every string of the locale files, by language and key. */
function localeTable(): Map<string, Partial<Record<Lang, string>>> {
  const table = new Map<string, Partial<Record<Lang, string>>>();
  for (const name of readdirSync(join(ROOT, 'locales')).filter((n) => n.endsWith('.json')).sort()) {
    const lang: Lang = /(^|\.)en\.json$/.test(name) ? 'en' : 'pt';
    for (const [key, s] of localeStrings(JSON.parse(read(`locales/${name}`)))) {
      const row = table.get(key) ?? {};
      if (row[lang] !== undefined) throw new Error(`locales: key ${key} appears twice in ${lang}`);
      row[lang] = s;
      table.set(key, row);
    }
  }
  return table;
}

/** The problems of the locale strings against an allowlist. */
function localeProblems(table: Map<string, Partial<Record<Lang, string>>>, allow: readonly LocaleAllow[]): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, LocaleAllow>();
  for (const a of allow) {
    for (const k of a.keys) {
      if (byKey.has(k)) problems.push(`${k} is in two allowlist entries`);
      byKey.set(k, a);
    }
  }
  const seen = new Map<LocaleAllow, Set<string>>(allow.map((a) => [a, new Set()]));
  for (const [key, row] of table) {
    const a = byKey.get(key);
    const found: Partial<Record<Lang, string[]>> = {};
    for (const lang of ['en', 'pt'] as const) {
      const s = row[lang];
      if (s === undefined) continue;
      const nums = localeNumbers(s, lang);
      found[lang] = nums;
      if (!nums.length) continue;
      if (!a) {
        problems.push(`${lang} ${key}: digits ${nums.join(', ')} in "${s}" (numbers come from the data; a fixed one needs an entry in this allowlist)`);
        continue;
      }
      if (a.langs && !a.langs.includes(lang)) problems.push(`${lang} ${key}: digits ${nums.join(', ')}, but the entry allows them only in ${a.langs.join(', ')}`);
      for (const n of nums) {
        if (!a.numbers.includes(n)) problems.push(`${lang} ${key}: ${n} is not among the allowed ${a.numbers.join(', ')} (${a.why})`);
        seen.get(a)!.add(n);
      }
    }
    if (a && !a.langs && found.en && found.pt && [...found.en].sort().join() !== [...found.pt].sort().join()) {
      problems.push(`${key}: English holds ${found.en.join(', ') || 'no number'} and Portuguese ${found.pt.join(', ') || 'no number'}`);
    }
  }
  for (const a of allow) {
    for (const k of a.keys) if (!table.has(k)) problems.push(`allowlist key ${k} is in no locale file`);
    for (const n of a.numbers) if (!seen.get(a)!.has(n)) problems.push(`allowlist entry "${a.why}" allows ${n}, which none of its strings holds`);
    if (a.is) for (const v of [a.is()].flat()) if (!a.numbers.includes(String(v))) problems.push(`allowlist entry "${a.why}": its source now says ${v}`);
  }
  return problems;
}

describe('locale files', () => {
  it('hold no digit outside the allowlist, and the same numbers in both languages', () => {
    expect(localeProblems(localeTable(), LOCALES)).toEqual([]);
  });

  it('a planted digit in a copy fails', () => {
    const table = localeTable();
    const copy = new Map(table);
    copy.set('mode.2', { ...table.get('mode.2'), en: '1 against 1, 3 rounds' });
    expect(localeProblems(copy, LOCALES).join('\n')).toContain('en mode.2: 3 is not among the allowed');
    copy.set('play.start', { en: 'Play 7 hands', pt: 'Jogue 7 mãos' });
    expect(localeProblems(copy, LOCALES).join('\n')).toContain('en play.start: digits 7');
  });
});
