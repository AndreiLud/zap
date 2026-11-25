// The table's tools (CLIENT-SPEC 11.7): "Denunciar", "Silenciar frases e sinais dos outros" and "Sair
// da partida" (not after the match ended). From 64em they sit at the foot of the side panel; below
// 64em the table registers them as the menu sheet's group "This table". Only one instance exists at a
// time. The rules stay in the navigation (rules-button), never here. The report dialog loads on
// demand (room-chunks.tsx), so it never weighs on the table chunk.

import { useEffect, useRef } from 'preact/hooks';
import { Icon } from '../components/icons.tsx';
import { currentController } from '../controller.ts';
import { t } from '../i18n.ts';
import { ReportButton } from '../room-chunks.tsx';
import { MUTE_KEY, store, useStore } from '../store.ts';

/** Mutes the phrases and the signals of the other seats (remembered in this browser). */
export function setMuteOthers(on: boolean): void {
  store.set((st) => {
    const you = st.room?.you ?? -1;
    const bubbles = on ? Object.fromEntries(Object.entries(st.bubbles).filter(([seat]) => Number(seat) === you)) : st.bubbles;
    return { muteOthers: on, bubbles };
  });
  try {
    localStorage.setItem(MUTE_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/**
 * `close` is given in the menu sheet: leaving closes the sheet first; the report dialog opens over
 * the sheet and, when it closes, the sheet closes too and focus goes back to the menu button.
 */
export function Tools({ close }: { close?: (then?: () => void) => void }) {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  const ended = !s.view || s.view.over || s.room?.room.status === 'ended';
  const room = currentController()?.kind === 'room';

  useEffect(() => {
    if (!close) return;
    const onClose = (e: Event) => {
      const d = e.target as HTMLElement | null;
      if (d?.getAttribute?.('data-testid') === 'report-dialog' && box.current?.isConnected) close();
    };
    // The dialog's close event does not bubble: listen in the capture phase.
    document.addEventListener('close', onClose, true);
    return () => document.removeEventListener('close', onClose, true);
  }, [close]);

  return (
    <div class="table-tools" data-testid="table-tools" ref={box}>
      {room ? <ReportButton s={s} /> : null}
      <label class="switch table-tools__mute">
        <Icon name="mute" />
        <span>
          <b>{t('table.muteOthers')}</b>
        </span>
        <input type="checkbox" role="switch" data-testid="mute-others" checked={s.muteOthers} onChange={(e) => setMuteOthers(e.currentTarget.checked)} />
      </label>
      {ended ? null : (
        <button
          type="button"
          class="btn btn--quiet table-tools__leave"
          data-testid="leave-button"
          onClick={() => {
            if (close) close(() => currentController()?.leave());
            else currentController()?.leave();
          }}
        >
          <Icon name="leave" />
          <span>{t('table.leave')}</span>
        </button>
      )}
    </div>
  );
}
