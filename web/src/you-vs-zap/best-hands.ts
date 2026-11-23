// "Suas mãos que mais assustaram o Zap" (DATA-SPEC 5.6): the hands after which the AI on the other
// side thought much less of its chances. For each hand h of a match with an AI on the other team:
//
//   before = the winProb of the first move an opposing AI seat made in hand h
//   after  = the same for the next hand in which an opposing AI moved, or, after the last hand,
//            1 when the opponents won the match and 0 when they lost
//   swing  = before - after   (positive is good for the person)
//
// Hands without `before` (games the AI played with the rules fallback, which gives no estimate)
// are skipped. The top five by swing are kept, newer first on ties. The scan covers the 300 most
// recent records, 20 at a time with a yield in between, so input stays responsive.

import { teamOf } from '../../../engine/src/engine.ts';
import { handTags, newestFirst, walkMatch, type HandSpan, type HandTag, type PersonMatch } from './history.ts';

export const BEST_HANDS = 5;
export const SCAN_LIMIT = 300;
export const SCAN_CHUNK = 20;

export interface BestHand {
  matchId: string;
  endedAt: number;
  /** Hand number in the match, from 0. */
  hand: number;
  /** The opponents' estimated chance to win the match, at the start of the hand and after it. */
  before: number;
  after: number;
  swing: number;
  tags: HandTag[];
}

/** The first estimate an opposing AI seat gave in a hand, or null. */
function firstEstimate(m: PersonMatch, span: HandSpan): number | null {
  const r = m.record;
  const mine = teamOf(m.yourSeat);
  for (let i = span.start; i <= span.end; i++) {
    const seat = r.log[i] >> 4;
    if (teamOf(seat) === mine) continue;
    if (r.seats.find((s) => s.seat === seat)?.kind !== 'ai') continue;
    const p = r.moves[i]?.winProb ?? null;
    if (p !== null && Number.isFinite(p)) return p;
  }
  return null;
}

/** Every hand of one match with its swing (hands without an estimate left out). */
export function matchSwings(m: PersonMatch, spans: readonly HandSpan[] = walkMatch(m.record, m.yourSeat)): BestHand[] {
  const r = m.record;
  const mine = teamOf(m.yourSeat);
  if (!r.seats.some((s) => s.kind === 'ai' && teamOf(s.seat) !== mine)) return [];
  const est = spans.map((span) => firstEstimate(m, span));
  const final = r.result.winner === mine ? 0 : 1;
  const out: BestHand[] = [];
  for (let k = 0; k < spans.length; k++) {
    const before = est[k];
    if (before === null) continue;
    let after: number = final;
    for (let j = k + 1; j < spans.length; j++) {
      const e = est[j];
      if (e !== null) {
        after = e;
        break;
      }
    }
    out.push({ matchId: m.matchId, endedAt: r.endedAt, hand: spans[k].index, before, after, swing: before - after, tags: handTags(spans[k], m.yourSeat) });
  }
  return out;
}

/** Larger swing first; on a tie the newer match, then the later hand. */
export function bySwing(a: BestHand, b: BestHand): number {
  return b.swing - a.swing || b.endedAt - a.endedAt || b.hand - a.hand || (a.matchId < b.matchId ? 1 : a.matchId > b.matchId ? -1 : 0);
}

/** Keeps the best `limit` hands of a list (stable under bySwing). */
export function topHands(hands: readonly BestHand[], limit = BEST_HANDS): BestHand[] {
  return [...hands].sort(bySwing).slice(0, limit);
}

/** The best hands of the most recent matches, all at once (tests and small histories). */
export function bestHands(matches: readonly PersonMatch[], limit = BEST_HANDS): BestHand[] {
  const recent = [...matches].sort(newestFirst).slice(0, SCAN_LIMIT);
  return topHands(recent.flatMap((m) => matchSwings(m)).filter((h) => h.swing > 0), limit);
}

const yieldToInput = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The same scan in chunks of SCAN_CHUNK records with a yield between chunks. `alive` stops it when
 * the page goes away; `progress` reports matches done.
 */
export async function scanBestHands(
  matches: readonly PersonMatch[],
  opts: { alive?: () => boolean; progress?: (done: number, total: number) => void; limit?: number } = {},
): Promise<BestHand[] | null> {
  const recent = [...matches].sort(newestFirst).slice(0, SCAN_LIMIT);
  let best: BestHand[] = [];
  for (let i = 0; i < recent.length; i += SCAN_CHUNK) {
    if (opts.alive && !opts.alive()) return null;
    const chunk = recent.slice(i, i + SCAN_CHUNK);
    const found = chunk.flatMap((m) => matchSwings(m)).filter((h) => h.swing > 0);
    best = topHands([...best, ...found], opts.limit ?? BEST_HANDS);
    opts.progress?.(Math.min(recent.length, i + SCAN_CHUNK), recent.length);
    await yieldToInput();
  }
  return best;
}
