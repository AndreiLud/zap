// The data page (DATA-SPEC 4 and 8.1). In Portuguese on a phone and in English on a computer:
// every part and every figure renders, or shows its state (empty, not measured, unavailable) with a
// message; every ready figure has its heading and its footer; "See the numbers" (data.fig.numbers) opens the table; a
// tap term opens and Esc closes it with the focus back; the arrow keys move across the marks of
// F16 and write each mark to the live region; the chapter nav moves to each part; every link in and
// out goes where it should. No horizontal page scroll, no clipped chart word and no chart word over
// another at 360, 390 and 1440 px, in both languages and both themes, nor at 320 and 390 px with
// the text at 200%. A
// focused segmented button shows its focus ring; the replay's buttons keep the focus at the ends. The live strip polls every minute
// while the page is visible, stops while it is hidden and pauses after 30 polls without
// interaction; a match finished on this site adds to its counter.

import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, PHONE, Player, QUICK, expectTable, passHumanCheck, playLoop, startSolo, texts } from './support/zap.ts';

const PT = texts('pt');
const EN = texts('en');

/** The chapters of the nav, in page order. */
const CHAPTERS = ['como-funciona', 'leitura', 'truco', 'evolucao', 'como-joga', 'pessoas'];

/** Figures that are always on the page (F17 by week shows only from three weeks of summaries). */
const FIGURES = [
  'curva',
  'leitura-conta',
  'leitura-provas',
  'leitura-curva',
  'leitura-ganho',
  'leitura-explorador',
  'manilha',
  'forca-cartas',
  'mao-tres-cartas',
  'posicao',
  'primeira-rodada',
  'aceitar-truco',
  'forca-versoes',
  'placar-pessoas',
  'placar-modos',
  'gemea',
  'historico',
  'truco-forca',
  'mapa-decisao',
  'personagens',
  'maos-marcantes',
  'marcas',
  'tipos',
  'discordancias',
  'variantes',
];

/** Scrolls from the top to the bottom so every figure comes near the viewport and renders. */
async function renderAll(page: Page): Promise<void> {
  await page.getByTestId('page-data').and(page.locator('.dp')).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // The plan's four chapters load in their own chunk once the reader comes near them.
  await page.locator('#truco').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-chapter-shell]')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  const step = await page.evaluate(() => Math.round(innerHeight * 0.8));
  for (let y = 0; ; y += step) {
    const end = await page.evaluate((top) => {
      window.scrollTo(0, top);
      return top + innerHeight >= document.documentElement.scrollHeight;
    }, y);
    await page.waitForTimeout(40);
    if (end) break;
  }
  // The replay viewer of F23 comes with a second dynamic import.
  await expect(page.locator('#maos-marcantes .replay__controls')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** Problems of the figures: a missing heading, a ready chart without a picture or a footer, a state without its message. */
async function figureProblems(page: Page): Promise<{ problems: string[]; ids: string[] }> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const ids: string[] = [];
    for (const fig of document.querySelectorAll<HTMLElement>('main figure.figure')) {
      const id = fig.id || '(no id)';
      ids.push(id);
      const h = fig.querySelector('.figure__title');
      if (!h || !/^H[34]$/.test(h.tagName) || !h.textContent?.trim()) problems.push(`${id}: no heading`);
      if (h && fig.getAttribute('aria-labelledby') !== h.id) problems.push(`${id}: not labelled by its heading`);
      const state = fig.querySelector('.chart--state');
      if (state) {
        if (!state.querySelector('.chart__msg')?.textContent?.trim()) problems.push(`${id}: state without a message`);
        continue;
      }
      const chart = fig.querySelector('.chart');
      if (!chart) {
        problems.push(`${id}: no chart`);
        continue;
      }
      if (!chart.querySelector('svg, .replay, .dp-sim, ol, ul, dl')) problems.push(`${id}: the chart drew nothing`);
      if (!fig.querySelector('details.source, p.source')) problems.push(`${id}: no footer`);
      if (chart.getAttribute('role') === 'img' && !chart.getAttribute('aria-label')?.trim()) problems.push(`${id}: a chart without its summary`);
    }
    return { problems, ids };
  });
}

