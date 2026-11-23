// Performance measurements of the web client (CLIENT-SPEC 18): bytes of the table path, LCP of the
// table on a throttled phone, the time from a tap to the card leaving the hand, and the frame rate of
// the table's animations. Not part of the e2e gate: the integration runs them once, on a quiet
// machine, and copies the numbers into _local/m8/performance.md. Each spec also writes what it
// measured to _local/m8/perf/<name>.json.
//
//   docker compose --profile e2e up -d dev-e2e
//   docker run --rm --network host --user 1000:1000 -v $PWD:/app -w /app -e HOME=/app/.cache/home \
//     mcr.microsoft.com/playwright:v1.65.1-noble npx playwright test --config tests/perf/playwright.config.ts

import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { BASE_URL } from '../e2e/support/zap.ts';

const OUT = fileURLToPath(new URL('../../_local/m8/perf/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
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
    navigationTimeout: 60_000,
  },
});
