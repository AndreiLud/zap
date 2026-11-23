// Reads the numbers, links and anchors of the project's Markdown texts, and the digits of the site's
// locale files. Used by tests/docs/facts-in-texts.test.ts, which holds the allowlists; this file
// holds the rules only.
//
// Prose is everything but fenced code (Mermaid included), inline code, HTML comments and tags, link
// targets, URLs and host names, the README blocks that tools/docs/readme-facts.ts writes (that tool
// checks them), heading numbers ("## 7. Training server", "### 7.1 ..."), list numbers, and references
// to numbered sections ("section 1.6", "sections 5.5 and 6"), which must match a heading of the file.
//
// A number in prose passes when:
//   * an HTML comment after it, in the same paragraph, list item or table cell and before any other
//     comment, names a fact it states at the precision shown. The comment reads
//     "<!-- facts: worker.brake.estimate.room4WeighsSolo -->" or "<!-- facts.docs: deploy.cf.workerSizeMiB -->",
//     with keys separated by commas and both kinds by ";". Every key a comment names must exist, and
//     a key that holds a number must be stated by a number (or a number word) before the comment;
//   * or it has at least MIN_DIGITS_UNNAMED significant digits and some number of facts.json (docs
//     values included) states it at the precision shown;
//   * or it is a version that the repository's lock files and images name (versions given by the
//     caller), for tokens like 5.3.0;
//   * or the caller's allowlist holds it for that file.
// So an integer from 0 to 12 never matches facts.json by chance: it needs a comment or the allowlist.
// "States at the precision shown": the fact rounded to as many decimals as the text shows gives the
// same digits. A percent also reads a share (0.026 is 2.6%), and so do "points"; "million" and
// "billion" scale; KB and MB read bytes.

export type Lang = 'en' | 'pt';

export interface Annotation {
  /** Offset of the comment in the text. */
  at: number;
  /** Fact paths as written: "docs.<key>" for facts.docs keys. */
  keys: string[];
}

export interface Masked {
  /** The text with every non-prose character replaced by a space (line breaks kept). */
  prose: string;
  annotations: Annotation[];
  /** Section numbers of the headings ("7", "7.1"). */
  sections: Set<string>;
  /** Section references found in prose, with their offsets. */
  sectionRefs: { ref: string; at: number }[];
}

export type TokenKind = 'number' | 'version' | 'date' | 'time' | 'raw';

export interface Token {
  /** The token as written ("1,153", "2.6%", "v2", "2026-11-23", "5.3.0"). */
  text: string;
  kind: TokenKind;
  at: number;
  /** For numbers: the value read in the file's language, the decimals shown, and the flags. */
  value?: number;
  decimals?: number;
  percent?: boolean;
  /** A word after the number that scales it or reads it as a share. */
  unit?: 'million' | 'billion' | 'thousand' | 'points' | 'KB' | 'MB';
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** Replaces each match of `re` in `text` by spaces, calling `seen` with the match and its offset first. */
function blankAll(text: string, re: RegExp, seen?: (groups: string[], at: number) => void): string {
  return text.replace(re, (...args: unknown[]) => {
    const offset = args.findIndex((a) => typeof a === 'number');
    seen?.(args.slice(0, offset) as string[], args[offset] as number);
    return blank(args[0] as string);
  });
}

/** Parses a facts comment body: "facts: a.b, c.d; facts.docs: x.y" gives ["a.b", "c.d", "docs.x.y"]. */
export function annotationKeys(body: string): string[] | null {
  const parts = body.split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^facts(\.docs)?:/.test(p))) return null;
  const keys: string[] = [];
  for (const p of parts) {
    const docs = p.startsWith('facts.docs:');
    for (const k of p.slice(p.indexOf(':') + 1).split(',').map((x) => x.trim()).filter(Boolean)) keys.push(docs ? `docs.${k}` : k);
  }
  return keys;
}

// "section 1.6", "sections 5.5 and 6", "Sections "Before you start" and 1.6", "seções 1.4, 1.6 e 3".
const SECTION_ITEM = String.raw`(?:\d+(?:\.\d+)?|"[^"\n]{1,40}")`;
const SECTION_WORD = new RegExp(String.raw`\b(sections?|seç(?:ão|ões))\s+(${SECTION_ITEM}(?:(?:,\s*|\s+(?:and|e)\s+)${SECTION_ITEM})*)`, 'giu');

/** Fenced code blocks; a fence may be indented inside a list item. */
const FENCE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$/gm;

