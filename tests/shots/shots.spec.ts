// Screenshots of the client for the before and after comparison (CLIENT-SPEC section 20).
//
// SHOTS_PHASE=before photographs the client as it was before milestone 8 (the plain skin: home
// with every control, the old dropdown menu, the old table). SHOTS_PHASE=after (WP8) photographs
// the same names on the new client plus the new states; each test below says which phase it
// belongs to. Pictures: _local/m8/shots/<phase>/<name>.png.
//
// Rules for every picture: a fresh device that already answered the age gate and read the notice
// (as a person who played before), light theme unless the name says dark, no animation caught
// half way (each shot waits for the state it names). Pages and tables are full page, so nothing
// below the first screen is missed; the open menu and the dialogs are the first screen.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, DESKTOP, PHONE, Player, QUICK, createRoom, expectTable, passHumanCheck, playLoop, startSolo as startFromPlay } from '../e2e/support/zap.ts';

const PHASE = process.env.SHOTS_PHASE === 'after' ? 'after' : 'before';
const DIR = fileURLToPath(new URL(`../../_local/m8/shots/${PHASE}/`, import.meta.url));
mkdirSync(DIR, { recursive: true });

async function shot(page: Page, name: string, fullPage: boolean): Promise<void> {
  // Fonts and the last layout settle before the picture.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${DIR}${name}.png`, fullPage, animations: 'disabled' });
}

/** Quick play from the client of this phase: a solo 2 against 2 against two AIs. */
async function startSolo(p: Player): Promise<void> {
  const page = p.page;
  if (PHASE === 'before') {
    await page.goto('/');
    await page.getByTestId('play-now').click();
  } else {
    await page.goto('/jogar');
    await startFromPlay(page, 4);
  }
  await passHumanCheck(page);
  await expectTable(p);
}

test.describe(`shots, ${PHASE}`, () => {
  test('home on the phone and the desktop, and the phone menu', async ({ browser }) => {
    const phone = await Player.create(browser, 'Phone', PHONE);
    const desk = await Player.create(browser, 'Desk', DESKTOP);
    try {
      await phone.page.goto('/');
      await expect(phone.page.getByTestId('menu-button')).toBeVisible();
      await shot(phone.page, 'home-phone', true);
      await phone.page.getByTestId('menu-button').click();
      await expect(phone.page.getByTestId('link-source')).toBeVisible();
      await shot(phone.page, 'home-menu-phone', false);

      await desk.page.goto('/');
      await expect(desk.page.getByTestId('site-footer')).toBeVisible();
      await shot(desk.page, 'home-desktop', true);
    } finally {
      await phone.close();
      await desk.close();
    }
  });

  test('a room lobby on the desktop', async ({ browser }) => {
    const desk = await Player.create(browser, 'Ana', DESKTOP);
    try {
      // The support helper follows the client: WP8 moves it to the room mode of /jogar.
      await createRoom(desk, { players: 4, turn: '30' });
      await expect(desk.page.getByTestId('start-button')).toBeVisible();
      await shot(desk.page, 'lobby-desktop', true);
    } finally {
      await desk.close();
    }
  });

  test('the table on the phone after three moves, the quick rules, and the end of the match', async ({ browser }) => {
    const phone = await Player.create(browser, 'Phone', PHONE);
    const page = phone.page;
    try {
      await startSolo(phone);
      await playLoop(phone, { policy: QUICK, stop: () => phone.moves >= 3, timeoutMs: 60_000 });
      // Wait for the person's own turn, so the picture shows a table waiting for a card.
      await page.waitForFunction(() => document.querySelector('[data-testid="turn-indicator"]')?.getAttribute('data-mine') === 'true', null, { timeout: 30_000 });
      await shot(page, 'table-phone', true);

      if (PHASE === 'before') {
        await page.getByTestId('menu-button').click();
        await page.getByTestId('rules-button').click();
      } else {
        await page.keyboard.press('r');
      }
      await expect(page.getByTestId('rules-dialog')).toBeVisible();
      await shot(page, 'rules-dialog-phone', false);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('rules-dialog')).toBeHidden();

      const r = await playLoop(phone, { policy: QUICK, timeoutMs: 240_000 });
      expect(r.ended).toBe(true);
      await expect(page.getByTestId('match-result')).toBeVisible();
      await shot(page, 'match-end-phone', true);
    } finally {
      await phone.close();
    }
  });

  test('the table on the desktop', async ({ browser }) => {
    const desk = await Player.create(browser, 'Desk', DESKTOP);
    const page = desk.page;
    try {
      await startSolo(desk);
      await playLoop(desk, { policy: QUICK, stop: () => desk.moves >= 3, timeoutMs: 60_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="turn-indicator"]')?.getAttribute('data-mine') === 'true', null, { timeout: 30_000 });
      await shot(page, 'table-desktop', true);
    } finally {
      await desk.close();
    }
  });

  test('the You page (/voce) on the desktop and the privacy page on the phone', async ({ browser }) => {
    const desk = await Player.create(browser, 'Desk', DESKTOP);
    const phone = await Player.create(browser, 'Phone', PHONE);
    try {
      await desk.page.goto('/voce');
      await expect(desk.page.getByTestId('page-you')).toBeVisible();
      await desk.page.waitForTimeout(1_000);
      await shot(desk.page, 'you-desktop', true);

      await phone.page.goto('/privacidade');
      await expect(phone.page.getByTestId('page-privacy')).toBeVisible();
      await shot(phone.page, 'privacy-phone', true);
    } finally {
      await desk.close();
      await phone.close();
    }
  });
});

