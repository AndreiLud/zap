// Reporting a nickname at the table: Ana picks a nickname on the You page (/voce), Beto sees it at the
// table, reports it (seat and reason) and the name turns into "Jogador N" at once for everyone.
// Then Beto mutes the phrases and signals of others: a phrase from Ana reaches his page but is
// not shown.

import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, createRoom, expectTable, joinByCode, newPlayers, sleep, tableTool } from './support/zap.ts';

test('a reported nickname is hidden at once, and muting hides the phrases of others', async ({ browser }) => {
  test.setTimeout(240_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  let code = '';
  try {
    await test.step('Ana opens a 1 against 1 room with no time limit and picks a nickname on the You page (/voce)', async () => {
      code = await createRoom(ana, { players: 2, turn: 'none' });
      await ana.page.getByTestId('link-you').click();
      await expect(ana.page).toHaveURL(/\/voce$/);
      await ana.page.getByTestId('nickname-input').fill('Tatu Bola');
      await ana.page.getByTestId('nickname-save').click();
      await expect(ana.page.getByTestId('nickname-status')).toHaveText('Apelido salvo.');
      await ana.page.goto(`/?sala=${code}`);
      await expect(ana.page.getByTestId('room-code')).toHaveText(code);
    });

    await test.step('Beto joins and sees the nickname; Ana starts', async () => {
      await joinByCode(beto, code);
      await expect(beto.page.getByTestId('seat-0')).toContainText('Tatu Bola');
      await ana.page.getByTestId('start-button').click();
      await expectTable(ana);
      await expectTable(beto);
      await expect(beto.page.getByTestId(`seat-${ana.seat}`)).toContainText('Tatu Bola');
    });

    await test.step('Beto reports the nickname: seat and reason, and the name is hidden for everyone', async () => {
      const p = beto.page;
      // Beto is on a phone: the table tools sit in the menu sheet's group "This table" (shell.sheet.table).
      await (await tableTool(p, 'report-button')).click();
      await expect(p.getByTestId('report-dialog')).toBeVisible();
      await p.getByTestId('report-submit').click();
      await expect(p.getByTestId('report-error')).toHaveText('Escolha a cadeira.');
      await p.getByTestId('report-seat').selectOption(String(ana.seat));
      await p.getByTestId('report-reason').selectOption('nickname');
      await beto.shot('report-dialog-phone');
      const req = p.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/report'));
      await p.getByTestId('report-submit').click();
      expect((await req).postDataJSON()).toEqual({ code, seat: ana.seat, reason: 'nickname' });
      await expect(p.getByTestId('report-dialog')).toBeHidden();
      await expect(p.getByTestId('notice')).toHaveText('Denúncia enviada. Uma pessoa vai revisar.');
      // The report closed the sheet too; focus is back on the menu button that opened it.
      await expect(p.getByTestId('menu-button')).toBeFocused();
      await expect(p.getByTestId(`seat-${ana.seat}`)).toContainText(`Jogador ${ana.seat + 1}`);
      await expect(p.getByTestId(`seat-${ana.seat}`)).not.toContainText('Tatu Bola');
      expect(beto.lastRoom()!.room.seats[ana.seat].name).toBe('');
      expect(ana.lastRoom()!.room.seats[ana.seat].name).toBe('');
      // Ana is told on her own page that the nickname waits for review.
      const mine = await ana.page.evaluate(async () => (await fetch('/api/me')).json());
      expect(mine).toEqual(expect.objectContaining({ nickname: 'Tatu Bola', nicknameHidden: true }));
    });

    await test.step('Beto mutes phrases and signals of others: Ana\'s phrase arrives but is not shown', async () => {
      const p = beto.page;
      await (await tableTool(p, 'mute-others')).check();
      expect(await p.evaluate(() => localStorage.getItem('zap-mute-phrases'))).toBe('1');
      const before = beto.recs.length;
      await ana.page.getByTestId('phrase-button').click();
      await ana.page.getByTestId('phrase-boa').click();
      await expect(ana.page.getByTestId(`seat-${ana.seat}`)).toContainText('Boa!');
      await expect.poll(() => beto.recs.slice(before).some((r) => r.msg.t === 'phrase' && r.msg.key === 'boa'), { timeout: 5_000 }).toBe(true);
      await sleep(500);
      await expect(p.locator('main')).not.toContainText('Boa!');
      await beto.shot('report-muted-phone');
    });

    await test.step('the You page (/voce) of Ana says the nickname is hidden until review', async () => {
      await ana.page.getByTestId('link-you').click();
      await expect(ana.page.getByTestId('you-nickname-hidden')).toBeVisible();
      expect([...ana.errors, ...beto.errors]).toEqual([]);
    });
  } finally {
    await ana.close();
    await beto.close();
  }
});