export function maskMarkdown(text: string): Masked {
  const annotations: Annotation[] = [];
  const sections = new Set<string>();
  const sectionRefs: { ref: string; at: number }[] = [];
  let t = text;
  t = blankAll(t, /<!-- facts:([a-z0-9-]+) -->[\s\S]*?<!-- \/facts:\1 -->/g);
  t = blankAll(t, /<!-- facts-template:[a-z0-9-]+\n[\s\S]*?\n-->/g);
  t = blankAll(t, FENCE);
  t = blankAll(t, /<!--([\s\S]*?)-->/g, (g, at) => {
    const keys = annotationKeys(g[1]);
    if (keys) annotations.push({ at, keys });
  });
  t = blankAll(t, /(``?)[^`\n]+?\1/g);
  t = blankAll(t, /<\/?[A-Za-z][^>\n]*>/g);
  t = blankAll(t, /\]\([^)\s]*(?:\s+"[^"]*")?\)/g);
  t = blankAll(t, /\bhttps?:\/\/[^\s)|>]+/g);
  t = blankAll(t, /\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|edu|gov|br)\b(?:\/[^\s)|]*)?/g);
  t = t.replace(/^(#{1,6}[ \t]+)(\d+(?:\.\d+)*)\.?(?=[ \t])/gm, (all, hashes: string, n: string) => {
    sections.add(n);
    return hashes + blank(all.slice(hashes.length));
  });
  t = t.replace(/^([ \t]*)(\d+)\.(?=[ \t])/gm, (all, indent: string) => indent + blank(all.slice(indent.length)));
  t = t.replace(/^([ \t]*\*[ \t]+\[)(\d+(?:\.\d+)*)\.?(?=[ \t])/gm, (all, lead: string) => lead + blank(all.slice(lead.length)));
  t = t.replace(SECTION_WORD, (all: string, word: string, list: string, offset: number) => {
    // "privacy-lia.md, section 5" points into another document: not checked here.
    const external = /\.md`?\)?[^.\n]{0,40}$/.test(text.slice(Math.max(0, offset - 60), offset));
    if (!external) for (const m of list.replace(/"[^"]*"/g, '').matchAll(/\d+(?:\.\d+)?/g)) sectionRefs.push({ ref: m[0], at: offset });
    return word + blank(all.slice(word.length));
  });
  return { prose: t, annotations, sections, sectionRefs };
}

// A number is not part of a name: nothing of a word glued before it (a letter, a digit, "_", "/",
// ":", "+", "-" or "."), and no letter, digit, "_", "+", "-word" or ".word" glued after it. Version
// names (v1, v2.3), ISO dates, Brazilian dates and clock times are tokens of their own.
const TOKEN = new RegExp(
  [
    String.raw`(?<date>(?<![\p{L}\p{N}_/-])\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?(?![\p{L}\p{N}_]))`,
    String.raw`(?<ptdate>(?<![\p{L}\p{N}_/-])\d{2}/\d{2}/\d{4}(?![\p{L}\p{N}_/]))`,
    String.raw`(?<time>(?<![\p{L}\p{N}_:])\d{1,2}:\d{2}(?![\p{N}:]))`,
    String.raw`(?<version>(?<![\p{L}\p{N}_/.-])v\d+(?:\.\d+)*(?![\p{L}\p{N}_]))`,
    String.raw`(?<num>(?<![\p{L}\p{N}_/:+.,-])−?\d+(?:[.,]\d+)*%?(?![\p{L}\p{N}_+]|[.,]\d|[-.][\p{L}\p{N}]))`,
  ].join('|'),
  'gu',
);

const EN_NUMBER = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^\d+(?:\.\d+)?$/;
const PT_NUMBER = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$|^\d+(?:,\d+)?$/;

/** Reads "1,153.5" (en) or "1.153,5" (pt); a token valid only in the other language is read in that one. */
export function readNumber(body: string, lang: Lang): { value: number; decimals: number } | null {
  const order: Lang[] = lang === 'en' ? ['en', 'pt'] : ['pt', 'en'];
  for (const l of order) {
    if (!(l === 'en' ? EN_NUMBER : PT_NUMBER).test(body)) continue;
    const [group, dec] = l === 'en' ? [',', '.'] : ['.', ','];
    const plain = body.split(group).join('').replace(dec, '.');
    const i = plain.indexOf('.');
    return { value: Number(plain), decimals: i < 0 ? 0 : plain.length - i - 1 };
  }
  return null;
}

