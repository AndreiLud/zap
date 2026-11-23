// Thousands of whole matches with random players, in every variant and table size.

import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/config.ts';
import { playMatch, randomPolicies, seriesSeed } from '../src/simulate.ts';

const BASE = '5a'.repeat(32);

describe('simulated matches', () => {
  for (const variant of ['paulista', 'mineiro'] as const) {
    for (const players of [2, 4] as const) {
      it(`${variant} ${players === 4 ? '2x2' : '1x1'}: 5,000 random matches end with a valid winner`, () => {
        const config = makeConfig(variant, players, { bestOf: 3 });
        const wins = [0, 0];
        let hands = 0;
        for (let i = 0; i < 5000; i++) {
          const s = playMatch(config, seriesSeed(BASE, i), randomPolicies(players, i));
          expect(s.over).toBe(true);
          expect(s.games[s.winner]).toBe(2);
          wins[s.winner]++;
          hands += s.history.length;
        }
        // Random play is symmetric: each team should win about half the time.
        expect(Math.abs(wins[0] - 2500)).toBeLessThan(250);
        expect(hands).toBeGreaterThan(5000 * 6);
      });
    }
  }
});
