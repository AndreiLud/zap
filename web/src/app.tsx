// The app shell: skip link, header (with the phone menu sheet), the page of the current route,
// footer, and the dialogs every page shares (age gate, notice, human check, quick rules). Routes
// come from routes.ts; every page outside the table path loads on demand (lazy.tsx), and so do the
// table itself, the quick rules dialog, the age gate and the legal texts (CLIENT-SPEC 18).

import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { openRules } from './actions.ts';
import { AdsRoot } from './ads/index.ts';
import { ConnStatus } from './components/common.tsx';
import { HumanCheck } from './components/Dialogs.tsx';
import { Footer } from './components/Footer.tsx';
import { Header } from './components/Header.tsx';
import { legalReady, loadData, loadLegal, t, type Key } from './i18n.ts';
import { lazyComponent } from './lazy.tsx';
import { limitText } from './limit.ts';
import { Lobby } from './pages/Lobby.tsx';
import { PlayPage } from './pages/Play.tsx';
import { RoomProblemPage } from './pages/RoomProblem.tsx';
import { StartPage } from './pages/Start.tsx';
import { INDEXED, isLegalRoute, type PathRoute, type Route } from './routes.ts';
import { store, useStore, type AppState } from './store.ts';

const Table = lazyComponent(() => import('./table/Table.tsx').then((m) => m.Table), Loading);
const TableOpening = lazyComponent(() => import('./table/Table.tsx').then((m) => m.TableOpening), (p: { s: AppState }) => <RoomLoading s={p.s} />);
const RulesPage = lazyComponent(() => import('./pages/Rules.tsx').then((m) => m.RulesPage), Loading);
const GuidedPage = lazyComponent(() => import('./pages/Guided.tsx').then((m) => m.GuidedPage), Loading);
/** The data texts load with the route chunk, not after it (the route would ask for them only once it runs). */
const withDataTexts = <T,>(chunk: Promise<T>): Promise<T> => {
  loadData().catch(() => {});
  return chunk;
};
const DataPage = lazyComponent(() => withDataTexts(import('./pages/Data.tsx')).then((m) => m.DataPage), Loading);
const NotFoundPage = lazyComponent(() => import('./pages/NotFound.tsx').then((m) => m.NotFoundPage), Loading);
const YouPage = lazyComponent(() => import('./pages/You.tsx').then((m) => m.YouPage), Loading);
const YouVsZapPage = lazyComponent(() => withDataTexts(import('./pages/YouVsZap.tsx')).then((m) => m.YouVsZapPage), Loading);
const LegalPage = lazyComponent(() => import('./pages/Legal.tsx').then((m) => m.LegalPage), Loading);
const RulesDialog = lazyComponent(() => import('./components/RulesDialog.tsx').then((m) => m.RulesDialog));
const AgeGate = lazyComponent(() => import('./components/Gate.tsx').then((m) => m.AgeGate));
const NoticeDialog = lazyComponent(() => import('./components/Gate.tsx').then((m) => m.NoticeDialog));

/** While a page's code or texts load: an empty main, busy, so the layout does not jump. */
function Loading() {
  return <main id="main" class="page loading" aria-busy="true" />;
}

/** Renders its content once the legal texts of the current language are in (i18n.ts loadLegal). */
function WithLegal({ s, children }: { s: AppState; children: () => ComponentChildren }) {
  const ready = legalReady(s.lang);
  useEffect(() => {
    if (!ready) void loadLegal(s.lang).catch(() => {});
  }, [ready, s.lang]);
  return <>{ready ? children() : <Loading />}</>;
}

/** Title and description of each route (the prerender writes the same ones into each page's head). */
const META: Partial<Record<Route['name'], { title: Key; description?: Key }>> = {
  start: { title: 'shell.meta.start.title', description: 'shell.meta.start.description' },
  play: { title: 'shell.meta.play.title', description: 'shell.meta.play.description' },
  guided: { title: 'shell.meta.guided.title', description: 'shell.meta.guided.description' },
  rules: { title: 'shell.meta.rules.title', description: 'shell.meta.rules.description' },
  data: { title: 'shell.meta.data.title', description: 'shell.meta.data.description' },
  vs: { title: 'shell.meta.vs.title', description: 'shell.meta.vs.description' },
  notFound: { title: 'shell.meta.notFound.title' },
};

