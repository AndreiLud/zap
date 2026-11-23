// The closing block of the data page (DATA-SPEC 4.10): the ways on (play, the personal page, the
// rules), where each number comes from (the method doc and facts.json, opened in a new tab), and
// the list of data terms every tap term links to (<dl id="termos">, DATA-SPEC 3.4).

import { ExternalLink, Link, SOURCE_URL } from '../../components/common.tsx';
import { t } from '../../i18n.ts';
import { td, TermList } from '../i18n-data.ts';
import './chapters.css';

/** The method doc and the numbers file, as published with the source. */
export const METHOD_URL = `${SOURCE_URL}/blob/main/project_docs/data-page.md`;
export const FACTS_URL = `${SOURCE_URL}/blob/main/facts.json`;

export function Closing() {
  return (
    <section id="fim" class="dp-part chap chap--end" aria-labelledby="fim-h">
      <header class="chap__head">
        <h2 id="fim-h" class="dp-part__h chap__title" tabIndex={-1}>
          {t('data.end.h')}
        </h2>
      </header>
      <div class="chap__end">
        <p class="chap__cta">
          <Link to={{ name: 'play' }} class="btn btn--primary" testid="data-end-play">
            {t('data.end.play')}
          </Link>
          <Link to={{ name: 'vs' }} class="btn" testid="data-end-you">
            {t('data.end.you')}
          </Link>
          <Link to={{ name: 'rules' }} class="btn" testid="data-end-rules">
            {t('data.end.rules')}
          </Link>
        </p>
        <p class="chap__links">{td('data.end.method', { link: <ExternalLink href={METHOD_URL} testid="data-end-method">{t('data.end.methodLink')}</ExternalLink> })}</p>
        <p class="chap__links">{td('data.end.facts', { link: <ExternalLink href={FACTS_URL} testid="data-end-facts">{t('data.end.factsLink')}</ExternalLink> })}</p>
      </div>
      <h2 id="termos-h" class="dp-part__h chap__title chap__title--terms">
        {t('data.end.terms')}
      </h2>
      <TermList />
    </section>
  );
}
