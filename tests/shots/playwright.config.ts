// Before and after screenshots of the web client (milestone 8), for the owner's comparison page.
// Not part of the e2e gate. Runs in the Playwright container against the fast local site:
//
//   docker compose --profile e2e up -d dev-e2e
//   docker run --rm --network host --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
//     -e SHOTS_PHASE=before mcr.microsoft.com/playwright:v1.65.1-noble \
//     npx playwright test --config tests/shots/playwright.config.ts
//
// SHOTS_PHASE is "before" (the client as it was before milestone 8) or "after". Pictures go to
// _local/m8/shots/<phase>/<name>.png; _local/m8/compare.mjs pairs them.

import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { BASE_URL } from '../e2e/support/zap.ts';

const OUT = fileURLToPath(new URL('../../_local/m8/shots/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: 'shots.spec.ts',
  outputDir: `${OUT}failures`,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
});
