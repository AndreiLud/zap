// Footer of every page (CLIENT-SPEC 9.5): Privacy, Terms, How we verify and You, then Source code
// and Portfolio. The Start page asks for the short footer (chrome.ts), because the code
// and the portfolio are its own buttons. On a table the footer sits below the stage.

import { useChrome } from '../chrome.ts';
import { t } from '../i18n.ts';
import type { AppState } from '../store.ts';
import { Link } from './common.tsx';
import { externalLinks } from './SiteNav.tsx';

export function Footer({ s }: { s: AppState }) {
  const { chrome } = useChrome();
  return (
    <footer class="site-footer" data-testid="site-footer">
      <nav aria-label={t('shell.nav.footer')}>
        <ul class="site-footer__links">
          <li>
            <Link to={{ name: 'privacy' }} testid="footer-privacy">
              {t('shell.nav.privacy')}
            </Link>
          </li>
          <li>
            <Link to={{ name: 'terms' }} testid="footer-terms">
              {t('shell.nav.terms')}
            </Link>
          </li>
          <li>
            <Link to={{ name: 'verify' }} testid="footer-verify">
              {t('shell.nav.verify')}
            </Link>
          </li>
          <li>
            <Link to={{ name: 'you' }} testid="footer-you">
              {t('shell.nav.you')}
            </Link>
          </li>
        </ul>
      </nav>
      {chrome.shortFooter ? null : <p class="site-footer__ext">{externalLinks(s, { class: 'link-ext' })}</p>}
    </footer>
  );
}
