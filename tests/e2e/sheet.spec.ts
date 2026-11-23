// The phone menu sheet (CLIENT-SPEC 9.1, 9.3, 19.4): it opens with the focus on the current page's
// link, Tab and Shift+Tab stay inside it, Esc and a click on the backdrop close it and give the focus
// back to the menu button; on a table the R key opens the quick rules and the focus comes back where
// it was, and the sheet's Regras item opens the same dialog; the four-color switch marks the page
// and survives a reload.

import { expect, test, type Page } from '@playwright/test';
import { PHONE, Player } from './support/zap.ts';

/** True when the focused element is inside the open sheet. */
const focusInSheet = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('#site-sheet[open]'));

test('the menu sheet on a phone: focus, Tab wrap, Esc, backdrop, R on a table, four colors', async ({ browser }) => {
  test.setTimeout(120_000);
  const phone = await Player.create(browser, 'Phone', PHONE);
  const page = phone.page;
  const menu = page.getByTestId('menu-button');
  const sheet = page.getByTestId('site-sheet');
  try {
    await test.step('opens with the focus on the current page link', async () => {
      await page.goto('/jogar');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.click();
      await expect(sheet).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      const current = page.locator('#site-nav [aria-current="page"]');
      await expect(current).toHaveText(/Jogar/);
      await expect(current).toBeFocused();
    });

    await test.step('Tab and Shift+Tab wrap inside the sheet', async () => {
      const count = await sheet.evaluate(
        (d) => [...d.querySelectorAll<HTMLElement>('a[href], button, input, select, [tabindex]:not([tabindex="-1"])')].filter((e) => e.offsetParent !== null).length,
      );
      expect(count).toBeGreaterThan(5);
      for (let i = 0; i < count + 2; i++) {
        await page.keyboard.press('Tab');
        expect(await focusInSheet(page), `Tab ${i + 1} stays in the sheet`).toBe(true);
      }
      for (let i = 0; i < count + 2; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await focusInSheet(page), `Shift+Tab ${i + 1} stays in the sheet`).toBe(true);
      }
    });

    await test.step('Esc closes and the focus goes back to the menu button', async () => {
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();
    });

    await test.step('a click on the backdrop closes it', async () => {
      await menu.click();
      await expect(sheet).toBeVisible();
      // The sheet slides in from the right; the strip on the left is backdrop.
      const box = (await sheet.boundingBox())!;
      expect(box.x).toBeGreaterThan(20);
      await page.mouse.click(10, 300);
      await expect(sheet).toBeHidden();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
    });

    await test.step('on a table, R opens the quick rules and the focus comes back to the card', async () => {
      await page.goto('/jogar/guiada');
      await page.getByTestId('guided-start').click();
      const card = page.getByTestId(/^hand-card-\d$/).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.focus();
      await page.keyboard.press('r');
      const dialog = page.getByTestId('rules-dialog');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(card).toBeFocused();
    });

    await test.step('on a table, the sheet\'s Regras item opens the same dialog; closing it focuses the menu button', async () => {
      await menu.click();
      await page.getByTestId('rules-button').click();
      const dialog = page.getByTestId('rules-dialog');
      await expect(dialog).toBeVisible();
      await expect(sheet).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(menu).toBeFocused();
    });

    await test.step('the four-color switch marks the page and survives a reload', async () => {
      await page.goto('/jogar');
      await expect(page.locator('html')).not.toHaveAttribute('data-deck', 'four');
      await menu.click();
      const sw = page.getByTestId('four-color-switch');
      await expect(sw).toHaveAttribute('role', 'switch');
      await sw.check();
      await expect(page.locator('html')).toHaveAttribute('data-deck', 'four');
      await page.keyboard.press('Escape');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-deck', 'four');
      await menu.click();
      await expect(page.getByTestId('four-color-switch')).toBeChecked();
      await page.getByTestId('four-color-switch').uncheck();
      await expect(page.locator('html')).not.toHaveAttribute('data-deck', 'four');
    });
    expect(phone.errors).toEqual([]);
  } finally {
    await phone.close();
  }
});
