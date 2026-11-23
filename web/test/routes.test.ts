// The site's addresses (web/src/routes.ts): every route in both languages and back, the room on
// the start address, slugs of the other language, the files the prerender writes.

import { describe, expect, it } from 'vitest';
import { INDEXED, PATH_ROUTES, ROUTE_PATHS, cleanCode, outputFile, pathFor, routeFromPath, withLang } from '../src/routes.ts';

describe('routes', () => {
  it('maps each page to its address in both languages and back', () => {
    for (const name of PATH_ROUTES) {
      const paths = ROUTE_PATHS[name];
      expect(routeFromPath(paths.pt, '')).toEqual({ name, lang: 'pt' });
      expect(routeFromPath(paths.en, '')).toEqual({ name, lang: 'en' });
      expect(pathFor({ name }, 'pt')).toBe(paths.pt);
      expect(pathFor({ name }, 'en')).toBe(paths.en);
      if (paths.pt !== '/') expect(routeFromPath(`${paths.pt}/`, '')).toEqual({ name, lang: 'pt' });
    }
    expect(ROUTE_PATHS.privacy).toEqual({ pt: '/privacidade', en: '/en/privacy' });
    expect(ROUTE_PATHS.terms).toEqual({ pt: '/termos', en: '/en/terms' });
    expect(ROUTE_PATHS.verify).toEqual({ pt: '/como-verificamos', en: '/en/how-we-verify' });
    expect(ROUTE_PATHS.you).toEqual({ pt: '/voce', en: '/en/you' });
    expect(ROUTE_PATHS.vs).toEqual({ pt: '/voce-contra-o-zap', en: '/en/you-vs-zap' });
    expect(ROUTE_PATHS.play).toEqual({ pt: '/jogar', en: '/en/play' });
    expect(ROUTE_PATHS.guided).toEqual({ pt: '/jogar/guiada', en: '/en/play/guided' });
  });

  it('opens a room on the start address with a valid code, in either language', () => {
    expect(routeFromPath('/', '?sala=ABCDE')).toEqual({ name: 'room', code: 'ABCDE', lang: 'pt' });
    expect(routeFromPath('/en/', '?sala=abcde')).toEqual({ name: 'room', code: 'ABCDE', lang: 'en' });
    expect(routeFromPath('/en', '?sala=ABCDE')).toEqual({ name: 'room', code: 'ABCDE', lang: 'en' });
    // 0, O, 1, I and L are not in the code alphabet: an invalid code is the start page.
    expect(routeFromPath('/', '?sala=ABCD0')).toEqual({ name: 'start', lang: 'pt' });
    expect(routeFromPath('/', '')).toEqual({ name: 'start', lang: 'pt' });
    expect(pathFor({ name: 'room', code: 'ABCDE' }, 'pt')).toBe('/?sala=ABCDE');
    expect(pathFor({ name: 'room', code: 'ABCDE' }, 'en')).toBe('/en/?sala=ABCDE');
    // The room keeps its address only on the start path.
    expect(routeFromPath('/jogar', '?sala=ABCDE')).toEqual({ name: 'play', lang: 'pt' });
  });

  it('accepts either slug under either prefix, and anything else is not found', () => {
    expect(routeFromPath('/en/jogar', '')).toEqual({ name: 'play', lang: 'en' });
    expect(routeFromPath('/en/privacidade', '')).toEqual({ name: 'privacy', lang: 'en' });
    expect(routeFromPath('/privacy', '')).toEqual({ name: 'privacy', lang: 'pt' });
    expect(routeFromPath('/play/guided', '')).toEqual({ name: 'guided', lang: 'pt' });
    expect(routeFromPath('/nada', '')).toEqual({ name: 'notFound', lang: 'pt' });
    expect(routeFromPath('/en/nothing', '')).toEqual({ name: 'notFound', lang: 'en' });
    expect(routeFromPath('/jogar/outra', '')).toEqual({ name: 'notFound', lang: 'pt' });
    expect(withLang('/nada', 'en')).toBe('/en/nada');
    expect(withLang('/en/nothing', 'pt')).toBe('/nothing');
    expect(withLang('/en/', 'pt')).toBe('/');
    expect(withLang('/', 'en')).toBe('/en/');
  });

  it('cleans room codes as people type them', () => {
    expect(cleanCode(' ab-cde ')).toBe('ABCDE');
    expect(cleanCode('ABCD')).toBeNull();
    expect(cleanCode('ABCDEF')).toBeNull();
  });

  it('names one output file per address', () => {
    expect(outputFile('/')).toBe('index.html');
    expect(outputFile('/en/')).toBe('en/index.html');
    expect(outputFile('/jogar')).toBe('jogar.html');
    expect(outputFile('/en/play/guided')).toBe('en/play/guided.html');
    const files = PATH_ROUTES.flatMap((r) => [outputFile(ROUTE_PATHS[r].pt), outputFile(ROUTE_PATHS[r].en)]);
    expect(files).toHaveLength(20);
    expect(new Set(files).size).toBe(20);
  });

  it('indexes the public pages only (the data page since M7)', () => {
    expect([...INDEXED].sort()).toEqual(['data', 'guided', 'play', 'privacy', 'rules', 'start', 'terms', 'verify']);
  });
});
