// Abandonment: a person leaves for longer than the abandonment time (120 s, 6 s here). The match
// goes on with the AI in that seat and ends normally; a new match keeps the AI in that seat.
//
// A 1 against 1 room between two people with no time limit: while Ana waits, the game waits for
// her, so the match is surely still running when Beto passes the abandonment time.

import { expect, test } from '@playwright/test';
import {
  ABANDON_MS,
  CALM,
  DESKTOP,
  GRACE_MS,
  PHONE,
  QUICK,
  actsIn,
  auditRoom,
  createRoom,
  expectSeat,
  expectTable,
  joinByCode,
  newPlayers,
  playLoop,
  shownScore,
  sleep,
} from './support/zap.ts';

test('after a person abandons, the AI keeps the seat and the match ends normally', async ({ browser }) => {
  test.setTimeout(300_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  try {
    let code = '';
    await test.step('Ana creates a 1 against 1 room without a time limit, Beto joins, Ana starts', async () => {
      code = await createRoom(ana, { players: 2, turn: 'none' });
      await joinByCode(beto, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      // No time limit is allowed only when every seat is a person.
      await expect(ana.page.getByTestId('start-button')).toBeEnabled();
      await ana.page.getByTestId('start-button').click();
      await expectTable(ana);
      await expectTable(beto);
      expect(ana.lastGame()!.deadline?.at ?? null).toBeNull();
    });

    let closedAt = 0;
    await test.step('both play a little, then Beto closes the page', async () => {
      const both = () => ana.moves + beto.moves >= 4;
      await Promise.all([playLoop(ana, { policy: CALM, stop: both, timeoutMs: 90_000 }), playLoop(beto, { policy: CALM, stop: both, timeoutMs: 90_000 })]);
      closedAt = Date.now();
      await beto.page.close();
      await expectSeat(ana.page, 1, { kind: 'human', connected: false }, GRACE_MS * 3);
    });

    await test.step('after the grace the AI plays for him; past the abandonment time the match is still running', async () => {
      await expectSeat(ana.page, 1, { aiPlaying: true }, GRACE_MS * 10);
      // Ana does nothing; the game waits for her.
      const wait = closedAt + ABANDON_MS + 1_500 - Date.now();
      if (wait > 0) await sleep(wait);
      await expect(ana.page.getByTestId('match-result')).toHaveCount(0);
      expect(ana.lastRoom()!.room.status).toBe('playing');
      await expect(ana.page.getByTestId('turn-indicator')).toHaveAttribute('data-mine', 'true');
      await expectSeat(ana.page, 1, { kind: 'human', connected: false, aiPlaying: true });
      await ana.shot('abandon-waiting-desktop');
    });

    await test.step('the match goes on with the AI in his seat and ends normally', async () => {
      const abandonedAt = Date.now();
      const r = await playLoop(ana, { policy: QUICK, timeoutMs: 240_000 });
      expect(r.ended).toBe(true);
      await expect(ana.page.getByTestId('match-result')).toBeVisible();
      // The AI kept playing his seat after the abandonment.
      expect(ana.recs.some((x) => x.at > abandonedAt && x.msg.t === 'game' && actsIn(x.msg, 1))).toBe(true);
      const room = ana.lastRoom()!.room;
      expect(room.status).toBe('ended');
      const [s0, s1] = room.score;
      expect(Math.max(s0, s1)).toBeGreaterThanOrEqual(12);
      expect(room.lastWinner).toBe(s0 > s1 ? 0 : 1);
      expect(await shownScore(ana)).toEqual([s0, s1]);
      // A person without a nickname has no name on the server; the page shows "Jogador N" in its own language.
      await expect(ana.page.getByTestId('match-result')).toHaveText(room.lastWinner === 0 ? 'Você venceu!' : `${room.seats[1].name || 'Jogador 2'} venceu.`);
      await expectSeat(ana.page, 1, { kind: 'human', connected: false, aiPlaying: true });
      await ana.shot('abandon-ended-desktop');
    });

    await test.step('a new match keeps the AI in the seat he left', async () => {
      await ana.page.getByTestId('rematch-button').click();
      await expect(ana.page.getByTestId('match-result')).toBeHidden();
      await expect.poll(() => ana.lastGame()?.matchNo).toBe(2);
      await expectSeat(ana.page, 1, { kind: 'human', connected: false, aiPlaying: true });
      expect(ana.lastRoom()!.room.seats[1].aiPlaying).toBe(true);
    });

    expect(auditRoom([ana, beto]).problems).toEqual([]);
  } finally {
    await ana.close();
    await beto.close();
  }
});
