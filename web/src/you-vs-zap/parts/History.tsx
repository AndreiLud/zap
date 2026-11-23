// P1, the history (DATA-SPEC 5.2): how many quick games the person won against Zap (a hero number
// with its interval in words), the same by mode as a dot plot with Wilson whiskers, and every match
// in a table, newest first, 20 at a time, each with "Rever" (the replay viewer on that match).

import { useMemo, useRef, useState } from 'preact/hooks';
import { DotInterval, refEven } from '../../data/charts/DotInterval.tsx';
import { Figure, READY } from '../../data/charts/Figure.tsx';
import { Hero } from '../../data/charts/Hero.tsx';
import { fmt } from '../../data/format.ts';
import { tdText, td } from '../../data/i18n-data.ts';
import { apart, likely, sample, wilson, type Est } from '../../data/words.ts';
import { t, type Key } from '../../i18n.ts';
import { lazyComponent } from '../../lazy.tsx';
import { matchRow, newestFirst, soloScore, type ModeKey, type PersonMatch } from '../history.ts';
import { modeName, partnerText, seatsText } from '../text.ts';

export const PAGE_ROWS = 20;
/** Under this many games the share is said to be still unsteady (data.u.small). */
export const MIN_GAMES = 10;

const MatchReplay = lazyComponent(() => import('./MatchReplay.tsx').then((m) => m.MatchReplay));

/** The title of the by-mode figure: one mode, a mode ahead of every other beyond noise, or noise. */
export function modesTitle(rows: readonly { mode: ModeKey; est: Est }[]): { key: Key; mode?: ModeKey } {
  if (rows.length === 1) return { key: 'data.vs.p1.modes.one', mode: rows[0].mode };
  const best = [...rows].sort((a, b) => b.est.mean - a.est.mean)[0];
  if (best && rows.every((r) => r === best || (apart(best.est, r.est) && best.est.mean > r.est.mean))) return { key: 'data.vs.p1.modes.best', mode: best.mode };
  return { key: 'data.vs.p1.modes.noise' };
}

