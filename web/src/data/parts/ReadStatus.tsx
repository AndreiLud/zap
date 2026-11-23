// Whether the version in play reads its opponents right now (DATA-SPEC 4.5, status line): from
// /api/live (`adapt`), or from what the build served until it answers. With reading off, the line
// says why, from the explorer criterion: the test stopped it; or a version that read was rolled back
// to the one in play (facts-view served.rolledBack: which and when); or, while no version the cycle
// published has carried the reading (served.carried), it passed and is still not live, with the
// largest bound, what the tables play and that only the owner's adoption, the duel with reading on
// and the days with people put it live. The measurements that weigh
// against the test version are in the figures below (F8 and F9). With reading on and the cycle's
// summary showing a test window for the version in play, the line adds the window's end and the
// share of quick play matches kept on the previous version. Never a hard-coded state
// (_local/m6/claims.md 3 and 13).

import { Link } from '../../components/common.tsx';
import { t } from '../../i18n.ts';
import { boundValue } from '../findings.ts';
import { td } from '../i18n-data.ts';
import { FACTS, READING, RULES, SERVED, allVerdicts, upperOf, useData } from '../load.ts';
import { goToPart } from './ChapterNav.tsx';

function Lamp({ on }: { on: boolean }) {
  return (
    <svg class={`dp-lamp${on ? ' is-on' : ''}`} viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="8.5" />
      {on ? <path d="M6 10.5l2.6 2.6L14 7.6" /> : <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" />}
    </svg>
  );
}

export function ReadStatus() {
  const { f, reads, served, summary } = useData();
  // In its test window with people, the cycle's summary names the version in play: its end and the
  // share of quick play matches kept on the previous version.
  const ab = reads && summary.kind === 'ready' ? summary.summary.ab : null;
  const c = READING.explorer?.criterion;
  const pass = c?.pass ?? null;
  const link = (
    <a href="#leitura-explorador" class="dp-link" onClick={(e) => goToPart('leitura-explorador', e)}>
      {t('data.read.whyLink')}
    </a>
  );
  let passed = null;
  const rb = SERVED.rolledBack;
  if (rb && rb.to === served) passed = t('data.read.rolled', { v: rb.version, date: f.date(rb.at) });
  else if (c && pass === true && !SERVED.carried) {
    // The largest one sided bound of every explorer judged, rounded away from the limit as F9 shows it.
    const b = boundValue(Math.max(...allVerdicts(c).map(upperOf)), c.requirement);
    // "A twin without reading" only for the bundled file the build checked (features v2-empty).
    const boot = FACTS.ai.bootstrapModel;
    const v = served === boot.version && boot.features === 'v2-empty' ? t('data.read.twinIs', { v: served }) : served;
    passed = td('data.read.pending', { link, up: f.per100(b.value / 100, b.digits), v, days: f.int(RULES.ab.days) });
  }
  return (
    <div class="dp-status" data-testid="read-status" data-reads={String(reads)}>
      <p class="dp-status__now">
        <Lamp on={reads} />
        <span>
          {reads ? (
            <>
              {td('data.read.on', {
                link: (
                  <Link to={{ name: 'you' }} class="dp-link">
                    {t('data.read.link')}
                  </Link>
                ),
              })}
              {ab?.version === served ? ` ${t('data.read.window', { date: f.date(ab.until), share: f.pct(ab.share, 0), v: ab.control })}` : null}
            </>
          ) : (
            <>
              {t('data.read.off')} {pass === false ? td('data.read.why', { link }) : passed}
            </>
          )}
        </span>
      </p>
      <p class="dp-status__opt">{t('data.read.optout')}</p>
    </div>
  );
}
