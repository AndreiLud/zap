// Words the parts of the personal page share: mode names, seat names, who sat across the table.

import { PERSONA_NAMES } from '../game-text.ts';
import { t, type Key } from '../i18n.ts';
import type { ModeKey, PersonMatch, SeatInfo } from './history.ts';

/** "Paulista, 1 against 1". */
export function modeName(mode: ModeKey): string {
  const [variant, players] = mode.split('-');
  return t('data.vs.mode', { variant: t(`variant.${variant}` as Key), players: t(`mode.${players}` as Key) });
}

/** Two names as one ("Bento e Lia"), or the name alone. */
function joinNames(names: readonly string[]): string {
  if (names.length === 2) return t('data.replay.pair', { a: names[0], b: names[1] });
  return names.join(', ');
}

/** Who sat on a side: the characters and their version, then the people ("Bento e Lia (v2)"). */
export function seatsText(seats: readonly SeatInfo[]): string {
  const ai = seats.filter((s) => s.kind === 'ai');
  const people = seats.length - ai.length;
  const parts: string[] = [];
  if (ai.length > 0) {
    const versions = [...new Set(ai.map((s) => s.version ?? ''))].filter((v) => v !== '');
    const who = joinNames(ai.map((s) => PERSONA_NAMES[s.persona ?? 'zap']));
    parts.push(versions.length === 1 ? t('data.vs.seatVersion', { who, version: versions[0] }) : who);
  }
  if (people === 1) parts.push(t('data.vs.person.one'));
  if (people > 1) parts.push(t('data.vs.person.other', { n: people }));
  return parts.join(', ');
}

/** The partner cell: the AI partner with its version, a person, or none in 1 against 1. */
export function partnerText(p: SeatInfo | null): string {
  if (!p) return t('data.vs.noPartner');
  return seatsText([p]);
}

/** Display name of every seat of a match, for the replay viewer: "Você", the characters, the people. */
export function seatNames(m: PersonMatch): string[] {
  const r = m.record;
  return Array.from({ length: r.config.players }, (_, seat) => {
    if (seat === m.yourSeat) return t('seat.you');
    const s = r.seats.find((x) => x.seat === seat);
    if (!s || s.kind === 'human') return t('seat.player', { n: seat + 1 });
    return PERSONA_NAMES[s.persona ?? 'zap'];
  });
}

/** Every other seat is an AI: the replay may show every card once a hand is over (DATA-SPEC 5.6). */
export function aloneWithAi(m: PersonMatch): boolean {
  return m.record.seats.every((s) => s.seat === m.yourSeat || s.kind === 'ai');
}

/**
 * The line about the reading during a match, under "How Zap reads you". A person with "Don't adapt
 * to me" on is never read: from their next match the room masks their whole table
 * (worker/src/room-core.ts, ai/src/features.ts), whatever the version in play can do. For everyone
 * else the line follows the version in play (/api/live adapt). `on` is the page's data-on.
 */
export function inMatchLine(inMatch: boolean, noAdapt: boolean): { on: boolean; key: Key } {
  if (noAdapt) return { on: false, key: 'data.vs.p3.inmatch.noAdapt' };
  return inMatch ? { on: true, key: 'data.vs.p3.inmatch.on' } : { on: false, key: 'data.vs.p3.inmatch.off' };
}
