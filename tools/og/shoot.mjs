// Saves the 20 Open Graph images (CLIENT-SPEC 21.1, WP6): web/public/og/<route>-<pt|en>.png, 1200
// by 630, at most 150,000 bytes each. Run in the Playwright image with no network, after building
// the pages (web/og) into .cache/og-build:
//
//   docker compose run --rm -T node npx vite build --config web/og/vite.config.ts
//   docker run --rm --network none --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
//     mcr.microsoft.com/playwright:v1.65.1-noble node tools/og/shoot.mjs [route ...]
//
// With route names (for example "data"), only those routes' two images are saved again.
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serve } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILD = join(ROOT, '.cache', 'og-build');
const OUT = join(ROOT, 'web', 'public', 'og');
const ALL_ROUTES = ['start', 'play', 'guided', 'rules', 'data', 'you', 'privacy', 'terms', 'verify', 'room'];
const asked = process.argv.slice(2);
const unknown = asked.filter((r) => !ALL_ROUTES.includes(r));
if (unknown.length) {
  console.error(`unknown route: ${unknown.join(', ')} (routes: ${ALL_ROUTES.join(', ')})`);
  process.exit(2);
}
const ROUTES = asked.length ? asked : ALL_ROUTES;
const MAX_BYTES = 150_000;

mkdirSync(OUT, { recursive: true });
const { server, base } = await serve(BUILD);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
const failures = [];
try {
  for (const route of ROUTES) {
    for (const lang of ['pt', 'en']) {
      const page = await context.newPage();
      page.on('pageerror', (e) => failures.push(`${route}-${lang}: ${e.message}`));
      page.on('requestfailed', (r) => failures.push(`${route}-${lang}: request failed ${r.url()}`));
      await page.goto(`${base}index.html?route=${route}&lang=${lang}`);
      await page.waitForSelector('#og[data-ready="true"]', { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      const file = join(OUT, `${route}-${lang}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1200, height: 630 } });
      const size = statSync(file).size;
      console.log(`${route}-${lang}.png ${size} bytes`);
      if (size > MAX_BYTES) failures.push(`${route}-${lang}.png is ${size} bytes, over ${MAX_BYTES}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
