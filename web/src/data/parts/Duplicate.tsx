// F4 "As mesmas cartas, duas vezes" (DATA-SPEC 4.4): the duplicate format as two small tables with
// the same lopsided deal; only the team mats change places. Static. After this block the page says
// {t:dup} instead of explaining it again.

import { Fragment } from 'preact';
import { TeamChip } from '../../components/pieces.tsx';
import { t } from '../../i18n.ts';
import { DUP_DEAL, MiniTable } from './MiniTable.tsx';

const GAMES = [
  { key: 'one', caption: 'data.dup.1', line: 'data.dup.1p', teams: { n: 'us', s: 'us', e: 'them', w: 'them' } },
  { key: 'two', caption: 'data.dup.2', line: 'data.dup.2p', teams: { n: 'them', s: 'them', e: 'us', w: 'us' } },
] as const;

export function Duplicate() {
  return (
    <section id="duplicado" class="dp-block" aria-labelledby="duplicado-t">
      <h3 id="duplicado-t" class="figure__title">
        {t('data.dup.h')}
      </h3>
      <p class="dp-sub">{t('data.dup.p')}</p>
      <div class="dp-dup">
        {GAMES.map((g, i) => (
          <Fragment key={g.key}>
            {i === 1 ? (
              <span class="dp-dup__swap" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
            ) : null}
            <figure class="dp-mini">
              <figcaption>
                <b>{t(g.caption)}</b>
                <span>{t(g.line)}</span>
              </figcaption>
              <MiniTable deal={DUP_DEAL} teams={g.teams} />
            </figure>
          </Fragment>
        ))}
      </div>
      <ul class="dp-dup__key">
        <li>
          <TeamChip team="us" />
          <span>{t('data.dup.zap')}</span>
        </li>
        <li>
          <TeamChip team="them" />
          <span>{t('data.dup.riv')}</span>
        </li>
      </ul>
      <p class="dp-dup__sum">{t('data.dup.sum')}</p>
    </section>
  );
}
