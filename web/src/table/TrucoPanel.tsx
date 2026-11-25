// The TRUCO moment (CLIENT-SPEC 11.4): when the other team raises and you answer, a panel covers the
// play area and the status line. The top area is a wall of generated tiles that turns over, the
// caller's line and the call in letter tiles; the answer area has the time bar, what each answer
// means, the context of the hand and the buttons Aceito (A), Corro (C) and the raise answer (T) when
// legal. Not modal: the header stays reachable. The buttons work from the first frame; the flip is
// decoration. Closing fades out and gives focus back to where it was, or to your hand.

import { Component } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { rankOf } from '../../../engine/src/cards.ts';
import { A_ACCEPT, A_RAISE, A_RUN, TIE } from '../../../engine/src/engine.ts';
import type { PersonaId } from '../../../ai/src/personas.ts';
import { AiMark, Avatar } from '../components/pieces.tsx';
import { currentController } from '../controller.ts';
import { Module, panelModules } from '../deck/tiles.tsx';
import { callName, cardName, seatName, seatOf } from '../game-text.ts';
import { t } from '../i18n.ts';
import { REDUCED_MOTION, useMedia } from '../media.ts';
import { serverNow } from '../store.ts';
import { focusHand, inGame } from './focus.ts';
import { can, nextCall, turnSeconds, type Model } from './model.ts';
import { TRUCO_IN, TRUCO_OUT, TRUCO_OUT_REDUCED, TRUCO_REDUCED_BEAT } from './timing.ts';

const PALETTE = {
  light: [
    ['#FBF8F2', '#1D3B9A'],
    ['#1D3B9A', '#F2EDE2'],
    ['#E3A72F', '#1D3B9A'],
    ['#F2EDE2', '#CF5B37'],
    ['#CF5B37', '#F2EDE2'],
    ['#FBF8F2', '#E3A72F'],
    ['#1D3B9A', '#E3A72F'],
  ],
  dark: [
    ['#1A1D24', '#8EA2FF'],
    ['#15225C', '#EFE8DA'],
    ['#21252D', '#F2BC4A'],
    ['#2A1A16', '#FF8B62'],
    ['#15225C', '#8EA2FF'],
    ['#1A1D24', '#FF8B62'],
    ['#F2BC4A', '#15225C'],
  ],
} as const;

/** What the panel says; frozen while it fades out. */
interface Panel {
  key: string;
  caller: number;
  callerName: string;
  persona: PersonaId | null;
  ai: boolean;
  word: string;
  aria: string;
  value: string;
  context: string;
  raise: string | null;
  deadline: { durationMs: number; elapsedMs: number } | null;
}

/** The rounds so far and the cards on the table, in one quiet line. */
export function trucoContext(m: Model): string {
  const v = m.v;
  const done = v.rounds
    .map((r, i) => ({ r, n: i + 1 }))
    .filter(({ r }) => r.result >= 0)
    .map(({ r, n }) => {
      if (r.result === TIE) return t('truco.ctx.tie', { n });
      if (m.n === 4) return t(r.result === m.team ? 'truco.ctx.us' : 'truco.ctx.them', { n });
      return r.winnerSeat === m.you ? t('truco.ctx.you', { n }) : t('truco.ctx.other', { n, name: seatName(m.names, r.winnerSeat) });
    });
  const cur = v.rounds[v.round];
  const list = (cur?.plays ?? [])
    .map((p) => {
      if (p.seat === m.you) {
        if (p.faceDown) return t('truco.ctx.covered.mine');
        return t(rankOf(p.card) === 4 ? 'truco.ctx.mine.f' : 'truco.ctx.mine', { card: cardName(p.card) });
      }
      if (p.faceDown) return t('truco.ctx.covered', { of: seatOf(m.names, p.seat) });
      return t('truco.ctx.theirs', { card: cardName(p.card), of: seatOf(m.names, p.seat) });
    })
    .join(', ');
  return (done.length ? done.join(' ') : t('truco.ctx.first')) + (list ? ` ${t('truco.ctx.table', { list })}` : '');
}

