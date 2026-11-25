// Choosing the line up of quick play (M15 spec 5): the Play page opens on the defaults every time
// (2 against 2: Zap and Iara with a random partner; 1 against 1: Zap), the switches "Adversários"
// and "Time" come before the pickers they hide, a character on one side is disabled on the other
// with the reason in words, and the end screen's switches below "Jogar de novo" choose between
// drawing again and repeating the line up just played. Only the mode and the variant are stored in
// this browser; an older stored line up is dropped as the page opens.

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, Player, QUICK, expectTable, passHumanCheck, playLoop } from './support/zap.ts';

const PERSONAS = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];

/** True when the element with testid `b` comes after the one with testid `a` in the page. */
function follows(page: Page, a: string, b: string): Promise<boolean> {
  return page.evaluate(
    ([x, y]) => {
      const ea = document.querySelector(`[data-testid="${x}"]`);
      const eb = document.querySelector(`[data-testid="${y}"]`);
      return !!ea && !!eb && (ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    },
    [a, b] as const,
  );
}

/** The page scrolls sideways (the check of layout.spec.ts, short form). */
function sideScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    window.scrollTo(10_000, window.scrollY);
    const scrolled = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return doc.scrollWidth > doc.clientWidth || scrolled !== 0;
  });
}

const stored = (page: Page) => page.evaluate(() => localStorage.getItem('zap-jogar'));

