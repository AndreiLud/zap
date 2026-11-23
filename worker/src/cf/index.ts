// The Worker: API routes, the human check, the device credential, room creation, the WebSocket
// hand-off to each room, and the person's own data (see, download, delete, recover, report).
// Everything else is a static asset. A daily Cron Trigger runs the daily jobs (worker/src/cron.ts):
// retention, waiting room calls, the training cycle's imports and export, the training alert and
// the receipt. Locally, wrangler dev serves it at /cdn-cgi/handler/scheduled (worker/dev/trigger-cron.ts).

import { CODE_PATTERN, type RoomSettings } from '../../../shared/protocol.ts';
import { adsSettings, adsTxt } from '../ads.ts';
import { isMatchId } from '../../../shared/match-record.ts';
import { LIMITS, SUMMARY_KEY } from '../../../shared/cycle-formats.ts';
import { cleanOptions, defaultSettings, validateSettings } from '../room-core.ts';
import { MATCHES_PER_CHECK, admitMatch, refundAdmission, refundMatch, type Admission } from '../allowance.ts';
import {
  REFUSAL_FROM_WORKER,
  addUsage,
  brakeConfig,
  emptyUsage,
  logBrakeProblems,
  meteredDb,
  newRoomBrake,
  parseTestLedger,
  readLedger,
  testLedgerKey,
  type LimitInfo,
  type RoomBrake,
  type TestLedger,
} from '../brake.ts';
import { cleanNickname } from '../nickname.ts';
import {
  REPORT_REASONS,
  checkedDevice,
  deleteDevice,
  myData,
  newRecoveryCode,
  normalizeRecoveryCode,
  recoverDevice,
  recoveryHash,
  roomsOf,
  type ReportReason,
  type SqlDb,
} from '../privacy.ts';
import {
  CRED_TTL_MS,
  DEVICE_MAX_AGE_S,
  credCookieName,
  credentialSubject,
  deviceCookieName,
  cookie,
  deviceIdFromSecret,
  ipKey,
  newDeviceSecret,
  parseCookies,
  signCredential,
  verifyCredential,
  type Credential,
} from '../auth.ts';
import { callEach, deliver as deliverCalls, queuedCalls, type RoomCall } from '../room-calls.ts';
import { createRoom as reserveRoom, roomExists as roomListed, type RoomHandle } from '../room-create.ts';
import { httpsRequired, isLocalHost, secretsReady } from '../site-guard.ts';
import { isTestKey, verifyTurnstile } from '../turnstile.ts';
import { wsForwardHeaders } from '../ws-headers.ts';
import { runDaily, type AlertMailer, type AlertTexts } from '../cron.ts';
import { countingDb } from '../d1-budget.ts';
import { dropProfilesIfNoAdapt } from '../profiles.ts';
import { readingFor } from '../reading.ts';
import {
  LIVE_MAX_AGE_S,
  SUMMARY_MAX_AGE_S,
  checkSummaryBody,
  liveAnswer,
  publicCacheControl,
  throughCache,
  warnSummaryOnce,
} from '../public-data.ts';
import ptBR from '../../../locales/pt-BR.json' with { type: 'json' };
import serverEn from '../../../locales/server.en.json' with { type: 'json' };
import serverPt from '../../../locales/server.pt-BR.json' with { type: 'json' };
import type { Env } from './env.ts';

export { Room } from './room.ts';

/** The training alert goes to the owner in Portuguese. */
const ALERT_TEXTS: AlertTexts = {
  subject: ptBR['alert.training.subject'],
  failed: ptBR['alert.training.failed'],
  stale: ptBR['alert.training.stale'],
  missing: ptBR['alert.training.missing'],
};

/** The send_email binding as the alert needs it; null unless the binding, ALERT_EMAIL and ALERT_FROM are all set. */
function alertMailer(env: Env): AlertMailer | null {
  const email = env.EMAIL;
  const to = env.ALERT_EMAIL?.trim();
  const from = env.ALERT_FROM?.trim();
  if (!email || !to || !from) return null;
  return { send: async (subject, text) => void (await email.send({ from, to, subject, text })) };
}

/** Reports one person may send per day. */
const MAX_REPORTS_PER_DAY = 20;

const SECURITY_HEADERS: Record<string, string> = {
  // Same values as web/public/_headers, which covers the static pages.
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

/** The invite page holds no script, style or form: it may load only its own preview image. */
const INVITE_CSP = "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  for (const [k, v] of new Headers(extra)) headers.append(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

const error = (code: string, status: number) => json({ error: code }, status);

/** A public answer of the data page: the security headers, but shared caches may keep it maxAgeS seconds. */
function publicBody(body: string, status: number, maxAgeS: number): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  headers.set('cache-control', publicCacheControl(maxAgeS));
  return new Response(body, { status, headers });
}

