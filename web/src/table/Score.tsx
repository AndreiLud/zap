// The score band (CLIENT-SPEC 11.8): team chip and name, the big number and twelve thin marks per
// team (ours fill from the left, theirs from the right, both toward "to 12" in the middle), the
// games of a best of three, and the connection badge at the end. The "+N" chip shows next to the
// number while the points are counted; new marks fill one by one (all at once above 4 points).

import { useRef } from 'preact/hooks';
import { ConnStatus } from '../components/common.tsx';
import { TeamChip } from '../components/pieces.tsx';
import { teamLabel } from '../game-text.ts';
import { t } from '../i18n.ts';
import { store, useStoreSelect } from '../store.ts';
import type { Model } from './model.ts';
import type { Scene } from './motion.ts';
import { COUNT_FLIGHT, MARKS_AT_ONCE, MARK_STEP } from './timing.ts';

function ConnBadge() {
  useStoreSelect((s) => `${s.conn}:${s.lang}`);
  return <ConnStatus s={store.get()} />;
}

interface Fresh {
  key: string;
  /** Marks that just filled, per side: [from, to). */
  us: [number, number];
  them: [number, number];
}

function Side(p: { side: 'us' | 'them'; name: string; points: number; fresh: [number, number]; chip: number | null; motion: boolean }) {
  const [from, to] = p.fresh;
  const allAtOnce = to - from > MARKS_AT_ONCE;
  return (
    <div class="score__side" data-team={p.side}>
      <span class="score__name">
        <TeamChip team={p.side} />
        <span>{p.name}</span>
      </span>
      <span class="score__num">
        <span class={`score__digit${p.motion && to > from ? ' is-bumped' : ''}`} key={`${p.side}${p.points}`}>
          {p.points}
        </span>
        {p.chip !== null ? <span class="score__chip">+{p.chip}</span> : null}
      </span>
      <ol class="score-marks">
        {Array.from({ length: 12 }, (_, i) => {
          const full = i < p.points;
          const isNew = p.motion && full && i >= from && i < to;
          return (
            <li
              key={i}
              class={`${full ? 'is-full' : ''}${isNew ? ' is-new' : ''}`}
              style={isNew ? { '--mark-delay': `${COUNT_FLIGHT + (allAtOnce ? 0 : (i - from) * MARK_STEP)}ms` } : undefined}
            />
          );
        })}
      </ol>
    </div>
  );
}

export function ScoreBand({ m, scene }: { m: Model; scene: Scene }) {
  const v = m.v;
  const us = v.score[m.team];
  const them = v.score[1 - m.team];
  const key = `${v.matchNo}:${us}:${them}`;
  const fresh = useRef<Fresh>({ key, us: [us, us], them: [them, them] });
  const last = useRef<[number, number]>([us, them]);
  if (fresh.current.key !== key) {
    const [a, b] = last.current;
    fresh.current = { key, us: us > a ? [a, us] : [us, us], them: them > b ? [b, them] : [them, them] };
    last.current = [us, them];
  }
  const usName = teamLabel(m.names, m.team);
  const themName = teamLabel(m.names, 1 - m.team);
  const chip = scene.chip;
  return (
    <section class="score" data-testid="score" aria-label={t('score.aria', { us, them, usName, themName })}>
      <div class="score__row" aria-hidden="true">
        <Side side="us" name={usName} points={us} fresh={fresh.current.us} chip={chip && chip.team === m.team ? chip.points : null} motion={scene.motion} />
        <span class="score__goal">{t('board.score.goal')}</span>
        <Side side="them" name={themName} points={them} fresh={fresh.current.them} chip={chip && chip.team !== m.team ? chip.points : null} motion={scene.motion} />
      </div>
      {v.options.bestOf === 3 ? <p class="score__games">{t('score.games', { us: v.games[m.team], them: v.games[1 - m.team] })}</p> : null}
      <ConnBadge />
    </section>
  );
}
