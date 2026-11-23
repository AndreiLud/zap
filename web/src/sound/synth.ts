// Synthesized card and table sounds (CLIENT-SPEC 15.2). No files: every sound is built from one
// shared noise buffer and sine oscillators. `schedule()` is pure: it returns the voices of a sound
// (node parameters and times relative to its start), so web/test/sound-synth.test.ts checks it
// against the spec table without a browser. `render()` turns a schedule into Web Audio nodes.

import type { Sfx } from './index.ts';

/** One point of a gain or frequency automation: set at once, or a linear or exponential ramp to it. */
export interface Ramp {
  t: number;
  v: number;
  kind: 'set' | 'lin' | 'exp';
}

export interface NoiseFilter {
  type: 'bandpass' | 'lowpass';
  freq: number;
  q: number;
  /** Exponential sweep of the filter frequency to this value over the voice. */
  sweepTo?: number;
}

/** A slice of the shared noise buffer through one filter and one gain envelope. */
export interface NoiseVoice {
  type: 'noise';
  start: number;
  dur: number;
  /** Playback rate of the noise slice (the deal jitter). */
  rate: number;
  /** Where the slice starts in the 1 s noise buffer, in seconds. */
  offset: number;
  filter: NoiseFilter;
  gain: Ramp[];
}

/** A sine oscillator through one gain envelope. */
export interface ToneVoice {
  type: 'tone';
  start: number;
  dur: number;
  freq: number;
  gain: Ramp[];
}

export type Voice = NoiseVoice | ToneVoice;

/** Seconds of the shared white noise buffer. */
export const NOISE_SECONDS = 1;
/** Seed of the noise generator (spec 15.1). */
export const NOISE_SEED = 2026;
/** Exponential ramps cannot reach zero: they end here, then the gain is set to zero. */
export const FLOOR = 0.001;
/** Short linear release that ends a held tone without a click. */
export const RELEASE = 0.004;

/** Fills `out` with white noise from -1 to 1 by a linear congruential generator (seed 2026). */
export function fillNoise(out: Float32Array, seed: number = NOISE_SEED): Float32Array {
  let x = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x / 2147483648 - 1;
  }
  return out;
}

/** Attack to `peak`, then exponential decay to the floor at `dur`, then silence. */
function strike(peak: number, dur: number, attack = 0): Ramp[] {
  const head: Ramp[] = attack > 0 ? [{ t: 0, v: 0, kind: 'set' }, { t: attack, v: peak, kind: 'lin' }] : [{ t: 0, v: peak, kind: 'set' }];
  return [...head, { t: dur, v: FLOOR, kind: 'exp' }, { t: dur, v: 0, kind: 'set' }];
}

/** A flat tone at `level` with a short release at its end. */
function held(level: number, dur: number): Ramp[] {
  return [
    { t: 0, v: level, kind: 'set' },
    { t: dur - RELEASE, v: level, kind: 'set' },
    { t: dur, v: 0, kind: 'lin' },
  ];
}

/** A random start inside the noise buffer that leaves room for the whole slice. */
function noiseOffset(dur: number, rate: number, rand: () => number): number {
  return rand() * Math.max(0, NOISE_SECONDS - dur * rate);
}

function dealBurst(start: number, peak: number, rand: () => number): NoiseVoice {
  const dur = 0.035;
  const rate = 0.94 + rand() * 0.12;
  return {
    type: 'noise',
    start,
    dur,
    rate,
    offset: noiseOffset(dur, rate, rand),
    filter: { type: 'bandpass', freq: 3200, q: 0.9 },
    gain: strike(peak, dur, 0.002),
  };
}

function cardDown(start: number, lowpass: number, rand: () => number): Voice[] {
  const dur = 0.06;
  return [
    {
      type: 'noise',
      start,
      dur,
      rate: 1,
      offset: noiseOffset(dur, 1, rand),
      filter: { type: 'lowpass', freq: lowpass, q: 1 },
      gain: strike(0.35, dur),
    },
    { type: 'tone', start, dur: 0.07, freq: 140, gain: strike(0.18, 0.07) },
  ];
}

/** Gap between the deal bursts of a shuffle. */
export const SHUFFLE_GAP = 0.028;
export const SHUFFLE_BURSTS = 16;

