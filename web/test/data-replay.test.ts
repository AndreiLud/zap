// The replay viewer's steps (DATA-SPEC F23, 5.6): the engine rebuilds the hand from the log, one
// view and one sentence per move, every card accounted for, and the personal view hides the cards
// of the other seats until they are played face up.

import { beforeAll, describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, legalActions, newMatch } from '../../engine/src/engine.ts';
import { mulberry32 } from '../../engine/src/rng.ts';
import { replaySteps, teamNamesOf, type ReplayData } from '../src/data/ReplayViewer.tsx';
import { loadData } from '../src/i18n.ts';

// The data area of the locales loads on demand (i18n.ts loadData), as the data pages do.
beforeAll(() => loadData('pt'));

/** A self play match with random legal moves (no signals), cut at the end of hand `target`. */
function sample(players: 2 | 4, target: number, seed: string, rngSeed: number): ReplayData {
  const config = makeConfig('paulista', players);
  const s = newMatch(config, seed.repeat(64).slice(0, 64));
  const rng = mulberry32(rngSeed);
  const actions: ReplayData['actions'] = [];
  while (!s.over && s.handIndex <= target) {
    let moved = false;
    for (let seat = 0; seat < s.n && !moved; seat++) {
      const legal = legalActions(s, seat).filter((a) => a < 9);
      if (!legal.length) continue;
      const a = legal[Math.floor(rng() * legal.length)];
      const i = s.log.length;
      const inHand = s.handIndex === target;
      applyAction(s, seat, a);
      if (inHand) actions.push({ i, seat, action: a, chance: rng() });
      moved = true;
    }
    if (!moved) break;
  }
  return { id: 'x', config, seed: seed.repeat(64).slice(0, 64), log: s.log.slice(0, actions[actions.length - 1].i + 1), handIndex: target, actions };
}

describe('replay steps', () => {
  for (const players of [2, 4] as const) {
    it(`rebuilds every move of a hand, ${players} players`, () => {
      const r = sample(players, 1, 'c', 11 + players);
      const names = ['Zap', 'Lia', 'Bento', 'Iara'].slice(0, players);
      const { views, texts } = replaySteps(r, names, -1, 'all');
      expect(views.length).toBe(r.actions.length + 1);
      expect(texts.length).toBe(r.actions.length + 1);
      texts.slice(1).forEach((x, j) => expect(x.length, `move ${j + 1}`).toBeGreaterThan(0));
      // Every card of the hand is in a hand or on the table, at every step.
      for (const v of views) {
        const inHands = v.seats.reduce((n, sv) => n + sv.cards.length, 0);
        const played = v.rounds.reduce((n, rd) => n + rd.plays.length, 0);
        expect(inHands + played).toBe(3 * players);
      }
      // Without a person at the table, team sentences name the teams, never "você" or "nós".
      expect(texts.join(' ')).not.toMatch(/\b(Você|Nós)\b/);
      const last = texts[texts.length - 1];
      const [a, b] = teamNamesOf(names, players);
      expect(last.includes(a) || last.includes(b) || /empatou/.test(last)).toBe(true);
    });
  }

  it('shows only the person and the cards played face up in the personal view', () => {
    const r = sample(4, 2, 'd', 5);
    const { views } = replaySteps(r, ['Você', 'Lia', 'Bento', 'Iara'], 0, 'mine');
    const start = views[0];
    expect(start.seats[0].cards.length).toBe(3);
    for (const sv of start.seats.slice(1)) {
      expect(sv.cards).toEqual([]);
      expect(sv.hidden).toBe(3);
    }
  });

  it('names the teams by their players', () => {
    expect(teamNamesOf(['Zap', 'Lia', 'Bento', 'Iara'], 4)).toEqual(['Zap e Bento', 'Lia e Iara']);
    expect(teamNamesOf(['Zap', 'Lia'], 2)).toEqual(['Zap', 'Lia']);
  });
});
