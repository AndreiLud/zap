// The room before a match (CLIENT-SPEC 10.3): the room code, the invite, the seats and the start
// button. The seats use the shared seat labels and a small drawing of the table shows our team,
// theirs and the free places. Loaded on demand (room-chunks.tsx).
//
// M15 (spec 6.3, 6.4): with room code that arranges (setup 2), a free seat names the AI that plays it
// if nobody sits there, the owner gets one select per seat to arrange the table, before the first
// match and after each one ("Mudar a mesa"), and friends read who decides. Each seat row keeps its
// control in the same place whatever sits there, so a change never takes the focus away.
//
// M17: the seats sit in two groups, one per team, the viewer's first ("Nós" and "Eles", the
// scoreboard's words, chips and colours; "Seu lado" and "Lado adversário" in 1 against 1); a person
// the owner moves to the other group changes team on every page, and a friend moved that way reads
// it. A viewer without a seat gets neutral groups ("Time 1", "Time 2") with no team colour.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PublicSeat } from '../../../shared/protocol.ts';
import { currentRoom, leaveRoom } from '../actions.ts';
import { requestBreak } from '../ads/index.ts';
import { ConnStatus } from '../components/common.tsx';
import { Icon } from '../components/icons.tsx';
import { SeatLabel, TeamChip, type SeatInfo } from '../components/pieces.tsx';
import { ReportButton } from '../components/Report.tsx';
import { humanName } from '../game-text.ts';
import { t } from '../i18n.ts';
import { ArrangeSelect, useArranger, type Arranger } from '../play/Arrange.tsx';
import { changes, movedLine, movedTo, teamsOf, teamTitle, type TeamGroup } from '../play/arrange.ts';
import { MiniTable, type Spot, type SpotPos } from '../play/drawings.tsx';
import { leadOf, SETUP_TABLE } from '../room-rules.ts';
import type { AppState, RoomMsg } from '../store.ts';
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

interface RowProps {
  r: RoomMsg;
  seat: PublicSeat;
  /** The room publishes the character of a free seat (setup 2). */
  planned: boolean;
  /** "Sentar aqui" on a free seat. */
  canSit: boolean;
  /** The owner's select for this seat. */
  arranger: Arranger | null;
}