function panelOf(m: Model, deadline: { seat: number; at: number | null } | null): Panel {
  const v = m.v;
  const caller = v.raiser;
  const pub = m.room.seats[caller];
  const callerName = seatName(m.names, caller);
  const call = callName(v.proposed, v.step + 1, true);
  const runLine = m.n === 4 ? t('truco.value.run.4', { points: v.value }) : t('truco.value.run.2', { points: v.value, name: callerName });
  const next = can(m, A_RAISE) ? nextCall(v) : null;
  const secs = turnSeconds(m.room);
  const d = deadline && deadline.seat === m.you && deadline.at !== null && secs ? deadline : null;
  return {
    key: `${v.matchNo}:${v.handIndex}:${v.round}:${caller}:${v.proposed}`,
    caller,
    callerName,
    persona: pub?.kind === 'ai' ? pub.persona : null,
    ai: pub?.kind === 'ai',
    word: call.toUpperCase(),
    aria: t('truco.aria', { name: callerName, call: callName(v.proposed, v.step + 1, false) }),
    value: `${t('truco.value.accept', { value: v.proposed })} ${runLine}`,
    context: trucoContext(m),
    raise: next ? callName(next.value, next.step, true) : null,
    deadline: d && secs ? { durationMs: secs * 1000, elapsedMs: Math.max(0, secs * 1000 - (d.at! - serverNow())) } : null,
  };
}

/** Tiles of the wall for a box: about 76 px on phones (at most 40 tiles), 96 px on wide screens. */
function wallSize(w: number, h: number): { cols: number; rows: number; size: number } {
  const target = w < 640 ? 76 : 96;
  const cols = Math.max(4, Math.round(w / target));
  const size = (w - 6) / cols;
  let rows = Math.ceil(h / Math.max(1, size)) + 1;
  if (w < 640) rows = Math.max(1, Math.min(rows, Math.floor(40 / cols)));
  return { cols, rows, size };
}