const UNIT_AFTER: [RegExp, NonNullable<Token['unit']>][] = [
  [/^\s+(?:million|milhão|milhões)(?![\p{L}])/iu, 'million'],
  [/^\s+(?:billion|bilhão|bilhões)(?![\p{L}])/iu, 'billion'],
  [/^\s+mil(?![\p{L}])/u, 'thousand'],
  [/^\s+(?:points?|pontos?)(?![\p{L}])/iu, 'points'],
  [/^\s+KB\b/u, 'KB'],
  [/^\s+MB\b/u, 'MB'],
];

/** The tokens of a masked text, in order. */
export function tokens(prose: string, lang: Lang): Token[] {
  const out: Token[] = [];
  for (const m of prose.matchAll(TOKEN)) {
    const g = m.groups as Record<string, string | undefined>;
    const at = m.index;
    if (g.date || g.ptdate) out.push({ text: m[0], kind: 'date', at });
    else if (g.time) out.push({ text: m[0], kind: 'time', at });
    else if (g.version) out.push({ text: m[0], kind: 'version', at });
    else {
      const text = m[0];
      const percent = text.endsWith('%');
      const body = text.replace(/^−/, '').replace(/%$/, '');
      const read = readNumber(body, lang);
      if (!read) {
        out.push({ text, kind: 'raw', at });
        continue;
      }
      const unit = UNIT_AFTER.find(([re]) => re.test(prose.slice(at + text.length, at + text.length + 16)))?.[1];
      const value = text.startsWith('−') ? -read.value : read.value;
      out.push({ text, kind: 'number', at, value, decimals: read.decimals, percent, ...(unit ? { unit } : {}) });
    }
  }
  return out;
}

/** The single token a short text holds, read in a language (for allowlist entries and checks). */
export function tokenOf(text: string, lang: Lang): Token {
  const t = tokens(` ${text} `, lang);
  if (t.length !== 1 || t[0].text !== text) throw new Error(`"${text}" is not one token`);
  return t[0];
}

// -----------------------------------------------------------------------------------------------
// facts.json

/** The value at a path; a key may itself hold dots ("docs.deploy.cf.workerSizeMiB"). */
export function factAt(facts: unknown, path: string): { found: boolean; value?: unknown } {
  const parts = path.split('.');
  const walk = (node: unknown, i: number): { found: boolean; value?: unknown } => {
    if (i === parts.length) return { found: true, value: node };
    if (node === null || typeof node !== 'object') return { found: false };
    for (let j = parts.length; j > i; j--) {
      const key = parts.slice(i, j).join('.');
      if (Object.hasOwn(node, key)) {
        const r = walk((node as Record<string, unknown>)[key], j);
        if (r.found) return r;
      }
    }
    return { found: false };
  };
  return walk(facts, 0);
}

/** A docs entry stands for its value. */
export function plainValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && 'source' in v) return (v as { value: unknown }).value;
  return v;
}

/** Every finite number in facts.json, docs values included, once each. */
export function factNumbers(facts: unknown): number[] {
  const out = new Set<number>();
  const walk = (node: unknown) => {
    if (typeof node === 'number' && Number.isFinite(node)) out.add(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(facts);
  return [...out];
}

const formatters = new Map<number, Intl.NumberFormat>();
/** A number with `d` decimals, rounded the way the site and the README tool round (Intl, en-US). */
export function fixed(v: number, d: number): string {
  let f = formatters.get(d);
  if (!f) formatters.set(d, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false })));
  return f.format(v).replace(/^-(0(\.0+)?)$/, '$1');
}

/** The ways a fact may be written in a text: itself, as a percent or points, scaled by the word after it. */
function candidates(fact: number, t: Token): number[] {
  const c = [fact];
  if (t.percent || t.unit === 'points') c.push(fact * 100);
  if (t.unit === 'million' || t.unit === 'MB') c.push(fact / 1e6);
  if (t.unit === 'billion') c.push(fact / 1e9);
  if (t.unit === 'thousand' || t.unit === 'KB') c.push(fact / 1e3);
  return c;
}

