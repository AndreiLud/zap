// P6, the person's data (DATA-SPEC 5.7): links to the download and the deletion on the You page (/voce)
// (its sections #baixar and #apagar), and the button that forgets the copies this page keeps on
// the device (records-cache.ts).

import { useState } from 'preact/hooks';
import { navigate, urlFor } from '../../actions.ts';
import { t } from '../../i18n.ts';

function YouLink({ hash, children, testid }: { hash: string; children: string; testid: string }) {
  return (
    <a
      href={`${urlFor({ name: 'you' })}${hash}`}
      data-testid={testid}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate({ name: 'you' }, { hash });
      }}
    >
      {children}
    </a>
  );
}

export function YourData({ onForget }: { onForget(): Promise<boolean> }) {
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onForget();
    setMsg({ text: t(ok ? 'data.vs.forgotten' : 'data.vs.forgetFailed'), error: !ok });
    setBusy(false);
  };
  return (
    <section id="vs-dados" class="doc__section vs-part" aria-labelledby="vs-dados-t" data-testid="vs-data">
      <h2 id="vs-dados-t">{t('data.vs.p6.title')}</h2>
      <ul class="vs-links">
        <li class="doc__go">
          <YouLink hash="#baixar" testid="vs-download">
            {t('data.vs.p6.download')}
          </YouLink>
        </li>
        <li class="doc__go">
          <YouLink hash="#apagar" testid="vs-delete">
            {t('data.vs.p6.delete')}
          </YouLink>
        </li>
      </ul>
      <p>{t('data.vs.p6.note')}</p>
      <div class="button-row">
        <button type="button" class="btn" data-testid="vs-forget" disabled={busy} onClick={() => void forget()}>
          {t('data.vs.forget')}
        </button>
      </div>
      <div class="doc__status">
        <p class="quiet" role="status">
          {msg && !msg.error ? msg.text : ''}
        </p>
        {msg?.error ? (
          <p class="error" role="alert">
            {msg.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
