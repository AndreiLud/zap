// The table's controller for the guided first match (CLIENT-SPEC 10.5 and 11.1). It plays the role
// of the room's server in the browser: the practice hand runs on the engine in a Web Worker
// (engine.worker.ts, engine-host.ts), which answers each move with the events seat 0 may see and
// the observation after them. This controller wraps them in the same game messages a room sends
// (display offsets, a deadline with no clock) and fills the same store fields as RoomController
// (room, game, view, feed, bubbles) through the same Playback, so table/Table.tsx renders it
// unchanged. Nothing is sent to the server.
//
// The coach (coach.ts) hears every event when the table shows it. While a coach step waits for
// "Continuar", the AI seats wait too; the person may still play, which skips the explanation. The
// next hand's deal closes the stream as in a room, and the playback holds before it (beforeDeal),
// so the lesson ends with the deck back on the tile.
//
// ?cena=antes|meio|truco|fim opens the lesson at a fixed point (screenshots and tests); ?demo=1
// plays the whole hand alone and sets window.__zapDemoDone at the end.

import { manilhaRankForVira } from '../../../engine/src/cards.ts';
import type { PhraseKey, PublicRoom } from '../../../shared/protocol.ts';
import { navigate } from '../actions.ts';
import { currentController, setController, type TableController } from '../controller.ts';
import type { Key } from '../i18n.ts';
import { newId, store, type FeedItem, type RoomMsg } from '../store.ts';
import { Playback, predealFrom, type GameMsg } from '../table-view.ts';
import { CoachModel } from './coach.ts';
import { GUIDED_CODE, GUIDED_HANDS, GUIDED_STRENGTH, GUIDED_VIRA, IARA, YOU } from './constants.ts';
import type { GuidedReply, GuidedRequest, GuidedState, SceneName } from './engine-host.ts';

export type Scene = 'antes' | SceneName;
export type Phase = 'intro' | 'playing' | 'outro';

export interface GuidedOptions {
  demo: boolean;
  scene: Scene | null;
}

/** ?demo=1 and ?cena= from the address (anything else is ignored). */
export function guidedOptions(search: string): GuidedOptions {
  const p = new URLSearchParams(search);
  const cena = p.get('cena');
  return {
    demo: p.get('demo') === '1',
    scene: cena === 'antes' || cena === 'meio' || cena === 'truco' || cena === 'fim' ? cena : null,
  };
}

/** Pause of the demo between its own moves. */
export const DEMO_GAP_MS = 600;
/** Time the table needs after the hand event (count, cards back to the deck) before the demo ends. */
export const HAND_END_PAUSE_MS = 1600;
const FEED_MAX = 40;
const BUBBLE_MS = 4_000;
const NOTICE_MS = 4_000;
const PHRASE_GAP_MS = 5_000;

declare global {
  interface Window {
    __zapDemoDone?: boolean;
  }
}

function newCoach(): CoachModel {
  return new CoachModel({ you: YOU, partner: IARA, dealt: GUIDED_HANDS[YOU], strength: GUIDED_STRENGTH, manilhaRank: manilhaRankForVira(GUIDED_VIRA) });
}

/** The practice hand in its worker: requests answered in order. */
class EngineLink {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly waiting = new Map<number, (r: GuidedReply) => void>();

  constructor(onError: () => void) {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ id: number; reply: GuidedReply }>) => {
      const done = this.waiting.get(e.data.id);
      this.waiting.delete(e.data.id);
      done?.(e.data.reply);
    };
    this.worker.onerror = onError;
  }

  call(req: GuidedRequest): Promise<GuidedReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, req });
    });
  }

  close(): void {
    this.worker.terminate();
    this.waiting.clear();
  }
}

