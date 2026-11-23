// Four devices in one 2 against 2 room: create, join by code, sit, play to the end by clicking,
// check that each page only ever had its own hand and that the four scores agree, then "Jogar de
// novo" starts a new match in the same room for everyone.

import { expect, test } from '@playwright/test';
import {
  DESKTOP,
  PHONE,
  QUICK,
  STEADY,
  auditRoom,
  createRoom,
  expectSeat,
  expectTable,
  joinByCode,
  newPlayers,
  playLoop,
  shownScore,
  since,
  type Player,
} from './support/zap.ts';

const FORBIDDEN = ['Você, humano verificado', 'O anel marca o tempo'];

test('four devices play a 2 against 2 room to the end and start a new match', async ({ browser }) => {
  test.setTimeout(480_000);
  const players = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
    ['Caio', DESKTOP],
    ['Duda', PHONE],
  ]);
  const [ana, beto, caio, duda] = players;
  let code = '';
  try {
    // 30 s per move: 1.5 s on the e2e site (ROOM_TIME_SCALE 0.05). With 15 s (0.75 s there) four
    // pages of the new table on a busy host missed three turns in a row and the AI took every seat.
    await test.step('Ana creates a 2 against 2 room with 30 s per move', async () => {
      code = await createRoom(ana, { players: 4, variant: 'paulista', turn: '30' });
      await expectSeat(ana.page, 0, { kind: 'human', connected: true });
      for (const seat of [1, 2, 3]) await expectSeat(ana.page, seat, { kind: 'empty' });
    });

    await test.step('the others join by code and sit', async () => {
      await joinByCode(beto, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      // Beto moves to the seat in front of Ana: they play as partners.
      await beto.page.getByTestId('sit-2').click();
      await expectSeat(beto.page, 2, { kind: 'human' });
      await expectSeat(beto.page, 1, { kind: 'empty' });
      await expectSeat(ana.page, 2, { kind: 'human', connected: true });
      await joinByCode(caio, code);
      await joinByCode(duda, code);
      for (const p of players) {
        await expect(p.page.getByTestId('room-code')).toHaveText(code);
        await expect(p.page.getByTestId('invite-link')).toContainText(`/s/${code}`);
        for (const seat of [0, 1, 2, 3]) await expectSeat(p.page, seat, { kind: 'human', connected: true });
        await expect(p.page.getByTestId('start-button')).toHaveCount(p === ana ? 1 : 0);
        const text = await p.page.locator('body').innerText();
        for (const f of FORBIDDEN) expect(text, `${p.name} lobby text`).not.toContain(f);
      }
      expect(players.map((p) => p.seat)).toEqual([0, 2, 1, 3]);
      await ana.shot('room4-lobby-desktop');
      await duda.shot('room4-lobby-phone');
    });

    await test.step('the owner starts and the four play by clicking until the match ends', async () => {
      await ana.page.getByTestId('start-button').click();
      for (const p of players) await expectTable(p);
      for (const p of players) for (const seat of [0, 1, 2, 3]) await expectSeat(p.page, seat, { kind: 'human' });
      const t0 = Date.now();
      const results = await Promise.all(players.map((p) => playLoop(p, { policy: STEADY, timeoutMs: 360_000 })));
      console.log(`room ${code}: match 1 ended in ${since(t0)}, moves ${results.map((r) => r.moves).join('/')}`);
      for (const r of results) expect(r.ended).toBe(true);
      await ana.shot('room4-ended-desktop');
      await beto.shot('room4-ended-phone');
    });

    await test.step('the four pages agree on the result and each only ever had its own hand', async () => {
      for (const p of players) await expect(p.page.getByTestId('match-result')).toBeVisible();
      // The server's last word on every page.
      const finals = players.map((p) => p.lastRoom()!.room);
      for (const r of finals) {
        expect(r.status).toBe('ended');
        expect(r.matchNo).toBe(1);
        expect(r.score).toEqual(finals[0].score);
        expect(r.lastWinner).toBe(finals[0].lastWinner);
      }
      const [s0, s1] = finals[0].score;
      const winner = finals[0].lastWinner;
      expect(Math.max(s0, s1)).toBeGreaterThanOrEqual(12);
      expect(winner).toBe(s0 > s1 ? 0 : 1);
      // What each screen shows.
      for (const p of players) {
        expect(await shownScore(p), `${p.name} score on screen`).toEqual([s0, s1]);
        await expect(p.page.getByTestId('match-result')).toHaveText((p.seat & 1) === winner ? 'Nós vencemos!' : 'Eles venceram.');
      }
      // Every page received hands; together they never shared a card.
      for (const p of players) expect(p.samples.length, `${p.name} hands seen on screen`).toBeGreaterThan(0);
      const audit = auditRoom(players);
      expect(audit.problems).toEqual([]);
      expect(audit.sharedHands, 'hands that all four devices received').toBeGreaterThan(0);
      console.log(`room ${code}: ${audit.hands} hands checked, ${audit.sharedHands} on all four devices`);
    });

    await test.step('"Play again" (result.rematch) starts a new match in the same room for everyone', async () => {
      const seats = players.map((p) => p.seat);
      await expect(ana.page.getByTestId('rematch-button')).toHaveText('Jogar de novo');
      await ana.page.getByTestId('rematch-button').click();
      for (const p of players) {
        await expect(p.page.getByTestId('match-result')).toBeHidden();
        await expectTable(p);
        await expect(p.page).toHaveURL(new RegExp(`[?&]sala=${code}$`));
        await expect.poll(() => p.lastGame()?.matchNo, { message: `${p.name} gets match 2` }).toBe(2);
        const first = p.gameMsgs().find((g) => g.matchNo === 2)!;
        expect(first.obs.handIndex).toBe(0);
        expect(first.obs.score).toEqual([0, 0]);
        expect(p.lastRoom()!.room.status).toBe('playing');
        expect(p.lastRoom()!.room.code).toBe(code);
      }
      expect(players.map((p) => p.seat)).toEqual(seats);
      // A few moves of the new match, to see it really runs.
      const total = () => players.reduce((n, x) => n + x.moves, 0);
      const before = total();
      await Promise.all(players.map((p) => playLoop(p, { policy: QUICK, stop: () => total() >= before + 6, timeoutMs: 60_000 })));
      expect(total()).toBeGreaterThanOrEqual(before + 6);
      expect(auditRoom(players).problems).toEqual([]);
      await caio.shot('room4-rematch-desktop');
    });
  } finally {
    await Promise.all(players.map((p: Player) => p.close()));
  }
});
