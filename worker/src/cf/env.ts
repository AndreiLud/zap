import type { Room } from './room.ts';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<Room>;
  DB: D1Database;
  /** Match records (bucket zap-events): no person in them, kept for training and the report. */
  EVENTS: R2Bucket;
  /** Models, cards, the manifest and the training status (bucket zap-models), written by the training cycle. Read only here. */
  MODELS: R2Bucket;
  /** summary.json for the data page (bucket zap-public), written by the training cycle. Read only here. */
  PUBLIC?: R2Bucket;
  /** send_email binding for the training alert; no destination in the configuration (Email Routing delivers only to verified addresses). */
  EMAIL?: SendEmail;
  /** Sender address on the zone for the training alert; empty means no email. */
  ALERT_FROM?: string;
  /** The owner's address for the training alert (a secret, set with wrangler secret put). */
  ALERT_EMAIL?: string;
  /** "true" only on a local test site (.dev.vars): records carry test: true, and MANIFEST_TTL_S counts. Never in wrangler.jsonc. */
  TEST_RECORDS?: string;
  /** Manifest cache in seconds on a test site (from 1 to 300). Never in wrangler.jsonc. */
  MANIFEST_TTL_S?: string;
  RL_API?: RateLimiter;
  RL_VERIFY?: RateLimiter;
  /** Per device, only for downloading one's own match records (many small reads in a row). */
  RL_DATA?: RateLimiter;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_HOSTNAMES: string;
  SESSION_SECRET: string;
  AI_MODE: string;
  /** "on": an adaptive model (features v2) reads the public statistics of the match. Anything else, or unset: off. */
  AI_ADAPT?: string;
  ADS_ENABLED: string;
  ADS_CLIENT_ID: string;
  ADS_TEST_MODE: string;
  ADS_MIN_INTERVAL_S: string;
  PRIVACY_CONTACT: string;
  PUBLIC_ORIGIN: string;
  /** Only for end-to-end tests (in .dev.vars): shortens every waiting time. Never set in production. */
  ROOM_TIME_SCALE?: string;
  /** The brake (worker/src/brake.ts): "free" (default), "paid" or "off". */
  BRAKE_MODE?: string;
  /** The other projects' share of each limit, from 0 to 0.8 (a JSON object; 0.5 for any one missing). */
  BRAKE_RESERVE?: unknown;
  /** Paid mode: the monthly bill ceiling in US dollars, the $5 base included. */
  BRAKE_MONTHLY_USD?: unknown;
  /** The typical cost of a match with one person (a JSON object, see brake.ts ESTIMATE_KEYS). */
  BRAKE_COST_SOLO?: unknown;
  /** What each further person at the table adds to it. */
  BRAKE_COST_PER_PERSON?: unknown;
}
