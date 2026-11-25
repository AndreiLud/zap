// The line about the reading during a match on "You against Zap" (inMatchLine in
// web/src/you-vs-zap/text.ts, shown by parts/Reading.tsx once the reading answer is in). A person
// with "Don't adapt to me" on is never told that the AI reads them, even while the version in play
// reads: from their next match the room masks their whole table (worker/src/room-core.ts).

import { describe, expect, it } from 'vitest';
import { inMatchLine } from '../src/you-vs-zap/text.ts';
import { DICT } from './data-text.ts';

describe('the in-match reading line', () => {
  it('follows the version in play for a person who did not opt out', () => {
    expect(inMatchLine(true, false)).toEqual({ on: true, key: 'data.vs.p3.inmatch.on' });
    expect(inMatchLine(false, false)).toEqual({ on: false, key: 'data.vs.p3.inmatch.off' });
  });

  it('says no one at the table is read for a person with "Don\'t adapt to me" on, also while the version in play reads', () => {
    for (const inMatch of [true, false]) {
      const line = inMatchLine(inMatch, true);
      expect(line).toEqual({ on: false, key: 'data.vs.p3.inmatch.noAdapt' });
      expect(DICT.pt[line.key]).toMatch(/não lê ninguém/);
      expect(DICT.en[line.key]).toMatch(/reads no one/);
      expect(DICT.pt[line.key]).not.toMatch(/lê só/);
      expect(DICT.en[line.key]).not.toMatch(/reads only/);
    }
  });

  it('says, when the reading is on, that it reads only that match and keeps nothing', () => {
    expect(DICT.pt['data.vs.p3.inmatch.on']).toMatch(/^Durante a partida, o Zap lê só .+ esquece tudo quando ela acaba\.$/);
    expect(DICT.en['data.vs.p3.inmatch.on']).toMatch(/^During a game, Zap reads only .+ forgets it all when the game ends\.$/);
  });
});
