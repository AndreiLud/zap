// Every route in both languages (CLIENT-SPEC 3, 19.4): each page loads with its own h1, title and
// html[lang]; the PT/EN switch moves to the same page in the other language; each prerendered file,
// fetched as a crawler would (no JavaScript), carries its title, canonical, the three hreflang links
// and its Open Graph image; the sitemap lists the 16 indexed addresses, robots.txt matches, and an
// unknown address shows the not found page without being indexed.

import { expect, test } from '@playwright/test';
import { DESKTOP, PHONE, Player, texts } from './support/zap.ts';

const ORIGIN = 'https://zap.andreiludescher.com';

interface RouteCase {
  name: string;
  pt: string;
  en: string;
  h1: string;
  title: string;
  indexed: boolean;
}

/** The route table of spec 3.1, with the keys of each page's h1 and title. */
const ROUTES: RouteCase[] = [
  { name: 'start', pt: '/', en: '/en/', h1: 'start.h1', title: 'shell.meta.start.title', indexed: true },
  { name: 'play', pt: '/jogar', en: '/en/play', h1: 'play.choose.h', title: 'shell.meta.play.title', indexed: true },
  { name: 'guided', pt: '/jogar/guiada', en: '/en/play/guided', h1: 'guide.title', title: 'shell.meta.guided.title', indexed: true },
  { name: 'rules', pt: '/regras', en: '/en/rules', h1: 'rulebook.h1', title: 'shell.meta.rules.title', indexed: true },
  { name: 'data', pt: '/dados', en: '/en/data', h1: 'data.h1.selfplay', title: 'shell.meta.data.title', indexed: true },
  { name: 'you', pt: '/voce', en: '/en/you', h1: 'legal.you.title', title: 'legal.you.metaTitle', indexed: false },
  { name: 'privacy', pt: '/privacidade', en: '/en/privacy', h1: 'legal.privacy.title', title: 'legal.privacy.metaTitle', indexed: true },
  { name: 'terms', pt: '/termos', en: '/en/terms', h1: 'legal.terms.title', title: 'legal.terms.metaTitle', indexed: true },
  { name: 'verify', pt: '/como-verificamos', en: '/en/how-we-verify', h1: 'legal.verify.title', title: 'legal.verify.metaTitle', indexed: true },
];

const T = { pt: texts('pt'), en: texts('en') };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathRe = (path: string) => new RegExp(`^https?://[^/]+${escapeRe(path)}$`);

