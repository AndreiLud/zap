// The ads structure (CLIENT-SPEC 16.3 and 16.4, web/src/ads): when a pause point is skipped at once,
// the interval between breaks, the consent, the 3 s guard, the order of the hold messages around a
// break between solo hands, and the loader's calls to Google's queue. Fake timers; the queue, the
// script loader and every other side effect are injected, so nothing here touches a network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_MS, MAX_BREAK_MS, PLACEMENT, createAds, parseAdsConfig, readConsent, type AdsConfig, type AdsDeps, type PausePoint } from '../src/ads/index.ts';
import { SCRIPT_URL, loadAds, scriptAttrs, type AdsApi, type LoaderDeps, type Placement } from '../src/ads/loader.ts';
import { NOTICE_VERSION, noticeVersion } from '../src/consent-keys.ts';

const CFG: AdsConfig = { client: 'ca-pub-0123456789012345', test: true, minIntervalS: 120, hold: true };

/** A fake placement API that records each placement; the test plays Google's callbacks. */
function fakeApi() {
  const placements: Placement[] = [];
  const api: AdsApi = { adBreak: (p) => void placements.push(p) };
  return { api, placements };
}

function deps(over: Partial<AdsDeps> = {}) {
  const log: string[] = [];
  const fake = fakeApi();
  let last: number | null = null;
  const d: AdsDeps = {
    config: async () => CFG,
    load: vi.fn(async () => fake.api),
    consent: () => 'yes',
    lastBreak: () => last,
    setLastBreak: (at) => {
      last = at;
      log.push(`last ${at}`);
    },
    hidden: () => false,
    now: () => Date.now(),
    hold: (on) => {
      log.push(`hold ${on}`);
      return true;
    },
    suspendSound: () => log.push('suspend'),
    resumeSound: () => log.push('resume'),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    ...over,
  };
  return { d, log, placements: fake.placements };
}

