// A sentence from the locales with elements in place of its {placeholders}: the words that are
// glossary terms (Term buttons) sit inside a translated sentence without splitting it into pieces.

import { Fragment, type ComponentChildren } from 'preact';
import { t, type Key } from '../i18n.ts';

export function Rich({ k, parts }: { k: Key; parts: Record<string, ComponentChildren> }) {
  const out: ComponentChildren[] = [];
  let last = 0;
  const s = t(k);
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    out.push(s.slice(last, m.index));
    out.push(m[1] in parts ? <Fragment key={m.index}>{parts[m[1]]}</Fragment> : m[0]);
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return <>{out}</>;
}
