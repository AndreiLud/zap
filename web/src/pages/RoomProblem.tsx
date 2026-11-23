// A room that cannot open or stopped (CLIENT-SPEC 10.4): a short reading page in the cover style of
// the other reading pages, one paragraph, then "Tentar de novo" (when trying again can help) and
// "Pick another table", which goes to the Play page. It stays in the entry chunk: a room that
// lost the network must still be able to say so.

import { currentRoom, goPlay } from '../actions.ts';
import { t, type Key } from '../i18n.ts';
import type { AppState, RoomProblem } from '../store.ts';
import { TileStrip } from './Doc.tsx';

const PROBLEMS: Record<RoomProblem, { title: Key; text: Key; retry: boolean }> = {
  not_found: { title: 'problem.not_found.title', text: 'problem.not_found.text', retry: false },
  started: { title: 'problem.started.title', text: 'problem.started.text', retry: true },
  full: { title: 'problem.full.title', text: 'problem.full.text', retry: true },
  check: { title: 'problem.check.title', text: 'problem.check.text', retry: true },
  blocked: { title: 'problem.blocked.title', text: 'problem.blocked.text', retry: false },
  expired: { title: 'problem.expired.title', text: 'problem.expired.text', retry: false },
  gone: { title: 'problem.gone.title', text: 'problem.gone.text', retry: true },
  network: { title: 'problem.network.title', text: 'problem.network.text', retry: true },
  replaced: { title: 'problem.replaced.title', text: 'problem.replaced.text', retry: true },
  closed: { title: 'problem.closed.title', text: 'problem.closed.text', retry: false },
  forgotten: { title: 'problem.forgotten.title', text: 'problem.forgotten.text', retry: false },
  age: { title: 'legal.age.under.title', text: 'legal.age.under.text', retry: true },
  gate: { title: 'problem.gate.title', text: 'problem.gate.text', retry: true },
};

export function RoomProblemPage({ problem }: { s: AppState; problem: RoomProblem }) {
  const p = PROBLEMS[problem];
  return (
    <main id="main" class="page doc room-problem" data-testid="room-problem" data-problem={problem}>
      <header class="doc__cover">
        <h1>{t(p.title)}</h1>
        <p class="doc__lede">{t(p.text)}</p>
        <TileStrip seed={2026} />
      </header>
      <p class="doc__cta">
        {p.retry ? (
          <button type="button" class="btn btn--primary" onClick={() => currentRoom()?.retry()}>
            {t('common.retry')}
          </button>
        ) : null}
        <button type="button" class={p.retry ? 'btn doc__cta-quiet' : 'btn btn--primary'} onClick={goPlay}>
          {t('board.other')}
        </button>
      </p>
    </main>
  );
}
