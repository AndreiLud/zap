// The rating of "You against Zap" (DATA-SPEC 5.3): the Weng-Lin Bradley-Terry full update of
// shared/rating.ts against openskill (the oracle, a dev dependency only) and against the formulas
// of the spec written out again here; the anchors against their definition; and the sequence a
// fixture of records gives.

import { rate } from 'openskill';
import { bradleyTerryFull } from 'openskill/models';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../engine/src/rng.ts';
import { BETA, KAPPA, MU_REF, MU_START, SIGMA_ANCHOR, SIGMA_START, anchorMu, heuristicMu, rateTeams, teamC, type Rating } from '../../shared/rating.ts';
import facts from '../src/data/generated/facts-view.json';
import { anchorBook, rateMatches, type AnchorFacts, type AnchorSummary } from '../src/you-vs-zap/rating.ts';
import { personWon } from '../src/you-vs-zap/history.ts';
import { playMatch } from './vs-fixtures.ts';

const FACTS = facts as unknown as AnchorFacts;

/** The update of the spec, written from its formulas (5.3), for one team i against the others. */
function independent(teams: Rating[][], rank: number[]): Rating[][] {
  const mu = teams.map((t) => t.reduce((a, r) => a + r.mu, 0));
  const s2 = teams.map((t) => t.reduce((a, r) => a + r.sigma ** 2, 0));
  return teams.map((team, i) => {
    let omega = 0;
    let delta = 0;
    teams.forEach((_, q) => {
      if (q === i) return;
      const c = Math.sqrt(s2[i] + s2[q] + 2 * BETA ** 2);
      const piq = Math.exp(mu[i] / c) / (Math.exp(mu[i] / c) + Math.exp(mu[q] / c));
      const pqi = 1 - piq;
      const s = rank[i] < rank[q] ? 1 : rank[i] > rank[q] ? 0 : 0.5;
      const gamma = Math.sqrt(s2[i]) / c;
      omega += (s2[i] / c) * (s - piq);
      delta += gamma * (s2[i] / c ** 2) * piq * pqi;
    });
    return team.map((r) => ({
      mu: r.mu + ((r.sigma ** 2) / s2[i]) * omega,
      sigma: Math.sqrt(r.sigma ** 2 * Math.max(1 - ((r.sigma ** 2) / s2[i]) * delta, KAPPA)),
    }));
  });
}

function randomTeams(rng: () => number): { teams: Rating[][]; rank: number[] } {
  const size = rng() < 0.5 ? 1 : 2;
  const person = { mu: 10 + rng() * 30, sigma: 0.5 + rng() * 8 };
  const anchor = () => ({ mu: 10 + rng() * 30, sigma: SIGMA_ANCHOR });
  const us = size === 1 ? [person] : [person, anchor()];
  const them = size === 1 ? [anchor()] : [anchor(), anchor()];
  const r = rng();
  return { teams: [us, them], rank: r < 0.45 ? [0, 1] : r < 0.9 ? [1, 0] : [0, 0] };
}

describe('Weng-Lin Bradley-Terry full update', () => {
  it('matches openskill (tau 0) within 1e-9', () => {
    const rng = mulberry32(2026);
    for (let k = 0; k < 500; k++) {
      const { teams, rank } = randomTeams(rng);
      const ours = rateTeams(teams, rank);
      const oracle = rate(teams, { model: bradleyTerryFull, tau: 0, rank });
      ours.forEach((team, i) =>
        team.forEach((r, j) => {
          expect(Math.abs(r.mu - oracle[i][j].mu)).toBeLessThan(1e-9);
          expect(Math.abs(r.sigma - oracle[i][j].sigma)).toBeLessThan(1e-9);
        }),
      );
    }
  });

  it('matches the formulas of the spec within 1e-9', () => {
    const rng = mulberry32(11);
    for (let k = 0; k < 500; k++) {
      const { teams, rank } = randomTeams(rng);
      const ours = rateTeams(teams, rank);
      const spec = independent(teams, rank);
      ours.forEach((team, i) =>
        team.forEach((r, j) => {
          expect(Math.abs(r.mu - spec[i][j].mu)).toBeLessThan(1e-9);
          expect(Math.abs(r.sigma - spec[i][j].sigma)).toBeLessThan(1e-9);
        }),
      );
    }
  });

  it('moves a winner up, a loser down, and never widens a band', () => {
    const start = { mu: MU_START, sigma: SIGMA_START };
    const zap = { mu: MU_REF, sigma: SIGMA_ANCHOR };
    const won = rateTeams([[start], [zap]], [0, 1])[0][0];
    const lost = rateTeams([[start], [zap]], [1, 0])[0][0];
    expect(won.mu).toBeGreaterThan(start.mu);
    expect(lost.mu).toBeLessThan(start.mu);
    expect(won.sigma).toBeLessThan(start.sigma);
    expect(lost.sigma).toBeLessThan(start.sigma);
  });
});