/** Sideways page scroll, with the element that pokes out, or null. */
async function sideScroll(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    window.scrollTo(10_000, window.scrollY);
    const scrolled = window.scrollX;
    window.scrollTo(0, window.scrollY);
    if (doc.scrollWidth <= doc.clientWidth && scrolled === 0) return null;
    let worst: Element | null = null;
    let right = doc.clientWidth;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 0.5) {
        right = r.right;
        worst = el;
      }
    }
    const name = worst ? `${worst.tagName.toLowerCase()}${worst.id ? `#${worst.id}` : ''}.${[...worst.classList].join('.')} in #${worst.closest('[id]')?.id ?? '?'}` : '?';
    return `scrollWidth ${doc.scrollWidth} > ${doc.clientWidth} (scrollX ${scrolled}); widest: ${name} to ${Math.round(right)} px`;
  });
}

/** Chart words that run out of what the reader can see (the viewport, or the box that scrolls them). */
async function clippedChartText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const cw = document.documentElement.clientWidth;
    for (const t of document.querySelectorAll('main figure svg text')) {
      const r = t.getBoundingClientRect();
      if (!r.width) continue;
      let left = 0;
      let right = cw;
      for (let e = t.parentElement; e; e = e.parentElement) {
        if (e instanceof SVGElement) continue;
        const ox = getComputedStyle(e).overflowX;
        if (/auto|scroll|hidden|clip/.test(ox)) {
          const b = e.getBoundingClientRect();
          // A box that scrolls (a heatmap at 200% text on a phone) shows all of its content by
          // scrolling: its whole scroll width counts (the box itself stays on the page, sideScroll).
          if (/auto|scroll/.test(ox)) {
            left = b.left - e.scrollLeft;
            right = b.left - e.scrollLeft + e.scrollWidth;
          } else {
            left = Math.max(left, b.left);
            right = Math.min(right, b.right);
          }
          break;
        }
      }
      if (r.right > right + 1 || r.left < left - 1) out.push(`#${t.closest('figure')?.id}: "${t.textContent}"`);
    }
    return out;
  });
}

/**
 * Chart words drawn over other words of the same chart: two visible texts of one svg.plot whose
 * boxes cross by more than 2 px across and by more than a quarter of the smaller height (a glyph
 * box holds some line gap, so boxes of neighbouring rows may touch).
 */
async function overlappingChartText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const svg of document.querySelectorAll('main figure svg.plot')) {
      const texts = [...svg.querySelectorAll('text')]
        .filter((t) => {
          const s = getComputedStyle(t);
          return t.textContent?.trim() && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
        })
        .map((t) => ({ text: t.textContent!.trim(), r: t.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && x.r.height > 0);
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i].r;
          const b = texts[j].r;
          const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (across > 2 && down > Math.max(2, 0.25 * Math.min(a.height, b.height))) {
            out.push(`#${svg.closest('figure')?.id}: "${texts[i].text}" and "${texts[j].text}" (${Math.round(across)} px)`);
          }
        }
      }
    }
    return out;
  });
}

