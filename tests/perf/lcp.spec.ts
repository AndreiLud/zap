// LCP of the table on a phone (CLIENT-SPEC 18): a solo match made in a setup context; then five
// cold contexts with that device's saved state (phone profile, slow 4G, 4x CPU, empty cache) open
// /?sala=CODE, and the last largest-contentful-paint entry is read 6 s after the start of the
// navigation. The median of the five must be at most 2,500 ms.

import { expect, test } from '@playwright/test';
import { BASE_URL, PHONE } from '../e2e/support/zap.ts';
import { SLOW_4G, median, soloRoom, throttle, writeResult } from './support.ts';

const RUNS = 5;

test('LCP of the table on a throttled phone', async ({ browser }) => {
  const { code, state } = await soloRoom(browser, PHONE);
  const runs: { lcp: number; element: string; size: number; fcp: number | null; tableDrawn: number | null }[] = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ ...PHONE, baseURL: BASE_URL, storageState: state, locale: 'pt-BR' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { __zapLcp: { at: number; element: string; size: number } | null; __zapTableAt: number | null };
      w.__zapLcp = null;
      // For context: when the real table (its score band) is first in the page. LCP counts text and
      // images, not the SVG cards, so the largest paint can be the opening screen's heading.
      w.__zapTableAt = null;
      new MutationObserver((_, obs) => {
        if (document.querySelector('[data-testid="score"]')) {
          requestAnimationFrame(() => (w.__zapTableAt ??= performance.now()));
          obs.disconnect();
        }
      }).observe(document, { subtree: true, childList: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { element?: Element | null; size: number })[]) {
          const el = e.element;
          w.__zapLcp = { at: e.startTime, size: e.size, element: el ? `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` : '(gone)' };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const cdp = await throttle(page, { network: SLOW_4G, cpu: 4 });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.goto(`/?sala=${code}`, { waitUntil: 'commit' });
    await page.waitForTimeout(6_000);
    const r = await page.evaluate(() => ({
      lcp: (window as unknown as { __zapLcp: { at: number; element: string; size: number } | null }).__zapLcp,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      table: (window as unknown as { __zapTableAt: number | null }).__zapTableAt,
    }));
    await ctx.close();
    expect(r.lcp, `run ${i + 1}: an LCP entry`).not.toBeNull();
    runs.push({ lcp: Math.round(r.lcp!.at), element: r.lcp!.element, size: r.lcp!.size, fcp: r.fcp === null ? null : Math.round(r.fcp), tableDrawn: r.table === null ? null : Math.round(r.table) });
    console.log(`run ${i + 1}: LCP ${Math.round(r.lcp!.at)} ms on ${r.lcp!.element} (FCP ${r.fcp === null ? '?' : Math.round(r.fcp)} ms, table drawn at ${r.table === null ? '?' : Math.round(r.table)} ms)`);
  }
  const m = median(runs.map((r) => r.lcp));
  console.log(`median LCP ${m} ms`);
  const drawn = runs.map((r) => r.tableDrawn).filter((x): x is number => x !== null);
  writeResult('lcp', { profile: { device: 'Pixel 7, 390 by 844', network: SLOW_4G, cpu: 4 }, runs, median: m, tableDrawnMedian: drawn.length ? median(drawn) : null, budget: 2500 });
  expect(m).toBeLessThanOrEqual(2_500);
});
