// Ads structure in test mode (CLIENT-SPEC 16): AdSense H5 games ads with the Ad Placement API, off
// by default. While /api/config answers `ads: null` (ADS_ENABLED is not "true"), nothing is loaded,
// reserved or declared: every pause point is skipped at once, AdsRoot renders nothing, and neither
// the loader chunk nor the consent dialog's chunk is ever requested. The table path never imports
// loader.ts or AdsConsent.tsx statically.
//
// On: the person answers the consent dialog first (only ads that are not personalized, for
// everyone; whoever says no plays the same, with no ads), stored in localStorage['zap-ads'] with the
// notice version. A break then needs: the consent, at least minIntervalS since the last break shown
// in this tab (sessionStorage), the script loaded, the page visible, and for the pause between solo
// hands the server's hold (16.5, after the training freeze). A failed or blocked ad never shows a
// message: the game goes on.

import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { noticeVersion } from '../consent-keys.ts';
import { isAdult } from '../consent.ts';
import { lazyComponent } from '../lazy.tsx';
import { sound } from '../sound/index.ts';
import { useStoreSelect } from '../store.ts';
import type { AdsApi, BreakDone, Placement } from './loader.ts';

export type PausePoint = 'solo.betweenHands' | 'solo.betweenMatches' | 'room.matchEnd' | 'room.lobby';
export type BreakResult = 'shown' | 'skipped';

/** /api/config `ads` when ads are on. */
export interface AdsConfig {
  client: string;
  test: boolean;
  minIntervalS: number;
  /** The server holds the solo clock between hands ({ t: 'hold' }, WP6b): /api/config `hold`. */
  hold: boolean;
}

export const CONSENT_KEY = 'zap-ads';
export const LAST_BREAK_KEY = 'zap-ads-last';
/** A break that has not started this long after it was asked for counts as skipped. */
export const GUARD_MS = 3_000;
/** A break that started but never ended lets the game go on after this long. */
export const MAX_BREAK_MS = 120_000;

/** Placement types: "next" at a natural pause in the game, "browse" while waiting in the lobby. Full screen only, never a reward. */
export const PLACEMENT: Record<PausePoint, Placement['type']> = {
  'solo.betweenHands': 'next',
  'solo.betweenMatches': 'next',
  'room.matchEnd': 'next',
  'room.lobby': 'browse',
};

/** Reads /api/config defensively: `ads` must be an object with a valid client id, or ads are off. */
export function parseAdsConfig(raw: unknown): AdsConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as { ads?: unknown; hold?: unknown };
  const a = c.ads as { client?: unknown; test?: unknown; minIntervalS?: unknown } | null | undefined;
  if (!a || typeof a !== 'object' || typeof a.client !== 'string' || !/^ca-pub-\d{16}$/.test(a.client)) return null;
  const interval = typeof a.minIntervalS === 'number' && Number.isFinite(a.minIntervalS) ? Math.max(30, a.minIntervalS) : 120;
  return { client: a.client, test: a.test === true, minIntervalS: interval, hold: c.hold === true };
}

/** What the person answered for this version of the notice: 'yes', 'no', or null when not asked yet. */
export function readConsent(stored: string | null, version: string): 'yes' | 'no' | null {
  const m = /^(yes|no):(.+)$/.exec(stored ?? '');
  return m && m[2] === version ? (m[1] as 'yes' | 'no') : null;
}

/** Everything a break touches, injected by the tests (web/test/ads.test.ts). */
export interface AdsDeps {
  config(): Promise<AdsConfig | null>;
  /** The loader chunk: Google's script and the placement API, or null when it failed or was blocked. */
  load(cfg: AdsConfig): Promise<AdsApi | null>;
  consent(): 'yes' | 'no' | null;
  lastBreak(): number | null;
  setLastBreak(at: number): void;
  hidden(): boolean;
  now(): number;
  /** The solo clock between hands: { t: 'hold', on } to the room. False when it could not be sent. */
  hold(on: boolean): boolean;
  suspendSound(): void;
  resumeSound(): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface Ads {
  requestBreak(point: PausePoint): Promise<BreakResult>;
}

/** The ads logic over its dependencies. One break at a time; a second ask while one runs is skipped. */
export function createAds(d: AdsDeps): Ads {
  let api: Promise<AdsApi | null> | null = null;
  let running = false;

  async function requestBreak(point: PausePoint): Promise<BreakResult> {
    if (running) return 'skipped';
    let cfg: AdsConfig | null = null;
    try {
      cfg = await d.config();
    } catch {
      cfg = null;
    }
    if (!cfg) return 'skipped';
    if (d.consent() !== 'yes') return 'skipped';
    if (point === 'solo.betweenHands' && !cfg.hold) return 'skipped';
    if (d.hidden()) return 'skipped';
    const last = d.lastBreak();
    if (last !== null && d.now() - last < cfg.minIntervalS * 1000) return 'skipped';
    const conf = cfg;
    api ??= d.load(conf).catch(() => null);
    const ads = await api;
    if (!ads) {
      // Blocked or failed: asked again on a later page load, never in this one.
      return 'skipped';
    }
    if (d.hidden()) return 'skipped';
    running = true;
    return new Promise<BreakResult>((resolve) => {
      const holds = point === 'solo.betweenHands';
      let started = false;
      let ended = false;
      let settled = false;
      let held = false;
      let timer: unknown = null;
      const arm = (ms: number) => {
        if (timer !== null) d.clearTimeout(timer);
        timer = d.setTimeout(() => finish(null), ms);
      };
      // The ad is over (afterAd, adBreakDone or a guard): sound and the clock come back.
      const end = () => {
        if (!started || ended) return;
        ended = true;
        d.resumeSound();
        if (held) d.hold(false);
        held = false;
      };
      const finish = (info: BreakDone | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) d.clearTimeout(timer);
        end();
        running = false;
        const shown = started && info?.breakStatus === 'viewed';
        if (shown) d.setLastBreak(d.now());
        resolve(shown ? 'shown' : 'skipped');
      };
      arm(GUARD_MS);
      try {
        ads.adBreak({
          type: PLACEMENT[point],
          name: point.replace('.', '_'),
          beforeAd: () => {
            if (settled || started) return;
            started = true;
            arm(MAX_BREAK_MS);
            d.suspendSound();
            if (holds) held = d.hold(true);
          },
          afterAd: end,
          adBreakDone: (info) => finish(info ?? {}),
        });
      } catch {
        finish(null);
      }
    });
  }

