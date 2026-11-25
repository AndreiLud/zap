// The lineup rules shared by the Play page and the room (shared/lineup.ts): the order of the
// characters, the defaults, the checks of a requested lineup and the draw behind quick play's
// random switches.

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../engine/src/rng.ts';
import { PERSONAS, type PersonaId } from '../../ai/src/personas.ts';
import { DEFAULT_OPPONENTS, DEFAULT_ROOM_OPPONENTS, FILL_ORDER, PERSONA_ORDER, drawLineup, firstFree, isPersonaId, lineupProblem } from '../../shared/lineup.ts';

type Fields = Parameters<typeof lineupProblem>[0];

const solo4 = (over: Partial<Fields> = {}): Fields => ({ mode: 'solo', players: 4, opponents: ['zap', 'iara'], partner: 'lia', ...over });
const solo2 = (over: Partial<Fields> = {}): Fields => ({ mode: 'solo', players: 2, opponents: ['zap'], partner: 'iara', ...over });

/** Draws `n` lineups and counts every character per position: opponent slots 0 and 1, then the partner. */
function tally(players: 2 | 4, opponents: PersonaId[], partner: PersonaId, f: { opponents: boolean; partner: boolean }, n = 10_000, seed = 7) {
  const rand = mulberry32(seed);
  const counts = Array.from({ length: 3 }, () => new Map<PersonaId, number>());
  const draws: { opponents: PersonaId[]; partner: PersonaId }[] = [];
  for (let i = 0; i < n; i++) {
    const d = drawLineup(players, opponents, partner, f, rand);
    draws.push(d);
    d.opponents.forEach((p, j) => counts[j].set(p, (counts[j].get(p) ?? 0) + 1));
    counts[2].set(d.partner, (counts[2].get(d.partner) ?? 0) + 1);
  }
  return { draws, counts };
}

/** Every character of `pool` holds its fair share of a position, within 1.5 points, and nobody else appears there. */
function expectUniform(count: Map<PersonaId, number>, pool: readonly PersonaId[], n: number): void {
  expect([...count.keys()].sort()).toEqual([...pool].sort());
  for (const p of pool) expect(Math.abs((count.get(p) ?? 0) / n - 1 / pool.length), p).toBeLessThan(0.015);
}

