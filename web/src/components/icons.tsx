// Interface icons on a 24 unit grid with a 2 px stroke (prototype pecas.js ICONES, plus sound,
// report, mute, leave, eye and user drawn the same way). Decorative: aria-hidden, the text or the
// accessible name of the control around them says what they mean.

import type { ComponentChildren } from 'preact';

export type IconName =
  | 'menu'
  | 'close'
  | 'home'
  | 'play'
  | 'book'
  | 'data'
  | 'code'
  | 'portfolio'
  | 'arrow'
  | 'star'
  | 'refresh'
  | 'four-color'
  | 'sound'
  | 'report'
  | 'mute'
  | 'leave'
  | 'eye'
  | 'user';

const S = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

const DRAW: Record<IconName, () => ComponentChildren> = {
  menu: () => <path d="M4 7h16M4 12h16M4 17h11" {...S} />,
  close: () => <path d="M6 6l12 12M18 6 6 18" {...S} stroke-width={2.3} />,
  home: () => (
    <>
      <path d="M4 11 12 4l8 7M6 9.5V20h12V9.5" {...S} />
      <path d="M10 20v-5h4v5" {...S} />
    </>
  ),
  play: () => (
    <>
      <rect x="4" y="5" width="9" height="13" rx="1.6" transform="rotate(-8 8.5 11.5)" {...S} />
      <rect x="11" y="6" width="9" height="13" rx="1.6" transform="rotate(8 15.5 12.5)" fill="currentColor" />
    </>
  ),
  book: () => (
    <>
      <path d="M3 5.5C5.6 4.3 8.6 4.3 12 6v14c-3.4-1.7-6.4-1.7-9-.5Z" {...S} />
      <path d="M21 5.5c-2.6-1.2-5.6-1.2-9 .5v14c3.4-1.7 6.4-1.7 9-.5Z" fill="currentColor" />
    </>
  ),
  data: () => <path d="M4 20V11M10 20V5M16 20v-7M21 20H3" {...S} stroke-width={2.2} />,
  code: () => <path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5" {...S} stroke-width={2.2} />,
  portfolio: () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" {...S} />
      <path d="M3 12a9 9 0 0 1 9-9v9Z" fill="currentColor" />
      <path d="M21 12a9 9 0 0 1-9 9v-9Z" fill="currentColor" />
    </>
  ),
  arrow: () => <path d="M7 17 17 7M9 7h8v8" {...S} />,
  star: () => <path d="M12 2l3.3 8.7L24 12l-8.7 3.3L12 24l-3.3-8.7L0 12l8.7-3.3Z" fill="currentColor" />,
  refresh: () => <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5" {...S} />,
  // Four suits in a 2 by 2 grid, each in its four-color deck color.
  'four-color': () => (
    <>
      <g class="icon__them">
        <circle cx="4.4" cy="4.2" r="2.2" />
        <circle cx="7.6" cy="4.2" r="2.2" />
        <path d="M6 3.6 9.5 7 6 10.5 2.5 7Z" />
      </g>
      <g class="icon__us">
        <circle cx="18" cy="3.6" r="2.1" />
        <circle cx="15.7" cy="6.8" r="2.1" />
        <circle cx="20.3" cy="6.8" r="2.1" />
        <path d="M18 6.5l1.4 4h-2.8Z" />
      </g>
      <g fill="currentColor">
        <path d="M6 13.2 9.2 16.4 6 19.6 2.8 16.4Z" />
        <circle cx="4.5" cy="18" r="2" />
        <circle cx="7.5" cy="18" r="2" />
        <path d="M6 18.5l1.2 3.6H4.8Z" />
      </g>
      <path class="icon__ochre" d="M18 13.5 21.4 17.8 18 22 14.6 17.8Z" stroke="currentColor" stroke-width=".9" />
    </>
  ),
  sound: () => (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" {...S} />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" {...S} />
    </>
  ),
  report: () => (
    <>
      <path d="M5 21V4" {...S} />
      <path d="M5 4.5h11.5l-2.4 4 2.4 4H5" {...S} />
    </>
  ),
  mute: () => (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h-1" {...S} />
      <path d="M3 3l18 18" {...S} />
    </>
  ),
  leave: () => (
    <>
      <path d="M13 4H6v16h7" {...S} />
      <path d="M10.5 12H21M17.5 8.5 21 12l-3.5 3.5" {...S} />
    </>
  ),
  eye: () => (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" {...S} />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </>
  ),
  user: () => <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" {...S} />,
};

/** One icon. `arrow` is the small external link arrow; it gets the class "icon--arrow". */
export function Icon({ name, class: cls }: { name: IconName; class?: string }) {
  return (
    <svg class={`icon icon--${name}${cls ? ` ${cls}` : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {DRAW[name]()}
    </svg>
  );
}
