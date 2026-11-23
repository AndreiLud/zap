// The number formats of the data pages (DATA-SPEC 3.5), every example in both languages, plus the
// helpers around them: digits by interval width, uncertainty words, the Wilson interval, the
// pieces of a template with tap terms, and the chart keyboard and pointer rules.

import { describe, expect, it } from 'vitest';
import { digitsFor, MINUS, type Format } from '../src/data/format.ts';
import { DATA_TERMS, pieces } from '../src/data/glossary.ts';
import { nearestMark, nextMark, sayMark, type MarkSet } from '../src/data/charts/keyboard.ts';
import { linear, stepTicks, symmetricDomain } from '../src/data/charts/scales.ts';
import { apart, excludes, likely, realOrNoise, wilson } from '../src/data/words.ts';
import { DICT, F, plain, textFor } from './data-text.ts';

describe('format (DATA-SPEC 3.5)', () => {
  const cases: [string, (f: Format) => string, string, string][] = [
    ['pct(0.796, 1)', (f) => f.pct(0.796, 1), '79,6%', '79.6%'],
    ['pct(0.5, 0)', (f) => f.pct(0.5, 0), '50%', '50%'],
    ['int(4000)', (f) => f.int(4000), '4.000', '4,000'],
    ['big(3099598)', (f) => f.big(3099598), '3,1 milhões', '3.1 million'],
    ['big(999999)', (f) => f.big(999999), '999.999', '999,999'],
    ['big(1000000)', (f) => f.big(1_000_000), '1 milhão', '1 million'],
    ['range(0.788, 0.805)', (f) => f.range(0.788, 0.805), 'de 78,8% a 80,5%', 'from 78.8% to 80.5%'],
    ['per100(0.0123)', (f) => f.per100(0.0123), '1,2 partida em cada 100', '1.2 games in every 100'],
    ['per100(0.01)', (f) => f.per100(0.01), '1 partida em cada 100', '1 game in every 100'],
    ['per100(0.025)', (f) => f.per100(0.025), '2,5 partidas em cada 100', '2.5 games in every 100'],
    ['per100(0.00312)', (f) => f.per100(0.00312), '0,3 partida em cada 100', '0.3 games in every 100'],
    ['per100(0.01046, 2)', (f) => f.per100(0.01046, 2), '1,05 partida em cada 100', '1.05 games in every 100'],
    ['per100(0.0015, 2)', (f) => f.per100(0.0015, 2), '0,15 partida em cada 100', '0.15 games in every 100'],
    ['per100Range(0.00009, 0.00291, 2)', (f) => f.per100Range(0.00009, 0.00291, 2), 'de 0,01 a 0,29 partida em cada 100', 'from 0.01 to 0.29 games in every 100'],
    ['per100Range(0.0019, 0.0043)', (f) => f.per100Range(0.0019, 0.0043), 'de 0,2 a 0,4 partida em cada 100', 'from 0.2 to 0.4 games in every 100'],
    ['per100Range(-0.0084, 0.035)', (f) => f.per100Range(-0.0084, 0.035), `de ${MINUS}0,8 a 3,5 partidas em cada 100`, `from ${MINUS}0.8 to 3.5 games in every 100`],
    ['signed(-0.4)', (f) => f.signed(-0.4), `${MINUS}0,4`, `${MINUS}0.4`],
    ['signed(1.2)', (f) => f.signed(1.2), '+1,2', '+1.2'],
    ['signed(-0.04)', (f) => f.signed(-0.04), '0,0', '0.0'],
    ['date(21 Nov 2026)', (f) => f.date(Date.UTC(2026, 10, 21, 23, 15)), '21/11/2026', '21 Nov 2026'],
    ['ms(0.41)', (f) => f.ms(0.41), '0,4 ms', '0.4 ms'],
    ['ms(12.3)', (f) => f.ms(12.3), '12 ms', '12 ms'],
    ['kb(184976)', (f) => f.kb(184976), '185 KB', '185 KB'],
    ['inTen(0.796)', (f) => f.inTen(0.796), '8 de cada 10', '8 out of 10'],
    ['tenths(3)', (f) => f.tenths(3), '3 de cada 10', '3 out of 10'],
    ['score(12, 7)', (f) => f.score(12, 7), '12 a 7', '12 to 7'],
    ['num(-1.66, 2)', (f) => f.num(-1.66, 2), `${MINUS}1,66`, `${MINUS}1.66`],
  ];
  for (const [name, fn, pt, en] of cases) {
    it(name, () => {
      expect(plain(fn(F.pt))).toBe(pt);
      expect(plain(fn(F.en))).toBe(en);
    });
  }

  it('never writes a hyphen as a minus or a dash in a range', () => {
    for (const f of [F.pt, F.en]) {
      for (const s of [f.signed(-3.2), f.num(-0.5), f.per100(-0.012), f.range(0.1, 0.2), f.per100Range(-0.01, 0.02)]) {
        expect(s).not.toMatch(/[-\u2013\u2014]/);
      }
    }
  });

  it('picks one decimal when the 95% half width is under one point, else none', () => {
    expect(digitsFor(0.0042)).toBe(1);
    expect(digitsFor(0.0099)).toBe(1);
    expect(digitsFor(0.012)).toBe(0);
    expect(digitsFor(null)).toBe(1);
  });
});

