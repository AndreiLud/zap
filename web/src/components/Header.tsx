// The site header (CLIENT-SPEC 9). Phone and tablet (below 64em): logo, PT/EN and the hamburger,
// which opens the menu sheet (Sheet.tsx). Desktop (from 64em): logo, the navigation inline
// (Início, Jogar, Regras, Dados, Você), Código-fonte and Portfólio, the four-color pill, the sound
// switch (the sheet holds it below 64em) and PT/EN.
// The header never imports page code: a page adds to it through chrome.ts.

import { useEffect } from 'preact/hooks';
import { setFourColor, setLang } from '../actions.ts';
import { useChrome } from '../chrome.ts';
import { BrandMark } from '../deck/tiles.tsx';
import { t } from '../i18n.ts';
import { DESKTOP, useMedia } from '../media.ts';
import { SoundToggle } from '../sound/SoundToggle.tsx';
import { store, type AppState } from '../store.ts';
import { Link } from './common.tsx';
import { Icon } from './icons.tsx';
import { MENU_BUTTON_ID, Sheet, closeSheet, openSheet } from './Sheet.tsx';
import { SiteNav, externalLinks } from './SiteNav.tsx';

export function Header({ s }: { s: AppState }) {
  const desktop = useMedia(DESKTOP);
  const { chrome } = useChrome();
  const other = s.lang === 'pt' ? 'en' : 'pt';

  // The sheet exists only below 64em: crossing the breakpoint closes it.
  useEffect(() => {
    if (desktop && store.get().menuOpen) closeSheet();
  }, [desktop]);

  return (
    <header class="site-header">
      <Link to={{ name: 'start' }} class="brand" ariaLabel={t('brand.home')}>
        <BrandMark />
        <b>Zap</b>
      </Link>
      {desktop ? <SiteNav s={s} inSheet={false} /> : null}
      {desktop && chrome.headerExternal ? <div class="site-header__ext">{externalLinks(s, { class: 'link-ext', testids: true })}</div> : null}
      {desktop ? (
        <button
          type="button"
          class="four-color-toggle"
          data-testid="four-color-toggle"
          aria-pressed={s.fourColor}
          title={t('shell.fourColor')}
          onClick={() => setFourColor(!s.fourColor)}
        >
          <Icon name="four-color" />
          <span class="four-color-toggle__label">{t('shell.fourColor.short')}</span>
        </button>
      ) : null}
      {desktop ? <SoundToggle on={s.soundOn} /> : null}
      <button type="button" class="lang-switch" data-testid="lang-switch" aria-label={t('lang.switch')} onClick={() => setLang(other)}>
        <span class={s.lang === 'pt' ? 'is-current' : undefined}>PT</span>
        <span class={s.lang === 'en' ? 'is-current' : undefined}>EN</span>
      </button>
      {desktop ? null : (
        <button
          type="button"
          id={MENU_BUTTON_ID}
          class="menu-button icon-button"
          data-testid="menu-button"
          aria-haspopup="dialog"
          aria-expanded={s.menuOpen}
          aria-controls="site-sheet"
          aria-label={t('menu.open')}
          onClick={() => (s.menuOpen ? closeSheet() : openSheet())}
        >
          <Icon name="menu" />
        </button>
      )}
      {desktop ? null : <Sheet s={s} />}
    </header>
  );
}
