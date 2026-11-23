// Sound and vibration (CLIENT-SPEC 15). One AudioContext, made on the first gesture at a table or
// on the guided page. Graph: each sound gets its own stereo panner, all panners feed a master gain
// of 0.8, then a compressor with default settings, then the speakers. Card and table sounds are
// synthesized (synth.ts); the nine shouts are small Ogg Opus files (shouts.ts).
//
// Rules: nothing plays before a user gesture, while the page is hidden, while an ad shows, or with
// the switch off (store.soundOn, localStorage 'zap-sound', '0' turns it off, default on). A sound
// asked for while the context is not running is dropped, never queued, so nothing bursts out later.
// Vibration follows the same switch and only runs on a visible page after a gesture.
//
// Use from the table and the guided match (spec 11.6):
//   onPointerDown / onKeyDown          sound.unlock()   (cheap; call it on every one)
//   a card lands                       sound.play('play', { pan: panFor('left') })
//   any event                          const s = shoutForEvent(e, view); if (s) sound.shout(s, { pan })
//   your turn, a raise you must answer sound.vibrate(VIBRATION.turn), sound.vibrate(VIBRATION.answer)

import { ShoutBank, canPlayOpus } from './shouts.ts';
import { NOISE_SECONDS, fillNoise, render, schedule } from './synth.ts';

export type Sfx = 'deal' | 'play' | 'playMine' | 'gather' | 'shuffle' | 'tento' | 'turn' | 'tiles';
export type Shout = 'truco' | 'seis' | 'oito' | 'nove' | 'dez' | 'doze' | 'desce' | 'corro' | 'zap';

export { shoutForCall, shoutForEvent, zapCard } from './shouts.ts';

/** Stereo position of each seat on screen (spec 15.1): left and right seats are panned, the rest centered. */
export const PAN = { bottom: 0, right: 0.6, top: 0, left: -0.6 } as const;
export type SeatPosition = keyof typeof PAN;

/** Vibration patterns of spec 15.5, in milliseconds. */
export const VIBRATION = {
  turn: 20,
  answer: [40, 60, 40],
  won: [30, 50, 30, 50, 80],
} as const satisfies Record<string, number | readonly number[]>;

export const MASTER_GAIN = 0.8;
/** Sounds start this many seconds after the call, so the first ramp is never in the past. */
const LEAD = 0.005;
/** A shout still decoding after this long has missed its moment and is dropped. */
const SHOUT_LATE_MS = 500;

let enabled = true;
let adPause = false;
let unlocked = false;
let failed = false;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let bank: ShoutBank | null = null;
let current: AudioBufferSourceNode | null = null;
let shoutToken = 0;

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

function allowed(): boolean {
  return enabled && !adPause && !pageHidden();
}

/** The page had a user gesture at some point (sticky activation), so audio and vibration may start. */
function hadGesture(): boolean {
  if (unlocked) return true;
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation;
  return ua?.hasBeenActive === true;
}

/**
 * Makes the context inside the gesture (browsers start audio only there). Everything else waits for
 * the next task (prepare), so the first tap at a table pays only for the browser's own audio start.
 */
function createContext(): void {
  if (ctx || failed || typeof AudioContext === 'undefined') return;
  let c: AudioContext | null = null;
  try {
    c = new AudioContext();
    const m = c.createGain();
    m.gain.value = MASTER_GAIN;
    const comp = c.createDynamicsCompressor();
    m.connect(comp);
    comp.connect(c.destination);
    ctx = c;
    master = m;
    bank = canPlayOpus() ? new ShoutBank() : null;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => (pageHidden() ? sleep() : wake()));
    // The browser may stop the context on its own (iOS "interrupted"): come back on the next press.
    c.onstatechange = () => {
      if (ctx && ctx.state !== 'running' && allowed()) arm();
    };
    setTimeout(prepare, 0);
  } catch {
    // No Web Audio here (or the browser refused a context): stay silent, never retry.
    failed = true;
    ctx = null;
    c?.close().catch(() => {});
  }
}

/**
 * Right after the gesture: fills the noise buffer, then renders one card sound into a muted node so
 * the code and the node types are warm before the first card click (measured in Chromium at 4x CPU:
 * about 10 ms of the click cold, about 2 ms warm). Sounds asked for before this runs are dropped
 * like any sound that cannot play yet.
 */
