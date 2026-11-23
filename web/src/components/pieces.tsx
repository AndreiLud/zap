// Shared pieces of the table, the lobby and the Play page (prototype pecas.js): the avatar with its
// optional timer ring, the AI mark, the verified human seal, the team chip and the seat label.
// Styles: styles/pieces.css. Text comes from the locales; nothing here reads the store.

import type { PersonaId } from '../../../ai/src/personas.ts';
import { AvatarArt } from '../deck/avatars.tsx';
import { PERSONA_NAMES } from '../game-text.ts';
import { t } from '../i18n.ts';

/**
 * The timer ring around an avatar. A countdown (a person with a deadline) shrinks over `durationMs`,
 * already `elapsedMs` in (a CSS animation with a negative delay, so a re-render never restarts it);
 * 'static' is a full ring that only marks whose turn it is (AI seats move within 700 ms).
 */
export type Ring = { durationMs: number; elapsedMs: number } | 'static';

function RingSvg({ ring }: { ring: Ring }) {
  const style = ring === 'static' ? undefined : { '--ring-dur': `${ring.durationMs}ms`, '--ring-delay': `${-ring.elapsedMs}ms` };
  return (
    <svg class={`timer-ring${ring === 'static' ? ' timer-ring--static' : ''}`} viewBox="0 0 46 46" aria-hidden="true" focusable="false" style={style}>
      <circle class="timer-ring__track" cx="23" cy="23" r="21" pathLength="100" />
      <circle class="timer-ring__live" cx="23" cy="23" r="21" pathLength="100" />
    </svg>
  );
}

/** A character's tile (30 by 30) or a person's initial; optional timer ring. */
export function Avatar(p: ({ persona: PersonaId } | { initial: string }) & { ring?: Ring | null; class?: string }) {
  const cls = `avatar${'persona' in p ? '' : ' avatar--person'}${p.class ? ` ${p.class}` : ''}`;
  return (
    <span class={cls} aria-hidden="true">
      {'persona' in p ? <AvatarArt id={p.persona} /> : <span class="avatar__initial">{(p.initial || '?').charAt(0).toUpperCase()}</span>}
      {p.ring ? <RingSvg ring={p.ring} /> : null}
    </span>
  );
}

/** "IA" ("AI") in a thin outlined box, never a filled badge. Every AI seat shows it, always. */
export function AiMark() {
  return (
    <abbr class="ai-mark" title={t('seat.ai.title')}>
      {t('seat.ai')}
    </abbr>
  );
}

const SEAL_BODY = (
  <>
    <g fill="currentColor">
      <rect x="8" y="8" width="24" height="24" rx="3" />
      <rect x="8" y="8" width="24" height="24" rx="3" transform="rotate(45 20 20)" />
    </g>
    <path class="human-seal__check" d="M13.5 20.5l4.5 4.5 8.5-9" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />
  </>
);

/** The seal plus "humano verificado". Only on other people's seats in rooms: never your own, never an AI. */
export function HumanSeal() {
  return (
    <span class="human-seal">
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        {SEAL_BODY}
      </svg>
      <span>{t('seat.verified')}</span>
    </span>
  );
}

/** A 12 px team tile: us a cobalt quarter disc, them a terracotta triangle (shape tells them apart too). */
export function TeamChip({ team }: { team: 'us' | 'them' }) {
  return (
    <svg class={`team-chip team-chip--${team}`} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect class="team-chip__ground" width="10" height="10" rx="1.5" />
      <path class="team-chip__mark" d={team === 'us' ? 'M0 0H10V10A10 10 0 0 0 0 0Z' : 'M0 10 10 0V10Z'} />
    </svg>
  );
}

/** What a seat label shows. The caller maps a PublicSeat (or a scripted seat) to this. */
export interface SeatInfo {
  kind: 'ai' | 'human';
  /** The character, for AI seats. */
  persona?: PersonaId | null;
  /** Shown name: the character's name, a nickname or "Jogador N". Defaults to the character's name. */
  name?: string;
  team: 'us' | 'them';
  /** A person who passed the human check (the seal shows only on other people's seats). */
  verified?: boolean;
  /** An AI is playing this person's seat for now. */
  aiPlaying?: boolean;
  /** The person is away from the table. */
  away?: boolean;
  ring?: Ring | null;
}

/** The one quiet line under a name: the character's style, or the person's state, or the seal. */
function SeatLine({ seat }: { seat: SeatInfo }) {
  if (seat.kind === 'ai') return seat.persona ? <>{t(`persona.${seat.persona}.style`)}</> : null;
  if (seat.aiPlaying) return <>{t('seat.aiPlaying')}</>;
  if (seat.away) return <>{t('seat.away')}</>;
  if (seat.verified) return <HumanSeal />;
  return null;
}

/**
 * Seat label: avatar, name, AI mark, team chip and one quiet line. side 'right' puts the avatar on
 * the right (a seat on the right edge). Accessible names belong to the seat region around it.
 */
export function SeatLabel({ seat, side }: { seat: SeatInfo; side?: 'left' | 'right' }) {
  const name = seat.name ?? (seat.persona ? PERSONA_NAMES[seat.persona] : '');
  return (
    <span class={`seat-label${side === 'right' ? ' seat-label--right' : ''}`} data-team={seat.team}>
      {seat.kind === 'ai' && seat.persona ? <Avatar persona={seat.persona} ring={seat.ring} /> : <Avatar initial={name} ring={seat.ring} />}
      <span class="seat-label__name">
        <span>{name}</span>
        {seat.kind === 'ai' ? <AiMark /> : null}
        <TeamChip team={seat.team} />
      </span>
      <span class="seat-label__line">
        <SeatLine seat={seat} />
      </span>
    </span>
  );
}
