// The age gate and the notice before the first match (see consent.ts for when they appear), in the
// modal look of the site (styles/dialogs.css): a title bar, the body, and the buttons at the foot.
// The notice gains an ads row only when /api/config reports ads on (CLIENT-SPEC 16.6).

import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type SiteConfig } from '../api.ts';
import { acceptNotice, answerAge, closeGate } from '../consent.ts';
import { ageVerdict } from '../consent-keys.ts';
import { t, type Key } from '../i18n.ts';
import type { AppState } from '../store.ts';
import { Dialog, ExternalLink, Link } from './common.tsx';
import { openRules } from '../actions.ts';
import { pathFor } from '../routes.ts';
import '../styles/dialogs.css';

/** Birth years offered: this year down to 100 years ago, newest first. No default. */
function yearList(thisYear: number): number[] {
  return Array.from({ length: 101 }, (_, i) => thisYear - i);
}

export function AgeGate({ s }: { s: AppState }) {
  const open = s.gate === 'age' || s.gate === 'under';
  const asking = s.gate === 'age';
  const [year, setYear] = useState('');
  const [birthday, setBirthday] = useState<'' | 'yes' | 'no'>('');
  const [error, setError] = useState<Key | null>(null);
  const underTitle = useRef<HTMLHeadingElement>(null);
  const thisYear = new Date().getFullYear();

  useEffect(() => {
    if (!asking) return;
    setYear('');
    setBirthday('');
    setError(null);
  }, [asking]);

  useEffect(() => {
    if (s.gate === 'under') underTitle.current?.focus();
  }, [s.gate]);

  const needsBirthday = year !== '' && ageVerdict(Number(year), null, thisYear) === 'ask';

  const submit = (e: Event) => {
    e.preventDefault();
    if (!year) {
      setError('gate.pickYear');
      return;
    }
    const v = ageVerdict(Number(year), birthday === '' ? null : birthday === 'yes', thisYear);
    if (v === 'ask') {
      setError('gate.pickBirthday');
      return;
    }
    setError(null);
    answerAge(v === 'adult');
  };

  return (
    <Dialog open={open} onClose={closeGate} labelledBy={asking ? 'age-title' : 'age-under-title'} class="dialog dialog--framed gate" testid="age-gate">
      {asking ? (
        <form class="gate__form" onSubmit={submit} noValidate>
          <div class="dialog__top">
            <h2 id="age-title">{t('legal.age.title')}</h2>
          </div>
          <div class="dialog__body">
            <label class="field gate__year" for="age-year">
              <span>{t('legal.age.question')}</span>
              <select
                id="age-year"
                data-testid="age-year"
                value={year}
                aria-describedby="age-note"
                aria-invalid={error === 'gate.pickYear'}
                onChange={(e) => {
                  setYear(e.currentTarget.value);
                  setBirthday('');
                  setError(null);
                }}
              >
                <option value="">{t('legal.age.yearPlaceholder')}</option>
                {yearList(thisYear).map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            {needsBirthday ? (
              <fieldset class="gate__birthday" data-testid="age-birthday">
                <legend>{t('legal.age.birthday.question')}</legend>
                <label class="check-field">
                  <input type="radio" name="age-birthday" value="yes" data-testid="age-birthday-yes" checked={birthday === 'yes'} onChange={() => setBirthday('yes')} />
                  <span>{t('legal.age.birthday.yes')}</span>
                </label>
                <label class="check-field">
                  <input type="radio" name="age-birthday" value="no" data-testid="age-birthday-no" checked={birthday === 'no'} onChange={() => setBirthday('no')} />
                  <span>{t('legal.age.birthday.no')}</span>
                </label>
              </fieldset>
            ) : null}
            <p id="age-note" class="dialog__note">
              {t('legal.age.note')}
            </p>
            {error ? (
              <p class="error" role="alert" data-testid="age-error">
                {t(error)}
              </p>
            ) : null}
          </div>
          <div class="dialog__foot">
            <button type="button" class="btn btn--quiet" onClick={closeGate}>
              {t('common.cancel')}
            </button>
            <button type="submit" class="btn btn--primary" data-testid="age-continue">
              {t('legal.age.continue')}
            </button>
          </div>
        </form>
      ) : (
        <div class="gate__under" data-testid="age-under">
          <div class="dialog__top">
            <h2 id="age-under-title" ref={underTitle} tabIndex={-1}>
              {t('legal.age.under.title')}
            </h2>
          </div>
          <div class="dialog__body">
            <p>{t('legal.age.under.text')}</p>
            <p class="dialog__note">{t('legal.age.under.private')}</p>
            <ul class="dialog__links">
              <li>
                <button
                  type="button"
                  class="dialog__link"
                  data-testid="age-under-rules"
                  onClick={() => {
                    closeGate();
                    openRules();
                  }}
                >
                  {t('legal.age.under.goRules')}
                </button>
              </li>
              <li>
                {/* TODO(M7): point this link to the public data page when it ships; until then the privacy page explains the data. */}
                <Link to={{ name: 'privacy' }} class="dialog__link" testid="age-under-data" onNavigate={closeGate}>
                  {t('legal.age.under.goData')}
                </Link>
              </li>
            </ul>
          </div>
          <div class="dialog__foot">
            <button type="button" class="btn" data-testid="age-under-close" onClick={closeGate}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

const NOTICE_ROWS = ['who', 'what', 'why', 'keep', 'rights', 'contact', 'share', 'where', 'age'] as const;
type NoticeRow = (typeof NOTICE_ROWS)[number] | 'ads';

/** True when /api/config says ads are on (its `ads` field is an object; null or missing means off). */
function adsOn(c: SiteConfig): boolean {
  const ads = (c as SiteConfig & { ads?: unknown }).ads;
  return typeof ads === 'object' && ads !== null;
}

export function NoticeDialog({ s }: { s: AppState }) {
  const open = s.gate === 'notice';
  const [contact, setContact] = useState<string | null | undefined>(undefined);
  const [ads, setAds] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    title.current?.focus();
    let live = true;
    api.config().then(
      (c) => {
        if (!live) return;
        setContact(c.privacyContact);
        setAds(adsOn(c));
      },
      () => live && setContact(null),
    );
    return () => {
      live = false;
    };
  }, [open]);

  const rowText = (row: NoticeRow): string => {
    if (row === 'ads') return t('legal.notice.ads.text');
    if (row !== 'contact') return t(`legal.notice.${row}.text`);
    if (contact === undefined) return '';
    return contact ? t('legal.notice.contact.ifContact', { contact }) : t('legal.notice.contact.ifNoContact');
  };

  const rows: NoticeRow[] = ads ? [...NOTICE_ROWS, 'ads'] : [...NOTICE_ROWS];

  return (
    <Dialog open={open} onClose={closeGate} labelledBy="notice-title" class="dialog dialog--framed notice" testid="notice-dialog">
      <div class="dialog__top">
        <h2 id="notice-title" ref={title} tabIndex={-1}>
          {t('legal.notice.title')}
        </h2>
      </div>
      <div class="dialog__body">
        <p>{t('legal.notice.lede')}</p>
        <dl class="notice__list">
          {rows.map((row) => (
            <div key={row} class="notice__row" data-row={row}>
              <dt>{t(`legal.notice.${row}.label`)}</dt>
              <dd aria-live={row === 'contact' ? 'polite' : undefined}>{rowText(row)}</dd>
            </div>
          ))}
        </dl>
        <p>{t('legal.notice.more')}</p>
        <p class="dialog__links dialog__links--inline">
          <ExternalLink href={pathFor({ name: 'privacy' }, s.lang)} class="dialog__link" testid="notice-privacy">
            {t('legal.notice.goPrivacy')}
          </ExternalLink>
          <ExternalLink href={pathFor({ name: 'terms' }, s.lang)} class="dialog__link" testid="notice-terms">
            {t('legal.notice.goTerms')}
          </ExternalLink>
        </p>
      </div>
      <div class="dialog__foot dialog__foot--line">
        <button type="button" class="btn btn--primary" data-testid="notice-ok" onClick={acceptNotice}>
          {t('legal.notice.ok')}
        </button>
      </div>
    </Dialog>
  );
}
