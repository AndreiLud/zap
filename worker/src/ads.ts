// Ads in test mode (CLIENT-SPEC 16, DEPLOY.md "How to enable ads"): what the Worker tells the page
// about ads, and the ads.txt line. Off by default: while ADS_ENABLED is not "true", or the client id
// is not a valid AdSense id, /api/config answers `ads: null` and /ads.txt answers 404.

export interface AdsVars {
  ADS_ENABLED?: string;
  ADS_CLIENT_ID?: string;
  ADS_TEST_MODE?: string;
  ADS_MIN_INTERVAL_S?: string;
}

/** What /api/config sends as `ads` when ads are on. */
export interface AdsSettings {
  client: string;
  test: boolean;
  minIntervalS: number;
}

/** An AdSense publisher id as the ad tag writes it: ca-pub- and 16 digits. */
const CLIENT = /^ca-pub-(\d{16})$/;
/** Google's default frequency hint, and the shortest interval its Ad Placement API allows. */
export const DEFAULT_INTERVAL_S = 120;
export const MIN_INTERVAL_S = 30;

export function adsSettings(env: AdsVars): AdsSettings | null {
  if ((env.ADS_ENABLED ?? '').trim() !== 'true') return null;
  const client = (env.ADS_CLIENT_ID ?? '').trim();
  if (!CLIENT.test(client)) return null;
  const n = Number(env.ADS_MIN_INTERVAL_S);
  const minIntervalS = Number.isFinite(n) && (env.ADS_MIN_INTERVAL_S ?? '').trim() !== '' ? Math.max(MIN_INTERVAL_S, Math.round(n)) : DEFAULT_INTERVAL_S;
  return { client, test: (env.ADS_TEST_MODE ?? '').trim() === 'true', minIntervalS };
}

/**
 * The ads.txt of this host when ads are on: Google as a direct seller for the publisher id, with
 * Google's certification authority id. The root domain needs its own line (DEPLOY.md). Null when off.
 */
export function adsTxt(env: AdsVars): string | null {
  const a = adsSettings(env);
  if (!a) return null;
  const pub = a.client.slice('ca-'.length);
  return `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`;
}
