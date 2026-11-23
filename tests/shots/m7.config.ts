// Screenshots of the two pages of milestone 7 (the data page and "You against Zap") for the
// owner's page _local/m7/paginas.html. Not part of the e2e gate. Runs in the Playwright container
// against the fast local site (the personal page plays a few matches first):
//
//   docker compose --profile e2e up -d dev-e2e
//   docker run --rm --network host --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
//     mcr.microsoft.com/playwright:v1.65.1-noble npx playwright test --config tests/shots/m7.config.ts
//
// Pictures go to _local/m7/shots/<name>.png.

import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { BASE_URL } from '../e2e/support/zap.ts';

const OUT = fileURLToPath(new URL('../../_local/m7/shots/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: 'm7-shots.spec.ts',
  outputDir: `${OUT}failures`,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 600_000,
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