/** Title, description and robots for the current route; null while its texts are still loading. */
function pageMeta(route: Route): { title: string; description: string | null; noindex: boolean } | null {
  const noindex = route.name === 'room' || route.name === 'notFound' || !INDEXED.includes(route.name as PathRoute);
  if (route.name === 'room') return { title: t('title.room', { code: route.code ?? '' }), description: null, noindex };
  if (isLegalRoute(route.name) || route.name === 'you') {
    if (!legalReady()) return null;
    return { title: t(`legal.${route.name}.metaTitle`), description: t(`legal.${route.name}.description`), noindex };
  }
  const m = META[route.name];
  if (!m) return null;
  return { title: t(m.title), description: m.description ? t(m.description) : null, noindex };
}

function Page({ s }: { s: AppState }) {
  const r = s.route;
  switch (r.name) {
    case 'start':
      return <StartPage s={s} />;
    case 'play':
      return <PlayPage s={s} />;
    case 'room':
      return <RoomPage s={s} />;
    case 'rules':
      return <RulesPage s={s} />;
    case 'guided':
      return <GuidedPage s={s} />;
    case 'data':
      return <DataPage s={s} />;
    case 'you':
      return <WithLegal s={s}>{() => <YouPage key="you" s={s} />}</WithLegal>;
    case 'vs':
      return <YouVsZapPage s={s} />;
    case 'privacy':
    case 'terms':
    case 'verify': {
      const page = r.name;
      return <WithLegal s={s}>{() => <LegalPage key={page} page={page} s={s} />}</WithLegal>;
    }
    case 'notFound':
      return <NotFoundPage s={s} />;
  }
}

function RoomPage({ s }: { s: AppState }) {
  if (s.roomProblem) {
    const problem = s.roomProblem;
    // The under-18 answer speaks with the legal texts.
    if (problem === 'age') return <WithLegal s={s}>{() => <RoomProblemPage s={s} problem={problem} />}</WithLegal>;
    return <RoomProblemPage s={s} problem={problem} />;
  }
  const status = s.room?.room.status;
  if (status === 'lobby') return <Lobby s={s} />;
  if ((status === 'playing' || status === 'ended') && s.view) return <Table s={s} />;
  // Opening: the table's stage with the deck on the medallion (CLIENT-SPEC 10.4), from the table chunk.
  return <TableOpening s={s} />;
}

/** While the table's code loads: the room's name and the connection badge. */
function RoomLoading({ s }: { s: AppState }) {
  return (
    <main id="main" class="page loading" aria-busy="true">
      <h1>{s.route.name === 'room' ? t('room.loading', { code: s.route.code ?? '' }) : ''}</h1>
      <ConnStatus s={s} />
    </main>
  );
}

function setMeta(name: string, content: string | null): void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (content === null) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = name;
    document.head.append(tag);
  }
  tag.content = content;
}

/** The page description the HTML shipped with, for routes that have none of their own. */
let defaultDescription: string | null = null;

export function App() {
  const s = useStore();

  useEffect(() => {
    const meta = pageMeta(s.route);
    if (!meta) return;
    document.title = meta.title;
    const tag = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (tag) defaultDescription ??= tag.content;
    if (meta.description ?? defaultDescription) setMeta('description', meta.description ?? defaultDescription);
    // Rooms, the You page, the data placeholder and unknown addresses are never indexed.
    setMeta('robots', meta.noindex ? 'noindex' : null);
  }, [s.lang, s.route, s.legalLoads]);

  // R opens the quick rules from any page except the rules page, unless typing, a dialog is open or
  // the single key shortcuts are off (WCAG 2.1.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !store.get().keysOn) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (document.querySelector('dialog[open]')) return;
      if (s.route.name === 'rules') return;
      e.preventDefault();
      openRules();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.route.name]);

  return (
    <>
      <a class="skip-link" href="#main">
        {t('skip.main')}
      </a>
      <Header s={s} />
      <Page s={s} />
      <Footer s={s} />
      {s.gate !== 'closed' || AgeGate.loaded ? (
        <>
          <AgeGate s={s} />
          <NoticeDialog s={s} />
        </>
      ) : null}
      <HumanCheck s={s} />
      {s.rulesOpen || RulesDialog.loaded ? <RulesDialog s={s} /> : null}
      <AdsRoot />
      <div class="toast-area" role="status" aria-live="polite">
        {s.notice ? (
          <p class="toast" data-testid="notice">
            {t(s.notice)}
          </p>
        ) : null}
        {s.noticeLimit ? (
          <p class="toast" data-testid="notice-limit">
            {limitText(s.noticeLimit)}
          </p>
        ) : null}
      </div>
    </>
  );
}
