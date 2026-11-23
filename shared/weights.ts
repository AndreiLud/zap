// How abandons weigh on a person's moves in training (contract 1.6): the export's weight of a seat
// is multiplied by 1 - min(ABANDON_MAX_CUT, abandons / max(10, seats)). The Worker's export SQL
// (worker/src/cycle-jobs.ts) and the personal page ("You against Zap", which says the floor in
// words) read the same constant from here, so the two cannot disagree. No imports: any chunk may
// take it.

/** The largest share of weight that abandons can take away. */
export const ABANDON_MAX_CUT = 0.5;