test('every route loads in both languages, and the language switch keeps the page', async ({ browser }) => {
  test.setTimeout(180_000);
  const desk = await Player.create(browser, 'Desk', DESKTOP);
  const page = desk.page;
  try {
    for (const r of ROUTES) {
      await test.step(`${r.name}: ${r.pt} and ${r.en}`, async () => {
        for (const lang of ['pt', 'en'] as const) {
          const path = r[lang];
          const other = lang === 'pt' ? 'en' : 'pt';
          await page.goto(path);
          await expect(page.locator('h1').first(), `${path} h1`).toHaveText(T[lang][r.h1]);
          await expect(page, `${path} title`).toHaveTitle(T[lang][r.title]);
          await expect(page.locator('html')).toHaveAttribute('lang', lang === 'pt' ? 'pt-BR' : 'en');
          const robots = page.locator('meta[name="robots"]');
          if (r.indexed) await expect(robots, `${path} is indexed`).toHaveCount(0);
          else await expect(robots).toHaveAttribute('content', 'noindex');
          // The switch rewrites the address in place, never reloads, and lands on the same page.
          await page.evaluate(() => ((window as unknown as { __zapSame: boolean }).__zapSame = true));
          await page.getByTestId('lang-switch').click();
          await expect(page, `${path} switched`).toHaveURL(pathRe(r[other]));
          await expect(page.locator('h1').first()).toHaveText(T[other][r.h1]);
          await expect(page.locator('html')).toHaveAttribute('lang', other === 'pt' ? 'pt-BR' : 'en');
          expect(await page.evaluate(() => (window as unknown as { __zapSame?: boolean }).__zapSame), 'no reload').toBe(true);
        }
      });
    }

    await test.step('a slug of the other language opens the page and the address is rewritten', async () => {
      await page.goto('/en/jogar');
      await expect(page).toHaveURL(pathRe('/en/play'));
      await expect(page.locator('h1')).toHaveText(T.en['play.choose.h']);
    });

    await test.step('an unknown address shows the not found page, never indexed', async () => {
      for (const [path, lang] of [
        ['/nada-por-aqui', 'pt'],
        ['/en/nothing-here', 'en'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByTestId('page-not-found')).toBeVisible();
        await expect(page.locator('h1')).toHaveText(T[lang]['shell.notFound.title']);
        await expect(page).toHaveTitle(T[lang]['shell.meta.notFound.title']);
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
      }
    });
    expect(desk.errors).toEqual([]);
  } finally {
    await desk.close();
  }
});

test('each prerendered page carries its own head; sitemap and robots', async ({ request }) => {
  for (const r of ROUTES) {
    for (const lang of ['pt', 'en'] as const) {
      const path = r[lang];
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      const head = html.slice(0, html.indexOf('</head>'));
      const attr = (re: RegExp) => re.exec(head)?.[1] ?? null;
      expect(html, `${path} lang`).toContain(`<html lang="${lang === 'pt' ? 'pt-BR' : 'en'}"`);
      expect(attr(/<title>([^<]*)<\/title>/), `${path} title`).toBe(T[lang][r.title]);
      expect(attr(/<link rel="canonical" href="([^"]+)">/), `${path} canonical`).toBe(`${ORIGIN}${path}`);
      expect(attr(/<link rel="alternate" hreflang="pt-BR" href="([^"]+)">/), `${path} hreflang pt-BR`).toBe(`${ORIGIN}${r.pt}`);
      expect(attr(/<link rel="alternate" hreflang="en" href="([^"]+)">/), `${path} hreflang en`).toBe(`${ORIGIN}${r.en}`);
      expect(attr(/<link rel="alternate" hreflang="x-default" href="([^"]+)">/), `${path} x-default`).toBe(`${ORIGIN}${r.pt}`);
      expect(attr(/<meta property="og:image" content="([^"]+)">/), `${path} og:image`).toBe(`${ORIGIN}/og/${r.name}-${lang}.png`);
      expect(head.includes('<meta name="robots" content="noindex">'), `${path} robots`).toBe(!r.indexed);
      // The image itself is served.
      const img = await request.get(`/og/${r.name}-${lang}.png`);
      expect(img.status(), `/og/${r.name}-${lang}.png`).toBe(200);
      expect(img.headers()['content-type']).toBe('image/png');
    }
  }

  const sitemap = await (await request.get('/sitemap.xml')).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const indexed = ROUTES.filter((r) => r.indexed).flatMap((r) => [`${ORIGIN}${r.pt}`, `${ORIGIN}${r.en}`]);
  expect(locs).toHaveLength(16);
  expect(locs.sort()).toEqual(indexed.sort());
  expect([...sitemap.matchAll(/<xhtml:link rel="alternate" hreflang="(pt-BR|en|x-default)"/g)]).toHaveLength(48);

  const robots = await (await request.get('/robots.txt')).text();
  expect(robots.trim()).toBe(['User-agent: *', 'Allow: /', 'Disallow: /api/', `Sitemap: ${ORIGIN}/sitemap.xml`].join('\n'));
});

test('a phone opens every page from the menu sheet', async ({ browser }) => {
  const phone = await Player.create(browser, 'Phone', PHONE);
  const page = phone.page;
  try {
    await page.goto('/');
    for (const [name, path] of [
      ['Jogar', '/jogar'],
      ['Regras', '/regras'],
      ['Dados', '/dados'],
      ['Você', '/voce'],
      ['Privacidade', '/privacidade'],
      ['Termos', '/termos'],
      ['Como verificamos', '/como-verificamos'],
      ['Início', '/'],
    ] as const) {
      await page.getByTestId('menu-button').click();
      await page.locator('#site-nav').getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(pathRe(path));
      await expect(page.getByTestId('site-sheet')).toBeHidden();
      await expect(page.locator('h1').first()).toBeFocused();
    }
    expect(phone.errors).toEqual([]);
  } finally {
    await phone.close();
  }
});
