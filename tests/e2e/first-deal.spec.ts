// The opening of a quick match (CLIENT-SPEC 11.3, 11.6, 13): the room deals before the page connects,
// and the page still shows the table before the deal, the deal itself and the AI's opening cards
// flying in. The first game message starts with the deal, the hand log and the screen reader say
// the new hand, and the clock never shows more than the turn's seconds.

import { expect, test } from '@playwright/test';
import { DESKTOP, Player, expectTable, passHumanCheck, startSolo, texts } from './support/zap.ts';

const pt = texts('pt');

interface Opening {
  flights: number;
  maxClock: number;
  said: string[];
  firstLog: string | null;
}

for (const players of [2, 4] as const) {
  test(`${players} players: the first hand of a quick match is dealt on screen`, async ({ browser }) => {
    test.setTimeout(120_000);
    const me = await Player.create(browser, `Abertura${players}`, DESKTOP);
    const page = me.page;
    await page.addInitScript(() => {
      const w = window as unknown as { __zapOpen: Opening };
      w.__zapOpen = { flights: 0, maxClock: 0, said: [], firstLog: null };
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (!(n instanceof Element)) continue;
            if (n.classList.contains('flight') || n.querySelector('.flight')) w.__zapOpen.flights++;
            if (n.parentElement?.matches('[data-testid="announcer"]')) w.__zapOpen.said.push(n.textContent ?? '');
          }
        }
        const clock = document.querySelector('[data-testid="deadline"]');
        const secs = clock ? Number(clock.textContent) : 0;
        if (secs > w.__zapOpen.maxClock) w.__zapOpen.maxClock = secs;
        const log = document.querySelector('[data-testid="hand-log"] li:not(.hand-log__empty)');
        if (log && w.__zapOpen.firstLog === null) w.__zapOpen.firstLog = log.textContent ?? '';
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    try {
      await page.goto('/jogar');
      await startSolo(page, players);
      await passHumanCheck(page);
      await expectTable(me);
      // The server: the first game message of the match starts with the deal of the first hand.
      await expect.poll(() => me.gameMsgs().find((g) => g.events.length > 0)?.events[0]?.e.t ?? null).toBe('deal');
      // The page: cards fly (the deal, then the AI's opening cards), the hand log starts with the new
      // hand and the screen reader hears it.
      const opening = () => page.evaluate(() => (window as unknown as { __zapOpen: Opening }).__zapOpen);
      const newHand = pt['ev.deal'].replace(/\.$/, '');
      await expect.poll(async () => (await opening()).flights, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await opening()).firstLog ?? '', { timeout: 10_000 }).toContain(newHand);
      await expect.poll(async () => (await opening()).said.join(' | '), { timeout: 10_000 }).toContain(newHand);
      const turn = me.lastRoom()?.room.settings.turnSeconds ?? null;
      if (typeof turn === 'number') expect((await opening()).maxClock, 'the clock never shows more than the turn').toBeLessThanOrEqual(turn);
      expect(me.errors).toEqual([]);
    } finally {
      await me.close();
    }
  });
}