export class LocalController implements TableController {
  readonly kind = 'local' as const;
  phase: Phase = 'intro';
  coach: CoachModel = newCoach();
  private readonly playback: Playback;
  private readonly opts: GuidedOptions;
  private engine: EngineLink | null = null;
  /** The hand as of the last reply of the worker. */
  private state: GuidedState | null = null;
  /** A request is on its way to the worker: nothing else is sent until it answers. */
  private busy = false;
  /** Bumped by "Repetir": a reply of the hand before is dropped. */
  private lesson = 0;
  private seq = 0;
  private matchNo = 1;
  private disposed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private pumpQueued = false;
  private demoTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private handShownAt = 0;
  /** The next hand's deal waits on this forever: the lesson ends with the deck back on the tile. */
  private readonly hold = new Promise<void>(() => {});

  constructor(opts: GuidedOptions) {
    this.opts = opts;
    this.playback = new Playback(
      {
        view: (v, playing) => {
          if (this.disposed) return;
          store.set({ view: v, playing });
          if (!playing) this.queuePump();
        },
        event: (e, msg) => {
          if (this.disposed) return;
          // As in a room: the match event already says who won a single game; muted signals stay out.
          if (e.t === 'game' && msg.obs.options.bestOf !== 3) return;
          if (!(e.t === 'signal' && e.seat !== YOU && store.get().muteOthers)) {
            this.pushFeed({ id: newId(), kind: 'event', e, you: YOU, players: msg.obs.players });
          }
          this.coach.onEvent(e);
          if (e.t === 'hand') this.handShownAt = performance.now();
          this.changed();
        },
      },
      { beforeDeal: (hand) => (hand > 0 ? this.hold : undefined) },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Life cycle (pages/Guided.tsx)

  /** Re-renders the page when the lesson moves (the coach is not in the store). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
    if (this.opts.demo) this.queueDemo();
  }

  /** The hand is ready to be shown (the worker answered once). */
  get ready(): boolean {
    return this.state !== null;
  }

  mount(): void {
    setController(this);
    store.set({
      conn: 'online',
      roomProblem: null,
      room: this.roomMsg(),
      game: null,
      view: null,
      playing: false,
      clockOffset: 0,
      feed: [],
      bubbles: {},
      cover: false,
      sending: false,
      notice: null,
      noticeLimit: null,
      phraseReadyAt: 0,
    });
    this.engine = new EngineLink(() => {
      if (!this.disposed) this.notice('error.generic');
    });
    const scene = this.opts.scene;
    if (scene && scene !== 'antes') void this.playScene(scene);
    else void this.request({ op: 'new' }).then((r) => r && this.showBeforeDeal());
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    if (this.demoTimer !== null) clearTimeout(this.demoTimer);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.engine?.close();
    this.playback.stop();
    this.listeners.clear();
    // Another page (a room) may already own the table: leave its state alone.
    if (currentController() === this) {
      setController(null);
      store.set({ room: null, game: null, view: null, playing: false, feed: [], bubbles: {}, cover: false, sending: false });
    }
  }

  private later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
  }

  /** One request to the worker; null when the page went away or the lesson restarted meanwhile. */
  private async request(req: GuidedRequest): Promise<GuidedReply | null> {
    if (!this.engine || this.disposed) return null;
    const lesson = this.lesson;
    this.busy = true;
    const r = await this.engine.call(req);
    this.busy = false;
    if (this.disposed || lesson !== this.lesson) return null;
    this.state = r.state;
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // Messages, as a room would send them

  private roomMsg(): RoomMsg {
    const seat = (n: number, persona: 'zap' | 'iara' | 'bento' | null, name: string): PublicRoom['seats'][number] => ({
      seat: n,
      kind: persona ? 'ai' : 'human',
      name,
      persona,
      verified: false,
      connected: true,
      aiPlaying: false,
    });
    const now = Date.now();
    return {
      t: 'room',
      now,
      you: YOU,
      owner: true,
      room: {
        code: GUIDED_CODE,
        status: 'playing',
        settings: { mode: 'solo', players: 4, variant: 'paulista', options: {}, opponents: ['zap', 'bento'], partner: 'iara', turnSeconds: null },
        seats: [seat(0, null, ''), seat(1, 'zap', 'Zap'), seat(2, 'iara', 'Iara'), seat(3, 'bento', 'Bento')],
        matchNo: this.matchNo,
        score: [0, 0],
        games: [0, 0],
        lastWinner: -1,
        aiVersion: '',
        expiresAt: now + 3_600_000,
      },
    };
  }

  /** One game message: the events to show and seat 0's observation after them, with no clock. */
  private send(events: GameMsg['events']): void {
    const st = this.state;
    if (!st) return;
    const m: GameMsg = {
      t: 'game',
      now: Date.now(),
      seq: ++this.seq,
      matchNo: this.matchNo,
      obs: st.obs,
      events,
      deadline: st.deadlineSeat === null ? null : { seat: st.deadlineSeat, at: null },
    };
    store.set({ game: m, sending: false });
    this.playback.push(m);
  }

  /** The table before a deal, drawn in place: deck on the tile, vira and manilha still to come. */
  private showBeforeDeal(): void {
    this.send([]);
    const o = this.state?.obs;
    if (!o) return;
    this.playback.local((x) => Object.assign(x, predealFrom(x, { hand: o.handIndex, dealer: o.dealer, mao: o.mao, kind: o.kind, onzeTeam: o.onzeTeam })));
    this.changed();
  }

  private pushFeed(item: FeedItem): void {
    store.set((s) => ({ feed: [...s.feed, item].slice(-FEED_MAX) }));
  }

  // -------------------------------------------------------------------------------------------
  // The lesson

  /** "Start": the deal. */
  start(): void {
    if (this.disposed || this.phase !== 'intro' || !this.state || this.busy) return;
    void this.request({ op: 'start' }).then((r) => {
      if (!r) return;
      this.phase = 'playing';
      this.send(r.events);
      this.changed();
    });
  }

  /** "Continuar". */
  next(): void {
    if (this.phase !== 'playing') return;
    this.coach.next();
    this.changed();
    // The table stays on the deck before the next deal (held), so the lesson closes from here.
    if (this.state?.ended && this.coach.finished) this.toOutro();
    else this.queuePump();
  }

  /** "Repeat the practice hand": the same hand from the deal. */
  restart(): void {
    if (this.disposed) return;
    this.lesson++;
    this.busy = false;
    this.playback.stop();
    this.coach = newCoach();
    this.matchNo++;
    this.phase = 'intro';
    store.set({ room: this.roomMsg(), feed: [], bubbles: {}, cover: false, sending: false });
    void this.request({ op: 'new' }).then((r) => {
      if (!r) return;
      this.showBeforeDeal();
      this.start();
    });
  }

  private queuePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    this.later(() => {
      this.pumpQueued = false;
      this.pump();
    }, 0);
  }

  /** After the table showed everything: explain, let the person play, or move the AI seats. */
  private pump(): void {
    const st = this.state;
    if (this.disposed || this.phase !== 'playing' || this.playback.playing || this.busy || !st || !st.started) return;
    if (st.ended) {
      if (this.coach.finished) this.toOutro();
      return;
    }
    if (this.coach.readPending()) return;
    if (st.humanTurn) {
      if (st.phase === 'play' && this.coach.onTurn()) this.changed();
      return;
    }
    void this.request({ op: 'ai' }).then((r) => r && r.events.length && this.send(r.events));
  }

  private toOutro(): void {
    if (this.phase === 'outro') return;
    this.phase = 'outro';
    this.changed();
    if (this.opts.demo) this.later(() => (window.__zapDemoDone = true), Math.max(0, this.handShownAt + HAND_END_PAUSE_MS - performance.now()));
  }

  /** ?cena=: the worker plays the demo moves up to the scene; the coach hears it all, and the table shows that moment without animation. */
  private async playScene(scene: Exclude<Scene, 'antes'>): Promise<void> {
    const r = await this.request({ op: 'scene', scene });
    if (!r) return;
    for (const step of r.scene ?? []) {
      // What the person would have read before each move.
      this.coach.skipReads();
      if (step.t === 'turn') this.coach.onTurn();
      else for (const te of step.events) this.hearAtOnce(te.e);
    }
    if (scene === 'fim') {
      this.coach.skipReads();
      this.phase = 'outro';
      // Hand counted, deck back on the tile.
      this.showBeforeDeal();
      return;
    }
    // "truco": the Zap's call waits for the answer; "meio": "Agora a mão vale 3." waits for "Continue".
    if (scene === 'truco') this.coach.skipReads();
    this.phase = 'playing';
    this.send([]);
    this.changed();
  }

  /** An event of a scene: the coach and the hand log hear it, as if the table had shown it. */
  private hearAtOnce(e: GameMsg['events'][number]['e']): void {
    if (e.t === 'deal' && e.hand > 0) return;
    if (!(e.t === 'signal' && e.seat !== YOU && store.get().muteOthers)) {
      this.pushFeed({ id: newId(), kind: 'event', e, you: YOU, players: 4 });
    }
    this.coach.onEvent(e);
  }

  // -------------------------------------------------------------------------------------------
  // ?demo=1

  private queueDemo(): void {
    if (this.demoTimer !== null) clearTimeout(this.demoTimer);
    this.demoTimer = setTimeout(() => {
      this.demoTimer = null;
      this.demoStep();
    }, DEMO_GAP_MS);
  }

  private demoStep(): void {
    if (this.disposed) return;
    const st = this.state;
    if (!st || this.busy) return this.queueDemo();
    if (this.phase === 'intro') return this.start();
    if (this.phase !== 'playing') return;
    // After the hand the playback stays held before the next deal: read the last card and close.
    if (st.ended && this.coach.readPending()) return this.next();
    if (this.playback.playing) return this.queueDemo();
    if (this.coach.readPending()) return this.next();
    if (st.humanTurn && st.demoAction >= 0) return this.act(st.demoAction);
    // The AI seats are moving: look again in a moment.
    this.queueDemo();
  }

  // -------------------------------------------------------------------------------------------
  // TableController

  act(a: number): void {
    if (this.disposed || this.phase !== 'playing' || this.busy || !this.state) return;
    const v = this.playback.view;
    if (!v || this.playback.playing || !(v.legal & (1 << a)) || !(this.state.legal & (1 << a))) return;
    // Playing skips whatever the coach was still explaining.
    this.coach.skipReads();
    store.set({ cover: false, sending: true });
    // The card leaves the hand at once, as in a room.
    this.playback.local((x) => {
      if (a < 6) x.hand[a % 3] = -1;
      x.legal = 0;
    });
    this.changed();
    void this.request({ op: 'human', a }).then((r) => {
      if (!r) return;
      if (r.events.length) this.send(r.events);
      else store.set({ sending: false });
    });
  }

  phrase(key: PhraseKey): void {
    const now = Date.now();
    if (now < store.get().phraseReadyAt) {
      this.notice('notice.too_fast');
      return;
    }
    store.set({ phraseReadyAt: now + PHRASE_GAP_MS });
    this.pushFeed({ id: newId(), kind: 'phrase', seat: YOU, key, you: YOU });
    const id = newId();
    store.set((s) => ({ bubbles: { ...s.bubbles, [YOU]: { key, id } } }));
    this.later(() => {
      store.set((s) => {
        if (s.bubbles[YOU]?.id !== id) return {};
        const b = { ...s.bubbles };
        delete b[YOU];
        return { bubbles: b };
      });
    }, BUBBLE_MS);
  }

  /** "Jogar de novo" has no match end here; it repeats the practice hand. */
  rematch(): void {
    this.restart();
  }

  /** Nobody plays for the person in the practice hand: there is no clock. */
  resume(): void {}

  leave(): void {
    navigate({ name: 'play' });
  }

  notice(key: Key): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    store.set({ notice: key, noticeLimit: null });
    this.noticeTimer = setTimeout(() => store.set({ notice: null }), NOTICE_MS);
  }
}
