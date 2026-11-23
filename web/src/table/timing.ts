// How long each table animation takes (CLIENT-SPEC 11.6). Every animation fits inside the server's
// display offsets (AI_DELAY_MS 700 and HAND_END_DELAY_MS 1,600 in worker/src/room-core.ts): the
// client never delays a game event to finish an animation. web/test/table-timing.test.ts checks the
// sums against those constants.

/** Between two dealt cards. */
export const DEAL_STAGGER = 30;
/** One dealt card, from the deck to its seat. */
export const DEAL_FLIGHT = 240;
/** Your cards turn face up when the last dealt card lands. */
export const REVEAL_FLIP = 120;
/** The vira turns over; it starts VIRA_AT after the deal starts. */
export const VIRA_FLIP = 240;
export const VIRA_AT = 400;
/** An AI card from the seat's avatar to its spot, turning face up on the way. */
export const AI_PLAY_FLIGHT = 280;
/** Your card from the hand to its spot. */
export const MY_PLAY_FLIGHT = 220;
/** Longest time a resolved trick stays before it gathers into its round slot. */
export const ROUND_HOLD = 900;
/** The trick into its round slot. */
export const GATHER = 220;
/** The TRUCO wall flip; letters fall TRUCO_LETTER apart. */
export const TRUCO_IN = 600;
export const TRUCO_LETTER = 50;
/** The TRUCO panel fades out (200 ms with reduced motion). */
export const TRUCO_OUT = 240;
export const TRUCO_OUT_REDUCED = 200;
/** Reduced motion: the beat before the answers of the TRUCO panel take focus. */
export const TRUCO_REDUCED_BEAT = 250;
/** The "+N" chip from the round slots to the score. */
export const COUNT_FLIGHT = 380;
/** One score mark; above MARKS_AT_ONCE points all marks fill at once. */
export const MARK_STEP = 120;
export const MARKS_AT_ONCE = 4;
/** Reduced motion: the "+N" chip stays on the score about this long. */
export const COUNT_HOLD_REDUCED = 1500;
/** After the hand event, the cards start back to the deck. */
export const HAND_GATHER_AT = 700;
/** Cards to the deck, deck to the medallion. */
export const HAND_GATHER = 400;
/** After the hand event, the table shows the next hand's "before the deal" state. */
export const PREDEAL_AT = HAND_GATHER_AT + HAND_GATHER;
/** One riffle of the deck (opening, after the gather). */
export const SHUFFLE = 600;
/** Reduced motion: nothing travels; the card appears after this share of the flight time. */
export const REDUCED_BEAT = 0.8;
/** A phrase bubble stays this long. */
export const BUBBLE_MS = 4_000;
/** The Zap's line at the end of a hand stays this long. */
export const ZAP_LINE_MS = 2_400;
/** Sentences for the screen reader that arrive this close together are joined into one line. */
export const ANNOUNCE_JOIN = 90;

/** The whole deal of `cards` cards: the last card's start, its flight and the reveal flip. */
export function dealDuration(cards: number): number {
  return (cards - 1) * DEAL_STAGGER + DEAL_FLIGHT + REVEAL_FLIP;
}
