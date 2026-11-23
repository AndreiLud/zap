// "Rever": one of the person's matches in the replay viewer (data/ReplayViewer.tsx), with a hand
// picker. The person's cards are always shown; the other seats' cards show once played face up,
// and, when every other seat is an AI, every card shows once the hand is over (DATA-SPEC 5.6).
// Loaded on demand (the viewer brings the engine's replay and the card art).

import './match-replay.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ReplayViewer } from '../../data/ReplayViewer.tsx';
import { fmt } from '../../data/format.ts';
import { t } from '../../i18n.ts';
import { replayOf, walkMatch, type PersonMatch } from '../history.ts';
import { aloneWithAi, seatNames } from '../text.ts';

export interface MatchReplayProps {
  match: PersonMatch;
  /** The hand to open (from 0); the first hand when absent. */
  hand?: number;
  onClose(): void;
}

export function MatchReplay({ match, hand, onClose }: MatchReplayProps) {
  const f = fmt();
  const spans = useMemo(() => walkMatch(match.record, match.yourSeat), [match.matchId]);
  const [at, setAt] = useState(() => Math.max(0, spans.findIndex((s) => s.index === (hand ?? 0))));
  useEffect(() => setAt(Math.max(0, spans.findIndex((s) => s.index === (hand ?? 0)))), [match.matchId, hand]);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    title.current?.scrollIntoView({ block: 'nearest' });
  }, [match.matchId, hand]);

  const span = spans[at];
  const names = useMemo(() => seatNames(match), [match.matchId, f.lang]);
  const end = aloneWithAi(match);
  const id = `vs-rever-${match.matchId.slice(0, 8)}`;
  if (!span) return null;
  const choice = { key: `${match.matchId}-${span.index}`, label: t('data.replay.hand', { h: f.int(span.index + 1) }), replay: replayOf(match.record, span) };

  return (
    <section class="vs-replay" aria-labelledby={`${id}-t`} data-testid="vs-replay">
      <div class="vs-replay__head">
        <h3 id={`${id}-t`} ref={title} tabIndex={-1}>
          {t('data.vs.replay.h', { date: f.date(match.record.endedAt, { local: true }) })}
        </h3>
        <button type="button" class="btn btn--quiet" onClick={onClose} data-testid="vs-replay-close">
          {t('common.close')}
        </button>
      </div>
      <p class="sub">{t(end ? 'data.vs.replay.end' : 'data.vs.replay.mine')}</p>
      <label class="field vs-replay__pick" for={`${id}-hand`}>
        <span>{t('data.replay.choose')}</span>
        <select id={`${id}-hand`} value={String(at)} onChange={(e) => setAt(Number(e.currentTarget.value))}>
          {spans.map((s, i) => (
            <option key={s.index} value={String(i)}>
              {t('data.replay.hand', { h: f.int(s.index + 1) })}
            </option>
          ))}
        </select>
      </label>
      <ReplayViewer key={choice.key} id={id} choices={[choice]} names={names} you={match.yourSeat} reveal={end ? 'end' : 'mine'} />
    </section>
  );
}
