// Number formatting for the data pages (DATA-SPEC 3.5). Everything goes through Intl with pt-BR or
// en-US (dates in English use en-GB with a short month). The few words that numbers need ("de X a
// Y", "partida em cada 100", "8 de cada 10") live in the data area of the locales as templates
// with {placeholders}; the digits are always made here, never typed into a string.
//
// makeFormat(lang, text) is pure: the unit tests build it from the locale files directly. Pages use
// fmt(), which binds the current language and i18n's t().

import { lang as currentLang, t, type Key, type Vars } from '../i18n.ts';
import type { Lang } from '../routes.ts';

/** Text lookup: a data key and its variables, already filled in. */
export type TextFn = (key: Key, vars?: Vars) => string;

/** 0 or 1 decimal for a share shown as a percent. */
export type Digits = 0 | 1 | 2;

/** The minus sign of charts and tables (U+2212), never a hyphen. */
export const MINUS = '−';

export interface Format {
  readonly lang: Lang;
  /** The text lookup this formatter was made with (findings use it for names inside titles). */
  readonly text: TextFn;
  /** A share as a percent: pct(0.796, 1) is "79,6%" / "79.6%". */
  pct(v: number, digits?: Digits): string;
  /** A plain number with a fixed number of decimals (minus as U+2212). */
  num(v: number, digits?: Digits): string;
  /** A whole number with grouping: "4.000" / "4,000". */
  int(n: number): string;
  /** From one million up, one decimal and the word ("3,1 milhões" / "3.1 million"); below, int(). */
  big(n: number): string;
  /** Two shares as a range in words: "de 78,8% a 80,5%" / "from 78.8% to 80.5%". */
  range(lo: number, hi: number, digits?: Digits): string;
  /**
   * A difference in mean score as games per 100: per100(0.0123) is "1,2 partida em cada 100". One
   * decimal by default (no trailing zero); `digits` 2 keeps two, for a bound that sits next to a
   * limit and must not round onto it (per100(0.01046, 2) is "1,05 partida em cada 100").
   */
  per100(d: number, digits?: 1 | 2): string;
  /** Two differences in mean score as one range of games per 100 (`digits` as in per100). */
  per100Range(lo: number, hi: number, digits?: 1 | 2): string;
  /** A number with its sign, for chart labels: "−0,4", "+1,2", "0". */
  signed(v: number, digits?: Digits): string;
  /** A date in the page language: "21/11/2026" / "21 Nov 2026" (UTC unless local is set). */
  date(ms: number, opts?: { local?: boolean }): string;
  /** A clock time in the viewer's zone: "14:05". */
  time(ms: number): string;
  /** Milliseconds: one decimal under 10 ("0,4 ms"), whole above. */
  ms(v: number): string;
  /** Bytes as kilobytes (bytes / 1000, rounded): "185 KB". */
  kb(bytes: number): string;
  /** A share as a rounded count out of ten: "8 de cada 10" / "8 out of 10". */
  inTen(share: number): string;
  /** The same phrase for a given k. */
  tenths(k: number): string;
  /** A score: "12 a 7" / "12 to 7". */
  score(a: number, b: number): string;
}

const LOCALE: Record<Lang, string> = { pt: 'pt-BR', en: 'en-US' };

/** Decimals for a share: 1 when the 95% half width is under one point (or exact), else 0. */
export function digitsFor(half95: number | null | undefined): Digits {
  if (half95 === null || half95 === undefined || !Number.isFinite(half95)) return 1;
  return half95 < 0.01 ? 1 : 0;
}

/** Half width of an interval given as lo and hi (for digitsFor). */
export function halfWidth(lo: number, hi: number): number {
  return Math.abs(hi - lo) / 2;
}

