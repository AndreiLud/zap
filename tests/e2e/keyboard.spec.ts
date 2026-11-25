// Keyboard play on the desktop, in English (CLIENT-SPEC 12, 19.4): a solo 1 against 1 match played
// to the end with the keys only (1, 2 and 3 for the cards, T to raise, A to accept, C to run), never
// the mouse; the quick rules open with R in the middle of the match without touching the room's
// connection and give the focus back; the match ends with the focus on the result heading, and Tab
// walks the result in the order of M15 spec 5.4. The random switch of the Play page and of the end
// screen toggles with Space and keeps the focus. In a room with friends, the owner arranges the table
// by keyboard: Tab walks the seat selects, the arrow keys change one, and the focus stays (M15 6.4),
// also when the owner changes team and the two team groups swap, with and without moveBefore (M17).

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, auditRoom, createRoom, expectSeat, expectTable, expectTeams, newPlayers, passHumanCheck, textContrast, waitForMove, type TableState } from './support/zap.ts';

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
      // The random switch (M15) toggles with Space and keeps the focus; turned off again, Zap stays.
      const random = page.getByTestId('random-opponents');
      await expect(page.getByTestId('random-partner')).toHaveCount(0);
      await random.focus();
      await page.keyboard.press('Space');
      await expect(random).toBeChecked();
      await expect(random).toBeFocused();
      await expect(page.getByTestId('play-summary')).toHaveText('Paulista, 1 against 1: you against a random opponent.');
      await page.keyboard.press('Space');
      await expect(random).not.toBeChecked();
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
      // Tab from the heading: "Play again", the switch for the next match (1 against 1: the opponent
      // only), "Pick another table", "You against Zap" (M15 spec 5.4). Space toggles the switch.
      for (const id of ['rematch-button', 'rematch-random-opponents', 'home-button', 'link-vs']) {
        await page.keyboard.press('Tab');
        await expect(page.getByTestId(id)).toBeFocused();
      }
      await expect(page.getByTestId('rematch-random-partner')).toHaveCount(0);
      await page.getByTestId('rematch-random-opponents').focus();
      await page.keyboard.press('Space');
      await expect(page.getByTestId('rematch-random-opponents')).toBeChecked();
      await expect(page.getByTestId('rematch-random-opponents')).toBeFocused();
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

test('the owner arranges the table by keyboard: Tab walks the seats, the arrows change one, the focus stays', async ({ browser }) => {
  test.setTimeout(120_000);
  const [ana] = await newPlayers(browser, [['Ana', DESKTOP]]);
  const page = ana.page;
  /** From the last link of the invite, Tab walks the seat selects in page order, then the start. */
  const tabOrder = async (ids: string[]) => {
    await page.getByTestId('whatsapp-invite').focus();
    for (const id of [...ids, 'start-button']) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(id)).toBeFocused();
    }
  };
  try {
    await createRoom(ana, { players: 4, turn: '30' });
    // The seats come by team (M17): Nós (seats 1 and 3) then Eles (seats 2 and 4), so Tab reads
    // Ana's team first.
    await expectTeams(page, [0, 2], [1, 3]);
    await tabOrder(['arrange-0', 'arrange-2', 'arrange-1', 'arrange-3']);
    // Seat 3 is free with Lia planned: Down reserves Otávio in Lia's place, Up frees the seat again,
    // which keeps Otávio as its plan; the select keeps the focus through both answers of the room.
    const select = page.getByTestId('arrange-2');
    await select.focus();
    await expect(select).toHaveValue('open');
    await page.keyboard.press('ArrowDown');
    await expect(select).toHaveValue('ai:otavio');
    await expectSeat(page, 2, { kind: 'ai' });
    await expect(page.getByTestId('seat-2')).toContainText('Otávio');
    await expect(select).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(select).toHaveValue('open');
    await expectSeat(page, 2, { kind: 'empty' });
    await expect(page.getByTestId('seat-2')).toContainText('se ficar vazia, joga o Otávio');
    await expect(select).toBeFocused();
    // The owner's own seat takes only people: the arrows find nothing else to choose.
    const own = page.getByTestId('arrange-0');
    await own.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(own).toHaveValue('seat:0');
    await expect(own).toBeFocused();
    expect(ana.sent.filter((x) => x.data.includes('"t":"plan"')).map((x) => x.data)).toEqual(['{"t":"plan","seat":2,"ai":"otavio"}', '{"t":"plan","seat":2,"ai":null}']);
    expect(ana.sent.some((x) => x.data.includes('"t":"move"'))).toBe(false);
    // Ana sits herself on seat 2 from its select ("Você, na cadeira 1" is just above "Livre"): she
    // changes team, the two groups swap places (Nós is now seats 2 and 4) and the select she used
    // keeps the focus.
    const other = page.getByTestId('arrange-1');
    await other.focus();
    await expect(other).toHaveValue('open');
    await page.keyboard.press('ArrowUp');
    await expectSeat(page, 1, { kind: 'human', connected: true });
    await expectTeams(page, [1, 3], [0, 2]);
    await expect(other).toHaveValue('seat:1');
    await expect(other).toBeFocused();
    await expect(page.getByTestId('lobby-said')).toContainText('Cadeira 2: Você.');
    expect(ana.sent.filter((x) => x.data.includes('"t":"move"')).map((x) => x.data)).toEqual(['{"t":"move","from":0,"to":1}']);
    await tabOrder(['arrange-1', 'arrange-3', 'arrange-0', 'arrange-2']);
  } finally {
    await ana.close();
  }
});

test('without moveBefore (Safari, iOS) the select the owner used keeps the focus when the groups swap', async ({ browser }) => {
  test.setTimeout(120_000);
  const [ana] = await newPlayers(browser, [['Ana', DESKTOP]]);
  const page = ana.page;
  try {
    // A browser without moveBefore: Preact moves the swapped team group with insertBefore, which
    // drops the focus, and the Lobby gives it back to the control that had it (pages/Lobby.tsx).
    await page.addInitScript(() => {
      for (const proto of [Element.prototype, DocumentFragment.prototype, Document.prototype]) delete (proto as unknown as { moveBefore?: unknown }).moveBefore;
    });
    await createRoom(ana, { players: 4, turn: '30' });
    expect(await page.evaluate(() => 'moveBefore' in document.body), 'moveBefore is gone').toBe(false);
    await expectTeams(page, [0, 2], [1, 3]);
    // Ana sits herself on seat 2 from its select, by keyboard: she changes team and the groups swap.
    const other = page.getByTestId('arrange-1');
    await other.focus();
    await expect(other).toHaveValue('open');
    await page.keyboard.press('ArrowUp');
    await expectSeat(page, 1, { kind: 'human', connected: true });
    await expectTeams(page, [1, 3], [0, 2]);
    await expect(other).toHaveValue('seat:1');
    await expect(other).toBeFocused();
    await expect(page.getByTestId('lobby-said')).toContainText('Cadeira 2: Você.');
    // And back to seat 1: the groups swap again, the focus stays on the select she used.
    const own = page.getByTestId('arrange-0');
    await own.focus();
    await expect(own).toHaveValue('open');
    await page.keyboard.press('ArrowUp');
    await expectTeams(page, [0, 2], [1, 3]);
    await expect(own).toHaveValue('seat:0');
    await expect(own).toBeFocused();
    expect(ana.sent.filter((x) => x.data.includes('"t":"move"')).map((x) => x.data)).toEqual(['{"t":"move","from":0,"to":1}', '{"t":"move","from":1,"to":0}']);
  } finally {
    await ana.close();
  }
});
