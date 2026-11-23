// A hero number (DATA-SPEC F17, P1): when the story is one number, the number is the chart. The
// value leads in the display face, the label says what it counts, and the detail says its interval
// in words (words.ts likely()) or that the sample is still small. An optional bar shows the share
// against 50% so the eye has a reference without a second axis.

import type { ComponentChildren } from 'preact';
import type { Series } from './scales.ts';

export interface HeroProps {
  value: string;
  label: ComponentChildren;
  detail?: ComponentChildren;
  /** A share in 0 to 1 to draw as a thin bar with its interval; omit for none. */
  share?: { mean: number; lo?: number; hi?: number } | null;
  series?: Series;
}

export function Hero(p: HeroProps) {
  const s = p.series ?? 3;
  const sh = p.share;
  return (
    <div class="hero">
      <p class="hero__value">{p.value}</p>
      <p class="hero__label">{p.label}</p>
      {sh ? (
        <svg class="hero__bar" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <rect class="hero__track" x="0" y="4" width="200" height="6" rx="3" />
          <rect class={`hero__fill bar--s${s}`} x="0" y="4" width={Math.max(0, Math.min(200, sh.mean * 200)).toFixed(1)} height="6" rx="3" />
          {sh.lo !== undefined && sh.hi !== undefined ? (
            <rect class="hero__ci" x={(sh.lo * 200).toFixed(1)} y="1" width={Math.max(1, (sh.hi - sh.lo) * 200).toFixed(1)} height="12" rx="2" />
          ) : null}
          <line class="hero__half" x1="100" x2="100" y1="0" y2="14" />
        </svg>
      ) : null}
      {p.detail ? <p class="hero__detail">{p.detail}</p> : null}
    </div>
  );
}
