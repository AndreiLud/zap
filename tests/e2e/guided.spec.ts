// The guided first match on a phone (CLIENT-SPEC 10.5, 19.4): one practice hand on the real engine
// in the browser, played by taps from the intro card to the outro, with the coach's "Continuar" and
// the suggested cards. Nothing reaches the server while it runs: no request to /api/ and no socket.
// The scenes for screenshots (?cena=antes, meio, truco, fim) open at their moment.

import { expect, test, type Page } from '@playwright/test';
import { PHONE, Player, guidedTap } from './support/zap.ts';

/** Every request this page makes to the API, as "METHOD /path", and every socket it opens. */
function recordServer(page: Page): { api: string[]; sockets: string[] } {
  const out = { api: [] as string[], sockets: [] as string[] };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) out.api.push(`${r.method()} ${u.pathname}`);
  });
  page.on('websocket', (ws) => out.sockets.push(ws.url()));
  return out;
}

test('the guided hand by taps, from the intro to the outro, with nothing sent to the server', async ({ browser }) => {
  test.setTimeout(120_000);
  const me = await Player.create(browser, 'Learner', PHONE);
  const page = me.page;
  try {
    await page.goto('/jogar/guiada');
    await expect(page.getByTestId('page-guided')).toBeVisible();
    await expect(page.getByTestId('guided-start')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('guided-skip')).toHaveAttribute('href', '/jogar');
    // From here on, the practice hand: nothing may reach the server.
    const server = recordServer(page);
    await page.getByTestId('guided-start').tap();
    const taps: string[] = [];
    const outro = page.getByTestId('guided-outro-play');
    const until = Date.now() + 90_000;
    while (!(await outro.isVisible()) && Date.now() < until) {
      const tap = await guidedTap(page).catch(() => null);
      if (tap) taps.push(tap);
      else await page.waitForTimeout(100);
    }
    await expect(outro).toBeVisible();
    console.log(`guided hand: ${taps.join(', ')}`);
    expect(taps.filter((x) => x === 'card')).toHaveLength(3);
    expect(taps).toContain('aceito');
    expect(taps).toContain('continuar');
    // The hand went to us: the score shows 3 for our team.
    await expect(page.getByTestId('score')).toHaveAttribute('aria-label', /Nós 3, Eles 0/);
    await expect(outro).toHaveAttribute('href', '/jogar?modo=solo&contra=otavio');
    expect(server.api, 'requests to the API during the guided hand').toEqual([]);
    expect(server.sockets, 'sockets during the guided hand').toEqual([]);

    // The outro leads to a real match against Otávio.
    await outro.tap();
    await expect(page).toHaveURL(/\/jogar\?modo=solo&contra=otavio$/);
    await expect(page.getByTestId('play-summary')).toContainText('Otávio');
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});

test('the guided scenes open at their moment', async ({ browser }) => {
  const me = await Player.create(browser, 'Scenes', PHONE);
  const page = me.page;
  try {
    const server = recordServer(page);
    await page.goto('/jogar/guiada?cena=antes');
    await expect(page.getByTestId('deck')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('guided-start')).toBeVisible();
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(0);

    await page.goto('/jogar/guiada?cena=meio');
    await expect(page.getByTestId('coach')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('trick')).toBeVisible();
    // Round 2: your 3 of diamonds and king of clubs are on the table; the 7 of spades is left.
    await expect(page.locator('[data-testid^="hand-card-"]')).toHaveCount(1);

    await page.goto('/jogar/guiada?cena=truco');
    await expect(page.getByTestId('truco-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('action-accept')).toBeVisible();

    await page.goto('/jogar/guiada?cena=fim');
    await expect(page.getByTestId('guided-outro-play')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('deck')).toBeVisible();
    expect(server.sockets).toEqual([]);
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});