describe('uncertainty in words (DATA-SPEC 3.6)', () => {
  it('says an interval that leaves the reference out is real, else noise', () => {
    expect(realOrNoise({ lo: 0.0019, hi: 0.0043 })).toBe('data.u.real');
    expect(realOrNoise({ lo: -0.0084, hi: 0.0049 })).toBe('data.u.noise');
    expect(realOrNoise({ lo: 0.488, hi: 0.505 }, 0.5)).toBe('data.u.noise');
    expect(excludes({ lo: 0.51, hi: 0.53 }, 0.5)).toBe(true);
    expect(apart({ lo: 0.1, hi: 0.2 }, { lo: 0.21, hi: 0.3 })).toBe(true);
    expect(apart({ lo: 0.1, hi: 0.2 }, { lo: 0.2, hi: 0.3 })).toBe(false);
  });

  it('writes the likely sentence in both languages', () => {
    const e = { mean: 0.796, lo: 0.788, hi: 0.805 };
    expect(likely(textFor('pt'), F.pt, e)).toBe('79,6%, provavelmente entre 78,8% e 80,5%.');
    expect(likely(textFor('en'), F.en, e)).toBe('79.6%, likely between 78.8% and 80.5%.');
  });

  it('computes the Wilson interval', () => {
    const w = wilson(40, 100);
    expect(w.mean).toBeCloseTo(0.4, 10);
    expect(w.lo).toBeCloseTo(0.3094, 3);
    expect(w.hi).toBeCloseTo(0.4980, 3);
    const zero = wilson(0, 10);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0.25);
  });
});

describe('templates with tap terms (DATA-SPEC 3.4)', () => {
  it('splits text, variables and terms', () => {
    expect(pieces('A cada {every} {t:etapas} de treino.')).toEqual([
      { kind: 'text', text: 'A cada ' },
      { kind: 'var', name: 'every' },
      { kind: 'text', text: ' ' },
      { kind: 'term', id: 'etapas' },
      { kind: 'text', text: ' de treino.' },
    ]);
  });

  it('every data term has a name and a definition in both languages', () => {
    for (const id of DATA_TERMS) {
      for (const lang of ['pt', 'en'] as const) {
        expect(DICT[lang][`data.term.${id}.name`], `${lang} ${id}.name`).toBeTruthy();
        expect(DICT[lang][`data.term.${id}.def`], `${lang} ${id}.def`).toBeTruthy();
      }
    }
  });

  it('every {t:id} in the data strings names a known term', () => {
    const game = ['manilha', 'vira', 'mao', 'onze', 'dez', 'rodada', 'correr'];
    for (const [k, v] of Object.entries(DICT.pt).filter(([k]) => k.startsWith('data.'))) {
      for (const p of pieces(v)) if (p.kind === 'term') expect([...DATA_TERMS, ...game], k).toContain(p.id);
    }
  });
});