/** True when the number token states `fact` at the precision shown. */
export function statesNumber(t: Token, fact: number): boolean {
  if (t.kind !== 'number' || t.value === undefined) return false;
  const want = fixed(t.value, t.decimals ?? 0);
  return candidates(fact, t).some((c) => fixed(c, t.decimals ?? 0) === want);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the token states a string fact: the string holds the token (a version without its "v") as a whole. */
export function statesString(t: Token, fact: string): boolean {
  const bodies = [t.text.replace(/%$/, '')];
  if (t.kind === 'version') bodies.push(t.text.slice(1));
  return bodies.some((b) => fact === b || new RegExp(`(?<![\\p{N}.,])${escape(b)}(?![\\p{N}]|[.,]\\p{N})`, 'u').test(fact));
}

/** True when the token states a fact of any kind. */
export function statesValue(t: Token, v: unknown): boolean {
  if (typeof v === 'number') return statesNumber(t, v);
  if (typeof v === 'string') return statesString(t, v);
  return false;
}

/** A bare integer from 0 to 12. */
export function isSmallInteger(t: Token): boolean {
  return t.kind === 'number' && !t.percent && t.decimals === 0 && t.value !== undefined && t.value >= 0 && t.value <= 12 && !t.unit;
}

/** Significant digits as written: "734,207" has 6, "4,000" has 1, "5.30" has 3, "0.02" has 1. */
export function significantDigits(t: Token): number {
  if (t.kind !== 'number' || t.value === undefined) return 0;
  const digits = fixed(Math.abs(t.value), t.decimals ?? 0).replace('.', '').replace(/^0+/, '');
  return (t.decimals ?? 0) > 0 ? digits.length : digits.replace(/0+$/, '').length;
}

/**
 * facts.json holds thousands of numbers (training curves, counts per bin), so a number with two or
 * three significant digits nearly always equals one of them by chance. Without a comment that names
 * its fact, a number counts as stated by facts.json only from this many significant digits on.
 */
export const MIN_DIGITS_UNNAMED = 4;

/** The numbers of facts.json by their text at 0 to 4 decimals, so a token finds its candidates fast. */
export class FactIndex {
  private readonly byText = new Map<string, Set<number>>();
  constructor(numbers: readonly number[]) {
    for (const n of numbers) {
      for (let d = 0; d <= 4; d++) {
        for (const c of [n, n * 100, n / 1e3, n / 1e6, n / 1e9]) {
          const k = `${d}|${fixed(c, d)}`;
          let s = this.byText.get(k);
          if (!s) this.byText.set(k, (s = new Set()));
          s.add(n);
        }
      }
    }
  }

  /** Some number of facts.json states this token. */
  has(t: Token): boolean {
    if (t.kind !== 'number' || t.value === undefined) return false;
    const d = Math.min(t.decimals ?? 0, 4);
    const pool = this.byText.get(`${d}|${fixed(t.value, d)}`);
    if (!pool) return false;
    for (const n of pool) if (statesNumber(t, n)) return true;
    return false;
  }
}

const WORDS: Record<Lang, string[]> = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'],
  pt: ['zero', 'um|uma', 'dois|duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze'],
};

/** A small whole number written as a word ("one rate limiting rule", "uma regra"). */
export function statesInWords(span: string, v: number, lang: Lang): boolean {
  if (!Number.isInteger(v) || v < 0 || v > 12) return false;
  return new RegExp(`(?<![\\p{L}])(?:${WORDS[lang][v]})(?![\\p{L}])`, 'iu').test(span);
}

// -----------------------------------------------------------------------------------------------
// Checking one text

