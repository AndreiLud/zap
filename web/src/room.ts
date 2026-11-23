// The open room: its connection, the playback of game messages and the actions the person sends.
// Every action is a request; the server checks it and answers with the new state.

import { A_ACCEPT, A_RUN, PLAY_MASK } from '../../engine/src/engine.ts';
import type { ClientMsg, ErrorCode, LimitInfo, PhraseKey, ServerMsg } from '../../shared/protocol.ts';
import { requestBreak, setHoldSender } from './ads/index.ts';
import { ApiError, api } from './api.ts';
import { hasCredential, noteVerifiedUntil, requestHumanCheck } from './check.ts';
import { RoomSocket } from './connection.ts';
import { ensureReady } from './consent.ts';
import type { Key } from './i18n.ts';
import { defaultLimit, heldLimit, holdLimit, readLimit } from './limit.ts';
import { newId, serverNow, store, type FeedItem, type RoomProblem } from './store.ts';
import { Playback } from './table-view.ts';

const FEED_MAX = 40;
const BUBBLE_MS = 4_000;
const NOTICE_MS = 4_000;
/** The brake's message stays longer: it says when to come back. */
const LIMIT_NOTICE_MS = 12_000;
const PHRASE_GAP_MS = 5_000;

/** The move sent for the person when their time runs out in solo play: the first legal card. */
export function autoAction(legal: number): number {
  for (let a = 0; a < 3; a++) if (legal & (1 << a)) return a;
  if (legal & (1 << A_ACCEPT)) return A_ACCEPT;
  if (legal & (1 << A_RUN)) return A_RUN;
  for (let a = 0; a < 15; a++) if (legal & (1 << a)) return a;
  return -1;
}

const ERROR_NOTICE: Partial<Record<ErrorCode, Key>> = {
  too_fast: 'notice.too_fast',
  not_owner: 'notice.not_owner',
  seat_taken: 'notice.seat_taken',
  room_full: 'notice.room_full',
  not_in_lobby: 'notice.not_in_lobby',
  expired: 'notice.expired',
  needs_people: 'notice.needs_people',
};

export class RoomController {
  readonly code: string;
  private socket: RoomSocket | null = null;
  private readonly playback: Playback;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoSentSeq = -1;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly bubbleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private closed = false;
  private joined = false;

  constructor(code: string) {
    this.code = code;
    this.playback = new Playback(
      {
        view: (v, playing) => store.set({ view: v, playing }),
        event: (e, msg) => {
          // In a single game the match event already says who won; skip the game event.
          if (e.t === 'game' && msg.obs.options.bestOf !== 3) return;
          // Signals of the other seats stay out of the captions when the person muted them.
          if (e.t === 'signal' && e.seat !== msg.obs.seat && store.get().muteOthers) return;
          this.pushFeed({ id: newId(), kind: 'event', e, you: msg.obs.seat, players: msg.obs.players });
        },
      },
      {
        // The solo pause point between hands (CLIENT-SPEC 16.4): skipped at once while ads are off.
        beforeDeal: () => (store.get().room?.room.settings.mode === 'solo' ? requestBreak('solo.betweenHands') : undefined),
      },
    );
    // While an ad shows between solo hands the room holds the person's clock (CLIENT-SPEC 16.5).
    setHoldSender((on) => this.send({ t: 'hold', on }));
  }

  async open(): Promise<void> {
    store.set({
      conn: 'connecting',
      roomProblem: null,
      room: null,
      game: null,
      view: null,
      playing: false,
      feed: [],
      bubbles: {},
      cover: false,
      sending: false,
      notice: null,
      noticeLimit: null,
    });
    // The age gate and the notice come before anything about this person reaches the server.
    try {
      await ensureReady();
    } catch (e) {
      this.problem(e instanceof ApiError && e.code === 'age_under' ? 'age' : 'gate');
      return;
    }
    if (this.closed) return;
    if (!(await hasCredential())) {
      try {
        await requestHumanCheck();
      } catch {
        this.problem('check');
        return;
      }
    }
    if (this.closed) return;
    try {
      await api.room(this.code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.problem('not_found');
        return;
      }
      // Anything else: the socket will tell.
    }
    if (this.closed) return;
    this.connect();
    this.autoTimer = setInterval(() => this.checkAuto(), 250);
  }

