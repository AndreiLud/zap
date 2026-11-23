// Screenshots of the data page and of "You against Zap" (milestone 7) for the owner's page
// _local/m7/paginas.html: phone (390 px) and computer (1440 px), light and dark, both languages for
// the data page; the personal page for a new person and for a person who played a few matches.
// Every picture waits until each figure has rendered (the page draws a chart when it comes near the
// screen) and is taken with animations off.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContextOptions, type Page } from '@playwright/test';
import { DESKTOP, PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo } from '../e2e/support/zap.ts';

const DIR = fileURLToPath(new URL('../../_local/m7/shots/', import.meta.url));
mkdirSync(DIR, { recursive: true });

// Phones at twice the pixels (sharp, and not too heavy for the full page); computers at one.
const phone = (scheme: 'light' | 'dark'): BrowserContextOptions => ({ ...PHONE, deviceScaleFactor: 2, colorScheme: scheme });
const computer = (scheme: 'light' | 'dark'): BrowserContextOptions => ({ ...DESKTOP, viewport: { width: 1440, height: 900 }, colorScheme: scheme });

/** Scrolls down the whole page so every lazy part renders, then back to the top. */
async function renderAll(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // The data page's four chapters load in their own chunk once the reader comes near them.
  if (await page.locator('[data-chapter-shell]').count()) {
    await page.locator('[data-chapter-shell]').first().scrollIntoViewIfNeeded();
    await expect(page.locator('[data-chapter-shell]')).toHaveCount(0);
  }
  const step = await page.evaluate(() => Math.round(innerHeight * 0.8));
  for (let y = 0; ; y += step) {
    const end = await page.evaluate((top) => {
      window.scrollTo(0, top);
      return top + innerHeight >= document.documentElement.scrollHeight;
    }, y);
    await page.waitForTimeout(60);
    if (end) break;
  }
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.screenshot({ path: `${DIR}${name}.png`, fullPage, animations: 'disabled' });
}

/** The parts of the data page, in order: the cover, part 1, the reading, the four chapters, the closing. */
const PARTS = ['capa', 'como-funciona', 'leitura', 'truco', 'evolucao', 'como-joga', 'pessoas', 'fim'];

/**
 * The data page: the first screen, then the whole page (computers) or one picture per part
 * (phones, whose whole page would be too tall for one picture).
 */
async function dataPage(p: Player, path: string, name: string, byPart: boolean): Promise<void> {
  await p.page.goto(path);
  await p.page.locator('#capa h1').waitFor();
  await expect(p.page.getByTestId('live-matches')).not.toHaveText('…');
  await renderAll(p.page);
  await expect(p.page.locator('#maos-marcantes .replay__controls')).toBeVisible();
  await shot(p.page, `${name}-screen`, false);
  if (!byPart) return shot(p.page, name);
  for (const [i, id] of PARTS.entries()) {
    await p.page.locator(`#${id}`).screenshot({ path: `${DIR}${name}-${i + 1}-${id}.png`, animations: 'disabled' });
  }
}

for (const [name, path, options, byPart] of [
  ['data-phone-light', '/dados', phone('light'), true],
  ['data-phone-dark', '/dados', phone('dark'), true],
  ['data-computer-light', '/dados', computer('light'), false],
  ['data-computer-dark', '/dados', computer('dark'), false],
  ['data-phone-en', '/en/data', phone('light'), true],
  ['data-computer-en-dark', '/en/data', computer('dark'), false],
] as const) {
  test(`data page: ${name}`, async ({ browser }) => {
    const p = await Player.create(browser, 'Foto', options);
    try {
      await dataPage(p, path, name, byPart);
    } finally {
      await p.close();
    }
  });
}

test('personal page: a new person, then a person after a few matches', async ({ browser }) => {
  test.setTimeout(900_000);
  const p = await Player.create(browser, 'Bia', phone('light'));
  const page = p.page;
  try {
    await page.goto('/voce-contra-o-zap');
    await expect(page.getByTestId('vs-empty')).toBeVisible();
    await shot(page, 'you-new-phone');

    // Two matches of 1 against 1 and one of 2 against 2, each to the end.
    await page.goto('/jogar');
    await startSolo(page, 2);
    await passHumanCheck(page);
    await expectTable(p);
    expect((await playLoop(p, { policy: QUICK, timeoutMs: 240_000 })).ended).toBe(true);
    await page.getByTestId('rematch-button').click();
    await expect(page.getByTestId('match-result')).toBeHidden();
    await expect.poll(() => p.lastGame()?.matchNo).toBe(2);
    expect((await playLoop(p, { policy: QUICK, timeoutMs: 240_000 })).ended).toBe(true);
    await shot(page, 'match-end-link', false);
    await page.goto('/jogar');
    await startSolo(page, 4);
    await expectTable(p);
    expect((await playLoop(p, { policy: QUICK, timeoutMs: 300_000 })).ended).toBe(true);

    await page.goto('/voce-contra-o-zap');
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId('vs-history-row')).toHaveCount(3, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId('page-vs')).toHaveAttribute('data-complete', 'true');
    await renderAll(page);
    await shot(page, 'you-phone-light');

    // The same person on a computer, dark: a new browser with this device's cookie and storage.
    const ctx = await browser.newContext({ ...computer('dark'), locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', storageState: await p.ctx.storageState() });
    try {
      const desk = await ctx.newPage();
      await desk.goto('/voce-contra-o-zap');
      await expect(desk.getByTestId('page-vs')).toHaveAttribute('data-complete', 'true');
      await expect(desk.getByTestId('vs-history-row')).toHaveCount(3);
      await renderAll(desk);
      await shot(desk, 'you-computer-dark');
      await desk.emulateMedia({ colorScheme: 'light' });
      await desk.goto('/en/you-vs-zap');
      await expect(desk.getByTestId('page-vs')).toHaveAttribute('data-complete', 'true');
      await renderAll(desk);
      await shot(desk, 'you-computer-en');
    } finally {
      await ctx.close();
    }
  } finally {
    await p.close();
  }
});