describe('anchors', () => {
  const p = (muA: number, muB: number, size: 1 | 2) => 1 / (1 + Math.exp((muB - muA) / teamC(size)));

  it('place a character where its measured score against a team of Zap comes back', () => {
    for (const s of [0.1, 0.266, 0.41, 0.5, 0.7]) {
      const zapMu = 27.3;
      expect(p(anchorMu(s, 1, zapMu), zapMu, 1)).toBeCloseTo(s, 12);
      // 2 against 2: a team of two such characters against two Zaps.
      expect(p(2 * anchorMu(s, 2, zapMu), 2 * zapMu, 2)).toBeCloseTo(s, 12);
    }
    expect(anchorMu(0.5, 1, 30)).toBe(30);
    // Lopsided scores are clamped, so every anchor stays finite.
    expect(Number.isFinite(anchorMu(0, 1, MU_REF))).toBe(true);
    expect(anchorMu(1, 2, MU_REF)).toBe(anchorMu(0.98, 2, MU_REF));
  });

  it('put the tuned rules player where Zap v1 scores its measured share against it', () => {
    const s = FACTS.ai.strengthByVersion!.v1!.table!['zap-tuned']!.overall!.mean;
    expect(p(MU_REF, heuristicMu(s, 1), 1)).toBeCloseTo(s, 12);
    expect(p(2 * MU_REF, 2 * heuristicMu(s, 2), 2)).toBeCloseTo(s, 12);
  });

  it('read v1, v2 and the rules player from the facts, and later versions from the summary', () => {
    const summary: AnchorSummary = {
      versions: [{ version: 'v3', anchors: { v1: { mean: 0.75 } }, personas: { stats: { otavio: { vsZap: 0.25 }, bento: { vsZap: 0.3 }, lia: { vsZap: 0.3 }, ravi: { vsZap: 0.3 }, iara: { vsZap: 0.4 } } } }],
    };
    const book = anchorBook(FACTS, summary);
    expect(book.seat('zap', 'v1', 1)).toBe(MU_REF);
    expect(book.seat(null, 'v1', 2)).toBe(MU_REF);
    const h2h = FACTS.ai.releases!.v2!.headToHeadV1!.mean;
    expect(book.seat('zap', 'v2', 1)).toBeCloseTo(anchorMu(h2h, 1, MU_REF), 12);
    expect(book.seat('zap', 'v2', 1)!).toBeGreaterThan(MU_REF);
    // v2's characters from the fresh deals of its check.
    const fresh = (FACTS.ai.personasByVersion!.v2!.freshCheck!.vsZap as Record<string, { mean: number }>).otavio.mean;
    expect(book.seat('otavio', 'v2', 1)).toBeCloseTo(anchorMu(fresh, 1, anchorMu(h2h, 1, MU_REF)), 12);
    expect(book.seat('iara', 'v3', 2)).toBeCloseTo(anchorMu(0.4, 2, anchorMu(0.75, 2, MU_REF)), 12);
    expect(book.seat('bento', 'v9', 1)).toBeNull();
    const hs = new Set(['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'].map((id) => book.seat(id as 'zap', 'heuristic', 1)));
    expect(hs.size).toBe(1);
    expect(book.cast('v2', 1)!.map((c) => c.id)).toEqual(['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap']);
    expect(book.cast('v9', 1)).toBeNull();
  });
});

describe('the person rating over a fixture of records', () => {
  it('follows openskill match by match, per table size, with abandons as losses and unknown versions left out', () => {
    const book = anchorBook(FACTS, null);
    const matches = [
      playMatch({ players: 2, seedChar: 'a', rng: 1, personas: { 1: 'bento' } }),
      playMatch({ players: 2, seedChar: 'b', rng: 2, personas: { 1: 'iara' } }),
      playMatch({ players: 4, seedChar: 'c', rng: 3, personas: { 1: 'lia', 2: 'otavio', 3: 'ravi' }, partnerVersion: 'v1' }),
      playMatch({ players: 2, seedChar: 'd', rng: 4, personas: { 1: 'zap' }, abandoned: [0] }),
      playMatch({ players: 2, seedChar: 'e', rng: 5, version: 'v9' }),
      playMatch({ players: 2, seedChar: 'f', rng: 6, version: 'heuristic', personas: { 1: 'ravi' } }),
      // Friends and other people: listed, never rated.
      playMatch({ players: 4, seedChar: '1', rng: 7, humans: [2], kind: 'friends' }),
    ];
    const out = rateMatches(matches, book);
    expect(out[1].unrated).toBe(1);
    expect(out[1].points.length).toBe(4);
    expect(out[2].points.length).toBe(1);

    // The same sequence through openskill.
    let one: Rating = { mu: MU_START, sigma: SIGMA_START };
    const expectOne: Rating[] = [];
    for (const m of [matches[0], matches[1], matches[3], matches[5]]) {
      const opp = m.record.seats[1];
      const them = { mu: book.seat(opp.persona, opp.aiVersion, 1)!, sigma: SIGMA_ANCHOR };
      const won = personWon(m);
      one = rate([[one], [them]], { model: bradleyTerryFull, tau: 0, rank: won ? [1, 2] : [2, 1] })[0][0];
      expectOne.push(one);
    }
    out[1].points.forEach((pt, i) => {
      expect(Math.abs(pt.mu - expectOne[i].mu)).toBeLessThan(1e-9);
      expect(Math.abs(pt.sigma - expectOne[i].sigma)).toBeLessThan(1e-9);
    });
    // The abandoned match is a loss whatever the table's result.
    expect(personWon(matches[3])).toBe(false);

    const m2 = matches[2];
    const seat = (k: number) => ({ mu: book.seat(m2.record.seats[k].persona, m2.record.seats[k].aiVersion, 2)!, sigma: SIGMA_ANCHOR });
    const two = rate(
      [
        [{ mu: MU_START, sigma: SIGMA_START }, seat(2)],
        [seat(1), seat(3)],
      ],
      { model: bradleyTerryFull, tau: 0, rank: personWon(m2) ? [1, 2] : [2, 1] },
    )[0][0];
    expect(Math.abs(out[2].now.mu - two.mu)).toBeLessThan(1e-9);
    expect(Math.abs(out[2].now.sigma - two.sigma)).toBeLessThan(1e-9);
    // The partner of v1 sits at v1's anchor.
    expect(book.seat('otavio', 'v1', 2)).toBe(seat(2).mu);
  });
});
