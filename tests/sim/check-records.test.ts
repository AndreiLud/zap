// The A/B rules the end to end proof checks on the site's records (tests/sim/check-records.ts):
// the candidate only on opponent seats, a person's AI partner always the control version, an arm on
// every quick play match during a test, every record marked test.

import { describe, expect, it } from 'vitest';
import type { MatchRecord } from '../../shared/match-record.ts';
import { abProblems, wilson } from './check-records.ts';

type Seat = { kind: 'human' | 'ai'; aiVersion: string | null };

function rec(kind: MatchRecord['kind'], players: 2 | 4, arm: MatchRecord['arm'], aiVersion: string, partnerVersion: string, seats: Seat[], test = true): MatchRecord {
  return {
    kind,
    arm,
    aiVersion,
    partnerVersion,
    test,
    config: { players } as MatchRecord['config'],
    seats: seats.map((s, i) => ({ seat: i, kind: s.kind, verified: s.kind === 'human', persona: null, aiVersion: s.aiVersion })),
  } as unknown as MatchRecord;
}

const H: Seat = { kind: 'human', aiVersion: null };
const ai = (v: string): Seat => ({ kind: 'ai', aiVersion: v });

describe('A/B rules on records', () => {
  it('accepts both arms of quick play when the versions sit where they should', () => {
    // Four players: seat 2 is the person's partner and plays the control version.
    expect(abProblems(rec('solo2', 4, 'candidate', 'v5', 'v4', [H, ai('v5'), ai('v4'), ai('v5')]), 'v5', 'v4')).toEqual([]);
    expect(abProblems(rec('solo2', 4, 'control', 'v4', 'v4', [H, ai('v4'), ai('v4'), ai('v4')]), 'v5', 'v4')).toEqual([]);
    expect(abProblems(rec('solo1', 2, 'candidate', 'v5', 'v4', [H, ai('v5')]), 'v5', 'v4')).toEqual([]);
    // Friends with two people on one team: no arm, the candidate faces them.
    expect(abProblems(rec('friends', 4, null, 'v5', 'v4', [H, ai('v5'), H, ai('v5')]), 'v5', 'v4')).toEqual([]);
  });

  it('finds the candidate next to a person, a missing arm, a wrong arm and an unmarked record', () => {
    expect(abProblems(rec('solo2', 4, 'candidate', 'v5', 'v4', [H, ai('v5'), ai('v5'), ai('v5')]), 'v5', 'v4').join()).toMatch(/partner/);
    expect(abProblems(rec('solo1', 2, null, 'v4', 'v4', [H, ai('v4')]), 'v5', 'v4').join()).toMatch(/without an arm/);
    expect(abProblems(rec('solo1', 2, 'control', 'v5', 'v4', [H, ai('v5')]), 'v5', 'v4').join()).toMatch(/control arm/);
    expect(abProblems(rec('solo1', 2, 'candidate', 'v5', 'v4', [H, ai('v5')], false), 'v5', 'v4').join()).toMatch(/not marked test/);
    expect(abProblems(rec('solo2', 4, 'candidate', 'v5', 'v4', [H, ai('v4'), ai('v4'), ai('v5')]), 'v5', 'v4').join()).toMatch(/opponent seat 1/);
  });

  it('the Wilson interval holds the share and stays inside 0 and 1', () => {
    const [lo, hi] = wilson(20, 72);
    expect(lo).toBeLessThan(20 / 72);
    expect(hi).toBeGreaterThan(20 / 72);
    expect(wilson(0, 10)[0]).toBeCloseTo(0, 12);
    expect(wilson(10, 10)[1]).toBeCloseTo(1, 12);
    expect(wilson(10, 10)[1]).toBeLessThanOrEqual(1);
  });
});
