// Frame rate of the table's animations (CLIENT-SPEC 18): the guided demo (/jogar/guiada?demo=1:
// deal, plays, gathers, the TRUCO panel, the count and the deck going back) runs by itself while the
// page records every requestAnimationFrame time. motion.ts marks each run of animations with
// performance marks zap:anim:start and zap:anim:end; only frames inside those spans count. Desktop
// (1280 by 800, no throttle): mean at least 58 fps and no frame over 50 ms. Phone with 4x CPU: mean
// at least 50 fps.

import { expect, test, type BrowserContextOptions } from '@playwright/test';
import { BASE_URL, DESKTOP, PHONE } from '../e2e/support/zap.ts';
import { throttle, writeResult } from './support.ts';

interface Fps {
  spans: number;
  frames: number;
  ms: number;
  mean: number;
  worst: number;
  over50: number;
}

async function measure(browser: import('@playwright/test').Browser, options: BrowserContextOptions, cpu: number): Promise<Fps> {
  const ctx = await browser.newContext({ ...options, baseURL: BASE_URL, locale: 'pt-BR' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __zapFrames: number[] };
    w.__zapFrames = [];
    const tick = (t: number) => {
      w.__zapFrames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (cpu > 1) await throttle(page, { cpu });
  await page.goto('/jogar/guiada?demo=1');
  await page.waitForFunction(() => (window as unknown as { __zapDemoDone?: boolean }).__zapDemoDone === true, null, { timeout: 120_000, polling: 500 });
  const r = await page.evaluate(() => {
    const frames = (window as unknown as { __zapFrames: number[] }).__zapFrames;
    const starts = performance.getEntriesByName('zap:anim:start').map((e) => e.startTime);
    const ends = performance.getEntriesByName('zap:anim:end').map((e) => e.startTime);
    const spans: [number, number][] = [];
    for (const s of starts) {
      const e = ends.find((x) => x >= s);
      if (e !== undefined) spans.push([s, e]);
    }
    let count = 0;
    let ms = 0;
    let worst = 0;
    let over50 = 0;
    for (const [s, e] of spans) {
      const inside = frames.filter((f) => f >= s && f <= e);
      for (let i = 1; i < inside.length; i++) {
        const d = inside[i] - inside[i - 1];
        count++;
        ms += d;
        worst = Math.max(worst, d);
        if (d > 50) over50++;
      }
    }
    return { spans: spans.length, frames: count, ms, worst, over50 };
  });
  await ctx.close();
  return { ...r, ms: Math.round(r.ms), worst: Math.round(r.worst * 10) / 10, mean: r.ms > 0 ? Math.round((r.frames / r.ms) * 10_000) / 10 : 0 };
}

test('animations: 60 fps on the desktop, at least 50 with 4x CPU on a phone', async ({ browser }) => {
  test.setTimeout(300_000);
  const desktop = await measure(browser, DESKTOP, 1);
  const phone = await measure(browser, PHONE, 4);
  console.log(`desktop ${JSON.stringify(desktop)}; phone 4x ${JSON.stringify(phone)}`);
  writeResult('fps', { desktop: { profile: '1280 by 800, no throttle', ...desktop }, phone4x: { profile: 'Pixel 7, 390 by 844, 4x CPU', ...phone } });
  expect(desktop.spans).toBeGreaterThan(5);
  expect(desktop.mean).toBeGreaterThanOrEqual(58);
  expect(desktop.over50).toBe(0);
  expect(phone.mean).toBeGreaterThanOrEqual(50);
});