/**
 * summary.json from the public bucket: null when it is missing, too large or unreadable (the size
 * is checked before the body is read).
 */
async function readSummary(env: Env): Promise<{ body: string | null; tag: string; errors: string[] }> {
  const obj = await env.PUBLIC?.get(SUMMARY_KEY);
  if (!obj) return { body: null, tag: 'missing', errors: [] };
  if (obj.size > LIMITS.summary) return { body: null, tag: obj.etag, errors: [`${obj.size} bytes, over ${LIMITS.summary}`] };
  return { body: await obj.text(), tag: obj.etag, errors: [] };
}

/** GET /api/live (zap-live/1, public-data.ts): the counters, the version in play, humansVsZap. */
async function liveResponse(env: Env): Promise<Response> {
  try {
    const now = Date.now();
    // Loaded on first use (the bundle holds it anyway, through the room): the unit tests of the
    // other routes replace the room module and never load the bundled model files.
    const { currentVersion } = await import('./ai-runtime.ts');
    const [served, summary] = await Promise.all([currentVersion(env, now), readSummary(env).catch(() => ({ body: null }))]);
    const live = await liveAnswer(env.DB, summary.body, served.current, served.adapt, now);
    return publicBody(JSON.stringify(live), 200, LIVE_MAX_AGE_S);
  } catch {
    return error('unavailable', 503);
  }
}

/** GET /api/summary: summary.json as stored once it passes validateSummary; 404 no_summary otherwise. */
async function summaryResponse(env: Env): Promise<Response> {
  let read: Awaited<ReturnType<typeof readSummary>>;
  try {
    read = await readSummary(env);
  } catch {
    return error('unavailable', 503);
  }
  const checked = read.errors.length > 0 ? ({ ok: false, reason: 'invalid', errors: read.errors } as const) : checkSummaryBody(read.body);
  if (!checked.ok) {
    if (checked.reason === 'invalid') warnSummaryOnce(read.tag, checked.errors);
    return publicBody(JSON.stringify({ error: 'no_summary' }), 404, SUMMARY_MAX_AGE_S);
  }
  return publicBody(checked.body, 200, SUMMARY_MAX_AGE_S);
}

/**
 * The brake refused a match: the person reads which limit period ran out and when it starts
 * again (the client turns resetAt into "21h" in Brasília).
 */
function limitError(limit: LimitInfo, now: number): Response {
  return json({ error: 'limit_reached', limit }, 503, { 'retry-after': String(Math.max(1, Math.ceil((limit.resetAt - now) / 1000))) });
}

/**
 * A local test site (TEST_RECORDS in .dev.vars, never in production) over http on a local host:
 * only there do the brake's test ledgers exist (brake.ts TestLedger). Production sets no
 * TEST_RECORDS and answers only https on a public host, so both conditions fail there.
 */
function testSite(env: Env, url: URL): boolean {
  return env.TEST_RECORDS === 'true' && url.protocol === 'http:' && isLocalHost(url.hostname);
}

/** The test ledger a request asks for (x-zap-test-ledger), on a local test site only. */
function testLedger(request: Request, env: Env, url: URL): TestLedger | null {
  return testSite(env, url) ? parseTestLedger(request.headers.get('x-zap-test-ledger')) : null;
}

interface Who {
  device: string;
  /** The device secret from the cookie, only to set the cookie again. */
  secret: string;
  cred: Credential | null;
}

/** The browser's device (from its cookie) and its credential, or null without a device cookie. */
async function who(request: Request, env: Env): Promise<Who | null> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const secure = new URL(request.url).protocol === 'https:';
  const secret = cookies[deviceCookieName(secure)];
  if (!secret || !/^[A-Za-z0-9_-]{22}$/.test(secret)) return null;
  const device = await deviceIdFromSecret(secret);
  const cred = await verifyCredential(env.SESSION_SECRET, cookies[credCookieName(secure)], Date.now());
  const mine = cred !== null && cred.d === (await credentialSubject(env.SESSION_SECRET, device));
  return { device, secret, cred: mine ? cred : null };
}

interface DeviceRow {
  verified_at: number | null;
  matches_since_verify: number;
  flagged: number;
  blocked_until: number;
  adult_at: number | null;
  nickname: string | null;
  nickname_hidden: number;
  open_data_opt_out: number;
  no_adapt: number;
}

async function deviceRow(env: Env, device: string): Promise<DeviceRow | null> {
  return env.DB.prepare(
    'SELECT verified_at, matches_since_verify, flagged, blocked_until, adult_at, nickname, nickname_hidden, open_data_opt_out, no_adapt FROM devices WHERE id = ?',
  )
    .bind(device)
    .first<DeviceRow>();
}

