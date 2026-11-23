// End-to-end tests of the whole site: real Chromium pages against the fast local site
// (docker compose --profile e2e up -d dev-e2e, every waiting time 20 times shorter).
//
// Run from the project root:
//   docker run --rm --network host --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
//     mcr.microsoft.com/playwright:v1.65.1-noble npx playwright test --config tests/e2e/playwright.config.ts
//
// Screenshots taken by the tests, and traces and screenshots of failures, go to _local/e2e-shots/.

import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { BASE_URL, DESKTOP, PHONE } from './support/zap.ts';

const SHOTS = fileURLToPath(new URL('../../_local/e2e-shots/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: `${SHOTS}failures`,
  // The rooms run on short real clocks (a 15 s move lasts 0.75 s): one test at a time keeps the
  // machine free enough for the pages to answer within their turn.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    // Rooms with several devices: each test opens its own mix of phone and desktop contexts.
    { name: 'desktop', testIgnore: /solo-phone\.spec\.ts/, use: DESKTOP },
    { name: 'phone', testMatch: /solo-phone\.spec\.ts/, use: PHONE },
  ],
});
