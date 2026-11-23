// The nine shouts (CLIENT-SPEC 15.3 and 15.4): Ogg Opus files made once by tools/audio, imported
// with new URL(..., import.meta.url) so Vite hashes them. They are fetched at low priority after
// the first gesture, decoded on first use and kept as AudioBuffers. A browser that cannot decode
// Ogg Opus plays no shouts; the TRUCO panel, the captions and the vibration carry the moment.

import { MINEIRO_MANILHAS, SUIT_CLUBS, makeCard } from '../../../engine/src/cards.ts';
import type { Variant } from '../../../engine/src/config.ts';
import type { GameEvent } from '../../../engine/src/engine.ts';
import type { Shout } from './index.ts';

/** One literal URL per file: Vite only rewrites and hashes static new URL() calls. */
export const SHOUT_URLS: Record<Shout, URL> = {
  truco: new URL('../sfx/truco.opus', import.meta.url),
  seis: new URL('../sfx/seis.opus', import.meta.url),
  oito: new URL('../sfx/oito.opus', import.meta.url),
  nove: new URL('../sfx/nove.opus', import.meta.url),
  dez: new URL('../sfx/dez.opus', import.meta.url),
  doze: new URL('../sfx/doze.opus', import.meta.url),
  desce: new URL('../sfx/desce.opus', import.meta.url),
  corro: new URL('../sfx/corro.opus', import.meta.url),
  zap: new URL('../sfx/zap.opus', import.meta.url),
};

export const SHOUTS = Object.keys(SHOUT_URLS) as Shout[];

/** The shout of a bet: the first step is "truco", the next ones say the value. */
const CALL_SHOUTS: Partial<Record<number, Shout>> = { 6: 'seis', 8: 'oito', 9: 'nove', 10: 'dez', 12: 'doze' };

/** Same rule as callName() in game-text.ts: step 1 is truco, later steps are named by value. */
export function shoutForCall(value: number, step: number): Shout | null {
  if (step <= 1) return 'truco';
  return CALL_SHOUTS[value] ?? null;
}

/** The zap card of a hand: the manilha of clubs (paulista) or the 4 of clubs (mineiro). -1 if unknown. */
export function zapCard(variant: Variant, manilhaRank: number): number {
  if (variant === 'mineiro') return MINEIRO_MANILHAS[3];
  return manilhaRank >= 0 ? makeCard(manilhaRank, SUIT_CLUBS) : -1;
}

/**
 * The shout an event calls for (spec 15.4), or null: a raise says its call, an accept DESCE!, a run
 * (also running from the mão de onze) CORRO!, the zap played face up ZAP!.
 */
export function shoutForEvent(e: GameEvent, hand: { variant: Variant; manilhaRank: number }): Shout | null {
  switch (e.t) {
    case 'raise':
      return shoutForCall(e.value, e.step);
    case 'accept':
      return 'desce';
    case 'run':
      return 'corro';
    case 'onze':
      return e.play ? null : 'corro';
    case 'play': {
      if (e.faceDown || e.card < 0) return null;
      return e.card === zapCard(hand.variant, hand.manilhaRank) ? 'zap' : null;
    }
    default:
      return null;
  }
}

/** True when this browser says it can play Ogg Opus (spec 15.4 feature check). */
export function canPlayOpus(): boolean {
  try {
    return typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs="opus"') !== '';
  } catch {
    return false;
  }
}

/** Fetches the nine files once and decodes each on first use. Failures stay silent. */
export class ShoutBank {
  private bytes = new Map<Shout, Promise<ArrayBuffer | null>>();
  private decoded = new Map<Shout, Promise<AudioBuffer | null>>();
  private readonly urls: Record<Shout, URL | string>;

  constructor(urls: Record<Shout, URL | string> = SHOUT_URLS) {
    this.urls = urls;
  }

  /** Starts the low priority downloads; safe to call again. */
  prefetch(): void {
    for (const s of Object.keys(this.urls) as Shout[]) {
      if (this.bytes.has(s)) continue;
      const p = fetch(String(this.urls[s]), { priority: 'low' })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      this.bytes.set(s, p);
    }
  }

  /** The decoded shout, or null when it could not be fetched or decoded. */
  get(ctx: BaseAudioContext, s: Shout): Promise<AudioBuffer | null> {
    let d = this.decoded.get(s);
    if (!d) {
      if (!this.bytes.has(s)) this.prefetch();
      d = (this.bytes.get(s) ?? Promise.resolve(null)).then((b) => (b ? ctx.decodeAudioData(b).catch(() => null) : null));
      this.decoded.set(s, d);
    }
    return d;
  }
}
