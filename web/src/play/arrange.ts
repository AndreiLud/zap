// The owner's table controls in a room with friends (M15 spec 6.4), the pure part: what each seat's
// select offers and holds, the message a choice sends, what changed between two room messages (for
// the announcement), the queue that sends the choices without flooding the room, and how the lobby
// groups the seats by team (M17). Imported only by the lobby (pages/Lobby.tsx), so it loads with the
// lobby's chunk. Texts come through `tr` (i18n's t, injected for the tests).
//
// One rule, the server's (worker/src/room-core.ts): a character shown on a free seat belongs to the
// seat; people move without it; an AI moves with its character.

import { PERSONA_ORDER, isPersonaId } from '../../../shared/lineup.ts';
import type { ClientMsg, PublicRoom, PublicSeat } from '../../../shared/protocol.ts';
import { PERSONA_NAMES } from '../game-text.ts';
import type { Key, Vars } from '../i18n.ts';

export type Tr = (key: Key, vars?: Vars) => string;
type Table = Pick<PublicRoom, 'seats' | 'settings'>;

export interface ArrangeOption {
  value: string;
  label: string;
  disabled: boolean;
}

export type ArrangeMsg = Extract<ClientMsg, { t: 'move' } | { t: 'plan' }>;

/** The seats at the table (a 1 against 1 room has two). */
function seatsOf(room: Table): PublicSeat[] {
  return room.seats.slice(0, room.settings.players);
}

/**
 * A select's value: the person now at a seat ("seat:2"), a seat free for a friend ("open"), or a
 * character playing the seat ("ai:lia").
 */
export function seatValue(seat: PublicSeat): string {
  if (seat.kind === 'human') return `seat:${seat.seat}`;
  if (seat.kind === 'ai') return `ai:${seat.persona ?? ''}`;
  return 'open';
}

/** A person's name as the owner reads it: "Você", the nickname or "Jogador N", and "fora da mesa" when away. */
export function personLabel(seat: PublicSeat, you: number | null, tr: Tr): string {
  const name = seat.seat === you ? tr('seat.you') : seat.name || tr('seat.player', { n: seat.seat + 1 });
  return seat.connected ? name : tr('play.arrange.away', { name });
}

/**
 * The options of one seat's select: the people first, in seat order (choosing one swaps the two
 * seats), then "Livre para um amigo", then the six characters. A person or a character visible on
 * another seat says where ("Ana, na cadeira 2"); a person's hidden character is never shown. In the
 * row of a connected person or of the owner only people can be chosen: nobody is pushed out of a
 * seat they are in. Someone away after a match can be replaced.
 */
export function seatOptions(room: Table, you: number | null, seat: number, tr: Tr): ArrangeOption[] {
  const seats = seatsOf(room);
  const row = seats[seat];
  const locked = row.kind === 'human' && (row.connected || row.seat === you);
  const out: ArrangeOption[] = [];
  for (const p of seats) {
    if (p.kind !== 'human') continue;
    const who = personLabel(p, you, tr);
    out.push({ value: `seat:${p.seat}`, label: p.seat === seat ? who : tr('play.arrange.at', { who, n: p.seat + 1 }), disabled: false });
  }
  out.push({ value: 'open', label: tr('play.arrange.open'), disabled: locked });
  for (const id of PERSONA_ORDER) {
    const who = tr('play.arrange.ai', { name: PERSONA_NAMES[id] });
    // People's seats publish no character, so only an AI seat or a free seat's plan is named.
    const at = seats.find((x) => x.seat !== seat && x.kind !== 'human' && x.persona === id);
    out.push({ value: `ai:${id}`, label: at ? tr('play.arrange.at', { who, n: at.seat + 1 }) : who, disabled: locked });
  }
  return out;
}

