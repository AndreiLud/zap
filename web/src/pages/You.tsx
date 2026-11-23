// The You page (/voce): what the server keeps about this browser, the match history, how Zap reads the
// person's style ("How Zap reads you"), the nickname, the two switches, the download, the deletion
// and the recovery code. Reading page look (pages/Doc.tsx, styles/page.css): a cover, then
// sections with thin rules; boxes only around what you can touch.
//
// Nothing here reaches the server before the age gate. A browser that never played sees only the
// empty state and "Recuperar em outro aparelho".

import { useEffect, useRef, useState } from 'preact/hooks';
import { forgetLocal } from '../actions.ts';
import { ApiError, api, type MyData, type Prefs, type Reading } from '../api.ts';
import { noteVerifiedUntil, requestToken, withCheck } from '../check.ts';
import { Dialog, Link } from '../components/common.tsx';
import { ensureAdult, isAdult, isGateStop } from '../consent.ts';
import { t, type Key, type Lang } from '../i18n.ts';
import { cleanRecoveryCode, collectMyData, saveJson } from '../my-data.ts';
import { forgetRecords } from '../you-vs-zap/records-cache.ts';
import type { AppState } from '../store.ts';
import { TileStrip } from './Doc.tsx';
import { usePageFocus, usePrivacyContact } from './Legal.tsx';

type View = { k: 'gate' } | { k: 'loading' } | { k: 'failed' } | { k: 'empty' } | { k: 'ready'; data: MyData };

/** A short message after an action: read aloud by screen readers (status), errors as alerts. */
type Msg = { text: string; error: boolean } | null;

function codeOf(e: unknown): string {
  return e instanceof ApiError ? e.code : 'network';
}

function errorKey(code: string, fallback: Key): Key {
  if (code === 'too_many') return 'error.too_many';
  if (code === 'network') return 'error.network';
  if (code === 'check_failed') return 'check.failed';
  return fallback;
}

