// The owner away after a match (M15 owner decision D6, spec 6.5): while the owner of a room with
// friends is connected, only the owner starts the next match; once the owner's page is gone, a
// friend's end screen and post match lobby switch at once to "anyone at the table can start", and
// back again when the owner returns, so a room never gets stuck. The focused heading reads the line
// with it, and a friend on the start button keeps a place to stand when the button goes.

import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, QUICK, createRoom, expectSeat, expectTable, expectTeams, joinByCode, newPlayers, playLoop } from './support/zap.ts';

const WAIT = 'Esperando quem criou a sala começar.';
const BACK = 'A partida acabou. Quem criou a sala está mudando a mesa.';
const AWAY = 'Quem criou a sala está fora. Qualquer pessoa na mesa pode começar.';

test('a friend may start while the owner is away after a match, and waits again when the owner is back', async ({ browser }) => {
  test.setTimeout(480_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  let code = '';
  /** Ana opens the room again on the same browser: same device, same seat. */
  const anaBack = async () => {
    const page = await ana.openPage();
    await page.goto(`/?sala=${code}`);
    await expect.poll(() => ana.lastRoom()?.room.ownerAway, { message: 'Ana is back' }).toBe(false);
    return page;
  };
  try {
    await test.step('Ana creates a 1 against 1 room, Beto joins, and they play a match to the end', async () => {
      code = await createRoom(ana, { players: 2, turn: '60' });
      await joinByCode(beto, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      // 1 against 1 (M17): each seat is its own side, "Seu lado" first and then "Lado adversário", on both pages.
      await expectTeams(ana.page, [0], [1]);
      await expectTeams(beto.page, [1], [0]);
      // The headings say the sides, so the owner's note is only the first sentence (no team sentence).
      await expect(ana.page.getByText('Você arruma a mesa: escolha quem senta em cada cadeira.', { exact: true })).toBeVisible();
      await ana.shot('m15-room-teams-1v1-owner-desktop');
      await beto.shot('m15-room-teams-1v1-friend-phone');
      await ana.page.getByTestId('start-button').click();
      for (const p of [ana, beto]) await expectTable(p);
      const results = await Promise.all([ana, beto].map((p) => playLoop(p, { policy: QUICK, timeoutMs: 240_000 })));
      for (const r of results) expect(r.ended).toBe(true);
      await expect(beto.page.getByTestId('wait-owner')).toHaveText(WAIT);
      await expect(beto.page.getByTestId('rematch-button')).toHaveCount(0);
      await expect(beto.page.getByTestId('match-result')).toHaveAttribute('aria-describedby', 'result-wait');
    });

    await test.step('Ana\'s page closes: Beto\'s end screen says anyone may start, with "Jogar de novo"', async () => {
      await ana.page.close();
      await expect(beto.page.getByTestId('wait-owner')).toHaveText(AWAY);
      await expect(beto.page.getByTestId('rematch-button')).toBeVisible();
      expect(beto.lastRoom()!.room.ownerAway).toBe(true);
      await beto.shot('m15-room-owner-away-end-phone');
    });

    await test.step('Ana comes back: Beto waits again, and his focus goes from "Jogar de novo" to the heading', async () => {
      await beto.page.getByTestId('rematch-button').focus();
      const page = await anaBack();
      await expect(page.getByTestId('rematch-button')).toBeVisible();
      await expect(beto.page.getByTestId('wait-owner')).toHaveText(WAIT);
      await expect(beto.page.getByTestId('rematch-button')).toHaveCount(0);
      await expect(beto.page.getByTestId('match-result')).toBeFocused();
    });

    await test.step('Ana\'s page closes again and Beto plays again: her seat is played by the AI', async () => {
      await ana.page.close();
      await beto.page.getByTestId('rematch-button').click();
      await expect.poll(() => beto.lastGame()?.matchNo, { timeout: 20_000 }).toBe(2);
      await expectTable(beto);
      await expectSeat(beto.page, 0, { kind: 'human', connected: false, aiPlaying: true });
      expect(beto.sent.map((x) => JSON.parse(x.data) as { t: string }).filter((m) => m.t === 'rematch')).toHaveLength(1);
      expect((await playLoop(beto, { policy: QUICK, timeoutMs: 240_000 })).ended).toBe(true);
    });

    await test.step('Ana back and "Mudar a mesa", then away: in the lobby Beto reads the same line and may start', async () => {
      const page = await anaBack();
      await page.getByTestId('change-table').click();
      await expect(beto.page.getByTestId('room-code')).toHaveText(code, { timeout: 15_000 });
      await expect(beto.page.getByTestId('wait-owner')).toHaveText(BACK);
      await expect(beto.page.locator('main.lobby h1')).toHaveAttribute('aria-describedby', 'lobby-wait');
      await expect(beto.page.getByTestId('start-button')).toHaveCount(0);
      // The post match lobby groups the seats the same way.
      await expectTeams(beto.page, [1], [0]);
      await page.close();
      await expect(beto.page.getByTestId('wait-owner')).toHaveText(AWAY);
      await expect(beto.page.getByTestId('start-button')).toBeVisible();
      await beto.shot('m15-room-owner-away-lobby-phone');
    });

    await test.step('Ana comes back to the lobby: Beto\'s start button goes, and his focus lands on the title', async () => {
      await beto.page.getByTestId('start-button').focus();
      await anaBack();
      await expect(beto.page.getByTestId('wait-owner')).toHaveText(BACK);
      await expect(beto.page.getByTestId('start-button')).toHaveCount(0);
      await expect(beto.page.locator('main.lobby h1')).toBeFocused();
    });
  } finally {
    await ana.close();
    await beto.close();
  }
});
