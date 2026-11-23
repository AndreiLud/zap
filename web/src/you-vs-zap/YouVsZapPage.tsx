// "You against Zap" (DATA-SPEC 5): the person's history, rating, how Zap reads them, abandons,
// best hands and their data, all computed in this browser from the person's own records. Nothing
// new is stored on the server and nothing is sent anywhere: the page reads /api/me/data,
// /api/me/matches/:id and /api/me/reading (the person's own), and the two public answers every
// visitor gets, /api/live (the version in play, whether it reads during the match) and
// /api/summary (the anchors of versions the cycle promoted).
//
// Loading (5.1): without a game credential the page asks the person to confirm it is them (the
// human check, as the You page (/voce) does). Then /api/me/data; the records come from the device cache
// (records-cache.ts) and the missing ones from the server in batches of 10, and the history fills
// in as they arrive. The rating and the best hands wait for every record.

import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, type MyData } from '../api.ts';
import { noteVerifiedUntil, withCheck } from '../check.ts';
import { Link } from '../components/common.tsx';
import { ensureAdult, isAdult, isGateStop } from '../consent.ts';
import { normalizeSummary } from '../../../shared/summary-view.ts';
import type { AnySummary, SummaryV2 } from '../../../shared/cycle-formats.ts';
import facts from '../data/generated/facts-view.json';
import { fmt } from '../data/format.ts';
import { t } from '../i18n.ts';
import { DOWNLOAD_BATCH, fetchRecord } from '../my-data.ts';
import { usePageFocus } from '../page-focus.ts';
import { TileStrip } from '../pages/Doc.tsx';
import type { AppState } from '../store.ts';
import '../styles/you-vs-zap.css';
import { toPersonMatch, type PersonMatch } from './history.ts';
import { Abandons } from './parts/Abandons.tsx';
import { BestHands } from './parts/BestHands.tsx';
import { History } from './parts/History.tsx';
import { Rating } from './parts/Rating.tsx';
import { Reading } from './parts/Reading.tsx';
import { YourData } from './parts/YourData.tsx';
import { forgetRecords, openRecordsCache, type CachedRecord } from './records-cache.ts';

type View = { k: 'gate' } | { k: 'loading' } | { k: 'failed' } | { k: 'empty' } | { k: 'ready'; data: MyData };

interface Records {
  list: PersonMatch[];
  /** Records in hand, and the matches that have one (a record the server no longer has drops out). */
  done: number;
  total: number;
  complete: boolean;
  failed: boolean;
}

interface Served {
  version: string;
  adapt: boolean;
}

const SERVED_FACTS = (facts as unknown as { served: { version: string; readsOpponents: boolean } }).served;

