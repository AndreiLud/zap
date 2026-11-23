// The chart colors of DATA-SPEC 3.1 as numbers, for the rules that need them in code: which ink a
// heatmap label wears on each step of the ramps, and the contrast checks of
// web/test/data-contrast.test.ts. styles/data.css holds the same values as custom properties; the
// test reads that file and fails when the two disagree.

export type Theme = 'light' | 'dark';

export const SURFACE: Record<Theme, string> = { light: '#FBF8F2', dark: '#1A1D24' };
export const INK: Record<Theme, string> = { light: '#17181C', dark: '#EFE8DA' };
export const INK_2: Record<Theme, string> = { light: '#4B4A50', dark: '#A8A397' };
export const SERIES: Record<Theme, [string, string, string]> = {
  light: ['#2F4FC0', '#B5531F', '#008A6E'],
  dark: ['#6A80EE', '#D0652F', '#1F9E83'],
};
/** The middle segment of a stacked bar (ties): a grey that still reaches 3:1 on the surface. */
export const NEUTRAL: Record<Theme, string> = { light: '#8A857C', dark: '#7A808C' };
/** Heatmap steps, light to strong. */
export const RAMP: Record<Theme, [string, string, string, string, string]> = {
  light: ['#9AABE9', '#7A90DE', '#5571CF', '#3653B8', '#1F3A92'],
  dark: ['#3E4C8E', '#4E64B6', '#6A84DD', '#91A6F1', '#BCC9FB'],
};

/** The two inks a label inside a cell may wear, in both themes: the dark ink and white. */
export const LABEL_INKS = { ink: '#17181C', white: '#FFFFFF' } as const;
export type LabelInk = keyof typeof LABEL_INKS;

/** The fixed cut points of the heatmaps (DATA-SPEC 4, F15): five steps. */
export const CUTS = [0.2, 0.35, 0.5, 0.65] as const;

/** WCAG relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG contrast ratio of two colors. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ink with the higher contrast on a cell, or null when neither reaches 4.5:1 (no label then). */
export function labelInk(cell: string): { ink: LabelInk | null; ratio: number } {
  const dark = contrast(cell, LABEL_INKS.ink);
  const white = contrast(cell, LABEL_INKS.white);
  const best: LabelInk = dark >= white ? 'ink' : 'white';
  const ratio = Math.max(dark, white);
  return { ink: ratio >= 4.5 ? best : null, ratio };
}

/** The step (1 to 5) of a value on the cut points. */
export function stepOf(value: number, cuts: readonly number[] = CUTS): number {
  let s = 1;
  for (const c of cuts) if (value >= c) s++;
  return s;
}
