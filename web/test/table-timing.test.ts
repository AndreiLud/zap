// The table's animations fit inside the server's display offsets (CLIENT-SPEC 11.6): the client never
// delays a game event to finish an animation.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_PLAY_FLIGHT,
  DEAL_FLIGHT,
  DEAL_STAGGER,
  GATHER,
  HAND_GATHER,
  HAND_GATHER_AT,
  MY_PLAY_FLIGHT,
  PREDEAL_AT,
  REVEAL_FLIP,
  ROUND_HOLD,
  TRUCO_OUT,
  VIRA_AT,
  VIRA_FLIP,
  dealDuration,
} from '../src/table/timing.ts';

// The server's display offsets, read from worker/src/room-core.ts (its source, so the web typecheck
// does not pull in the worker's types).
const core = readFileSync(new URL('../../worker/src/room-core.ts', import.meta.url), 'utf8');
function serverConst(name: string): number {
  const m = new RegExp(`export const ${name} = ([\\d_]+);`).exec(core);
  if (!m) throw new Error(`${name} not found in room-core.ts`);
  return Number(m[1].replace(/_/g, ''));
}
const AI_DELAY_MS = serverConst('AI_DELAY_MS');
const HAND_END_DELAY_MS = serverConst('HAND_END_DELAY_MS');

describe('table timing', () => {
  it('reads the server offsets', () => {
    expect(AI_DELAY_MS).toBe(700);
    expect(HAND_END_DELAY_MS).toBe(1600);
  });

  it('uses the values of the spec', () => {
    expect([DEAL_STAGGER, DEAL_FLIGHT, REVEAL_FLIP, VIRA_FLIP, AI_PLAY_FLIGHT, MY_PLAY_FLIGHT, ROUND_HOLD, GATHER, HAND_GATHER_AT, HAND_GATHER]).toEqual([30, 240, 120, 240, 280, 220, 900, 220, 700, 400]);
    expect(VIRA_AT).toBe(400);
    expect(TRUCO_OUT).toBe(240);
  });

  it('a full 2 against 2 deal (690 ms) ends before the first AI move (700 ms)', () => {
    expect(11 * DEAL_STAGGER + DEAL_FLIGHT + REVEAL_FLIP).toBe(690);
    expect(dealDuration(12)).toBe(690);
    expect(dealDuration(12)).toBeLessThan(AI_DELAY_MS);
    expect(dealDuration(6)).toBeLessThan(AI_DELAY_MS);
  });

  it('the vira turns over inside the first AI delay', () => {
    expect(VIRA_AT + VIRA_FLIP).toBe(640);
    expect(VIRA_AT + VIRA_FLIP).toBeLessThanOrEqual(AI_DELAY_MS);
  });

  it('the cards are back in the deck, with room to spare, before the next deal', () => {
    expect(HAND_GATHER_AT + HAND_GATHER + 300).toBe(1400);
    expect(HAND_GATHER_AT + HAND_GATHER + 300).toBeLessThan(HAND_END_DELAY_MS);
    expect(PREDEAL_AT).toBeLessThan(HAND_END_DELAY_MS);
  });

  it('an AI card lands and a resolved trick gathers within one AI delay', () => {
    expect(AI_PLAY_FLIGHT + GATHER).toBe(500);
    expect(AI_PLAY_FLIGHT + GATHER).toBeLessThan(AI_DELAY_MS);
    expect(MY_PLAY_FLIGHT).toBeLessThan(AI_DELAY_MS);
  });
});