/** The name other people see: the nickname, unless it was reported and waits for review. */
const shownName = (row: DeviceRow) => (row.nickname_hidden ? '' : (row.nickname ?? ''));

type PlayCheck = { ok: true; verified: boolean; matchesLeft: number; name: string; noAdapt: boolean } | { ok: false; code: string };

/**
 * The device may start matches: credential valid, declared 18 or older, fewer than 10 matches
 * since the check, not blocked.
 */
function playCheck(w: Who, row: DeviceRow | null): PlayCheck {
  if (!w.cred || !row || row.adult_at === null) return { ok: false, code: 'check_needed' };
  if (row.blocked_until > Date.now()) return { ok: false, code: 'blocked' };
  if (row.matches_since_verify >= MATCHES_PER_CHECK) return { ok: false, code: 'check_needed' };
  return { ok: true, verified: row.flagged === 0, matchesLeft: MATCHES_PER_CHECK - row.matches_since_verify, name: shownName(row), noAdapt: row.no_adapt !== 0 };
}

async function canPlay(env: Env, w: Who): Promise<PlayCheck> {
  if (!w.cred) return { ok: false, code: 'check_needed' };
  return playCheck(w, await deviceRow(env, w.device));
}

/** A fresh Turnstile token for this action (Cloudflare's test secrets answer without an action). */
async function humanCheck(env: Env, token: unknown, action: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return false;
  const check = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, typeof token === 'string' ? token : '', {
    expectedHostnames: env.TURNSTILE_HOSTNAMES ? env.TURNSTILE_HOSTNAMES.split(',').map((h) => h.trim()).filter(Boolean) : [],
    expectedAction: isTestKey(env.TURNSTILE_SECRET_KEY) ? undefined : action,
  });
  return check.ok;
}

/**
 * Both cookies for a device that just passed the human check, and the credential's expiry. The
 * device cookie is set again each time with its full lifetime (400 days, the most browsers keep),
 * so a person who keeps playing never loses it.
 */
async function sessionCookies(env: Env, secret: string, device: string, secure: boolean, now: number): Promise<{ cookies: string[]; until: number }> {
  const until = now + CRED_TTL_MS;
  const token = await signCredential(env.SESSION_SECRET, { d: await credentialSubject(env.SESSION_SECRET, device), v: now, e: until });
  return {
    cookies: [cookie(deviceCookieName(secure), secret, DEVICE_MAX_AGE_S, secure), cookie(credCookieName(secure), token, CRED_TTL_MS / 1000, secure)],
    until,
  };
}

const setCookieHeaders = (cookies: string[]) => cookies.map((c) => ['set-cookie', c]) as [string, string][];

/** Whether a room code is live, without waking its Durable Object. */
function roomExists(env: Env, code: string): Promise<boolean> {
  return roomListed(env.DB, code, Date.now());
}

function roomStub(env: Env, code: string) {
  // No Durable Object region in South America: Eastern North America is the closest.
  return env.ROOM.get(env.ROOM.idFromName(code), { locationHint: 'enam' });
}

/** One call to a room: let go of the ids (a deletion), or move them to the new id (a recovery). */
async function callRoom(env: Env, c: RoomCall): Promise<void> {
  const stub = roomStub(env, c.code);
  if (c.to) await stub.rekey(c.from, c.to);
  else for (const device of c.from) await stub.forget(device);
}

/**
 * Makes the calls. One that still fails waits in room_calls for the room or the daily job; a
 * waiting one (`queued`) that went through leaves the queue.
 */
function deliver(env: Env, calls: RoomCall[], queued: RoomCall[] = []): Promise<number> {
  return deliverCalls(env.DB, calls, queued, (c) => callRoom(env, c), Date.now());
}

/** A new room (see room-create.ts), which starts with the brake's state `brake` made right before the call. */
function createRoom(
  env: Env,
  db: SqlDb,
  settings: RoomSettings,
  w: Who,
  verified: boolean,
  name: string,
  noAdapt: boolean,
  brake: () => RoomBrake,
): ReturnType<typeof reserveRoom> {
  const room = (code: string): RoomHandle => {
    const stub = roomStub(env, code);
    return { create: (...args) => stub.create(...args), forget: (device) => stub.forget(device) };
  };
  return reserveRoom(db, room, settings, { device: w.device, verified, verifiedUntil: w.cred?.e ?? 0, name, noAdapt, brake }, Date.now());
}

