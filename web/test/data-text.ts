// Test helper for the data pages: the text lookup of one language read from the locale files (the
// same rule as i18n's t()), and a formatter per language. Not a test file itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFormat, type Format, type TextFn } from '../src/data/format.ts';
import type { Lang } from '../src/routes.ts';

const root = join(import.meta.dirname, '..', '..', 'locales');
const load = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8')) as Record<string, string>;

export const DICT: Record<Lang, Record<string, string>> = {
  pt: { ...load('pt-BR.json'), ...load('glossary.pt-BR.json'), ...load('data.pt-BR.json') },
  en: { ...load('en.json'), ...load('glossary.en.json'), ...load('data.en.json') },
};

export function textFor(lang: Lang): TextFn {
  return (key, vars) => {
    const s = DICT[lang][key];
    if (s === undefined) throw new Error(`missing key ${key}`);
    return vars ? s.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : s;
  };
}

/** Intl may use a no-break space; the spec's examples use a plain one. */
export const plain = (s: string) => s.replace(/[  ]/g, ' ');

export const F: Record<Lang, Format> = { pt: makeFormat('pt', textFor('pt')), en: makeFormat('en', textFor('en')) };
