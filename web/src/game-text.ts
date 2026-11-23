// Words for the table: card names, seat names, bet calls and one sentence per game event, used
// both on screen and in the screen reader announcements.

import { MINEIRO_MANILHAS, rankOf, suitOf } from '../../engine/src/cards.ts';
import { SIGNALS, TIE, type GameEvent } from '../../engine/src/engine.ts';
import { HIDDEN } from '../../engine/src/observe.ts';
import type { PersonaId } from '../../ai/src/personas.ts';
import type { PhraseKey, PublicRoom, PublicSeat } from '../../shared/protocol.ts';
import { t, tn, type Key } from './i18n.ts';
import { UNKNOWN } from './table-view.ts';

export const PERSONA_IDS: readonly PersonaId[] = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];
export const PERSONA_NAMES: Record<PersonaId, string> = { otavio: 'Otávio', bento: 'Bento', lia: 'Lia', ravi: 'Ravi', iara: 'Iara', zap: 'Zap' };

export function isKnownCard(c: number): boolean {
  return c >= 0 && c < 40;
}

/** "7 de copas" / "7 of hearts". */
export function cardName(c: number): string {
  if (c === HIDDEN || c === UNKNOWN || !isKnownCard(c)) return t('card.hidden');
  return t('card.of', { rank: t(`rank.${rankOf(c)}` as Key), suit: t(`suit.${suitOf(c)}` as Key) });
}

/** "o 7 de copas" / "the 7 of hearts". */
function cardWithArticle(c: number): string {
  return t('card.of', { rank: t(`rank.the.${rankOf(c)}` as Key), suit: t(`suit.${suitOf(c)}` as Key) });
}

/** Name of the bet that takes the hand to this value: truco, seis, nove... */
export function callName(value: number, step: number, button: boolean): string {
  const k = step <= 1 ? 'truco' : String(value);
  return t(`${button ? 'call' : 'callw'}.${k}` as Key);
}

export function signalName(sig: number, short: boolean): string {
  return t(`${short ? 'signal' : 'signalw'}.${SIGNALS[sig]}` as Key);
}

export function phraseText(key: PhraseKey): string {
  return t(`phrase.${key}`);
}

export function personaStyle(p: PersonaId): string {
  return t(`persona.${p}.style`);
}

export interface Names {
  you: number;
  players: number;
  room: PublicRoom | null;
  variant: 'paulista' | 'mineiro';
}

export function seatName(n: Names, seat: number): string {
  if (seat === n.you) return t('seat.you');
  const s = n.room?.seats[seat];
  if (s && s.kind === 'human' && !s.name) return humanName(s.seat);
  if (!s || !s.name) return t('seat.number', { n: seat + 1 });
  return s.name;
}

/** A person without a nickname (or with one reported and waiting for review): "Jogador 3". */
export function humanName(seat: number): string {
  return t('seat.player', { n: seat + 1 });
}

/** Team label for scores: Nós / Eles in 2 against 2; Você / the opponent in 1 against 1. */
export function teamLabel(n: Names, team: number): string {
  const mine = n.you >= 0 ? n.you & 1 : 0;
  if (n.players === 2) return team === mine ? t('seat.you') : seatName(n, team === 0 ? 0 : 1);
  return team === mine ? t('team.us') : t('team.them');
}

const ORD: Key[] = ['ord.0', 'ord.1', 'ord.2'];

/** One sentence per game event, from the point of view of seat n.you. */
export function describeEvent(e: GameEvent, n: Names): string {
  const who = (seat: number, base: string, vars: Record<string, string | number> = {}) =>
    seat === n.you ? t(`${base}.you` as Key, vars) : t(`${base}.other` as Key, { ...vars, name: seatName(n, seat) });
  // Team sentences: us/them in 2 against 2, you/name in 1 against 1.
  const team = (winner: number, base: string, vars: Record<string, string | number> = {}) => {
    const mine = (n.you >= 0 ? n.you : 0) & 1;
    if (n.players === 4) return t(`${base}.${winner === mine ? 'us' : 'them'}` as Key, vars);
    return who(winner === mine ? n.you : (n.you + 1) % 2, base, vars);
  };
  switch (e.t) {
    case 'deal':
      if (e.kind === 'iron') return t('ev.deal.iron');
      if (e.kind === 'onze') {
        const base = e.onzeTeam === ((n.you >= 0 ? n.you : 0) & 1) ? 'ev.deal.onze.mine' : 'ev.deal.onze.theirs';
        return t(base as Key, { hand: onzeHandName(n.variant) });
      }
      return e.vira >= 0 ? t('ev.deal.vira', { card: cardName(e.vira) }) : t('ev.deal');
    case 'onze':
      return who(e.seat, e.play ? 'ev.onze.play' : 'ev.onze.run', { hand: onzeHandName(n.variant) });
    case 'play':
      if (e.faceDown) return who(e.seat, 'ev.cover', { card: isKnownCard(e.card) ? cardWithArticle(e.card) : '' });
      return who(e.seat, 'ev.play', { card: isKnownCard(e.card) ? cardWithArticle(e.card) : t('card.hidden') });
    case 'raise':
      return who(e.seat, 'ev.raise', { call: callName(e.value, e.step, false), value: e.value });
    case 'accept':
      return who(e.seat, 'ev.accept', { value: e.value });
    case 'run':
      return who(e.seat, 'ev.run');
    case 'signal':
      return who(e.seat, 'ev.signal', { signal: signalName(e.signal, false) });
    case 'round':
      if (e.result === TIE) return t('ev.round.tie', { ord: t(ORD[e.round] ?? 'ord.2') });
      return who(e.winnerSeat, 'ev.round', { ord: t(ORD[e.round] ?? 'ord.2') });
    case 'hand': {
      const score = scoreSentence(n, e.score);
      if (e.winner < 0) return `${t('ev.hand.tie')} ${score}`;
      return `${team(e.winner, 'ev.hand', { points: tn('points', e.points) })} ${score}`;
    }
    case 'game':
      return team(e.winner, 'ev.game');
    case 'match':
      return team(e.winner, 'ev.match');
  }
}

