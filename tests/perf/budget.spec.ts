// The bytes a phone downloads to open a table (CLIENT-SPEC 18): (a) from the build, the gzip -9
// sizes of the entry chunk, the table chunk and their static imports (web/scripts/budget.ts, the
// same check that fails the build); (b) from a real cold load of /?sala=CODE on the phone profile,
// the encoded body sizes of the site's own script and stylesheet responses (brotli on the local
// site, as in production).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { BUDGET, measure, type Manifest } from '../../web/scripts/budget.ts';
import { BASE_URL, PHONE } from '../e2e/support/zap.ts';
import { soloRoom, writeResult } from './support.ts';

const DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

test('the table path stays inside the JavaScript and CSS budgets', async ({ browser }) => {
  const manifest = JSON.parse(readFileSync(`${DIST}.vite/manifest.json`, 'utf8')) as Manifest;
  const build = measure(DIST, manifest);

  const { code, state } = await soloRoom(browser, PHONE);
  const ctx = await browser.newContext({ ...PHONE, baseURL: BASE_URL, storageState: state, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const origin = new URL(BASE_URL).origin;
  const seen: Promise<{ url: string; type: string; bytes: number; encoding: string }>[] = [];
  page.on('requestfinished', (r) => {
    const type = r.resourceType();
    if (!r.url().startsWith(origin) || (type !== 'script' && type !== 'stylesheet')) return;
    seen.push(
      (async () => {
        const res = await r.response();
        return { url: new URL(r.url()).pathname, type, bytes: (await r.sizes()).responseBodySize, encoding: (await res?.headerValue('content-encoding')) ?? '' };
      })(),
    );
  });
  await page.goto(`/?sala=${code}`);
  await expect(page.getByTestId('turn-indicator').or(page.getByTestId('match-result'))).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  const files = await Promise.all(seen);
  await ctx.close();
  const sum = (t: string) => files.filter((f) => f.type === t).reduce((a, f) => a + f.bytes, 0);
  const run = { js: sum('script'), css: sum('stylesheet'), files };
  console.log(`build gzip -9: JS ${build.js.gzip}, CSS ${build.css.gzip}; cold load encoded: JS ${run.js}, CSS ${run.css}`);
  writeResult('budget', { budget: BUDGET, build: { js: build.js, css: build.css }, run });
  expect(build.js.gzip).toBeLessThanOrEqual(BUDGET.js);
  expect(build.css.gzip).toBeLessThanOrEqual(BUDGET.css);
  expect(run.js).toBeLessThanOrEqual(BUDGET.js);
  expect(run.css).toBeLessThanOrEqual(BUDGET.css);
});