function Status({ msg, testid }: { msg: Msg; testid: string }) {
  // One live region that is always there for progress and success; errors come as an alert.
  return (
    <div class="doc__status" data-testid={testid}>
      <p class="quiet" role="status">
        {msg && !msg.error ? msg.text : ''}
      </p>
      {msg?.error ? (
        <p class="error" role="alert">
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}

function dateText(ms: number | null, lang: Lang): string {
  if (ms === null || !Number.isFinite(ms)) return t('legal.you.stored.never');
  return new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

const KINDS = ['solo2', 'solo1', 'friends', 'humans', 'mixed'] as const;

function kindText(kind: string): string {
  return (KINDS as readonly string[]).includes(kind) ? t(`legal.you.matches.kind.${kind as (typeof KINDS)[number]}`) : kind;
}

// -------------------------------------------------------------------------------------------------

function Stored({ data, lang, contact }: { data: MyData; lang: Lang; contact: string | null | undefined }) {
  const d = data.device;
  return (
    <section class="doc__section" aria-labelledby="you-stored-title" data-testid="you-stored">
      <h2 id="you-stored-title">{t('legal.you.stored.title')}</h2>
      <dl class="doc__facts">
        <div>
          <dt>{t('legal.you.stored.pseudonym')}</dt>
          <dd>
            <code data-testid="you-pseudonym">{data.pseudonym ?? ''}</code>
            <span class="hint">{t('legal.you.stored.pseudonymHelp')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.since')}</dt>
          <dd>{dateText(d.createdAt, lang)}</dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.lastSeen')}</dt>
          <dd>{dateText(d.lastSeen, lang)}</dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.adult')}</dt>
          <dd>{dateText(d.adultAt, lang)}</dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.verified')}</dt>
          <dd>{dateText(d.verifiedAt, lang)}</dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.abandons')}</dt>
          <dd>{d.abandons}</dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.reports')}</dt>
          <dd data-testid="you-reports-made">{data.reportsMade.length || t('legal.you.stored.none')}</dd>
        </div>
        <div>
          <dt>{t('legal.you.stored.flags')}</dt>
          <dd>
            {data.flags.length === 0 ? (
              t('legal.you.stored.flagsNone')
            ) : (
              <>
                <ul class="doc__list">
                  {data.flags.map((f, i) => (
                    <li key={i}>
                      {dateText(f.createdAt, lang)}: {f.reviewedAt === null ? t('legal.you.stored.flagOpen') : t('legal.you.stored.flagReviewed', { date: dateText(f.reviewedAt, lang) })}
                    </li>
                  ))}
                </ul>
                <span class="hint">{t('legal.you.stored.flagHelp')}</span>
                {contact ? <span class="hint">{t('legal.you.stored.flagReview.ifContact', { contact })}</span> : null}
                {contact === null ? <span class="hint">{t('legal.you.stored.flagReview.ifNoContact')}</span> : null}
              </>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Matches({ data, lang }: { data: MyData; lang: Lang }) {
  return (
    <section class="doc__section" aria-labelledby="you-matches-title">
      <h2 id="you-matches-title">{t('legal.you.matches.title')}</h2>
      <p class="doc__go">
        <Link to={{ name: 'vs' }} testid="you-vs-link">
          {t('shell.link.vs')}
        </Link>
      </p>
      {data.matches.length === 0 ? (
        <p class="quiet" data-testid="you-matches-empty">
          {t('legal.you.matches.empty')}
        </p>
      ) : (
        <div class="doc__table-scroll">
          <table class="doc__table" data-testid="you-matches">
            <thead>
              <tr>
                <th scope="col">{t('legal.you.matches.colDate')}</th>
                <th scope="col">{t('legal.you.matches.colKind')}</th>
                <th scope="col">{t('legal.you.matches.colSeat')}</th>
              </tr>
            </thead>
            <tbody>
              {data.matches.map((m) => (
                <tr key={m.matchId} data-testid="you-match-row" data-match-id={m.matchId} data-seat={String(m.seat)}>
                  <td>{dateText(m.endedAt, lang)}</td>
                  <td>{kindText(m.kind)}</td>
                  <td>{t('legal.you.matches.seat', { n: m.seat + 1 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A share as a whole percent ("45%"), or a strength from 0 to 100 for the cards shown after calling. */
function shareText(key: Reading['numbers'][number]['key'], x: number, lang: Lang): string {
  const n = Math.round(x * 100);
  return key === 'shown' ? t('reading.scale', { value: n }) : new Intl.NumberFormat(lang === 'en' ? 'en' : 'pt-BR', { style: 'percent' }).format(n / 100);
}

function secondsText(ms: number, lang: Lang): string {
  return `${new Intl.NumberFormat(lang === 'en' ? 'en' : 'pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ms / 1000)} s`;
}

type ReadingView = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; r: Reading };

/**
 * "How Zap reads you": the counters the server keeps about this person's style, each number shown
 * only once its 80% interval is narrower than 30 points (worker/src/reading.ts). Loads again when
 * a switch changed (`version`).
 */
function ReadingSection({ lang, version }: { lang: Lang; version: number }) {
  const [view, setView] = useState<ReadingView>({ k: 'loading' });

  const load = async () => {
    setView({ k: 'loading' });
    try {
      setView({ k: 'ready', r: await withCheck(() => api.reading()) });
    } catch {
      setView({ k: 'failed' });
    }
  };

  useEffect(() => {
    void load();
  }, [version]);

  const r = view.k === 'ready' ? view.r : null;
  // Each number names where its reference comes from: a number keeps the self-play value until
  // enough people have observations of it, even when other numbers already come from people.
  const reference = (x: Reading['numbers'][number]) =>
    t(x.source === 'people' ? 'reading.reference.people' : 'reading.reference.selfplay', { value: shareText(x.key, x.population, lang) });

  return (
    <section class="doc__section" aria-labelledby="you-reading-title" data-testid="you-reading" data-state={view.k}>
      <h2 id="you-reading-title">{t('reading.title')}</h2>
      <p>{t('reading.lede')}</p>
      {view.k === 'loading' ? <p class="quiet">{t('reading.loading')}</p> : null}
      {view.k === 'failed' ? (
        <>
          <p class="error" role="alert">
            {t('reading.failed')}
          </p>
          <div class="button-row">
            <button type="button" class="btn" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        </>
      ) : null}
      {r?.noAdapt ? <p data-testid="reading-off">{t('reading.off')}</p> : null}
      {r && !r.noAdapt ? (
        <>
          <p class="quiet" data-testid="reading-summary">
            {t('reading.summary', { matches: r.matches, decisions: r.decisions })}
          </p>
          <dl class="doc__facts">
            {r.numbers.map((x) => (
              <div key={x.key} data-testid={`reading-${x.key}`} data-shown={String(x.shown)}>
                <dt>{t(`reading.n.${x.key}`)}</dt>
                <dd>
                  <span>
                    {x.shown && x.value !== null && x.low !== null && x.high !== null
                      ? t('reading.value', { value: shareText(x.key, x.value, lang), low: shareText(x.key, x.low, lang), high: shareText(x.key, x.high, lang) })
                      : t('reading.hidden', { n: x.n })}
                  </span>
                  <span class="hint">{t(`reading.n.${x.key}.help`)}</span>
                  <span class="hint">{reference(x)}</span>
                </dd>
              </div>
            ))}
            <div data-testid="reading-time" data-shown={String(r.time.shown)}>
              <dt>{t('reading.time')}</dt>
              <dd>
                <span>
                  {r.time.shown && r.time.medianMs !== null && r.time.lowMs !== null && r.time.highMs !== null
                    ? t('reading.value', { value: secondsText(r.time.medianMs, lang), low: secondsText(r.time.lowMs, lang), high: secondsText(r.time.highMs, lang) })
                    : t('reading.hidden', { n: r.time.n })}
                </span>
                <span class="hint">{t('reading.time.help')}</span>
              </dd>
            </div>
          </dl>
          <p class="hint">{t('reading.rule')}</p>
          <p class="hint">{t('reading.use')}</p>
        </>
      ) : null}
    </section>
  );
}

function Nickname({ data }: { data: MyData }) {
  const [value, setValue] = useState(data.device.nickname ?? '');
  const [hidden, setHidden] = useState(data.device.nicknameHidden);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const save = async (nickname: string | null) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await withCheck(() => api.nickname(nickname));
      setValue(r.nickname ?? '');
      setHidden(r.nicknameHidden);
      setMsg({ text: t(r.nickname === null ? 'you.nicknameCleared' : 'legal.you.nickname.saved'), error: false });
    } catch (e) {
      const code = codeOf(e);
      if (!isGateStop(code)) setMsg({ text: t(code === 'bad_nickname' ? 'legal.you.nickname.bad' : errorKey(code, 'error.generic')), error: true });
    }
    setBusy(false);
  };

  return (
    <section class="doc__section" aria-labelledby="you-nickname-title">
      <h2 id="you-nickname-title">{t('legal.you.nickname.title')}</h2>
      <p class="hint" id="you-nickname-help">
        {t('legal.you.nickname.help')}
      </p>
      {hidden ? (
        <p class="doc__warn" data-testid="you-nickname-hidden">
          {t('legal.you.nickname.hidden')}
        </p>
      ) : null}
      <form
        class="doc__form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          void save(v === '' ? null : v);
        }}
      >
        <label class="field" for="you-nickname">
          <span>{t('legal.you.nickname.label')}</span>
          <input
            id="you-nickname"
            data-testid="nickname-input"
            value={value}
            maxLength={20}
            autocomplete="nickname"
            spellcheck={false}
            aria-describedby="you-nickname-help"
            onInput={(e) => setValue(e.currentTarget.value)}
          />
        </label>
        <div class="button-row">
          <button type="submit" class="btn" data-testid="nickname-save" disabled={busy}>
            {t('legal.you.nickname.save')}
          </button>
          {data.device.nickname !== null || value !== '' ? (
            <button type="button" class="btn btn--quiet" data-testid="nickname-clear" disabled={busy} onClick={() => void save(null)}>
              {t('legal.you.nickname.clear')}
            </button>
          ) : null}
        </div>
      </form>
      <Status msg={msg} testid="nickname-status" />
    </section>
  );
}

function PrefSwitches({ data, onSaved }: { data: MyData; onSaved(): void }) {
  const [prefs, setPrefs] = useState<Prefs>(data.device.prefs);
  const [msg, setMsg] = useState<Msg>(null);

  const change = async (patch: Partial<Prefs>) => {
    const before = prefs;
    setPrefs({ ...prefs, ...patch });
    setMsg(null);
    try {
      const r = await withCheck(() => api.prefs(patch));
      setPrefs(r.prefs);
      setMsg({ text: t('legal.you.prefs.saved'), error: false });
      onSaved();
    } catch (e) {
      setPrefs(before);
      const code = codeOf(e);
      if (!isGateStop(code)) setMsg({ text: t(errorKey(code, 'error.generic')), error: true });
    }
  };

  const item = (id: 'open-data' | 'no-adapt', key: keyof Prefs, label: Key, help: Key) => (
    <label class="switch doc__switch" for={`pref-${id}`}>
      <span>
        <b>{t(label)}</b>
        <small id={`pref-${id}-help`}>{t(help)}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        id={`pref-${id}`}
        data-testid={`pref-${id}`}
        checked={prefs[key]}
        aria-describedby={`pref-${id}-help`}
        onChange={(e) => void change({ [key]: e.currentTarget.checked })}
      />
    </label>
  );

  return (
    <section class="doc__section" aria-labelledby="you-prefs-title">
      <h2 id="you-prefs-title">{t('legal.you.prefs.title')}</h2>
      {item('open-data', 'openDataOptOut', 'legal.you.prefs.openData', 'legal.you.prefs.openDataHelp')}
      {item('no-adapt', 'noAdapt', 'legal.you.prefs.noAdapt', 'legal.you.prefs.noAdaptHelp')}
      <Status msg={msg} testid="prefs-status" />
    </section>
  );
}

function Download() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const file = await collectMyData((done, total) => setMsg({ text: t('legal.you.download.progress', { done, total }), error: false }));
      const day = new Date().toISOString().slice(0, 10);
      saveJson(file, `${t('you.fileName')}-${day}.json`);
      setMsg({ text: t('legal.you.download.done'), error: false });
    } catch (e) {
      const code = codeOf(e);
      setMsg(isGateStop(code) ? null : { text: t(errorKey(code, 'legal.you.download.failed')), error: true });
    }
    setBusy(false);
  };

  return (
    <section id="baixar" class="doc__section" aria-labelledby="you-download-title">
      <h2 id="you-download-title">{t('legal.you.download.title')}</h2>
      <p>{t('legal.you.download.text')}</p>
      <div class="button-row">
        <button type="button" class="btn" data-testid="you-download" disabled={busy} onClick={() => void run()}>
          {t('legal.you.download.button')}
        </button>
      </div>
      <Status msg={msg} testid="download-status" />
    </section>
  );
}

function RecoveryCode({ had }: { had: boolean }) {
  const [code, setCode] = useState<string | null>(null);
  const [exists, setExists] = useState(had);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const out = useRef<HTMLElement>(null);

  useEffect(() => {
    if (code) out.current?.focus();
  }, [code]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setCopied(false);
    try {
      const r = await withCheck(() => api.newRecoveryCode());
      setCode(r.code);
      setExists(true);
    } catch (e) {
      const code = codeOf(e);
      if (!isGateStop(code)) setMsg({ text: t(errorKey(code, 'error.generic')), error: true });
    }
    setBusy(false);
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section class="doc__section" aria-labelledby="you-recovery-title">
      <h2 id="you-recovery-title">{t('legal.you.recovery.title')}</h2>
      <p>{t('legal.you.recovery.text')}</p>
      {exists ? <p class="hint">{t('legal.you.recovery.replaces')}</p> : null}
      <div class="button-row">
        <button type="button" class="btn" data-testid="you-recovery-show" disabled={busy} onClick={() => void create()}>
          {t(exists ? 'legal.you.recovery.again' : 'legal.you.recovery.button')}
        </button>
      </div>
      {code ? (
        <div class="doc__box">
          <p class="doc__warn">{t('legal.you.recovery.once')}</p>
          <code class="doc__code" ref={out} tabIndex={-1} data-testid="you-recovery-code">
            {code}
          </code>
          <div class="button-row">
            <button type="button" class="btn" data-testid="you-recovery-copy" onClick={() => void copy()}>
              {copied ? t('legal.you.recovery.copied') : t('legal.you.recovery.copy')}
            </button>
          </div>
          <p class="sr-only" role="status">
            {copied ? t('legal.you.recovery.copied') : ''}
          </p>
        </div>
      ) : null}
      <Status msg={msg} testid="recovery-status" />
    </section>
  );
}

/** hasMatches: this browser has a history of its own, which joins the recovered one. */
function Recover({ hasMatches, onDone }: { hasMatches: boolean; onDone(): void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const code = cleanRecoveryCode(value);
    if (!code) {
      setMsg({ text: t('legal.you.recover.bad'), error: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // A fresh human check for this one action; no game credential is needed.
      const token = await requestToken('recover');
      const r = await api.recover(code, token);
      noteVerifiedUntil(r.verifiedUntil);
      setValue('');
      setMsg({ text: t('legal.you.recover.done'), error: false });
      onDone();
    } catch (err) {
      const c = codeOf(err);
      if (!isGateStop(c)) setMsg({ text: t(c === 'bad_code' ? 'legal.you.recover.bad' : errorKey(c, 'error.generic')), error: true });
    }
    setBusy(false);
  };

  return (
    <section class="doc__section" aria-labelledby="you-recover-title">
      <h2 id="you-recover-title">{t('legal.you.recover.title')}</h2>
      <p>{t('legal.you.recover.text')}</p>
      {hasMatches ? (
        <p class="hint" data-testid="recover-merge-note">
          {t('legal.you.recover.replaceWarn')}
        </p>
      ) : null}
      <form class="doc__form" onSubmit={(e) => void submit(e)}>
        <label class="field" for="you-recover">
          <span>{t('legal.you.recover.label')}</span>
          <input
            id="you-recover"
            data-testid="recover-input"
            value={value}
            maxLength={32}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            aria-describedby="you-recover-hint"
            onInput={(e) => setValue(e.currentTarget.value.toUpperCase())}
          />
        </label>
        <div class="button-row">
          <button type="submit" class="btn" data-testid="recover-submit" disabled={busy}>
            {t('legal.you.recover.button')}
          </button>
        </div>
        <p id="you-recover-hint" class="hint">
          {t('legal.you.recover.hint')}
        </p>
      </form>
      <Status msg={msg} testid="recover-status" />
    </section>
  );
}

function DeleteData({ onDeleted }: { onDeleted(): void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const button = useRef<HTMLButtonElement>(null);

  const run = async () => {
    setConfirm(false);
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const token = await requestToken('delete');
      await api.deleteMe(token);
      setBusy(false);
      onDeleted();
      return;
    } catch (e) {
      const code = codeOf(e);
      if (!isGateStop(code)) setMsg({ text: t(errorKey(code, 'legal.you.delete.failed')), error: true });
    }
    setBusy(false);
    button.current?.focus();
  };

  return (
    <section id="apagar" class="doc__section doc__section--danger" aria-labelledby="you-delete-title">
      <h2 id="you-delete-title">{t('legal.you.delete.title')}</h2>
      <p>{t('legal.you.delete.text')}</p>
      <p class="hint">{t('legal.you.delete.more')}</p>
      <div class="button-row">
        <button type="button" ref={button} class="btn btn--danger" data-testid="you-delete" disabled={busy} onClick={() => setConfirm(true)}>
          {t('legal.you.delete.button')}
        </button>
      </div>
      <Status msg={msg} testid="delete-status" />
      <Dialog
        open={confirm}
        onClose={() => {
          setConfirm(false);
          button.current?.focus();
        }}
        labelledBy="you-delete-confirm-title"
        class="dialog"
        testid="you-delete-dialog"
      >
        <h2 id="you-delete-confirm-title">{t('legal.you.delete.confirmTitle')}</h2>
        <p>{t('legal.you.delete.confirmText')}</p>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn btn--quiet"
            onClick={() => {
              setConfirm(false);
              button.current?.focus();
            }}
          >
            {t('common.cancel')}
          </button>
          <button type="button" class="btn btn--danger" data-testid="you-delete-confirm" onClick={() => void run()}>
            {t('legal.you.delete.confirm')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}

// -------------------------------------------------------------------------------------------------

export function YouPage({ s }: { s: AppState }) {
  const title = usePageFocus('you');
  const [view, setView] = useState<View>(() => (isAdult() ? { k: 'loading' } : { k: 'gate' }));
  const contact = usePrivacyContact(view.k === 'ready');
  /** What the last page-wide action did (deleted, recovered), read aloud. */
  const [done, setDone] = useState<Key | null>(null);
  /** Bumped when a switch is saved, so the reading loads again ("Don't adapt to me" removes it). */
  const [prefsVersion, setPrefsVersion] = useState(0);

  const load = async () => {
    setView({ k: 'loading' });
    try {
      const me = await api.me();
      noteVerifiedUntil(me.verifiedUntil);
      // Without a device, or one that never declared its age, the server keeps nothing to show.
      if (!me.device || !me.adult) {
        setView({ k: 'empty' });
        return;
      }
      const data = await withCheck(() => api.myData());
      setView({ k: 'ready', data });
    } catch {
      setView({ k: 'failed' });
    }
  };

  useEffect(() => {
    if (isAdult()) void load();
  }, []);

  // Links from "You against Zap" land on a section (#baixar, #apagar) once it is on the page.
  useEffect(() => {
    if (view.k !== 'ready') return;
    const id = location.hash.slice(1);
    if (id !== 'baixar' && id !== 'apagar') return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }, [view.k]);

  const start = async () => {
    try {
      await ensureAdult();
    } catch {
      return;
    }
    void load();
  };

  const deleted = () => {
    forgetLocal();
    // The copies "You against Zap" keeps on this device go with the data (DATA-SPEC 5.1).
    void forgetRecords();
    noteVerifiedUntil(null);
    setDone('legal.you.delete.done');
    setView({ k: 'empty' });
  };

  return (
    <main id="main" class="page doc you" data-testid="page-you" data-state={view.k}>
      <header class="doc__cover">
        <h1 ref={title} tabIndex={-1}>
          {t('legal.you.title')}
        </h1>
        <p class="doc__lede">{t('legal.you.lede')}</p>
        <p class="doc__go">
          <Link to={{ name: 'privacy' }}>{t('legal.you.goPrivacy')}</Link>
        </p>
        <TileStrip seed={1405} />
      </header>

      <p class="doc__page-status" role="status" data-testid="you-status">
        {view.k === 'loading' ? t('legal.you.loading') : done ? t(done) : ''}
      </p>

      {view.k === 'gate' ? (
        <section class="doc__section">
          <p>{t('you.gate')}</p>
          <div class="button-row">
            <button type="button" class="btn btn--primary" data-testid="you-start" onClick={() => void start()}>
              {t('you.start')}
            </button>
          </div>
        </section>
      ) : null}

      {view.k === 'failed' ? (
        <section class="doc__section">
          <p class="error" role="alert">
            {t('legal.you.loadFailed')}
          </p>
          <div class="button-row">
            <button type="button" class="btn" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        </section>
      ) : null}

      {view.k === 'empty' || view.k === 'ready' ? (
        <section class="doc__section" aria-labelledby="you-device-title">
          <h2 id="you-device-title">{t('legal.you.device.title')}</h2>
          <p>{t('legal.you.device.text')}</p>
          {view.k === 'empty' ? (
            <p class="quiet" data-testid="you-empty">
              {t('legal.you.empty')}
            </p>
          ) : null}
        </section>
      ) : null}

      {view.k === 'ready' ? (
        <>
          <Matches data={view.data} lang={s.lang} />
          <ReadingSection lang={s.lang} version={prefsVersion} />
          <Nickname data={view.data} />
          <PrefSwitches data={view.data} onSaved={() => setPrefsVersion((v) => v + 1)} />
          <Download />
          <Stored data={view.data} lang={s.lang} contact={contact} />
          <RecoveryCode had={view.data.device.hasRecoveryCode} />
        </>
      ) : null}

      {view.k === 'empty' || view.k === 'ready' ? (
        <Recover
          hasMatches={view.k === 'ready' && view.data.matches.length > 0}
          onDone={() => {
            setDone('legal.you.recover.done');
            void load();
          }}
        />
      ) : null}

      {view.k === 'ready' ? <DeleteData onDeleted={deleted} /> : null}
    </main>
  );
}
