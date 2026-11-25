// The room's lobby and the "Denunciar" dialog load on demand (M15 spec 6.2): only rooms with friends
// use them, so they stay out of the entry chunk every page loads. This module is in the entry; the
// lobby starts loading with a room address (main.tsx) and on the Play page's idle prefetch.

import { ConnStatus } from './components/common.tsx';
import { t } from './i18n.ts';
import { lazyComponent } from './lazy.tsx';
import type { AppState } from './store.ts';

/** While the room's code (the lobby or the table) loads: the room's name and the connection badge. */
export function RoomLoading({ s }: { s: AppState }) {
  return (
    <main id="main" class="page loading" aria-busy="true">
      <h1>{s.route.name === 'room' ? t('room.loading', { code: s.route.code ?? '' }) : ''}</h1>
      <ConnStatus s={s} />
    </main>
  );
}

export const Lobby = lazyComponent(() => import('./pages/Lobby.tsx').then((m) => m.Lobby), RoomLoading);

/** The table's "Denunciar": its dialog loads with the lobby or on demand, never inside the table chunk. */
export const ReportButton = lazyComponent<{ s: AppState }>(() => import('./components/Report.tsx').then((m) => m.ReportButton));
