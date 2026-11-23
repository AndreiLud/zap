// "Denunciar" at the table and in the lobby: choose the seat and the reason. A nickname report
// hides that nickname at once for everyone at the table; a person reviews every report. The dialog
// uses the site's modal look (styles/dialogs.css). In the phone menu sheet the dialog opens over the
// sheet, which stays open behind it (table/Tools.tsx closes the sheet when the dialog closes).

import { useRef, useState } from 'preact/hooks';
import { ApiError, api, type ReportReason } from '../api.ts';
import { withCheck } from '../check.ts';
import { isGateStop } from '../consent.ts';
import { seatName, type Names } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import { currentRoom } from '../actions.ts';
import type { AppState } from '../store.ts';
import { Dialog } from './common.tsx';
import { Icon } from './icons.tsx';
import '../styles/dialogs.css';

const REASONS: ReportReason[] = ['nickname', 'phrases', 'cheating', 'other'];

export function ReportButton({ s }: { s: AppState }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={button} class="btn btn--quiet report-button" data-testid="report-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="report" />
        <span>{t('report.button')}</span>
      </button>
      <ReportDialog
        s={s}
        open={open}
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
      />
    </>
  );
}

function ReportDialog({ s, open, onClose }: { s: AppState; open: boolean; onClose(): void }) {
  const [seat, setSeat] = useState('');
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const r = s.room;
  if (!r) return null;
  const room = r.room;
  const you = r.you ?? -1;
  const names: Names = { you, players: room.settings.players, room, variant: room.settings.variant };
  const others = room.seats.filter((x) => x.kind !== 'empty' && x.seat !== you);

  const close = () => {
    setSeat('');
    setReason('');
    setError(null);
    onClose();
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (seat === '' || reason === '') {
      setError(seat === '' ? 'report.pickSeat' : 'report.pickReason');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await withCheck(() => api.report(room.code, Number(seat), reason));
      setBusy(false);
      close();
      currentRoom()?.notice('report.sent');
      return;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      if (!isGateStop(code)) setError(code === 'too_many' ? 'error.too_many' : 'report.failed');
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onClose={close} labelledBy="report-title" class="dialog dialog--framed report" testid="report-dialog">
      <form class="report__form" onSubmit={(e) => void submit(e)} noValidate>
        <div class="dialog__top">
          <h2 id="report-title">{t('report.title')}</h2>
        </div>
        <div class="dialog__body">
          <p>{t('report.text')}</p>
          {others.length === 0 ? (
            <p class="dialog__note">{t('report.nobody')}</p>
          ) : (
            <>
              <label class="field" for="report-seat">
                <span>{t('report.seat')}</span>
                <select id="report-seat" data-testid="report-seat" value={seat} aria-invalid={error === 'report.pickSeat'} onChange={(e) => setSeat(e.currentTarget.value)}>
                  <option value="">{t('report.seat')}</option>
                  {others.map((x) => (
                    <option key={x.seat} value={String(x.seat)}>
                      {t('report.seatOption', { name: seatName(names, x.seat), n: x.seat + 1 })}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field" for="report-reason">
                <span>{t('report.reason')}</span>
                <select
                  id="report-reason"
                  data-testid="report-reason"
                  value={reason}
                  aria-invalid={error === 'report.pickReason'}
                  onChange={(e) => setReason(e.currentTarget.value as ReportReason | '')}
                >
                  <option value="">{t('report.reason')}</option>
                  {REASONS.map((x) => (
                    <option key={x} value={x}>
                      {t(`report.reason.${x}`)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {error ? (
            <p class="error" role="alert" data-testid="report-error">
              {t(error)}
            </p>
          ) : null}
        </div>
        <div class="dialog__foot">
          <button type="button" class="btn btn--quiet" onClick={close}>
            {t('common.cancel')}
          </button>
          {others.length ? (
            <button type="submit" class="btn btn--primary" data-testid="report-submit" disabled={busy}>
              {t('report.submit')}
            </button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
