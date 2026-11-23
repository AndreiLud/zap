// The actions row (CLIENT-SPEC 11.7): the status line on the left (bold line, second line, and on
// your timed turn the seconds left), the buttons on the right when they apply (bet, "Jogar coberta",
// signals, phrases). In a mão de onze the decision bar takes its place. Above the hand: the thin time
// bar of your turn and the banner while the AI plays for you. The clock is a leaf that ticks once a
// second; nothing else re-renders on a tick.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { onzeRunPoints } from '../../../engine/src/config.ts';
import { A_ACCEPT, A_RAISE, A_RUN, A_SIGNAL0, SIGNALS, SIGNAL_MASK } from '../../../engine/src/engine.ts';
import { PHRASES } from '../../../shared/protocol.ts';
import { currentController } from '../controller.ts';
import { callName, handWords, keyList, onzeHandName, phraseText, seatName, signalName, teamLabel, turnText } from '../game-text.ts';
import { t } from '../i18n.ts';
import { FINE_POINTER, useMedia } from '../media.ts';
import { sound, VIBRATION } from '../sound/index.ts';
import { serverNow, store, useStoreSelect } from '../store.ts';
import { say } from './announce.ts';
import { inGame } from './focus.ts';
import { can, canBet, handSlots, nextCall, turnSeconds, type Model } from './model.ts';
import type { Scene } from './motion.ts';

type Deadline = { seat: number; at: number | null } | null;

/** Seconds left until a server time, updated once per second (a leaf: only its owner re-renders). */
/**
 * Whole seconds left before `at`, never above `max` (the turn's length): a deadline also counts the
 * display offsets of the moves still being shown, which are not decision time.
 */
function useSecondsLeft(at: number, max: number): number {
  const left = () => Math.min(max, Math.max(0, Math.ceil((at - serverNow()) / 1000)));
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setSecs(left());
      const ms = (at - serverNow()) % 1000;
      id = setTimeout(tick, ms > 20 ? ms : 1000);
    };
    tick();
    return () => clearTimeout(id);
  }, [at, max]);
  return secs;
}

/** "23 s" on your timed turn, and "10 segundos", "5 segundos" for the screen reader once each. */
function Clock({ at, max }: { at: number; max: number }) {
  const secs = useSecondsLeft(at, max);
  const said = useRef<Set<number>>(new Set());
  useEffect(() => {
    if ((secs === 10 || secs === 5) && !said.current.has(secs)) {
      said.current.add(secs);
      say(t('board.seconds', { n: secs }));
    }
  }, [secs]);
  return (
    <span class={`clock${secs <= 5 ? ' is-low' : ''}`} role="timer" aria-label={t('turn.seconds', { n: secs })}>
      <span data-testid="deadline">{secs}</span>
      <span aria-hidden="true"> s</span>
    </span>
  );
}

/** The thin bar above the hand on your timed turn; terracotta from 5 s. */
export function TurnBar({ at, total }: { at: number; total: number }) {
  const secs = useSecondsLeft(at, Math.ceil(total / 1000));
  const elapsed = Math.max(0, total - (at - serverNow()));
  return (
    <div class="turn-bar" aria-hidden="true">
      <span class={secs <= 5 ? 'is-low' : undefined} style={{ animationDuration: `${total}ms`, animationDelay: `${-elapsed}ms` }} />
    </div>
  );
}

interface Status {
  bold: string;
  line: string;
  /** The line is only the "tap a card" hint (hidden on short phones). */
  hint?: boolean;
  extra: string;
  seat: number;
  mine: boolean;
}

