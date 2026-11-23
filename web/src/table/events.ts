// One dispatcher for what the table hears (CLIENT-SPEC 11.6): each event the playback shows goes to
// the motion (motion.ts), the sound and vibration (sound/index.ts) and, through the feed, to the
// screen reader (Announcer.tsx). cuesFor is pure and unit tested.

import { useEffect } from 'preact/hooks';
import { manilhaRankForVira } from '../../../engine/src/cards.ts';
import type { Variant } from '../../../engine/src/config.ts';
import type { GameEvent } from '../../../engine/src/engine.ts';
import { panFor, shoutForEvent, sound, VIBRATION, type Sfx, type Shout } from '../sound/index.ts';
import { store } from '../store.ts';
import { tableBus, type BusItem } from '../table-view.ts';
import * as motion from './motion.ts';
import { makeModel, posOf, zapOpponent } from './model.ts';
import { COUNT_FLIGHT, DEAL_STAGGER, MARK_STEP } from './timing.ts';

export interface CueContext {
  you: number;
  players: number;
  variant: Variant;
  /** Manilha rank of the hand (paulista), -1 otherwise. */
  manilhaRank: number;
}

export interface Cues {
  sfx: { name: Sfx; pan: number; count: number; gap: number; delay: number }[];
  shout: { name: Shout; pan: number } | null;
  vibrate: number | readonly number[] | null;
}

/** Stereo position of a seat: left -0.6, right 0.6, top and bottom 0 (sound/index.ts PAN). */
export function panOf(seat: number, you: number, players: number): number {
  if (seat < 0 || you < 0) return 0;
  return panFor(posOf(seat, you, players));
}

const NONE: Cues = { sfx: [], shout: null, vibrate: null };

/**
 * Sound, shout and vibration of one event (section 11.6 table, 15.4 and 15.5). The shout comes from
 * WP3's one mapping (sound/shouts.ts shoutForEvent), panned like the seat that made it.
 */
export function cuesFor(e: GameEvent, c: CueContext): Cues {
  const mine = c.you >= 0 ? c.you & 1 : 0;
  const name = shoutForEvent(e, { variant: c.variant, manilhaRank: c.manilhaRank });
  const shout = name ? { name, pan: 'seat' in e ? panOf(e.seat, c.you, c.players) : 0 } : null;
  switch (e.t) {
    case 'deal': {
      const cards = c.players * 3;
      const sfx: Cues['sfx'] = [];
      // After the first hand the deck was gathered: one riffle before the cards go out.
      if (e.hand > 0) sfx.push({ name: 'shuffle', pan: 0, count: 1, gap: 0, delay: 0 });
      sfx.push({ name: 'deal', pan: 0, count: cards, gap: DEAL_STAGGER, delay: 0 });
      return { sfx, shout: null, vibrate: null };
    }
    case 'play':
      return { sfx: [{ name: e.seat === c.you ? 'playMine' : 'play', pan: panOf(e.seat, c.you, c.players), count: 1, gap: 0, delay: 0 }], shout, vibrate: null };
    case 'raise': {
      // A raise against your team: the TRUCO tiles turn and the phone buzzes.
      const against = (e.seat & 1) !== mine;
      return { sfx: against ? [{ name: 'tiles', pan: 0, count: 1, gap: 0, delay: 0 }] : [], shout, vibrate: against ? VIBRATION.answer : null };
    }
    case 'accept':
    case 'run':
    case 'onze':
      return { sfx: [], shout, vibrate: null };
    case 'round':
      return { sfx: [{ name: 'gather', pan: 0, count: 1, gap: 0, delay: 0 }], shout: null, vibrate: null };
    case 'hand': {
      if (e.winner < 0 || e.points <= 0) return NONE;
      const count = Math.min(e.points, 12);
      return { sfx: [{ name: 'tento', pan: 0, count, gap: count > 4 ? 0 : MARK_STEP, delay: COUNT_FLIGHT }], shout: null, vibrate: null };
    }
    case 'game':
      return { sfx: [{ name: 'tento', pan: 0, count: 1, gap: 0, delay: 0 }], shout: null, vibrate: null };
    case 'match':
      return { sfx: [], shout: null, vibrate: e.winner === mine ? VIBRATION.won : null };
    case 'signal':
      return NONE;
  }
}

function playCues(cues: Cues): void {
  for (const s of cues.sfx) {
    for (let i = 0; i < s.count; i++) {
      const at = s.delay + i * s.gap;
      if (at <= 0) sound.play(s.name, { pan: s.pan });
      else setTimeout(() => sound.play(s.name, { pan: s.pan }), at);
    }
  }
  if (cues.shout) sound.shout(cues.shout.name, { pan: cues.shout.pan });
  if (cues.vibrate) sound.vibrate(cues.vibrate);
}

/** Routes the playback's events to motion, sound and vibration while the table is mounted. */
export function useTableEvents(): void {
  useEffect(() => {
    // The hand each event belongs to, as the playback shows it.
    let hand = store.get().view?.handIndex ?? 0;
    let manilhaRank = store.get().view?.manilhaRank ?? -1;
    const handle = (b: BusItem) => {
      if (b.kind === 'snapshot') {
        hand = b.msg.obs.handIndex;
        manilhaRank = b.msg.obs.manilhaRank;
        motion.onSnapshot();
        return;
      }
      if (b.kind === 'predeal') {
        motion.onPredeal();
        return;
      }
      const e = b.e;
      const o = b.msg.obs;
      const ctx = { you: o.seat, players: o.players, matchNo: b.msg.matchNo };
      if (e.t === 'deal') {
        hand = e.hand;
        manilhaRank = o.variant === 'paulista' && e.vira >= 0 ? manilhaRankForVira(e.vira) : -1;
      }
      if (b.instant) {
        motion.onInstant();
        return;
      }
      playCues(cuesFor(e, { you: o.seat, players: o.players, variant: o.variant, manilhaRank }));
      switch (e.t) {
        case 'deal':
          motion.onDeal(ctx, e.hand, e.mao);
          break;
        case 'play':
          motion.onPlay(ctx, e.seat);
          break;
        case 'round':
          motion.onRound(ctx, hand, e.round);
          break;
        case 'hand': {
          const s = store.get();
          let zapWon: boolean | null = null;
          if (s.room && s.view && !s.muteOthers && e.winner >= 0) {
            const zap = zapOpponent(makeModel(s.view, s.room.room, { sending: false, cover: false, playing: false, muted: s.muteOthers }));
            if (zap >= 0) zapWon = (zap & 1) === e.winner;
          }
          motion.onHand(ctx, e.winner, e.points, zapWon);
          break;
        }
        default:
          break;
      }
    };
    // The table mounts just after the first message of a match: its deal still shows.
    const off = tableBus.on(handle, 300);
    return () => {
      off();
      motion.disposeMotion();
    };
  }, []);
}

/** Wakes the sound on the first pointer or key at the table (nothing plays before a gesture). */
export function useSoundUnlock(): void {
  useEffect(() => {
    const unlock = () => {
      sound.unlock();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);
}