function prepare(): void {
  if (!ctx || noise) return;
  try {
    const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    fillNoise(buf.getChannelData(0));
    const muted = ctx.createGain();
    muted.gain.value = 0;
    render(ctx, schedule('playMine'), buf, muted, ctx.currentTime);
    noise = buf;
  } catch {
    failed = true;
    return;
  }
  wake();
}

/** Makes the context and wakes it, only while sound is allowed: a switched off page opens no audio device. */
function start(): void {
  if (!allowed()) return;
  createContext();
  wake();
}

/** Resumes the context when sound is allowed; once prepared, also starts the shout downloads. */
function wake(): void {
  if (!ctx || !allowed()) return;
  if (ctx.state !== 'running' && ctx.state !== 'closed') {
    // Outside a gesture some browsers (Safari) refuse to resume: until it works, the next press will.
    arm();
    const c = ctx;
    c.resume().then(
      () => {
        if (c.state === 'running') disarm();
      },
      () => {},
    );
  }
  if (noise) bank?.prefetch();
}

let armed = false;

function onPress(): void {
  disarm();
  start();
}

/**
 * Waits for the next pointer or key press anywhere on the page and starts the sound there. Callers
 * may call unlock() only once (the table drops its listener after the first gesture), so a context
 * stopped later (hidden page, ad, a phone call) still finds a gesture to come back with.
 */
function arm(): void {
  if (armed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  armed = true;
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('keydown', onPress, true);
}

function disarm(): void {
  if (!armed) return;
  armed = false;
  window.removeEventListener('pointerdown', onPress, true);
  window.removeEventListener('keydown', onPress, true);
}

/** Stops the shout and lets the audio thread rest (switch off, ad, hidden page). */
function sleep(): void {
  stopShout();
  disarm();
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
}

function stopShout(): void {
  shoutToken++;
  if (!current) return;
  try {
    current.stop();
  } catch {
    // Already ended.
  }
  current = null;
}

/** The running context, made now if the page already had a gesture; null when nothing may play. */
function live(): AudioContext | null {
  if (!allowed()) return null;
  if (!ctx && hadGesture()) {
    unlocked = true;
    start();
  }
  if (!ctx) return null;
  if (ctx.state === 'running') return ctx;
  // Allowed to play but stopped: try now, and again on the next press (wake arms it).
  wake();
  return null;
}

function pannerFor(c: AudioContext, pan: number | undefined): StereoPannerNode {
  const p = c.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan ?? 0));
  p.connect(master as GainNode);
  return p;
}

export const sound = {
  /** On the first pointerdown or keydown at a table or the guided page; cheap to call on every one. */
  unlock(): void {
    unlocked = true;
    start();
  },
  play(s: Sfx, o?: { pan?: number }): void {
    const c = live();
    if (!c || !noise) return;
    const p = pannerFor(c, o?.pan);
    const last = render(c, schedule(s), noise, p, c.currentTime + LEAD);
    if (last) last.onended = () => p.disconnect();
    else p.disconnect();
  },
  /** At most one shout at a time: a new one stops the previous one. */
  shout(s: Shout, o?: { pan?: number }): void {
    const c = live();
    if (!c || !bank) return;
    stopShout();
    const token = shoutToken;
    const asked = performance.now();
    bank.get(c, s).then((buf) => {
      if (!buf || token !== shoutToken || ctx !== c || c.state !== 'running' || !allowed()) return;
      if (performance.now() - asked > SHOUT_LATE_MS) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      const p = pannerFor(c, o?.pan);
      src.connect(p);
      src.onended = () => {
        p.disconnect();
        if (current === src) current = null;
      };
      current = src;
      src.start(c.currentTime + LEAD);
    });
  },
  vibrate(pattern: number | readonly number[]): void {
    if (!allowed() || !hadGesture() || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    try {
      navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
    } catch {
      // Blocked by the browser: the screen carries the moment.
    }
  },
  setEnabled(on: boolean): void {
    enabled = on;
    if (!on) sleep();
    else if (unlocked) start();
  },
  /** Ads: silence everything while an ad shows. */
  suspend(): void {
    adPause = true;
    sleep();
  },
  resume(): void {
    adPause = false;
    wake();
  },
};

/** Stereo pan of a seat by its place on screen. */
export function panFor(pos: SeatPosition): number {
  return PAN[pos];
}
