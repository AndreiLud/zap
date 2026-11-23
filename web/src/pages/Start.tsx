// The start page (/, /en/; CLIENT-SPEC 10.1, prototype azulejo-v2/index.html): a short opening
// screen. The hook and one line, one picture (the medallion tile with your three cards dealt into a
// fan) and exactly three buttons, all plain links: Jogar (the Play page), Código-fonte and Portfólio
// (new tabs). The header does not repeat the two external links and the footer is the short one.

import { useState } from 'preact/hooks';
import { Card } from '../deck/Card.tsx';
import { Medallion } from '../deck/tiles.tsx';
import { usePageChrome } from '../chrome.ts';
import { ExternalLink, Link, SOURCE_URL, portfolioUrl } from '../components/common.tsx';
import { Icon } from '../components/icons.tsx';
import { t } from '../i18n.ts';
import { usePageFocus } from '../page-focus.ts';
import type { AppState } from '../store.ts';
import '../styles/start.css';

/**
 * Your hand of the demonstration deal (the vira is the 6 of hearts, so the 7 of spades is a manilha):
 * 3 of diamonds, 7 of spades, king of clubs. Card ids are rank * 4 + suit.
 */
const HAND = [
  { card: 36, manilha: false },
  { card: 13, manilha: true },
  { card: 27, manilha: false },
];

/** The deal runs once per page load; coming back to the start page shows the resting fan. */
let dealt = false;

export function StartPage({ s }: { s: AppState }) {
  usePageChrome({ shortFooter: true, headerExternal: false });
  const title = usePageFocus('start');
  const [deal] = useState(() => {
    const first = !dealt;
    dealt = true;
    return first;
  });
  return (
    <main id="main" class="start">
      <div class="start__text">
        <h1 ref={title} tabIndex={-1}>
          {t('start.h1')}
        </h1>
        <p class="start__lead">{t('start.lead')}</p>
      </div>

      <div class="start__art" aria-hidden="true">
        <div class={`start__stage${deal ? ' is-dealing' : ''}`}>
          <Medallion class="medallion start__tile" />
          <div class="start__fan">
            {HAND.map((c) => (
              <span key={c.card} class="start__card">
                <Card card={c.card} manilha={c.manilha} />
              </span>
            ))}
          </div>
        </div>
      </div>

      <div class="start__actions">
        <Link to={{ name: 'play' }} class="btn btn--primary start__play" testid="home-play">
          <Icon name="play" />
          <span>{t('start.play')}</span>
        </Link>
        <div class="start__out">
          <ExternalLink href={SOURCE_URL} class="btn btn--outline start__ext" testid="home-source">
            <Icon name="code" />
            <span>{t('link.source')}</span>
            <Icon name="arrow" />
          </ExternalLink>
          <ExternalLink href={portfolioUrl(s.lang)} class="btn btn--outline start__ext" testid="home-portfolio">
            <Icon name="portfolio" />
            <span>{t('link.portfolio')}</span>
            <Icon name="arrow" />
          </ExternalLink>
        </div>
      </div>
    </main>
  );
}