/** The message a choice sends, or null when it changes nothing (or no longer makes sense). */
export function messageFor(room: Table, seat: number, value: string): ArrangeMsg | null {
  const s = seatsOf(room)[seat];
  if (!s || value === seatValue(s)) return null;
  if (value === 'open') return { t: 'plan', seat, ai: null };
  if (value.startsWith('ai:')) {
    const id = value.slice(3);
    return isPersonaId(id) ? { t: 'plan', seat, ai: id } : null;
  }
  const m = /^seat:(\d)$/.exec(value);
  if (!m) return null;
  const from = Number(m[1]);
  return from !== seat && seatsOf(room)[from]?.kind === 'human' ? { t: 'move', from, to: seat } : null;
}

/** What a seat shows to everyone: who sits there, or the character that plays it if it stays free. */
function visible(s: PublicSeat): string {
  return `${s.kind}|${s.name}|${s.persona ?? ''}`;
}

/**
 * The owner's announcements after a room message: one sentence per seat whose visible state changed
 * ("Cadeira 2: Lia, IA.", "Cadeira 3 livre para um amigo; se ficar vazia, joga o Zap."). A swap with
 * a person's hidden character changes nothing visible, so it says nothing.
 */
export function changes(prev: Table | null, next: Table, you: number | null, tr: Tr): string[] {
  if (!prev || prev.settings.players !== next.settings.players) return [];
  const before = seatsOf(prev);
  const out: string[] = [];
  for (const s of seatsOf(next)) {
    const old = before[s.seat];
    if (old && visible(old) === visible(s)) continue;
    const n = s.seat + 1;
    if (s.kind === 'empty') out.push(s.persona ? tr('play.arrange.nowOpen', { n, who: tr(`play.who.${s.persona}`) }) : tr('play.arrange.now', { n, who: tr('play.arrange.open') }));
    else if (s.kind === 'ai') out.push(tr('play.arrange.now', { n, who: tr('play.arrange.ai', { name: s.persona ? PERSONA_NAMES[s.persona] : s.name }) }));
    else out.push(tr('play.arrange.now', { n, who: personLabel(s, you, tr) }));
  }
  return out;
}

/** One side of the table as the lobby groups it. */
export interface TeamGroup {
  /** The side by seat parity: 0 holds seats 1 and 3 (indexes 0 and 2), 1 holds seats 2 and 4. */
  team: 0 | 1;
  /** Its seat indexes in seat order: two in 2 against 2, one in 1 against 1. */
  seats: number[];
  /** Seen from the viewer's seat, as the scoreboard says it; null when the viewer has no seat. */
  side: 'us' | 'them' | null;
}

/**
 * The two sides of the table, the viewer's first: in 2 against 2 seats 1 and 3 play together
 * against seats 2 and 4, in 1 against 1 each seat is its own side. A viewer without a seat gets
 * the table's order and no side.
 */
export function teamsOf(players: 2 | 4, you: number | null): TeamGroup[] {
  const group = (team: 0 | 1, side: TeamGroup['side']): TeamGroup => ({ team, seats: players === 4 ? [team, team + 2] : [team], side });
  if (you === null) return [group(0, null), group(1, null)];
  const mine = (you & 1) as 0 | 1;
  return [group(mine, 'us'), group(mine === 0 ? 1 : 0, 'them')];
}

/**
 * A side's heading, then its seats ("cadeiras 1 e 3"). 2 against 2 uses the scoreboard's words,
 * "Nós" and "Eles", or "Time N" for a viewer without a seat; 1 against 1 has one person a side:
 * "Seu lado" and "Lado adversário", or "Lado N".
 */
export function teamTitle(g: TeamGroup, tr: Tr): { name: string; seats: string } {
  const solo = g.seats.length === 1;
  const name =
    g.side === null
      ? tr(solo ? 'play.lobby.side' : 'play.lobby.team', { n: g.team + 1 })
      : g.side === 'us'
        ? tr(solo ? 'play.lobby.sideUs' : 'team.us')
        : tr(solo ? 'play.lobby.sideThem' : 'team.them');
  const seats = solo ? tr('play.lobby.teamSeat', { n: g.seats[0] + 1 }) : tr('play.lobby.teamSeats', { a: g.seats[0] + 1, b: g.seats[1] + 1 });
  return { name, seats };
}

