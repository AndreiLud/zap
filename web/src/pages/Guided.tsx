// The guided first match (/jogar/guiada, /en/play/guided; CLIENT-SPEC 10.5): one practice hand on
// the real engine, in the browser, explained step by step. The page owns a LocalController (set as
// the table's controller while it is mounted) and renders the same table as a room. Nothing of this
// hand reaches the server, so there is no age gate and no human check.
//
// The coach card, the suggested card and the table's title go to the table through guided/slot.ts;
// the table places them (CLIENT-SPEC 10.5), so the coach exists once in the page.

import '../styles/guided.css';
import { useEffect, useMemo } from 'preact/hooks';
import { currentController } from '../controller.ts';
import { CoachCard, useLesson } from '../guided/Coach.tsx';
import { LocalController, guidedOptions } from '../guided/LocalController.ts';
import { GUIDED_CODE } from '../guided/constants.ts';
import { setTableExtras } from '../guided/slot.ts';
import { t } from '../i18n.ts';
import { sound } from '../sound/index.ts';
import type { AppState } from '../store.ts';
import { Table } from '../table/Table.tsx';

export function GuidedPage({ s }: { s: AppState }) {
  const ctl = useMemo(() => new LocalController(guidedOptions(location.search)), []);
  useLesson(ctl);

  useEffect(() => {
    ctl.mount();
    // The table never reports or calls the server here: its report button stays hidden (guided.css).
    document.documentElement.dataset.guided = '';
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      delete document.documentElement.dataset.guided;
      setTableExtras(null);
      ctl.dispose();
    };
  }, [ctl]);

  const renderCoach = useMemo(() => () => <CoachCard ctl={ctl} />, [ctl]);
  const suggest = ctl.phase === 'playing' ? ctl.coach.suggestion() : null;
  const slot = suggest !== null && s.view ? s.view.hand.indexOf(suggest) : -1;
  const suggestSlot = slot >= 0 ? slot : null;

  useEffect(() => {
    setTableExtras({ title: 'guide.title', coach: renderCoach, suggestSlot, suggestTag: 'guide.suggest' });
  });

  const ready = currentController() === ctl && s.view !== null && s.room?.room.code === GUIDED_CODE;
  return (
    <div class="guided" data-testid="page-guided">
      {ready ? (
        <Table s={s} />
      ) : (
        <main id="main" class="page loading" aria-busy="true">
          <h1>{t('guide.loading')}</h1>
        </main>
      )}
    </div>
  );
}
