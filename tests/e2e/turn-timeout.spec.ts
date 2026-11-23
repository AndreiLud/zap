// Time out: a person stops acting. Each time their turn time runs out (30 s, 1.5 s here) the AI
// plays that move for them and the game goes on. After three time outs in a row the AI keeps
// playing for them, without waiting, until they act again.

import { expect, test } from '@playwright/test';
import {
  CALM,
  DESKTOP,
  actsIn,
  auditRoom,
  background,
  createRoom,
  expectSeat,
  expectTable,
  joinByCode,
  newPlayers,
  playLoop,
  turnMs,
  type GameMsg,
} from './support/zap.ts';

const TURN_SECONDS = 30;

interface Timeout {
  /** Server time when the turn ran out, and when the AI's move for the person was sent. */
  deadline: number;
  movedAt: number;
  /** What the AI did for the person (play, raise, accept, run, onze or signal). */
  kinds: string[];
}

/** Each time the game waited for this seat and the move came from the AI after the deadline. */
function timeoutsIn(msgs: GameMsg[], seat: number): Timeout[] {
  const timeouts: Timeout[] = [];
  let waiting: { at: number } | null = null;
  for (const g of msgs) {
    if (waiting && actsIn(g, seat)) {
      const kinds = g.events.flatMap(({ e }) => ('seat' in e && e.seat === seat ? [e.t] : []));
      timeouts.push({ deadline: waiting.at, movedAt: g.now, kinds });
      waiting = null;
    }
    if (g.deadline?.seat === seat && g.deadline.at !== null) waiting = { at: g.deadline.at };
  }
  return timeouts;
}

test('the AI plays for a person whose time runs out, and after three in a row until they act again', async ({ browser }) => {
  test.setTimeout(240_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', DESKTOP],
  ]);
  try {
    let code = '';
    await test.step('Ana creates a 2 against 2 room with 30 s per move, Beto joins, Ana starts', async () => {
      code = await createRoom(ana, { players: 4, turn: String(TURN_SECONDS) as '30' });
      await joinByCode(beto, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      await ana.page.getByTestId('start-button').click();
      await expectTable(ana);
      await expectTable(beto);
    });

    const seat = beto.seat;
    // Ana plays on her own. While Beto tries to come back she waits a little on each of her turns,
    // so that he has a moment to act out of turn; never long enough to run out of time herself.
    let returning = false;
    let heldSeq = -1;
    let heldSince = 0;
    const hold = () => {
      if (!returning) return false;
      const seq = ana.lastGame()?.seq ?? -1;
      if (seq !== heldSeq) {
        heldSeq = seq;
        heldSince = Date.now();
      }
      return Date.now() - heldSince < turnMs(TURN_SECONDS) * 0.5;
    };
    const anaLoop = background(ana, { policy: CALM, hold });
    try {
      let takeoverSeq = 0;
      await test.step('Beto stops acting: each time his time runs out the AI plays his move and the game goes on', async () => {
        // His turn comes with his clock running.
        await expect(beto.page.locator('[data-testid="turn-indicator"][data-mine="true"] [data-testid="deadline"]')).toBeVisible({ timeout: 30_000 });
        await beto.shot('timeout-waiting');
        await expectSeat(ana.page, seat, { aiPlaying: true }, 60_000);
        // Beto's page, in the order the messages came: the room message that says the AI plays for
        // him, and right after it the game message of the same step (his third automatic move).
        const recs = beto.recs.filter((r) => r.page === 1);
        const ti = recs.findIndex((r) => r.msg.t === 'room' && r.msg.room.seats[seat].aiPlaying);
        const gi = recs.findIndex((r, i) => i > ti && r.msg.t === 'game');
        expect(ti, 'Beto learns the AI plays for him').toBeGreaterThan(0);
        expect(gi).toBeGreaterThan(ti);
        const upTo = recs.slice(0, gi + 1).flatMap((r) => (r.msg.t === 'game' ? [r.msg] : []));
        // Three moves made for him, each only after his time ran out. Before the third the game
        // waited for him again each time: he kept his seat.
        const timeouts = timeoutsIn(upTo, seat);
        expect(timeouts.length, 'time outs before the AI took the seat').toBe(3);
        for (const t of timeouts) expect(t.movedAt).toBeGreaterThanOrEqual(t.deadline);
        console.log(`room ${code}: moves the AI made for Beto when his time ran out: ${timeouts.map((t) => t.kinds.join('+')).join(', ')}`);
        takeoverSeq = upTo[upTo.length - 1].seq;
        await expectSeat(beto.page, seat, { aiPlaying: true });
        await ana.shot('timeout-ai-playing-desktop');
      });

      await test.step('after the third the AI keeps playing for him without waiting for his time', async () => {
        const after = () => beto.gameMsgs().filter((g: GameMsg) => g.seq > takeoverSeq);
        await expect.poll(() => after().filter((g) => actsIn(g, seat)).length, { timeout: 60_000, message: 'moves the AI made for him' }).toBeGreaterThanOrEqual(2);
        // The game goes on for everyone else too.
        expect(after().some((g) => [0, 1, 2, 3].some((other) => other !== seat && actsIn(g, other)))).toBe(true);
        for (const g of after()) expect(g.deadline?.seat, 'the game never waits for his seat').not.toBe(seat);
      });

      await test.step('when he acts again (a signal to his partner) the seat is his again', async () => {
        returning = true;
        const t0 = Date.now();
        const until = t0 + 120_000;
        while (beto.lastRoom()!.room.seats[seat].aiPlaying && Date.now() < until) {
          // Signals go out of turn, before his first card of the hand. They sit in a popover: open
          // it when the button is there, then send the first signal that is enabled.
          const opener = beto.page.getByTestId('signals-button');
          if ((await opener.isVisible().catch(() => false)) && (await opener.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
            await opener.click({ timeout: 1_500 }).catch(() => {});
          }
          await beto.page
            .locator('[data-testid^="signal-"]:enabled')
            .first()
            .click({ timeout: 3_000 })
            .catch(() => {});
          await expect.poll(() => beto.lastRoom()!.room.seats[seat].aiPlaying, { timeout: 1_000 }).toBe(false).catch(() => {});
        }
        returning = false;
        expect(beto.lastRoom()!.room.status, 'the match is still running').toBe('playing');
        expect(beto.lastRoom()!.room.seats[seat].aiPlaying, 'his signal gives him the seat back').toBe(false);
        console.log(`room ${code}: Beto back with a signal after ${Date.now() - t0} ms`);
        await expectSeat(ana.page, seat, { aiPlaying: false, connected: true });
        await expectSeat(beto.page, seat, { aiPlaying: false });
        // His next move waits for him again, with his own clock, and he plays it.
        const before = beto.moves;
        await playLoop(beto, { policy: CALM, stop: () => beto.moves > before, timeoutMs: 60_000 });
        expect(beto.moves).toBeGreaterThan(before);
        const back = beto.gameMsgs().filter((g) => g.seq > takeoverSeq);
        expect(back.some((g) => g.deadline?.seat === seat && g.deadline.at !== null)).toBe(true);
        await beto.shot('timeout-back');
      });
    } finally {
      returning = false;
      await anaLoop.stop();
    }
    expect(auditRoom([ana, beto]).problems).toEqual([]);
  } finally {
    await ana.close();
    await beto.close();
  }
});
