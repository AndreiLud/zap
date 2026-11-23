// "You against Zap" over fixture records (DATA-SPEC 5.2, 5.5, 5.6): the hands of a match found by
// replaying its log, the swing of each hand from the AI's own estimates, the top five, the tags of a
// hand checked against what the engine says happened, the history rows and the score against Zap.

import { describe, expect, it } from 'vitest';
import { BASE_PARAMS, handEstimate } from '../../ai/src/heuristic.ts';
import { A_ACCEPT, A_RAISE, A_RUN, replay, teamOf } from '../../engine/src/engine.ts';
import { observe } from '../../engine/src/observe.ts';
import { replaySteps } from '../src/data/ReplayViewer.tsx';
import { bestHands, bySwing, matchSwings, scanBestHands, topHands, type BestHand } from '../src/you-vs-zap/best-hands.ts';
import { handTags, matchRow, personWon, replayOf, soloScore, walkMatch, WEAK_HAND, type PersonMatch } from '../src/you-vs-zap/history.ts';
import { fixtureWinProb, playMatch, type Policy } from './vs-fixtures.ts';

/** The estimate an opposing AI gave at the first of its moves in [start, end], recomputed from the state. */
function firstOpposing(m: PersonMatch, start: number, end: number): number | null {
  for (let i = start; i <= end; i++) {
    const seat = m.record.log[i] >> 4;
    if (teamOf(seat) === teamOf(m.yourSeat) || m.record.seats[seat].kind !== 'ai') continue;
    return fixtureWinProb(replay(m.record.config, m.record.seed, m.record.log.slice(0, i)), seat);
  }
  return null;
}

describe('the hands of a match', () => {
  it('cover the log, hand after hand, as the engine played it', () => {
    for (const players of [2, 4] as const) {
      const m = playMatch({ players, seedChar: players === 2 ? '3' : '4', rng: 9 });
      const spans = walkMatch(m.record, m.yourSeat);
      const final = replay(m.record.config, m.record.seed, m.record.log);
      expect(spans.length).toBe(final.history.length);
      expect(spans[0].start).toBe(0);
      expect(spans[spans.length - 1].end).toBe(m.record.log.length - 1);
      spans.forEach((s, k) => {
        expect(s.index).toBe(k);
        if (k > 0) expect(s.start).toBe(spans[k - 1].end + 1);
        expect(s.summary.result).toEqual(final.history[k].result);
      });
    }
  });

  it('give the replay viewer one hand with each move and team 0 chance', () => {
    const m = playMatch({ players: 4, seedChar: '5', rng: 3, yourSeat: 1 });
    const spans = walkMatch(m.record, m.yourSeat);
    const span = spans[Math.min(2, spans.length - 1)];
    const r = replayOf(m.record, span);
    expect(r.actions.length).toBe(span.end - span.start + 1);
    expect(r.log.length).toBe(span.end + 1);
    for (const a of r.actions) {
      const p = m.record.moves[a.i].winProb;
      if (p === null) expect(a.chance).toBeNull();
      else expect(a.chance).toBeCloseTo(teamOf(a.seat) === 0 ? p : 1 - p, 12);
    }
    const names = ['Você', 'Lia', 'Iara', 'Bento'];
    for (const reveal of ['mine', 'end'] as const) {
      const { views } = replaySteps(r, names, m.yourSeat, reveal);
      expect(views.length).toBe(r.actions.length + 1);
      const last = views[views.length - 1];
      expect(last.over).toBe(true);
      // Others' cards: hidden in the middle of the hand; after it, shown only with "end".
      const others = last.seats.filter((s) => s.seat !== m.yourSeat);
      if (reveal === 'mine') expect(others.every((s) => s.cards.length === 0)).toBe(true);
      else expect(others.every((s) => s.hidden === 0)).toBe(true);
      expect(views[0].seats.filter((s) => s.seat !== m.yourSeat).every((s) => s.cards.length === 0)).toBe(true);
    }
  });
});

