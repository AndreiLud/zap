// The rules page (CLIENT-SPEC 10.6, 19.4): each interactive example answers with the right text, as
// the engine decides it (vira 6 gives the 7 as manilha, vira 3 wraps to the 4; a king beats a queen;
// accepting a truco makes the hand worth 3, or 4 in mineiro), the variant switch lives in the
// address, and every glossary term has its anchor.

import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, Player, texts } from './support/zap.ts';

const PT = texts('pt');
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

test('the interactive examples of the rules page and the glossary anchors', async ({ browser }) => {
  const phone = await Player.create(browser, 'Phone', PHONE);
  const page = phone.page;
  try {
    await test.step('the vira picks the manilha: 6 gives 7, 3 wraps to 4', async () => {
      await page.goto('/regras');
      await expect(page.getByTestId('page-rules')).toBeVisible();
      await page.getByTestId('vira-6').click();
      await expect(page.getByTestId('manilha-result')).toHaveText('Vira 6, manilha 7');
      await page.getByTestId('vira-3').click();
      await expect(page.getByTestId('manilha-result')).toHaveText('Vira 3, manilha 4');
    });

    await test.step('who wins: a king beats a queen; two of the same rank tie', async () => {
      await page.getByTestId('duel-a-K').click();
      await page.getByTestId('duel-b-Q').click();
      const kq = fill(PT['rulebook.duel.win'], { a: PT['rulebook.rank.the.6'], b: PT['rulebook.rank.from.4'] });
      expect(kq).toBe('O rei ganha da dama.');
      await expect(page.getByTestId('duel-result')).toHaveText(kq);
      await page.getByTestId('duel-b-K').click();
      await expect(page.getByTestId('duel-result')).toHaveText(PT['rulebook.duel.tie']);
    });

    await test.step('a truco accepted makes the hand worth 3; a run gives the caller 1', async () => {
      await page.getByTestId('truco-demo-call').click();
      await page.getByTestId('truco-demo-accept').click();
      await expect(page.getByTestId('truco-demo-result')).toHaveText('Eles aceitaram: a mão vale 3 tentos.');
      await page.getByTestId('truco-demo-call').click();
      await page.getByTestId('truco-demo-run').click();
      await expect(page.getByTestId('truco-demo-result')).toHaveText('Eles correram: você leva 1 tento.');
      await page.getByTestId('truco-demo-call').click();
      await page.getByTestId('truco-demo-raise').click();
      await expect(page.getByTestId('truco-demo-result')).toContainText('Eles pediram seis. Aceitando, a mão vale 6 tentos.');
    });

    await test.step('mineiro: the switch goes into the address, and an accepted truco is worth 4', async () => {
      await page.getByTestId('rules-variant-mineiro').click();
      await expect(page).toHaveURL(/\/regras\?variante=mineiro$/);
      await page.getByTestId('truco-demo-call').click();
      await page.getByTestId('truco-demo-accept').click();
      await expect(page.getByTestId('truco-demo-result')).toHaveText('Eles aceitaram: a mão vale 4 tentos.');
      await page.reload();
      await expect(page.getByTestId('rules-variant-mineiro').locator('input')).toBeChecked();
      await page.getByTestId('rules-variant-paulista').click();
      await expect(page).toHaveURL(/\/regras$/);
    });

    await test.step('every glossary term has its anchor', async () => {
      const ids = Object.keys(PT)
        .map((k) => /^glossary\.(\w+)\.def$/.exec(k)?.[1])
        .filter((x): x is string => !!x);
      expect(ids.length).toBeGreaterThanOrEqual(19);
      const glossary = page.getByTestId('glossary');
      await expect(glossary).toHaveAttribute('id', 'glossario');
      for (const id of ids) await expect(glossary.locator(`#glossario-${id}`), id).toHaveText(PT[`glossary.${id}.name`]);
    });
    expect(phone.errors).toEqual([]);
  } finally {
    await phone.close();
  }
});

test('a glossary address opens the rules page at the term', async ({ browser }) => {
  const desk = await Player.create(browser, 'Desk', DESKTOP);
  const page = desk.page;
  try {
    await page.goto('/regras#glossario-manilha');
    await expect(page.locator('#glossario-manilha')).toBeInViewport();
    expect(desk.errors).toEqual([]);
  } finally {
    await desk.close();
  }
});