/** Waits for a guided scene (?cena=) to settle: the table and its info row are in. */
async function scene(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByTestId('hand-info').waitFor({ timeout: 20_000 });
  if (path.includes('cena=truco')) await page.getByTestId('truco-panel').waitFor();
  if (path.includes('cena=fim')) await page.getByTestId('guided-outro-play').waitFor();
  // The scene's own settling (the deck, the gather) has no event to wait for.
  await page.waitForTimeout(1_200);
}

/** Waits until the table waits for this person's card. */
async function myTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('[data-testid="turn-indicator"]')?.getAttribute('data-mine') === 'true', null, { timeout: 30_000 });
  await page.waitForTimeout(700);
}

/** The names of the 20 Open Graph images (CLIENT-SPEC 21.1 WP6). */
const OG = ['start', 'play', 'guided', 'rules', 'data', 'you', 'privacy', 'terms', 'verify', 'room'].flatMap((r) => [`${r}-pt`, `${r}-en`]);

test.describe('shots, after only', () => {
  test.skip(PHASE !== 'after', 'new states of milestone 8');

  test('start in the dark, Play on the phone and the desktop, the room mode, the menu sheet', async ({ browser }) => {
    const dark = await Player.create(browser, 'Dark', { ...PHONE, colorScheme: 'dark' });
    const phone = await Player.create(browser, 'Phone', PHONE);
    const desk = await Player.create(browser, 'Desk', DESKTOP);
    try {
      await dark.page.goto('/');
      await dark.page.getByTestId('home-play').waitFor();
      await dark.page.waitForTimeout(800);
      await shot(dark.page, 'start-phone-dark', false);

      await phone.page.goto('/jogar');
      await phone.page.getByTestId('play-now').waitFor();
      await shot(phone.page, 'play-phone', true);
      await phone.page.getByTestId('mode-room').click();
      await phone.page.getByTestId('create-room-submit').waitFor();
      await shot(phone.page, 'play-room-phone', true);
      await phone.page.getByTestId('menu-button').click();
      await phone.page.getByTestId('site-sheet').waitFor();
      await phone.page.waitForTimeout(400);
      await shot(phone.page, 'sheet-phone', false);

      await desk.page.goto('/jogar');
      await desk.page.getByTestId('play-now').waitFor();
      await shot(desk.page, 'play-desktop', true);
    } finally {
      await dark.close();
      await phone.close();
      await desk.close();
    }
  });

  test('the guided table in each scene, on the phone and the desktop', async ({ browser }) => {
    const phone = await Player.create(browser, 'Phone', PHONE);
    const desk = await Player.create(browser, 'Desk', DESKTOP);
    try {
      await scene(phone.page, '/jogar/guiada?cena=antes');
      await shot(phone.page, 'table-before-deal-phone', false);
      await scene(phone.page, '/jogar/guiada?cena=meio');
      await shot(phone.page, 'table-mid-phone', false);
      await scene(phone.page, '/jogar/guiada?cena=truco');
      await shot(phone.page, 'table-truco-phone', false);
      await scene(phone.page, '/jogar/guiada?cena=fim');
      await shot(phone.page, 'table-hand-end-phone', false);

      await scene(desk.page, '/jogar/guiada?cena=meio');
      await shot(desk.page, 'table-mid-desktop', false);
      await scene(desk.page, '/jogar/guiada?cena=truco');
      await shot(desk.page, 'table-truco-desktop', false);

      // The coach at the first step of the lesson.
      await phone.page.goto('/jogar/guiada');
      await phone.page.getByTestId('guided-start').click();
      await phone.page.getByTestId('coach').waitFor();
      await phone.page.waitForTimeout(1_500);
      await shot(phone.page, 'guided-coach-phone', false);
    } finally {
      await phone.close();
      await desk.close();
    }
  });

  test('the table with four colors, with reduced motion and in the dark', async ({ browser }) => {
    const four = await Player.create(browser, 'Four', PHONE);
    const calm = await Player.create(browser, 'Calm', { ...PHONE, reducedMotion: 'reduce' });
    const dark = await Player.create(browser, 'Dark', { ...PHONE, colorScheme: 'dark' });
    try {
      await four.page.goto('/');
      await four.page.evaluate(() => localStorage.setItem('zap-four-color', '1'));
      await scene(four.page, '/jogar/guiada?cena=meio');
      await shot(four.page, 'table-four-colors-phone', false);
      await scene(calm.page, '/jogar/guiada?cena=truco');
      await shot(calm.page, 'table-reduced-motion-phone', false);
      await scene(dark.page, '/jogar/guiada?cena=meio');
      await shot(dark.page, 'table-dark-phone', false);
    } finally {
      await four.close();
      await calm.close();
      await dark.close();
    }
  });

  test('a real solo match on the phone, first screen', async ({ browser }) => {
    const phone = await Player.create(browser, 'Real', PHONE);
    try {
      await phone.page.goto('/jogar');
      await startFromPlay(phone.page, 2);
      await passHumanCheck(phone.page);
      await expectTable(phone);
      await playLoop(phone, { policy: { raise: 0, accept: 1, run: 0 }, stop: () => phone.moves >= 1, timeoutMs: 60_000 });
      await myTurn(phone.page);
      await shot(phone.page, 'table-real-phone', false);
    } finally {
      await phone.close();
    }
  });

  test('rules on the phone and the desktop, the data placeholder and the not found page', async ({ browser }) => {
    const phone = await Player.create(browser, 'Phone', PHONE);
    const desk = await Player.create(browser, 'Desk', DESKTOP);
    try {
      await phone.page.goto('/regras');
      await phone.page.getByTestId('glossary').waitFor();
      await shot(phone.page, 'rules-phone', true);
      await desk.page.goto('/regras');
      await desk.page.getByTestId('glossary').waitFor();
      await shot(desk.page, 'rules-desktop', true);
      await phone.page.goto('/dados');
      await phone.page.getByTestId('page-data').waitFor();
      await shot(phone.page, 'data-placeholder-phone', true);
      await phone.page.goto('/nada-por-aqui');
      await phone.page.getByTestId('page-not-found').waitFor();
      await shot(phone.page, 'not-found-phone', true);
    } finally {
      await phone.close();
      await desk.close();
    }
  });

  test('after the reviews: the sheet on a table, and large text at the TRUCO panel and on Play', async ({ browser }) => {
    const phone = await Player.create(browser, 'Sheet', PHONE);
    const big = await Player.create(browser, 'Big', PHONE);
    try {
      await scene(phone.page, '/jogar/guiada?cena=meio');
      await phone.page.getByTestId('menu-button').click();
      await phone.page.getByTestId('site-sheet').waitFor();
      await phone.page.waitForTimeout(400);
      await shot(phone.page, 'table-sheet-phone', false);

      // The browser's text at 32 px, as Android's largest font setting does.
      const cdp = await big.ctx.newCDPSession(big.page);
      await cdp.send('Page.enable');
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
      await scene(big.page, '/jogar/guiada?cena=truco');
      await shot(big.page, 'table-truco-large-text-phone', false);
      await big.page.goto('/jogar');
      await big.page.locator('.lesson').scrollIntoViewIfNeeded();
      await big.page.waitForTimeout(400);
      await big.page.locator('.lesson').screenshot({ path: `${DIR}play-loop-large-text-phone.png`, animations: 'disabled' });
    } finally {
      await phone.close();
      await big.close();
    }
  });

  test('a contact sheet of the 20 Open Graph images', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1240, height: 800 } });
    const page = await ctx.newPage();
    try {
      // A plain local page (no site CSP here) with the site's own images in a grid of four.
      const figures = OG.map((n) => `<figure><img src="${BASE_URL}/og/${n}.png" alt="${n}"><figcaption>${n}</figcaption></figure>`).join('');
      await page.setContent(
        `<!doctype html><style>body{margin:0;padding:16px;background:#F2EDE2;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font:13px system-ui}figure{margin:0}img{width:100%;display:block;border-radius:6px;box-shadow:0 1px 3px rgb(0 0 0/.2)}figcaption{padding-top:4px}</style>${figures}`,
      );
      await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
      await page.screenshot({ path: `${DIR}og-contact-sheet.png`, fullPage: true });
    } finally {
      await ctx.close();
    }
  });
});

