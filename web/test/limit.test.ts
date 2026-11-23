// The brake's message (web/src/limit.ts): when the Zap reached its limits, the person reads when to
// come back in Brasília time, which is 00:00 UTC, when Cloudflare's daily limits start again.

import { describe, expect, it, vi } from 'vitest';
import en from '../../locales/en.json' with { type: 'json' };
import { LIMIT_HOLD_MS, defaultLimit, heldLimit, holdLimit, limitText, limitVars, readLimit, resetsTomorrow } from '../src/limit.ts';

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k]);

describe('the brake message', () => {
  it('the day: back after 21h, the plan\'s sentence', () => {
    const info = { period: 'day' as const, resetAt: Date.UTC(2026, 10, 23) };
    expect(limitText(info, Date.UTC(2026, 10, 22, 15))).toBe('O Zap chegou ao limite de hoje. Volte depois das 21h.');
    expect(fill(en['limit.day'], limitVars(info, 'en'))).toMatch(/^Zap has reached today's limit\. Come back after 9\sPM, Brasília time\.$/u);
  });

  it('the month (Workers Paid): names the last day of the month in Brasília', () => {
    const info = { period: 'month' as const, resetAt: Date.UTC(2026, 11, 1) };
    expect(limitText(info, Date.UTC(2026, 10, 22, 15))).toBe('O Zap chegou ao limite deste mês. Volte depois das 21h de 30 de novembro.');
    expect(fill(en['limit.month'], limitVars(info, 'en'))).toMatch(/^Zap has reached this month's limit\. Come back after 9\sPM on November 30, Brasília time\.$/u);
    expect(limitVars({ period: 'month', resetAt: Date.UTC(2027, 0, 1) }, 'pt').date).toBe('31 de dezembro');
  });

  it('from 21h to 24h in Brasília the day\'s reset is tomorrow\'s 21h, and the message says so', () => {
    const info = { period: 'day' as const, resetAt: Date.UTC(2026, 10, 24) };
    // 02:30 UTC on the 23rd is 23:30 on the 22nd in Brasília: the reset is 21h on the 23rd.
    const late = Date.UTC(2026, 10, 23, 2, 30);
    expect(resetsTomorrow(info, late)).toBe(true);
    expect(limitText(info, late)).toBe('O Zap chegou ao limite de hoje. Volte amanhã depois das 21h.');
    expect(fill(en['limit.dayTomorrow'], limitVars(info, 'en'))).toMatch(/^Zap has reached today's limit\. Come back tomorrow after 9\sPM, Brasília time\.$/u);
    // 15:00 UTC is 12h in Brasília: the plan's sentence. So is 23:59 UTC (20:59), just before the reset.
    expect(limitText({ period: 'day', resetAt: Date.UTC(2026, 10, 23) }, Date.UTC(2026, 10, 22, 15))).toBe('O Zap chegou ao limite de hoje. Volte depois das 21h.');
    expect(resetsTomorrow({ period: 'day', resetAt: Date.UTC(2026, 10, 23) }, Date.UTC(2026, 10, 22, 23, 59))).toBe(false);
    // 00:00 UTC exactly is 21h: a refusal then belongs to the new day, back tomorrow.
    expect(resetsTomorrow({ period: 'day', resetAt: Date.UTC(2026, 10, 24) }, Date.UTC(2026, 10, 23))).toBe(true);
    // The month names its date, never "amanhã".
    expect(limitText({ period: 'month', resetAt: Date.UTC(2026, 11, 1) }, Date.UTC(2026, 11, 1) - 3600_000)).toBe('O Zap chegou ao limite deste mês. Volte depois das 21h de 30 de novembro.');
  });

  it('the page keeps a refusal until the reset, an hour at most, without storage or with it', () => {
    const t0 = Date.UTC(2026, 10, 22, 23, 30);
    const day = { period: 'day' as const, resetAt: Date.UTC(2026, 10, 23) };
    // Node has no sessionStorage: the copy in memory holds it.
    holdLimit(day, t0);
    expect(heldLimit(t0 + 60_000)).toEqual(day);
    expect(heldLimit(day.resetAt)).toBeNull();
    // A month away: kept for LIMIT_HOLD_MS only, then the server is asked again.
    const month = { period: 'month' as const, resetAt: Date.UTC(2026, 11, 1) };
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    try {
      holdLimit(month, t0);
      expect(JSON.parse(store.get('zap-limit')!)).toEqual({ limit: month, until: t0 + LIMIT_HOLD_MS });
      expect(heldLimit(t0 + LIMIT_HOLD_MS - 1)).toEqual(month);
      expect(heldLimit(t0 + LIMIT_HOLD_MS)).toBeNull();
      // A malformed copy in storage falls back to the page's own.
      store.set('zap-limit', '{"limit":{"period":"week"}}');
      expect(heldLimit(t0 + 1)).toEqual(month);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads only a well formed limit from the server, and falls back to the next 00:00 UTC', () => {
    expect(readLimit({ period: 'day', resetAt: 5 })).toEqual({ period: 'day', resetAt: 5 });
    expect(readLimit({ period: 'week', resetAt: 5 })).toBeNull();
    expect(readLimit({ period: 'day', resetAt: '5' })).toBeNull();
    expect(readLimit(null)).toBeNull();
    expect(defaultLimit(Date.UTC(2026, 10, 22, 23, 59, 59, 999))).toEqual({ period: 'day', resetAt: Date.UTC(2026, 10, 23) });
  });
});
