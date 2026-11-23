// Keyboard play on the desktop, in English (CLIENT-SPEC 12, 19.4): a solo 1 against 1 match played
// to the end with the keys only (1, 2 and 3 for the cards, T to raise, A to accept, C to run), never
// the mouse; the quick rules open with R in the middle of the match without touching the room's
// connection and give the focus back; the match ends with the focus on the result heading.

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, auditRoom, expectTable, newPlayers, passHumanCheck, textContrast, waitForMove, type TableState } from './support/zap.ts';

/** The key for the first playable card: its place (1, 2 or 3) among the cards still in hand, left to right. */
async function cardKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid^="hand-card-"]')];
    const i = cards.findIndex((b) => b.getAttribute('aria-disabled') !== 'true');
    return i < 0 ? null : String(i + 1);
  });
}

/** A person at the keyboard: answers bets (A or C, sometimes T), raises now and then (T), else plays a card. */
async function chooseKey(page: Page, st: TableState): Promise<string | null> {
  const r = Math.random();
  if (st.accept || st.run) {
    if (st.accept && r < 0.6) return 'a';
    if (st.run && r < 0.85) return 'c';
    if (st.raise) return 't';
    return st.accept ? 'a' : 'c';
  }
  if (st.raise && r < 0.25) return 't';
  if (st.cards.length) return cardKey(page);
  return st.raise ? 't' : null;
}

test('a whole solo match with the keyboard only, the quick rules on R, and the focus on the result', async ({ browser }) => {
  test.setTimeout(300_000);
  const [me] = await newPlayers(browser, [['Keys', DESKTOP]]);
  const page = me.page;
  // Any mouse use would be a failure of the test itself: count pointer events in the page.
  await page.addInitScript(() => {
    const w = window as unknown as { __zapPointer: number };
    w.__zapPointer = 0;
    for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
      window.addEventListener(type, (e) => {
        if ((e as PointerEvent).detail > 0 || e.type === 'pointerdown' || e.type === 'mousedown') w.__zapPointer++;
      }, true);
    }
  });
  const used = new Map<string, number>();
  // The key hint on each kind of raise button (the bet button of the actions row, the raise of the
  // TRUCO panel), measured once in the light theme: small text, so 4.5:1 at least.
  const hints = new Map<string, number>();
  const measureHint = async () => {
    const raise = page.getByTestId('action-raise');
    if (!(await raise.isVisible().catch(() => false))) return;
    const kind = (await raise.getAttribute('class').catch(() => null))?.includes('btn--bet') ? 'bet' : 'raise';
    if (hints.has(kind)) return;
    const ratio = await textContrast(raise.locator('kbd')).catch(() => null);
    if (ratio !== null) hints.set(kind, ratio);
  };
  try {
    await test.step('the Play page in English, by keyboard: the 1 against 1 tile, then "Play now"', async () => {
      await page.goto('/en/play');
      const solo = page.locator('input[name="play-mode"][value="solo"]');
      await solo.focus();
      await page.keyboard.press('Space');
      await expect(solo).toBeChecked();
      await expect(page.getByTestId('play-summary')).toHaveText('Paulista, 1 against 1: you against Zap.');
      await page.getByTestId('play-now').focus();
      await page.keyboard.press('Enter');
      await passHumanCheck(page);
      await expectTable(me);
      expect(me.lastRoom()!.room.settings.players).toBe(2);
    });

    const play = async (stop: () => boolean): Promise<boolean> => {
      const until = Date.now() + 240_000;
      while (Date.now() < until && !stop()) {
        const st = await waitForMove(page, 500);
        if (!st) continue;
        if (st.ended) return true;
        me.checkScreen(st);
        if (st.raise) await measureHint();
        const key = await chooseKey(page, st);
        if (!key) continue;
        const before = me.lastGame()?.seq ?? -1;
        await page.keyboard.press(key);
        used.set(key, (used.get(key) ?? 0) + 1);
        me.moves++;
        await me.waitForSeqAbove(before, 3_000);
      }
      return false;
    };

    await test.step('a few moves, then R opens the quick rules; Esc closes them and the focus comes back', async () => {
      await play(() => me.moves >= 3);
      await page.waitForFunction(() => document.querySelector('[data-testid="turn-indicator"]')?.getAttribute('data-mine') === 'true', null, { timeout: 30_000 });
      // The focus sits on a card of the hand (where the table puts it on your turn); mark it.
      await page.evaluate(() => {
        const card = [...document.querySelectorAll<HTMLElement>('[data-testid^="hand-card-"]')].find((b) => b.getAttribute('aria-disabled') !== 'true');
        card?.focus();
        if (card) card.dataset.zapBefore = '1';
      });
      await page.keyboard.press('r');
      const dialog = page.getByTestId('rules-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Quick rules');
      // While the dialog is open the table keys do nothing (a move sent by the clock is "auto").
      const moves = () => me.sent.filter((x) => x.data.includes('"t":"act"') && !x.data.includes('"auto":true')).length;
      const sentBefore = moves();
      await page.keyboard.press('1');
      await page.waitForTimeout(150);
      expect(moves(), 'a card key under the dialog sends nothing').toBe(sentBefore);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      // The focus is back on the card it left (unless the clock played that card meanwhile).
      const back = await page.evaluate(() => {
        const was = document.querySelector('[data-zap-before]');
        return !was || document.activeElement === was;
      });
      expect(back, 'the focus came back to the card').toBe(true);
      expect(me.sockets.length, 'the rules never touch the connection').toBe(1);
      expect(me.sockets[0].isClosed()).toBe(false);
    });

    await test.step('the match goes on to the end by keyboard, and the result heading takes the focus', async () => {
      const ended = await play(() => false);
      expect(ended).toBe(true);
      const room = me.lastRoom()!.room;
      expect(room.status).toBe('ended');
      const heading = page.getByTestId('match-result');
      await expect(heading).toHaveText(room.lastWinner === (me.seat & 1) ? 'You won!' : 'Zap won.');
      await expect(heading).toBeFocused();
      await expect(page.getByTestId('rematch-button')).toHaveText('Play again');
      console.log(`keys pressed: ${[...used].map(([k, n]) => `${k} ${n}`).join(', ')}`);
      console.log(`key hint contrast: ${[...hints].map(([k, r]) => `${k} ${r}`).join(', ')}`);
      expect(hints.has('bet'), 'the bet button showed up at least once').toBe(true);
      for (const [kind, ratio] of hints) expect(ratio, `the T hint on the ${kind} button`).toBeGreaterThanOrEqual(4.5);
      expect([...used.keys()].some((k) => ['1', '2', '3'].includes(k))).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __zapPointer: number }).__zapPointer), 'no pointer input').toBe(0);
      expect(auditRoom([me]).problems).toEqual([]);
    });
  } finally {
    await me.close();
  }
});
