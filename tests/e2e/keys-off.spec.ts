// Single key shortcuts (CLIENT-SPEC 12, WCAG 2.1.4): the table keys act only with focus on the page
// or in the table's game area, never from a footer link, and the switch "Single key shortcuts" in
// the side panel turns them off (the R of the quick rules too), saved in this browser. The turn's
// focus never pulls focus back from a footer link the person reached first (M15 spec 7). A room with
// no time limit, so no clock plays for the person while the test presses keys.

import { expect, test } from '@playwright/test';
import { CALM, DESKTOP, PHONE, act, choose, createRoom, expectSeat, expectTable, joinByCode, newPlayers, waitForMove } from './support/zap.ts';

test('the table keys act only from the game, and the switch turns them off', async ({ browser }) => {
  test.setTimeout(180_000);
  const [ana, beto] = await newPlayers(browser, [
    ['Ana', DESKTOP],
    ['Beto', PHONE],
  ]);
  const page = ana.page;
  const acts = () => ana.sent.filter((x) => x.data.includes('"t":"act"')).length;
  const firstCard = () => page.locator('[data-testid^="hand-card-"]:not([aria-disabled="true"])').first();
  try {
    await test.step('Ana opens a 1 against 1 room with no time limit, Beto joins, Ana starts', async () => {
      const code = await createRoom(ana, { players: 2, turn: 'none' });
      await joinByCode(beto, code);
      await expectSeat(page, 1, { kind: 'human', connected: true });
      await page.getByTestId('start-button').click();
      await expectTable(ana);
      await expectTable(beto);
    });

    await test.step('wait for Ana to play a card (Beto plays when it is his turn)', async () => {
      const until = Date.now() + 60_000;
      for (;;) {
        expect(Date.now() < until, 'Ana gets a turn with cards').toBe(true);
        const st = await waitForMove(page, 300);
        if (st && st.cards.length && !st.accept && !st.run) break;
        const other = await waitForMove(beto.page, 300);
        if (other && !other.ended) await act(beto, choose(other, CALM));
      }
    });

    await test.step('from a footer link, 1 plays nothing', async () => {
      await page.getByTestId('footer-privacy').focus();
      const before = acts();
      await page.keyboard.press('1');
      await page.waitForTimeout(400);
      expect(acts(), 'a card key from the footer sends nothing').toBe(before);
    });

    // The flaky case made certain (M15 spec 7): the hand's turn effect queues the card's focus for
    // the next frame; if the person reaches the footer before that frame, the focus must stay there.
    // Ana's frames are held from Beto's card until she is on the footer link, then run at once.
    await test.step('the turn never pulls focus back from a footer link reached before its frame', async () => {
      const hold = () => {
        const w = window as unknown as { __zapHeld: Map<number, FrameRequestCallback>; __zapRaf: typeof requestAnimationFrame; __zapCaf: typeof cancelAnimationFrame };
        w.__zapHeld = new Map();
        w.__zapRaf = window.requestAnimationFrame;
        w.__zapCaf = window.cancelAnimationFrame;
        let n = 1e9;
        window.requestAnimationFrame = (cb) => {
          w.__zapHeld.set(++n, cb);
          return n;
        };
        window.cancelAnimationFrame = (id) => {
          if (!w.__zapHeld.delete(id)) w.__zapCaf.call(window, id);
        };
        (document.activeElement as HTMLElement | null)?.blur();
      };
      const release = () => {
        const w = window as unknown as { __zapHeld: Map<number, FrameRequestCallback>; __zapRaf: typeof requestAnimationFrame; __zapCaf: typeof cancelAnimationFrame };
        window.requestAnimationFrame = w.__zapRaf;
        window.cancelAnimationFrame = w.__zapCaf;
        const held = [...w.__zapHeld.values()];
        w.__zapHeld.clear();
        for (const cb of held) cb(performance.now());
        return document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null;
      };
      const anaOnTurn = () =>
        page
          .waitForFunction(
            () =>
              document.querySelector('[data-testid="turn-indicator"]')?.getAttribute('data-mine') === 'true' &&
              [...document.querySelectorAll('[data-testid^="hand-card-"]')].some((b) => b.getAttribute('aria-disabled') !== 'true'),
            null,
            // Polling by time: the page's own frames are held.
            { polling: 30, timeout: 3_000 },
          )
          .then(
            () => true,
            () => false,
          );
      const until = Date.now() + 90_000;
      for (;;) {
        expect(Date.now() < until, 'Ana gets her turn right after a card of Beto').toBe(true);
        const mine = await waitForMove(page, 300);
        if (mine && !mine.ended) {
          await act(ana, mine.cards.length && !mine.accept && !mine.run ? `hand-card-${mine.cards[0]}` : choose(mine, CALM));
          continue;
        }
        const other = await waitForMove(beto.page, 300);
        if (!other || other.ended) continue;
        if (!other.cards.length || other.accept || other.run) {
          await act(beto, choose(other, CALM));
          continue;
        }
        await page.evaluate(hold);
        await act(beto, `hand-card-${other.cards[0]}`);
        if (!(await anaOnTurn())) {
          // Beto leads again or a new hand starts: let Ana's page draw and try with the next card.
          await page.evaluate(release);
          continue;
        }
        // Preact runs the turn's effect after its 35 ms fallback (frames are held); give it time to queue the focus.
        await page.waitForTimeout(250);
        await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="footer-privacy"]')!.focus());
        expect(await page.evaluate(release), 'the footer link keeps the focus once the queued frames run').toBe('footer-privacy');
        const before = acts();
        await page.keyboard.press('1');
        await page.waitForTimeout(400);
        expect(acts(), 'a card key from the footer sends nothing').toBe(before);
        break;
      }
    });

    await test.step('with the switch off, 1 and R do nothing even from a card', async () => {
      const sw = page.getByTestId('keys-switch-panel');
      await expect(sw).toBeChecked();
      await sw.uncheck();
      expect(await page.evaluate(() => localStorage.getItem('zap-keys'))).toBe('0');
      await expect(page.locator('.side-panel .keys')).toBeHidden();
      await firstCard().focus();
      const before = acts();
      await page.keyboard.press('1');
      await page.keyboard.press('r');
      await page.waitForTimeout(400);
      expect(acts(), 'a card key with the shortcuts off sends nothing').toBe(before);
      await expect(page.getByTestId('rules-dialog')).toBeHidden();
    });

    await test.step('switched on again, 1 plays from the game area', async () => {
      await page.getByTestId('keys-switch-panel').check();
      expect(await page.evaluate(() => localStorage.getItem('zap-keys'))).toBe('1');
      await firstCard().focus();
      const before = acts();
      await page.keyboard.press('1');
      await expect.poll(acts, { timeout: 3_000 }).toBe(before + 1);
    });
    expect(ana.errors).toEqual([]);
    expect(beto.errors).toEqual([]);
  } finally {
    await ana.close();
    await beto.close();
  }
});