describe('chart keyboard and pointer (DATA-SPEC 3.3)', () => {
  const rows: MarkSet = {
    mode: 'y',
    marks: [0, 1, 2].map((i) => ({ x: 100 + i * 10, y: 20 + i * 30, value: `${i}`, label: `row ${i}` })),
  };
  it('moves with arrows, jumps with Home and End, clears with Escape', () => {
    expect(nextMark('ArrowDown', -1, 3, 'y')).toBe(0);
    expect(nextMark('ArrowDown', 0, 3, 'y')).toBe(1);
    expect(nextMark('ArrowDown', 2, 3, 'y')).toBe(2);
    expect(nextMark('ArrowUp', 0, 3, 'y')).toBe(0);
    expect(nextMark('End', 0, 3, 'y')).toBe(2);
    expect(nextMark('Home', 2, 3, 'y')).toBe(0);
    expect(nextMark('Escape', 1, 3, 'y')).toBe('clear');
    expect(nextMark('Tab', 1, 3, 'y')).toBeNull();
  });
  it('moves cell by cell in a grid', () => {
    // 3 columns, 2 rows
    expect(nextMark('ArrowRight', 0, 6, 'grid', 3)).toBe(1);
    expect(nextMark('ArrowRight', 2, 6, 'grid', 3)).toBe(2);
    expect(nextMark('ArrowDown', 1, 6, 'grid', 3)).toBe(4);
    expect(nextMark('ArrowDown', 4, 6, 'grid', 3)).toBe(4);
    expect(nextMark('ArrowUp', 4, 6, 'grid', 3)).toBe(1);
    expect(nextMark('ArrowLeft', 3, 6, 'grid', 3)).toBe(3);
  });
  it('finds the nearest row within 24 px and the nearest x within 48 px', () => {
    expect(nearestMark(rows, 0, 52)).toBe(1);
    expect(nearestMark(rows, 0, 120)).toBe(-1);
    const line: MarkSet = { mode: 'x', marks: rows.marks };
    expect(nearestMark(line, 118, 999)).toBe(2);
    expect(nearestMark(line, 200, 0)).toBe(-1);
    const grid: MarkSet = { mode: 'grid', marks: [{ x: 10, y: 10, hw: 10, hh: 10, value: '', label: '' }] };
    expect(nearestMark(grid, 15, 5)).toBe(0);
    expect(nearestMark(grid, 25, 5)).toBe(-1);
  });
  it('says a mark as one sentence', () => {
    expect(sayMark({ x: 0, y: 0, value: '79,6%', label: 'Zap contra o jogador de regras', detail: ['provavelmente entre 78,8% e 80,5%'] })).toBe(
      'Zap contra o jogador de regras: 79,6%. provavelmente entre 78,8% e 80,5%.',
    );
  });
});

describe('chart scales', () => {
  it('maps and inverts linearly, without clamping', () => {
    const x = linear([0, 1], [10, 110]);
    expect(x(0.5)).toBe(60);
    expect(x(1.2)).toBeCloseTo(130, 10);
    expect(x.invert(60)).toBeCloseTo(0.5, 10);
    expect(linear([2, 2], [0, 100])(5)).toBe(0);
  });
  it('steps ticks without a negative zero and widens symmetric domains', () => {
    expect(stepTicks([0, 240], 40)).toEqual([0, 40, 80, 120, 160, 200, 240]);
    expect(Object.is(stepTicks([-0.0000001, 1], 0.5)[0], -0)).toBe(false);
    expect(symmetricDomain([0.43, -1.34, 1.15], 1, 2)).toEqual([-2, 2]);
    expect(symmetricDomain([3.35], 1, 2)).toEqual([-4, 4]);
  });
});
