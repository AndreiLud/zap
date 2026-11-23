// The data glossary (DATA-SPEC 3.4 and 7): terms that only the data pages use, with their names and
// short definitions in locales/data.*.json (data.term.<id>.name and .def). The game terms (manilha,
// vira, mão, onze, dez, rodada, correr) stay in M8's glossary area and open the rules glossary.
// A locale string marks a term with {t:<id>}; i18n-data.ts turns it into a tap term.

import { t, type Key, type Vars } from '../i18n.ts';

/** Data terms in the order the page meets them; the closing list (#termos) follows this order. */
export const DATA_TERMS = [
  'duelo',
  'imitacao',
  'regras',
  'recompensa',
  'treinador',
  'rede',
  'peso',
  'ajustado',
  'etapas',
  'margem',
  'dup',
  'populacao',
  'provas',
  'semleitura',
  'explorador',
  'ic',
  'gemea',
  'ruido',
  'blefe',
  'ic80',
  'faixa',
] as const;
export type DataTermId = (typeof DATA_TERMS)[number];

/** Game terms defined by M8's glossary area; on the data pages they link to the rules glossary. */
export const GAME_TERMS = ['manilha', 'vira', 'mao', 'onze', 'dez', 'rodada', 'correr'] as const;
export type GameTermId = (typeof GAME_TERMS)[number];

export function isDataTerm(id: string): id is DataTermId {
  return (DATA_TERMS as readonly string[]).includes(id);
}

export function isGameTerm(id: string): id is GameTermId {
  return (GAME_TERMS as readonly string[]).includes(id);
}

/** The anchor of a term in the closing list. */
export function termAnchor(id: DataTermId): string {
  return `termos-${id}`;
}

const termVars: Partial<Record<DataTermId, Vars>> = {};

/**
 * Numbers a definition needs, set once by the page that has them (etapas: { k } = decisions per
 * training step, from curve.json). A definition shown before that leaves the placeholder out.
 */
export function setTermVars(id: DataTermId, vars: Vars): void {
  termVars[id] = vars;
}

export function termName(id: DataTermId): string {
  return t(`data.term.${id}.name` as Key);
}

export function termDef(id: DataTermId): string {
  const s = t(`data.term.${id}.def` as Key, termVars[id]);
  // An unfilled {placeholder} never reaches the page: "junta {k} decisões" reads "junta decisões".
  return s.replace(/\{\w+\}\s?/g, '');
}

/** One piece of a template: plain text, a variable or a term. */
export type Piece = { kind: 'text'; text: string } | { kind: 'var'; name: string } | { kind: 'term'; id: string };

/** Splits a template into its pieces (pure; the unit tests use it). */
export function pieces(template: string): Piece[] {
  const out: Piece[] = [];
  const re = /\{t:([\w-]+)\}|\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) out.push({ kind: 'text', text: template.slice(last, m.index) });
    out.push(m[1] ? { kind: 'term', id: m[1] } : { kind: 'var', name: m[2] });
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push({ kind: 'text', text: template.slice(last) });
  return out;
}