  return { requestBreak };
}

// -----------------------------------------------------------------------------------------------
// The site's instance

function readStorage(kind: 'local' | 'session', key: string): string | null {
  try {
    return (kind === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(kind: 'local' | 'session', key: string, value: string): void {
  try {
    (kind === 'local' ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    // Storage blocked: the answer lasts for this page only (kept below).
  }
}

/** /api/config read once per page (api.config() caches it). */
export function adsConfig(): Promise<AdsConfig | null> {
  return api.config().then(parseAdsConfig, () => null);
}

let consentHere: 'yes' | 'no' | null = null;

/** The person's answer for the notice version of ads on. */
export function adsConsent(): 'yes' | 'no' | null {
  return consentHere ?? readConsent(readStorage('local', CONSENT_KEY), noticeVersion(true));
}

export function setAdsConsent(answer: 'yes' | 'no'): void {
  consentHere = answer;
  writeStorage('local', CONSENT_KEY, `${answer}:${noticeVersion(true)}`);
}

/** Sends the hold message to the room, once WP6b wires it (setHoldSender); until then nothing holds. */
let holdSender: ((on: boolean) => boolean) | null = null;
export function setHoldSender(send: ((on: boolean) => boolean) | null): void {
  holdSender = send;
}

let lastHere: number | null = null;

const site = createAds({
  config: adsConfig,
  load: (cfg) => import('./loader.ts').then((m) => m.loadAds(cfg)),
  consent: adsConsent,
  lastBreak: () => {
    const v = Number(readStorage('session', LAST_BREAK_KEY));
    return lastHere ?? (Number.isFinite(v) && v > 0 ? v : null);
  },
  setLastBreak: (at) => {
    lastHere = at;
    writeStorage('session', LAST_BREAK_KEY, String(at));
  },
  hidden: () => document.visibilityState === 'hidden',
  now: () => Date.now(),
  hold: (on) => (holdSender ? holdSender(on) : false),
  suspendSound: () => sound.suspend(),
  resumeSound: () => sound.resume(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
});

/** Asks for a break at a pause point. Resolves 'skipped' at once while ads are off. */
export function requestBreak(point: PausePoint): Promise<BreakResult> {
  return site.requestBreak(point);
}

const AdsConsent = lazyComponent(() => import('./AdsConsent.tsx').then((m) => m.AdsConsent));

/**
 * The ads root of the app: the consent dialog, only when ads are on and the person has not answered
 * for this version, out of a hand (the Play page, a lobby or a finished match) and with no other
 * dialog open. Renders nothing while ads are off, and loads nothing: not the dialog's chunk, not the
 * loader.
 */
export function AdsRoot() {
  // Only a person who answered the age gate as an adult can play, so only they are asked about ads;
  // before that answer (or under 18) the page does not even read the config.
  const calm = useStoreSelect(
    (s) => s.gate === 'closed' && !s.rulesOpen && isAdult() && (s.route.name === 'play' || (s.route.name === 'room' && s.room !== null && s.room.room.status !== 'playing')),
  );
  const [cfg, setCfg] = useState<AdsConfig | null | undefined>(undefined);
  const [answered, setAnswered] = useState(() => adsConsent() !== null);
  useEffect(() => {
    if (!calm || cfg !== undefined || answered) return;
    let live = true;
    void adsConfig().then((c) => live && setCfg(c));
    return () => {
      live = false;
    };
  }, [calm, cfg, answered]);
  if (!calm || !cfg || answered) return null;
  return h(AdsConsent, {
    onAnswer: (a: 'yes' | 'no') => {
      setAdsConsent(a);
      setAnswered(true);
    },
  });
}
