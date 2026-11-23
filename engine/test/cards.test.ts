import { describe, expect, it } from 'vitest';
import { cardToString, manilhaRankForVira, parseCard, parseCards, strengthTable, RANKS } from '../src/cards.ts';

const order = (table: number[], cards: string) => parseCards(cards).map((c) => table[c]);

describe('card order', () => {
  it('round-trips card names', () => {
    for (let c = 0; c < 40; c++) expect(parseCard(cardToString(c))).toBe(c);
  });

  it('paulista: manilha is the rank after the vira, wrapping 3 to 4', () => {
    const next: Record<string, string> = { '4': '5', '5': '6', '6': '7', '7': 'Q', Q: 'J', J: 'K', K: 'A', A: '2', '2': '3', '3': '4' };
    for (const r of RANKS) expect(RANKS[manilhaRankForVira(parseCard(r + 'h'))]).toBe(next[r]);
  });

  it('paulista with vira 3: the fours are manilhas, clubs strongest, then hearts, spades, diamonds', () => {
    const t = strengthTable('paulista', manilhaRankForVira(parseCard('3s')));
    const s = order(t, '4c 4h 4s 4d 3c 2c Ac Kc Jc Qc 7c 6c 5c');
    for (let i = 1; i < s.length; i++) expect(s[i - 1]).toBeGreaterThan(s[i]);
  });

  it('paulista: plain cards of the same rank tie whatever the suit', () => {
    const t = strengthTable('paulista', manilhaRankForVira(parseCard('5d')));
    expect(t[parseCard('3c')]).toBe(t[parseCard('3d')]);
    expect(t[parseCard('7h')]).toBe(t[parseCard('7s')]);
  });

  it('mineiro: fixed manilhas 4c > 7h > As > 7d > 3 > 2 > A > K > J > Q > 7 > 6 > 5 > 4', () => {
    const t = strengthTable('mineiro', -1);
    const s = order(t, '4c 7h As 7d 3h 2h Ah Kh Jh Qh 7c 6h 5h 4h');
    for (let i = 1; i < s.length; i++) expect(s[i - 1]).toBeGreaterThan(s[i]);
    expect(t[parseCard('7s')]).toBe(t[parseCard('7c')]);
    expect(t[parseCard('Ac')]).toBe(t[parseCard('Ad')]);
    expect(t[parseCard('4d')]).toBe(t[parseCard('4s')]);
  });
});
