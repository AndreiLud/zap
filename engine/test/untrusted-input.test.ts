// Inputs the server must never trust: bad seats, impossible starting states, bad rigged cards,
// and rules that change after the match starts.

import { describe, expect, it } from 'vitest';
import { A_ACCEPT, IllegalActionError, applyAction, legalMask, makeConfig, newMatch, observe, parseCards, replay, setHandCards } from '../src/index.ts';
import { SEED, act, rig } from './helpers.ts';

describe('untrusted input', () => {
  it('rejects seats that are not integers in range, and leaves the state untouched', () => {
    const s = rig({ players: 2, cards: ['3c 5c Qc', '2h Jh Kh'] });
    act(s, [0, 'raise']);
    const before = JSON.stringify(s);
    for (const seat of [0.5, 2.5, Number.NaN, -1, 2, '1' as unknown as number]) {
      expect(legalMask(s, seat)).toBe(0);
      expect(() => applyAction(s, seat, A_ACCEPT)).toThrow(IllegalActionError);
    }
    expect(JSON.stringify(s)).toBe(before);
    expect(replay(s.config, SEED, s.log, { dealer: 1 }).log).toEqual(s.log);
  });

  it('rejects starting states that play cannot produce', () => {
    const c2 = makeConfig('paulista', 2);
    const c3 = makeConfig('paulista', 4, { bestOf: 3 });
    expect(() => newMatch(c2, SEED, { dealer: 1.5 })).toThrow();
    expect(() => newMatch(c2, SEED, { dealer: 7 })).toThrow();
    expect(() => newMatch(c2, SEED, { score: [12, 3] })).toThrow();
    expect(() => newMatch(c2, SEED, { score: [-5, 3] })).toThrow();
    expect(() => newMatch(c3, SEED, { games: [2, 0] })).toThrow();
    expect(() => newMatch(c2, SEED, { games: [1, 0] })).toThrow();
    expect(() => newMatch(c3, SEED, { games: [1, 1], score: [11, 11], dealer: 3 })).not.toThrow();
  });

  it('rejects rigged cards that are not integers from 0 to 39, and a vira in mineiro', () => {
    const p = newMatch(makeConfig('paulista', 2), SEED, { dealer: 1 });
    expect(() => setHandCards(p, [[Number.NaN, 1, 2], [3, 4, 5]], 6)).toThrow();
    expect(() => setHandCards(p, [[1.5, 1, 2], [3, 4, 5]], 6)).toThrow();
    expect(() => setHandCards(p, [[0, 1, 2], [3, 4, 5]], 2.5)).toThrow();
    const m = newMatch(makeConfig('mineiro', 2), SEED, { dealer: 1 });
    expect(() => setHandCards(m, [parseCards('3c 5c Qc'), parseCards('2h Jh Kh')], 999)).toThrow();
    expect(() => setHandCards(m, [parseCards('3c 5c Qc'), parseCards('2h Jh Kh')])).not.toThrow();
  });

  it('a match that ends on a run shows no pending bet', () => {
    // 9 to 0: truco, six, nine, and the other side runs, giving 6 points and the match.
    const s = rig({ players: 2, cards: ['3c 5c Qc', '2h Jh Kh'], score: [9, 0] });
    act(s, [0, 'raise'], [1, 'raise'], [0, 'raise'], [1, 'run']);
    expect(s.over).toBe(true);
    expect(s.score[0]).toBe(15);
    for (let seat = 0; seat < 2; seat++) {
      const o = observe(s, seat);
      expect(o.phase).not.toBe('raise');
      expect(o.legal).toBe(0);
    }
  });

  it('changing the caller config after the match starts changes nothing', () => {
    const config = makeConfig('paulista', 4);
    const s = newMatch(config, SEED, { dealer: 3 });
    const before = legalMask(s, 1);
    (config.options as { raiseAnyTime: boolean }).raiseAnyTime = true;
    (config as { variant: string }).variant = 'mineiro';
    expect(legalMask(s, 1)).toBe(before);
    expect(s.config.variant).toBe('paulista');
  });
});
