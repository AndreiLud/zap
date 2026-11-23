// Any address the site does not have (CLIENT-SPEC 10.9). The app sets noindex at runtime here; the
// static fallback serves index.html with status 200, so this page is what the person sees.

import { Link } from '../components/common.tsx';
import { t } from '../i18n.ts';
import type { AppState } from '../store.ts';
import { usePageFocus } from '../page-focus.ts';

export function NotFoundPage(_: { s: AppState }) {
  const ref = usePageFocus('not-found');
  return (
    <main id="main" class="page not-found" data-testid="page-not-found">
      <h1 ref={ref} tabIndex={-1}>
        {t('shell.notFound.title')}
      </h1>
      <p>{t('shell.notFound.text')}</p>
      <p>
        <Link to={{ name: 'start' }} class="btn btn--primary">
          {t('shell.notFound.home')}
        </Link>
      </p>
    </main>
  );
}
