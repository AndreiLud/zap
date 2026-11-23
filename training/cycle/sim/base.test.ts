// The simulated players reach only the local sites, keep to the site's limits, and their styles
// only ever answer legal moves.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../../engine/src/config.ts';
import { applyAction, expectedActor, legalMask, newMatch } from '../../../engine/src/engine.ts';
import { observe } from '../../../engine/src/observe.ts';
import { mulberry32 } from '../../../engine/src/rng.ts';
import { seriesSeed } from '../../../engine/src/simulate.ts';
import { ALLOWED_BASES, checkedBase } from './base.ts';
import { Limiter, MIN_THINK_MS, TEMPOS, deviceIdOf, displayMs, pickTempo, tempoMedian, thinkMs } from './run.ts';
import { STYLES, styleMove } from './styles.ts';

describe('simulated players', () => {
  it('allow only the local sites', () => {
    for (const b of ALLOWED_BASES) expect(checkedBase(b)).toBe(b);
    expect(checkedBase('http://dev:8787/')).toBe('http://dev:8787');
    for (const b of ['https://zap.andreiludescher.com', 'http://dev:8789', 'http://example.com:8787', 'http://192.168.0.5:8787', '', undefined]) expect(checkedBase(b)).toBeNull();
  });

  it('exit with code 2 before any request for any other base', () => {
    // A base that would answer if anything were sent: the run must stop before.
    for (const base of ['https://zap.andreiludescher.com', 'http://127.0.0.1:9']) {
      const r = spawnSync(process.execPath, ['training/cycle/sim/run.ts', '--base', base, '--devices', '1', '--out', '.cache/sim/refused.json'], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/refused --base/);
    }
  });

  it('every style answers a legal move in whole matches', () => {
    for (const [i, style] of STYLES.entries()) {
      const s = newMatch(makeConfig(i & 1 ? 'mineiro' : 'paulista', i % 3 === 0 ? 2 : 4), seriesSeed('5e'.repeat(32), i));
      const rand = mulberry32(i);
      let n = 0;
      while (!s.over && n < 2000) {
        const seat = expectedActor(s);
        const a = styleMove(style, observe(s, seat), rand);
        expect(legalMask(s, seat) & (1 << a), `${style} action ${a}`).not.toBe(0);
        applyAction(s, seat, a);
        n++;
      }
      expect(s.over).toBe(true);
    }
  });

  it('think times: never under 260 ms, inside the time left, a metronome within 2%', () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 2000; i++) {
      expect(thinkMs('random', 300, rand, null)).toBeGreaterThanOrEqual(MIN_THINK_MS);
      expect(thinkMs('bluffer', 1200, rand, 1500)).toBeLessThanOrEqual(900);
      const m = thinkMs('metronome', 800, rand, null);
      expect(Math.abs(m - 800)).toBeLessThanOrEqual(16);
    }
  });

  it('paces: fast, normal and slow medians in their ranges, every pace drawn', () => {
    const rand = mulberry32(11);
    const seen = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      const t = pickTempo(rand);
      seen.set(t, (seen.get(t) ?? 0) + 1);
      const m = tempoMedian(t, rand);
      const [lo, hi] = t === 'fast' ? [300, 500] : t === 'normal' ? [500, 1200] : [1800, 3500];
      expect(m).toBeGreaterThanOrEqual(lo);
      expect(m).toBeLessThanOrEqual(hi);
    }
    expect([...seen.keys()].sort()).toEqual([...TEMPOS].sort());
    // 30% fast, 50% normal, 20% slow: each share within 4 points.
    expect(Math.abs(seen.get('fast')! / 3000 - 0.3)).toBeLessThan(0.04);
    expect(Math.abs(seen.get('slow')! / 3000 - 0.2)).toBeLessThan(0.04);
  });

  it('the think time starts after the last event is shown', () => {
    expect(displayMs([])).toBe(0);
    expect(displayMs([{ at: 0 }, { at: 700 }, { at: 1400 }, { at: 3000 }])).toBe(3000);
    expect(displayMs([{ at: 2300 }, { at: 700 }])).toBe(2300);
  });

  it('a device id is the SHA-256 the server stores (worker/src/auth.ts)', async () => {
    const { deviceIdFromSecret } = await import('../../../worker/src/auth.ts');
    expect(deviceIdOf('abc')).toBe(await deviceIdFromSecret('abc'));
  });

  it('the limiter keeps at most max uses in any window', async () => {
    let t = 0;
    const waits: number[] = [];
    const lim = new Limiter(10, 60_000);
    const now = () => t;
    const wait = async (ms: number) => {
      waits.push(ms);
      t += ms;
    };
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      await lim.take(now, wait);
      times.push(t);
    }
    for (let i = 10; i < times.length; i++) expect(times[i] - times[i - 10]).toBeGreaterThanOrEqual(60_000);
    expect(waits.length).toBeGreaterThan(0);
  });
});