/** What document.visibilityState says, as a hidden or visible tab would, with its event. */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('the data page in Portuguese on a phone: every figure in its state, the nav, a table, a term and the links', async ({ browser }) => {
  test.setTimeout(180_000);
  const me = await Player.create(browser, 'Dados', PHONE);
  const page = me.page;
  try {
    await test.step('links in: the menu and the Play page lead to the data page', async () => {
      await page.goto('/jogar');
      await page.locator('.lesson__link').click();
      await expect(page).toHaveURL(/\/dados$/);
      await page.goto('/');
      await page.getByTestId('menu-button').click();
      await page.locator('#site-nav').getByRole('link', { name: PT['shell.nav.data'], exact: true }).click();
      await expect(page).toHaveURL(/\/dados$/);
    });

    await test.step('the head, the cover and the live strip', async () => {
      await expect(page).toHaveTitle('Zap · como aprende');
      await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
      const live = await (await page.request.get('/api/live')).json();
      await expect(page.locator('#capa h1')).toHaveText(PT['data.h1.selfplay']);
      await expect(page.getByTestId('live-version')).toHaveText(live.current);
      await expect(page.getByTestId('read-status')).toHaveAttribute('data-reads', String(live.adapt));
    });

    await test.step('every part and every figure renders, or says why it cannot yet', async () => {
      await renderAll(page);
      for (const id of [...CHAPTERS, 'capa', 'ciclo', 'aprendeu', 'duplicado', 'fim', 'termos']) await expect(page.locator(`#${id}`)).toHaveCount(1);
      const { problems, ids } = await figureProblems(page);
      expect(problems).toEqual([]);
      for (const id of FIGURES) expect(ids, `figure #${id}`).toContain(id);
      expect(await sideScroll(page)).toBeNull();
      expect(await clippedChartText(page)).toEqual([]);
    });

    await test.step('"See the numbers" (data.fig.numbers) opens the table of a figure', async () => {
      const fig = page.locator('#forca-versoes');
      const details = fig.locator('details.source');
      await details.locator('summary').click();
      await expect(details).toHaveAttribute('open', '');
      const table = details.locator('table');
      await expect(table).toBeVisible();
      await expect(table.locator('caption')).toHaveText((await fig.locator('.figure__title').textContent()) ?? '');
      expect(await table.locator('tbody tr').count()).toBeGreaterThan(0);
      await details.locator('summary').click();
    });

    await test.step('a tap term opens its explanation; Esc closes it and the focus comes back', async () => {
      const term = page.locator('#curva .sub button.term').first();
      await term.scrollIntoViewIfNeeded();
      await term.click();
      const tip = page.locator(`#${await term.getAttribute('popovertarget')}`);
      await expect(tip).toBeVisible();
      await expect(tip).not.toBeEmpty();
      await page.keyboard.press('Escape');
      await expect(tip).toBeHidden();
      await expect(term).toBeFocused();
    });

    await test.step('the chapter nav moves to each part and marks it', async () => {
      const nav = page.getByRole('navigation', { name: PT['data.nav.label'] });
      await expect(nav.locator('a')).toHaveText([PT['data.nav.how'], PT['data.nav.reading'], PT['data.nav.truco'], PT['data.nav.evolution'], PT['data.nav.plays'], PT['data.nav.people']]);
      for (const id of CHAPTERS) {
        await nav.locator(`a[href="#${id}"]`).click();
        await expect(page).toHaveURL(new RegExp(`/dados#${id}$`));
        await expect(page.locator(`#${id}`).locator('h2, h3').first()).toBeFocused();
        await expect(nav.locator(`a[href="#${id}"]`)).toHaveAttribute('aria-current', 'true');
      }
    });

    await test.step('the reading status links to the explorer test; a figure term links to the page glossary', async () => {
      const why = page.getByTestId('read-status').locator('a[href="#leitura-explorador"]');
      if (await why.count()) {
        await why.click();
        await expect(page.locator('#leitura-explorador')).toBeInViewport();
      }
      await expect(page.locator('#termos dt[id^="termos-"]').first()).toBeAttached();
      const ids = await page.locator('#termos dt[id^="termos-"]').evaluateAll((els) => els.map((e) => e.id));
      expect(ids).toContain('termos-duelo');
      expect(new Set(ids).size).toBe(ids.length);
    });

    await test.step('the replay viewer of F23 steps through a hand; at the last move the focus stays on its button', async () => {
      const viewer = page.locator('#maos-marcantes');
      await viewer.scrollIntoViewIfNeeded();
      const move = viewer.locator('.replay__move');
      const before = await move.textContent();
      const next = viewer.getByRole('button', { name: PT['data.replay.next'] });
      await next.click();
      await expect(move).not.toHaveText(before ?? '');
      for (let i = 0; i < 80 && (await next.getAttribute('aria-disabled')) !== 'true'; i++) await page.keyboard.press('Enter');
      await expect(next).toHaveAttribute('aria-disabled', 'true');
      await expect(next).toBeFocused();
    });

    await test.step('a segmented button shows its focus ring when the keyboard reaches it', async () => {
      const seg = page.locator('#forca-cartas .seg__btn').first();
      await seg.scrollIntoViewIfNeeded();
      await seg.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(seg).toBeFocused();
      const ring = await seg.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { visible: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset) };
      });
      expect(ring.visible).toBe(true);
      expect(ring.style).not.toBe('none');
      expect(ring.width).toBeGreaterThan(0);
      // .seg clips its children: the ring is drawn inside the button.
      expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
    });

    await test.step('links out: play, the personal page, the rules, the method and the numbers', async () => {
      await expect(page.getByTestId('data-end-play')).toHaveAttribute('href', '/jogar');
      await expect(page.getByTestId('data-end-you')).toHaveAttribute('href', '/voce-contra-o-zap');
      await expect(page.getByTestId('data-end-rules')).toHaveAttribute('href', '/regras');
      await expect(page.getByTestId('data-f24-you')).toHaveAttribute('href', '/voce-contra-o-zap');
      for (const [id, end] of [
        ['data-end-method', '/project_docs/data-page.md'],
        ['data-end-facts', '/facts.json'],
      ] as const) {
        const a = page.getByTestId(id);
        expect(await a.getAttribute('href')).toMatch(new RegExp(`^https://github\\.com/[^/]+/zap/blob/main${end.replace('.', '\\.')}$`));
        await expect(a).toHaveAttribute('target', '_blank');
        await expect(a).toHaveAttribute('rel', 'noopener');
      }
      await page.getByTestId('data-end-you').click();
      await expect(page).toHaveURL(/\/voce-contra-o-zap$/);
      await expect(page.getByTestId('page-vs')).toBeVisible();
    });

    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});

