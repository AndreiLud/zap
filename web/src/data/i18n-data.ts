// Text with tap terms for the data pages (DATA-SPEC 3.4). Locale strings mark a term with {t:<id>}
// and numbers with {placeholders}. td() returns Preact nodes: text pieces, the variables (strings,
// numbers or nodes such as a link) and a <Term> for each {t:<id>}; never an HTML string.
//
// Data terms (glossary.ts DATA_TERMS) open their definition from the data area and link to the
// closing list of the data page (#termos-<id>): on the data page the link scrolls there, anywhere
// else it moves to the data page with that hash. Game terms (manilha, vira...) are M8's and link to
// the rules glossary.

import { createElement, Fragment, type ComponentChildren } from 'preact';
import { navigate, urlFor } from '../actions.ts';
import { Term } from '../components/Term.tsx';
import { t, type Key } from '../i18n.ts';
import { DATA_TERMS, isDataTerm, isGameTerm, pieces, termAnchor, termDef, termName, type DataTermId } from './glossary.ts';

export { pieces, type Piece } from './glossary.ts';

/** Variables of td(): text, numbers or nodes. */
export type NodeVars = Record<string, string | number | ComponentChildren>;

/** The same template as plain text: terms by name, variables filled (for aria labels and captions). */
export function tdText(key: Key, vars: Record<string, string | number> = {}): string {
  return pieces(t(key))
    .map((p) => {
      if (p.kind === 'text') return p.text;
      if (p.kind === 'var') return p.name in vars ? String(vars[p.name]) : `{${p.name}}`;
      if (isDataTerm(p.id)) return termName(p.id);
      if (isGameTerm(p.id)) return t(`glossary.${p.id}.name` as Key);
      return p.id;
    })
    .join('');
}

/** Moves to a data term in the closing list: scrolls when it is on this page, else opens the data page. */
export function goToTerm(id: DataTermId, e?: Event): void {
  const anchor = termAnchor(id);
  const el = document.getElementById(anchor);
  e?.preventDefault();
  if (el) {
    history.replaceState(history.state, '', `#${anchor}`);
    el.scrollIntoView({ block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    return;
  }
  navigate({ name: 'data' }, { hash: `#${anchor}` });
}

/** The tap term of a data term, linking to the closing list. */
export function DataTerm({ id, children }: { id: DataTermId; children?: ComponentChildren }) {
  return createElement(Term, {
    id,
    text: { name: termName(id), def: termDef(id) },
    more: { href: `${urlFor({ name: 'data' })}#${termAnchor(id)}`, label: 'data.term.more', onClick: (e: MouseEvent) => goToTerm(id, e) },
    children,
  });
}

/** A data string as nodes: variables filled in, {t:<id>} as tap terms. */
export function td(key: Key, vars: NodeVars = {}): ComponentChildren[] {
  return pieces(t(key)).map((p, i) => {
    if (p.kind === 'text') return p.text;
    if (p.kind === 'var') {
      const v = vars[p.name];
      if (v === undefined) return `{${p.name}}`;
      return typeof v === 'string' || typeof v === 'number' ? String(v) : createElement(Fragment, { key: `v${i}` }, v);
    }
    if (isDataTerm(p.id)) return createElement(DataTerm, { key: `t${i}`, id: p.id });
    if (isGameTerm(p.id)) return createElement(Term, { key: `t${i}`, id: p.id });
    return p.id;
  });
}

/**
 * The closing list of data terms (DATA-SPEC 3.4): <dl id="termos">, each name a <dt id="termos-<id>">
 * the tap terms link to, in page order (glossary.ts DATA_TERMS) unless `ids` says otherwise.
 */
export function TermList({ ids = DATA_TERMS }: { ids?: readonly DataTermId[] }) {
  return createElement(
    'dl',
    { id: 'termos', class: 'terms' },
    ids.map((id) =>
      createElement(Fragment, { key: id }, createElement('dt', { id: termAnchor(id), tabIndex: -1 }, termName(id)), createElement('dd', null, termDef(id))),
    ),
  );
}
