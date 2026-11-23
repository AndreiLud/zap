// The AdSense H5 games loader (CLIENT-SPEC 16.3). A chunk of its own: ads/index.ts imports it only
// when /api/config returns `ads` and the person said yes to ads, so nothing of it is ever requested
// while ADS_ENABLED is not "true". Names from Google's Ad Placement API (adBreak, adConfig,
// requestNonPersonalizedAds, data-ad-frequency-hint, data-adbreak-test): check them against
// Google's page before turning ads on (DEPLOY.md, "How to enable ads").

import type { AdsConfig } from './index.ts';

/** What Google's script reports when a break ends. */
export interface BreakDone {
  breakStatus?: string;
}

/** One placement, as the Ad Placement API takes it. */
export interface Placement {
  type: 'next' | 'browse';
  name: string;
  beforeAd?: () => void;
  afterAd?: () => void;
  adBreakDone?: (info: BreakDone) => void;
}

export interface AdsApi {
  adBreak(p: Placement): void;
}

/** The two side effects of the loader, injected by the tests (web/test/ads.test.ts). */
export interface LoaderDeps {
  /** adsbygoogle.push: the queue Google's script reads once it runs. */
  push(o: object): void;
  /** Sets requestNonPersonalizedAds on the queue (before the script reads it). */
  nonPersonalized(): void;
  /** Adds a script element; resolves when it loaded, rejects when it failed or was blocked. */
  loadScript(src: string, attrs: Record<string, string>): Promise<void>;
}

export const SCRIPT_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

type AdsWindow = Window & { adsbygoogle?: object[] & { requestNonPersonalizedAds?: number }; adBreak?: (o: object) => void; adConfig?: (o: object) => void };

function queue(): NonNullable<AdsWindow['adsbygoogle']> {
  const w = window as AdsWindow;
  w.adsbygoogle = w.adsbygoogle || [];
  return w.adsbygoogle;
}

/** The real side effects: the window's queue and a script element in the head. */
export const browserDeps: LoaderDeps = {
  push: (o) => void queue().push(o),
  nonPersonalized: () => {
    queue().requestNonPersonalizedAds = 1;
  },
  loadScript: (src, attrs) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
      s.addEventListener('load', () => resolve());
      s.addEventListener('error', () => reject(new Error('ads script blocked or failed')));
      document.head.appendChild(s);
    }),
};

/** The script's attributes: anonymous CORS, the frequency hint and, in test mode, test ads only. */
export function scriptAttrs(cfg: AdsConfig): Record<string, string> {
  const attrs: Record<string, string> = { crossorigin: 'anonymous', 'data-ad-frequency-hint': `${cfg.minIntervalS}s` };
  if (cfg.test) attrs['data-adbreak-test'] = 'on';
  return attrs;
}

/**
 * Loads Google's script once and answers the placement API, or null when the script failed or
 * was blocked (the game then goes on with no message). Only ads that are not personalized are
 * asked for, for everyone (plan, section 10).
 */
export async function loadAds(cfg: AdsConfig, deps: LoaderDeps = browserDeps): Promise<AdsApi | null> {
  deps.nonPersonalized();
  const adBreak = (o: object) => deps.push(o);
  const adConfig = (o: object) => deps.push(o);
  if (deps === browserDeps) {
    const w = window as AdsWindow;
    w.adBreak = adBreak;
    w.adConfig = adConfig;
  }
  adConfig({ preloadAdBreaks: 'on', sound: 'on' });
  try {
    await deps.loadScript(`${SCRIPT_URL}?client=${encodeURIComponent(cfg.client)}`, scriptAttrs(cfg));
  } catch {
    return null;
  }
  return { adBreak: (p) => adBreak(p) };
}
