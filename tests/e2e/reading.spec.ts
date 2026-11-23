// "How Zap reads you" on the You page (/voce): before any match there is nothing to read; after a solo
// match the section counts it, shows each number only once it is known well enough (the page
// agrees with /api/me/reading), and names where its reference comes from. "Don't adapt to me"
// takes the reading away at once, and switching it off starts the count again. The English page
// shows the same section.

import { expect, test, type Page } from '@playwright/test';
import { READING_KEYS, type Reading } from '../../shared/cycle-formats.ts';
import { PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo } from './support/zap.ts';

const api = <T,>(page: Page, path: string) => page.evaluate(async (p) => (await fetch(p)).json(), path) as Promise<T>;

test('the reading counts a finished match, hides what is not known yet, and goes with "Don\'t adapt to me"', async ({ browser }) => {
  test.setTimeout(300_000);
  const caio = await Player.create(browser, 'Caio', PHONE);
  const page = caio.page;
  try {
    await test.step('a solo 1 against 1 match, played to the end', async () => {
      await page.goto('/jogar');
      await startSolo(page, 2);
      await passHumanCheck(page);
      await expectTable(caio);
      const r = await playLoop(caio, { policy: QUICK, timeoutMs: 240_000 });
      expect(r.ended).toBe(true);
    });

    await test.step('the You page (/voce) reads the match: each number shown only when the server shows it', async () => {
      await page.getByTestId('footer-you').click();
      await expect(page).toHaveURL(/\/voce$/);
      // The room writes the match when it ends; a reload shows it once it is there.
      await expect(async () => {
        await page.reload();
        await expect(page.getByTestId('reading-summary')).toContainText('Partidas contadas: 1.', { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      const section = page.getByTestId('you-reading');
      await expect(section).toHaveAttribute('data-state', 'ready');
      await expect(section.getByRole('heading', { name: 'Como o Zap te lê' })).toBeVisible();
      const r = await api<Reading>(page, '/api/me/reading');
      expect(r.matches).toBe(1);
      await expect(page.getByTestId('reading-summary')).toHaveText(`Partidas contadas: 1. Decisões contadas: ${r.decisions}.`);
      for (const [i, key] of READING_KEYS.entries()) {
        const row = page.getByTestId(`reading-${key}`);
        const x = r.numbers[i];
        await expect(row).toHaveAttribute('data-shown', String(x.shown));
        await expect(row).toContainText(x.shown ? 'provavelmente de' : `Ainda não dá para dizer. Observações até agora: ${x.n}.`);
        // Each number names its own source: the self-play value until people fitted that number.
        await expect(row).toContainText(x.source === 'people' ? /Referência: .+, de quem joga no Zap\./ : /Referência: .+, das partidas do Zap contra ele mesmo\./);
      }
      await expect(page.getByTestId('reading-time')).toHaveAttribute('data-shown', String(r.time.shown));
      await caio.shot('you-reading-phone');
    });

    await test.step('"Don\'t adapt to me" takes the reading away at once; switched off, the count starts again', async () => {
      await page.getByTestId('pref-no-adapt').check();
      await expect(page.getByTestId('prefs-status')).toHaveText('Escolha salva.');
      await expect(page.getByTestId('reading-off')).toBeVisible();
      await expect(page.getByTestId('reading-summary')).toHaveCount(0);
      expect((await api<{ profile: unknown[] }>(page, '/api/me/data')).profile).toEqual([]);
      await page.getByTestId('pref-no-adapt').uncheck();
      await expect(page.getByTestId('prefs-status')).toHaveText('Escolha salva.');
      await expect(page.getByTestId('reading-summary')).toHaveText('Partidas contadas: 0. Decisões contadas: 0.');
      await expect(page.getByTestId('reading-raise')).toHaveAttribute('data-shown', 'false');
    });

    await test.step('the English page shows the same section', async () => {
      await page.goto('/en/you');
      await expect(page.getByTestId('you-reading').getByRole('heading', { name: 'How Zap reads you' })).toBeVisible();
      await expect(page.getByTestId('reading-summary')).toHaveText('Matches counted: 0. Decisions counted: 0.');
      await expect(page.getByTestId('reading-bluff')).toContainText('Too early to say. Observations so far: 0.');
    });

    expect(caio.errors).toEqual([]);
  } finally {
    await caio.close();
  }
});