test('the data page in English on a computer, dark: the figures, the keyboard across F16 and the language switch', async ({ browser }) => {
  test.setTimeout(180_000);
  const me = await Player.create(browser, 'Data', { ...DESKTOP, viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = me.page;
  try {
    await page.goto('/en/data');
    await expect(page).toHaveTitle('Zap · how it learns');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#capa h1')).toHaveText(EN['data.h1.selfplay']);
    await renderAll(page);
    const { problems, ids } = await figureProblems(page);
    expect(problems).toEqual([]);
    for (const id of FIGURES) expect(ids, `figure #${id}`).toContain(id);
    expect(await sideScroll(page)).toBeNull();
    expect(await clippedChartText(page)).toEqual([]);

    await test.step('the arrow keys move across the marks of F16 and say each one', async () => {
      const chart = page.locator('#forca-versoes .chart');
      const live = page.locator('#forca-versoes-live');
      await chart.scrollIntoViewIfNeeded();
      await chart.focus();
      await expect(live).not.toBeEmpty();
      const first = await live.textContent();
      await page.keyboard.press('ArrowDown');
      await expect(live).not.toHaveText(first ?? '');
      const second = await live.textContent();
      await page.keyboard.press('End');
      await expect(live).not.toHaveText(second ?? '');
      await page.keyboard.press('Home');
      await expect(live).toHaveText(first ?? '');
      await expect(chart.locator('.chart-tip')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(chart.locator('.chart-tip')).toBeHidden();
    });

    await test.step('the chapter nav stays at the top while the page scrolls', async () => {
      await page.locator('#pessoas').scrollIntoViewIfNeeded();
      const nav = page.getByRole('navigation', { name: EN['data.nav.label'] });
      await expect(nav).toBeInViewport();
    });

    await test.step('the language switch keeps the page and its part', async () => {
      await page.getByTestId('lang-switch').click();
      await expect(page).toHaveURL(/\/dados(#.*)?$/);
      await expect(page.locator('#capa h1')).toHaveText(PT['data.h1.selfplay']);
    });
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});

test('no horizontal page scroll on the data page: phones and a computer, both languages and themes, and text at 200%', async ({ browser }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  const cases: { path: string; width: number; scheme: 'light' | 'dark'; text200?: boolean }[] = [];
  for (const path of ['/dados', '/en/data']) {
    for (const width of [360, 390, 1440]) for (const scheme of ['light', 'dark'] as const) cases.push({ path, width, scheme });
    for (const width of [320, 390]) cases.push({ path, width, scheme: 'light', text200: true });
  }
  for (const c of cases) {
    const ctx = await browser.newContext({ ...(c.width < 900 ? PHONE : DESKTOP), viewport: { width: c.width, height: 800 }, colorScheme: c.scheme, locale: 'pt-BR' });
    const page = await ctx.newPage();
    try {
      await page.goto(c.path);
      await page.locator('#capa h1').waitFor();
      // The reader's own text size: the root font size at 200% (the charts follow it up to 1.6 times).
      if (c.text200) await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
      await renderAll(page);
      const where = `${c.path} at ${c.width} px, ${c.scheme}${c.text200 ? ', text 200%' : ''}`;
      const s = await sideScroll(page);
      if (s) problems.push(`${where}: ${s}`);
      // DATA-SPEC 6: no clipped chart word, with the text at 100% and at 200%.
      for (const t of await clippedChartText(page)) problems.push(`${where}: clipped ${t}`);
      // No chart word over another one, which the clipping check cannot see.
      for (const t of await overlappingChartText(page)) problems.push(`${where}: overlap ${t}`);
    } finally {
      await ctx.close();
    }
  }
  expect(problems).toEqual([]);
});

test('the live strip polls every minute while the page is visible, stops while hidden and pauses when nobody is there', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ ...DESKTOP, locale: 'pt-BR' });
  const page = await ctx.newPage();
  try {
    let asked = 0;
    await page.clock.install();
    await page.route('**/api/live', (route) => {
      asked++;
      return route.fulfill({
        json: { schema: 'zap-live/1', at: Date.now(), matches: 100 + asked, decisions: 3_100_000, current: 'v2', adapt: false, humansVsZap: null },
        headers: { 'cache-control': 'no-store' },
      });
    });
    await page.goto('/dados');
    await expect(page.getByTestId('live-matches')).toHaveText('101');
    await expect(page.getByTestId('live-decisions')).toHaveText('3,1 milhões');
    expect(asked).toBe(1);

    await page.clock.runFor(60_000);
    await expect(page.getByTestId('live-matches')).toHaveText('102');
    expect(asked).toBe(2);

    await setVisibility(page, 'hidden');
    await page.clock.runFor(5 * 60_000);
    expect(asked, 'no request while the tab is hidden').toBe(2);
    await expect(page.getByTestId('live-matches')).toHaveText('102');

    await setVisibility(page, 'visible');
    await expect(page.getByTestId('live-matches')).toHaveText('103');
    await page.clock.runFor(60_000);
    await expect(page.getByTestId('live-matches')).toHaveText('104');

    // Nobody touches the page: after 30 polls without a pointer, key or scroll it stops and says so.
    await page.clock.runFor(40 * 60_000);
    await expect(page.getByTestId('live-resume')).toBeVisible();
    const paused = asked;
    expect(paused).toBe(30);
    await page.clock.runFor(10 * 60_000);
    expect(asked).toBe(paused);
    await page.getByTestId('live-resume').click();
    await expect(page.getByTestId('live-resume')).toBeHidden();
    await expect.poll(() => asked).toBe(paused + 1);
  } finally {
    await ctx.close();
  }
});

test('a match finished on the site adds to the counter of games with people', async ({ browser }) => {
  test.setTimeout(300_000);
  const me = await Player.create(browser, 'Conta', DESKTOP);
  const page = me.page;
  try {
    const count = async () => ((await (await page.request.get('/api/live')).json()) as { matches: number }).matches;
    const before = await count();
    await page.goto('/jogar');
    await startSolo(page, 2);
    await passHumanCheck(page);
    await expectTable(me);
    const r = await playLoop(me, { policy: QUICK, timeoutMs: 240_000 });
    expect(r.ended).toBe(true);
    await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(before);
    const after = await count();
    await page.goto('/dados');
    await expect(page.getByTestId('live-matches')).toHaveText(new Intl.NumberFormat('pt-BR').format(after));
    expect(me.errors).toEqual([]);
  } finally {
    await me.close();
  }
});
