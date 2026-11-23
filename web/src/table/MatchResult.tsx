// The end of the match (CLIENT-SPEC 11.3): over the play area, the heading takes focus ("We won!",
// "You won!"...), the final score, "Play again" and "Pick another table", and a quiet link to
// "You against Zap" (DATA-SPEC 1.1). The deck is back on the medallion behind it. A rematch shows
// "Opening the table" (board.rematch.wait) until the new deal arrives.
// Ads pause points: room.matchEnd when the result appears in a room; solo.betweenMatches before a
// solo rematch (both skipped at once while ads are off).

import { useEffect, useRef, useState } from 'preact/hooks';
import { goPlay } from '../actions.ts';
import { requestBreak } from '../ads/index.ts';
import { Link } from '../components/common.tsx';
import { currentController } from '../controller.ts';
import { seatName, teamLabel } from '../game-text.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { inGame } from './focus.ts';
import type { Model } from './model.ts';

export function MatchResult({ m }: { m: Model }) {
  const v = m.v;
  const winner = v.over ? v.winner : m.room.lastWinner;
  const won = winner === m.team;
  const text = m.n === 4 ? t(won ? 'result.us' : 'result.them') : won ? t('result.you') : t('result.other', { name: seatName(m.names, (m.you + 1) % 2) });
  const heading = useRef<HTMLHeadingElement>(null);
  const [waiting, setWaiting] = useState(false);
  const solo = m.room.settings.mode === 'solo';

  useEffect(() => {
    // The heading takes focus, unless the person is in the header, the side panel or a dialog.
    if (inGame()) heading.current?.focus({ preventScroll: true });
    if (m.room.settings.mode === 'room') void requestBreak('room.matchEnd');
  }, []);

  // A refused rematch (the brake, an error) gives the button back.
  useEffect(() => {
    if (!waiting) return;
    const start = store.get();
    const off = store.subscribe(() => {
      const s = store.get();
      if ((s.noticeLimit && s.noticeLimit !== start.noticeLimit) || (s.notice && s.notice !== start.notice)) setWaiting(false);
    });
    const id = setTimeout(() => setWaiting(false), 10_000);
    return () => {
      off();
      clearTimeout(id);
    };
  }, [waiting]);

  const rematch = () => {
    if (waiting) return;
    setWaiting(true);
    if (solo) void requestBreak('solo.betweenMatches').then(() => currentController()?.rematch());
    else currentController()?.rematch();
  };

  return (
    <section class="match-result" aria-labelledby="result-title">
      <h2 id="result-title" ref={heading} tabIndex={-1} data-testid="match-result">
        {text}
      </h2>
      <p class="match-result__score">
        {t('result.score', { us: v.score[m.team], them: v.score[1 - m.team], usName: teamLabel(m.names, m.team), themName: teamLabel(m.names, 1 - m.team) })}
      </p>
      <div class="button-row">
        <button type="button" class="btn btn--primary btn--big" data-testid="rematch-button" aria-disabled={waiting ? 'true' : undefined} onClick={rematch}>
          {waiting ? t('board.rematch.wait') : t('result.rematch')}
        </button>
        <button type="button" class="btn btn--outline" data-testid="home-button" onClick={goPlay}>
          {t('board.other')}
        </button>
      </div>
      <Link to={{ name: 'vs' }} class="btn btn--quiet" testid="link-vs">
        {t('shell.link.vs')}
      </Link>
    </section>
  );
}
