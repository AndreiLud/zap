// The brake as a person meets it (worker/src/brake.ts, web/src/limit.ts): a quick play match on a
// test ledger with room for one match, played to the end; "Jogar de novo" is refused and the table
// says until when; back on the Play page, "Jogar agora" is refused the same way, in both languages. The ledger
// header (x-zap-test-ledger) is honoured only on a local test site.

import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DESKTOP, QUICK, expectTable, newPlayers, passHumanCheck, playLoop, startSolo } from './support/zap.ts';

// From 21h to 24h in Brasília (00:00 to 03:00 UTC) the reset is the next day's 21h (web/src/limit.ts).
const tomorrow = () => new Date().getUTCHours() < 3;
const dayPt = () => `O Zap chegou ao limite de hoje. Volte ${tomorrow() ? 'amanhã ' : ''}depois das 21h.`;
const dayEn = () => new RegExp(`^Zap has reached today's limit\\. Come back ${tomorrow() ? 'tomorrow ' : ''}after 9\\sPM, Brasília time\\.$`, 'u');

test('the brake: the rematch and a new quick play are refused, and the page says to come back after 21h', async ({ browser }) => {
  test.setTimeout(300_000);
  const [me] = await newPlayers(browser, [['Desktop', DESKTOP]]);
  const page = me.page;
  try {
    await me.ctx.setExtraHTTPHeaders({ 'x-zap-test-ledger': `${randomBytes(8).toString('hex')}:1` });

    await test.step('the one match the ledger has room for starts and is played to the end', async () => {
      await page.goto('/jogar');
      await startSolo(page, 4);
      await passHumanCheck(page);
      await expect(page).toHaveURL(/\/\?sala=[A-Z0-9]{5}$/, { timeout: 20_000 });
      await expectTable(me);
      const r = await playLoop(me, { policy: QUICK, timeoutMs: 240_000 });
      expect(r.ended).toBe(true);
      await expect(page.getByTestId('rematch-button')).toBeVisible();
    });

    await test.step('"Play again" (result.rematch) is refused: the table stays on the result and says when to come back', async () => {
      const matchNo = me.lastRoom()!.room.matchNo;
      await page.getByTestId('rematch-button').click();
      await expect(page.getByTestId('notice-limit')).toHaveText(dayPt());
      await expect(page.getByTestId('match-result')).toBeVisible();
      expect(me.lastRoom()!.room.matchNo).toBe(matchNo);
      expect(me.lastRoom()!.room.status).toBe('ended');
      await me.shot('brake-rematch-refused');
    });

    await test.step('back on the Play page, "Play now" (play.play) is refused the same way, in Portuguese and in English, without asking the server again', async () => {
      await page.goto('/jogar');
      await expect(page.getByTestId('notice-limit')).toHaveCount(0);
      // The page keeps the refusal (web/src/limit.ts holdLimit): no new request reaches the server.
      const asked: string[] = [];
      page.on('request', (r) => {
        if (new URL(r.url()).pathname === '/api/play') asked.push(r.url());
      });
      await page.getByTestId('play-now').click();
      await expect(page.getByTestId('home-error')).toHaveText(dayPt());
      await expect(page).toHaveURL(/\/jogar$/);
      expect(asked).toEqual([]);
      await me.shot('brake-home-refused');
      await page.getByTestId('lang-switch').click();
      await expect(page.getByTestId('home-error')).toHaveText(dayEn());
    });

    await test.step('once the page lets the refusal go, the server is asked and refuses again', async () => {
      await page.evaluate(() => sessionStorage.removeItem('zap-limit'));
      await page.reload();
      const refused = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/play' && r.status() === 503);
      await page.getByTestId('play-now').click();
      await refused;
      await expect(page.getByTestId('home-error')).toHaveText(dayEn());
    });
  } finally {
    await me.close();
  }
});