test('quick play line ups: defaults, the switches and pickers, the end screen switches and what the browser keeps', async ({ browser }) => {
  test.setTimeout(420_000);
  const me = await Player.create(browser, 'Lineup', DESKTOP);
  const page = me.page;
  const posts: unknown[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/play') posts.push(JSON.parse(r.postData() ?? 'null'));
  });
  try {
    await test.step('a fresh Play page: 2 against 2, Zap and Iara, the partner drawn', async () => {
      await page.goto('/jogar');
      await expect(page.locator('input[name="play-mode"][value="dupla"]')).toBeChecked();
      await expect(page.getByTestId('random-opponents')).not.toBeChecked();
      await expect(page.getByTestId('random-partner')).toBeChecked();
      await expect(page.getByTestId('random-opponents')).toHaveAttribute('role', 'switch');
      await expect(page.getByTestId('partner-toggle')).toHaveCount(0);
      await expect(page.getByTestId('opponents-toggle')).toContainText('Zap e Iara');
      await expect(page.getByTestId('play-summary')).toHaveText('Paulista, 2 contra 2: você e um parceiro sorteado contra o Zap e a Iara.');
      expect(await follows(page, 'random-partner', 'opponents-toggle'), 'the switches come before the pickers').toBe(true);
      await me.shot('m15-play-defaults');
    });

    await test.step('"Time" off by keyboard: the focus stays, the partner picker appears after it, and each side locks the other', async () => {
      const team = page.getByTestId('random-partner');
      await team.focus();
      await page.keyboard.press('Space');
      await expect(team).not.toBeChecked();
      await expect(team).toBeFocused();
      await expect(page.getByTestId('partner-toggle')).toContainText('Lia');
      expect(await follows(page, 'random-partner', 'partner-toggle'), 'the partner picker follows its switch').toBe(true);
      await page.getByTestId('partner-toggle').click();
      await page.getByTestId('partner-ravi').click();
      await expect(page.getByTestId('partner-toggle')).toContainText('Ravi');
      for (const id of ['zap', 'iara']) {
        await expect(page.getByTestId(`partner-${id}`).locator('input')).toBeDisabled();
        await expect(page.getByTestId(`partner-${id}`)).toContainText('joga contra você');
      }
      await expect(page.getByTestId('partner-lia').locator('input')).toBeEnabled();
      await page.getByTestId('opponents-toggle').click();
      await expect(page.getByTestId('opponent-ravi').locator('input')).toBeDisabled();
      await expect(page.getByTestId('opponent-ravi')).toContainText('joga com você');
      await expect(page.getByTestId('opponent-lia').locator('input')).toBeEnabled();
      await expect(page.getByTestId('play-summary')).toHaveText('Paulista, 2 contra 2: você e o Ravi contra o Zap e a Iara.');
      await me.shot('m15-play-partner-open');
    });

    await test.step('the match plays the chosen line up, to the end', async () => {
      await page.getByTestId('play-now').click();
      await passHumanCheck(page);
      await expectTable(me);
      expect(posts.at(-1)).toEqual({ players: 4, variant: 'paulista', opponents: ['zap', 'iara'], partner: 'ravi', randomOpponents: false, randomPartner: false });
      const room = me.lastRoom()!.room;
      expect(me.seat).toBe(0);
      expect(room.seats.slice(1).map((x) => x.persona)).toEqual(['zap', 'ravi', 'iara']);
      expect(room.settings.randomOpponents).toBe(false);
      expect(room.settings.randomPartner).toBe(false);
      expect(room.setup ?? 0).toBeGreaterThanOrEqual(1);
      expect((await playLoop(me, { policy: QUICK, timeoutMs: 300_000 })).ended).toBe(true);
    });

    await test.step('the end screen: both switches off below "Jogar de novo", in the focus order of the spec', async () => {
      const rematch = page.getByTestId('rematch-button');
      const opp = page.getByTestId('rematch-random-opponents');
      const team = page.getByTestId('rematch-random-partner');
      await expect(rematch).toBeVisible();
      await expect(opp).not.toBeChecked();
      await expect(team).not.toBeChecked();
      const [r, o, h] = await Promise.all([rematch.boundingBox(), opp.boundingBox(), page.getByTestId('home-button').boundingBox()]);
      expect(o!.y, 'the switches sit below "Jogar de novo"').toBeGreaterThanOrEqual(r!.y + r!.height);
      expect(h!.y, 'and above "Escolher outra mesa"').toBeGreaterThanOrEqual(o!.y + o!.height);
      await expect(page.getByTestId('match-result')).toBeFocused();
      for (const id of ['rematch-button', 'rematch-random-opponents', 'rematch-random-partner', 'home-button', 'link-vs']) {
        await page.keyboard.press('Tab');
        await expect(page.getByTestId(id)).toBeFocused();
      }
      await me.shot('m15-quick-end-switches');
      await page.setViewportSize({ width: 360, height: 640 });
      await page.waitForTimeout(300);
      expect(await sideScroll(page), 'no horizontal scroll at 360 px on the end screen').toBe(false);
      // The result never spills over the score bar; held upright it grows over the empty hand area,
      // so everything shows at once, with no scroll hidden inside the box.
      const [box, head] = await Promise.all([page.locator('.match-result').boundingBox(), page.getByTestId('match-result').boundingBox()]);
      expect(head!.y, 'the heading starts inside the result').toBeGreaterThanOrEqual(box!.y);
      await expect(rematch).toBeInViewport();
      await expect(page.getByTestId('link-vs')).toBeInViewport({ ratio: 1 });
      const inner = await page.locator('.match-result').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(inner.scroll, 'the result does not scroll inside its box').toBeLessThanOrEqual(inner.client + 1);
      await me.shot('m15-quick-end-switches-360');
      await page.setViewportSize(DESKTOP.viewport!);
    });

    await test.step('"Time" on, "Jogar de novo": the opponents stay, the partner is drawn again', async () => {
      await page.getByTestId('rematch-random-partner').check();
      await page.getByTestId('rematch-button').click();
      await expect.poll(() => me.lastGame()?.matchNo, { timeout: 20_000 }).toBe(2);
      expect(me.sent.map((x) => x.data)).toContain('{"t":"rematch","randomOpponents":false,"randomPartner":true}');
      const room = me.lastRoom()!.room;
      expect(room.seats[1].persona).toBe('zap');
      expect(room.seats[3].persona).toBe('iara');
      expect(['zap', 'iara']).not.toContain(room.seats[2].persona);
      expect(PERSONAS).toContain(room.seats[2].persona);
      expect(room.settings.randomPartner).toBe(true);
      expect(room.settings.randomOpponents).toBe(false);
      expect(room.settings.partner).toBe(room.seats[2].persona);
    });

    await test.step('1 against 1 with "Adversário" on: a random opponent from the six', async () => {
      await page.goto('/jogar');
      await page.getByTestId('mode-1x1').click();
      await expect(page.getByTestId('random-partner')).toHaveCount(0);
      await expect(page.getByTestId('random-opponents')).not.toBeChecked();
      await page.getByTestId('random-opponents').check();
      await expect(page.getByTestId('opponents-toggle')).toHaveCount(0);
      await expect(page.getByTestId('play-summary')).toHaveText('Paulista, 1 contra 1: você contra um adversário sorteado.');
      await page.getByTestId('play-now').click();
      await expectTable(me);
      expect(posts.at(-1)).toEqual({ players: 2, variant: 'paulista', opponents: ['zap'], randomOpponents: true });
      const room = me.lastRoom()!.room;
      expect(room.settings.randomOpponents).toBe(true);
      expect(PERSONAS).toContain(room.seats[1].persona);
      expect(room.settings.opponents).toEqual([room.seats[1].persona]);
    });

    await test.step('a reload starts from the defaults again; only the mode and the variant are kept', async () => {
      await page.goto('/jogar');
      await expect(page.locator('input[name="play-mode"][value="solo"]')).toBeChecked();
      await expect(page.getByTestId('random-opponents')).not.toBeChecked();
      await expect(page.getByTestId('play-summary')).toHaveText('Paulista, 1 contra 1: você contra o Zap.');
      await page.getByTestId('mode-2x2').click();
      await page.getByTestId('variant-mineiro').click();
      await page.getByTestId('random-partner').uncheck();
      await page.getByTestId('random-opponents').check();
      await page.reload();
      await expect(page.locator('input[name="play-mode"][value="dupla"]')).toBeChecked();
      await expect(page.locator('input[name="play-variant"][value="mineiro"]')).toBeChecked();
      await expect(page.getByTestId('random-opponents')).not.toBeChecked();
      await expect(page.getByTestId('random-partner')).toBeChecked();
      await expect(page.getByTestId('play-summary')).toHaveText('Mineiro, 2 contra 2: você e um parceiro sorteado contra o Zap e a Iara.');
      expect(JSON.parse((await stored(page))!)).toEqual({ modo: 'dupla', variante: 'mineiro' });
    });

    await test.step('an older stored line up is ignored and rewritten without it as the page opens', async () => {
      await page.evaluate(() => localStorage.setItem('zap-jogar', JSON.stringify({ modo: 'dupla', variante: 'paulista', contra: { dupla: ['lia', 'ravi'], solo: ['otavio'] } })));
      await page.reload();
      await expect(page.getByTestId('opponents-toggle')).toContainText('Zap e Iara');
      await expect.poll(async () => JSON.parse((await stored(page)) ?? 'null')).toEqual({ modo: 'dupla', variante: 'paulista' });
    });

    await test.step('no horizontal scroll at 360 px with both switches off and both pickers open', async () => {
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByTestId('random-partner').uncheck();
      await page.getByTestId('opponents-toggle').click();
      await page.getByTestId('partner-toggle').click();
      await expect(page.getByTestId('partner-zap')).toBeVisible();
      await expect(page.getByTestId('opponent-lia')).toBeVisible();
      await page.waitForTimeout(300);
      expect(await sideScroll(page), 'no horizontal scroll at 360 px on the Play page').toBe(false);
      await me.shot('m15-play-pickers-360');
    });
    expect(me.errors).toEqual([]);
    expect(me.problems).toEqual([]);
  } finally {
    await me.close();
  }
});