  close(): void {
    this.closed = true;
    this.socket?.stop();
    this.socket = null;
    this.playback.stop();
    if (this.autoTimer !== null) clearInterval(this.autoTimer);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    // The brake's message belongs to this room's start; the next page does not show it.
    if (store.get().noticeLimit) store.set({ noticeLimit: null });
    for (const t of this.bubbleTimers.values()) clearTimeout(t);
    this.bubbleTimers.clear();
  }

  /** Tries again after a problem (human check cancelled, network). */
  retry(): void {
    if (this.closed) return;
    store.set({ roomProblem: null });
    this.socket?.stop();
    this.socket = null;
    if (this.autoTimer !== null) clearInterval(this.autoTimer);
    this.autoTimer = null;
    void this.open();
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/rooms/${this.code}/ws`;
    this.socket = new RoomSocket(url, {
      message: (m) => this.onMessage(m),
      state: (s) => {
        if (!this.closed) store.set({ conn: s });
      },
      ended: (reason) => {
        if (this.closed) return;
        if (reason === 'expired') this.problem('expired');
        else if (reason === 'blocked') this.problem('blocked');
        else if (reason === 'gone') this.problem('gone');
        else if (reason === 'replaced') this.problem('replaced');
        else if (reason === 'closed') this.problem('closed');
        else if (reason === 'forgotten') this.problem('forgotten');
      },
      refused: () => this.refused(),
    });
    this.socket.start();
  }

  private problem(p: RoomProblem): void {
    if (this.closed) return;
    store.set({ roomProblem: p, conn: 'offline' });
  }

  /** The socket was refused before opening: find out why. */
  private async refused(): Promise<'retry' | 'stop'> {
    if (this.closed) return 'stop';
    let info;
    try {
      info = await api.room(this.code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.problem('not_found');
        return 'stop';
      }
      return 'retry';
    }
    noteVerifiedUntil(null);
    if (!(await hasCredential())) {
      try {
        await requestHumanCheck();
        return 'retry';
      } catch {
        this.problem('check');
        return 'stop';
      }
    }
    if (!this.joined) {
      if (info.status !== 'lobby') {
        this.problem('started');
        return 'stop';
      }
      if (!info.seats.some((s) => s.kind === 'empty')) {
        this.problem('full');
        return 'stop';
      }
    }
    return 'retry';
  }

  private onMessage(m: ServerMsg): void {
    if (this.closed) return;
    switch (m.t) {
      case 'room':
        if (m.you !== null) this.joined = true;
        store.set({ room: m, clockOffset: m.now - Date.now() });
        break;
      case 'game': {
        const prev = store.get().game;
        store.set({ game: m, clockOffset: m.now - Date.now(), sending: false, ...(prev && prev.matchNo !== m.matchNo ? { cover: false } : {}) });
        this.playback.push(m);
        break;
      }
      case 'phrase': {
        const s = store.get();
        const you = s.room?.you ?? -1;
        if (s.muteOthers && m.seat !== you) return;
        this.pushFeed({ id: newId(), kind: 'phrase', seat: m.seat, key: m.key, you });
        this.showBubble(m.seat, m.key);
        break;
      }
      case 'error':
        this.onError(m.code, m.limit);
        break;
    }
  }

  private onError(code: ErrorCode, limit?: LimitInfo): void {
    store.set({ sending: false });
    const key = ERROR_NOTICE[code];
    if (key) this.notice(key);
    // The brake refused the start or the rematch: the match did not begin, and the person reads until when.
    if (code === 'limit_reached') {
      const l = readLimit(limit) ?? defaultLimit(Date.now());
      holdLimit(l);
      this.limitNotice(l);
    }
    if (code === 'too_fast') store.set({ phraseReadyAt: Date.now() + PHRASE_GAP_MS });
    // stale and not_your_turn come with the current state; anything else asks for it.
    if (code === 'illegal' || code === 'bad_message' || code === 'not_seated') this.send({ t: 'sync' });
    // Out of matches for this check: confirm again, then reconnect so the room sees the new credential.
    if (code === 'check_needed') {
      requestHumanCheck().then(
        () => this.retry(),
        () => this.notice('notice.check_needed'),
      );
    }
  }

  /** Stops or restarts the playback of game events where it is (an ad shows over the table). */
  holdPlayback(on: boolean): void {
    if (on) this.playback.pause();
    else this.playback.resume();
  }

  /** Takes the seat back from the AI that played for this person. */
  resume(): void {
    this.send({ t: 'resume' });
  }

  /** The brake's message (limit.ts), in place of any other notice. */
  private limitNotice(limit: LimitInfo): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    store.set({ notice: null, noticeLimit: limit });
    this.noticeTimer = setTimeout(() => store.set({ noticeLimit: null }), LIMIT_NOTICE_MS);
  }

  notice(key: Key): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    store.set({ notice: key, noticeLimit: null });
    this.noticeTimer = setTimeout(() => store.set({ notice: null }), NOTICE_MS);
  }

  private pushFeed(item: FeedItem): void {
    store.set((s) => ({ feed: [...s.feed, item].slice(-FEED_MAX) }));
  }

  private showBubble(seat: number, key: PhraseKey): void {
    const id = newId();
    store.set((s) => ({ bubbles: { ...s.bubbles, [seat]: { key, id } } }));
    const old = this.bubbleTimers.get(seat);
    if (old) clearTimeout(old);
    this.bubbleTimers.set(
      seat,
      setTimeout(() => {
        store.set((s) => {
          if (s.bubbles[seat]?.id !== id) return {};
          const b = { ...s.bubbles };
          delete b[seat];
          return { bubbles: b };
        });
      }, BUBBLE_MS),
    );
  }

  private send(msg: ClientMsg): boolean {
    return this.socket?.send(msg) ?? false;
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  act(a: number, auto = false): void {
    const g = this.playback.message;
    const v = this.playback.view;
    const s = store.get();
    if (!g || !v || s.sending || this.playback.playing) return;
    if (!(v.legal & (1 << a))) return;
    if (!this.send(auto ? { t: 'act', seq: g.seq, a, auto: true } : { t: 'act', seq: g.seq, a })) return;
    store.set({ sending: true, cover: false });
    // The card leaves the hand at once; the server's answer puts it on the table.
    this.playback.local((x) => {
      if (a < 6) x.hand[a % 3] = -1;
      x.legal = 0;
    });
  }

  sit(seat: number): void {
    this.send({ t: 'sit', seat });
  }

  start(): void {
    if (this.limitHeld()) return;
    this.send({ t: 'start' });
  }

  rematch(): void {
    if (this.limitHeld()) return;
    this.send({ t: 'rematch' });
  }

  /** A refusal of the brake the page still keeps (limit.ts holdLimit): shown again, nothing sent. */
  private limitHeld(): boolean {
    const held = heldLimit();
    if (held) this.limitNotice(held);
    return held !== null;
  }

  phrase(key: PhraseKey): void {
    const now = Date.now();
    if (now < store.get().phraseReadyAt) {
      this.notice('notice.too_fast');
      return;
    }
    if (this.send({ t: 'phrase', key })) store.set({ phraseReadyAt: now + PHRASE_GAP_MS });
  }

  /** Leaves the seat: in a match the AI takes it over; in the lobby the seat is freed. */
  leave(): void {
    const s = store.get();
    const owner = s.room?.owner === true;
    const lobby = s.room?.room.status === 'lobby';
    // In the lobby the owner's leave closes the room for everyone.
    void owner;
    void lobby;
    if (s.room?.you !== null && s.room?.room.status !== 'ended') this.send({ t: 'leave' });
  }

  private checkAuto(): void {
    const s = store.get();
    const g = this.playback.message;
    if (!g || !s.room || s.room.room.settings.mode !== 'solo' || this.playback.playing || s.sending) return;
    const d = g.deadline;
    if (!d || d.at === null || d.seat !== g.obs.seat || g.obs.over) return;
    if (serverNow() < d.at || this.autoSentSeq === g.seq) return;
    this.autoSentSeq = g.seq;
    const a = autoAction(g.obs.legal);
    if (a >= 0) this.act(a, true);
  }
}

/** Legal card slots in a mask (face up or face down). */
export function legalCards(legal: number, cover: boolean): number {
  return cover ? (legal >> 3) & PLAY_MASK : legal & PLAY_MASK;
}
