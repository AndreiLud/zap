// Saves the project cover, project_docs/media/cover.png: the page web/cover at 1440 by 900 CSS px and
// device scale 2 (2880 by 1800), for the portfolio card and the repository's social preview. Run in
// the Playwright image with no network, after building the page into .cache/cover-build:
//
//   docker compose run --rm -T node npx vite build --config web/cover/vite.config.ts
//   docker run --rm --network none --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
//     mcr.microsoft.com/playwright:v1.65.1-noble node tools/media/cover.mjs
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serve } from '../og/serve.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILD = join(ROOT, '.cache', 'cover-build');
const OUT = join(ROOT, 'project_docs', 'media', 'cover.png');

const { server, base } = await serve(BUILD);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
const failures = [];
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => failures.push(`request failed ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`${base}index.html`);
  await page.waitForSelector('#cover[data-ready="true"]', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1440, height: 900 } });
  console.log(`saved ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
