// The ads consent dialog (CLIENT-SPEC 16.3): shown once per notice version, only when ads are on
// (its chunk loads only then). Only ads that are not personalized, for everyone; saying no costs
// nothing, the game is the same. Esc counts as no. Both buttons look alike: refusing is as easy as
// accepting.

import { useEffect, useRef } from 'preact/hooks';
import { t } from '../i18n.ts';
import '../styles/ads.css';

export function AdsConsent({ onAnswer }: { onAnswer: (answer: 'yes' | 'no') => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const answer = (a: 'yes' | 'no') => {
    ref.current?.close();
    onAnswer(a);
  };
  return (
    <dialog
      ref={ref}
      class="modal ads-consent"
      data-testid="ads-consent"
      aria-labelledby="ads-consent-title"
      aria-describedby="ads-consent-text"
      onCancel={(e) => {
        e.preventDefault();
        answer('no');
      }}
    >
      <div class="modal__top">
        <h2 id="ads-consent-title">{t('ads.title')}</h2>
      </div>
      <div class="modal__body">
        <p id="ads-consent-text" class="ads-consent__text">
          {t('ads.text')}
        </p>
        <div class="button-row ads-consent__actions">
          <button type="button" class="btn btn--outline" data-testid="ads-refuse" onClick={() => answer('no')}>
            {t('ads.refuse')}
          </button>
          <button type="button" class="btn btn--outline" data-testid="ads-accept" onClick={() => answer('yes')}>
            {t('ads.accept')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
