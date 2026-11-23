// The table of a running match (CLIENT-SPEC 11): the score band and the row about this hand, the
// play area with the seats and the trick, the actions row, the TRUCO panel and the match result over
// the play area, your hand, and from 64em the side panel. Every action goes through
// currentController(), so a room and the guided match share it. Each region reads its own slice of
// the store; the root ignores the app's re-renders, and a tick of the clock re-renders only the clock.
//
// TableOpening is the same stage while a room opens (no room message yet): the deck on the medallion,
// three hand hollows and "Abrindo a sala ABCDE", with no score and no turn indicator.

import '../styles/table.css';
import '../styles/truco.css';
import { Component } from 'preact';
import { useMemo } from 'preact/hooks';
import { useSheetGroup } from '../chrome.ts';
import { ConnStatus } from '../components/common.tsx';
import { currentController } from '../controller.ts';
import { t, type Key } from '../i18n.ts';
import { useTableExtras } from '../guided/slot.ts';
import { DESKTOP, useMedia } from '../media.ts';
import { shallowEqual, store, useStoreSelect, type AppState } from '../store.ts';
import { Actions, turnClock } from './Actions.tsx';
import { Announcer } from './Announcer.tsx';
import { BackView } from './cards.tsx';
import { useSoundUnlock, useTableEvents } from './events.ts';
import { skipToCards } from './focus.ts';
import { HandArea, playFromButton } from './Hand.tsx';
import { HandInfo } from './HandInfo.tsx';
import { useTableKeys, type KeyResult } from './keyboard.ts';
import { MatchResult } from './MatchResult.tsx';
import { answeringRaise, makeModel, posOf } from './model.ts';
import { useScene } from './motion.ts';
import { ScoreBand } from './Score.tsx';
import { SidePanel } from './SidePanel.tsx';
import { OpeningArea, PlayArea } from './Stage.tsx';
import { Tools } from './Tools.tsx';
import { TrucoPanel } from './TrucoPanel.tsx';

function onKey(r: NonNullable<KeyResult>): void {
  if (r.kind === 'cover') {
    store.set({ cover: !store.get().cover });
    return;
  }
  if (r.slot !== undefined) {
    playFromButton(document.querySelector<HTMLElement>(`.hand [data-slot="${r.slot}"]`), r.slot);
    return;
  }
  currentController()?.act(r.a);
}

function readKeys() {
  const s = store.get();
  return { v: s.view, legal: s.sending || !s.view || s.conn !== 'online' ? 0 : s.view.legal, cover: s.cover };
}

function TableBody({ title }: { title?: string }) {
  const sl = useStoreSelect(
    (s) => ({
      view: s.view,
      room: s.room,
      sending: s.sending,
      cover: s.cover,
      muted: s.muteOthers,
      lang: s.lang,
      playing: s.playing,
      deadline: s.game?.deadline ?? null,
      bubbles: s.bubbles,
      online: s.conn === 'online',
    }),
    shallowEqual,
  );
  const scene = useScene();
  const desktop = useMedia(DESKTOP);
  // The guided match adds its title, its coach and the suggested card (guided/slot.ts).
  const extras = useTableExtras();
  useTableEvents();
  useSoundUnlock();
  useTableKeys(onKey, readKeys);
  // Below 64em the tools live in the menu sheet, as the group "This table".
  const group = useMemo(() => ({ title: 'shell.sheet.table' as Key, render: (close: (then?: () => void) => void) => <Tools close={close} /> }), []);
  useSheetGroup(group, !desktop);

  if (!sl.view || !sl.room) return null;
  const m = makeModel(sl.view, sl.room.room, { sending: sl.sending, cover: sl.cover, playing: sl.playing, muted: sl.muted, online: sl.online });
  const panel = !m.ended && answeringRaise(m);
  const resume = !!m.room.seats[m.you]?.aiPlaying && !m.ended;
  const clock = turnClock(m, sl.deadline, sl.playing);
  return (
    <main id="main" class={`table players-${m.n}`} data-motion={scene.motion ? 'on' : 'off'}>
      <h1 class="sr-only">{title ?? (extras ? t(extras.title) : t('table.title', { code: m.room.code }))}</h1>
      <a
        class="skip-link"
        href="#hand-area"
        onClick={(e) => {
          e.preventDefault();
          skipToCards();
        }}
      >
        {t('shell.skip.cards')}
      </a>
      <div class="stage">
        <div class="band">
          <ScoreBand m={m} scene={scene} />
          <HandInfo m={m} scene={scene} />
        </div>
        {extras && !desktop ? <div class="table-coach">{extras.coach()}</div> : null}
        <div class={`stage__game${panel ? ' has-truco' : ''}`}>
          <PlayArea m={m} scene={scene} bubbles={sl.bubbles} deadline={sl.deadline} />
          <Actions m={m} scene={scene} deadline={sl.deadline} playing={sl.playing} panel={panel} />
          <TrucoPanel m={m} open={panel} deadline={sl.deadline} pos={m.v.raiser >= 0 ? posOf(m.v.raiser, m.you, m.n) : 'top'} />
          {m.ended ? <MatchResult key={m.v.matchNo} m={m} /> : null}
        </div>
        <HandArea
          m={m}
          scene={scene}
          bubbles={sl.bubbles}
          clock={clock}
          resume={resume}
          suggest={extras && extras.suggestSlot !== null ? { slot: extras.suggestSlot, tag: t(extras.suggestTag) } : null}
        />
      </div>
      {desktop ? <SidePanel m={m} coach={extras ? extras.coach : null} /> : null}
      <Announcer names={m.names} />
      <div class="flights-src" hidden>
        <BackView />
      </div>
    </main>
  );
}

/**
 * The table. The app re-renders it on every store change; it ignores those and lets each region
 * follow its own slice. `title` replaces "Mesa da sala ABCDE" (the guided match).
 */
export class Table extends Component<{ s: AppState; title?: string }> {
  override shouldComponentUpdate(next: { s: AppState; title?: string }): boolean {
    return next.title !== this.props.title;
  }

  override render() {
    return <TableBody title={this.props.title} />;
  }
}

function OpeningBody({ code }: { code: string }) {
  useStoreSelect((s) => s.lang);
  return (
    <main id="main" class="table table--opening" aria-busy="true">
      <h1 class="sr-only">{t('table.title', { code })}</h1>
      <div class="stage">
        <div class="stage__game">
          <OpeningArea />
          <div class="actions actions--before">
            <p class="actions__status">
              <b>{t('board.opening', { code })}</b>
            </p>
            <ConnStatus s={store.get()} />
          </div>
        </div>
        <section class="hand-area" aria-hidden="true">
          <div class="turn-bar turn-bar--off" />
          <ul class="hand">
            {[0, 1, 2].map((i) => (
              <li key={i} class="hand__hollow">
                <div class="hand__hollow-card" />
                <span class="hand__legend" />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

/** The room is opening: the stage before anything about the match arrived. */
export function TableOpening({ s }: { s: AppState }) {
  return <OpeningBody code={s.route.code ?? ''} />;
}
