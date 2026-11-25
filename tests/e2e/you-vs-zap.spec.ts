// "You against Zap" (DATA-SPEC 5 and 8.1): after one scripted solo match, the end of the match
// links to the page; the page shows the history row, the "early" rating title, the reading's
// hidden rows, the abandons line and the links to the data; the records sit in IndexedDB
// (zap-you) until "Esquecer" empties it, and the deletion on the You page (/voce) removes the database.
// A browser with no matches sees the empty state, in both languages. A person who played a few
// matches (two of 1 against 1, one of 2 against 2) sees each of them, the score by mode and a rating
// for each table size.

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo } from './support/zap.ts';

/** Names of the IndexedDB databases of the page's origin. */
const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ''));

/** The number of records in zap-you (0 when the database is not there). */
const cachedRecords = (page: Page) =>
  page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'zap-you')) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open('zap-you');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) {
          db.close();
          resolve(0);
          return;
        }
        const count = db.transaction('records', 'readonly').objectStore('records').count();
        count.onsuccess = () => {
          resolve(count.result);
          db.close();
        };
      };
      req.onerror = () => resolve(0);
    });
  });

test('a solo match shows on "You against Zap", which keeps its copies on the device until they are forgotten or deleted', async ({ browser }) => {
  test.setTimeout(420_000);
  const rui = await Player.create(browser, 'Rui', PHONE);
  const page = rui.page;
  try {
    await test.step('a browser that never played sees the empty state', async () => {
      await page.goto('/voce-contra-o-zap');
      await expect(page.getByTestId('vs-empty')).toContainText('Você ainda não jogou. Sua primeira partida já aparece aqui.');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    });

    await test.step('a solo 1 against 1 match, played to the end, links to the page', async () => {
      await page.goto('/jogar');
      await startSolo(page, 2);
      await passHumanCheck(page);
      await expectTable(rui);
      const r = await playLoop(rui, { policy: QUICK, timeoutMs: 300_000 });
      expect(r.ended).toBe(true);
      await page.getByTestId('link-vs').click();
      await expect(page).toHaveURL(/\/voce-contra-o-zap$/);
    });

    await test.step('the page shows the match, the early rating, the hidden reading, no abandons and the data links', async () => {
      // The room writes the record when the match ends; a reload shows it once it is there.
      await expect(async () => {
        await page.reload();
        await expect(page.getByTestId('vs-history-row')).toHaveCount(1, { timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
      await expect(page.getByTestId('page-vs')).toHaveAttribute('data-complete', 'true');
      await expect(page.getByTestId('vs-history-row')).toContainText('Paulista, 1 contra 1');
      await expect(page.locator('#vs-placar-t')).toHaveText(/^Você venceu [01] de 1 partida contra o Zap\.$/);
      await expect(page.locator('#vs-faixa-t')).toHaveText(/^Com 1 partida, sua faixa ainda é larga: entre \S+ e \S+\.$/);
      const reading = page.getByTestId('vs-reading');
      await expect(reading).toHaveAttribute('data-state', 'ready');
      await expect(reading.locator('#vs-numeros-t')).toBeVisible();
      await expect(page.getByTestId('vs-reading-time')).toHaveAttribute('data-shown', 'false');
      await expect(page.getByTestId('vs-inmatch')).toHaveText(/^A leitura durante a partida está (desligada|ligada)\.|^Durante a partida|^Com "Não adaptar a mim" ligado/);
      await expect(page.getByTestId('vs-abandons-line')).toHaveText('Você nunca abandonou uma partida.');
      await expect(page.getByTestId('vs-download')).toHaveAttribute('href', '/voce#baixar');
      await expect(page.getByTestId('vs-delete')).toHaveAttribute('href', '/voce#apagar');
      await expect(page.getByTestId('vs-best')).toBeVisible();
      await rui.shot('you-vs-zap-phone');
    });

    await test.step('"Rever" opens the replay of the match', async () => {
      const rever = page.getByTestId('vs-history-row').getByRole('button');
      await rever.click();
      await expect(page.getByTestId('vs-replay')).toBeVisible();
      await expect(page.getByTestId('vs-replay').getByRole('combobox')).toBeVisible();
      await page.getByTestId('vs-replay-close').click();
      await expect(page.getByTestId('vs-replay')).toHaveCount(0);
      // The focus goes back to the button that opened the replay, not to the page (WCAG 2.4.3).
      await expect(rever).toBeFocused();
    });

    await test.step('"Forget" (data.vs.forget) empties IndexedDB; the next visit fills it again', async () => {
      expect(await cachedRecords(page)).toBe(1);
      await page.getByTestId('vs-forget').click();
      await expect(page.getByTestId('vs-data')).toContainText('Pronto. As cópias deste aparelho foram apagadas.');
      expect(await databases(page)).not.toContain('zap-you');
      await page.reload();
      await expect(page.getByTestId('page-vs')).toHaveAttribute('data-complete', 'true');
      await expect(page.getByTestId('vs-history-row')).toHaveCount(1);
      expect(await cachedRecords(page)).toBe(1);
    });

    await test.step('the deletion on the You page (/voce) removes the database', async () => {
      await page.getByTestId('vs-delete').click();
      await expect(page).toHaveURL(/\/voce#apagar$/);
      await page.getByTestId('you-delete').click();
      await page.getByTestId('you-delete-confirm').click();
      await passHumanCheck(page);
      await expect(page.getByTestId('you-status')).toHaveText('Pronto. Seus dados foram apagados.');
      await expect.poll(() => databases(page)).not.toContain('zap-you');
    });

    expect(rui.errors).toEqual([]);
  } finally {
    await rui.close();
  }
});

test('the English page and a browser with no matches', async ({ browser }) => {
  const eva = await Player.create(browser, 'Eva', DESKTOP);
  try {
    await eva.page.goto('/en/you-vs-zap');
    await expect(eva.page.getByRole('heading', { level: 1 })).toHaveText('You against Zap');
    await expect(eva.page.getByTestId('vs-empty')).toContainText('You have not played yet. Your first game shows up here.');
    await expect(eva.page).toHaveTitle('You against Zap · Zap');
    expect(eva.errors).toEqual([]);
  } finally {
    await eva.close();
  }
});

test('a person who played a few matches: every match in the history, the score by mode and a rating per table size', async ({ browser }) => {
  test.setTimeout(600_000);
  const lu = await Player.create(browser, 'Lu', DESKTOP);
  const page = lu.page;
  try {
    await test.step('two matches of 1 against 1 (the second one with "Play again", result.rematch) and one of 2 against 2, each to the end', async () => {
      await page.goto('/jogar');
      await startSolo(page, 2);
      await passHumanCheck(page);
      await expectTable(lu);
      expect((await playLoop(lu, { policy: QUICK, timeoutMs: 240_000 })).ended).toBe(true);
      await page.getByTestId('rematch-button').click();
      await expect(page.getByTestId('match-result')).toBeHidden();
      await expect.poll(() => lu.lastGame()?.matchNo).toBe(2);
      expect((await playLoop(lu, { policy: QUICK, timeoutMs: 240_000 })).ended).toBe(true);
      await page.goto('/jogar');
      await startSolo(page, 4);
      await expectTable(lu);
      expect((await playLoop(lu, { policy: QUICK, timeoutMs: 300_000 })).ended).toBe(true);
    });

    await test.step('the page lists the three matches and scores them', async () => {
      await page.goto('/voce-contra-o-zap');
      await expect(async () => {
        await page.reload();
        await expect(page.getByTestId('vs-history-row')).toHaveCount(3, { timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
      await expect(page.getByTestId('page-vs')).toHaveAttribute('data-complete', 'true');
      const rows = page.getByTestId('vs-history-row');
      await expect(rows.filter({ hasText: 'Paulista, 1 contra 1' })).toHaveCount(2);
      await expect(rows.filter({ hasText: 'Paulista, 2 contra 2' })).toHaveCount(1);
      await expect(page.locator('#vs-placar-t')).toHaveText(/^Você venceu [0-3] de 3 partidas contra o Zap\.$/);
      // The score by mode: one row per mode with games, each with its interval.
      const modes = page.locator('#vs-modos');
      await expect(modes.locator('.figure__title')).not.toBeEmpty();
      await expect(modes.locator('details.source tbody tr')).toHaveCount(2);
    });

    await test.step('a rating for each table size, still wide after so few games', async () => {
      const rating = page.locator('#vs-faixa');
      await expect(rating.locator('.figure__title')).toHaveText(/^Com [12] partidas?, sua faixa ainda é larga: entre \S+ e \S+\.$/);
      const sizes = rating.locator('.figure__controls button');
      await expect(sizes).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        await sizes.nth(i).click();
        await expect(sizes.nth(i)).toHaveAttribute('aria-pressed', 'true');
        await expect(rating.locator('.figure__title')).toHaveText(/^Com [12] partidas?, sua faixa ainda é larga: entre \S+ e \S+\.$/);
      }
      await expect(rating.locator('details.source tbody tr')).toHaveCount(2);
    });

    await test.step('the best hands, the reading, no abandons and the data links', async () => {
      await expect(page.getByTestId('vs-best')).toBeVisible();
      expect((await page.getByTestId('vs-best-hand').count()) + (await page.getByTestId('vs-best-empty').count())).toBeGreaterThan(0);
      await expect(page.getByTestId('vs-reading')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByTestId('vs-abandons-line')).toHaveText('Você nunca abandonou uma partida.');
      await expect(page.getByTestId('vs-download')).toHaveAttribute('href', '/voce#baixar');
      await lu.shot('you-vs-zap-few-desktop');
    });

    await test.step('the reading line links to the reading part of the data page', async () => {
      await page.getByTestId('vs-inmatch').getByRole('link').click();
      await expect(page).toHaveURL(/\/dados#leitura$/);
      await expect(page.locator('#leitura')).toBeInViewport();
    });

    expect(lu.errors).toEqual([]);
  } finally {
    await lu.close();
  }
});