function statusOf(m: Model, scene: Scene, fine: boolean): Status {
  const v = m.v;
  const seat = v.over || !v.dealt ? -1 : v.waitingFor;
  const mine = seat >= 0 && seat === m.you;
  const st: Status = { bold: '', line: '', extra: '', seat, mine };
  const name = (s: number) => seatName(m.names, s);
  const us = v.score[m.team];
  const them = v.score[1 - m.team];
  if (!v.dealt) {
    st.bold = v.dealer === m.you ? t('board.pre.line.youDeal', { mao: name(v.mao) }) : v.mao === m.you ? t('board.pre.line.you', { dealer: name(v.dealer) }) : t('board.pre.line', { dealer: name(v.dealer), mao: name(v.mao) });
    st.line =
      m.n === 4
        ? t('board.pre.count.4', { n: v.handIndex + 1, a: 12 - us, b: 12 - them })
        : t('board.pre.count.2', { n: v.handIndex + 1, a: 12 - us, b: 12 - them, name: name((m.you + 1) % 2) });
    const pub = m.room.seats[v.dealer];
    if (scene.dealerInStatus && !m.muted && pub?.kind === 'ai' && pub.persona) st.extra = `${name(v.dealer)} ${t('board.quote', { text: t(`board.dealer.${pub.persona}`) })}`;
    return st;
  }
  if (scene.dealing === v.handIndex) {
    st.bold = v.dealer === m.you ? t('board.deal.line.you') : t('board.deal.line', { dealer: name(v.dealer) });
    st.line = v.mao === m.you ? t('board.deal.count.you') : t('board.deal.count', { mao: name(v.mao) });
    return st;
  }
  if (v.handResult) {
    const hr = v.handResult;
    const gameEnded = v.options.bestOf === 3 && (us >= 12 || them >= 12);
    if (scene.handEnd === 'count' && hr.winner >= 0) {
      if (m.n === 4) st.bold = t(hr.winner === m.team ? 'board.count.us' : 'board.count.them', { p: hr.points });
      else st.bold = hr.winner === m.team ? t('board.count.you', { p: hr.points }) : t('board.count.other', { p: hr.points, name: name((m.you + 1) % 2) });
      st.line = t('board.st.count');
    } else if (hr.winner < 0) {
      st.bold = t('ev.hand.tie');
    } else if (gameEnded) {
      const g = { us: v.games[m.team], them: v.games[1 - m.team] };
      const won = us >= 12;
      st.bold = m.n === 4 ? t(won ? 'board.queda.us' : 'board.queda.them', g) : won ? t('board.queda.you', g) : t('board.queda', { ...g, team: teamLabel(m.names, 1 - m.team) });
    } else {
      st.bold = t('board.st.end.b');
      st.line = m.n === 4 ? t('board.st.end.4', { us, them }) : t('board.st.end.2', { us, them, name: name((m.you + 1) % 2) });
    }
    return st;
  }
  if (v.phase === 'raise' && v.raiser >= 0) {
    const call = callName(v.proposed, v.step + 1, false);
    if ((v.raiser & 1) === m.team) {
      st.bold = v.raiser === m.you ? t('board.wait.answer.you', { call }) : t('board.wait.answer', { name: name(v.raiser), call });
    } else {
      st.bold = t('truco.aria', { name: name(v.raiser), call });
      if (seat >= 0 && !mine) st.line = turnText(m.names, seat);
    }
    return st;
  }
  const iron = v.kind === 'iron' && v.round === 0;
  if (mine) {
    st.bold = t('turn.you');
    const count = handSlots(v).length;
    st.line = iron ? t('board.iron') : fine ? t('board.st.you.keys', { keys: keyList(count) }) : t('board.st.you');
    st.hint = !iron;
  } else if (seat >= 0) {
    st.bold = turnText(m.names, seat);
    if (iron) st.line = t('board.iron');
  }
  return st;
}