/** The version on the AI seats and whether it reads during the match (zap-live/1), or null. */
async function fetchLive(): Promise<Served | null> {
  try {
    const res = await fetch('/api/live', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const j = (await res.json()) as { schema?: unknown; current?: unknown; adapt?: unknown };
    if (j.schema !== 'zap-live/1' || typeof j.current !== 'string') return null;
    return { version: j.current, adapt: j.adapt === true };
  } catch {
    return null;
  }
}

/** summary.json as served (/api/summary), in its zap-summary/2 view; null when there is none. */
async function fetchSummary(): Promise<SummaryV2 | null> {
  try {
    const res = await fetch('/api/summary', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const j = (await res.json()) as AnySummary;
    if (j?.schema !== 'zap-summary/1' && j?.schema !== 'zap-summary/2') return null;
    return normalizeSummary(j);
  } catch {
    return null;
  }
}

function usable(c: CachedRecord): PersonMatch | null {
  try {
    const m = toPersonMatch(c);
    return Array.isArray(m.record.log) && Array.isArray(m.record.seats) && m.record.result ? m : null;
  } catch {
    return null;
  }
}

/** Records from the device first, then the missing ones from the server, `onChange` after each batch. */
async function loadRecords(data: MyData, alive: () => boolean, onChange: (r: Records) => void): Promise<void> {
  const ids = [...new Set(data.matches.map((m) => m.matchId))];
  const cache = await openRecordsCache();
  const list: PersonMatch[] = [];
  let total = ids.length;
  const publish = (complete: boolean, failed = false) => alive() && onChange({ list: [...list], done: list.length, total, complete, failed });
  try {
    if (cache && data.pseudonym) await cache.claim(data.pseudonym);
    const cached = cache ? await cache.all() : new Map<string, CachedRecord>();
    const todo: string[] = [];
    for (const id of ids) {
      const c = cached.get(id);
      const m = c ? usable(c) : null;
      if (m) list.push(m);
      else todo.push(id);
    }
    publish(todo.length === 0);
    for (let i = 0; i < todo.length; i += DOWNLOAD_BATCH) {
      if (!alive()) return;
      const got = await Promise.all(todo.slice(i, i + DOWNLOAD_BATCH).map((id) => fetchRecord(id)));
      const fresh: CachedRecord[] = [];
      for (const g of got) {
        const m = g.record && g.yourSeat !== null ? usable({ yourSeat: g.yourSeat, record: g.record }) : null;
        if (!m) {
          total--;
          continue;
        }
        list.push(m);
        fresh.push({ yourSeat: m.yourSeat, record: m.record });
      }
      await cache?.put(fresh);
      publish(i + DOWNLOAD_BATCH >= todo.length);
    }
  } catch {
    publish(false, true);
  } finally {
    cache?.close();
  }
}

const EMPTY_RECORDS: Records = { list: [], done: 0, total: 0, complete: false, failed: false };

export function YouVsZap({ s }: { s: AppState }) {
  const title = usePageFocus('vs');
  const f = fmt();
  const [view, setView] = useState<View>(() => (isAdult() ? { k: 'loading' } : { k: 'gate' }));
  const [records, setRecords] = useState<Records>(EMPTY_RECORDS);
  const [attempt, setAttempt] = useState(0);
  const [served, setServed] = useState<Served>({ version: SERVED_FACTS.version, adapt: SERVED_FACTS.readsOpponents });
  const [summary, setSummary] = useState<SummaryV2 | null>(null);

  /** askCheck: the person pressed the button, so a missing credential opens the human check. */
  const load = async (askCheck: boolean) => {
    setView({ k: 'loading' });
    try {
      const me = await api.me();
      noteVerifiedUntil(me.verifiedUntil);
      // A browser that never played, or never declared its age to the server, has nothing to show.
      if (!me.device || !me.adult) {
        setView({ k: 'empty' });
        return;
      }
      if (!askCheck && !(me.verifiedUntil !== null && me.verifiedUntil > Date.now() + 10_000)) {
        setView({ k: 'gate' });
        return;
      }
      const data = await withCheck(() => api.myData());
      setView(data.matches.length === 0 ? { k: 'empty' } : { k: 'ready', data });
    } catch (e) {
      setView(e instanceof ApiError && isGateStop(e.code) ? { k: 'gate' } : { k: 'failed' });
    }
  };

  useEffect(() => {
    if (isAdult()) void load(false);
  }, []);

  const data = view.k === 'ready' ? view.data : null;
  useEffect(() => {
    if (!data) return;
    let alive = true;
    setRecords({ ...EMPTY_RECORDS, total: data.matches.length });
    void loadRecords(data, () => alive, setRecords);
    return () => {
      alive = false;
    };
  }, [data, attempt]);

  useEffect(() => {
    if (!data) return;
    let alive = true;
    void fetchLive().then((x) => alive && x && setServed(x));
    void fetchSummary().then((x) => alive && setSummary(x));
    return () => {
      alive = false;
    };
  }, [data]);

  const start = async () => {
    try {
      await ensureAdult();
    } catch {
      return;
    }
    void load(true);
  };

  const loading = data !== null && !records.complete && !records.failed;

  return (
    <main id="main" class="page doc data-root vs" data-testid="page-vs" data-state={view.k} data-complete={String(records.complete)}>
      <header class="doc__cover">
        <h1 ref={title} tabIndex={-1}>
          {t('data.vs.h1')}
        </h1>
        <p class="doc__lede">{t('data.vs.lede')}</p>
        <TileStrip seed={2026} />
      </header>

      <p class="doc__page-status" role="status" data-testid="vs-status">
        {view.k === 'loading' ? t('data.vs.opening') : loading ? t('data.vs.loading', { done: f.int(records.done), total: f.int(records.total) }) : ''}
      </p>

      {view.k === 'gate' ? (
        <section class="doc__section" data-testid="vs-gate">
          <p>{t('data.vs.gate')}</p>
          <div class="button-row">
            <button type="button" class="btn btn--primary" data-testid="vs-start" onClick={() => void start()}>
              {t('data.vs.gate.button')}
            </button>
          </div>
        </section>
      ) : null}

      {view.k === 'failed' ? (
        <section class="doc__section">
          <p class="error" role="alert">
            {t('data.vs.openFailed')}
          </p>
          <div class="button-row">
            <button type="button" class="btn" onClick={() => void load(true)}>
              {t('common.retry')}
            </button>
          </div>
        </section>
      ) : null}

      {view.k === 'empty' ? (
        <section class="doc__section" data-testid="vs-empty">
          <p>{t('data.vs.empty')}</p>
          <div class="button-row">
            <Link to={{ name: 'play' }} class="btn btn--primary">
              {t('data.vs.play')}
            </Link>
          </div>
        </section>
      ) : null}

      {data ? (
        <>
          {records.failed ? (
            <section class="doc__section">
              <p class="error" role="alert">
                {t('data.vs.loadFailed')}
              </p>
              <div class="button-row">
                <button type="button" class="btn" onClick={() => setAttempt((n) => n + 1)}>
                  {t('common.retry')}
                </button>
              </div>
            </section>
          ) : null}
          <History matches={records.list} />
          <Rating matches={records.list} complete={records.complete} version={served.version} summary={summary} />
          <Reading inMatch={served.adapt} adaptOn={summary?.layers.adaptation.on === true} />
          <Abandons abandons={data.device.abandons} total={data.matches.length} matches={records.list} />
          <BestHands matches={records.list} complete={records.complete} />
          <YourData onForget={() => forgetRecords()} />
        </>
      ) : null}
    </main>
  );
}
