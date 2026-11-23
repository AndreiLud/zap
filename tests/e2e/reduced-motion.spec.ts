// Reduced motion (CLIENT-SPEC 14, 19.4): with prefers-reduced-motion set, a whole solo match on a
// phone never adds a flying card (no element with the class "flight"), and no animation longer than
// 300 ms runs, except the ones that carry the time left (the timer ring on an avatar, the bar above
// the hand and the bar of the TRUCO panel).

import { expect, test } from '@playwright/test';
import { PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo } from './support/zap.ts';

/** CSS animations that carry the clock and may run with reduced motion (pieces.css, table.css, truco.css). */
const CLOCK_ANIMATIONS = ['timer-ring', 'turn-bar', 'truco-time'];

test('with reduced motion nothing flies and nothing long moves during a whole match', async ({ browser }) => {
  test.setTimeout(300_000);
  const me = await Player.create(browser, 'Calm', { ...PHONE, reducedMotion: 'reduce' });
  const page = me.page;
  await page.addInitScript((allowed: string[]) => {
    const w = window as unknown as { __zapMotion: { flights: number; long: string[]; samples: number } };
    w.__zapMotion = { flights: 0, long: [], samples: 0 };
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.classList.contains('flight') || n.querySelector('.flight')) w.__zapMotion.flights++;
        }
      }
    }).observe(document, { subtree: true, childList: true });
    setInterval(() => {
      w.__zapMotion.samples++;
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running') continue;
        const timing = a.effect?.getComputedTiming();
        const total = Number(timing?.activeDuration ?? 0);
        if (!(total > 300)) continue;
        const name = (a as CSSAnimation).animationName ?? '';
        if (allowed.includes(name)) continue;
        const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
        const what = `${name || 'script animation'} ${Math.round(total)} ms on ${el ? `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` : '?'}`;
        if (w.__zapMotion.long.length < 20 && !w.__zapMotion.long.includes(what)) w.__zapMotion.long.push(what);
      }
    }, 50);
  }, CLOCK_ANIMATIONS);
  try {
    await page.goto('/jogar');
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await startSolo(page, 4);
    await passHumanCheck(page);
    await expectTable(me);
    const r = await playLoop(me, { policy: QUICK, timeoutMs: 240_000 });
    expect(r.ended).toBe(true);
    await expect(page.getByTestId('match-result')).toBeVisible();
    const motion = await page.evaluate(() => (window as unknown as { __zapMotion: { flights: number; long: string[]; samples: number } }).__zapMotion);
    console.log(`reduced motion: ${r.moves} moves, ${motion.samples} samples of the running animations`);
    expect(motion.samples).toBeGreaterThan(20);
    expect(motion.flights, 'flying elements added').toBe(0);
    expect(motion.long, 'animations longer than 300 ms').toEqual([]);
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});
