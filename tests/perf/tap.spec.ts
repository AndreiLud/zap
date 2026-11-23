// From a tap to the card leaving the hand (CLIENT-SPEC 18): on the phone profile with 4x CPU, in the
// guided hand and in a real solo match. Event Timing reports each click on a hand card that took
// 16 ms or more (8 ms granularity); every one must be at most 48 ms, and a tap with no entry was
// under 16 ms. The card must also carry data-leaving="true" in the first animation frame after the
// click. Each tap holds the press for 80 ms, as a finger does: the first press at a table starts the
// audio (WP3), which belongs to pointerdown, not to the click (DEVIATIONS WP3 item 11).

import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, PHONE, Player, act, choose, expectTable, guidedTap, passHumanCheck, QUICK, startSolo, waitForMove } from '../e2e/support/zap.ts';
import { throttle, writeResult } from './support.ts';

interface Tap {
  at: number;
  leavingInFrame: boolean | null;
  duration: number | null;
}

/** Records each click on a hand card (its event timestamp) and whether the card left within one frame. */
async function watchTaps(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __zapTaps: { at: number; leavingInFrame: boolean | null }[]; __zapEvents: { start: number; duration: number }[] };
    w.__zapTaps = [];
    w.__zapEvents = [];
    window.addEventListener(
      'click',
      (e) => {
        const card = (e.target as Element | null)?.closest?.('[data-testid^="hand-card-"]') as HTMLElement | null;
        if (!card || card.getAttribute('aria-disabled') === 'true') return;
        const tap = { at: e.timeStamp, leavingInFrame: null as boolean | null };
        w.__zapTaps.push(tap);
        requestAnimationFrame(() => (tap.leavingInFrame = card.dataset.leaving === 'true'));
      },
      true,
    );
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'click') w.__zapEvents.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  });
}

async function readTaps(page: Page): Promise<Tap[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __zapTaps: { at: number; leavingInFrame: boolean | null }[]; __zapEvents: { start: number; duration: number }[] };
    return w.__zapTaps.map((t) => ({ ...t, duration: w.__zapEvents.find((e) => Math.abs(e.start - t.at) < 1)?.duration ?? null }));
  });
}

/** A finger on a card: press, hold 80 ms, lift. */
async function press(page: Page, testid: string): Promise<boolean> {
  const box = await page.getByTestId(testid).boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  return true;
}

function summary(taps: Tap[]) {
  const measured = taps.map((t) => t.duration).filter((d): d is number => d !== null);
  return {
    taps: taps.length,
    withEntry: measured.length,
    under16: taps.length - measured.length,
    max: measured.length ? Math.max(...measured) : null,
    durations: measured,
    leavingInFrame: taps.filter((t) => t.leavingInFrame === true).length,
  };
}

test('tap to card leaving, phone with 4x CPU: the guided hand and a real solo match', async ({ browser }) => {
  test.setTimeout(300_000);
  const results: Record<string, ReturnType<typeof summary>> = {};

  await test.step('the guided hand', async () => {
    const ctx = await browser.newContext({ ...PHONE, baseURL: BASE_URL, locale: 'pt-BR' });
    const page = await ctx.newPage();
    await watchTaps(page);
    await page.goto('/jogar/guiada');
    await page.getByTestId('guided-start').waitFor();
    await throttle(page, { cpu: 4 });
    await page.getByTestId('guided-start').tap();
    const outro = page.getByTestId('guided-outro-play');
    const until = Date.now() + 120_000;
    while (!(await outro.isVisible()) && Date.now() < until) {
      const card = page.locator('[data-testid^="hand-card-"][data-suggest]:not([aria-disabled="true"])');
      if (await card.count()) {
        const id = (await card.first().getAttribute('data-testid'))!;
        await press(page, id);
        continue;
      }
      if (!(await guidedTap(page).catch(() => null))) await page.waitForTimeout(100);
    }
    results.guided = summary(await readTaps(page));
    await ctx.close();
  });

  await test.step('a real solo match', async () => {
    const me = await Player.create(browser, 'Tapper', PHONE);
    const page = me.page;
    try {
      await watchTaps(page);
      await page.goto('/jogar');
      await startSolo(page, 2);
      await passHumanCheck(page);
      await expectTable(me);
      await throttle(page, { cpu: 4 });
      let cards = 0;
      const until = Date.now() + 180_000;
      while (Date.now() < until && cards < 20) {
        const st = await waitForMove(page, 500);
        if (!st) continue;
        if (st.ended) break;
        const choice = choose(st, { ...QUICK, raise: 0.1 });
        if (choice.startsWith('hand-card-')) {
          const before = me.lastGame()?.seq ?? -1;
          if (await press(page, choice)) cards++;
          await me.waitForSeqAbove(before, 3_000);
        } else {
          await act(me, choice);
        }
      }
      results.solo = summary(await readTaps(page));
    } finally {
      await me.close();
    }
  });

  console.log(JSON.stringify(results));
  writeResult('tap', { profile: { device: 'Pixel 7, 390 by 844', cpu: 4, hold: 80 }, ...results });
  for (const [name, r] of Object.entries(results)) {
    expect(r.taps, `${name}: taps measured`).toBeGreaterThan(2);
    expect(r.max ?? 0, `${name}: slowest tap`).toBeLessThanOrEqual(48);
    expect(r.leavingInFrame, `${name}: cards that left within one frame`).toBe(r.taps);
  }
});
