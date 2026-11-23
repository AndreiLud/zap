// Narrow phones (CLIENT-SPEC 2): every page, in both languages, at 360 and at 320 CSS px wide, has no
// horizontal scroll: the start page, Play (solo and room modes), the guided table in each scene,
// the rules page and its quick dialog, the reading pages, the menu sheet, a room's lobby and a
// table with a real match. The narrowest desktop (64em, 1024 px) is checked too, since its header
// holds the whole navigation, the external links, the four-color pill and the sound switch.

import { devices, expect, test, type Page } from '@playwright/test';
import { Player, createRoom, expectTable, passHumanCheck, startSolo } from './support/zap.ts';

const WIDTHS = [360, 320] as const;
const phoneAt = (width: number) => ({ ...devices['Pixel 7'], viewport: { width, height: width === 320 ? 568 : 640 } });

const PAGES = [
  '/',
  '/jogar',
  '/jogar?modo=sala',
  '/jogar/guiada?cena=antes',
  '/jogar/guiada?cena=meio',
  '/jogar/guiada?cena=truco',
  '/jogar/guiada?cena=fim',
  '/regras',
  '/regras?variante=mineiro',
  '/dados',
  '/voce',
  '/privacidade',
  '/termos',
  '/como-verificamos',
  '/nao-existe',
  '/en/',
  '/en/play',
  '/en/play?modo=sala',
  '/en/play/guided?cena=meio',
  '/en/play/guided?cena=truco',
  '/en/rules',
  '/en/data',
  '/en/you',
  '/en/privacy',
  '/en/terms',
  '/en/how-we-verify',
];

/** The widest thing on the page beyond the viewport, or null when nothing scrolls sideways. */
async function sideScroll(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    window.scrollTo(10_000, window.scrollY);
    const scrolled = window.scrollX;
    window.scrollTo(0, window.scrollY);
    if (doc.scrollWidth <= doc.clientWidth && scrolled === 0) return null;
    // Name the element that pokes out, for the failure message.
    let worst: Element | null = null;
    let right = doc.clientWidth;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 0.5) {
        right = r.right;
        worst = el;
      }
    }
    const name = worst ? `${worst.tagName.toLowerCase()}${worst.id ? `#${worst.id}` : ''}.${[...worst.classList].join('.')}` : '?';
    return `scrollWidth ${doc.scrollWidth} > ${doc.clientWidth} (scrollX ${scrolled}); widest: ${name} to ${Math.round(right)} px`;
  });
}

/** Waits for the page's main content (or the guided table) and the fonts, then checks. */
async function check(page: Page, where: string, problems: string[]): Promise<void> {
  await page.locator('main, [data-testid="page-guided"]').first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(300);
  const s = await sideScroll(page);
  if (s) problems.push(`${where}: ${s}`);
}

for (const width of WIDTHS) {
  test(`no horizontal scroll at ${width} px on any page, the sheet and the quick rules`, async ({ browser }) => {
    test.setTimeout(240_000);
    const me = await Player.create(browser, `W${width}`, phoneAt(width));
    const page = me.page;
    const problems: string[] = [];
    try {
      for (const path of PAGES) {
        await page.goto(path);
        if (path.includes('cena=')) await page.locator('[data-testid="hand-info"]').waitFor({ timeout: 15_000 });
        await check(page, path, problems);
      }
      await page.goto('/jogar');
      await page.getByTestId('opponents-toggle').click();
      await check(page, '/jogar with the opponents open', problems);
      await page.getByTestId('menu-button').click();
      await expect(page.getByTestId('site-sheet')).toBeVisible();
      await check(page, 'menu sheet', problems);
      await page.keyboard.press('Escape');
      await page.goto('/jogar/guiada?cena=meio');
      await page.locator('[data-testid="hand-info"]').waitFor();
      await page.keyboard.press('r');
      await expect(page.getByTestId('rules-dialog')).toBeVisible();
      await check(page, 'quick rules dialog', problems);
      await page.keyboard.press('Escape');
      expect(problems).toEqual([]);
      expect(me.errors).toEqual([]);
    } finally {
      await me.close();
    }
  });
}

test('no horizontal scroll at 1024 px, the narrowest desktop, and the header keeps one row', async ({ browser }) => {
  test.setTimeout(180_000);
  const me = await Player.create(browser, 'W1024', { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } });
  const page = me.page;
  const problems: string[] = [];
  try {
    for (const path of PAGES) {
      await page.goto(path);
      if (path.includes('cena=')) await page.locator('[data-testid="hand-info"]').waitFor({ timeout: 15_000 });
      await check(page, `1024 ${path}`, problems);
      // Every control of the header sits inside it, on one row.
      const header = await page.evaluate(() => {
        const h = document.querySelector('.site-header');
        if (!h) return 'no header';
        const box = h.getBoundingClientRect();
        const kids = [...h.children].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
        const top = Math.min(...kids.map((r) => r.top));
        const out = kids.some((r) => r.right > box.right + 0.5 || r.left < box.left - 0.5);
        const rows = kids.some((r) => r.top >= top + Math.max(...kids.map((k) => k.height)) - 0.5);
        return out || rows ? `header: ${out ? 'overflows' : ''} ${rows ? 'wraps' : ''}` : null;
      });
      if (header) problems.push(`1024 ${path}: ${header}`);
    }
    expect(problems).toEqual([]);
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});

test('no horizontal scroll at 360 px in a lobby and at a real table', async ({ browser }) => {
  test.setTimeout(180_000);
  const players: Player[] = [];
  const problems: string[] = [];
  try {
    const owner = await Player.create(browser, 'Owner', phoneAt(360));
    players.push(owner);
    await createRoom(owner, { players: 4, turn: '30' });
    await check(owner.page, 'lobby', problems);

    const solo = await Player.create(browser, 'Solo', phoneAt(360));
    players.push(solo);
    await solo.page.goto('/jogar');
    await startSolo(solo.page, 4);
    await passHumanCheck(solo.page);
    await expectTable(solo);
    await check(solo.page, 'table', problems);
    await solo.page.getByTestId('menu-button').click();
    await expect(solo.page.getByTestId('table-tools')).toBeVisible();
    await check(solo.page, 'table with the sheet and its tools', problems);
    expect(problems).toEqual([]);
  } finally {
    for (const p of players) await p.close();
  }
});