describe('swings', () => {
  it('are the AI estimate at the start of a hand minus the next one, or the result after the last', () => {
    for (const players of [2, 4] as const) {
      const m = playMatch({ players, seedChar: players === 2 ? '6' : '7', rng: 21 });
      const spans = walkMatch(m.record, m.yourSeat);
      const est = spans.map((s) => firstOpposing(m, s.start, s.end));
      const swings = matchSwings(m, spans);
      const final = m.record.result.winner === teamOf(m.yourSeat) ? 0 : 1;
      let j = 0;
      spans.forEach((s, k) => {
        if (est[k] === null) return;
        const next = est.slice(k + 1).find((x) => x !== null);
        const h = swings[j++];
        expect(h.hand).toBe(s.index);
        expect(h.before).toBeCloseTo(est[k]!, 12);
        expect(h.after).toBeCloseTo(next ?? final, 12);
        expect(h.swing).toBeCloseTo(h.before - h.after, 12);
      });
      expect(j).toBe(swings.length);
    }
  });

  it('skip hands without an estimate and matches without an AI across the table', () => {
    expect(matchSwings(playMatch({ seedChar: '8', noEstimate: true }))).toEqual([]);
    expect(matchSwings(playMatch({ seedChar: '9', humans: [1], kind: 'humans' }))).toEqual([]);
  });

  it('keep the five largest, newer first on ties, and the chunked scan agrees', async () => {
    const h = (matchId: string, endedAt: number, hand: number, swing: number): BestHand => ({ matchId, endedAt, hand, before: 0.5 + swing, after: 0.5, swing, tags: [] });
    const list = [h('a', 1, 0, 0.1), h('b', 2, 0, 0.3), h('c', 3, 0, 0.3), h('d', 4, 1, 0.05), h('d', 4, 2, 0.2), h('e', 5, 0, 0.25), h('f', 6, 0, 0.01)];
    const top = topHands(list);
    expect(top.map((x) => `${x.matchId}${x.hand}`)).toEqual(['c0', 'b0', 'e0', 'd2', 'a0']);
    expect([...list].sort(bySwing)[0].matchId).toBe('c');

    const matches = Array.from({ length: 45 }, (_, i) => playMatch({ players: i % 3 === 0 ? 4 : 2, seedChar: '0123456789abcdef'[i % 16], rng: 100 + i, yourSeat: i % 2 }));
    const all = bestHands(matches);
    expect(all.length).toBe(5);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].swing).toBeGreaterThanOrEqual(all[i].swing);
    expect(all.every((x) => x.swing > 0)).toBe(true);
    let calls = 0;
    const scanned = await scanBestHands(matches, { progress: () => calls++ });
    expect(scanned).toEqual(all);
    expect(calls).toBe(3);
    expect(await scanBestHands(matches, { alive: () => false })).toBeNull();
  });
});

