// The cover of the data page (DATA-SPEC 4.0): the kicker, the title the data supports (h1Title:
// "learns from the people who play" only once a promoted version trained on people's games), one
// line, the page's tile strip and the live counters.

import { t } from '../../i18n.ts';
import { usePageFocus } from '../../page-focus.ts';
import { TileStrip } from '../../pages/Doc.tsx';
import { h1Title, say } from '../findings.ts';
import { useData } from '../load.ts';
import { LiveStrip } from './LiveStrip.tsx';

export function Cover() {
  const d = useData();
  const title = usePageFocus('data');
  const summary = d.summary.kind === 'ready' ? d.summary.summary : null;
  return (
    <header id="capa" class="dp-cover">
      <div class="dp-cover__text">
        <p class="dp-kicker">{t('data.kicker')}</p>
        <h1 ref={title} tabIndex={-1}>
          {say(d.f, h1Title(summary))}
        </h1>
        <p class="dp-lead">{t('data.lead')}</p>
        <TileStrip seed={1957} />
      </div>
      <LiveStrip />
    </header>
  );
}
