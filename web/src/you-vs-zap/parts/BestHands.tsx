// P5, best hands (DATA-SPEC 5.6): the five hands after which the AI across the table thought least
// of its chances, found in the person's 300 most recent games once every record is in. Each card
// says the AI's estimate before and after the hand, the hand's marks, and opens the replay.

import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt } from '../../data/format.ts';
import { t, type Key } from '../../i18n.ts';
import { lazyComponent } from '../../lazy.tsx';
import { SCAN_LIMIT, scanBestHands, type BestHand } from '../best-hands.ts';
import type { PersonMatch } from '../history.ts';

const MatchReplay = lazyComponent(() => import('./MatchReplay.tsx').then((m) => m.MatchReplay));

type View = { k: 'wait' } | { k: 'scan'; done: number; total: number } | { k: 'ready'; hands: BestHand[] };

function tagText(tag: BestHand['tags'][number], m: PersonMatch | undefined): string {
  if (tag === 'doze') return t('data.vs.p5.tag.doze', { call: t('callw.12') });
  if (tag === 'onze') return t(`onze.${m?.record.config.variant ?? 'paulista'}` as Key);
  return t(`data.vs.p5.tag.${tag}` as Key);
}

export function BestHands({ matches, complete }: { matches: readonly PersonMatch[]; complete: boolean }) {
  const f = fmt();
  const [view, setView] = useState<View>({ k: 'wait' });
  const [open, setOpen] = useState<{ matchId: string; hand: number } | null>(null);
  // "Fechar" unmounts the replay: the focus goes back to the "Rever" button that opened it.
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    setOpen(null);
    requestAnimationFrame(() => opener.current?.isConnected && opener.current.focus());
  };

  useEffect(() => {
    if (!complete) {
      setView({ k: 'wait' });
      return;
    }
    let alive = true;
    setView({ k: 'scan', done: 0, total: Math.min(SCAN_LIMIT, matches.length) });
    void scanBestHands(matches, { alive: () => alive, progress: (done, total) => alive && setView({ k: 'scan', done, total }) }).then((hands) => {
      if (alive && hands) setView({ k: 'ready', hands });
    });
    return () => {
      alive = false;
    };
  }, [complete, matches]);

  const byId = new Map(matches.map((m) => [m.matchId, m]));
  const openMatch = open ? byId.get(open.matchId) : undefined;

  return (
    <section id="vs-melhores" class="doc__section vs-part" aria-labelledby="vs-melhores-t" data-testid="vs-best">
      <h2 id="vs-melhores-t">{t('data.vs.p5.title')}</h2>
      <h3 class="figure__title">{t('data.vs.p5.h')}</h3>
      <p class="sub">{t('data.vs.p5.sub')}</p>
      {view.k === 'wait' ? <p class="quiet">{t('data.vs.p5.wait')}</p> : null}
      {view.k === 'scan' ? (
        <p class="quiet" role="status">
          {t('data.vs.p5.scanning', { done: f.int(view.done), total: f.int(view.total) })}
        </p>
      ) : null}
      {view.k === 'ready' && view.hands.length === 0 ? (
        <p class="quiet" data-testid="vs-best-empty">
          {t('data.vs.p5.empty')}
        </p>
      ) : null}
      {view.k === 'ready' && view.hands.length > 0 ? (
        <ol class="vs-hands">
          {view.hands.map((h) => {
            const m = byId.get(h.matchId);
            const date = f.date(h.endedAt, { local: true });
            const name = t('data.vs.p5.card', { date, h: f.int(h.hand + 1) });
            const isOpen = open?.matchId === h.matchId && open.hand === h.hand;
            return (
              <li key={`${h.matchId}-${h.hand}`} class="vs-hand" data-testid="vs-best-hand">
                <h4 class="vs-hand__title">{name}</h4>
                <p class="vs-hand__line">{t('data.vs.p5.line', { before: f.pct(h.before, 0), after: f.pct(h.after, 0) })}</p>
                <HandDrop before={h.before} after={h.after} />
                {h.tags.length > 0 ? (
                  <ul class="vs-hand__tags" aria-label={t('data.vs.p5.tags')}>
                    {h.tags.map((tag) => (
                      <li key={tag}>{tagText(tag, m)}</li>
                    ))}
                  </ul>
                ) : null}
                <button
                  type="button"
                  class="btn btn--quiet vs-hand__btn"
                  aria-expanded={isOpen}
                  aria-label={`${t('data.vs.replay')}: ${name}`}
                  onClick={(e) => {
                    opener.current = e.currentTarget;
                    setOpen(isOpen ? null : { matchId: h.matchId, hand: h.hand });
                  }}
                >
                  {t('data.vs.replay')}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {openMatch && open ? <MatchReplay match={openMatch} hand={open.hand} onClose={close} /> : null}
      <p class="source source--plain">{t('data.vs.p5.src', { limit: f.int(SCAN_LIMIT) })}</p>
    </section>
  );
}

/** Before and after on one 0% to 100% track: a hollow mark, an arrow, a filled mark (shape, not color). */
function HandDrop({ before, after }: { before: number; after: number }) {
  const x = (v: number) => (4 + Math.max(0, Math.min(1, v)) * 192).toFixed(1);
  return (
    <svg class="vs-hand__drop" viewBox="0 0 200 16" aria-hidden="true" focusable="false">
      <line class="vs-hand__track" x1="4" x2="196" y1="8" y2="8" />
      <line class="vs-hand__half" x1="100" x2="100" y1="2" y2="14" />
      <line class="vs-hand__fall" x1={x(before)} x2={x(after)} y1="8" y2="8" />
      <circle class="vs-hand__before" cx={x(before)} cy="8" r="4" />
      <circle class="vs-hand__after" cx={x(after)} cy="8" r="4" />
    </svg>
  );
}
