// The owner's table controls in the lobby (M15 spec 6.4), the pure part (web/src/play/arrange.ts):
// what each seat's select offers, the message a choice sends, the owner's announcements, the
// friend's "moved" line, the queue that sends the choices without flooding the room, and the
// lobby's team groups (M17).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PersonaId } from '../../ai/src/personas.ts';
import type { PublicRoom, PublicSeat } from '../../shared/protocol.ts';
import type { Key, Vars } from '../src/i18n.ts';
import { ARRANGE_DELAY_MS, ARRANGE_GAP_MS, ArrangeQueue, changes, messageFor, movedLine, movedTo, seatOptions, seatValue, teamTitle, teamsOf, type Clock } from '../src/play/arrange.ts';

/** t over the real dictionaries of one language (shared file plus the play area). */
function realT(lang: 'pt-BR' | 'en'): (key: Key, vars?: Vars) => string {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../../locales/${f}`, import.meta.url), 'utf8')) as Record<string, string>;
  const dict = { ...read(`${lang}.json`), ...read(`play.${lang}.json`) };
  return (key, vars) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
}
const pt = realT('pt-BR');
const en = realT('en');

const person = (seat: number, name = '', connected = true): PublicSeat => ({ seat, kind: 'human', name, persona: null, verified: false, connected, aiPlaying: false });
const open = (seat: number, persona: PersonaId): PublicSeat => ({ seat, kind: 'empty', name: '', persona, verified: false, connected: false, aiPlaying: false });
const ai = (seat: number, persona: PersonaId, name: string): PublicSeat => ({ seat, kind: 'ai', name, persona, verified: false, connected: true, aiPlaying: false });

function table(seats: PublicSeat[]): Pick<PublicRoom, 'seats' | 'settings'> {
  return { seats, settings: { mode: 'room', players: seats.length as 2 | 4, variant: 'paulista', options: {}, opponents: ['iara', 'zap'], partner: 'lia', turnSeconds: 60 } };
}

/** The default room after Beto joined: Ana (owner, seat 0), Beto (seat 1, Iara hidden), Lia and Zap planned on 2 and 3. */
const fresh = table([person(0, 'Ana'), person(1, 'Beto'), open(2, 'lia'), open(3, 'zap')]);

const labels = (opts: { label: string; disabled: boolean }[]) => opts.map((o) => `${o.label}${o.disabled ? ' [x]' : ''}`);

describe('seatValue', () => {
  it('names a person by seat, a free seat as open, an AI by character', () => {
    expect(seatValue(person(2))).toBe('seat:2');
    expect(seatValue(open(1, 'iara'))).toBe('open');
    expect(seatValue(ai(3, 'zap', 'Zap'))).toBe('ai:zap');
  });
});

describe('seatOptions', () => {
  it('people first, in seat order; then free; then the six characters, with where a visible one already is', () => {
    expect(labels(seatOptions(fresh, 0, 2, pt))).toEqual([
      'Você, na cadeira 1',
      'Beto, na cadeira 2',
      'Livre para um amigo',
      'Otávio, IA',
      'Bento, IA',
      'Lia, IA',
      'Ravi, IA',
      'Iara, IA',
      'Zap, IA, na cadeira 4',
    ]);
    expect(seatOptions(fresh, 0, 2, pt).map((o) => o.value)).toEqual(['seat:0', 'seat:1', 'open', 'ai:otavio', 'ai:bento', 'ai:lia', 'ai:ravi', 'ai:iara', 'ai:zap']);
  });

  it('never names a person\'s hidden character: Iara under Beto is not "na cadeira 2"', () => {
    const opts = seatOptions(fresh, 0, 3, pt);
    expect(opts.find((o) => o.value === 'ai:iara')!.label).toBe('Iara, IA');
    expect(opts.find((o) => o.value === 'ai:lia')!.label).toBe('Lia, IA, na cadeira 3');
  });

  it('the owner\'s own row and a connected friend\'s row take only people (no one is pushed out)', () => {
    expect(labels(seatOptions(fresh, 0, 0, pt))).toEqual([
      'Você',
      'Beto, na cadeira 2',
      'Livre para um amigo [x]',
      'Otávio, IA [x]',
      'Bento, IA [x]',
      'Lia, IA, na cadeira 3 [x]',
      'Ravi, IA [x]',
      'Iara, IA [x]',
      'Zap, IA, na cadeira 4 [x]',
    ]);
    const beto = seatOptions(fresh, 0, 1, pt);
    expect(beto.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['seat:0', 'seat:1']);
  });

  it('someone away after a match can be replaced; a person without a nickname is "Jogador N"', () => {
    const t = table([person(0, 'Ana'), person(1, '', false), ai(2, 'lia', 'Lia'), open(3, 'zap')]);
    const opts = seatOptions(t, 0, 1, pt);
    expect(opts.every((o) => !o.disabled)).toBe(true);
    expect(opts[1].label).toBe('Jogador 2, fora da mesa');
    expect(seatOptions(t, 0, 3, pt)[1].label).toBe('Jogador 2, fora da mesa, na cadeira 2');
    expect(seatOptions(t, 0, 3, pt).find((o) => o.value === 'ai:lia')!.label).toBe('Lia, IA, na cadeira 3');
    expect(seatOptions(t, 0, 3, en)[1].label).toBe('Player 2, away from the table, in seat 2');
  });

  it('a 1 against 1 room offers its two seats only', () => {
    const t = table([person(0, 'Ana'), open(1, 'zap')]);
    expect(seatOptions(t, 0, 1, en).map((o) => o.label)).toEqual(['You, in seat 1', 'Free for a friend', 'Otávio, AI', 'Bento, AI', 'Lia, AI', 'Ravi, AI', 'Iara, AI', 'Zap, AI']);
  });
});

describe('messageFor', () => {
  it('a person moves (the two seats swap), free plans null, a character plans it', () => {
    expect(messageFor(fresh, 2, 'seat:1')).toEqual({ t: 'move', from: 1, to: 2 });
    expect(messageFor(fresh, 1, 'seat:0')).toEqual({ t: 'move', from: 0, to: 1 });
    expect(messageFor(fresh, 2, 'ai:otavio')).toEqual({ t: 'plan', seat: 2, ai: 'otavio' });
    const t = table([person(0, 'Ana'), person(1, 'Beto'), ai(2, 'lia', 'Lia'), open(3, 'zap')]);
    expect(messageFor(t, 2, 'open')).toEqual({ t: 'plan', seat: 2, ai: null });
    expect(messageFor(t, 3, 'ai:zap')).toEqual({ t: 'plan', seat: 3, ai: 'zap' });
  });

  it('the current value, an unknown value or a person who is no longer there send nothing', () => {
    expect(messageFor(fresh, 2, 'open')).toBeNull();
    expect(messageFor(fresh, 1, 'seat:1')).toBeNull();
    expect(messageFor(table([person(0), person(1), ai(2, 'lia', 'Lia'), open(3, 'zap')]), 2, 'ai:lia')).toBeNull();
    expect(messageFor(fresh, 2, 'ai:nobody')).toBeNull();
    expect(messageFor(fresh, 2, 'seat:3')).toBeNull();
    expect(messageFor(fresh, 2, 'bogus')).toBeNull();
    expect(messageFor(fresh, 7, 'open')).toBeNull();
  });
});

describe('changes', () => {
  it('announces a move: the seat left free with its character, the seat taken', () => {
    const after = table([person(0, 'Ana'), open(1, 'iara'), person(2, 'Beto'), open(3, 'zap')]);
    expect(changes(fresh, after, 0, pt)).toEqual(['Cadeira 2 livre para um amigo; se ficar vazia, joga a Iara.', 'Cadeira 3: Beto.']);
  });

  it('announces a reservation, an opening and a changed plan on a free seat', () => {
    const reserved = table([person(0, 'Ana'), person(1, 'Beto'), ai(2, 'lia', 'Lia'), open(3, 'zap')]);
    expect(changes(fresh, reserved, 0, pt)).toEqual(['Cadeira 3: Lia, IA.']);
    expect(changes(reserved, fresh, 0, pt)).toEqual(['Cadeira 3 livre para um amigo; se ficar vazia, joga a Lia.']);
    // Lia reserved on seat 4 swaps plans with seat 3: both seats are told.
    const swapped = table([person(0, 'Ana'), person(1, 'Beto'), open(2, 'zap'), ai(3, 'lia', 'Lia')]);
    expect(changes(fresh, swapped, 0, en)).toEqual(['Seat 3 free for a friend; if it stays empty, Zap plays.', 'Seat 4: Lia, AI.']);
  });

  it('says nothing for a swap with a person\'s hidden character, for the same message, or with no earlier message', () => {
    // Iara planned on seat 3 swaps with Beto's hidden fallback: nothing visible changes on Beto's seat.
    const t1 = table([person(0, 'Ana'), person(1, 'Beto'), open(2, 'lia'), open(3, 'iara')]);
    expect(changes(fresh, t1, 0, pt)).toEqual(['Cadeira 4 livre para um amigo; se ficar vazia, joga a Iara.']);
    expect(changes(fresh, fresh, 0, pt)).toEqual([]);
    expect(changes(null, fresh, 0, pt)).toEqual([]);
  });

  it('announces a friend who joins, and one who comes back away', () => {
    const before = table([person(0, 'Ana'), open(1, 'iara'), open(2, 'lia'), open(3, 'zap')]);
    expect(changes(before, fresh, 0, pt)).toEqual(['Cadeira 2: Beto.']);
    const caio = table([person(0, 'Ana'), person(1, 'Beto'), open(2, 'lia'), person(3, '')]);
    expect(changes(fresh, caio, 0, pt)).toEqual(['Cadeira 4: Jogador 4.']);
  });
});

describe('movedTo (the friend\'s "moved" line)', () => {
  it('a seat change the page did not ask for is the owner\'s move', () => {
    expect(movedTo(1, 2, () => false)).toBe(2);
  });
  it('the page\'s own "Sentar aqui", the first seat and no change say nothing', () => {
    const asked = new Set([2]);
    const ask = (n: number) => {
      const mine = asked.has(n);
      asked.clear();
      return mine;
    };
    expect(movedTo(1, 2, ask)).toBeNull();
    // The request is used up: the owner moving the friend back to 2 later is told.
    expect(movedTo(3, 2, ask)).toBe(2);
    expect(movedTo(null, 1, () => false)).toBeNull();
    expect(movedTo(1, 1, () => false)).toBeNull();
    expect(movedTo(1, null, () => false)).toBeNull();
  });
  it('says the other team when the move changed it (2 against 2 only)', () => {
    // Seat 2 to seat 3 crosses to the other group; seat 2 to seat 4 keeps the team.
    expect(movedLine(1, 2, 4, pt)).toBe('Quem criou a sala mudou você para a cadeira 3, na outra dupla.');
    expect(movedLine(1, 2, 4, en)).toBe('The room owner moved you to seat 3, on the other team.');
    expect(movedLine(1, 3, 4, pt)).toBe('Quem criou a sala mudou você para a cadeira 4.');
    expect(movedLine(2, 0, 4, en)).toBe('The room owner moved you to seat 1.');
    expect(movedLine(3, 0, 4, pt)).toBe('Quem criou a sala mudou você para a cadeira 1, na outra dupla.');
    // In 1 against 1 each seat is its own side: there is no team to change.
    expect(movedLine(1, 0, 2, pt)).toBe('Quem criou a sala mudou você para a cadeira 1.');
  });
});

describe('teamsOf and teamTitle (the lobby groups the seats by team, M17)', () => {
  const shown = (players: 2 | 4, you: number | null, tr = pt) =>
    teamsOf(players, you).map((g) => {
      const h = teamTitle(g, tr);
      return `${h.name} (${h.seats}) [${g.seats.join(',')}] ${g.side ?? 'none'}`;
    });

  it('2 against 2: seats 1 and 3 play against 2 and 4, the viewer\'s team first as "Nós"', () => {
    expect(shown(4, 0)).toEqual(['Nós (cadeiras 1 e 3) [0,2] us', 'Eles (cadeiras 2 e 4) [1,3] them']);
    expect(shown(4, 2)).toEqual(shown(4, 0));
    expect(shown(4, 1)).toEqual(['Nós (cadeiras 2 e 4) [1,3] us', 'Eles (cadeiras 1 e 3) [0,2] them']);
    expect(shown(4, 3)).toEqual(shown(4, 1));
    expect(shown(4, 3, en)).toEqual(['Us (seats 2 and 4) [1,3] us', 'Them (seats 1 and 3) [0,2] them']);
  });

  it('a person moved to a seat of the other group changes team: the friend on seat 2 joins the owner\'s group on seat 3', () => {
    const groupOf = (you: number, seat: number) => teamsOf(4, you).find((g) => g.seats.includes(seat))!.side;
    expect(groupOf(0, 1)).toBe('them');
    expect(groupOf(0, 2)).toBe('us');
    // Seen from the friend: the owner (seat index 0) is "Eles" from seat index 1, "Nós" from seat index 2.
    expect(groupOf(1, 0)).toBe('them');
    expect(groupOf(2, 0)).toBe('us');
  });

  it('1 against 1: each seat is its own side, "Seu lado" against "Lado adversário"', () => {
    expect(shown(2, 0)).toEqual(['Seu lado (cadeira 1) [0] us', 'Lado adversário (cadeira 2) [1] them']);
    expect(shown(2, 1)).toEqual(['Seu lado (cadeira 2) [1] us', 'Lado adversário (cadeira 1) [0] them']);
    expect(shown(2, 1, en)).toEqual(['Your side (seat 2) [1] us', 'Their side (seat 1) [0] them']);
  });

  it('a viewer without a seat reads neutral names in the table\'s order', () => {
    expect(shown(4, null)).toEqual(['Time 1 (cadeiras 1 e 3) [0,2] none', 'Time 2 (cadeiras 2 e 4) [1,3] none']);
    expect(shown(4, null, en)).toEqual(['Team 1 (seats 1 and 3) [0,2] none', 'Team 2 (seats 2 and 4) [1,3] none']);
    // One person is not a team: "Lado 1" and "Lado 2".
    expect(shown(2, null)).toEqual(['Lado 1 (cadeira 1) [0] none', 'Lado 2 (cadeira 2) [1] none']);
    expect(shown(2, null, en)).toEqual(['Side 1 (seat 1) [0] none', 'Side 2 (seat 2) [1] none']);
  });

  it('the owner\'s sentence names the same seats as the groups: 1 and 3 against 2 and 4', () => {
    const [a, b] = teamsOf(4, 0).map((g) => g.seats.map((i) => i + 1));
    expect(pt('play.arrange.teams.dupla')).toContain(`cadeiras ${a[0]} e ${a[1]} contra ${b[0]} e ${b[1]}.`);
    expect(en('play.arrange.teams.dupla')).toContain(`seats ${a[0]} and ${a[1]} against ${b[0]} and ${b[1]}.`);
  });

  it('every seat of the table is in exactly one group', () => {
    for (const players of [2, 4] as const) {
      for (const you of [null, ...Array.from({ length: players }, (_, i) => i)]) {
        expect(teamsOf(players, you).flatMap((g) => g.seats).sort()).toEqual(Array.from({ length: players }, (_, i) => i));
      }
    }
  });
});

/** A clock the test moves by hand: timers fire in time order as it advances. */
function fakeClock() {
  let now = 1_000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    set: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clear: (x) => {
      timers.delete(x as number);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { clock, advance, now: () => now, pending: () => timers.size };
}

describe('ArrangeQueue', () => {
  const setup = () => {
    const c = fakeClock();
    const sent: { seat: number; value: string; at: number }[] = [];
    const q = new ArrangeQueue((seat, value) => sent.push({ seat, value, at: c.now() }), c.clock);
    return { c, q, sent };
  };

  it('sends a seat\'s choice 400 ms after its last change, the latest one winning', () => {
    const { c, q, sent } = setup();
    q.set(1, 'ai:otavio', 'open');
    c.advance(300);
    q.set(1, 'ai:bento', 'open');
    expect(q.pending(1)).toBe('ai:bento');
    c.advance(300);
    q.set(1, 'ai:lia', 'open');
    c.advance(ARRANGE_DELAY_MS - 1);
    expect(sent).toEqual([]);
    c.advance(1);
    expect(sent.map((x) => [x.seat, x.value])).toEqual([[1, 'ai:lia']]);
    expect(q.pending(1)).toBeUndefined();
  });

  it('drops a choice equal to what the room shows', () => {
    const { c, q, sent } = setup();
    q.set(2, 'ai:zap', 'open');
    q.set(2, 'open', 'open');
    expect(q.pending(2)).toBeUndefined();
    c.advance(2_000);
    expect(sent).toEqual([]);
    expect(c.pending()).toBe(0);
  });

  it('never sends two messages closer than 500 ms (two a second at most)', () => {
    const { c, q, sent } = setup();
    for (const seat of [0, 1, 2, 3]) q.set(seat, 'open', 'seat:9');
    c.advance(5_000);
    expect(sent.map((x) => x.seat)).toEqual([0, 1, 2, 3]);
    expect(sent[0].at).toBe(1_000 + ARRANGE_DELAY_MS);
    for (let i = 1; i < sent.length; i++) expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(ARRANGE_GAP_MS);
    // A burst of changes over fifteen seconds: still never two sends closer than the gap.
    const many = setup();
    for (let k = 0; k < 100; k++) {
      many.q.set(k % 4, `ai:${k}`, 'open');
      many.c.advance(150);
    }
    many.c.advance(5_000);
    for (let i = 1; i < many.sent.length; i++) expect(many.sent[i].at - many.sent[i - 1].at).toBeGreaterThanOrEqual(ARRANGE_GAP_MS);
    expect(many.sent.length).toBeGreaterThan(4);
  });

  it('flush sends everything waiting at once, in seat order, and nothing later', () => {
    const { c, q, sent } = setup();
    q.set(3, 'ai:otavio', 'open');
    q.set(1, 'open', 'ai:iara');
    q.set(2, 'seat:1', 'open');
    c.advance(100);
    q.flush();
    expect(sent.map((x) => [x.seat, x.value, x.at])).toEqual([
      [1, 'open', 1_100],
      [2, 'seat:1', 1_100],
      [3, 'ai:otavio', 1_100],
    ]);
    c.advance(5_000);
    expect(sent).toHaveLength(3);
    // The next change still waits its turn after the flush.
    q.set(0, 'seat:2', 'seat:0');
    c.advance(ARRANGE_DELAY_MS);
    expect(sent).toHaveLength(4);
    expect(sent[3].at - 1_100).toBeGreaterThanOrEqual(ARRANGE_GAP_MS);
  });

  it('sends nothing after dispose', () => {
    const { c, q, sent } = setup();
    q.set(1, 'ai:lia', 'open');
    q.dispose();
    c.advance(5_000);
    q.set(2, 'ai:zap', 'open');
    q.flush();
    c.advance(5_000);
    expect(sent).toEqual([]);
    expect(c.pending()).toBe(0);
  });
});
