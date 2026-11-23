// The age gate and the notice, from a browser that never answered: under 18 nothing reaches the
// server (not even from an invite link or the You page (/voce)); an adult reads the notice once, and
// the human check then sends only the token and "adult: true". The legal pages open in both
// languages from the footer and from the phone menu.

import { expect, test, type Page } from '@playwright/test';
import { ADULT_KEY, NOTICE_KEY, NOTICE_VERSION } from '../../web/src/consent-keys.ts';
import { DESKTOP, PHONE, Player, expectTable, passHumanCheck, startSolo, tableTool } from './support/zap.ts';

const PERSONAL = 'O Zap é um projeto pessoal, mantido por uma pessoa física, sem fins lucrativos.';

/** Every call to the API this page makes, as "METHOD /path". */
/**
 * The public counters (GET /api/live when the Play page opens, GET /api/summary on the data page)
 * are read by everyone before any question, are answered before any credential and carry nothing
 * of the person; they are recorded apart, with a note when one went out with a cookie.
 */
const PUBLIC_READS = new Set(['/api/live', '/api/summary']);

function recordApi(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    if (r.method() === 'GET' && PUBLIC_READS.has(u.pathname)) {
      if ((await r.allHeaders()).cookie) calls.push(`${u.pathname} with a cookie`);
      return;
    }
    calls.push(`${r.method()} ${u.pathname}`);
  });
  return calls;
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test('under 18 nothing reaches the server; an adult reads the notice once and plays', async ({ browser }) => {
  test.setTimeout(180_000);
  const me = await Player.create(browser, 'Fresh', PHONE, { fresh: true });
  const page = me.page;
  const api = recordApi(page);
  const thisYear = new Date().getFullYear();
  try {
    await test.step('under 18 from "Play now" (play.play): a kind message with the rules and the data page, nothing sent', async () => {
      await page.goto('/jogar');
      await startSolo(page, 4);
      await expect(page.getByTestId('age-gate')).toBeVisible();
      await expect(page.getByTestId('age-gate')).toContainText('Em que ano você nasceu?');
      // A neutral list with no default, and the focus already inside the dialog.
      await expect(page.getByTestId('age-year')).toHaveValue('');
      await expect(page.getByTestId('age-year')).toBeFocused();
      await page.getByTestId('age-continue').click();
      await expect(page.getByTestId('age-error')).toBeVisible();
      await page.getByTestId('age-year').selectOption(String(thisYear - 15));
      await page.getByTestId('age-continue').click();
      await expect(page.getByTestId('age-under')).toBeVisible();
      await expect(page.getByTestId('age-under')).toContainText('As partidas são para maiores de 18 anos');
      await expect(page.getByTestId('age-under-data')).toHaveAttribute('href', '/privacidade');
      await me.shot('age-under-phone');
      // The rules stay open to everyone.
      await page.getByTestId('age-under-rules').click();
      await expect(page.getByTestId('age-gate')).toBeHidden();
      await expect(page.getByTestId('rules-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('rules-dialog')).toBeHidden();
      expect(api, 'no call to the server').toEqual([]);
      expect(await stored(page, ADULT_KEY)).toBeNull();
    });

    await test.step('the year that turns 18 asks about the birthday; "Not yet" (legal.age.birthday.no) is under 18', async () => {
      await startSolo(page, 2);
      await page.getByTestId('age-year').selectOption(String(thisYear - 18));
      await expect(page.getByTestId('age-birthday')).toBeVisible();
      await page.getByTestId('age-continue').click();
      await expect(page.getByTestId('age-error')).toBeVisible();
      await page.getByTestId('age-birthday-no').check();
      await page.getByTestId('age-continue').click();
      await expect(page.getByTestId('age-under')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('age-gate')).toBeHidden();
      expect(api).toEqual([]);
    });

    await test.step('an invite link and the You page (/voce) ask first, before any call', async () => {
      await page.goto('/?sala=ABCDE');
      await expect(page.getByTestId('age-gate')).toBeVisible();
      await page.getByTestId('age-year').selectOption(String(thisYear - 12));
      await page.getByTestId('age-continue').click();
      await page.getByTestId('age-under-close').click();
      await expect(page.getByTestId('room-problem')).toHaveAttribute('data-problem', 'age');
      await page.goto('/voce');
      await expect(page.getByTestId('page-you')).toHaveAttribute('data-state', 'gate');
      await page.getByTestId('you-start').click();
      await page.getByTestId('age-year').selectOption(String(thisYear - 16));
      await page.getByTestId('age-continue').click();
      await page.getByTestId('age-under-close').click();
      await expect(page.getByTestId('page-you')).toHaveAttribute('data-state', 'gate');
      expect(api, 'no call to the server').toEqual([]);
      expect(await stored(page, ADULT_KEY)).toBeNull();
    });

    await test.step('an adult reads the notice, passes the check, and the session carries only the token and adult', async () => {
      await page.goto('/jogar');
      const session = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/session'));
      await startSolo(page, 4);
      await page.getByTestId('age-year').selectOption(String(thisYear - 30));
      await page.getByTestId('age-continue').click();
      const notice = page.getByTestId('notice-dialog');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(PERSONAL);
      await expect(notice).toContainText('Estados Unidos');
      await expect(notice).toContainText('Cloudflare');
      await expect(page.getByTestId('notice-privacy')).toHaveAttribute('href', '/privacidade');
      await expect(page.getByTestId('notice-terms')).toHaveAttribute('href', '/termos');
      // The notice only reads the site's contact; nothing about the person has been sent.
      expect(api.filter((c) => c !== 'GET /api/config')).toEqual([]);
      expect(await stored(page, ADULT_KEY)).toBe('1');
      await me.shot('notice-phone');
      await page.getByTestId('notice-ok').click();
      await passHumanCheck(page);
      const body = (await session).postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['adult', 'token']);
      expect(body.adult).toBe(true);
      await expectTable(me);
      expect(await stored(page, NOTICE_KEY)).toBe(NOTICE_VERSION);
    });

    await test.step('the next match asks nothing again', async () => {
      // On the phone the table tools live in the menu sheet; leaving lands on the Play page.
      await (await tableTool(page, 'leave-button')).click();
      await expect(page).toHaveURL(/\/jogar$/);
      await expect(page.getByTestId('mode-1x1')).toBeVisible();
      await startSolo(page, 2);
      await expectTable(me);
      await expect(page.getByTestId('age-gate')).toBeHidden();
      await expect(page.getByTestId('notice-dialog')).toBeHidden();
      expect(me.errors).toEqual([]);
    });
  } finally {
    await me.close();
  }
});

test('the legal pages open in both languages from the footer and the phone menu', async ({ browser }) => {
  const desk = await Player.create(browser, 'Desk', DESKTOP, { fresh: true });
  const phone = await Player.create(browser, 'Phone', PHONE, { fresh: true });
  try {
    await test.step('footer links on the home page, and each page in Portuguese and English', async () => {
      const page = desk.page;
      await page.goto('/');
      // The start page's short footer has no source link: the page's own button carries it.
      await expect(page.getByTestId('home-source')).toHaveAttribute('href', /github\.com/);
      const pages = [
        { id: 'footer-privacy', pt: '/privacidade', en: '/en/privacy', h1pt: 'Privacidade', h1en: 'Privacy' },
        { id: 'footer-terms', pt: '/termos', en: '/en/terms', h1pt: 'Termos de uso', h1en: 'Terms of use' },
        { id: 'footer-verify', pt: '/como-verificamos', en: '/en/how-we-verify', h1pt: 'Como verificamos', h1en: 'How we verify' },
      ];
      for (const p of pages) {
        await page.getByTestId(p.id).click();
        await expect(page).toHaveURL(new RegExp(`${p.pt}$`));
        await expect(page.locator('h1')).toHaveText(p.h1pt);
        await expect(page.locator('h1')).toBeFocused();
        if (p.pt !== '/como-verificamos') await expect(page.locator('main')).toContainText(PERSONAL);
        await page.getByTestId('lang-switch').click();
        await expect(page).toHaveURL(new RegExp(`${p.en}$`));
        await expect(page.locator('h1')).toHaveText(p.h1en);
        await expect(page).toHaveTitle(new RegExp(`^${p.h1en}`));
        await page.getByTestId('lang-switch').click();
        await expect(page).toHaveURL(new RegExp(`${p.pt}$`));
      }
      // Without a contact address, the pages say rights are used on the You page (/voce).
      await page.goto('/privacidade');
      await expect(page.locator('main')).toContainText('Por enquanto não há um endereço de contato');
      await page.getByRole('link', { name: 'Abrir a página Você' }).click();
      await expect(page).toHaveURL(/\/voce$/);
      await expect(page.getByTestId('page-you')).toBeVisible();
      await desk.shot('legal-you-desktop');
      // A direct visit to the English address works too.
      await page.goto('/en/how-we-verify');
      await expect(page.locator('h1')).toHaveText('How we verify');
      await desk.shot('legal-verify-en-desktop');
    });

    await test.step('on the phone, the menu has Você and the three legal pages', async () => {
      const page = phone.page;
      await page.goto('/');
      await page.getByTestId('menu-button').click();
      const nav = page.locator('#site-nav');
      for (const name of ['Você', 'Privacidade', 'Termos', 'Como verificamos']) await expect(nav.getByRole('link', { name })).toBeVisible();
      await nav.getByRole('link', { name: 'Termos' }).click();
      await expect(page).toHaveURL(/\/termos$/);
      await expect(page.getByTestId('menu-button')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('h1')).toHaveText('Termos de uso');
      await phone.shot('legal-terms-phone');
    });
  } finally {
    await desk.close();
    await phone.close();
  }
});
