// The brake's message (worker/src/brake.ts): the Zap reached the limits of the day on Workers Free,
// or the bill ceiling of the month on Workers Paid, so the match did not start. Both reset at
// 00:00 UTC, which the person reads in Brasília time ("21h"), in their own language. From 21h to
// 24h in Brasília the next reset is the following day's 21h, and the day message says "amanhã".
//
// After a refusal the page keeps it for a while (holdLimit): "Play now", a room's start and
// "Jogar de novo" then show the message again without asking the server, since every refusal
// costs a request and a D1 row of the very limits the brake protects.

import type { LimitInfo } from '../../shared/protocol.ts';
import { lang, t, type Lang } from './i18n.ts';

const ZONE = 'America/Sao_Paulo';

/** The limit info of an answer from the server, checked; null when it is missing or malformed. */
export function readLimit(raw: unknown): LimitInfo | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || (o.period !== 'day' && o.period !== 'month') || typeof o.resetAt !== 'number' || !Number.isFinite(o.resetAt)) return null;
  return { period: o.period, resetAt: o.resetAt };
}

/** Without the server's info: the daily limits, which end at the next 00:00 UTC. */
export function defaultLimit(now: number): LimitInfo {
  const d = new Date(now);
  return { period: 'day', resetAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) };
}

/** The hour and the day of the reset in Brasília: "21h" and "30 de novembro", or "9 PM" and "November 30". */
export function limitVars(info: LimitInfo, l: Lang): { hour: string; date: string } {
  const at = new Date(info.resetAt);
  // Just before the reset, so the date is the last day of the period in Brasília.
  const day = new Date(info.resetAt - 1);
  if (l === 'pt') {
    const hour = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(at);
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, day: 'numeric', month: 'long' }).format(day);
    return { hour: `${Number(hour)}h`, date };
  }
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hour12: true }).format(at);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, day: 'numeric', month: 'long' }).format(day);
  return { hour, date };
}

/** Whether the day's reset falls on a later date in Brasília than `now` (a refusal from 21h to 24h there). */
export function resetsTomorrow(info: LimitInfo, now: number): boolean {
  if (info.period !== 'day') return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE });
  return fmt.format(new Date(info.resetAt)) !== fmt.format(new Date(now));
}

/** The text a refused person reads, in the current language. */
export function limitText(info: LimitInfo, now: number = Date.now()): string {
  const key = info.period === 'month' ? 'limit.month' : resetsTomorrow(info, now) ? 'limit.dayTomorrow' : 'limit.day';
  return t(key, limitVars(info, lang()));
}

// -----------------------------------------------------------------------------------------------
// The refusal the page keeps

/**
 * How long the page keeps a refusal at most. The day's reset is never more than 24 hours away,
 * but the month's can be weeks, and the owner may raise the paid ceiling meanwhile: after this
 * long the next try asks the server again (one request an hour at most per tab).
 */
export const LIMIT_HOLD_MS = 60 * 60_000;
const HOLD_KEY = 'zap-limit';

interface Held {
  limit: LimitInfo;
  until: number;
}

/** The page's own copy, for browsers whose storage refuses (a private window, blocked site data). */
let memory: Held | null = null;

/** Keeps a refusal from the server until its reset, or LIMIT_HOLD_MS at most. */
export function holdLimit(limit: LimitInfo, now: number = Date.now()): void {
  memory = { limit, until: Math.min(limit.resetAt, now + LIMIT_HOLD_MS) };
  try {
    sessionStorage.setItem(HOLD_KEY, JSON.stringify(memory));
  } catch {
    // The copy in memory is enough for this page.
  }
}

/** The refusal kept, while it lasts; null otherwise. */
export function heldLimit(now: number = Date.now()): LimitInfo | null {
  let h = memory;
  try {
    const raw = sessionStorage.getItem(HOLD_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { limit?: unknown; until?: unknown };
      const limit = readLimit(o.limit);
      if (limit && typeof o.until === 'number' && Number.isFinite(o.until)) h = { limit, until: o.until };
    }
  } catch {
    // Storage unreadable: the copy in memory, if any.
  }
  if (!h || now >= h.until || now >= h.limit.resetAt) return null;
  return h.limit;
}
