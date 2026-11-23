// The personal rating band (DATA-SPEC 5.3): one horizontal scale with the six characters of the
// version in play at their anchors (avatar and name; characters whose levels are close stack in
// rows above the axis, so names never collide and a tie reads as a tie), and the
// person's band from mu − 2 sigma to mu + 2 sigma in the people color, with "you" at mu. Marks
// are the characters and the person, in scale order.

import type { PersonaId } from '../../../../ai/src/personas.ts';
import { AvatarArt } from '../../deck/avatars.tsx';
import { t } from '../../i18n.ts';
import { useChart } from './Figure.tsx';
import type { Mark } from './keyboard.ts';
import { MarkShape, Txt } from './parts.tsx';
import { linear, r1, textWidth } from './scales.ts';

export interface RatingAnchorMark {
  id: PersonaId;
  name: string;
  mu: number;
}

export interface RatingBandProps {
  anchors: RatingAnchorMark[];
  /** The person's rating, or null before any rated game. */
  you: { mu: number; sigma: number } | null;
  domain: [number, number];
  /** Rating numbers (mu), for the tooltip and the table. */
  format: (v: number) => string;
  /** The band in words for the tooltip ("entre o Bento e a Iara"). */
  bandText?: string;
}

/** A domain that holds every anchor and the band, with a margin. */
export function ratingDomain(mus: readonly number[], you: { mu: number; sigma: number } | null): [number, number] {
  const vals = [...mus, ...(you ? [you.mu - 2 * you.sigma, you.mu + 2 * you.sigma] : [])];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(1, (hi - lo) * 0.06);
  return [Math.floor(lo - pad), Math.ceil(hi + pad)];
}

export function RatingBand(p: RatingBandProps) {
  const { width: W, fs, active, register } = useChart();
  const av = 22;
  const gap = 4;
  const x0 = av / 2 + 2;
  const x1 = W - av / 2 - 2;
  const X = linear(p.domain, [x0, x1]);
  const sorted = [...p.anchors].sort((a, b) => a.mu - b.mu);
  const rowH = Math.max(av, 15 * fs) + 6;
  // Each character sits at its exact x; characters that would collide (close levels, or a tie)
  // stack in rows above the axis, each with its name beside its avatar (to the left near the right
  // edge). A faint guide drops from each avatar to its tick on the axis.
  const rowEnd: number[] = [];
  const placed = sorted.map((a) => {
    const x = X(a.mu);
    const nw = textWidth(a.name, 12.5 * fs);
    const right = x + av / 2 + gap + nw <= W;
    const left = right ? x - av / 2 : x - av / 2 - gap - nw;
    const end = right ? x + av / 2 + gap + nw : x + av / 2;
    let row = rowEnd.findIndex((e) => left > e + 6);
    if (row < 0) {
      row = rowEnd.length;
      rowEnd.push(-Infinity);
    }
    rowEnd[row] = end;
    return { a, x, row, right };
  });
  const rows = Math.max(1, rowEnd.length);
  const lineY = rows * rowH + 8;
  const rowY = (row: number) => lineY - 8 - (row + 0.5) * rowH;
  const nodes: preact.JSX.Element[] = [];
  for (const pl of placed) {
    nodes.push(<line key={`g${pl.a.id}`} class="leader" x1={r1(pl.x)} x2={r1(pl.x)} y1={r1(rowY(pl.row) + av / 2)} y2={r1(lineY)} />);
  }
  nodes.push(<line key="axis" class="track track--strong" x1={r1(x0)} x2={r1(x1)} y1={r1(lineY)} y2={r1(lineY)} />);
  for (const pl of placed) {
    nodes.push(<line key={`t${pl.a.id}`} class={`tick${pl.a.id === 'zap' ? ' tick--strong' : ''}`} x1={r1(pl.x)} x2={r1(pl.x)} y1={r1(lineY - 5)} y2={r1(lineY + 5)} />);
  }
  const youY = lineY + 22;
  if (p.you) {
    const b0 = X(Math.max(p.domain[0], p.you.mu - 2 * p.you.sigma));
    const b1 = X(Math.min(p.domain[1], p.you.mu + 2 * p.you.sigma));
    nodes.push(<rect key="band" class="you-band" x={r1(b0)} y={r1(youY - 7)} width={r1(Math.max(2, b1 - b0))} height="14" rx="3" />);
  }
  const marks: Mark[] = [];
  const items = [
    ...placed.map((pl) => ({ kind: 'anchor' as const, mu: pl.a.mu, pl })),
    ...(p.you ? [{ kind: 'you' as const, mu: p.you.mu, pl: null }] : []),
  ].sort((a, b) => a.mu - b.mu);
  items.forEach((it, k) => {
    if (it.kind === 'anchor') {
      const { a, x, row, right } = it.pl!;
      const cy = rowY(row);
      nodes.push(
        <svg key={`a${a.id}`} class={`rating-avatar${active === k ? ' is-active' : ''}`} x={r1(x - av / 2)} y={r1(cy - av / 2)} width={av} height={av} viewBox="0 0 2 2">
          <AvatarArt id={a.id} />
        </svg>,
      );
      nodes.push(
        <Txt key={`n${a.id}`} x={right ? x + av / 2 + gap : x - av / 2 - gap} y={cy + 4.5 * fs} cls={`row-label rating-name${a.id === 'zap' ? ' row-label--strong' : ''}`} anchor={right ? 'start' : 'end'}>
          {a.name}
        </Txt>,
      );
      marks.push({ x, y: cy, value: p.format(a.mu), label: a.name });
    } else {
      const x = X(p.you!.mu);
      nodes.push(<MarkShape key="you" shape="diamond" x={x} y={youY} series={3} active={active === k} r={6} />);
      const w = textWidth(t('data.lab.you'), 13 * fs);
      nodes.push(
        <Txt key="youl" x={Math.max(0, Math.min(W - w, x - w / 2))} y={youY + 24 * fs} cls="row-label row-label--strong">
          {t('data.lab.you')}
        </Txt>,
      );
      marks.push({ x, y: youY, value: p.format(p.you!.mu), label: t('data.lab.you'), detail: p.bandText ? [p.bandText] : [] });
    }
  });
  register({ marks, mode: 'x' });
  const H = Math.ceil(youY + (p.you ? 32 * fs : 8));
  return (
    <svg class="plot" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" focusable="false" style={{ '--fs': String(fs) }}>
      {nodes}
    </svg>
  );
}