function Wall({ pos, dark }: { pos: string; dark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ cols: number; rows: number; size: number } | null>(null);
  // The tiles turn over once, when the panel opens; after that a resize rebuilds the wall in place.
  const [entering, setEntering] = useState(true);
  const busy = useRef(entering);
  busy.current = entering;
  useEffect(() => {
    const id = setTimeout(() => setEntering(false), TRUCO_IN + 600);
    return () => clearTimeout(id);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setSize((old) => {
        const next = wallSize(r.width, r.height);
        return old && old.cols === next.cols && old.rows === next.rows && Math.abs(old.size - next.size) < 1 ? old : next;
      });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    // Rebuild on resize only when idle (not while the tiles turn over).
    const ro = new ResizeObserver(() => {
      if (!busy.current) measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} class={`truco__wall${entering ? ' is-entering' : ''}`} aria-hidden="true" style={size ? { '--cols': String(size.cols), gridAutoRows: `${Math.max(1, size.size - 3)}px` } : undefined}>
      {size ? <Tiles cols={size.cols} rows={size.rows} dark={dark} pos={pos} /> : null}
    </div>
  );
}

interface TilesProps {
  cols: number;
  rows: number;
  dark: boolean;
  pos: string;
}

/** The wall's tiles, redrawn only when the grid or the palette changes. */
class Tiles extends Component<TilesProps> {
  override shouldComponentUpdate(n: TilesProps): boolean {
    const p = this.props;
    return n.cols !== p.cols || n.rows !== p.rows || n.dark !== p.dark || n.pos !== p.pos;
  }

  override render() {
    const { cols, rows, dark, pos } = this.props;
    const mods = panelModules(cols * rows, 2026, dark ? PALETTE.dark : PALETTE.light);
    return (
      <>
        {mods.map((mod, k) => {
          const col = k % cols;
          const row = Math.floor(k / cols);
          // The wave starts on the caller's side.
          const d = pos === 'right' ? (cols - 1 - col) * 52 + row * 22 : pos === 'left' ? col * 52 + row * 22 : row * 40 + Math.abs(col - cols / 2) * 22;
          return (
            <div key={k} class="truco__tile" style={{ '--d': `${Math.round(Math.min(d, TRUCO_IN - 200))}ms`, '--turn': `${mod.rot * 90}deg` }}>
              <div class="truco__tile-in">
                <div class="truco__tile-a" />
                <div class="truco__tile-b">
                  <Module m={{ ...mod, rot: 0 }} />
                </div>
              </div>
            </div>
          );
        })}
      </>
    );
  }
}

function wordCols(n: number): number {
  return n <= 4 ? 2 : n <= 6 ? 3 : 4;
}

/** The panel's host: shows it while you answer a raise and fades it out after. */
export function TrucoPanel({ m, open, deadline, pos }: { m: Model; open: boolean; deadline: { seat: number; at: number | null } | null; pos: string }) {
  const reducedMotion = useMedia(REDUCED_MOTION);
  const dark = useMedia('(prefers-color-scheme: dark)');
  const last = useRef<Panel | null>(null);
  const [gone, setGone] = useState('');
  const before = useRef<HTMLElement | null>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const live = open ? panelOf(m, deadline) : null;
  if (live) last.current = live;
  const closing = !live && last.current && gone !== last.current.key ? last.current : null;
  const key = live?.key ?? '';

  // Opening: remember where focus was; put it on "Aceito" when it was in the game.
  useEffect(() => {
    if (!live) return;
    const a = document.activeElement as HTMLElement | null;
    if (!a?.closest('.truco')) before.current = a;
    if (!inGame()) return;
    // Checked again when it runs: with reduced motion it waits a beat, and the person may leave the game meanwhile.
    const go = () => {
      if (inGame()) accept.current?.focus({ preventScroll: true });
    };
    if (reducedMotion) {
      const id = setTimeout(go, TRUCO_REDUCED_BEAT);
      return () => clearTimeout(id);
    }
    go();
  }, [key]);

  // Closing: fade out, then give focus back to where it was, or to the hand.
  const closingKey = closing?.key ?? '';
  useEffect(() => {
    if (!closingKey) return;
    const id = setTimeout(
      () => {
        const panelHeld = () => {
          const a = document.activeElement;
          return !a || a === document.body || !!a.closest('.truco');
        };
        setGone(closingKey);
        if (!panelHeld()) return;
        requestAnimationFrame(() => {
          // Focus left for the footer or the header during that frame: it stays there.
          if (!panelHeld()) return;
          const back = before.current;
          if (back && back.isConnected && back !== document.body && !back.closest('.truco') && back.offsetParent !== null) back.focus({ preventScroll: true });
          else focusHand();
          before.current = null;
        });
      },
      reducedMotion ? TRUCO_OUT_REDUCED : TRUCO_OUT,
    );
    return () => clearTimeout(id);
  }, [closingKey]);

  const p = live ?? closing;
  if (!p) return null;
  const isClosing = !live;
  const letters = [...p.word];
  const act = (a: number) => {
    if (isClosing) return;
    currentController()?.act(a);
  };
  return (
    <section
      key={p.key}
      class={`truco${isClosing ? ' is-closing' : ''}`}
      role="alertdialog"
      aria-label={p.aria}
      aria-describedby="truco-value truco-context"
      data-testid={isClosing ? undefined : 'truco-panel'}
    >
      <Wall pos={pos} dark={dark} />
      <div class="truco__stage">
        <div class="truco__content">
          <p class="truco__who">
            {p.persona ? <Avatar persona={p.persona} /> : <Avatar initial={p.callerName} />}
            <span>{t('truco.who', { name: p.callerName })}</span>
            {p.ai ? <AiMark /> : null}
          </p>
          <h2 class="truco__word" aria-label={p.word} style={{ '--word-cols': String(wordCols(letters.length)), '--word-len': String(letters.length) }}>
            {letters.map((ch, i) => (
              <span key={i} class="truco__letter" style={{ '--i': String(i) }} aria-hidden="true">
                <span>{ch}</span>
              </span>
            ))}
          </h2>
        </div>
      </div>
      <div class="truco__answers">
        <div class="truco__time" aria-hidden="true">
          {p.deadline ? <span style={{ animationDuration: `${p.deadline.durationMs}ms`, animationDelay: `${-p.deadline.elapsedMs}ms` }} /> : null}
        </div>
        <p class="truco__value" id="truco-value">
          {p.value}
        </p>
        <p class="truco__context" id="truco-context">
          {p.context}
        </p>
        <div class="truco__buttons">
          <button
            type="button"
            ref={accept}
            class="btn btn--primary"
            data-testid={isClosing ? undefined : 'action-accept'}
            aria-keyshortcuts="A"
            aria-disabled={isClosing || !can(m, A_ACCEPT) ? 'true' : undefined}
            onClick={() => act(A_ACCEPT)}
          >
            {t('action.accept')}
            <kbd class="kbd-only" aria-hidden="true">
              A
            </kbd>
          </button>
          <button
            type="button"
            class="btn btn--outline"
            data-testid={isClosing ? undefined : 'action-run'}
            aria-keyshortcuts="C"
            aria-disabled={isClosing || !can(m, A_RUN) ? 'true' : undefined}
            onClick={() => act(A_RUN)}
          >
            {t('action.run')}
            <kbd class="kbd-only" aria-hidden="true">
              C
            </kbd>
          </button>
          {p.raise ? (
            <button
              type="button"
              class="btn btn--alert truco__raise"
              data-testid={isClosing ? undefined : 'action-raise'}
              aria-keyshortcuts="T"
              aria-disabled={isClosing || !can(m, A_RAISE) ? 'true' : undefined}
              onClick={() => act(A_RAISE)}
            >
              {p.raise}
              <kbd class="kbd-only" aria-hidden="true">
                T
              </kbd>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
