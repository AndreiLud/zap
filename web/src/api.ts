// HTTP calls to the Worker. The device cookie and the game credential are HttpOnly cookies set by
// the server; the browser sends them on its own and this code never sees them.

import type { MatchKind, MatchRecord } from '../../shared/match-record.ts';
import type { Reading } from '../../shared/cycle-formats.ts';
import type { PublicRoom, RoomSettings } from '../../shared/protocol.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** The whole answer, for errors that carry more than a code (limit_reached carries its limit). */
  readonly data: unknown;
  constructor(code: string, status: number, data: unknown = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export interface SiteConfig {
  turnstileSiteKey: string;
  adsEnabled: boolean;
  privacyContact: string | null;
}

export interface Prefs {
  openDataOptOut: boolean;
  noAdapt: boolean;
}

export interface Me {
  device: boolean;
  verified: boolean;
  verifiedUntil: number | null;
  adult: boolean;
  nickname: string | null;
  nicknameHidden: boolean;
  prefs: Prefs;
}

/** Everything the server keeps about this device (GET /api/me/data); see worker/src/privacy.ts. */
export interface MyData {
  generatedAt: number;
  pseudonym: string | null;
  device: {
    createdAt: number;
    lastSeen: number | null;
    adultAt: number | null;
    verifiedAt: number | null;
    matchesSinceVerify: number;
    flagged: boolean;
    blockedUntil: number;
    abandons: number;
    nickname: string | null;
    nicknameHidden: boolean;
    prefs: Prefs;
    hasRecoveryCode: boolean;
  };
  matches: { matchId: string; seat: number; startedAt: number; endedAt: number; kind: MatchKind | string; verified: boolean }[];
  openRooms: { code: string; createdAt: number; expiresAt: number; mode: string }[];
  joinedRooms: { code: string; expiresAt: number }[];
  reportsMade: { createdAt: number; matchId: string | null; roomCode: string | null; seat: number; reason: string; status: string }[];
  reportsAboutYou: { createdAt: number; reason: string; status: string }[];
  flags: { reason: string | null; createdAt: number; reviewedAt: number | null; decision: string | null; ref: string | null }[];
  /** Style counters per rules segment (worker/src/profiles.ts). */
  profile: ({ segment: string; matches: number; decisions: number } & Record<string, number | string>)[];
  /** This person's random group in each daily export of the last 30 days. */
  exportGroups: { exportDate: string; group: string }[];
}

export type { Reading };

export type ReportReason = 'nickname' | 'phrases' | 'cheating' | 'other';

/** What the client may ask for when it creates a match; the server validates every field. */
export type NewMatch = Partial<Pick<RoomSettings, 'players' | 'variant' | 'options' | 'opponents' | 'partner' | 'turnSeconds'>>;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON: the status code alone tells what happened.
  }
  if (!res.ok) {
    const code = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `http_${res.status}`;
    throw new ApiError(code, res.status, data);
  }
  return data as T;
}

let configPromise: Promise<SiteConfig> | null = null;

export const api = {
  config(): Promise<SiteConfig> {
    configPromise ??= request<SiteConfig>('GET', '/api/config').catch((e: unknown) => {
      configPromise = null;
      throw e;
    });
    return configPromise;
  },
  me: () => request<Me>('GET', '/api/me'),
  /** Only called after the age gate: the person declared being 18 or older. The year is never sent. */
  session: (token: string) => request<{ verifiedUntil: number }>('POST', '/api/session', { token, adult: true }),
  play: (m: NewMatch) => request<{ code: string }>('POST', '/api/play', m),
  createRoom: (m: NewMatch) => request<{ code: string }>('POST', '/api/rooms', m),
  room: (code: string) => request<PublicRoom>('GET', `/api/rooms/${encodeURIComponent(code)}`),
  myData: () => request<MyData>('GET', '/api/me/data'),
  /** "How Zap reads you": the person's style counters read against the population (worker/src/reading.ts). */
  reading: () => request<Reading>('GET', '/api/me/reading'),
  matchRecord: (matchId: string) => request<{ yourSeat: number; record: MatchRecord }>('GET', `/api/me/matches/${encodeURIComponent(matchId)}`),
  nickname: (nickname: string | null) => request<{ nickname: string | null; nicknameHidden: boolean }>('POST', '/api/me/nickname', { nickname }),
  prefs: (p: Partial<Prefs>) => request<{ prefs: Prefs }>('POST', '/api/me/prefs', p),
  deleteMe: (token: string) => request<{ deleted: true }>('POST', '/api/me/delete', { token }),
  newRecoveryCode: () => request<{ code: string }>('POST', '/api/me/recovery'),
  /** Shown only after the age gate: the recovered history is for playing, so it carries the same declaration as session(). */
  recover: (code: string, token: string) => request<{ recovered: true; verifiedUntil: number }>('POST', '/api/recover', { code, token, adult: true }),
  report: (code: string, seat: number, reason: ReportReason) => request<{ reported: true }>('POST', '/api/report', { code, seat, reason }),
};