describe('tags', () => {
  it('say what the engine shows: virada, doze and the mão de onze', () => {
    let virada = 0;
    let doze = 0;
    let onze = 0;
    // Everybody raises and accepts as much as they can, so hands reach twelve.
    const bold: Policy = (_s, _seat, legal, rng) => (legal.includes(A_RAISE) && rng() < 0.6 ? A_RAISE : legal.includes(A_ACCEPT) ? A_ACCEPT : legal[Math.floor(rng() * legal.length)]);
    for (let i = 0; i < 24; i++) {
      const m = playMatch({ players: i % 2 ? 4 : 2, seedChar: '0123456789abcdef'[i % 16], rng: 300 + i, policy: i % 3 === 0 ? { 0: bold, 1: bold, 2: bold, 3: bold } : {} });
      const mine = teamOf(m.yourSeat);
      for (const span of walkMatch(m.record, m.yourSeat)) {
        const tags = handTags(span, m.yourSeat);
        const h = span.summary;
        const isVirada = h.rounds[0]?.result === 1 - mine && h.result.winner === mine;
        expect(tags.includes('virada')).toBe(isVirada);
        expect(tags.includes('doze')).toBe(h.step === 4);
        expect(tags.includes('onze')).toBe(h.kind === 'onze');
        virada += isVirada ? 1 : 0;
        doze += h.step === 4 ? 1 : 0;
        onze += h.kind === 'onze' ? 1 : 0;
      }
    }
    expect(virada).toBeGreaterThan(0);
    expect(doze).toBeGreaterThan(0);
    expect(onze).toBeGreaterThan(0);
  });

  it('call it a bluff only when the person raised with a weak hand and the others ran', () => {
    // The person raises at the first chance; the other side always runs.
    const raise: Policy = (_s, _seat, legal, rng) => (legal.includes(A_RAISE) ? A_RAISE : legal[Math.floor(rng() * legal.length)]);
    const run: Policy = (_s, _seat, legal, rng) => (legal.includes(A_RUN) ? A_RUN : legal.filter((a) => a !== A_RAISE)[Math.floor(rng() * legal.filter((a) => a !== A_RAISE).length)] ?? legal[0]);
    let yes = 0;
    let no = 0;
    for (let i = 0; i < 12; i++) {
      const m = playMatch({ players: 2, seedChar: '0123456789abcdef'[i], rng: 500 + i, policy: { 0: raise, 1: run } });
      for (const span of walkMatch(m.record, 0)) {
        // The estimate at the person's last raise of the hand, recomputed from the state then.
        let est: number | null = null;
        let lastSeat = -1;
        for (let k = span.start; k <= span.end; k++) {
          if ((m.record.log[k] & 15) !== A_RAISE) continue;
          lastSeat = m.record.log[k] >> 4;
          est = lastSeat === 0 ? handEstimate(observe(replay(m.record.config, m.record.seed, m.record.log.slice(0, k)), 0), BASE_PARAMS) : null;
        }
        const h = span.summary;
        const bluff = h.result.reason === 'run' && h.result.winner === 0 && lastSeat === 0 && est !== null && est < WEAK_HAND;
        expect(handTags(span, 0).includes('blefe')).toBe(bluff);
        if (bluff) yes++;
        else if (h.result.reason === 'run') no++;
      }
    }
    expect(yes).toBeGreaterThan(0);
    expect(no).toBeGreaterThan(0);
  });
});

describe('history', () => {
  it('counts quick games only, an abandon as a loss, and marks every row', () => {
    const solo = playMatch({ seedChar: 'a', rng: 1 });
    const left = playMatch({ seedChar: 'b', rng: 2, abandoned: [0] });
    const friends = playMatch({ players: 4, seedChar: 'c', rng: 3, humans: [2], kind: 'friends' });
    const people = playMatch({ players: 2, seedChar: 'd', rng: 4, humans: [1], kind: 'humans' });
    const mineiro = playMatch({ variant: 'mineiro', players: 4, seedChar: 'e', rng: 5, yourSeat: 3 });
    const all = [solo, left, friends, people, mineiro];
    const score = soloScore(all);
    expect(score.total.matches).toBe(3);
    expect(score.total.wins).toBe([solo, left, mineiro].filter(personWon).length);
    expect(personWon(left)).toBe(false);
    expect(score.modes.map((x) => x.mode)).toEqual(['paulista-2', 'mineiro-4']);
    expect(matchRow(left).marks).toEqual(['abandoned']);
    expect(matchRow(friends).marks).toEqual(['friends']);
    expect(matchRow(people).marks).toEqual(['people']);
    const row = matchRow(mineiro);
    expect(row.opponents.map((s) => s.seat)).toEqual([0, 2]);
    expect(row.partner?.seat).toBe(1);
    expect(row.us).toBe(mineiro.record.result.score[1]);
    expect(matchRow(solo).partner).toBeNull();
  });
});
