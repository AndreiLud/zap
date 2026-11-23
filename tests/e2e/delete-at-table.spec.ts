// Deleting one's data while seated at a table: Beto plays in a room with Ana and deletes his data
// from the You page (/voce) in another tab. His table tab says he is no longer in the room and stops
// trying to reconnect; Ana's table shows his seat without a name, played by the AI, and the match
// goes on.

import { expect, test } from '@playwright/test';
import { CALM, DESKTOP, PHONE, actsIn, createRoom, expectSeat, expectTable, joinByCode, newPlayers, passHumanCheck, playLoop } from './support/zap.ts';

test('deleting one\'s data at the table: that tab leaves the room, and the AI keeps the seat for the others', async ({ browser }) => {
  test.setTimeout(240_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  try {
    await test.step('Ana opens a 1 against 1 room with no time limit, Beto joins, Ana starts', async () => {
      const code = await createRoom(ana, { players: 2, turn: 'none' });
      await joinByCode(beto, code);
      await expectSeat(ana.page, 1, { kind: 'human', connected: true });
      await ana.page.getByTestId('start-button').click();
      await expectTable(ana);
      await expectTable(beto);
    });

    const table = beto.page;
    const seat = beto.seat;
    let deletedAt = 0;
    await test.step('Beto deletes his data in another tab', async () => {
      const you = await beto.openPage();
      await you.goto('/voce');
      await expect(you.getByTestId('you-match-row').or(you.getByTestId('you-matches-empty'))).toBeVisible();
      await you.getByTestId('you-delete').click();
      await you.getByTestId('you-delete-confirm').click();
      await passHumanCheck(you);
      await expect(you.getByTestId('you-status')).toHaveText('Pronto. Seus dados foram apagados.');
      deletedAt = Date.now();
    });

    await test.step('his table tab says he is no longer in the room', async () => {
      const problem = table.getByTestId('room-problem');
      await expect(problem).toHaveAttribute('data-problem', 'forgotten', { timeout: 15_000 });
      await expect(problem).toContainText('Você não está mais nesta sala');
      await expect(problem).toContainText('Os dados deste navegador foram apagados ou passaram para outro aparelho.');
      await beto.shot('delete-at-table-phone');
    });

    await test.step('Ana sees the seat without a name, played by the AI, and the match goes on', async () => {
      await expectSeat(ana.page, seat, { kind: 'human', connected: false, aiPlaying: true });
      await expect(ana.page.getByTestId(`seat-${seat}`)).toContainText(`Jogador ${seat + 1}`);
      await expect(ana.page.getByTestId(`seat-${seat}`)).toContainText('a IA joga por enquanto');
      expect(ana.lastRoom()!.room.seats[seat]).toMatchObject({ kind: 'human', name: '', aiPlaying: true });
      const before = ana.moves;
      await playLoop(ana, { policy: CALM, stop: () => ana.moves >= before + 2, timeoutMs: 60_000 });
      await expect
        .poll(() => ana.recs.some((r) => r.at >= deletedAt && r.msg.t === 'game' && actsIn(r.msg, seat)), { timeout: 20_000, message: 'a move for his seat' })
        .toBe(true);
      await ana.shot('delete-at-table-desktop');
      expect([...ana.errors, ...beto.errors]).toEqual([]);
    });
  } finally {
    await ana.close();
    await beto.close();
  }
});