/** "mão de onze" in paulista, "mão de dez" in mineiro. */
export function onzeHandName(variant: 'paulista' | 'mineiro'): string {
  return t(variant === 'paulista' ? 'onze.paulista' : 'onze.mineiro');
}

export function scoreSentence(n: Names, score: readonly number[]): string {
  const mine = (n.you >= 0 ? n.you : 0) & 1;
  const us = score[mine];
  const them = score[1 - mine];
  if (n.players === 4) return t('score.sentence.4', { us, them });
  return t('score.sentence.2', { us, them, name: seatName(n, (Math.max(n.you, 0) + 1) % 2) });
}

export function describePhrase(seat: number, key: PhraseKey, n: Names): string {
  return seat === n.you ? t('ev.phrase.you', { text: phraseText(key) }) : t('ev.phrase.other', { name: seatName(n, seat), text: phraseText(key) });
}

// -------------------------------------------------------------------------------------------------
// The table's words (CLIENT-SPEC 11 and 13)

/** The manilha name of a card's suit: pica-fumo, espadilha, copas, zap. */
export function manilhaName(c: number): string {
  return t(`board.manilha.${suitOf(c)}` as Key);
}

/** Whether a card is a manilha of this hand (paulista: the rank after the vira; mineiro: the four fixed cards). */
export function isManilhaOf(v: { variant: 'paulista' | 'mineiro'; manilhaRank: number }, c: number): boolean {
  if (!isKnownCard(c)) return false;
  return v.variant === 'mineiro' ? MINEIRO_MANILHAS.includes(c) : rankOf(c) === v.manilhaRank;
}

/**
 * Accessible name of a card in your hand, exactly "{card}[, manilha {name}][, coberta]" (the e2e
 * helper reads the card from the text before the first comma). A card you cannot see (a blind
 * hand) is "Carta 2, escondida".
 */
export function handCardLabel(c: number, position: number, manilha: boolean, cover: boolean): string {
  const base = isKnownCard(c) ? cardName(c) : t('card.hiddenSlot', { n: position });
  return `${base}${manilha ? `, ${t('card.manilha')} ${manilhaName(c)}` : ''}${cover ? `, ${t('card.facedown')}` : ''}`;
}

/** "1, 2 e 3", "1 e 2" or "1": the keys of the cards still in hand. */
export function keyList(count: number): string {
  const ks = Array.from({ length: Math.max(1, count) }, (_, i) => String(i + 1));
  return ks.length > 1 ? `${ks.slice(0, -1).join(', ')}${t('board.keys.and')}${ks[ks.length - 1]}` : ks[0];
}

/** "Vez do Zap", "Vez da Iara" (each character with its article), "Vez de Ana" for a person. */
export function turnText(n: Names, seat: number): string {
  const s = n.room?.seats[seat];
  if (s?.kind === 'ai' && s.persona) return t(`board.turn.${s.persona}` as Key);
  return t('board.turn.person', { name: seatName(n, seat) });
}

/** "do Zap", "da Iara" (each character with its article), "de Ana" for a person; "Zap's" in English. */
export function seatOf(n: Names, seat: number): string {
  const s = n.room?.seats[seat];
  if (s?.kind === 'ai' && s.persona) return t(`board.of.${s.persona}` as Key);
  return t('board.of.person', { name: seatName(n, seat) });
}

/**
 * Accessible name of a seat: "Zap, inteligência artificial, o mais forte. Outra dupla." plus
 * "Vez de jogar." when it is its turn. People: name, the seal, and their state.
 */
export function seatAria(n: Names, pub: PublicSeat | undefined, seat: number, active: boolean): string {
  const parts: string[] = [];
  if (pub?.kind === 'ai' && pub.persona) parts.push(t('board.seat.ai', { name: seatName(n, seat), style: personaStyle(pub.persona) }));
  else parts.push(t('board.seat.person', { name: seatName(n, seat) }));
  if (pub?.kind === 'human') {
    if (pub.verified) parts.push(t('board.seat.verified'));
    if (pub.aiPlaying) parts.push(t('board.seat.aiPlaying'));
    else if (!pub.connected) parts.push(t('board.seat.away'));
  }
  if (n.players === 4) parts.push(t((seat & 1) === (n.you & 1) ? 'board.seat.partner' : 'board.seat.other'));
  if (active) parts.push(t('board.seat.turn'));
  return parts.join(' ');
}

/** Your cards for the screen reader: "7 de espadas, manilha espadilha; 3 de ouros". */
export function handWords(v: { hand: number[]; variant: 'paulista' | 'mineiro'; manilhaRank: number }): string {
  return v.hand
    .filter((c) => c !== -1)
    .map((c) => (isManilhaOf(v, c) ? t('board.say.manilha', { card: cardName(c), mname: manilhaName(c) }) : cardName(c)))
    .join('; ');
}
