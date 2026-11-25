// The live counters (DATA-SPEC 2.4): the zap-live/1 answer becomes the counters, and the poller of
// the data page follows its rules: one request at start, one a minute while the page is visible,
// none while hidden (and one at once when visible again), a pause after 30 polls without any
// interaction, the last numbers kept when a request fails. Without polling, a single request.
// Every request to /api/live and /api/summary, from the data page, the Play page and "You against
// Zap", goes past the browser's cache.

import { afterEach, describe, expect, it, vi } from 'vitest';
import headline from '../src/data/generated/headline.json' with { type: 'json' };
import { fetchSummary } from '../src/data/load.ts';
import { LIVE_IDLE_POLLS, LIVE_PERIOD_MS, LivePoller, type LiveState, type PollEnv } from '../src/data/live-poll.ts';
import { fetchLive, parseLive, type LiveCounters } from '../src/live.ts';
import * as vsAnswers from '../src/you-vs-zap/public-answers.ts';

const answer = (over: Record<string, unknown> = {}) => ({
  schema: 'zap-live/1',
  at: 1_700_000_000_000,
  matches: 12,
  decisions: 345,
  current: 'v2',
  adapt: false,
  humansVsZap: { matches: 10, humanWins: 3 },
  ...over,
});

describe('parseLive', () => {
  it('maps zap-live/1 to the counters, with the training hands of the version in play', () => {
    expect(parseLive(answer())).toEqual({
      humanMatches: 12,
      humansVsZap: { matches: 10, humanWins: 3 },
      aiVersion: 'v2',
      trainingHands: headline.v2.trainingHands,
      updatedAt: 1_700_000_000_000,
      decisions: 345,
      adapt: false,
    });
  });

  it('gives zeros without a summary and null hands for a version without a training row', () => {
    const c = parseLive(answer({ humansVsZap: null, current: 'heuristic', adapt: true }))!;
    expect(c.humansVsZap).toEqual({ matches: 0, humanWins: 0 });
    expect(c.trainingHands).toBeNull();
    expect(c.adapt).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of [null, 'x', {}, answer({ schema: 'zap-live/2' }), answer({ matches: -1 }), answer({ decisions: 1.5 }), answer({ adapt: 'on' }), answer({ humansVsZap: { matches: 1 } })]) {
      expect(parseLive(bad)).toBeNull();
    }
  });
});

describe('the requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ask the network on every open, reload and poll, never a copy the browser kept', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url === '/api/live' ? answer() : { error: 'no_summary' }), { status: url === '/api/live' ? 200 : 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchLive())?.humanMatches).toBe(12);
    expect(await fetchSummary()).toEqual({ kind: 'none' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.cache])).toEqual([
      ['/api/live', 'no-cache'],
      ['/api/summary', 'no-cache'],
    ]);
  });

  it('of "You against Zap" ask the network every time too', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url === '/api/live' ? answer({ current: 'v3', adapt: true }) : { error: 'no_summary' }), { status: url === '/api/live' ? 200 : 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await vsAnswers.fetchLive()).toEqual({ version: 'v3', adapt: true });
    expect(await vsAnswers.fetchSummary()).toBeNull();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.cache, init?.credentials])).toEqual([
      ['/api/live', 'no-cache', 'same-origin'],
      ['/api/summary', 'no-cache', 'same-origin'],
    ]);
  });
});

/** A fake browser: a manual clock, a visibility flag and listeners the test fires. */
function fakeEnv(results: (LiveCounters | null)[]) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let visible = true;
  let onVis: () => void = () => {};
  let onAct: () => void = () => {};
  let calls = 0;
  const env: PollEnv = {
    fetchLive: async () => results[Math.min(calls++, results.length - 1)],
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    visible: () => visible,
    listen: (v, a) => {
      onVis = v;
      onAct = a;
      return () => {
        onVis = () => {};
        onAct = () => {};
      };
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    calls: () => calls,
    timers: () => timers.size,
    /** Moves the clock and runs the timers that are due. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    async hide() {
      visible = false;
      onVis();
      await flush();
    },
    async show() {
      visible = true;
      onVis();
      await flush();
    },
    act: () => onAct(),
    flush,
  };
}

const counters = (matches: number): LiveCounters => parseLive(answer({ matches }))!;

describe('LivePoller', () => {
  it('without polling asks once and sets no timer', async () => {
    const f = fakeEnv([counters(1)]);
    const states: LiveState[] = [];
    new LivePoller(f.env, false, (s) => states.push(s)).start();
    await f.flush();
    expect(f.calls()).toBe(1);
    expect(f.timers()).toBe(0);
    expect(states.at(-1)?.live?.humanMatches).toBe(1);
  });

  it('polls every minute while visible, stops while hidden and asks at once when visible again', async () => {
    const f = fakeEnv([counters(1), counters(2), counters(3), counters(4)]);
    const p = new LivePoller(f.env, true, () => {});
    p.start();
    await f.flush();
    expect(f.calls()).toBe(1);
    await f.advance(LIVE_PERIOD_MS);
    expect(f.calls()).toBe(2);
    await f.hide();
    expect(f.timers()).toBe(0);
    await f.advance(LIVE_PERIOD_MS * 5);
    expect(f.calls()).toBe(2);
    await f.show();
    expect(f.calls()).toBe(3);
    await f.advance(LIVE_PERIOD_MS);
    expect(f.calls()).toBe(4);
    expect(p.state.polls).toBe(4);
    p.stop();
    expect(f.timers()).toBe(0);
  });

  it('keeps the last numbers when a request fails and greys the dot', async () => {
    const f = fakeEnv([counters(7), null, counters(9)]);
    const p = new LivePoller(f.env, true, () => {});
    p.start();
    await f.flush();
    await f.advance(LIVE_PERIOD_MS);
    expect(p.state.ok).toBe(false);
    expect(p.state.live?.humanMatches).toBe(7);
    await f.advance(LIVE_PERIOD_MS);
    expect(p.state.ok).toBe(true);
    expect(p.state.live?.humanMatches).toBe(9);
  });

  it(`pauses after ${LIVE_IDLE_POLLS} polls without interaction; activity resets the count; resume asks again`, async () => {
    const f = fakeEnv([counters(1)]);
    const p = new LivePoller(f.env, true, () => {});
    p.start();
    await f.flush();
    await f.advance(LIVE_PERIOD_MS * 20);
    f.act();
    await f.advance(LIVE_PERIOD_MS * (LIVE_IDLE_POLLS - 1));
    expect(p.state.paused).toBe(false);
    const before = f.calls();
    await f.advance(LIVE_PERIOD_MS * 3);
    expect(p.state.paused).toBe(true);
    expect(f.calls()).toBe(before + 1);
    expect(f.timers()).toBe(0);
    await f.show();
    expect(f.calls()).toBe(before + 1);
    p.resume();
    await f.flush();
    expect(p.state.paused).toBe(false);
    expect(f.calls()).toBe(before + 2);
    expect(f.timers()).toBe(1);
  });
});
