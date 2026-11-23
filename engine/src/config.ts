// Match configuration: variant, number of players and room options.
// Defaults follow the rules table approved for launch (project_docs/rules.md).

export type Variant = 'paulista' | 'mineiro';

export interface RuleOptions {
  /** Mineiro only: 'standard' is 2, 4, 6, 10, 12; 'mineiro8' is 2, 4, 8, 10, 12. */
  ladder: 'standard' | 'mineiro8';
  /** Raise at any moment of the play instead of only on your own turn. */
  raiseAnyTime: boolean;
  /** One game of 12 points, or best of three games. */
  bestOf: 1 | 3;
  /** Mão de onze (paulista) or mão de dez (mineiro): the team on the threshold sees the partner's cards. */
  onzeSeesPartner: boolean;
  /** In a mão de onze or de dez that ends with all three rounds tied, the other team takes the hand value. */
  onzeTieToOpponents: boolean;
  /** Both teams on the threshold: 'blind' plays the mão de ferro face down, 'normal' plays a regular hand. */
  ironHand: 'blind' | 'normal';
  /** Allow a face-down card in the first round, except for the player who opens the hand. */
  faceDownFirstRound: boolean;
  /** Three tied rounds give the hand to the team of the player who opened it (the "mão"). */
  allTieToMao: boolean;
  /** Partner signals (2 against 2 only): opponents never see them, each sees with 25% chance, or all see. */
  signals: 'secret' | 'p25' | 'all';
}

export interface MatchConfig {
  variant: Variant;
  players: 2 | 4;
  options: RuleOptions;
}

export const TARGET_POINTS = 12;

export const DEFAULT_OPTIONS: Readonly<RuleOptions> = Object.freeze({
  ladder: 'standard',
  raiseAnyTime: false,
  bestOf: 1,
  onzeSeesPartner: true,
  onzeTieToOpponents: false,
  ironHand: 'blind',
  faceDownFirstRound: false,
  allTieToMao: false,
  signals: 'p25',
});

const LADDERS = {
  paulista: [1, 3, 6, 9, 12],
  mineiro: [2, 4, 6, 10, 12],
  mineiro8: [2, 4, 8, 10, 12],
} as const;

export function makeConfig(variant: Variant, players: 2 | 4, options: Partial<RuleOptions> = {}): MatchConfig {
  const o: RuleOptions = { ...DEFAULT_OPTIONS, ...options };
  validateConfig({ variant, players, options: o });
  return { variant, players, options: o };
}

export function validateConfig(c: MatchConfig): void {
  if (c.variant !== 'paulista' && c.variant !== 'mineiro') throw new Error('bad variant');
  if (c.players !== 2 && c.players !== 4) throw new Error('bad players');
  const o = c.options;
  if (o.ladder !== 'standard' && o.ladder !== 'mineiro8') throw new Error('bad ladder');
  if (o.ladder === 'mineiro8' && c.variant !== 'mineiro') throw new Error('mineiro8 ladder is mineiro only');
  if (o.bestOf !== 1 && o.bestOf !== 3) throw new Error('bad bestOf');
  if (o.ironHand !== 'blind' && o.ironHand !== 'normal') throw new Error('bad ironHand');
  if (o.signals !== 'secret' && o.signals !== 'p25' && o.signals !== 'all') throw new Error('bad signals');
  for (const k of ['raiseAnyTime', 'onzeSeesPartner', 'onzeTieToOpponents', 'faceDownFirstRound', 'allTieToMao'] as const) {
    if (typeof o[k] !== 'boolean') throw new Error(`bad ${k}`);
  }
}

/** Hand values by step: index 0 is the starting value, 1 is truco, then the raises up to 12. */
export function ladderOf(c: MatchConfig): readonly number[] {
  if (c.variant === 'paulista') return LADDERS.paulista;
  return c.options.ladder === 'mineiro8' ? LADDERS.mineiro8 : LADDERS.mineiro;
}

/** Score that triggers the mão de onze (paulista, 11) or mão de dez (mineiro, 10). */
export function onzeThreshold(c: MatchConfig): number {
  return c.variant === 'paulista' ? 11 : 10;
}

/** Hand value when the team on the threshold plays. */
export function onzeValue(c: MatchConfig): number {
  return c.variant === 'paulista' ? 3 : 4;
}

/** Points the other team receives when the team on the threshold runs. */
export function onzeRunPoints(c: MatchConfig): number {
  return c.variant === 'paulista' ? 1 : 2;
}

export const MAX_STEP = 4;