function StatusLine({ m, scene, deadline, playing }: { m: Model; scene: Scene; deadline: Deadline; playing: boolean }) {
  const fine = useMedia(FINE_POINTER);
  const st = statusOf(m, scene, fine);
  const v = m.v;
  const clock = st.mine && !playing && deadline && deadline.seat === st.seat && deadline.at !== null ? deadline.at : null;
  // Your turn, once per turn: "Sua vez. Suas cartas: ...".
  const turnKey = st.mine && v.phase === 'play' && !playing && m.legal ? `${v.matchNo}:${v.handIndex}:${v.round}:${v.rounds[v.round]?.plays.length ?? 0}` : '';
  useEffect(() => {
    if (!turnKey) return;
    say(t('board.say.turn', { cards: handWords(v) }));
    sound.play('turn');
    sound.vibrate(VIBRATION.turn);
  }, [turnKey]);
  return (
    <p class="actions__status" data-testid="turn-indicator" data-seat={String(st.seat)} data-mine={String(st.mine)}>
      {st.bold ? <b>{st.bold}</b> : null}
      {clock !== null ? <Clock at={clock} max={turnSeconds(m.room) ?? Infinity} /> : null}
      {st.line ? <span class={`actions__more${st.hint ? ' actions__more--hint' : ''}`}>{st.line}</span> : null}
      {st.extra ? <span class="actions__dealer">{st.extra}</span> : null}
    </p>
  );
}

/**
 * A button that opens a popover (signals, phrases); Esc and a click outside close it and focus goes
 * back to the button. The list is rendered only while open, so its texts are not in the page.
 */
function Pop(props: { id: string; testid: string; label: string; buttonClass: string; panelLabel: string; children: (close: () => void) => ComponentChildren }) {
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    const onToggle = (e: Event) => setOpen((e as Event & { newState?: string }).newState === 'open');
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, []);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      pop.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const a = document.activeElement;
      if (!a || a === document.body || pop.current?.contains(a)) button.current?.focus();
    }
  }, [open]);
  const close = () => {
    const el = pop.current as (HTMLDivElement & { hidePopover?: () => void }) | null;
    el?.hidePopover?.();
    button.current?.focus();
  };
  return (
    <>
      <button type="button" ref={button} class={props.buttonClass} data-testid={props.testid} popovertarget={props.id} aria-haspopup="true" aria-expanded={open}>
        {props.label}
      </button>
      <div id={props.id} ref={pop} class="table-pop" popover="auto" role="group" aria-label={props.panelLabel}>
        {open ? props.children(close) : null}
      </div>
    </>
  );
}

function Phrases() {
  const readyAt = useStoreSelect((s) => s.phraseReadyAt);
  const [, tick] = useState(0);
  const waiting = readyAt > Date.now();
  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => tick((x) => x + 1), readyAt - Date.now() + 20);
    return () => clearTimeout(id);
  }, [readyAt, waiting]);
  return (
    <Pop id="phrase-pop" testid="phrase-button" label={t('phrase.button')} buttonClass="btn btn--quiet actions__phrases" panelLabel={t('phrase.panel')}>
      {(close) => (
        <>
          <div class="table-pop__list">
            {PHRASES.map((k) => (
              <button
                type="button"
                key={k}
                class="chip"
                data-testid={`phrase-${k}`}
                disabled={waiting}
                onClick={() => {
                  currentController()?.phrase(k);
                  close();
                }}
              >
                {phraseText(k)}
              </button>
            ))}
          </div>
          {waiting ? <p class="table-pop__note">{t('board.phrases.wait')}</p> : null}
        </>
      )}
    </Pop>
  );
}

function Signals({ m }: { m: Model }) {
  return (
    <Pop id="signals-pop" testid="signals-button" label={t('board.signals')} buttonClass="btn btn--quiet" panelLabel={t('board.signals.panel')}>
      {(close) => (
        <div class="table-pop__list">
          {SIGNALS.map((name, i) => (
            <button
              type="button"
              key={name}
              class="chip"
              data-testid={`signal-${name}`}
              disabled={!can(m, A_SIGNAL0 + i)}
              onClick={() => {
                currentController()?.act(A_SIGNAL0 + i);
                close();
              }}
            >
              {signalName(i, true)}
            </button>
          ))}
        </div>
      )}
    </Pop>
  );
}

