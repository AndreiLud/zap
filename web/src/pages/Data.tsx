// The data page (/dados, /en/data; DATA-SPEC 4). This route module waits for the data area of the
// locales (i18n.ts loadData, its own chunk per language) and then renders the page itself,
// web/src/data/DataPage.tsx. A language switch loads the other language's texts first.

import { useEffect, useState } from 'preact/hooks';
import { DataStory } from '../data/DataPage.tsx';
import { dataReady, loadData } from '../i18n.ts';
import type { AppState } from '../store.ts';

export function DataPage({ s }: { s: AppState }) {
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
  if (!ready) return <main id="main" class="page loading" aria-busy="true" data-testid="page-data" />;
  return <DataStory s={s} />;
}
