// Small drawings of the Play page and the lobby (prototype jogar.js miniMesa and the loop glyphs).
// Decorative: aria-hidden; the text around them says the same thing. Colors come from classes in
// styles/play.css and styles/lobby.css (team colors follow the theme).

export type SpotKind = 'us' | 'them' | 'open';
export type SpotPos = 'bottom' | 'right' | 'top' | 'left';
export interface Spot {
  kind: SpotKind;
  pos: SpotPos;
  /** Your own place: a ring around the dot. */
  you?: boolean;
}

const AT: Record<SpotPos, [number, number]> = { bottom: [22, 38.5], right: [38.5, 22], top: [22, 5.5], left: [5.5, 22] };

const f = (pt: [number, number]) => pt.map((v) => v.toFixed(2)).join(' ');

/** "Them" is a triangle pointing at the table, the shape of the team chip; "us" a disc; an open seat a dashed ring. */
function SpotShape({ spot }: { spot: Spot }) {
  const [x, y] = AT[spot.pos];
  if (spot.kind === 'open') return <circle class="mini-table__open" cx={x} cy={y} r="4.2" />;
  if (spot.kind === 'them') {
    const len = Math.hypot(22 - x, 22 - y);
    const dx = (22 - x) / len;
    const dy = (22 - y) / len;
    const tip: [number, number] = [x + dx * 5, y + dy * 5];
    const base: [number, number] = [x - dx * 4.2, y - dy * 4.2];
    const a: [number, number] = [base[0] - dy * 5.4, base[1] + dx * 5.4];
    const b: [number, number] = [base[0] + dy * 5.4, base[1] - dx * 5.4];
    return <path class="mini-table__them" d={`M${f(tip)}L${f(a)}L${f(b)}Z`} />;
  }
  return (
    <>
      {spot.you ? <circle class="mini-table__you" cx={x} cy={y} r="6.6" /> : null}
      <circle class="mini-table__us" cx={x} cy={y} r="4.8" />
    </>
  );
}

/** A tiny table seen from above with a mark per seat: you at the bottom, your partner on top. */
export function MiniTable({ spots, class: cls }: { spots: readonly Spot[]; class?: string }) {
  return (
    <svg class={`mini-table${cls ? ` ${cls}` : ''}`} viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <rect class="mini-table__table" x="12.5" y="12.5" width="19" height="19" rx="4" />
      {spots.map((s) => (
        <SpotShape key={s.pos} spot={s} />
      ))}
    </svg>
  );
}

/** The three mode tiles: 2 against 2, 1 against 1, and a room with an open seat. */
export const MODE_SPOTS: Record<'dupla' | 'solo' | 'sala', readonly Spot[]> = {
  dupla: [
    { kind: 'us', pos: 'bottom' },
    { kind: 'us', pos: 'top' },
    { kind: 'them', pos: 'left' },
    { kind: 'them', pos: 'right' },
  ],
  solo: [
    { kind: 'us', pos: 'bottom' },
    { kind: 'them', pos: 'top' },
  ],
  sala: [
    { kind: 'us', pos: 'bottom' },
    { kind: 'us', pos: 'top' },
    { kind: 'them', pos: 'left' },
    { kind: 'open', pos: 'right' },
  ],
};

/** A check mark drawn as SVG (the fonts have no U+2713), for the chosen mode tile. */
export function CheckMark({ class: cls }: { class?: string }) {
  return (
    <svg class={cls} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <circle class="check-mark__disc" cx="7" cy="7" r="7" />
      <path class="check-mark__tick" d="M4 7.2l2 2 4-4.4" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

/** The four steps of the learning loop, each a glyph in a 24 unit box drawn in currentColor. */
export function LoopGlyph({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {step === 1 ? (
        <>
          <rect x="4" y="5" width="9" height="13" rx="1.6" transform="rotate(-8 8.5 11.5)" {...STROKE} />
          <rect x="11" y="6" width="9" height="13" rx="1.6" transform="rotate(8 15.5 12.5)" fill="currentColor" />
        </>
      ) : null}
      {step === 2 ? <path d="M5 6.5h2M10 6.5h9M5 12h2M10 12h9M5 17.5h2M10 17.5h6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /> : null}
      {step === 3 ? (
        <>
          <g stroke="currentColor" stroke-width="1.4" opacity=".75">
            <path d="M5 5l14 7M5 12h14M5 19l14-7M5 5h14M5 19h14" />
          </g>
          <g fill="currentColor">
            <circle cx="5" cy="5" r="2.4" />
            <circle cx="5" cy="12" r="2.4" />
            <circle cx="5" cy="19" r="2.4" />
            <circle cx="19" cy="5" r="2.4" />
            <circle cx="19" cy="12" r="2.4" />
            <circle cx="19" cy="19" r="2.4" />
          </g>
        </>
      ) : null}
      {step === 4 ? (
        <>
          <path d="M2.5 18.5V8a10.5 10.5 0 0 1 8.5 10.5Z" fill="currentColor" />
          <path d="M21.5 18.5H13L21.5 8Z" fill="currentColor" />
          <path d="M12 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" fill="currentColor" />
          <path d="M2 21h20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </>
      ) : null}
    </svg>
  );
}
