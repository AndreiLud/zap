import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { cancelCheck, submitToken, widgetFailed } from '../check.ts';
import { t, type Key } from '../i18n.ts';
import { renderWidget } from '../turnstile.ts';
import type { AppState, CheckPurpose } from '../store.ts';
import { Dialog } from './common.tsx';

const CHECK_TEXT: Record<CheckPurpose, Key> = {
  play: 'check.text',
  delete: 'legal.you.delete.check',
  recover: 'legal.you.recover.check',
};

/**
 * The human check: Turnstile inside a dialog. For play, the action that asked for it runs again
 * after; for delete and recover, the fresh token goes with that one request.
 */
export function HumanCheck({ s }: { s: AppState }) {
  const box = useRef<HTMLDivElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const open = s.check.open;
  const purpose = s.check.purpose;

  useEffect(() => {
    if (!open) return;
    setLoadFailed(false);
    let cancelled = false;
    let widget: { remove(): void; reset(): void } | null = null;
    (async () => {
      try {
        const cfg = await api.config();
        if (cancelled || !box.current) return;
        const w = await renderWidget(box.current, cfg.turnstileSiteKey, s.lang === 'en' ? 'en' : 'pt-br', purpose, {
          onToken: (token) => {
            void submitToken(token).then((ok) => {
              if (!ok) widget?.reset();
            });
          },
          onError: () => widgetFailed(),
        });
        if (cancelled) w.remove();
        else widget = w;
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      widget?.remove();
    };
  }, [open, purpose]);

  return (
    <Dialog open={open} onClose={cancelCheck} labelledBy="check-title" class="dialog check">
      <h2 id="check-title">{t('check.title')}</h2>
      <p>{t(CHECK_TEXT[purpose])}</p>
      <div ref={box} class="turnstile" data-testid="turnstile" />
      {s.check.failed ? (
        <p class="error" role="alert">
          {t('check.failed')}
        </p>
      ) : null}
      {loadFailed ? (
        <p class="error" role="alert">
          {t('check.loadFailed')}
        </p>
      ) : null}
      <div class="dialog-actions">
        <button type="button" class="btn btn--quiet" onClick={cancelCheck}>
          {t('common.cancel')}
        </button>
      </div>
    </Dialog>
  );
}