function ResultMark({ won }: { won: boolean }) {
  return (
    <span class={`vs-result vs-result--${won ? 'win' : 'loss'}`}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        {won ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
      </svg>
      {t(won ? 'data.vs.win' : 'data.vs.loss')}
    </span>
  );
}

export function History({ matches }: { matches: readonly PersonMatch[] }) {
  const f = fmt();
  const [shown, setShown] = useState(PAGE_ROWS);
  const [open, setOpen] = useState<string | null>(null);
  // "Fechar" unmounts the replay: the focus goes back to the "Rever" button that opened it.
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    setOpen(null);
    requestAnimationFrame(() => opener.current?.isConnected && opener.current.focus());
  };
  const score = useMemo(() => soloScore(matches), [matches]);
  const rows = useMemo(() => [...matches].sort(newestFirst).map((m) => ({ m, row: matchRow(m) })), [matches]);
  const { wins: w, matches: n } = score.total;
  const est = wilson(w, n);
  const titleKey: Key = n === 0 ? 'data.vs.p1.h.none' : n === 1 ? 'data.vs.p1.h.one' : 'data.vs.p1.h';
  const title = t(titleKey, { w: f.int(w), m: f.int(n) });
  const detail = n >= MIN_GAMES ? likely(t, f, est, 0) : t('data.u.small');

  const modes = score.modes.map((x) => ({ mode: x.mode, wins: x.wins, n: x.matches, est: wilson(x.wins, x.matches) }));
  const mt = modesTitle(modes);
  const modesText = tdText(mt.key, mt.mode ? { mode: modeName(mt.mode) } : {});
  const games = (k: number) => t(k === 1 ? 'data.vs.p1.games.one' : 'data.vs.p1.games.other', { n: f.int(k) });
  const openMatch = rows.find((r) => r.m.matchId === open)?.m ?? null;

  return (
    <section id="vs-historico" class="doc__section vs-part" aria-labelledby="vs-historico-t">
      <h2 id="vs-historico-t">{t('data.vs.p1.title')}</h2>
      {n > 0 ? (
        <Figure id="vs-placar" title={title} sub={t('data.vs.p1.sub')} summary={`${title} ${detail}`} plain state={READY} source={t('data.vs.p1.src', { m: f.int(n) })}>
          <Hero value={f.pct(est.mean, 0)} label={t('data.vs.p1.label')} share={{ mean: est.mean, lo: est.lo, hi: est.hi }} detail={detail} />
        </Figure>
      ) : (
        <p class="vs-stat" id="vs-placar-t">
          {title}
        </p>
      )}

      {modes.length > 0 ? (
        <Figure
          id="vs-modos"
          title={modesText}
          sub={td('data.vs.p1.modes.sub')}
          summary={`${modesText} ${modes.map((x) => `${modeName(x.mode)}: ${f.pct(x.est.mean, 0)}, ${games(x.n)}`).join('; ')}`}
          source={t('data.vs.p1.src', { m: f.int(n) })}
          table={{
            columns: [
              { label: t('data.vs.th.mode') },
              { label: t('data.vs.th.games'), numeric: true },
              { label: t('data.vs.th.wins'), numeric: true },
              { label: t('data.vs.th.share'), numeric: true },
              { label: t('data.term.ic.name') },
            ],
            rows: modes.map((x) => [modeName(x.mode), f.int(x.n), f.int(x.wins), f.pct(x.est.mean, 0), f.range(x.est.lo, x.est.hi, 0)]),
          }}
          reserve={60 + modes.length * 40}
        >
          <DotInterval
            rows={modes.map((x) => ({
              key: x.mode,
              label: modeName(x.mode),
              note: games(x.n),
              marks: [{ series: 3, mean: x.est.mean, lo: x.est.lo, hi: x.est.hi, value: f.pct(x.est.mean, 0), detail: [sample(t, f, x.n)] }],
            }))}
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            format={(v) => f.pct(v, 0)}
            refs={[refEven()]}
            axisLabel={t('data.vs.p1.axis')}
          />
        </Figure>
      ) : null}

      {rows.length > 0 ? (
        <div class="vs-list">
          <h3 id="vs-lista-t">{t('data.vs.p1.list.h')}</h3>
          <p class="sub">{t('data.vs.p1.list.sub')}</p>
          <div class="doc__table-scroll" tabIndex={0} role="region" aria-labelledby="vs-lista-t">
            <table class="doc__table vs-table" data-testid="vs-history">
              <thead>
                <tr>
                  <th scope="col">{t('data.vs.th.date')}</th>
                  <th scope="col">{t('data.vs.th.mode')}</th>
                  <th scope="col">{t('data.vs.th.opponents')}</th>
                  <th scope="col">{t('data.vs.th.partner')}</th>
                  <th scope="col">{t('data.vs.th.result')}</th>
                  <th scope="col" class="num">
                    {t('data.vs.th.score')}
                  </th>
                  <th scope="col">{t('data.vs.th.marks')}</th>
                  <th scope="col">
                    <span class="sr-only">{t('data.vs.th.replay')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(({ m, row }) => {
                  const date = f.date(row.endedAt, { local: true });
                  return (
                    <tr key={row.matchId} data-testid="vs-history-row" data-match-id={row.matchId}>
                      <th scope="row">{date}</th>
                      <td>{modeName(row.mode)}</td>
                      <td>{seatsText(row.opponents)}</td>
                      <td>{partnerText(row.partner)}</td>
                      <td>
                        <ResultMark won={row.won} />
                      </td>
                      <td class="num">{f.score(row.us, row.them)}</td>
                      <td>{row.marks.map((k) => t(`data.vs.mark.${k}` as Key)).join(', ')}</td>
                      <td>
                        <button
                          type="button"
                          class="btn btn--quiet vs-table__btn"
                          aria-label={t('data.vs.replay.aria', { date })}
                          aria-expanded={open === m.matchId}
                          onClick={(e) => {
                            opener.current = e.currentTarget;
                            setOpen(open === m.matchId ? null : m.matchId);
                          }}
                        >
                          {t('data.vs.replay')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="quiet vs-list__count" aria-live="polite">
            {t('data.vs.shown', { n: f.int(Math.min(shown, rows.length)), total: f.int(rows.length) })}
          </p>
          {shown < rows.length ? (
            <div class="button-row">
              <button type="button" class="btn" data-testid="vs-older" onClick={() => setShown((x) => x + PAGE_ROWS)}>
                {t('data.vs.older')}
              </button>
            </div>
          ) : null}
          {openMatch ? <MatchReplay match={openMatch} onClose={close} /> : null}
        </div>
      ) : null}
    </section>
  );
}