/**
 * A friend's seat changed without their own "Sentar aqui": the owner moved them. Returns the new
 * seat, or null. `asked(seat)` says whether this page asked for that seat (and forgets the request).
 */
export function movedTo(prev: number | null, next: number | null, asked: (seat: number) => boolean): number | null {
  if (prev === null || next === null || prev === next) return null;
  return asked(next) ? null : next;
}

/**
 * What a friend the owner moved from seat `from` to `seat` reads: the new seat, and in 2 against 2
 * also when the move put them on the other team (their groups swap and their partner changes).
 */
export function movedLine(from: number, seat: number, players: 2 | 4, tr: Tr): string {
  const other = players === 4 && (from & 1) !== (seat & 1);
  return tr(other ? 'play.lobby.movedTeam' : 'play.lobby.moved', { n: seat + 1 });
}

export interface Clock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** A seat's choice waits this long after its last change (arrow keys walk the options). */
export const ARRANGE_DELAY_MS = 400;
/** At most two sends a second: the room blocks a socket that floods it (cf/room.ts). */
export const ARRANGE_GAP_MS = 500;

/**
 * The owner's choices on their way to the room: one waiting choice per seat (the latest wins), sent
 * ARRANGE_DELAY_MS after that seat's last change, never two sends closer than ARRANGE_GAP_MS. A
 * choice equal to what the room shows is dropped. flush() sends everything at once, in seat order,
 * so "Começar partida" always follows the arrangement on the socket.
 */
export class ArrangeQueue {
  private readonly waiting = new Map<number, { value: string; due: number }>();
  private timer: unknown = null;
  private last = -Infinity;
  private dead = false;
  private readonly send: (seat: number, value: string) => void;
  private readonly clock: Clock;

  constructor(send: (seat: number, value: string) => void, clock: Clock = realClock) {
    this.send = send;
    this.clock = clock;
  }

  /** The owner chose `value` for a seat that shows `current` in the room. */
  set(seat: number, value: string, current: string): void {
    if (this.dead) return;
    if (value === current) this.waiting.delete(seat);
    else this.waiting.set(seat, { value, due: this.clock.now() + ARRANGE_DELAY_MS });
    this.schedule();
  }

  /** The choice still waiting for a seat, if any. */
  pending(seat: number): string | undefined {
    return this.waiting.get(seat)?.value;
  }

  /** Sends every waiting choice now, in seat order. */
  flush(): void {
    if (this.dead) return;
    this.stopTimer();
    const seats = [...this.waiting.keys()].sort((a, b) => a - b);
    for (const seat of seats) {
      const w = this.waiting.get(seat)!;
      this.waiting.delete(seat);
      this.send(seat, w.value);
    }
    if (seats.length) this.last = this.clock.now();
  }

  /** The lobby closed: nothing more is sent. */
  dispose(): void {
    this.dead = true;
    this.stopTimer();
    this.waiting.clear();
  }

  private next(): { seat: number; value: string; due: number } | null {
    let best: { seat: number; value: string; due: number } | null = null;
    for (const [seat, w] of this.waiting) if (!best || w.due < best.due || (w.due === best.due && seat < best.seat)) best = { seat, ...w };
    return best;
  }

  private schedule(): void {
    this.stopTimer();
    const n = this.next();
    if (!n) return;
    const at = Math.max(n.due, this.last + ARRANGE_GAP_MS);
    this.timer = this.clock.set(() => this.fire(), Math.max(0, at - this.clock.now()));
  }

  private fire(): void {
    this.timer = null;
    if (this.dead) return;
    const n = this.next();
    const now = this.clock.now();
    if (n && n.due <= now && now >= this.last + ARRANGE_GAP_MS) {
      this.waiting.delete(n.seat);
      this.last = now;
      this.send(n.seat, n.value);
    }
    this.schedule();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
  }
}
