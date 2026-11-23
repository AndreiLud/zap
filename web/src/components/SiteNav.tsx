// The site navigation, #site-nav (CLIENT-SPEC 9.1 and 9.2). Exactly one exists at any time: the
// header renders it inline from 64em, the menu sheet renders it below 64em while open.

import { openRules } from '../actions.ts';
import { t, type Key } from '../i18n.ts';
import type { RouteName } from '../routes.ts';
import type { AppState } from '../store.ts';
import { ExternalLink, Link, SOURCE_URL, portfolioUrl } from './common.tsx';
import { Icon, type IconName } from './icons.tsx';
import { closeSheet } from './Sheet.tsx';

type NavRoute = 'start' | 'play' | 'rules' | 'data' | 'you';

const PAGES: { name: NavRoute; key: Key; icon: IconName; testid?: string }[] = [
  { name: 'start', key: 'shell.nav.home', icon: 'home' },
  { name: 'play', key: 'shell.nav.play', icon: 'play' },
  { name: 'rules', key: 'shell.nav.rules', icon: 'book', testid: 'rules-button' },
  { name: 'data', key: 'shell.nav.data', icon: 'data' },
  { name: 'you', key: 'shell.nav.you', icon: 'user', testid: 'link-you' },
];

const QUIET: { name: 'privacy' | 'terms' | 'verify'; key: Key }[] = [
  { name: 'privacy', key: 'shell.nav.privacy' },
  { name: 'terms', key: 'shell.nav.terms' },
  { name: 'verify', key: 'shell.nav.verify' },
];

/** Routes that sit inside the "Jogar" section: its link reads as current there. */
const IN_PLAY: readonly RouteName[] = ['room', 'guided'];

/** On a table (a room or the guided match), "Regras" opens the quick rules dialog instead of leaving. */
export function rulesOpensDialog(route: RouteName): boolean {
  return route === 'room' || route === 'guided';
}

function current(page: RouteName, route: RouteName): 'page' | 'true' | undefined {
  if (page === route) return 'page';
  if (page === 'play' && IN_PLAY.includes(route)) return 'true';
  return undefined;
}

/**
 * Código-fonte and Portfólio: icon, text, the small arrow and the hidden "(opens in a new tab)", in a
 * new tab with rel="noopener" (the match stays connected). `testids` only where the one instance of
 * link-source and link-portfolio lives (the header from 64em, the sheet below).
 */
export function externalLinks(s: AppState, o: { class?: string; testids?: boolean } = {}) {
  return [
    <ExternalLink key="source" href={SOURCE_URL} class={o.class} testid={o.testids ? 'link-source' : undefined}>
      <Icon name="code" />
      <span>{t('link.source')}</span>
      <Icon name="arrow" />
    </ExternalLink>,
    <ExternalLink key="portfolio" href={portfolioUrl(s.lang)} class={o.class} testid={o.testids ? 'link-portfolio' : undefined}>
      <Icon name="portfolio" />
      <span>{t('link.portfolio')}</span>
      <Icon name="arrow" />
    </ExternalLink>,
  ];
}

export function SiteNav({ s, inSheet }: { s: AppState; inSheet: boolean }) {
  const route = s.route.name;
  // A same-tab link closes the sheet before navigating; the new page's title takes the focus.
  const leaveSheet = inSheet ? () => closeSheet(undefined, false) : undefined;
  const items = PAGES.map((p) => {
    const label = (
      <>
        {inSheet ? <Icon name={p.icon} /> : null}
        <span>{t(p.key)}</span>
      </>
    );
    if (p.name === 'rules' && rulesOpensDialog(route)) {
      return (
        <li key={p.name}>
          <button type="button" data-testid={p.testid} aria-keyshortcuts="R" onClick={() => (inSheet ? closeSheet(openRules) : openRules())}>
            {label}
            <kbd class="kbd-only" aria-hidden="true">
              R
            </kbd>
          </button>
        </li>
      );
    }
    return (
      <li key={p.name}>
        <Link to={{ name: p.name }} testid={p.testid} current={current(p.name, route)} onNavigate={leaveSheet}>
          {label}
        </Link>
      </li>
    );
  });
  if (!inSheet) {
    return (
      <nav id="site-nav" class="site-header__nav" aria-label={t('shell.nav.pages')}>
        <ul>{items}</ul>
      </nav>
    );
  }
  return (
    <nav id="site-nav" class="sheet__nav" aria-label={t('shell.nav.pages')}>
      <ul class="sheet__list">{items}</ul>
      <ul class="sheet__list">
        {externalLinks(s, { testids: true }).map((a) => (
          <li key={String(a.key)}>{a}</li>
        ))}
      </ul>
      <ul class="sheet__list sheet__list--quiet">
        {QUIET.map((q) => (
          <li key={q.name}>
            <Link to={{ name: q.name }} current={current(q.name, route)} onNavigate={leaveSheet}>
              {t(q.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
