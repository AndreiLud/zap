// Text in two languages. Every visible string lives in locales/: the shared files pt-BR.json and
// en.json (edited only at integration), the area files <area>.pt-BR.json and <area>.en.json (one
// pair per area of the client, keys prefixed with "<area>.", CLIENT-SPEC 22.1) and the legal texts
// legal.pt-BR.json and legal.en.json (keys legal.*). Flat keys, {placeholders}.
// web/test/locales.test.ts keeps the files in step.
//
// Every dictionary is in the entry chunk except the legal texts and the data area, which load on
// demand: loadLegal() for the legal pages, the You page, the age gate and the notice; loadData() for the
// data pages (DATA-SPEC 7). The Key type still covers both through type queries, so a literal key
// that does not exist fails the typecheck, and neither file lands in the entry chunk.
//
// Portuguese lives at the root of the site and English under /en/. The switch changes the text in
// place: it rewrites the address with history.replaceState and never reloads the page, so the room
// connection stays open.

import ptBR from '../../locales/pt-BR.json' with { type: 'json' };
import en from '../../locales/en.json' with { type: 'json' };
import shellPt from '../../locales/shell.pt-BR.json' with { type: 'json' };
import shellEn from '../../locales/shell.en.json' with { type: 'json' };
import startPt from '../../locales/start.pt-BR.json' with { type: 'json' };
import startEn from '../../locales/start.en.json' with { type: 'json' };
import playPt from '../../locales/play.pt-BR.json' with { type: 'json' };
import playEn from '../../locales/play.en.json' with { type: 'json' };
import boardPt from '../../locales/board.pt-BR.json' with { type: 'json' };
import boardEn from '../../locales/board.en.json' with { type: 'json' };
import trucoPt from '../../locales/truco.pt-BR.json' with { type: 'json' };
import trucoEn from '../../locales/truco.en.json' with { type: 'json' };
import guidePt from '../../locales/guide.pt-BR.json' with { type: 'json' };
import guideEn from '../../locales/guide.en.json' with { type: 'json' };
import rulebookPt from '../../locales/rulebook.pt-BR.json' with { type: 'json' };
import rulebookEn from '../../locales/rulebook.en.json' with { type: 'json' };
import glossaryPt from '../../locales/glossary.pt-BR.json' with { type: 'json' };
import glossaryEn from '../../locales/glossary.en.json' with { type: 'json' };
import adsPt from '../../locales/ads.pt-BR.json' with { type: 'json' };
import adsEn from '../../locales/ads.en.json' with { type: 'json' };
import type legalPtBR from '../../locales/legal.pt-BR.json';
import type dataPt from '../../locales/data.pt-BR.json';
import type { Lang } from './routes.ts';

export type { Lang } from './routes.ts';
export { langFromPath } from './routes.ts';

type Eager = typeof ptBR &
  typeof shellPt &
  typeof startPt &
  typeof playPt &
  typeof boardPt &
  typeof trucoPt &
  typeof guidePt &
  typeof rulebookPt &
  typeof glossaryPt &
  typeof adsPt &
  typeof dataPt;
export type LegalKey = keyof typeof legalPtBR;
export type Key = keyof Eager | LegalKey;
export type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Record<string, string>> = {
  pt: { ...ptBR, ...shellPt, ...startPt, ...playPt, ...boardPt, ...trucoPt, ...guidePt, ...rulebookPt, ...glossaryPt, ...adsPt },
  en: { ...en, ...shellEn, ...startEn, ...playEn, ...boardEn, ...trucoEn, ...guideEn, ...rulebookEn, ...glossaryEn, ...adsEn },
};
const STORAGE_KEY = 'zap-lang';

let current: Lang = 'pt';

export function lang(): Lang {
  return current;
}

export function t(key: Key, vars?: Vars): string {
  const s = DICTS[current][key] ?? DICTS.pt[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Plural by count: uses `${base}.one` for 1 and `${base}.other` otherwise, with {n} filled in. */
export function tn(base: 'points', n: number): string {
  return t(`${base}.${n === 1 ? 'one' : 'other'}`, { n });
}

// ------------------------------------------------------------------------------------------------
// Legal texts, on demand

const legalLoading: Partial<Record<Lang, Promise<void>>> = {};
const legalOrder: { keys: LegalKey[] | null } = { keys: null };
const legalListeners = new Set<() => void>();

/** True once the legal texts of a language are in the dictionary. */
export function legalReady(l: Lang = current): boolean {
  return legalOrder.keys !== null && 'legal.nav.label' in DICTS[l];
}

/**
 * Loads the legal texts of a language (the current one by default) into the dictionary, once.
 * Each language is its own chunk; the other one loads when the person switches.
 */
export function loadLegal(l: Lang = current): Promise<void> {
  legalLoading[l] ??= (l === 'en' ? import('../../locales/legal.en.json') : import('../../locales/legal.pt-BR.json')).then(
    (m) => {
      const dict = m.default as Record<string, string>;
      Object.assign(DICTS[l], dict);
      // Both files share one key order (locales.test.ts), so either gives the page order.
      legalOrder.keys ??= Object.keys(dict) as LegalKey[];
      for (const fn of legalListeners) fn();
    },
    (e: unknown) => {
      // A failed chunk can be asked for again.
      delete legalLoading[l];
      throw e;
    },
  );
  return legalLoading[l]!;
}

/** Called after each legal dictionary loads (the store bumps legalLoads, so pages re-render). */
export function onLegalLoaded(fn: () => void): () => void {
  legalListeners.add(fn);
  return () => legalListeners.delete(fn);
}

/** Keys of the legal texts that start with a prefix, in file order. Empty until loadLegal() ran. */
export function legalKeys(prefix: string): LegalKey[] {
  return (legalOrder.keys ?? []).filter((k) => k.startsWith(prefix));
}

// ------------------------------------------------------------------------------------------------
// The data area, on demand (DATA-SPEC 7)

const dataLoading: Partial<Record<Lang, Promise<void>>> = {};
const dataIn: Partial<Record<Lang, true>> = {};

/** True once the data area of a language is in the dictionary. */
export function dataReady(l: Lang = current): boolean {
  return dataIn[l] === true;
}

/**
 * Loads the data area of a language (the current one by default) into the dictionary, once. The
 * data pages await it; each language is its own chunk, and a language switch loads the other.
 */
export function loadData(l: Lang = current): Promise<void> {
  dataLoading[l] ??= (l === 'en' ? import('../../locales/data.en.json') : import('../../locales/data.pt-BR.json')).then(
    (m) => {
      Object.assign(DICTS[l], m.default as Record<string, string>);
      dataIn[l] = true;
    },
    (e: unknown) => {
      delete dataLoading[l];
      throw e;
    },
  );
  return dataLoading[l]!;
}

// ------------------------------------------------------------------------------------------------
// Language of the page

export function savedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' || v === 'pt' ? v : null;
  } catch {
    return null;
  }
}

/** Applies a language to the module and the document (html lang); the store re-renders the text. */
export function applyLang(l: Lang, remember: boolean): void {
  current = l;
  document.documentElement.lang = l === 'en' ? 'en' : 'pt-BR';
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }
  // Pages that already show legal text get the other language's texts too.
  if (legalOrder.keys !== null) void loadLegal(l).catch(() => {});
}

/** Path prefix for links inside the site. */
export function basePath(l: Lang = current): string {
  return l === 'en' ? '/en/' : '/';
}
