// The rating model of "You against Zap" (milestone 7, DATA-SPEC 5.3): Weng-Lin with the
// Bradley-Terry full pairing, the model of OpenSkill, written out here with no library so the
// Worker can reuse it for a future public ranking. One rating for 1 against 1 and one for 2 against 2.
//
// The AI seats are fixed anchors: each (character, version, table size) sits at a mu derived from
// its measured score against a team of Zap, with a small fixed sigma, and only the person's rating
// moves. A team's mu is the sum of its members' mu, so
//
//   P(A beats B) = 1 / (1 + exp((mu_B - mu_A) / c)),   c = teamC(size)
//
// and a team that scores s against a team of Zap sits at zapMu + c * logit(s) / k, where k is the
// number of members whose mu differs from Zap's (1 in 1 against 1; 2 in 2 against 2, where both
// members of the character's team are that character).

/** Performance spread of one player (OpenSkill's default, 25 / 6). */
export const BETA = 25 / 6;
/** The level of Zap v1 with its shipped knobs: the reference every anchor is placed against. */
export const MU_REF = 25;
/** Sigma of every anchor: the AI seats are measured, not estimated from this person's games. */
export const SIGMA_ANCHOR = 1;
/** Where a person starts (OpenSkill's default): mu 25, sigma 25 / 3. */
export const MU_START = 25;
export const SIGMA_START = 25 / 3;
/** OpenSkill's floor on the share of variance a game may remove. */
export const KAPPA = 0.0001;
/** Scores are clamped to this range before the logit, so a lopsided measurement stays finite. */
export const SCORE_CLAMP = [0.02, 0.98] as const;

export type TeamSize = 1 | 2;

export interface Rating {
  mu: number;
  sigma: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/**
 * The c of a match between two anchored teams: 1 against 1 is two anchors of one player, 2 against 2
 * two teams of two (each anchor with SIGMA_ANCHOR).
 */
export function teamC(size: TeamSize): number {
  return Math.sqrt(2 * size * SIGMA_ANCHOR ** 2 + 2 * BETA ** 2);
}

/** The mu of a player whose team scores s against a team of Zap at zapMu. */
export function anchorMu(s: number, size: TeamSize, zapMu: number): number {
  const k = size === 2 ? 2 : 1;
  return zapMu + (teamC(size) * logit(clamp(s, SCORE_CLAMP[0], SCORE_CLAMP[1]))) / k;
}

/**
 * The tuned rules player (the AI of "heuristic" mode, which plays every character): Zap v1 scores
 * `zapScore` against it, so it sits below MU_REF by the same distance.
 */
export function heuristicMu(zapScore: number, size: TeamSize): number {
  return anchorMu(1 - zapScore, size, MU_REF);
}

/**
 * One Weng-Lin update with the Bradley-Terry full pairing, as OpenSkill's bradleyTerryFull with its
 * defaults (beta 25 / 6, kappa 0.0001, gamma = sigma_i / c_iq, no balance) and tau 0, so a game
 * never widens a band by itself. `rank[i]` is team i's place (lower is better; equal places tie).
 * Returns every member's new rating, in the same shape.
 */
export function rateTeams(teams: readonly (readonly Rating[])[], rank: readonly number[]): Rating[][] {
  const twoBetaSq = 2 * BETA * BETA;
  const sums = teams.map((team) => ({
    mu: team.reduce((a, r) => a + r.mu, 0),
    sigmaSq: team.reduce((a, r) => a + r.sigma * r.sigma, 0),
  }));
  return teams.map((team, i) => {
    let omega = 0;
    let delta = 0;
    for (let q = 0; q < teams.length; q++) {
      if (q === i) continue;
      const c = Math.sqrt(sums[i].sigmaSq + sums[q].sigmaSq + twoBetaSq);
      const p = 1 / (1 + Math.exp((sums[q].mu - sums[i].mu) / c));
      const s = rank[q] > rank[i] ? 1 : rank[q] < rank[i] ? 0 : 0.5;
      const eta = sums[i].sigmaSq / c;
      const gamma = Math.sqrt(sums[i].sigmaSq) / c;
      omega += eta * (s - p);
      delta += ((gamma * eta) / c) * p * (1 - p);
    }
    return team.map((r) => {
      const share = (r.sigma * r.sigma) / sums[i].sigmaSq;
      return { mu: r.mu + share * omega, sigma: r.sigma * Math.sqrt(Math.max(1 - share * delta, KAPPA)) };
    });
  });
}
