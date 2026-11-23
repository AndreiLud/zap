// P4, abandons (DATA-SPEC 5.5): the count the server keeps (device.abandons of /api/me/data, the one
// the training weight reads), the rule in words with its floor (shared/weights.ts, the constant of
// the export's SQL) and the list of the matches the person left, from the records.

import { ABANDON_MAX_CUT } from '../../../../shared/weights.ts';
import { fmt } from '../../data/format.ts';
import { t, type Key } from '../../i18n.ts';
import { abandonedBy, modeOf, newestFirst, type PersonMatch } from '../history.ts';
import { modeName } from '../text.ts';

export function Abandons({ abandons, total, matches }: { abandons: number; total: number; matches: readonly PersonMatch[] }) {
  const f = fmt();
  const left = [...matches].filter(abandonedBy).sort(newestFirst);
  const key: Key = abandons <= 0 ? 'data.vs.p4.h.none' : total === 1 ? 'data.vs.p4.h.one' : 'data.vs.p4.h';
  return (
    <section id="vs-abandonos" class="doc__section vs-part" aria-labelledby="vs-abandonos-t" data-testid="vs-abandons">
      <h2 id="vs-abandonos-t">{t('data.vs.p4.title')}</h2>
      <p class="vs-stat" data-testid="vs-abandons-line">
        {t(key, { a: f.int(abandons), m: f.int(total) })}
      </p>
      <p>{t('data.vs.p4.rule', { floor: f.pct(1 - ABANDON_MAX_CUT, 0) })}</p>
      {left.length > 0 ? (
        <ul class="doc__list">
          {left.map((m) => (
            <li key={m.matchId}>{t('data.vs.p4.item', { date: f.date(m.record.endedAt, { local: true }), mode: modeName(modeOf(m.record)) })}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