/** Lets the awaited config and loader settle. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T15:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ads: when a break is skipped at once', () => {
  it('ads off: skipped, and the loader is never asked for', async () => {
    const { d } = deps({ config: async () => null });
    const ads = createAds(d);
    for (const p of Object.keys(PLACEMENT) as PausePoint[]) expect(await ads.requestBreak(p)).toBe('skipped');
    expect(d.load).not.toHaveBeenCalled();
  });

  it('a config that failed counts as off', async () => {
    const { d } = deps({ config: async () => Promise.reject(new Error('network')) });
    expect(await createAds(d).requestBreak('room.matchEnd')).toBe('skipped');
    expect(d.load).not.toHaveBeenCalled();
  });

  it('no consent, or a no: skipped, nothing loaded', async () => {
    for (const consent of [null, 'no'] as const) {
      const { d } = deps({ consent: () => consent });
      expect(await createAds(d).requestBreak('room.matchEnd')).toBe('skipped');
      expect(d.load).not.toHaveBeenCalled();
    }
  });

  it('a hidden page: skipped', async () => {
    const { d } = deps({ hidden: () => true });
    expect(await createAds(d).requestBreak('solo.betweenMatches')).toBe('skipped');
  });

  it('between solo hands without the server hold: skipped, other points go on', async () => {
    const { d, placements } = deps({ config: async () => ({ ...CFG, hold: false }) });
    const ads = createAds(d);
    expect(await ads.requestBreak('solo.betweenHands')).toBe('skipped');
    expect(placements).toHaveLength(0);
    void ads.requestBreak('room.lobby');
    await flush();
    expect(placements).toHaveLength(1);
  });

  it('the script failed or was blocked: skipped, with no message, and not loaded again in this page', async () => {
    const { d, log } = deps({ load: vi.fn(async () => null) });
    const ads = createAds(d);
    expect(await ads.requestBreak('room.matchEnd')).toBe('skipped');
    expect(await ads.requestBreak('room.matchEnd')).toBe('skipped');
    expect(d.load).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);
  });
});

describe('ads: a break', () => {
  it('shown between solo hands: sound off and the clock held while the ad runs, both back after, in that order', async () => {
    const { d, log, placements } = deps();
    const result = createAds(d).requestBreak('solo.betweenHands');
    await flush();
    expect(placements).toHaveLength(1);
    const p = placements[0];
    expect(p.type).toBe('next');
    p.beforeAd!();
    p.afterAd!();
    p.adBreakDone!({ breakStatus: 'viewed' });
    expect(await result).toBe('shown');
    expect(log).toEqual(['suspend', 'hold true', 'resume', 'hold false', `last ${Date.now()}`]);
  });

  it('adBreakDone without afterAd still gives the sound and the clock back, once', async () => {
    const { d, log, placements } = deps();
    const result = createAds(d).requestBreak('solo.betweenHands');
    await flush();
    placements[0].beforeAd!();
    placements[0].adBreakDone!({ breakStatus: 'viewed' });
    placements[0].afterAd!();
    expect(await result).toBe('shown');
    expect(log.filter((l) => l.startsWith('hold'))).toEqual(['hold true', 'hold false']);
    expect(log.filter((l) => l === 'resume')).toHaveLength(1);
  });

  it('only the pause between solo hands holds the clock', async () => {
    for (const point of ['solo.betweenMatches', 'room.matchEnd', 'room.lobby'] as const) {
      const { d, log, placements } = deps();
      const result = createAds(d).requestBreak(point);
      await flush();
      expect(placements[0].type).toBe(PLACEMENT[point]);
      placements[0].beforeAd!();
      placements[0].afterAd!();
      placements[0].adBreakDone!({ breakStatus: 'viewed' });
      expect(await result).toBe('shown');
      expect(log.some((l) => l.startsWith('hold'))).toBe(false);
    }
    expect(PLACEMENT['room.lobby']).toBe('browse');
  });

  it('Google said no ad (frequency capped, not ready...): skipped, and the interval does not start', async () => {
    const { d, log, placements } = deps();
    const result = createAds(d).requestBreak('room.matchEnd');
    await flush();
    placements[0].adBreakDone!({ breakStatus: 'frequencyCapped' });
    expect(await result).toBe('skipped');
    expect(log).toEqual([]);
  });

  it('the 3 s guard: nothing happened, so the game goes on', async () => {
    const { d, log } = deps();
    const result = createAds(d).requestBreak('solo.betweenHands');
    await flush();
    await vi.advanceTimersByTimeAsync(GUARD_MS - 1);
    let done = false;
    void result.then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('skipped');
    expect(log).toEqual([]);
  });

  it('an ad that started is not cut by the 3 s guard, but one that never ends lets go after two minutes', async () => {
    const { d, log, placements } = deps();
    const result = createAds(d).requestBreak('solo.betweenHands');
    await flush();
    placements[0].beforeAd!();
    await vi.advanceTimersByTimeAsync(GUARD_MS * 5);
    expect(log).toEqual(['suspend', 'hold true']);
    await vi.advanceTimersByTimeAsync(MAX_BREAK_MS);
    expect(await result).toBe('skipped');
    expect(log).toEqual(['suspend', 'hold true', 'resume', 'hold false']);
  });

  it('a late callback after the guard changes nothing', async () => {
    const { d, log, placements } = deps();
    const result = createAds(d).requestBreak('solo.betweenHands');
    await flush();
    await vi.advanceTimersByTimeAsync(GUARD_MS);
    expect(await result).toBe('skipped');
    placements[0].beforeAd!();
    placements[0].afterAd!();
    placements[0].adBreakDone!({ breakStatus: 'viewed' });
    expect(log).toEqual([]);
  });

  it('one break at a time', async () => {
    const { d, placements } = deps();
    const ads = createAds(d);
    const first = ads.requestBreak('room.matchEnd');
    await flush();
    expect(await ads.requestBreak('room.lobby')).toBe('skipped');
    placements[0].beforeAd!();
    placements[0].adBreakDone!({ breakStatus: 'viewed' });
    expect(await first).toBe('shown');
  });
});

describe('ads: the interval', () => {
  it('no break within minIntervalS of the last one shown', async () => {
    const { d, placements } = deps();
    const ads = createAds(d);
    const first = ads.requestBreak('room.matchEnd');
    await flush();
    placements[0].beforeAd!();
    placements[0].adBreakDone!({ breakStatus: 'viewed' });
    expect(await first).toBe('shown');
    vi.setSystemTime(Date.now() + 119_000);
    expect(await ads.requestBreak('room.matchEnd')).toBe('skipped');
    expect(placements).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1_000);
    void ads.requestBreak('room.matchEnd');
    await flush();
    expect(placements).toHaveLength(2);
  });
});

describe('ads: configuration and consent', () => {
  it('/api/config: an object with a valid client is on; null, missing or invalid is off', () => {
    expect(parseAdsConfig({ ads: null })).toBeNull();
    expect(parseAdsConfig({ adsEnabled: true })).toBeNull();
    expect(parseAdsConfig(null)).toBeNull();
    expect(parseAdsConfig({ ads: { client: 'ca-pub-1', test: true, minIntervalS: 120 } })).toBeNull();
    expect(parseAdsConfig({ ads: { client: CFG.client, test: true, minIntervalS: 120 } })).toEqual({ ...CFG, hold: false });
    expect(parseAdsConfig({ ads: { client: CFG.client, test: 'yes', minIntervalS: 5 }, hold: true })).toEqual({ client: CFG.client, test: false, minIntervalS: 30, hold: true });
  });

  it('the consent belongs to the notice version with ads', () => {
    expect(noticeVersion(false)).toBe(NOTICE_VERSION);
    expect(noticeVersion(true)).toBe(`${NOTICE_VERSION}+ads`);
    const v = noticeVersion(true);
    expect(readConsent(`yes:${v}`, v)).toBe('yes');
    expect(readConsent(`no:${v}`, v)).toBe('no');
    expect(readConsent('yes:2026-01-01+ads', v)).toBeNull();
    expect(readConsent(null, v)).toBeNull();
    expect(readConsent('maybe', v)).toBeNull();
  });
});

describe('ads: the loader', () => {
  function loaderDeps(fail = false) {
    const calls: unknown[] = [];
    const d: LoaderDeps = {
      push: (o) => void calls.push(['push', o]),
      nonPersonalized: () => void calls.push(['nonPersonalized']),
      loadScript: async (src, attrs) => {
        calls.push(['script', src, attrs]);
        if (fail) throw new Error('blocked');
      },
    };
    return { d, calls };
  }

  it('asks for ads that are not personalized, configures preloading and sound, then adds the script', async () => {
    const { d, calls } = loaderDeps();
    const api = await loadAds(CFG, d);
    expect(api).not.toBeNull();
    expect(calls).toEqual([
      ['nonPersonalized'],
      ['push', { preloadAdBreaks: 'on', sound: 'on' }],
      ['script', `${SCRIPT_URL}?client=ca-pub-0123456789012345`, { crossorigin: 'anonymous', 'data-ad-frequency-hint': '120s', 'data-adbreak-test': 'on' }],
    ]);
    const p: Placement = { type: 'next', name: 'room_matchEnd' };
    api!.adBreak(p);
    expect(calls.at(-1)).toEqual(['push', p]);
  });

  it('test ads only in test mode', () => {
    expect(scriptAttrs({ ...CFG, test: false })).toEqual({ crossorigin: 'anonymous', 'data-ad-frequency-hint': '120s' });
  });

  it('a blocked script gives no API', async () => {
    const { d } = loaderDeps(true);
    expect(await loadAds(CFG, d)).toBeNull();
  });
});
