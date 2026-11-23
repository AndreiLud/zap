// The chart colors (DATA-SPEC 3.1 and 3.2): the heatmap label rule on every step of both ramps
// (the ink with the higher contrast, drawn only at 4.5:1 or more), the tokens of styles/data.css
// equal to charts/palette.ts in both themes, and the contrast of text and marks on the chart
// surface. The categorical trio and the ramps also passed the dataviz validator (CVD separation,
// lightness band, chroma floor) when they were chosen; this test keeps the measurable part.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrast, CUTS, INK, INK_2, LABEL_INKS, labelInk, NEUTRAL, RAMP, SERIES, stepOf, SURFACE, type Theme } from '../src/data/charts/palette.ts';

const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'data.css'), 'utf8');

/** The custom properties of `.data-root` in a theme: the first block for light, the one inside the dark media query for dark. */
function tokens(theme: Theme): Record<string, string> {
  const dark = css.indexOf('@media (prefers-color-scheme: dark)');
  const from = theme === 'light' ? css.indexOf('.data-root {') : css.indexOf('.data-root {', dark);
  const block = css.slice(from, css.indexOf('}', from));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim().toUpperCase();
  return out;
}

const THEMES: Theme[] = ['light', 'dark'];

describe('heatmap labels', () => {
  for (const theme of THEMES) {
    it(`every step of the ${theme} ramp gets a label ink at 4.5:1 or more, and data.css agrees`, () => {
      const tk = tokens(theme);
      RAMP[theme].forEach((step, i) => {
        const choice = labelInk(step);
        expect(choice.ink, `${theme} step ${i + 1} ${step}: best ratio ${choice.ratio.toFixed(2)}`).not.toBeNull();
        expect(choice.ratio).toBeGreaterThanOrEqual(4.5);
        expect(tk[`--hm-ink-${i + 1}`], `--hm-ink-${i + 1} in ${theme}`).toBe(LABEL_INKS[choice.ink!].toUpperCase());
        // The other ink would be worse (or as good) on this step.
        const other = choice.ink === 'ink' ? LABEL_INKS.white : LABEL_INKS.ink;
        expect(contrast(step, other)).toBeLessThanOrEqual(choice.ratio);
      });
    });
  }

  it('leaves a cell without a label when neither ink reaches 4.5:1', () => {
    expect(labelInk('#777777').ink).toBeNull();
    expect(labelInk('#FFFFFF').ink).toBe('ink');
    expect(labelInk('#000000').ink).toBe('white');
  });

  it('puts values on the fixed cut points', () => {
    expect(CUTS).toEqual([0.2, 0.35, 0.5, 0.65]);
    expect(stepOf(0.1)).toBe(1);
    expect(stepOf(0.2)).toBe(2);
    expect(stepOf(0.343)).toBe(2);
    expect(stepOf(0.5)).toBe(4);
    expect(stepOf(0.9)).toBe(5);
  });
});

describe('chart tokens', () => {
  for (const theme of THEMES) {
    it(`data.css holds the palette of palette.ts in the ${theme} theme`, () => {
      const tk = tokens(theme);
      expect(tk['--chart-surface']).toBe(SURFACE[theme]);
      expect(tk['--chart-ink']).toBe(INK[theme]);
      expect(tk['--chart-ink-2']).toBe(INK_2[theme]);
      expect(tk['--chart-neutral']).toBe(NEUTRAL[theme]);
      SERIES[theme].forEach((c, i) => expect(tk[`--series-${i + 1}`]).toBe(c));
      RAMP[theme].forEach((c, i) => expect(tk[`--seq-${i + 1}`]).toBe(c));
    });

    it(`text and marks keep their contrast on the ${theme} chart surface`, () => {
      const s = SURFACE[theme];
      expect(contrast(INK[theme], s)).toBeGreaterThanOrEqual(7);
      expect(contrast(INK_2[theme], s)).toBeGreaterThanOrEqual(4.5);
      for (const c of SERIES[theme]) expect(contrast(c, s), c).toBeGreaterThanOrEqual(3);
      expect(contrast(NEUTRAL[theme], s)).toBeGreaterThanOrEqual(3);
      // The ramp's light end still shows against the surface (the validator's ordinal floor).
      expect(contrast(RAMP[theme][0], s)).toBeGreaterThanOrEqual(2);
    });

    it(`the ${theme} ramp runs from light to strong on its surface`, () => {
      const r = RAMP[theme].map((c) => contrast(c, SURFACE[theme]));
      for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThan(r[i - 1]);
    });
  }
});