export function makeFormat(lang: Lang, text: TextFn): Format {
  const loc = LOCALE[lang];
  const cache = new Map<string, Intl.NumberFormat>();
  const nf = (key: string, opts: Intl.NumberFormatOptions) => {
    let f = cache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(loc, opts);
      cache.set(key, f);
    }
    return f;
  };
  const minus = (s: string) => s.replace(/^-/, MINUS).replace(/(\s)-/g, `$1${MINUS}`);
  // Intl rounds half away from zero; a value that rounds to zero must not keep its sign ("−0").
  const zeroSafe = (v: number, digits: number) => (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v);
  // -0 prints as "-0" in Intl; a zero is a zero.
  const unsigned0 = (v: number) => (v === 0 ? 0 : v);
  const num = (v: number, digits: Digits = 1) =>
    minus(nf(`n${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(zeroSafe(v, digits)));
  const pct = (v: number, digits: Digits = 1) =>
    minus(nf(`p${digits}`, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(zeroSafe(v, digits + 2)));
  const int = (n: number) => minus(nf('i', { maximumFractionDigits: 0 }).format(unsigned0(Math.round(n))));
  /** Up to one decimal (or `digits`), no trailing zero: 1.23 is "1,2", 1.0 is "1". */
  const short = (v: number, digits: 1 | 2 = 1) => minus(nf(`s${digits}`, { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(zeroSafe(v, digits)));
  const plural = (shown: number) => {
    // pt: singular under 2 ("1,5 partida"); en: singular only for exactly 1.
    if (lang === 'pt') return Math.abs(shown) < 2 ? 'one' : 'other';
    return Math.abs(shown) === 1 ? 'one' : 'other';
  };
  const roundTo = (v: number, digits: 1 | 2) => Math.round(v * 10 ** digits) / 10 ** digits;
  const base = () => int(100);
  return {
    lang,
    text,
    pct,
    num,
    int,
    big(n) {
      if (Math.abs(n) < 1_000_000) return int(n);
      return nf('b', { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 }).format(n);
    },
    range(lo, hi, digits = 1) {
      return text('data.fmt.range', { a: pct(lo, digits), b: pct(hi, digits) });
    },
    per100(d, digits = 1) {
      const v = roundTo(d * 100, digits);
      return text(`data.fmt.per100.${plural(v)}` as Key, { v: short(v, digits), base: base() });
    },
    per100Range(lo, hi, digits = 1) {
      const a = roundTo(lo * 100, digits);
      const b = roundTo(hi * 100, digits);
      // pt: singular while both ends are under 2; en: a range is never exactly 1, so plural.
      const form = lang === 'pt' && plural(a) === 'one' && plural(b) === 'one' ? 'one' : 'other';
      return text(`data.fmt.per100Range.${form}` as Key, { a: short(a, digits), b: short(b, digits), base: base() });
    },
    signed(v, digits = 1) {
      const shown = zeroSafe(v, digits);
      if (shown === 0) return num(0, digits);
      return shown > 0 ? `+${num(shown, digits)}` : num(shown, digits);
    },
    date(ms, opts) {
      const zone = opts?.local ? {} : { timeZone: 'UTC' };
      if (lang === 'en') return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...zone }).format(ms);
      return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', ...zone }).format(ms);
    },
    time(ms) {
      return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'pt-BR', { hour: '2-digit', minute: '2-digit' }).format(ms);
    },
    ms(v) {
      return text('data.fmt.ms', { v: Math.abs(v) < 10 ? num(v, 1) : int(v) });
    },
    kb(bytes) {
      return text('data.fmt.kb', { v: int(bytes / 1000) });
    },
    inTen(share) {
      return text('data.fmt.inTen', { k: int(Math.round(share * 10)), n: int(10) });
    },
    tenths(k) {
      return text('data.fmt.inTen', { k: int(k), n: int(10) });
    },
    score(a, b) {
      return text('data.vs.score', { a: int(a), b: int(b) });
    },
  };
}

const bound: Partial<Record<Lang, Format>> = {};

/** The formatter of the current page language (i18n's t and lang). */
export function fmt(): Format {
  const l = currentLang();
  return (bound[l] ??= makeFormat(l, (key, vars) => t(key, vars)));
}
