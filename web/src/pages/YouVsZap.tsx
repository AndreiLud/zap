// "You against Zap" (/voce-contra-o-zap, /en/you-vs-zap; DATA-SPEC 5): the person's own numbers,
// computed on this device. This route module waits for the data area of the locales (i18n.ts
// loadData, its own chunk per language) and then renders web/src/you-vs-zap/YouVsZapPage.tsx.
// Never indexed (routes.ts INDEXED leaves it out).

import { useEffect, useState } from 'preact/hooks';
import { dataReady, loadData } from '../i18n.ts';
import type { AppState } from '../store.ts';
import { YouVsZap } from '../you-vs-zap/YouVsZapPage.tsx';

export function YouVsZapPage({ s }: { s: AppState }) {
  const [, loaded] = useState(0);
  const ready = dataReady(s.lang);
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadData(s.lang).then(
      () => live && loaded((n) => n + 1),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ready, s.lang]);
  if (!ready) return <main id="main" class="page loading" aria-busy="true" data-testid="page-vs" />;
  return <YouVsZap s={s} />;
}
