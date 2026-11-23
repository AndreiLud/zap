// Drop and return: a phone closes in the middle of a match. During the grace (20 s, 1 s here) the
// seat waits for its person; after it an AI plays for them; when the same phone opens the room
// again the seat is theirs again.

import { expect, test } from '@playwright/test';
import {
  CALM,
  DESKTOP,
  GRACE_MS,
  PHONE,
  actsIn,
  auditRoom,
  background,
  createRoom,
  expectSeat,
  expectTable,
  joinByInvite,
  newPlayers,
  playLoop,
  waitForMove,
  waitForSeatState,
} from './support/zap.ts';

test('a dropped seat waits during the grace, then an AI plays for the person, and the seat comes back', async ({ browser }) => {
  test.setTimeout(240_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  let code = '';
  try {
    await test.step('Ana creates a 2 against 2 room, Beto joins through the invite link, Ana starts', async () => {
      code = await createRoom(ana, { players: 4, turn: '60' });
      const invite = (await ana.page.getByTestId('invite-link').innerText()).trim();
      expect(invite).toMatch(new RegExp(`/s/${code}$`));
      await joinByInvite(beto, invite, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      await ana.page.getByTestId('start-button').click();
      await expectTable(ana);
      await expectTable(beto);
      // Empty seats are filled with AIs.
      for (const seat of [2, 3]) await expectSeat(ana.page, seat, { kind: 'ai' });
    });

    const seat = beto.seat;
    expect(seat).toBe(1);
    const anaLoop = background(ana, { policy: CALM });
    try {
      let closedAt = 0;
      const times: string[] = [];
      await test.step('Beto plays, then his phone closes the page on his own turn', async () => {
        await playLoop(beto, { policy: CALM, stop: () => beto.moves >= 2, timeoutMs: 90_000 });
        const st = await waitForMove(beto.page, 60_000);
        expect(st, 'Beto gets his turn').not.toBeNull();
        expect(st!.ended).toBe(false);
        closedAt = Date.now();
        await beto.page.close();
      });

      await test.step('within the grace the seat waits for him', async () => {
        await waitForSeatState(ana.page, seat, { connected: false, aiPlaying: false, turnSeat: seat }, GRACE_MS);
        expect(Date.now() - closedAt, 'seen inside the grace').toBeLessThan(GRACE_MS);
        times.push(`grace seen ${Date.now() - closedAt}`);
        await ana.shot('drop-grace-desktop');
      });

      await test.step('after the grace an AI plays for him', async () => {
        await expectSeat(ana.page, seat, { kind: 'human', connected: false, aiPlaying: true }, 10_000);
        times.push(`AI seen ${Date.now() - closedAt}`);
        const recs = ana.recs.filter((r) => r.at >= closedAt);
        const roomAt = (pred: (s: { connected: boolean; aiPlaying: boolean }) => boolean) =>
          recs.find((r) => r.msg.t === 'room' && pred(r.msg.room.seats[seat]));
        const away = roomAt((s) => !s.connected);
        const takeover = roomAt((s) => s.aiPlaying);
        expect(away, 'the server says he is away').toBeDefined();
        expect(takeover, 'the server says an AI plays for him').toBeDefined();
        expect(away!.at, 'away first, without an AI').toBeLessThan(takeover!.at);
        expect(away!.at - closedAt).toBeLessThan(GRACE_MS);
        expect(takeover!.at - closedAt, 'the AI waits for the whole grace').toBeGreaterThanOrEqual(GRACE_MS - 50);
        // Nothing was played for his seat while he could still come back.
        for (const r of recs) if (r.at < takeover!.at && r.msg.t === 'game') expect(actsIn(r.msg, seat)).toBe(false);
        // Then the AI makes his moves.
        await expect
          .poll(() => ana.recs.some((r) => r.at >= takeover!.at && r.msg.t === 'game' && actsIn(r.msg, seat)), { timeout: 20_000, message: 'a move for his seat' })
          .toBe(true);
        times.push(`AI move ${Date.now() - closedAt}`);
        await expect(ana.page.getByTestId(`seat-${seat}`)).toContainText('a IA joga por enquanto');
        await ana.shot('drop-ai-playing-desktop');
      });

      await test.step('opening the room again on the same phone gives the seat back', async () => {
        const reopenedAt = Date.now();
        const page = await beto.openPage();
        await page.goto(`/?sala=${code}`);
        await expectTable(beto);
        // Same device, credential still valid: no new human check, same seat.
        await expect(page.getByTestId('turnstile')).toHaveCount(0);
        expect(beto.seat).toBe(seat);
        await expectSeat(page, seat, { kind: 'human', connected: true, aiPlaying: false });
        await expectSeat(ana.page, seat, { kind: 'human', connected: true, aiPlaying: false });
        const backAt = Date.now();
        await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online');
        // The game waits for him again and he plays his next move himself.
        const before = beto.moves;
        await playLoop(beto, { policy: CALM, stop: () => beto.moves > before, timeoutMs: 90_000 });
        expect(beto.moves).toBeGreaterThan(before);
        expect(beto.gameMsgs().some((g) => g.deadline?.seat === seat)).toBe(true);
        times.push(`reopened ${reopenedAt - closedAt}`, `seat back ${backAt - closedAt}`);
        console.log(`room ${code}: ms after the drop: ${times.join(', ')}`);
        await beto.shot('drop-back-phone');
      });
    } finally {
      await anaLoop.stop();
    }
    expect(auditRoom([ana, beto]).problems).toEqual([]);
  } finally {
    await ana.close();
    await beto.close();
  }
});
