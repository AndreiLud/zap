// Ads off (CLIENT-SPEC 16.2, 19.4): a whole solo match on a phone, in Portuguese, from the start
// page to the result, makes requests only to the site itself and to Cloudflare's human check. No
// request goes to a Google domain, the ads code (loader and consent chunks) is never fetched, and
// /api/config says ads are off.

import { expect, test } from '@playwright/test';
import { BASE_URL, PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo } from './support/zap.ts';

const ALLOWED_HOSTS = new Set([new URL(BASE_URL).host, 'challenges.cloudflare.com']);
const GOOGLE = /(^|\.)(google|googlesyndication|googleadservices|googletagmanager|googleapis|gstatic|doubleclick|googlevideo|adtrafficquality)\.[a-z.]+$/;
/** The ads chunks of web/src/ads/ (loader.ts and AdsConsent.tsx). */
const ADS_CHUNK = /\/assets\/(loader|AdsConsent)-[\w-]+\.(js|css)$/;

test('a whole solo match talks only to the site and the human check', async ({ browser }) => {
  test.setTimeout(300_000);
  const me = await Player.create(browser, 'Phone', PHONE);
  const page = me.page;
  const urls: string[] = [];
  me.ctx.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('data:') && !u.startsWith('blob:')) urls.push(u);
  });
  try {
    await page.goto('/');
    await page.getByTestId('home-play').click();
    await expect(page).toHaveURL(/\/jogar$/);
    const config = await page.evaluate(async () => (await fetch('/api/config')).json() as Promise<Record<string, unknown>>);
    expect(config.ads, 'ads are off').toBeNull();
    await startSolo(page, 4);
    await passHumanCheck(page);
    await expectTable(me);
    const r = await playLoop(me, { policy: QUICK, timeoutMs: 240_000 });
    expect(r.ended).toBe(true);
    await expect(page.getByTestId('match-result')).toBeVisible();

    const hosts = [...new Set(urls.map((u) => new URL(u).host))];
    console.log(`hosts: ${hosts.join(', ')}; ${urls.length} requests`);
    expect(hosts.filter((h) => !ALLOWED_HOSTS.has(h)), 'hosts other than the site and the human check').toEqual([]);
    expect(urls.filter((u) => GOOGLE.test(new URL(u).hostname)), 'requests to Google').toEqual([]);
    expect(urls.filter((u) => ADS_CHUNK.test(new URL(u).pathname)), 'ads code fetched').toEqual([]);
    expect(await page.locator('script[src*="googlesyndication"], ins.adsbygoogle').count()).toBe(0);
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});