/** Mão de onze (paulista) or de dez (mineiro): the team on the threshold plays or runs. */
function OnzeBar({ m }: { m: Model }) {
  const v = m.v;
  const ours = v.onzeTeam === m.team;
  const hand = onzeHandName(v.variant);
  const text = !ours ? t('board.onze.theirs', { hand }) : m.n === 4 && v.options.onzeSeesPartner ? t('board.onze.mine', { hand }) : t('board.onze.decide', { hand });
  const decides = ours && (can(m, A_ACCEPT) || can(m, A_RUN));
  const points = onzeRunPoints({ variant: v.variant, players: m.n as 2 | 4, options: v.options });
  const seat = v.waitingFor;
  return (
    <div class="actions actions--onze" data-testid="onze-bar">
      <p class="actions__status" data-testid="turn-indicator" data-seat={String(seat)} data-mine={String(seat >= 0 && seat === m.you)}>
        <b>{text}</b>
      </p>
      {decides ? (
        <div class="actions__buttons">
          <button type="button" class="btn btn--primary" data-testid="action-accept" aria-keyshortcuts="A" onClick={() => currentController()?.act(A_ACCEPT)}>
            {t('board.onze.play', { value: v.value })}
            <kbd class="kbd-only" aria-hidden="true">
              A
            </kbd>
          </button>
          <button type="button" class="btn btn--outline" data-testid="action-run" aria-keyshortcuts="C" onClick={() => currentController()?.act(A_RUN)}>
            {m.n === 4 ? t('board.onze.run.4', { points }) : t('board.onze.run', { team: seatName(m.names, (m.you + 1) % 2), points })}
            <kbd class="kbd-only" aria-hidden="true">
              C
            </kbd>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Actions({ m, scene, deadline, playing, panel }: { m: Model; scene: Scene; deadline: Deadline; playing: boolean; panel: boolean }) {
  const v = m.v;
  if (v.dealt && v.phase === 'onze' && !m.ended && !v.handResult) return <OnzeBar m={m} />;
  const yourTurn = v.dealt && v.waitingFor === m.you && !v.over;
  const bet = yourTurn && canBet(m) && !panel ? nextCall(v) : null;
  const signals = (m.legal & SIGNAL_MASK) !== 0;
  return (
    <div class={`actions${!v.dealt ? ' actions--before' : ''}${panel ? ' is-covered' : ''}`}>
      <StatusLine m={m} scene={scene} deadline={deadline} playing={playing} />
      <div class="actions__buttons">
        {bet ? (
          <button
            type="button"
            class="btn btn--bet"
            data-testid="action-raise"
            aria-keyshortcuts="T"
            aria-label={t('board.raise.aria', { call: callName(bet.value, bet.step, false) })}
            onClick={() => currentController()?.act(A_RAISE)}
          >
            {callName(bet.value, bet.step, true)}
            <kbd class="kbd-only" aria-hidden="true">
              T
            </kbd>
          </button>
        ) : null}
        {m.coverLegal && !m.ended ? (
          <button type="button" class="btn btn--quiet actions__cover" data-testid="action-cover" aria-pressed={m.cover} aria-keyshortcuts="E" onClick={() => store.set({ cover: !store.get().cover })}>
            {t('action.cover')}
            <kbd class="kbd-only" aria-hidden="true">
              E
            </kbd>
          </button>
        ) : null}
        {signals && !m.ended ? <Signals m={m} /> : null}
        <Phrases />
      </div>
    </div>
  );
}

/** "The AI is playing for you." with "Back to playing", which takes focus when it appears. */
export function ResumeBanner() {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (inGame()) button.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div class="resume">
      <p>{t('board.aiPlaying')}</p>
      <button type="button" ref={button} class="btn btn--primary" data-testid="resume-button" onClick={() => currentController()?.resume()}>
        {t('seat.resume')}
      </button>
    </div>
  );
}

/** Seconds of your timed turn for the bar above the hand, or null. */
export function turnClock(m: Model, deadline: Deadline, playing: boolean): { at: number; total: number } | null {
  const secs = turnSeconds(m.room);
  if (!secs || playing || !deadline || deadline.at === null || deadline.seat !== m.you || m.v.over) return null;
  return { at: deadline.at, total: secs * 1000 };
}
