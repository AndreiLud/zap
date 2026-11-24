// Quick play on a phone: the home page has four buttons and keeps Regras, Código-fonte and
// Portfólio behind the menu button; Jogar leads to the Play page, where "Jogar agora" asks for the
// human check and opens a 2 against 2 table with an AI partner against two AIs; the language switch
// in the middle of the match changes the text in place without closing the connection, and the
// match is played to the end.

import { expect, test } from '@playwright/test';
import { PHONE, QUICK, auditRoom, expectSeat, expectTable, newPlayers, passHumanCheck, playLoop, type Player } from './support/zap.ts';

const FORBIDDEN = ['Você, humano verificado', 'O anel marca o tempo', 'You, verified human', 'The ring marks the time'];

async function expectNoForbiddenText(p: Player): Promise<void> {
  const text = await p.page.locator('body').innerText();
  for (const f of FORBIDDEN) expect(text).not.toContain(f);
}

/** Starts recording every change of the connection badge, to prove it never left "online". */
async function watchConnection(p: Player): Promise<void> {
  await p.page.evaluate(() => {
    const w = window as unknown as { __zapSamePage: boolean; __zapConn: string[] };
    w.__zapSamePage = true;
    w.__zapConn = [];
    const el = document.querySelector('[data-testid="conn-status"]');
    if (!el) throw new Error('no connection badge');
    new MutationObserver(() => {
      const now = document.querySelector('[data-testid="conn-status"]')?.getAttribute('data-state') ?? 'missing';
      if (now !== 'online') w.__zapConn.push(now);
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-state'], childList: true });
  });
}

async function connectionHistory(p: Player): Promise<{ samePage: boolean; changes: string[] }> {
  return p.page.evaluate(() => {
    const w = window as unknown as { __zapSamePage?: boolean; __zapConn?: string[] };
    return { samePage: w.__zapSamePage === true, changes: w.__zapConn ?? ['no record'] };
  });
}

test('quick play on a phone, to the end, switching language mid-match without dropping the connection', async ({ browser }) => {
  test.setTimeout(300_000);
  const [me] = await newPlayers(browser, [['Phone', PHONE]]);
  const page = me.page;
  try {
    await test.step('home page on the phone: four buttons, and the links sit behind the menu button', async () => {
      await page.goto('/');
      await expect(page.getByTestId('home-play')).toBeVisible();
      // Como funciona: the data page, in the same tab.
      await expect(page.getByTestId('home-how')).toHaveAttribute('href', '/dados');
      await expect(page.getByTestId('home-how')).not.toHaveAttribute('target', /./);
      await expect(page.getByTestId('home-how')).toBeInViewport();
      await expect(page.getByTestId('home-source')).toHaveAttribute('href', 'https://github.com/AndreiLud/zap');
      await expect(page.getByTestId('home-portfolio')).toHaveAttribute('href', 'https://andreiludescher.com');
      for (const id of ['home-source', 'home-portfolio']) {
        await expect(page.getByTestId(id)).toHaveAttribute('target', '_blank');
        await expect(page.getByTestId(id)).toHaveAttribute('rel', 'noopener');
      }
      await expect(page.locator('main a, main button')).toHaveCount(4);
      await expect(page.getByTestId('menu-button')).toBeVisible();
      for (const id of ['rules-button', 'link-source', 'link-portfolio']) await expect(page.getByTestId(id)).toBeHidden();
      await page.getByTestId('menu-button').click();
      for (const id of ['rules-button', 'link-source', 'link-portfolio']) await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByTestId('link-source')).toHaveAttribute('href', /github\.com/);
      await me.shot('solo-home-menu-phone');
      await page.keyboard.press('Escape');
      for (const id of ['rules-button', 'link-source', 'link-portfolio']) await expect(page.getByTestId(id)).toBeHidden();
      await expectNoForbiddenText(me);
      await me.shot('solo-home-phone');
      await page.getByTestId('home-play').click();
      await expect(page).toHaveURL(/\/jogar$/);
      await expect(page.getByTestId('mode-2x2')).toBeVisible();
      await expect(page.getByTestId('play-now')).toBeVisible();
    });

    let code = '';
    await test.step('"Play now" (play.play) asks for the human check, then opens a table with an AI partner against two AIs', async () => {
      await page.getByTestId('play-now').click();
      await passHumanCheck(page);
      await expect(page).toHaveURL(/\/\?sala=[A-Z0-9]{5}$/, { timeout: 20_000 });
      code = new URL(page.url()).searchParams.get('sala')!;
      await expectTable(me);
      const room = me.lastRoom()!.room;
      expect(room.settings.mode).toBe('solo');
      expect(room.settings.players).toBe(4);
      expect(room.settings.variant).toBe('paulista');
      const you = me.seat;
      await expectSeat(page, you, { kind: 'human', connected: true });
      for (const seat of [0, 1, 2, 3].filter((s) => s !== you)) {
        await expectSeat(page, seat, { kind: 'ai' });
        // AIs always show the AI mark and their character.
        await expect(page.getByTestId(`seat-${seat}`)).toContainText('IA');
        await expect(page.getByTestId(`seat-${seat}`)).toContainText(room.seats[seat].name);
      }
      // The seal goes only on other people's seats: never on your own.
      await expect(page.getByTestId(`seat-${you}`)).not.toContainText('humano verificado');
      await expectNoForbiddenText(me);
    });

    await test.step('mid-match, PT/EN changes the text in place and keeps the connection', async () => {
      await playLoop(me, { policy: QUICK, stop: () => me.moves >= 3, timeoutMs: 60_000 });
      await expect(page.getByTestId('match-result')).toHaveCount(0);
      await expect(page.getByTestId('phrase-button')).toHaveText('Frases');
      await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
      await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online');
      expect(me.sockets.length).toBe(1);
      await watchConnection(me);

      await page.getByTestId('lang-switch').click();
      await expect(page).toHaveURL(new RegExp(`/en/\\?sala=${code}$`));
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page).toHaveTitle(`Room ${code} · Zap`);
      await expect(page.getByTestId('phrase-button')).toHaveText('Phrases');
      await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online');
      await expect(page.getByTestId('conn-status')).toHaveText('Connected');
      await expect(page.getByTestId(`seat-${me.seat}`)).toContainText('You');
      await expectNoForbiddenText(me);
      await me.shot('solo-table-en-phone');

      // Same page, same socket: nothing reloaded, closed or synced again.
      const h = await connectionHistory(me);
      expect(h.samePage, 'the page did not reload').toBe(true);
      expect(h.changes, 'the connection badge never left online').toEqual([]);
      expect(me.sockets.length, 'no new connection').toBe(1);
      expect(me.sockets[0].isClosed()).toBe(false);
      expect(me.sent.filter((s) => s.data.includes('"sync"')), 'no resync').toEqual([]);
    });

    await test.step('the match goes on in English to the end', async () => {
      const r = await playLoop(me, { policy: QUICK, timeoutMs: 240_000 });
      expect(r.ended).toBe(true);
      const room = me.lastRoom()!.room;
      expect(room.status).toBe('ended');
      expect(Math.max(...room.score)).toBeGreaterThanOrEqual(12);
      await expect(page.getByTestId('match-result')).toHaveText(room.lastWinner === (me.seat & 1) ? 'We won!' : 'They won.');
      await expect(page.getByTestId('rematch-button')).toHaveText('Play again');
      await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online');
      const h = await connectionHistory(me);
      expect(h.samePage).toBe(true);
      expect(h.changes).toEqual([]);
      expect(me.sockets.length).toBe(1);
      const audit = auditRoom([me]);
      expect(audit.problems).toEqual([]);
      expect(me.samples.length, 'hands seen on screen').toBeGreaterThan(0);
      await me.shot('solo-ended-en-phone');
    });

    await test.step('back to Portuguese, still the same connection', async () => {
      await page.getByTestId('lang-switch').click();
      await expect(page).toHaveURL(new RegExp(`/\\?sala=${code}$`));
      await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
      await expect(page.getByTestId('rematch-button')).toHaveText('Jogar de novo');
      await expect(page.getByTestId('conn-status')).toHaveText('Conectado');
      expect(me.sockets.length).toBe(1);
      expect(me.sockets[0].isClosed()).toBe(false);
    });
  } finally {
    await me.close();
  }
});
