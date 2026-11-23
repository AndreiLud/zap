// Waffles of 100 squares (DATA-SPEC F10): filled squares are the share, a ring marks the extra
// squares a second share reaches (a team of two), and each waffle is named directly under it with
// both numbers. Side by side when they fit, stacked on a narrow phone. One mark per waffle.

import './shares.css';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { Txt } from './parts.tsx';
import { r1 } from './scales.ts';

export interface WaffleItem {
  key: string;
  /** The waffle's name ("Paulista"). */
  label: string;
  /** Filled squares: round(100 share). */
  share: number;
  shareText: string;
  /** What the filled squares are ("in your hand"). */
  shareLabel: string;
  /** Ringed squares up to round(100 extra) (a team of two); optional. */
  extra?: number;
  extraText?: string;
  extraLabel?: string;
}

export function Waffle({ items }: { items: WaffleItem[] }) {
  const { width: W, fs, active, register } = useChart();
  const gap = 28;
  const perRow = W >= 2 * 200 + gap ? Math.min(items.length, Math.floor((W + gap) / (200 + gap))) : 1;
  const size = Math.min(240, (W - gap * (perRow - 1)) / perRow);
  const cell = size / 10;
  const textH = 44 * fs;
  const blockH = size + textH + 12;
  const nodes: preact.JSX.Element[] = [];
  const marks: Mark[] = [];
  items.forEach((it, i) => {
    const ox = (i % perRow) * (size + gap);
    const oy = Math.floor(i / perRow) * (blockH + 8);
    const filled = Math.round(it.share * 100);
    const ringed = it.extra === undefined ? filled : Math.round(it.extra * 100);
    for (let s = 0; s < 100; s++) {
      // Fill from the bottom left, row by row, so the share reads like a level.
      const col = s % 10;
      const row = 9 - Math.floor(s / 10);
      const x = ox + col * cell + 1;
      const y = oy + row * cell + 1;
      const kind = s < filled ? 'wf-on' : s < ringed ? 'wf-ring' : 'wf-off';
      nodes.push(<rect key={`${i}-${s}`} class={`${kind}${active === i ? ' is-active' : ''}`} x={r1(x)} y={r1(y)} width={r1(cell - 2)} height={r1(cell - 2)} rx="1.5" />);
    }
    const ty = oy + size + 16 * fs;
    nodes.push(
      <Txt key={`n${i}`} x={ox} y={ty} cls="group-label">
        {it.label}
      </Txt>,
    );
    nodes.push(
      <Txt key={`s${i}`} x={ox} y={ty + 17 * fs} cls="note note--strong">
        {`${it.shareText} ${it.shareLabel}`}
      </Txt>,
    );
    if (it.extraText && it.extraLabel) {
      nodes.push(
        <Txt key={`e${i}`} x={ox} y={ty + 33 * fs} cls="note">
          {`${it.extraText} ${it.extraLabel}`}
        </Txt>,
      );
    }
    marks.push({
      x: ox + size / 2,
      y: oy + size / 2,
      hw: size / 2,
      hh: size / 2,
      value: it.shareText,
      label: `${it.label}, ${it.shareLabel}`,
      detail: it.extraText && it.extraLabel ? [`${it.extraLabel}: ${it.extraText}`] : [],
    });
  });
  register({ marks, mode: 'grid', cols: perRow });
  const rows = Math.ceil(items.length / perRow);
  const H = Math.ceil(rows * (blockH + 8));
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}