function readSettings(body: unknown, mode: 'solo' | 'room'): RoomSettings | null {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<RoomSettings>;
  const s = defaultSettings({
    mode,
    players: b.players ?? 4,
    variant: b.variant ?? 'paulista',
    options: cleanOptions(b.options),
    opponents: b.opponents ?? (b.players === 2 ? ['zap'] : ['zap', 'lia']),
    partner: b.partner ?? 'iara',
    turnSeconds: b.turnSeconds === undefined ? 30 : b.turnSeconds,
  });
  return validateSettings(s) ? null : s;
}

/** Reads a small JSON body; a missing or large length, or a body over 4 KB, is refused. */
async function readJson(request: Request): Promise<unknown> {
  const len = request.headers.get('content-length');
  if (len === null || !/^\d+$/.test(len) || Number(len) > 4096) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 4096) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const own = new URL(request.url).origin;
  return origin === own || origin === env.PUBLIC_ORIGIN;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Invite link with its own preview for WhatsApp and other apps, then the room page. Its words: locales/server.*.json. */
function invitePage(env: Env, code: string, en: boolean): Response {
  const words = en ? serverEn : serverPt;
  const title = words['server.invite.title'].replace('{code}', code);
  const desc = words['server.invite.description'];
  const target = `${en ? '/en' : ''}/?sala=${code}`;
  const url = `${env.PUBLIC_ORIGIN}${en ? '/en' : ''}/s/${code}`;
  const html = `<!doctype html><html lang="${en ? 'en' : 'pt-BR'}"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(env.PUBLIC_ORIGIN)}/og/room-${en ? 'en' : 'pt'}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(title)}">
<meta property="og:locale" content="${en ? 'en_US' : 'pt_BR'}">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">
</head><body><a href="${escapeHtml(target)}">${escapeHtml(title)}</a></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, 'content-security-policy': INVITE_CSP } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const invite = /^\/(en\/)?s\/([A-Za-z0-9]{5})\/?$/.exec(path);
    if (invite) {
      const code = invite[2].toUpperCase();
      if (!CODE_PATTERN.test(code)) return new Response('not found\n', { status: 404, headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
      return invitePage(env, code, Boolean(invite[1]));
    }
    // ads.txt exists only while ads are on (wrangler.jsonc run_worker_first sends it here first).
    if (path === '/ads.txt') {
      const txt = adsTxt(env);
      const headers = { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': txt ? 'public, max-age=3600' : 'no-store' };
      return new Response(txt ?? 'not found\n', { status: txt ? 200 : 404, headers });
    }
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    // The API answers a public host only over https (see site-guard.ts).
    if (httpsRequired(url)) return error('https_required', 403);

    // Changes must come from our own pages.
    if (request.method !== 'GET' && !sameOrigin(request, env)) return error('bad_origin', 403);

    if (path === '/api/config' && request.method === 'GET') {
      // ads: null while ads are off (CLIENT-SPEC 16.2); adsEnabled stays for older pages and says the same.
      // hold: rooms stop the quick play clock during an ad between hands ({ t: 'hold' }, CLIENT-SPEC 16.5).
      const ads = adsSettings(env);
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, adsEnabled: ads !== null, ads, hold: true, privacyContact: env.PRIVACY_CONTACT || null });
    }

    if ((path === '/api/live' || path === '/api/summary') && request.method === 'GET') {
      // The data page's public numbers (public-data.ts): aggregates only, no credential, limited
      // per IP like the other routes without one. Cached per location for their period, so D1 and
      // R2 are read at most once per period there; a local test site skips the cache, so its
      // tests see each change at once.
      const rl = await env.RL_API?.limit({ key: `public:${await ipKey(env.SESSION_SECRET, request.headers.get('CF-Connecting-IP') ?? 'local', Date.now())}` });
      if (rl && !rl.success) return error('too_many', 429);
      const cache = env.TEST_RECORDS === 'true' ? null : caches.default;
      const key = new Request(new URL(path, url.origin).toString(), { method: 'GET' });
      return throughCache(cache, key, () => (path === '/api/live' ? liveResponse(env) : summaryResponse(env)), (p) => ctx.waitUntil(p));
    }

    if (path === '/api/session' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
      const rl = await env.RL_VERIFY?.limit({ key: await ipKey(env.SESSION_SECRET, ip, Date.now()) });
      if (rl && !rl.success) return error('too_many', 429);
      const body = (await readJson(request)) as { token?: unknown; adult?: unknown } | null;
      // Only people who declared being 18 or older play; nothing else about age reaches the server.
      if (body?.adult !== true) return error('age_required', 400);
      if (!secretsReady(env, url)) return error('misconfigured', 500);
      if (!(await humanCheck(env, body.token, 'play'))) return error('check_failed', 403);
      // The browser keeps its device while D1 has it; a cookie whose device was deleted or moved
      // starts over with a new secret (checkedDevice).
      const known = await who(request, env);
      const fresh = newDeviceSecret();
      const now = Date.now();
      const device = await checkedDevice(env.DB, known?.device ?? null, await deviceIdFromSecret(fresh), now);
      const secret = known && device === known.device ? known.secret : fresh;
      const s = await sessionCookies(env, secret, device, url.protocol === 'https:', now);
      return json({ verifiedUntil: s.until }, 200, setCookieHeaders(s.cookies));
    }

    if (path === '/api/recover' && request.method === 'POST') {
      // No credential: this browser may have none yet. A fresh human check and a per-IP limit instead.
      const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
      const rl = await env.RL_VERIFY?.limit({ key: `recover:${await ipKey(env.SESSION_SECRET, ip, Date.now())}` });
      if (rl && !rl.success) return error('too_many', 429);
      const body = (await readJson(request)) as { code?: unknown; token?: unknown; adult?: unknown } | null;
      // The recovered history is for playing, so this asks for the same declaration as /api/session.
      if (body?.adult !== true) return error('age_required', 400);
      const code = normalizeRecoveryCode(body.code);
      if (!code) return error('bad_code', 400);
      if (!secretsReady(env, url)) return error('misconfigured', 500);
      if (!(await humanCheck(env, body.token, 'recover'))) return error('check_failed', 403);
      const current = await who(request, env);
      const secret = newDeviceSecret();
      const device = await deviceIdFromSecret(secret);
      const now = Date.now();
      const old = await recoverDevice(env.DB, { codeHash: await recoveryHash(code), newId: device, currentId: current?.device ?? null, now });
      if (!old) return error('bad_code', 400);
      // The rooms of either browser now know the person only by the new id; the other browser's
      // connections there close, and its cookies open nothing (its device row is gone). The move
      // in D1 is done, so a room that does not answer gets the call later; an earlier recovery
      // still waiting for a room (recoverDevice moved it to the new id) goes along.
      const from = current && current.device !== old ? [old, current.device] : [old];
      const rooms = (await roomsOf(env.DB, device, now)).map((c): RoomCall => ({ code: c, from, to: device }));
      // The older ids first: a room still waiting for an earlier recovery knows the person by an
      // id older than these, and moves it before it hears of this one.
      await deliver(env, [], await queuedCalls(env.DB, device));
      await deliver(env, rooms);
      const s = await sessionCookies(env, secret, device, url.protocol === 'https:', now);
      return json({ recovered: true, verifiedUntil: s.until }, 200, setCookieHeaders(s.cookies));
    }

    // A test ledger of the brake, for the integration tests of a local test site (testSite).
    const ledgerPath = /^\/api\/test\/ledger\/([0-9a-f]{16})$/.exec(path);
    if (ledgerPath && request.method === 'GET') {
      if (!testSite(env, url)) return error('not_found', 404);
      const row = await readLedger(env.DB, testLedgerKey({ id: ledgerPath[1], capacity: 0 }));
      return row ? json(row) : error('not_found', 404);
    }
    // A room on a test ledger expires now, so a test reads what its expiry writes (Room.expireForTest).
    const expirePath = /^\/api\/test\/rooms\/([A-Z0-9]{5})\/expire$/.exec(path);
    if (expirePath && request.method === 'POST') {
      if (!testSite(env, url) || !CODE_PATTERN.test(expirePath[1]) || !(await roomExists(env, expirePath[1]))) return error('not_found', 404);
      return (await roomStub(env, expirePath[1]).expireForTest()) ? json({ expiring: true }) : error('not_found', 404);
    }

    const w = await who(request, env);

    if (path === '/api/me' && request.method === 'GET') {
      // A device cookie means a D1 read: limited per device once it holds a credential, and per IP
      // without one (a bare device cookie costs nothing to make, so a new one each time is free).
      if (w) {
        const key = w.cred ? w.device : `me:${await ipKey(env.SESSION_SECRET, request.headers.get('CF-Connecting-IP') ?? 'local', Date.now())}`;
        const rl = await env.RL_API?.limit({ key });
        if (rl && !rl.success) return error('too_many', 429);
      }
      const row = w ? await deviceRow(env, w.device) : null;
      const allowed = w ? playCheck(w, row) : null;
      return json({
        device: Boolean(w),
        verified: Boolean(allowed?.ok),
        verifiedUntil: row && w?.cred ? w.cred.e : null,
        adult: Boolean(row?.adult_at),
        nickname: row?.nickname ?? null,
        nicknameHidden: Boolean(row?.nickname_hidden),
        prefs: { openDataOptOut: Boolean(row?.open_data_opt_out), noAdapt: Boolean(row?.no_adapt) },
      });
    }

    if (path === '/api/me/delete' && request.method === 'POST') {
      // The device cookie and a fresh human check are enough (an expired credential must not stop a deletion).
      if (!w) return error('check_needed', 401);
      const rl = await env.RL_API?.limit({ key: w.device });
      if (rl && !rl.success) return error('too_many', 429);
      const body = (await readJson(request)) as { token?: unknown } | null;
      if (!(await humanCheck(env, body?.token, 'delete'))) return error('check_failed', 403);
      // The rooms first, while D1 still lists them: each drops the device from its seats, its
      // connections and the match records it has not written yet. A recovery to this device still
      // waiting for a room is settled the same way: that room knows the person by an older id.
      const rooms = (await roomsOf(env.DB, w.device, Date.now())).map((code): RoomCall => ({ code, from: [w.device], to: null }));
      const waiting = (await queuedCalls(env.DB, w.device)).map((c): RoomCall => ({ ...c, to: null }));
      // Nothing is deleted while a room still holds the person: they try again (each call is safe
      // to repeat). The page shows its "try again" message for this answer. The older ids first,
      // and only then this device: a room may know the person by an id from before a recovery.
      if ((await callEach(waiting, (c) => callRoom(env, c))).length > 0) return error('try_again', 503);
      if ((await callEach(rooms, (c) => callRoom(env, c))).length > 0) return error('try_again', 503);
      // A room the device joined after the list above was read is told now.
      const late = (await deleteDevice(env.DB, w.device, Date.now())).filter((code) => !rooms.some((r) => r.code === code));
      await deliver(env, late.map((code): RoomCall => ({ code, from: [w.device], to: null })));
      const secure = url.protocol === 'https:';
      return json({ deleted: true }, 200, setCookieHeaders([cookie(deviceCookieName(secure), '', 0, secure), cookie(credCookieName(secure), '', 0, secure)]));
    }

    // Everything below needs a valid credential, so a rotated cookie costs a new human check.
    if (!w || !w.cred) return error('check_needed', 401);
    const download = path.startsWith('/api/me/matches/');
    const rl = await (download ? env.RL_DATA : env.RL_API)?.limit({ key: w.device });
    if (rl && !rl.success) return error('too_many', 429);

    if ((path === '/api/play' || path === '/api/rooms') && request.method === 'POST') {
      const allowed = await canPlay(env, w);
      if (!allowed.ok) return error(allowed.code, allowed.code === 'blocked' ? 429 : 401);
      const mode = path === '/api/play' ? 'solo' : 'room';
      const settings = readSettings(await readJson(request), mode);
      if (!settings) return error('bad_settings', 400);
      const ledger = testLedger(request, env, url);
      // The D1 rows this request writes and reads for the room start the room's meter (brake.ts).
      let spent = emptyUsage();
      const db = meteredDb(env.DB, (written, read) => {
        spent = addUsage(spent, { d1RowsWritten: written, d1RowsRead: read });
      });
      // Quick play starts a match now: the brake reserves its cost and it takes one match from the
      // allowance, in one batch. Rooms do both at their start.
      let admission: Admission | null = null;
      if (mode === 'solo') {
        const now = Date.now();
        const cfg = brakeConfig(env);
        logBrakeProblems(cfg);
        // A refusal's own cost (this request and the ledger row) goes to the ledger with it.
        admission = await admitMatch(db, cfg, w.device, 1, now, ledger, REFUSAL_FROM_WORKER);
        if (!admission.ok) return admission.code === 'limit_reached' ? limitError(admission.limit, now) : error('check_needed', 401);
      }
      const reservation = admission?.ok ? admission.reservation : null;
      // The Worker request that creates the room is counted by the room itself (Room.create).
      const created = await createRoom(env, db, settings, w, allowed.verified, allowed.name, allowed.noAdapt, () => newRoomBrake(ledger, reservation, spent));
      if ('error' in created) {
        // No match started, so the person's match goes back, and the reservation too unless a room
        // may hold it (its create() answer was lost): that room gives it back itself (room-create.ts).
        if (admission?.ok) {
          if (created.error === 'room_failed' && created.held) await refundMatch(env.DB, w.device);
          else await refundAdmission(env.DB, w.device, reservation, Date.now());
        }
        return error(created.error, created.error === 'too_many_rooms' ? 429 : 503);
      }
      await env.DB.prepare('DELETE FROM open_rooms WHERE expires_at <= ?').bind(Date.now()).run();
      return json({ code: created.code });
    }

    const roomPath = /^\/api\/rooms\/([A-Za-z0-9]{5})(\/ws)?$/.exec(path);
    if (roomPath) {
      const code = roomPath[1].toUpperCase();
      if (!CODE_PATTERN.test(code)) return error('not_found', 404);
      // Unknown codes never wake a Durable Object.
      if (!(await roomExists(env, code))) return error('not_found', 404);
      const stub = roomStub(env, code);
      if (!roomPath[2] && request.method === 'GET') {
        const info = await stub.info();
        return info ? json(info) : error('not_found', 404);
      }
      if (roomPath[2] && request.headers.get('Upgrade') === 'websocket') {
        if (!sameOrigin(request, env)) return error('bad_origin', 403);
        const row = await deviceRow(env, w.device);
        // A deleted device, or one whose history moved to another browser, has no row: its
        // credential, still validly signed for up to 2 hours, opens no room.
        if (!row) return error('check_needed', 401);
        const allowed = playCheck(w, row);
        if (!allowed.ok && allowed.code === 'blocked') return error('blocked', 429);
        // Coming back to your own seat needs only the credential; the room refuses a new seat without matches left.
        const headers = wsForwardHeaders(request.headers, {
          'X-Zap-Device': w.device,
          'X-Zap-Verified': allowed.ok && allowed.verified ? '1' : '0',
          'X-Zap-Verified-Until': String(w.cred.e),
          'X-Zap-Matches-Left': String(allowed.ok ? allowed.matchesLeft : 0),
          // Headers carry only Latin-1, so the nickname travels URI-encoded.
          'X-Zap-Name': encodeURIComponent(shownName(row)),
          // "Don't adapt to me": the room reads no statistics about this seat from the next match on.
          'X-Zap-No-Adapt': row.no_adapt ? '1' : '0',
        });
        return stub.fetch(new Request(request.url, { headers, method: 'GET' }));
      }
    }

    if (path === '/api/me/nickname' && request.method === 'POST') {
      const body = (await readJson(request)) as { nickname?: unknown } | null;
      if (!body || typeof body !== 'object' || !('nickname' in body)) return error('bad_nickname', 400);
      // null clears the nickname (the table shows "Jogador N").
      const nickname = body.nickname === null ? null : cleanNickname(body.nickname);
      if (body.nickname !== null && nickname === null) return error('bad_nickname', 400);
      // A new nickname replaces a reported one and shows at once; the same one stays hidden until
      // the review (project_docs/moderation.md).
      const row = await env.DB.prepare(
        'UPDATE devices SET nickname_hidden = CASE WHEN nickname IS ?1 THEN nickname_hidden ELSE 0 END, nickname = ?1 WHERE id = ?2 RETURNING nickname_hidden',
      )
        .bind(nickname, w.device)
        .first<{ nickname_hidden: number }>();
      if (!row) return error('check_needed', 401);
      return json({ nickname, nicknameHidden: Boolean(row.nickname_hidden) });
    }

    if (path === '/api/me/prefs' && request.method === 'POST') {
      const body = (await readJson(request)) as Record<string, unknown> | null;
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      const ok =
        keys.length > 0 &&
        keys.every((k) => k === 'openDataOptOut' || k === 'noAdapt') &&
        keys.every((k) => typeof (body as Record<string, unknown>)[k] === 'boolean');
      if (!ok) return error('bad_prefs', 400);
      const flag = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
      // "Don't adapt to me" on: the style counters go in the same transaction, and the room adds no more.
      const [updated] = await env.DB.batch([
        env.DB.prepare(
          'UPDATE devices SET open_data_opt_out = COALESCE(?, open_data_opt_out), no_adapt = COALESCE(?, no_adapt) WHERE id = ? RETURNING open_data_opt_out, no_adapt',
        ).bind(flag(body!.openDataOptOut), flag(body!.noAdapt), w.device),
        dropProfilesIfNoAdapt(env.DB, w.device) as D1PreparedStatement,
      ]);
      const row = (updated.results as { open_data_opt_out: number; no_adapt: number }[] | undefined)?.[0];
      if (!row) return error('check_needed', 401);
      if (typeof body!.noAdapt === 'boolean') {
        // The rooms this person sits in learn it now, not only when a socket opens again, so the
        // next match there honours it. A room that does not answer has expired or will read the
        // value from the header when the person reconnects.
        const on = body!.noAdapt;
        const codes = await roomsOf(env.DB, w.device, Date.now());
        await Promise.allSettled(codes.map((code) => roomStub(env, code).setNoAdapt(w.device, on)));
      }
      return json({ prefs: { openDataOptOut: row.open_data_opt_out !== 0, noAdapt: row.no_adapt !== 0 } });
    }

    if (path === '/api/me/reading' && request.method === 'GET') {
      // "How Zap reads you": the person's counters against the population priors (reading.ts).
      const reading = await readingFor(env.DB, w.device, Date.now());
      return reading ? json(reading) : error('check_needed', 401);
    }

    if (path === '/api/me/data' && request.method === 'GET') {
      const data = await myData(env.DB, w.device, Date.now());
      return data ? json(data) : error('check_needed', 401);
    }

    const matchPath = /^\/api\/me\/matches\/([^/]{1,64})$/.exec(path);
    if (matchPath && request.method === 'GET') {
      const id = matchPath[1];
      // Only a match where this device sat; anything else looks the same as a match that does not exist.
      if (!isMatchId(id)) return error('not_found', 404);
      const seat = await env.DB.prepare(
        'SELECT s.seat AS seat, m.record_key AS recordKey FROM match_seats s JOIN matches m ON m.id = s.match_id WHERE s.match_id = ? AND s.pseudonym = (SELECT pseudonym FROM devices WHERE id = ?)',
      )
        .bind(id, w.device)
        .first<{ seat: number; recordKey: string }>();
      if (!seat) return error('not_found', 404);
      const obj = await env.EVENTS.get(seat.recordKey);
      if (!obj) return error('not_found', 404);
      const record = await obj.text();
      const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      return new Response(`{"yourSeat":${seat.seat},"record":${record}}`, { headers });
    }

    if (path === '/api/me/recovery' && request.method === 'POST') {
      // A new code replaces the old one; only its hash is stored and the code is shown once.
      const code = newRecoveryCode();
      const res = await env.DB.prepare('UPDATE devices SET recovery_hash = ? WHERE id = ?').bind(await recoveryHash(normalizeRecoveryCode(code)!), w.device).run();
      if (!res.meta.changes) return error('check_needed', 401);
      return json({ code });
    }

    if (path === '/api/report' && request.method === 'POST') {
      const body = (await readJson(request)) as { code?: unknown; seat?: unknown; reason?: unknown } | null;
      const code = typeof body?.code === 'string' ? body.code.toUpperCase() : '';
      const seat = body?.seat;
      const reason = body?.reason;
      if (!CODE_PATTERN.test(code) || !Number.isInteger(seat) || (seat as number) < 0 || (seat as number) > 3 || !REPORT_REASONS.includes(reason as ReportReason)) {
        return error('bad_report', 400);
      }
      if (!(await roomExists(env, code))) return error('not_found', 404);
      const now = Date.now();
      const made = await env.DB.prepare(
        'SELECT COUNT(*) AS n, (SELECT pseudonym FROM devices WHERE id = ?1) AS me FROM reports WHERE reporter = (SELECT pseudonym FROM devices WHERE id = ?1) AND created_at > ?2',
      )
        .bind(w.device, now - 86_400_000)
        .first<{ n: number; me: string | null }>();
      if (!made?.me) return error('check_needed', 401);
      if (made.n >= MAX_REPORTS_PER_DAY) return error('too_many', 429);
      const ans = await roomStub(env, code).report(w.device, seat as number, reason === 'nickname');
      if (!ans.ok) return error(ans.reason, ans.reason === 'not_found' ? 404 : ans.reason === 'not_in_room' ? 403 : 400);
      const stmts = [
        env.DB.prepare(
          'INSERT INTO reports (created_at, match_id, room_code, seat, reason, reporter, target) VALUES (?, ?, ?, ?, ?, (SELECT pseudonym FROM devices WHERE id = ?), (SELECT pseudonym FROM devices WHERE id = ?))',
        ).bind(now, ans.matchId, code, seat, reason, w.device, ans.target),
      ];
      if (reason === 'nickname' && ans.target) {
        stmts.push(env.DB.prepare('UPDATE devices SET nickname_hidden = 1 WHERE id = ? AND nickname IS NOT NULL').bind(ans.target));
      }
      await env.DB.batch(stmts);
      return json({ reported: true });
    }

    return error('not_found', 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Every D1 statement of the run is counted, so the export stops within the per-invocation limit.
    const db = countingDb(env.DB);
    const result = await runDaily(
      {
        db,
        events: env.EVENTS,
        models: env.MODELS ?? null,
        mailer: alertMailer(env),
        texts: ALERT_TEXTS,
        // Calls to rooms that failed when a person deleted or moved their data (rooms gone are already out).
        deliverCalls: async () => deliverCalls(db, [], await queuedCalls(db), (c) => callRoom(env, c), Date.now()),
        brakeProblems: brakeConfig(env).problems,
      },
      Date.now(),
    );
    // A failed step marks the cron run as failed instead of vanishing (the receipt says which).
    if (result.failed.length > 0) throw new Error(`daily jobs failed: ${result.failed.join(', ')}`);
  },
} satisfies ExportedHandler<Env>;
