// The end of the match (CLIENT-SPEC 11.3): over the play area, the heading takes focus ("We won!",
// "You won!"...), the final score, "Play again" and "Pick another table", and a quiet link to
// "You against Zap" (DATA-SPEC 1.1). The deck is back on the medallion behind it. A rematch shows
// "Opening the table" (board.rematch.wait) until the new deal arrives.
// Ads pause points: room.matchEnd when the result appears in a room; solo.betweenMatches before a
// solo rematch (both skipped at once while ads are off).
// Quick play (M15 spec 5.4): right below "Play again", the random switches for the next match ("Time"
// only in 2 against 2): on draws that side again, off repeats the line up just played.
// Rooms with friends (M15 spec 6.5): the owner plays again or changes the table ("Mudar a mesa");
// a friend reads that the owner decides, unless the owner is away, when anyone seated may start.

import { useEffect, useRef, useState } from 'preact/hooks';
import { goPlay } from '../actions.ts';
import { requestBreak } from '../ads/index.ts';
import { Link } from '../components/common.tsx';
import { currentController } from '../controller.ts';
import { seatName, teamLabel } from '../game-text.ts';
import { t } from '../i18n.ts';
import { RandomSwitches, type RandomFlags } from '../play/RandomSwitches.tsx';
import { leadOf, SETUP_DRAW } from '../room-rules.ts';
import { store } from '../store.ts';
import { inGame } from './focus.ts';
import type { Model } from './model.ts';

export function MatchResult({ m }: { m: Model }) {
  const v = m.v;
  const winner = v.over ? v.winner : m.room.lastWinner;
  const won = winner === m.team;
  const text = m.n === 4 ? t(won ? 'result.us' : 'result.them') : won ? t('result.you') : t('result.other', { name: seatName(m.names, (m.you + 1) % 2) });
  const heading = useRef<HTMLHeadingElement>(null);
  // One waiting state for both buttons (M15 spec 6.5): the first press of either holds the other.
  const [waiting, setWaiting] = useState<'rematch' | 'change' | null>(null);
  const solo = m.room.settings.mode === 'solo';
  const room = currentController()?.kind === 'room';
  const lead = leadOf({ owner: m.owner, you: m.you, room: m.room });
  // Quick play's switches for the next match, from what the match that just ended used (the result
  // remounts each match). Not in the guided lesson (a local room) nor with older room code.
  const draws = solo && room && (m.room.setup ?? 0) >= SETUP_DRAW;
  const [next, setNext] = useState<RandomFlags>(() => ({ opponents: m.room.settings.randomOpponents === true, partner: m.room.settings.randomPartner === true }));

  useEffect(() => {
    // The heading takes focus, unless the person is in the header, the side panel or a dialog.
    if (inGame()) heading.current?.focus({ preventScroll: true });
    if (m.room.settings.mode === 'room') void requestBreak('room.matchEnd');
  }, []);

  // The owner came back while a friend was on "Jogar de novo": the button goes, and the focus with
  // it would fall to the page; the heading takes it, and reads why (aria-describedby).
  const led = useRef(lead.lead);
  useEffect(() => {
    const was = led.current;
    led.current = lead.lead;
    const a = document.activeElement;
    if (was && !lead.lead && (!a || a === document.body)) heading.current?.focus({ preventScroll: true });
  }, [lead.lead]);

  // A refused rematch or change (the brake, an error) gives the buttons back.
  useEffect(() => {
    if (!waiting) return;
    const start = store.get();
    const off = store.subscribe(() => {
      const s = store.get();
      if ((s.noticeLimit && s.noticeLimit !== start.noticeLimit) || (s.notice && s.notice !== start.notice)) setWaiting(null);
    });
    const id = setTimeout(() => setWaiting(null), 10_000);
    return () => {
      off();
      clearTimeout(id);
    };
  }, [waiting]);

  const rematch = () => {
    if (waiting) return;
    setWaiting('rematch');
    const choice = draws ? { randomOpponents: next.opponents, randomPartner: next.partner } : undefined;
    if (solo) void requestBreak('solo.betweenMatches').then(() => currentController()?.rematch(choice));
    else currentController()?.rematch();
  };

  const changeTable = () => {
    if (waiting) return;
    setWaiting('change');
    currentController()?.changeTable?.();
  };

  const held = waiting ? 'true' : undefined;
  return (
    <section class="match-result" aria-labelledby="result-title">
      {/* The wait line was there before the focus came: a live region would not read it, the heading does. */}
      <h2 id="result-title" ref={heading} tabIndex={-1} data-testid="match-result" aria-describedby={lead.line ? 'result-wait' : undefined}>
        {text}
      </h2>
      <p class="match-result__score">
        {t('result.score', { us: v.score[m.team], them: v.score[1 - m.team], usName: teamLabel(m.names, m.team), themName: teamLabel(m.names, 1 - m.team) })}
      </p>
      {lead.line ? (
        <p class="match-result__wait" id="result-wait" role="status" data-testid="wait-owner">
          {t(lead.line)}
        </p>
      ) : null}
      <div class="button-row">
        {lead.lead ? (
          <button type="button" class="btn btn--primary btn--big" data-testid="rematch-button" aria-disabled={held} onClick={rematch}>
            {waiting === 'rematch' ? t('board.rematch.wait') : t('result.rematch')}
          </button>
        ) : null}
        {lead.arrange && room ? (
          <button type="button" class="btn btn--outline" data-testid="change-table" aria-disabled={held} onClick={changeTable}>
            {t('board.change')}
          </button>
        ) : null}
        {draws ? (
          <RandomSwitches players={m.n === 2 ? 2 : 4} values={next} onChange={setNext} legend="board.random.legend" testid="rematch-random" disabled={waiting !== null} />
        ) : null}
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