/**
 * The voices of one sound, times in seconds from its start. `rand` returns a number from 0 to 1
 * (Math.random in the browser); it moves the noise slice and the deal jitter, nothing else.
 */
export function schedule(name: Sfx, rand: () => number = Math.random): Voice[] {
  switch (name) {
    case 'deal':
      return [dealBurst(0, 0.22, rand)];
    case 'play':
      return cardDown(0, 2200, rand);
    case 'playMine':
      return cardDown(0, 2800, rand);
    case 'gather': {
      const dur = 0.22;
      return [
        {
          type: 'noise',
          start: 0,
          dur,
          rate: 1,
          offset: noiseOffset(dur, 1, rand),
          filter: { type: 'bandpass', freq: 700, q: 1, sweepTo: 2600 },
          gain: [
            { t: 0, v: 0, kind: 'set' },
            { t: 0.08, v: 0.15, kind: 'lin' },
            { t: dur, v: 0, kind: 'lin' },
          ],
        },
      ];
    }
    case 'shuffle': {
      const out: Voice[] = [];
      for (let i = 0; i < SHUFFLE_BURSTS; i++) out.push(dealBurst(i * SHUFFLE_GAP, 0.12, rand));
      out.push(...cardDown(SHUFFLE_BURSTS * SHUFFLE_GAP, 2200, rand));
      return out;
    }
    case 'tento':
      return [1046.5, 1568].map((freq): Voice => ({ type: 'tone', start: 0, dur: 0.09, freq, gain: strike(0.12, 0.09) }));
    case 'turn':
      return [
        { type: 'tone', start: 0, dur: 0.04, freq: 660, gain: held(0.1, 0.04) },
        { type: 'tone', start: 0.04, dur: 0.03, freq: 990, gain: held(0.1, 0.03) },
      ];
    case 'tiles': {
      const out: Voice[] = [];
      for (let i = 0; i < 10; i++) {
        const dur = 0.008;
        out.push({
          type: 'noise',
          start: i * 0.04,
          dur,
          rate: 1,
          offset: noiseOffset(dur, 1, rand),
          filter: { type: 'bandpass', freq: 4500, q: 1 },
          gain: strike(0.1, dur),
        });
      }
      return out;
    }
  }
}

/** Length of a schedule in seconds: when its last voice ends. */
export function scheduleLength(voices: readonly Voice[]): number {
  return voices.reduce((m, v) => Math.max(m, v.start + v.dur), 0);
}

function automate(param: AudioParam, ramps: readonly Ramp[], at: number): void {
  for (const r of ramps) {
    const when = at + r.t;
    if (r.kind === 'set') param.setValueAtTime(r.v, when);
    else if (r.kind === 'lin') param.linearRampToValueAtTime(r.v, when);
    else param.exponentialRampToValueAtTime(r.v, when);
  }
}

/**
 * Builds the nodes of a schedule at context time `at` into `out` (the sound's stereo panner).
 * Returns the source that ends last, so the caller can disconnect the panner when it ends.
 */
export function render(ctx: BaseAudioContext, voices: readonly Voice[], noise: AudioBuffer, out: AudioNode, at: number): AudioScheduledSourceNode | null {
  let last: AudioScheduledSourceNode | null = null;
  let lastEnd = -1;
  for (const v of voices) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    automate(gain.gain, v.gain, at + v.start);
    gain.connect(out);
    let src: AudioScheduledSourceNode;
    if (v.type === 'noise') {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.playbackRate.value = v.rate;
      const f = ctx.createBiquadFilter();
      f.type = v.filter.type;
      f.Q.value = v.filter.q;
      f.frequency.setValueAtTime(v.filter.freq, at + v.start);
      if (v.filter.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(v.filter.sweepTo, at + v.start + v.dur);
      s.connect(f);
      f.connect(gain);
      s.start(at + v.start, v.offset);
      src = s;
    } else {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = v.freq;
      o.connect(gain);
      o.start(at + v.start);
      src = o;
    }
    const end = at + v.start + v.dur;
    src.stop(end);
    if (end > lastEnd) {
      lastEnd = end;
      last = src;
    }
  }
  return last;
}