describe('lineup', () => {
  it('the picker order is the order of PERSONAS, and the fill order holds the same six', () => {
    expect([...PERSONA_ORDER]).toEqual(PERSONAS.map((p) => p.id));
    expect([...FILL_ORDER].sort()).toEqual([...PERSONA_ORDER].sort());
    expect(PERSONA_ORDER.every(isPersonaId)).toBe(true);
    for (const x of ['', 'Zap', 'nobody', null, 3, undefined]) expect(isPersonaId(x)).toBe(false);
  });

  it('firstFree gives the first character of the fill order left free', () => {
    expect(firstFree([])).toBe('iara');
    expect(firstFree(['zap', 'lia'])).toBe('iara');
    expect(firstFree(['zap', 'iara'])).toBe('lia');
    expect(firstFree([null, 'iara', 'lia'])).toBe('ravi');
    expect(firstFree(['iara', 'lia', 'ravi', 'bento', 'otavio'])).toBe('zap');
  });

  it('the defaults are valid lineups, with the partner the first free character', () => {
    for (const players of [2, 4] as const) {
      const opponents = [...DEFAULT_OPPONENTS[players]];
      expect(lineupProblem({ mode: 'solo', players, opponents, partner: firstFree(opponents) })).toBeNull();
      const plan = [...DEFAULT_ROOM_OPPONENTS[players]];
      expect(lineupProblem({ mode: 'room', players, opponents: plan, partner: firstFree(plan) })).toBeNull();
    }
    expect(DEFAULT_OPPONENTS[4]).toEqual(['zap', 'iara']);
    expect(firstFree(DEFAULT_OPPONENTS[4])).toBe('lia');
    expect(DEFAULT_ROOM_OPPONENTS[4]).toEqual(['iara', 'zap']);
  });

  it('with both switches off nothing is drawn and the generator is never called', () => {
    let calls = 0;
    const rand = () => {
      calls++;
      return 0.5;
    };
    expect(drawLineup(4, ['zap', 'iara'], 'lia', { opponents: false, partner: false }, rand)).toEqual({ opponents: ['zap', 'iara'], partner: 'lia' });
    expect(drawLineup(2, ['bento'], 'iara', { opponents: false, partner: false }, rand)).toEqual({ opponents: ['bento'], partner: 'iara' });
    // The partner switch means nothing with two players.
    expect(drawLineup(2, ['bento'], 'iara', { opponents: false, partner: true }, rand)).toEqual({ opponents: ['bento'], partner: 'iara' });
    expect(calls).toBe(0);
    // A generator that returns exactly 1 stays inside the pool.
    expect(drawLineup(2, ['bento'], 'iara', { opponents: true, partner: false }, () => 1).opponents).toEqual(['zap']);
  });

  it('1 against 1, opponent drawn: one of all six, Zap included, each about as often', () => {
    const n = 10_000;
    const { draws, counts } = tally(2, ['bento'], 'iara', { opponents: true, partner: false }, n);
    for (const d of draws) {
      expect(d.opponents).toHaveLength(1);
      expect(d.partner).toBe('iara');
    }
    expectUniform(counts[0], PERSONA_ORDER, n);
  });

  it('2 against 2, both drawn: two different opponents from all six, then the partner from the four left', () => {
    const n = 10_000;
    const { draws, counts } = tally(4, ['zap', 'iara'], 'lia', { opponents: true, partner: true }, n);
    for (const d of draws) {
      expect(new Set([...d.opponents, d.partner]).size).toBe(3);
      expect(lineupProblem(solo4({ opponents: d.opponents, partner: d.partner }))).toBeNull();
    }
    for (const count of counts) expectUniform(count, PERSONA_ORDER, n);
  });

  it('2 against 2, opponents drawn: two different ones from the five that are not the partner, who stays', () => {
    const n = 10_000;
    const { draws, counts } = tally(4, ['zap', 'iara'], 'ravi', { opponents: true, partner: false }, n);
    for (const d of draws) {
      expect(d.partner).toBe('ravi');
      expect(new Set(d.opponents).size).toBe(2);
      expect(d.opponents).not.toContain('ravi');
    }
    const five = PERSONA_ORDER.filter((p) => p !== 'ravi');
    expectUniform(counts[0], five, n);
    expectUniform(counts[1], five, n);
  });

  it('2 against 2, partner drawn: one of the four that are not opponents, who stay', () => {
    const n = 10_000;
    const { draws, counts } = tally(4, ['zap', 'iara'], 'lia', { opponents: false, partner: true }, n);
    for (const d of draws) expect(d.opponents).toEqual(['zap', 'iara']);
    expectUniform(counts[2], ['otavio', 'bento', 'lia', 'ravi'], n);
  });

  it('lineupProblem refuses what a table cannot play', () => {
    expect(lineupProblem(solo4())).toBeNull();
    expect(lineupProblem(solo2())).toBeNull();
    // Count, duplicates, unknown characters, not a list.
    expect(lineupProblem(solo4({ opponents: ['zap'] }))).toBe('opponents');
    expect(lineupProblem(solo4({ opponents: ['zap', 'iara', 'lia'] }))).toBe('opponents');
    expect(lineupProblem(solo2({ opponents: ['zap', 'lia'] }))).toBe('opponents');
    expect(lineupProblem(solo2({ opponents: [] }))).toBe('opponents');
    expect(lineupProblem(solo4({ opponents: ['zap', 'zap'] }))).toBe('opponents');
    expect(lineupProblem(solo4({ opponents: ['zap', 'nobody' as PersonaId] }))).toBe('opponents');
    expect(lineupProblem(solo4({ opponents: 'zap' as unknown as PersonaId[] }))).toBe('opponents');
    // The partner: known, and never one of the opponents at four players; with two players only known.
    expect(lineupProblem(solo4({ partner: 'iara' }))).toBe('partner');
    expect(lineupProblem(solo4({ partner: 'nobody' as PersonaId }))).toBe('partner');
    expect(lineupProblem(solo2({ opponents: ['iara'], partner: 'iara' }))).toBeNull();
    expect(lineupProblem(solo2({ partner: 'nobody' as PersonaId }))).toBe('partner');
    // The switches: booleans or absent, the partner one only at four players, both only in quick play.
    for (const bad of ['yes', 1, null]) {
      expect(lineupProblem(solo4({ randomOpponents: bad as unknown as boolean }))).toBe('random');
      expect(lineupProblem(solo4({ randomPartner: bad as unknown as boolean }))).toBe('random');
    }
    expect(lineupProblem(solo4({ randomOpponents: true, randomPartner: true }))).toBeNull();
    expect(lineupProblem(solo2({ randomOpponents: true, randomPartner: false }))).toBeNull();
    expect(lineupProblem(solo2({ randomPartner: true }))).toBe('random');
    expect(lineupProblem(solo4({ mode: 'room', randomOpponents: true }))).toBe('random');
    expect(lineupProblem(solo4({ mode: 'room', randomPartner: true }))).toBe('random');
    expect(lineupProblem(solo4({ mode: 'room', randomOpponents: false, randomPartner: false }))).toBeNull();
    expect(lineupProblem({ mode: 'room', players: 2, opponents: ['zap'], partner: 'iara' })).toBeNull();
  });
});
