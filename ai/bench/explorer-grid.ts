// The explorers searched by ai/bench/explorer.ts.
//
// The original grid: every ordered pair of distinct explorer styles, a switch at hand 1, 2, 3, 4, 6
// or 8 or after 2, 4 or 8 betting events of the explorer's seat, and both partner options (same
// schedule, or v1 Zap). 8 x 7 x 9 x 2 = 1,008 explorers. Since the feints fine-tune trains against
// players built like it (league kind 'feints'), the whole grid is inside that network's training
// family.
//
// The fresh family: schedules no league kind draws, so the explorer test keeps explorers the
// network never met (every member is outside every training family, styles.ts inTrainingFamily).
// The part of a schedule that no training draw plays comes early: the median match has 5 to 9
// hands by segment (ai.adaptation.matchLength), so a schedule that leaves the training feints
// only late plays as one of them in many matches. explorer.ts --stage fresh records how often the
// realized play of a match left every training draw (styles.ts explorerMatchInFamily). Over the
// same 8 explorer styles (a then b, a and b distinct):
//   threePhase    a in hand 1, b in hands 2 and 3, a again from hand 4 (a>b>a@1,3), partner same
//                 or v1: 112
//   backAndForth  a and b in turns of 1 hand (a<>b@1), partner same: 56
//   heldOut       a held-out style (coversAll or coinFlip) as one phase or both, switch at hand 4
//                 or after 4 betting events, partner same: 34 ordered pairs x 2 = 68
//   ownSchedules  each seat of the team on its own three-phase schedule, mirrored: the lower seat
//                 a>b>a@1,3, its partner b>a>b@1,3, one per unordered pair: 28
// 264 explorers in all. Late switches (a, then b at hand 11 or after 12 betting events) were
// dropped: until the switch they play as a training feint, and most matches end before it. In 1
// against 1 the partner option changes nothing, so 'v1' and 'own' share the games of 'same' there.

import { EXPLORER_STYLES, HELD_OUT_STYLES, type ExplorerPhaseId, type ExplorerSpec } from '../src/styles.ts';

export const HAND_SWITCHES: readonly number[] = [1, 2, 3, 4, 6, 8];
export const EVIDENCE_SWITCHES: readonly number[] = [2, 4, 8];

/** The original grid of 1,008 explorers (attempts 1 to 4 searched it). */
export function grid(): ExplorerSpec[] {
  const out: ExplorerSpec[] = [];
  const triggers = [...HAND_SWITCHES.map((k) => ({ trigger: 'hand' as const, k })), ...EVIDENCE_SWITCHES.map((k) => ({ trigger: 'evidence' as const, k }))];
  for (const a of EXPLORER_STYLES) for (const b of EXPLORER_STYLES) if (a !== b) for (const t of triggers) for (const partner of ['same', 'v1'] as const) out.push({ a, b, k: t.k, trigger: t.trigger, partner });
  return out;
}

/** Settings of the fresh family, for the result files. */
export const FRESH_FAMILY = {
  threePhase: { at: [1, 3], partner: ['same', 'v1'] },
  backAndForth: { every: 1, partner: ['same'] },
  heldOut: { styles: HELD_OUT_STYLES, hand: 3, evidence: 4, partner: ['same'] },
  ownSchedules: { at: [1, 3], mirrored: true },
} as const;

/** The fresh family of 264 explorers (see the head of this file). */
export function freshFamily(): ExplorerSpec[] {
  const out: ExplorerSpec[] = [];
  const S = EXPLORER_STYLES;
  const pairs: [ExplorerPhaseId, ExplorerPhaseId][] = [];
  for (const a of S) for (const b of S) if (a !== b) pairs.push([a, b]);
  const f = FRESH_FAMILY;
  for (const [a, b] of pairs) for (const partner of f.threePhase.partner) out.push({ a, b, k: f.threePhase.at[0], k2: f.threePhase.at[1], partner });
  for (const [a, b] of pairs) out.push({ a, b, k: f.backAndForth.every, cycle: true, partner: 'same' });
  const held: [ExplorerPhaseId, ExplorerPhaseId][] = [];
  for (const h of f.heldOut.styles) for (const x of S) held.push([h, x], [x, h]);
  held.push([f.heldOut.styles[0], f.heldOut.styles[1]], [f.heldOut.styles[1], f.heldOut.styles[0]]);
  for (const [a, b] of held) {
    out.push({ a, b, k: f.heldOut.hand, partner: 'same' });
    out.push({ a, b, k: f.heldOut.evidence, trigger: 'evidence', partner: 'same' });
  }
  for (let i = 0; i < S.length; i++)
    for (let j = i + 1; j < S.length; j++) {
      const [a, b] = [S[i], S[j]];
      out.push({ a, b, k: f.ownSchedules.at[0], k2: f.ownSchedules.at[1], partner: 'own', mate: { a: b, b: a, k: f.ownSchedules.at[0], k2: f.ownSchedules.at[1] } });
    }
  return out;
}

export type SearchPool = 'grid' | 'fresh' | 'all';

/** The candidates of a search: the original grid, the fresh family, or both (grid first). */
export function searchPool(pool: SearchPool): ExplorerSpec[] {
  if (pool === 'grid') return grid();
  if (pool === 'fresh') return freshFamily();
  return [...grid(), ...freshFamily()];
}
