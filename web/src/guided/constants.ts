// The fixed facts of the guided match's practice hand (CLIENT-SPEC 10.5): the seed, the cards, the
// seats and the timing. Only the cards module of the engine is needed here, so the page and the
// coach can read these without loading the match code (which runs in the worker, engine-host.ts).

import { manilhaRankForVira, parseCard, parseCards, strengthTable } from '../../../engine/src/cards.ts';
import { SIGNALS } from '../../../engine/src/engine.ts';

export const GUIDED_SEED = 'a'.repeat(64);
/** Matches CODE_PATTERN, so shared helpers accept it. It is never sent anywhere. */
export const GUIDED_CODE = 'TREN2';

export const YOU = 0;
export const ZAP = 1;
export const IARA = 2;
export const BENTO = 3;

/** Display offset of each AI move (a room uses AI_DELAY_MS, 700; the lesson goes a little slower). */
export const AI_MOVE_MS = 900;
/** Time between the end of a hand and the next deal, as in a room (HAND_END_DELAY_MS). */
export const HAND_END_MS = 1600;

export const GUIDED_VIRA = parseCard('6h');
export const GUIDED_HANDS: readonly (readonly number[])[] = [parseCards('7s 3d Kc'), parseCards('2s 7h Qs'), parseCards('4c Ad 2d'), parseCards('Kh 5s Jd')];

/** Each seat plays the first card of its plan still in hand. Yours is what ?demo=1 plays. */
export const PLANS: readonly (readonly number[])[] = [parseCards('3d Kc 7s'), parseCards('2s 7h Qs'), parseCards('4c Ad 2d'), parseCards('Kh 5s Jd')];

export const SIGNAL_NADA = SIGNALS.indexOf('nada');

/** Strength of every card in the practice hand (vira 6 of hearts: the sevens are manilhas). */
export const GUIDED_STRENGTH: readonly number[] = strengthTable('paulista', manilhaRankForVira(GUIDED_VIRA));