/** The seat's label: who sits there, or a free seat and what happens if it stays free. */
function SeatWho({ r, seat, planned }: { r: RoomMsg; seat: PublicSeat; planned: boolean }) {
  const you = r.you ?? 0;
  const isYou = seat.seat === r.you;
  const team = isUs(seat.seat, you) ? 'us' : 'them';
  // A viewer without a seat has no team: the groups say "Time 1" and "Time 2", nothing says "sua
  // dupla", and lobby.css takes the team colour off the names (`team` below only fills SeatInfo).
  const teamText = r.room.settings.players === 4 && r.you !== null ? <span class="sr-only">{`, ${t(team === 'us' ? 'seat.team.us' : 'seat.team.them')}`}</span> : null;
  if (seat.kind === 'empty') {
    return (
      <span class="lobby__who">
        <span class="seat-label">
          <span class="avatar lobby__free" aria-hidden="true" />
          <span class="seat-label__name">
            <span>{t('lobby.seat.empty')}</span>
            {teamText}
          </span>
          <span class="seat-label__line">{planned && seat.persona ? t('play.lobby.emptyAi', { who: t(`play.who.${seat.persona}`) }) : t('lobby.seat.emptyHint')}</span>
        </span>
      </span>
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
    <span class="lobby__who">
      <SeatLabel seat={info} />
      {teamText}
    </span>
  );
}

function SeatRow({ r, seat, planned, canSit, arranger }: RowProps) {
  const isYou = seat.seat === r.you;
  const testids = {
    'data-testid': `seat-${seat.seat}`,
    'data-kind': seat.kind,
    'data-connected': String(seat.connected),
    'data-ai-playing': String(seat.aiPlaying),
    ...(planned && seat.persona ? { 'data-persona': seat.persona } : {}),
  };
  const cls = `lobby__seat${seat.kind === 'empty' ? ' lobby__seat--empty' : ''}${isYou ? ' lobby__seat--you' : ''}${arranger ? ' lobby__seat--arrange' : ''}`;
  // Two keyed children: the label changes with whoever sits there, the control slot never moves.
  return (
    <li class={cls} {...testids}>
      <SeatWho key="who" r={r} seat={seat} planned={planned} />
      {arranger ? (
        <ArrangeSelect key="ctl" r={r} seat={seat.seat} arranger={arranger} />
      ) : seat.kind === 'empty' && canSit ? (
        <button key="ctl" type="button" class="btn lobby__sit" data-testid={`sit-${seat.seat}`} onClick={() => currentRoom()?.sit(seat.seat)} aria-label={t('lobby.sitAria', { n: seat.seat + 1 })}>
          {t('lobby.sit')}
        </button>
      ) : null}
    </li>
  );
}

/**
 * One team: a labelled group with its heading (the name, the team chip, its seats) and its seat
 * rows in seat order. The name carries the team; the colour and the chip's shape only repeat it.
 */
function TeamBox({ g, r, planned, canSit, arranger }: Omit<RowProps, 'seat'> & { g: TeamGroup }) {
  const head = teamTitle(g, t);
  const id = `lobby-team-${g.team}`;
  return (
    <div class="lobby__team" role="group" aria-labelledby={id} data-testid={`team-${g.team}`} data-side={g.side ?? 'none'}>
      <h3 id={id} class="lobby__team-head">
        <span class="lobby__team-name">
          {g.side ? <TeamChip team={g.side} /> : null}
          <span>{head.name}</span>
        </span>
        <span class="sr-only">, </span>
        <span class="lobby__team-seats">{head.seats}</span>
      </h3>
      <ul class="lobby__seats">
        {g.seats.map((i) => {
          const seat = r.room.seats[i];
          return seat ? <SeatRow key={i} r={r} seat={seat} planned={planned} canSit={canSit} arranger={arranger} /> : null;
        })}
      </ul>
    </div>
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
  const table = (room.setup ?? 0) >= SETUP_TABLE;
  const lead = leadOf(r);
  // The owner's controls exist only for room code that arranges (setup 2), in a lobby.
  const arrange = table && lead.arrange && room.status === 'lobby';
  const owned = useArranger(r, s.notice);
  const arranger = arrange ? owned : null;
  // Arriving from a match ("Mudar a mesa", or a reload between matches): read once, on mount.
  const fromMatch = useRef(room.matchNo > 0).current;
  const heading = useRef<HTMLHeadingElement>(null);
  const [said, setSaid] = useState<{ text: string; moved: boolean } | null>(null);
  const last = useRef<RoomMsg>(r);

  // The viewer's team comes first, so when the viewer changes team (a friend the owner moved to the
  // other group, or the owner moving themselves) the two groups swap places. Preact moves the group with moveBefore where
  // the browser has it, which keeps the focus; elsewhere the moved group drops it, so it goes back
  // to the control that had it before the swap. Read during render, before the page changes.
  const teams = useRef<HTMLDivElement>(null);
  const mine = r.you === null ? -1 : r.you & 1;
  const swap = useRef<{ mine: number; focus: Element | null }>({ mine, focus: null });
  if (swap.current.mine !== mine) {
    const a = document.activeElement;
    swap.current = { mine, focus: a && teams.current?.contains(a) ? a : null };
  }
  useLayoutEffect(() => {
    const f = swap.current.focus;
    swap.current.focus = null;
    const a = document.activeElement;
    if (f instanceof HTMLElement && f.isConnected && (!a || a === document.body)) f.focus();
  }, [mine]);

  useEffect(() => {
    if (fromMatch) {
      // The end screen had the focus: it goes to this page's title, unless the person is elsewhere
      // (the header, a dialog). The end screen already had its ads pause (room.matchEnd).
      const a = document.activeElement;
      if (!a || a === document.body || a.closest('main')) heading.current?.focus();
      return;
    }
    // Ads pause point (CLIENT-SPEC 16.4): once per lobby visit, after 5 s of waiting. Skipped at once while ads are off.
    const id = setTimeout(() => void requestBreak('room.lobby'), 5000);
    return () => clearTimeout(id);
  }, []);

  // The owner came back while a friend was on "Começar partida": the button goes, and the focus with
  // it would fall to the page; the title takes it, and reads why (aria-describedby).
  const led = useRef(lead.lead);
  useEffect(() => {
    const was = led.current;
    led.current = lead.lead;
    const a = document.activeElement;
    if (was && !lead.lead && (!a || a === document.body)) heading.current?.focus();
  }, [lead.lead]);

  // What changed at the table, said once (M15 spec 6.4): to the owner every seat that changed, to a
  // friend only that the owner moved them, and to the other team when it did (M17).
  useEffect(() => {
    const prev = last.current;
    last.current = r;
    if (prev === r || !table) return;
    if (arrange) {
      const list = changes(prev.room, room, r.you, t);
      if (list.length) setSaid({ text: list.join(' '), moved: false });
      return;
    }
    const from = prev.you;
    const seat = movedTo(from, r.you, (n) => currentRoom()?.satHere(n) ?? false);
    if (seat !== null && from !== null) setSaid({ text: movedLine(from, seat, players, t), moved: true });
  }, [r]);

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
  // The drawing is the table seen from your seat, us and them: a viewer without a seat has neither,
  // so it is left out (it only repeats the groups below).
  const spots: Spot[] | null =
    r.you === null
      ? null
      : room.seats.slice(0, players).map((x) => ({
          pos: posOf(x.seat, you, players),
          kind: x.kind === 'empty' ? 'open' : isUs(x.seat, you) ? 'us' : 'them',
          you: x.seat === r.you,
        }));
  // Older room code: everyone seated sits by themselves, the owner too.
  const canSit = r.you !== null && room.status === 'lobby' && !(table && r.owner);

  return (
    <main id="main" class="page lobby">
      <header class="lobby__head">
        {/* After a match the title takes the focus, and reads the wait line already on the page with it. */}
        <h1 ref={heading} tabIndex={fromMatch ? -1 : undefined} aria-describedby={fromMatch && lead.line ? 'lobby-wait' : undefined}>
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
          {spots ? <MiniTable spots={spots} class="lobby__table" /> : null}
        </div>
        {arranger ? (
          <p class="lobby__note">
            {t('play.arrange.hint')}
            {/* 2 against 2: how the groups make the teams. In 1 against 1 the headings already say it. */}
            {players === 4 && r.you !== null ? ` ${t('play.arrange.teams.dupla')}` : null}
          </p>
        ) : null}
        <div ref={teams} class={`lobby__teams lobby__teams--${players}${r.you === null ? ' lobby__teams--neutral' : ''}`}>
          {teamsOf(players, r.you).map((g) => (
            <TeamBox key={g.team} g={g} r={r} planned={table} canSit={canSit} arranger={arranger} />
          ))}
        </div>
        <p class="lobby__note">{t(table ? 'play.lobby.aiHint' : 'lobby.aiHint')}</p>
        <p class={said?.moved ? 'lobby__note lobby__moved' : 'sr-only'} role="status" data-testid="lobby-said">
          {said?.text ?? ''}
        </p>
      </section>

      <div class="lobby__actions">
        {lead.line ? (
          <p class="lobby__wait" id="lobby-wait" role="status" data-testid="wait-owner">
            {t(lead.line)}
          </p>
        ) : null}
        {lead.lead ? (
          <button
            type="button"
            class="btn btn--primary btn--big lobby__start"
            data-testid="start-button"
            disabled={blockedByTime}
            onClick={() => {
              // The arrangement first, so the start always follows it on the socket.
              arranger?.flush();
              currentRoom()?.start();
            }}
          >
            <Icon name="play" />
            <span>{t('lobby.start')}</span>
          </button>
        ) : null}
        <div class="lobby__more">
          <button type="button" class="btn btn--quiet" data-testid="leave-button" onClick={leaveRoom}>
            <Icon name="leave" />
            {/* The owner's leave in a lobby closes the room for everyone (worker room-core leave). */}
            <span>{t(r.owner ? 'play.lobby.close' : 'lobby.leave')}</span>
          </button>
          {room.seats.some((x) => x.kind === 'human' && x.seat !== r.you) ? <ReportButton s={s} /> : null}
        </div>
      </div>
      {lead.lead && blockedByTime ? <p class="lobby__note">{t('turn.noneHint')}</p> : null}
    </main>
  );
}
