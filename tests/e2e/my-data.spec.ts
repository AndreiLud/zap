// The You page (/voce) with real data: a solo match played to the end shows up in the history; the
// nickname and the two switches are saved; the download, built in the browser, holds the match
// record and the person's seat and nothing that points to the browser; a recovery code (shown
// once) moves the history to a second browser and the first one loses it; deleting the data
// (confirmation plus a fresh human check) leaves no device and no history.

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ADULT_KEY } from '../../web/src/consent-keys.ts';
import { DESKTOP, PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo } from './support/zap.ts';

const status = (page: Page, path: string) => page.evaluate(async (p) => (await fetch(p)).status, path);
const me = (page: Page) => page.evaluate(async () => (await fetch('/api/me')).json() as Promise<Record<string, unknown>>);

test('a solo match, then download, nickname and switches, recovery on a second browser, and deletion', async ({ browser }) => {
  test.setTimeout(420_000);
  const ana = await Player.create(browser, 'Ana', DESKTOP);
  let bia: Player | null = null;
  const page = ana.page;
  let matchId = '';
  let seat = -1;
  try {
    await test.step('a solo 1 against 1 match, played to the end', async () => {
      await page.goto('/jogar');
      await startSolo(page, 2);
      await passHumanCheck(page);
      await expectTable(ana);
      seat = ana.seat;
      const r = await playLoop(ana, { policy: QUICK, timeoutMs: 300_000 });
      expect(r.ended).toBe(true);
    });

    await test.step('the You page (/voce) lists the match and this seat', async () => {
      await page.getByTestId('footer-you').click();
      await expect(page).toHaveURL(/\/voce$/);
      // The room writes the record when the match ends; a reload shows it once it is there.
      await expect(async () => {
        await page.reload();
        await expect(page.getByTestId('you-match-row')).toHaveCount(1, { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      const row = page.getByTestId('you-match-row');
      matchId = (await row.getAttribute('data-match-id')) ?? '';
      expect(matchId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(row).toHaveAttribute('data-seat', String(seat));
      await expect(row).toContainText('Sozinho, 1 contra 1');
      await expect(row).toContainText(`Cadeira ${seat + 1}`);
      await expect(page.getByTestId('you-pseudonym')).toHaveText(/^[0-9a-f]{32}$/);
      // This browser has a history, so recovering another one here would merge them: the page says so.
      await expect(page.getByTestId('recover-merge-note')).toHaveText(
        'Se este navegador já tem partidas, elas passam para o histórico recuperado. Para apagá-las antes, use "Apagar meus dados" primeiro.',
      );
    });

    await test.step('nickname: a refused one, a good one, then the two switches; all kept after a reload', async () => {
      await page.getByTestId('nickname-input').fill('Jogador 2');
      await page.getByTestId('nickname-save').click();
      await expect(page.getByTestId('nickname-status')).toHaveText('Esse apelido não pode ser usado. Tente outro.');
      await page.getByTestId('nickname-input').fill('Tatu Bola');
      await page.getByTestId('nickname-save').click();
      await expect(page.getByTestId('nickname-status')).toHaveText('Apelido salvo.');
      await page.getByTestId('pref-open-data').check();
      await expect(page.getByTestId('prefs-status')).toHaveText('Escolha salva.');
      await page.getByTestId('pref-no-adapt').check();
      await expect(page.getByTestId('pref-no-adapt')).toBeChecked();
      await expect(async () => {
        const m = await me(page);
        expect(m.prefs).toEqual({ openDataOptOut: true, noAdapt: true });
      }).toPass({ timeout: 5_000 });
      await page.reload();
      await expect(page.getByTestId('nickname-input')).toHaveValue('Tatu Bola');
      await expect(page.getByTestId('pref-open-data')).toBeChecked();
      await expect(page.getByTestId('pref-no-adapt')).toBeChecked();
      await page.getByTestId('pref-no-adapt').uncheck();
      await expect(page.getByTestId('prefs-status')).toHaveText('Escolha salva.');
      await ana.shot('you-ready-desktop');
    });

    await test.step('the download holds the match record and the seat, and nothing that points to this browser', async () => {
      const download = page.waitForEvent('download');
      await page.getByTestId('you-download').click();
      const d = await download;
      expect(d.suggestedFilename()).toMatch(/^zap-meus-dados-\d{4}-\d{2}-\d{2}\.json$/);
      const text = readFileSync(await d.path(), 'utf8');
      const file = JSON.parse(text);
      expect(file.format).toBe('zap-my-data/1');
      expect(file.data.matches).toEqual([expect.objectContaining({ matchId, seat, kind: 'solo1' })]);
      expect(file.data.device.nickname).toBe('Tatu Bola');
      expect(file.data.device.prefs).toEqual({ openDataOptOut: true, noAdapt: false });
      expect(file.data.pseudonym).toBe(await page.getByTestId('you-pseudonym').innerText());
      expect(file.matches).toHaveLength(1);
      const [m] = file.matches;
      expect(m.matchId).toBe(matchId);
      expect(m.yourSeat).toBe(seat);
      expect(m.record.schema).toBe('zap-match/2');
      // A local test site marks its records, and each AI seat names the version that played it.
      expect(m.record.test).toBe(true);
      expect(m.record.seats[seat].aiVersion).toBeNull();
      expect(m.record.seats[1 - seat].aiVersion).toBe(m.record.aiVersion);
      expect(m.record.matchId).toBe(matchId);
      expect(m.record.seats[seat]).toEqual(expect.objectContaining({ seat, kind: 'human' }));
      expect(m.record.seats[1 - seat].kind).toBe('ai');
      expect(m.record.log.length).toBe(m.record.moves.length);
      expect(Math.max(...m.record.result.score)).toBeGreaterThanOrEqual(12);
      // The cookies (device secret and credential) never appear in the file.
      for (const c of await ana.ctx.cookies()) if (c.value.length >= 16) expect(text).not.toContain(c.value);
      await expect(page.getByTestId('download-status')).toHaveText('Pronto. O arquivo foi baixado.');
    });

    let recovery = '';
    await test.step('a recovery code, shown once', async () => {
      await page.getByTestId('you-recovery-show').click();
      const code = page.getByTestId('you-recovery-code');
      await expect(code).toHaveText(/^[2-9A-HJKMNP-Z]{5}( [2-9A-HJKMNP-Z]{5}){3}$/);
      await expect(code).toBeFocused();
      recovery = (await code.innerText()).trim();
      await page.reload();
      await expect(page.getByTestId('you-match-row')).toHaveCount(1);
      await expect(page.getByTestId('you-recovery-code')).toHaveCount(0);
      await expect(page.getByTestId('you-recovery-show')).toHaveText('Criar outro código');
    });

    await test.step('a second browser: age gate, the code and a fresh human check bring the history; the first loses it', async () => {
      bia = await Player.create(browser, 'Bia', PHONE, { fresh: true });
      const p = bia.page;
      await p.goto('/voce');
      await p.getByTestId('you-start').click();
      await p.getByTestId('age-year').selectOption(String(new Date().getFullYear() - 40));
      await p.getByTestId('age-continue').click();
      await expect(p.getByTestId('you-empty')).toBeVisible();
      await expect(p.getByTestId('recover-merge-note')).toHaveCount(0);
      // Typed the way people type it: lower case, dashes instead of spaces.
      await p.getByTestId('recover-input').fill(recovery.toLowerCase().replaceAll(' ', '-'));
      const req = p.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/recover'));
      await p.getByTestId('recover-submit').click();
      await passHumanCheck(p);
      // The page sends the code, the token and the declaration made at the age gate; never the year.
      const body = (await req).postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['adult', 'code', 'token']);
      expect(body.adult).toBe(true);
      await expect(p.getByTestId('you-match-row')).toHaveCount(1);
      await expect(p.getByTestId('you-match-row')).toHaveAttribute('data-match-id', matchId);
      await expect(p.getByTestId('nickname-input')).toHaveValue('Tatu Bola');
      await expect(p.getByTestId('you-status')).toHaveText('Pronto. Este navegador agora tem o seu histórico.');
      await bia.shot('you-recovered-phone');
      // The first browser lost the history.
      expect(await status(page, '/api/me/data')).toBe(401);
      expect(await status(page, `/api/me/matches/${matchId}`)).not.toBe(200);
      await page.reload();
      await expect(page.getByTestId('you-empty')).toBeVisible();
      // The code worked once.
      await page.getByTestId('recover-input').fill(recovery);
      await page.getByTestId('recover-submit').click();
      await passHumanCheck(page);
      await expect(page.getByTestId('recover-status')).toHaveText('Esse código não foi encontrado. Confira e tente de novo.');
    });

    await test.step('delete: a confirmation, a fresh human check, then no device and no history', async () => {
      const p = bia!.page;
      await p.getByTestId('you-delete').click();
      await expect(p.getByTestId('you-delete-dialog')).toBeVisible();
      // Cancel first: nothing happens.
      await p.keyboard.press('Escape');
      await expect(p.getByTestId('you-delete-dialog')).toBeHidden();
      await expect(p.getByTestId('you-delete')).toBeFocused();
      await p.getByTestId('you-delete').click();
      const req = p.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/me/delete'));
      await p.getByTestId('you-delete-confirm').click();
      await passHumanCheck(p);
      expect(Object.keys((await req).postDataJSON() as object)).toEqual(['token']);
      await expect(p.getByTestId('you-status')).toHaveText('Pronto. Seus dados foram apagados.');
      await expect(p.getByTestId('you-empty')).toBeVisible();
      await expect(p.getByTestId('you-match-row')).toHaveCount(0);
      const after = await me(p);
      expect(after.device).toBe(false);
      expect(after.adult).toBe(false);
      expect(await status(p, '/api/me/data')).toBe(401);
      expect(await status(p, `/api/me/matches/${matchId}`)).toBe(401);
      // This browser forgot the age answer too: it starts from zero.
      expect(await p.evaluate((k) => localStorage.getItem(k), ADULT_KEY)).toBeNull();
      await p.reload();
      await expect(p.getByTestId('page-you')).toHaveAttribute('data-state', 'gate');
      await bia!.shot('you-deleted-phone');
      expect([...ana.errors, ...bia!.errors]).toEqual([]);
    });
  } finally {
    await ana.close();
    await (bia as Player | null)?.close();
  }
});
