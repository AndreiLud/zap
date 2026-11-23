// Shared pieces of the performance specs: the throttling profiles of CLIENT-SPEC 18, a solo room
// made once in a setup context, and the file each spec writes its numbers to.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContextOptions, CDPSession, Page } from '@playwright/test';
import { Player, expectTable, passHumanCheck, startSolo } from '../e2e/support/zap.ts';

export const OUT_DIR = fileURLToPath(new URL('../../_local/m8/perf/', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

/** "slow 4G" of spec 18: 150 ms latency, 1.6 Mbit/s down, 768 kbit/s up. */
export const SLOW_4G = { offline: false, latency: 150, downloadThroughput: 204_800, uploadThroughput: 96_000 } as const;

/** Applies the network profile and the CPU slowdown to a page (Chromium DevTools Protocol). */
export async function throttle(page: Page, o: { network?: typeof SLOW_4G; cpu?: number }): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  if (o.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', o.network);
  }
  if (o.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: o.cpu });
  return cdp;
}

/** A solo room made from the Play page by a fresh device; returns the code and the device's saved state. */
export async function soloRoom(browser: Browser, options: BrowserContextOptions, players: 2 | 4 = 4): Promise<{ code: string; state: Awaited<ReturnType<Player['ctx']['storageState']>> }> {
  const p = await Player.create(browser, 'Setup', options);
  try {
    await p.page.goto('/jogar');
    await startSolo(p.page, players);
    await passHumanCheck(p.page);
    await expectTable(p);
    const code = new URL(p.page.url()).searchParams.get('sala')!;
    const state = await p.ctx.storageState();
    return { code, state };
  } finally {
    await p.close();
  }
}

export function writeResult(name: string, data: unknown): void {
  writeFileSync(`${OUT_DIR}${name}.json`, `${JSON.stringify({ measuredAt: new Date().toISOString(), ...(data as object) }, null, 2)}\n`);
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
