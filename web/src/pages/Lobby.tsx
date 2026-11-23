// The room before the match starts (CLIENT-SPEC 10.3): the room code, the invite, the seats and
// the start button. Same behavior and testids as before; the seats use the shared seat labels and a
// small drawing of the table shows our team, theirs and the free places.

import { useEffect, useState } from 'preact/hooks';
import type { PublicSeat } from '../../../shared/protocol.ts';
import { currentRoom, leaveRoom } from '../actions.ts';
import { requestBreak } from '../ads/index.ts';
import { ConnStatus } from '../components/common.tsx';
import { Icon } from '../components/icons.tsx';
import { SeatLabel, type SeatInfo } from '../components/pieces.tsx';
import { ReportButton } from '../components/Report.tsx';
import { humanName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { MiniTable, type Spot, type SpotPos } from '../play/drawings.tsx';
import type { AppState } from '../store.ts';
import '../styles/lobby.css';

export function settingsSummary(s: AppState): string {
  const set = s.room!.room.settings;
  const parts = [t(`mode.${set.players}`), t(`variant.${set.variant}`), set.turnSeconds === null ? t('turn.noneShort') : t('turn.option', { n: set.turnSeconds })];
  if (set.options.bestOf === 3) parts.push(t('house.bestOf3.short'));
  return parts.join(' · ');
}

function inviteUrl(code: string, lang: 'pt' | 'en'): string {
  return `${location.origin}${lang === 'en' ? '/en' : ''}/s/${code}`;
}

/** Where a seat sits seen from yours: you at the bottom, then counterclockwise (right, top, left). */
function posOf(seat: number, you: number, players: number): SpotPos {
  if (players === 2) return seat === you ? 'bottom' : 'top';
  return (['bottom', 'right', 'top', 'left'] as const)[(seat - you + 4) % 4];
}

function isUs(seat: number, you: number): boolean {
  return (seat & 1) === (you & 1);
}

function SeatRow(props: { seat: PublicSeat; you: number | null; players: number; canSit: boolean }) {
  const { seat } = props;
  const you = props.you ?? 0;
  const isYou = seat.seat === props.you;
  const team = isUs(seat.seat, you) ? 'us' : 'them';
  const testids = {
    'data-testid': `seat-${seat.seat}`,
    'data-kind': seat.kind,
    'data-connected': String(seat.connected),
    'data-ai-playing': String(seat.aiPlaying),
  };
  const teamText = props.players === 4 ? <span class="sr-only">{`, ${t(team === 'us' ? 'seat.team.us' : 'seat.team.them')}`}</span> : null;

  if (seat.kind === 'empty') {
    return (
      <li class="lobby__seat lobby__seat--empty" {...testids}>
        <span class="seat-label">
          <span class="avatar lobby__free" aria-hidden="true" />
          <span class="seat-label__name">
            <span>{t('lobby.seat.empty')}</span>
            {teamText}
          </span>
          <span class="seat-label__line">{t('lobby.seat.emptyHint')}</span>
        </span>
        {props.canSit ? (
          <button type="button" class="btn lobby__sit" data-testid={`sit-${seat.seat}`} onClick={() => currentRoom()?.sit(seat.seat)} aria-label={t('lobby.sitAria', { n: seat.seat + 1 })}>
            {t('lobby.sit')}
          </button>
        ) : null}
      </li>
    );
  }

  const info: SeatInfo =
    seat.kind === 'ai'
      ? { kind: 'ai', persona: seat.persona, name: seat.name, team }
      : {
          kind: 'human',
          name: isYou ? t('seat.you') : seat.name || humanName(seat.seat),
          team,
          // The seal shows only on other people's seats, never on your own.
          verified: !isYou && seat.verified,
          aiPlaying: seat.aiPlaying,
          away: !seat.connected,
        };
  return (
    <li class={`lobby__seat${isYou ? ' lobby__seat--you' : ''}`} {...testids}>
      <SeatLabel seat={info} />
      {teamText}
    </li>
  );
}

export function Lobby({ s }: { s: AppState }) {
  const r = s.room!;
  const room = r.room;
  const [copied, setCopied] = useState(false);
  const link = inviteUrl(room.code, s.lang);
  const players = room.settings.players;
  const you = r.you ?? 0;
  const peopleOnly = room.seats.every((x) => x.kind === 'human');
  const blockedByTime = room.settings.turnSeconds === null && !peopleOnly;

  // Ads pause point (CLIENT-SPEC 16.4): once per lobby visit, after 5 s of waiting. Skipped at once while ads are off.
  useEffect(() => {
    const id = setTimeout(() => void requestBreak('room.lobby'), 5000);
    return () => clearTimeout(id);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(t('lobby.whatsappText', { url: link }))}`;
  const spots: Spot[] = room.seats.slice(0, players).map((x) => ({
    pos: posOf(x.seat, you, players),
    kind: x.kind === 'empty' ? 'open' : isUs(x.seat, you) ? 'us' : 'them',
    you: x.seat === r.you,
  }));

  return (
    <main id="main" class="page lobby">
      <header class="lobby__head">
        <h1>
          <span class="lobby__title">{t('lobby.title')}</span>{' '}
          <span class="lobby__code" data-testid="room-code">
            {room.code}
          </span>
        </h1>
        <ConnStatus s={s} />
        <p class="lobby__summary">{settingsSummary(s)}</p>
      </header>

      <section class="lobby__section" aria-labelledby="invite-title">
        <h2 id="invite-title">{t('lobby.invite')}</h2>
        <p class="lobby__invite">
          <span data-testid="invite-link">{link}</span>
        </p>
        <div class="button-row">
          <button type="button" class="btn lobby__copy" data-testid="copy-invite" onClick={() => void copy()}>
            {copied ? t('lobby.copied') : t('lobby.copy')}
          </button>
          <a class="btn lobby__whatsapp" href={whatsapp} target="_blank" rel="noopener" data-testid="whatsapp-invite">
            {t('lobby.whatsapp')}
            <Icon name="arrow" />
            <span class="sr-only"> {t('link.newtab')}</span>
          </a>
        </div>
        <p class="sr-only" role="status">
          {copied ? t('lobby.copied') : ''}
        </p>
      </section>

      <section class="lobby__section" aria-labelledby="seats-title">
        <div class="lobby__seats-head">
          <h2 id="seats-title">{t('lobby.seats')}</h2>
          <MiniTable spots={spots} class="lobby__table" />
        </div>
        <ul class={`lobby__seats lobby__seats--${players}`}>
          {room.seats.map((seat) => (
            <SeatRow key={seat.seat} seat={seat} you={r.you} players={players} canSit={r.you !== null && room.status === 'lobby'} />
          ))}
        </ul>
        <p class="lobby__note">{t('lobby.aiHint')}</p>
      </section>

      <div class="lobby__actions">
        {r.owner ? (
          <button type="button" class="btn btn--primary btn--big lobby__start" data-testid="start-button" disabled={blockedByTime} onClick={() => currentRoom()?.start()}>
            <Icon name="play" />
            <span>{t('lobby.start')}</span>
          </button>
        ) : (
          <p class="lobby__wait" role="status">
            {t('play.lobby.waitOwner')}
          </p>
        )}
        <div class="lobby__more">
          <button type="button" class="btn btn--quiet" data-testid="leave-button" onClick={leaveRoom}>
            <Icon name="leave" />
            <span>{t('lobby.leave')}</span>
          </button>
          {room.seats.some((x) => x.kind !== 'empty' && x.seat !== r.you) ? <ReportButton s={s} /> : null}
        </div>
      </div>
      {r.owner && blockedByTime ? <p class="lobby__note">{t('turn.noneHint')}</p> : null}
    </main>
  );
}
