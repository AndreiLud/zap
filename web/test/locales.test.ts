// The locale files must stay in step: same keys, same {placeholders}, and the project's writing
// rules. Besides the shared files (pt-BR.json, en.json) each area of the client has its own pair,
// <area>.pt-BR.json and <area>.en.json, with keys prefixed "<area>." (CLIENT-SPEC 22.1); the legal
// texts (legal.*) are one such area, loaded on demand, and keep the same key order in both
// languages (the legal pages render in file order). All of them are merged into one dictionary per
// language, so they follow the same checks. Keys written literally in the client must exist.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIGNALS } from '../../engine/src/engine.ts';
import { PHRASES } from '../../shared/protocol.ts';

const root = join(import.meta.dirname, '..', '..');
const dir = join(root, 'locales');
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
const mainPt = load('pt-BR.json');
const mainEn = load('en.json');
const legalPt = load('legal.pt-BR.json');
const legalEn = load('legal.en.json');

/** Area files: <area>.pt-BR.json and <area>.en.json, legal included. */
const AREAS = [...new Set(readdirSync(dir).flatMap((n) => /^([a-z]+)\.(pt-BR|en)\.json$/.exec(n)?.[1] ?? []))].sort();
const areaFiles = AREAS.map((area) => ({ area, pt: `${area}.pt-BR.json`, en: `${area}.en.json` }));
const pt: Record<string, unknown> = { ...mainPt };
const en: Record<string, unknown> = { ...mainEn };
for (const a of areaFiles) {
  Object.assign(pt, load(a.pt));
  Object.assign(en, load(a.en));
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const BANNED: Record<string, RegExp> = {
  pt: /\b(vale ressaltar|é importante destacar|em suma|mergulhe|desvende|jornada|crucial|robusto)\b/i,
  en: /\b(delve|tapestry|showcase|passionate|leverage|seamless|elevate|journey|crucial|robust|cutting-edge)\b/i,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('locales', () => {
  it('every key exists in both languages', () => {
    const onlyPt = Object.keys(pt).filter((k) => !(k in en));
    const onlyEn = Object.keys(en).filter((k) => !(k in pt));
    expect(onlyPt, 'keys only in pt-BR.json').toEqual([]);
    expect(onlyEn, 'keys only in en.json').toEqual([]);
  });

  it('every value is a non-empty string', () => {
    for (const [name, dict] of [['pt-BR', pt], ['en', en]] as const) {
      for (const [k, v] of Object.entries(dict)) {
        expect(typeof v === 'string' && v.trim().length > 0, `${name}: ${k}`).toBe(true);
      }
    }
  });

  it('placeholders match between languages', () => {
    const diff: string[] = [];
    for (const k of Object.keys(pt)) {
      if (!(k in en)) continue;
      const a = placeholders(String(pt[k]));
      const b = placeholders(String(en[k]));
      if (a.join(',') !== b.join(',')) diff.push(`${k}: pt {${a.join(', ')}} en {${b.join(', ')}}`);
    }
    expect(diff).toEqual([]);
  });

  it('follows the writing rules: no long dashes, no hyphen as a pause, no banned words', () => {
    const bad: string[] = [];
    for (const [lang, dict] of [['pt', pt], ['en', en]] as const) {
      for (const [k, v] of Object.entries(dict)) {
        const s = String(v);
        if (/[\u2013\u2014]/.test(s)) bad.push(`${lang} ${k}: long dash`);
        if (/\s-\s/.test(s)) bad.push(`${lang} ${k}: hyphen used as a pause`);
        if (BANNED[lang].test(s)) bad.push(`${lang} ${k}: banned word`);
        if (/\p{Extended_Pictographic}/u.test(s)) bad.push(`${lang} ${k}: emoji`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('data strings hold no digits: numbers come from the data (DATA-SPEC 0 and 9.3)', () => {
    // The few fixed numbers that are part of a definition, not a measurement.
    const allowed = /^data\.(u\.likely80|term\.ic\.|term\.ic80\.)/;
    const bad: string[] = [];
    for (const [lang, dict] of [['pt', pt], ['en', en]] as const) {
      for (const [k, v] of Object.entries(dict)) {
        if (!k.startsWith('data.') || allowed.test(k)) continue;
        if (/\d/.test(String(v).replace(/\{[^}]*\}/g, ''))) bad.push(`${lang} ${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the legal texts keep their own namespace and the same order in both languages', () => {
    const outside = [...Object.keys(legalPt), ...Object.keys(legalEn)].filter((k) => !k.startsWith('legal.'));
    expect(outside, 'legal keys outside legal.*').toEqual([]);
    const clash = [...Object.keys(mainPt), ...Object.keys(mainEn)].filter((k) => k in legalPt || k in legalEn || k.startsWith('legal.'));
    expect(clash, 'main keys that collide with the legal files').toEqual([]);
    expect(Object.keys(legalEn), 'same key order').toEqual(Object.keys(legalPt));
  });

  it('the legal pages use only the item kinds the client renders', () => {
    const bad: string[] = [];
    for (const page of ['privacy', 'terms', 'verify', 'you']) {
      for (const item of ['metaTitle', 'description', 'title', 'lede']) {
        if (!(`legal.${page}.${item}` in legalPt)) bad.push(`missing legal.${page}.${item}`);
      }
    }
    for (const k of Object.keys(legalPt)) {
      const parts = k.split('.');
      if (!['privacy', 'terms', 'verify'].includes(parts[1])) continue;
      if (parts.length === 3 && !['metaTitle', 'description', 'title', 'updated', 'lede'].includes(parts[2])) bad.push(`${k}: unknown page item`);
      if (parts.length === 4 && !/^(title|p\d+|li\d+|ifContact|ifNoContact|go(You|Privacy|Terms|Verify|Lia|Cloudflare))$/.test(parts[3])) bad.push(`${k}: unknown section item`);
      if (parts.length < 3 || parts.length > 4) bad.push(`${k}: unexpected shape`);
    }
    expect(bad).toEqual([]);
  });

  it('every area file has its pair, its own prefix, and no key in two files', () => {
    expect(AREAS).toEqual(expect.arrayContaining(['ads', 'board', 'data', 'glossary', 'guide', 'legal', 'play', 'rulebook', 'shell', 'start', 'truco']));
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const name of ['pt-BR.json', 'en.json']) for (const k of Object.keys(load(name))) seen.set(`${name.startsWith('pt') ? 'pt' : 'en'}:${k}`, name);
    for (const a of areaFiles) {
      for (const [lang, file] of [['pt', a.pt], ['en', a.en]] as const) {
        let dict: Record<string, unknown>;
        try {
          dict = load(file);
        } catch {
          problems.push(`missing ${file}`);
          continue;
        }
        for (const k of Object.keys(dict)) {
          if (!k.startsWith(`${a.area}.`)) problems.push(`${file}: ${k} does not start with "${a.area}."`);
          const other = seen.get(`${lang}:${k}`);
          if (other) problems.push(`${k} is in ${other} and ${file}`);
          seen.set(`${lang}:${k}`, file);
        }
      }
    }
    // The shared files never take a key of an area.
    for (const k of [...Object.keys(mainPt), ...Object.keys(mainEn)]) {
      const area = AREAS.find((a) => k.startsWith(`${a}.`));
      if (area) problems.push(`shared file key ${k} belongs to the area ${area}`);
    }
    expect(problems).toEqual([]);
  });

  it('keys written literally in the client exist', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(root, 'web', 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([^'$]+)'/g)) {
        if (!(m[1] in pt)) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every key is used by the code (no dead keys)', () => {
    // Where the keys are read: the client, its build scripts and OG pages, and the Worker (alerts).
    const roots = ['web/src', 'web/og', 'web/scripts', 'worker/src'].map((d) => join(root, d));
    const files = roots.flatMap((d) => sourceFiles(d).concat(readdirSync(d).filter((n) => n.endsWith('.mjs')).map((n) => join(d, n))));
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    // Keys named in full anywhere in the code (t('...'), key maps, typed constants).
    const literal = new Set([...src.matchAll(/['"]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"]/g)].map((m) => m[1]));
    // Keys built from a template with a fixed start (`play.mode.${m}`): each part in ${} stands for any text.
    const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const templates = [...src.matchAll(/`([^`]*\$\{[^`]*)`/g)]
      .map((m) => m[1])
      .filter((x) => /^[a-zA-Z][\w-]*\./.test(x))
      .map((x) => new RegExp(`^${x.split(/\$\{[^}]*\}/).map(escape).join('.+?')}$`));
    // Keys built in ways the two rules above cannot see, enumerated here with where they are built.
    const BUILT: RegExp[] = [
      /^(call|callw)\.(truco|\d+)$/, // game-text.ts callName: `${button ? 'call' : 'callw'}.${k}`
      /^legal\.(privacy|terms|verify)\./, // pages/Legal.tsx renders each page's sections in file order (legalKeys)
      /^points\.(one|other)$/, // i18n.ts tn('points', n)
      /^shell\.og\.alt\.\w+$/, // web/scripts/head.ts, inside a nested template
    ];
    // Suffixes that helpers append to a literal base: who() .you/.other and team() .us/.them in
    // game-text.ts, tn() .one/.other in i18n.ts.
    const SUFFIXES = ['you', 'other', 'us', 'them', 'one'];
    // Keys built from a list of ids take only the ids of that list (or a key named in full):
    // game-text.ts signalName `${'signal' | 'signalw'}.${SIGNALS[i]}`, Rules.tsx `signal.${x}` and
    // game-text.ts phraseText `phrase.${key}` for the ids of shared/protocol.ts PHRASES.
    const DOMAINS: [RegExp, readonly string[]][] = [
      [/^(?:signal|signalw)\.(\w+)$/, SIGNALS],
      [/^phrase\.(\w+)$/, PHRASES],
    ];
    const used = (k: string) => {
      for (const [r, ids] of DOMAINS) {
        const m = r.exec(k);
        if (m) return literal.has(k) || ids.includes(m[1]);
      }
      if (literal.has(k) || templates.some((r) => r.test(k)) || BUILT.some((r) => r.test(k))) return true;
      const dot = k.lastIndexOf('.');
      return SUFFIXES.includes(k.slice(dot + 1)) && literal.has(k.slice(0, dot));
    };
    const unused = Object.keys(pt).filter((k) => !used(k));
    expect(unused, 'keys no code uses').toEqual([]);
  });
});