/** Start offsets of the units of a masked text: paragraphs, list items, headings and table cells. */
export function unitStarts(prose: string): number[] {
  const starts = [0];
  let at = 0;
  let prevBlank = true;
  for (const line of prose.split('\n')) {
    const isBlank = line.trim() === '';
    const isTable = /^\s*\|/.test(line);
    const isItem = /^\s*(?:[*+]|\d+\.)\s/.test(line);
    const isHeading = /^#{1,6}\s/.test(line);
    if (!isBlank && (prevBlank || isTable || isItem || isHeading)) starts.push(at);
    if (isTable) for (let i = line.indexOf('|'); i >= 0; i = line.indexOf('|', i + 1)) starts.push(at + i);
    prevBlank = isBlank;
    at += line.length + 1;
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

export interface Finding {
  line: number;
  token: string;
  problem: string;
}

export interface CheckOptions {
  lang: Lang;
  facts: unknown;
  index: FactIndex;
  /** Tokens the file may state without a fact, exactly as written. */
  allowed: ReadonlySet<string>;
  /** Version strings the repository names (lock files, images, .node-version). */
  versions?: ReadonlySet<string>;
}

export interface CheckResult {
  findings: Finding[];
  /** Allowlisted tokens the file needed. */
  usedAllowed: Set<string>;
  tokens: Token[];
}

/** Checks every number of one Markdown text. */
export function checkText(text: string, o: CheckOptions): CheckResult {
  const { prose, annotations, sections, sectionRefs } = maskMarkdown(text);
  const all = tokens(prose, o.lang);
  const findings: Finding[] = [];
  const usedAllowed = new Set<string>();
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  const starts = unitStarts(prose);
  const unitOf = (i: number) => {
    let u = 0;
    for (const s of starts) if (s <= i) u = s;
    return u;
  };
  const value = (key: string) => plainValue(factAt(o.facts, key).value);

  // The prose a comment speaks for: from the previous comment of its unit, or from the unit's start.
  const spanStart = (a: Annotation) => {
    const u = unitOf(a.at);
    const prev = annotations.filter((x) => x.at < a.at && unitOf(x.at) === u).pop();
    return prev ? prev.at : u;
  };

  // A token belongs to the first comment after it in its unit.
  const covering = new Map<Token, Annotation>();
  const byAnnotation = new Map<Annotation, Token[]>(annotations.map((a) => [a, []]));
  for (const t of all) {
    const u = unitOf(t.at);
    const a = annotations.find((x) => x.at > t.at && unitOf(x.at) === u);
    if (a) {
      covering.set(t, a);
      byAnnotation.get(a)!.push(t);
    }
  }

  for (const a of annotations) {
    for (const key of a.keys) {
      if (!factAt(o.facts, key).found) {
        findings.push({ line: lineAt(a.at), token: key, problem: 'a facts comment names a key that facts.json does not have' });
        continue;
      }
      const v = value(key);
      const stated = byAnnotation.get(a)!.some((t) => statesNumber(t, v as number)) || statesInWords(prose.slice(spanStart(a), a.at), v as number, o.lang);
      if (typeof v === 'number' && !stated) findings.push({ line: lineAt(a.at), token: key, problem: `no number before the comment states ${key} = ${v}` });
    }
  }

  for (const t of all) {
    const a = covering.get(t);
    if (a && a.keys.some((k) => statesValue(t, value(k)))) continue;
    if (o.allowed.has(t.text)) {
      usedAllowed.add(t.text);
      continue;
    }
    if (t.kind === 'raw' && o.versions?.has(t.text)) continue;
    const specific = t.kind === 'number' && !isSmallInteger(t) && significantDigits(t) >= MIN_DIGITS_UNNAMED;
    if (specific && o.index.has(t)) continue;
    const problem =
      t.kind !== 'number'
        ? `a ${t.kind === 'raw' ? 'version' : t.kind} that is not on the allowlist${t.kind === 'raw' ? ' and that no lock file or image names' : ''}`
        : a
          ? `the comment after it names ${a.keys.join(', ')}, and none of them states it; not on the allowlist either`
          : specific
            ? 'no value of facts.json states it at this precision, and it is not on the allowlist'
            : `under ${MIN_DIGITS_UNNAMED} significant digits: it needs a facts comment that names its key, or an allowlist entry`;
    findings.push({ line: lineAt(t.at), token: t.text, problem });
  }

  for (const r of sectionRefs) {
    if (!sections.has(r.ref)) findings.push({ line: lineAt(r.at), token: r.ref, problem: 'a reference to a section that no heading of the file numbers' });
  }
  return { findings, usedAllowed, tokens: all };
}

// -----------------------------------------------------------------------------------------------
// Links and anchors

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
export function githubSlug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Every anchor of a Markdown text: heading slugs (with -1, -2 for repeats) and explicit ids. */
export function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  const prose = text.replace(FENCE, (m) => blank(m));
  for (const m of prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const slug = githubSlug(m[1]);
    const n = seen.get(slug) ?? 0;
    out.add(n ? `${slug}-${n}` : slug);
    seen.set(slug, n + 1);
  }
  for (const m of prose.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

export interface Link {
  target: string;
  line: number;
}

/** The links of a Markdown text outside fenced code: inline links and images. */
export function linksOf(text: string): Link[] {
  const prose = text.replace(FENCE, (m) => blank(m)).replace(/(``?)[^`\n]+?\1/g, (m) => blank(m));
  const out: Link[] = [];
  for (const m of prose.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    out.push({ target: m[1], line: prose.slice(0, m.index).split('\n').length });
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// Locale files

/** Every string of a locale file, by its dotted key. */
export function localeStrings(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => localeStrings(v, prefix ? `${prefix}.${i}` : String(i)));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => localeStrings(v, prefix ? `${prefix}.${k}` : k));
  return [];
}

/**
 * The numbers a locale string writes outside its placeholders, as plain text: "1,000" (en) and
 * "1.000" (pt) both give "1000"; "4.0" stays "4.0"; "7º" gives "7".
 */
export function localeNumbers(s: string, lang: Lang): string[] {
  const text = s.replace(/\{[^}]*\}/g, '');
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map(([n]) => {
    const grouped = lang === 'en' ? /^\d{1,3}(?:,\d{3})+$/ : /^\d{1,3}(?:\.\d{3})+$/;
    return grouped.test(n) ? n.replace(/[.,]/g, '') : n;
  });
}
