// The glossary of the rules page (id="glossario", data-testid="glossary"): every term of
// locales/glossary.*.json in the order of CLIENT-SPEC 22.7, each with the anchor #glossario-<id>
// that the Term popovers link to. And the seven sources of project_docs/rules.md.

import type { GlossaryId } from '../components/Term.tsx';
import { t, type Key } from '../i18n.ts';

export const GLOSSARY_ORDER: readonly GlossaryId[] = [
  'truco',
  'tento',
  'mao',
  'rodada',
  'vira',
  'manilha',
  'zap',
  'copas',
  'espadilha',
  'picafumo',
  'onze',
  'dez',
  'ferro',
  'coberta',
  'correr',
  'desce',
  'aumentos',
  'queda',
  'sinal',
];

export function Glossary() {
  return (
    <dl class="glossary" id="glossario" data-testid="glossary">
      {GLOSSARY_ORDER.map((id) => (
        <div key={id} class="glossary__item">
          <dt id={`glossario-${id}`} tabIndex={-1}>
            {t(`glossary.${id}.name` as Key)}
          </dt>
          <dd>{t(`glossary.${id}.def` as Key)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The sources of project_docs/rules.md, in its order. */
export const SOURCES: readonly { key: Key; href: string }[] = [
  {
    key: 'rulebook.src.uffs',
    href: 'https://site-antigo-2025.uffs.edu.br/pastas-ocultas/bd/pro-reitoria-de-assuntos-estudantis/arquivos/regulamento-truco-paulista/@@download/file',
  },
  { key: 'rulebook.src.banc', href: 'https://spbancarios.com.br/sites/default/files/anexos/regulamento2017_1.pdf' },
  { key: 'rulebook.src.asfo', href: 'https://www.ict.unesp.br/Home/sobreoict/fundacoeseassociacoes/asfo/regulamento-de-truco-2019.pdf' },
  { key: 'rulebook.src.mjp', href: 'https://www.megajogos.com.br/truco-online/regras' },
  { key: 'rulebook.src.mjm', href: 'https://www.megajogos.com.br/truco-mineiro-online/regras' },
  { key: 'rulebook.src.wiki', href: 'https://pt.wikipedia.org/wiki/Truco' },
  { key: 'rulebook.src.pagat', href: 'https://pagat.com/put/truco_br.html' },
];
