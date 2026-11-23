// The data page's poller of the live counters (DATA-SPEC 2.4): a request at load, then one every
// minute while the tab is visible; hidden stops the timer and visible again asks at once; after 30
// polls without a pointer, key or scroll event it pauses until the person resumes it; a failed
// request keeps the last numbers. It lives in the data chunk: live.ts (entry) keeps one fetch.

import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchLive, type LiveCounters } from '../live.ts';

/** Poll period and the polls without any interaction before the data page stops asking. */
export const LIVE_PERIOD_MS = 60_000;
export const LIVE_IDLE_POLLS = 30;

/** What the data page's strip shows: the last numbers, whether the last request worked, and the pause. */
export interface LiveState {
  live: LiveCounters | null;
  /** The last request answered (false greys the dot; the numbers stay). */
  ok: boolean;
  /** Polling stopped after LIVE_IDLE_POLLS polls without interaction ("Atualizar"). */
  paused: boolean;
  /** Requests made so far (the data page fetches the summary again on every fifth). */
  polls: number;
}

/** What the poller needs from the browser; the unit tests pass fakes. */
export interface PollEnv {
  fetchLive(): Promise<LiveCounters | null>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  visible(): boolean;
  /** Subscribes to visibility changes and to interaction; returns the unsubscribe. */
  listen(onVisibility: () => void, onActivity: () => void): () => void;
}

/**
 * The polling rules of DATA-SPEC 2.4: a request at start; with `poll`, one every period while the
 * page is visible (hidden stops the timer, visible again asks at once and restarts it); after
 * LIVE_IDLE_POLLS requests without interaction it pauses until resume(). Without `poll`, one
 * request and nothing else.
 */
export class LivePoller {
  state: LiveState = { live: null, ok: true, paused: false, polls: 0 };
  private timer: unknown = null;
  private idle = 0;
  private off: (() => void) | null = null;
  private stopped = false;
  private readonly env: PollEnv;
  private readonly poll: boolean;
  private readonly onChange: (s: LiveState) => void;

  constructor(env: PollEnv, poll: boolean, onChange: (s: LiveState) => void) {
    this.env = env;
    this.poll = poll;
    this.onChange = onChange;
  }

  start(): void {
    void this.ask();
    if (!this.poll) return;
    this.off = this.env.listen(
      () => (this.env.visible() ? this.wake() : this.halt()),
      () => (this.idle = 0),
    );
    if (this.env.visible()) this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.halt();
    this.off?.();
  }

  resume(): void {
    if (!this.state.paused) return;
    this.idle = 0;
    this.set({ paused: false });
    this.wake();
  }

  private wake(): void {
    if (this.state.paused || this.stopped) return;
    this.halt();
    void this.ask();
    this.arm();
  }

  private arm(): void {
    this.halt();
    if (this.state.paused || this.stopped) return;
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      void this.ask();
      this.arm();
    }, LIVE_PERIOD_MS);
  }

  private halt(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  private async ask(): Promise<void> {
    if (this.poll && ++this.idle > LIVE_IDLE_POLLS) {
      this.halt();
      this.set({ paused: true });
      return;
    }
    const polls = this.state.polls + 1;
    this.set({ polls });
    const live = await this.env.fetchLive();
    if (this.stopped) return;
    this.set(live ? { live, ok: true } : { ok: false });
  }

  private set(p: Partial<LiveState>): void {
    this.state = { ...this.state, ...p };
    this.onChange(this.state);
  }
}

const browserEnv: PollEnv = {
  fetchLive,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  visible: () => document.visibilityState === 'visible',
  listen(onVisibility, onActivity) {
    const opts = { passive: true };
    document.addEventListener('visibilitychange', onVisibility);
    for (const e of ['pointerdown', 'keydown', 'scroll']) addEventListener(e, onActivity, opts);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      for (const e of ['pointerdown', 'keydown', 'scroll']) removeEventListener(e, onActivity);
    };
  },
};

/** The data page's poller: the state and the button that resumes it. */
export function useLivePoll(poll: boolean): LiveState & { resume(): void } {
  const [state, setState] = useState<LiveState>({ live: null, ok: true, paused: false, polls: 0 });
  const ref = useRef<LivePoller | null>(null);
  useEffect(() => {
    const p = new LivePoller(browserEnv, poll, setState);
    ref.current = p;
    p.start();
    return () => p.stop();
  }, [poll]);
  return { ...state, resume: () => ref.current?.resume() };
}
