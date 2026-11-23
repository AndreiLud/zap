// The synthesized sounds against the table of CLIENT-SPEC 15.2: the pure schedule builder (node
// parameters and times), the seeded noise and the renderer on a recording fake context.
import { describe, expect, it } from 'vitest';
import type { Sfx } from '../src/sound/index.ts';
import {
  FLOOR,
  NOISE_SEED,
  SHUFFLE_BURSTS,
  SHUFFLE_GAP,
  fillNoise,
  render,
  schedule,
  scheduleLength,
  type NoiseVoice,
  type Ramp,
  type ToneVoice,
  type Voice,
} from '../src/sound/synth.ts';

const ALL: Sfx[] = ['deal', 'play', 'playMine', 'gather', 'shuffle', 'tento', 'turn', 'tiles'];
const mid = () => 0.5;
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

function noise(v: Voice): NoiseVoice {
  expect(v.type).toBe('noise');
  return v as NoiseVoice;
}
function tone(v: Voice): ToneVoice {
  expect(v.type).toBe('tone');
  return v as ToneVoice;
}
function peak(r: Ramp[]): number {
  return Math.max(...r.map((x) => x.v));
}
/** The ramp that reaches the peak, and the last ramp. */
function shape(r: Ramp[]) {
  return { peakAt: r.find((x) => x.v === peak(r))!, last: r[r.length - 1] };
}

describe('schedule (spec 15.2 table)', () => {
  it('deal: noise 35 ms, bandpass 3,200 Hz Q 0.9, 2 ms attack to 0.22, exponential decay to 0.001 at 35 ms', () => {
    const [v, ...rest] = schedule('deal', mid);
    expect(rest).toHaveLength(0);
    const n = noise(v);
    close(n.start, 0);
    close(n.dur, 0.035);
    expect(n.filter).toEqual({ type: 'bandpass', freq: 3200, q: 0.9 });
    expect(n.gain).toEqual([
      { t: 0, v: 0, kind: 'set' },
      { t: 0.002, v: 0.22, kind: 'lin' },
      { t: 0.035, v: FLOOR, kind: 'exp' },
      { t: 0.035, v: 0, kind: 'set' },
    ]);
    close(FLOOR, 0.001);
  });

  it('deal: playback rate jitter from 0.94 to 1.06', () => {
    close(noise(schedule('deal', () => 0)[0]).rate, 0.94);
    close(noise(schedule('deal', () => 0.999999999)[0]).rate, 1.06);
    for (let i = 0; i < 200; i++) {
      const r = noise(schedule('deal')[0]).rate;
      expect(r).toBeGreaterThanOrEqual(0.94);
      expect(r).toBeLessThanOrEqual(1.06);
    }
  });

  for (const [name, lowpass] of [
    ['play', 2200],
    ['playMine', 2800],
  ] as const) {
    it(`${name}: noise 60 ms lowpass ${lowpass} Hz from 0.35, plus a 140 Hz sine of 70 ms at 0.18`, () => {
      const vs = schedule(name, mid);
      expect(vs).toHaveLength(2);
      const n = noise(vs[0]);
      close(n.dur, 0.06);
      expect(n.filter.type).toBe('lowpass');
      expect(n.filter.freq).toBe(lowpass);
      expect(n.rate).toBe(1);
      expect(n.gain[0]).toEqual({ t: 0, v: 0.35, kind: 'set' });
      expect(shape(n.gain).last).toEqual({ t: 0.06, v: 0, kind: 'set' });
      expect(n.gain).toContainEqual({ t: 0.06, v: FLOOR, kind: 'exp' });
      const s = tone(vs[1]);
      expect(s.freq).toBe(140);
      close(s.dur, 0.07);
      expect(s.gain[0]).toEqual({ t: 0, v: 0.18, kind: 'set' });
      expect(s.gain).toContainEqual({ t: 0.07, v: FLOOR, kind: 'exp' });
    });
  }

  it('gather: noise 220 ms, bandpass swept from 700 to 2,600 Hz, gain up to 0.15 at 80 ms and back to 0', () => {
    const vs = schedule('gather', mid);
    expect(vs).toHaveLength(1);
    const n = noise(vs[0]);
    close(n.dur, 0.22);
    expect(n.filter).toEqual({ type: 'bandpass', freq: 700, q: 1, sweepTo: 2600 });
    expect(n.gain).toEqual([
      { t: 0, v: 0, kind: 'set' },
      { t: 0.08, v: 0.15, kind: 'lin' },
      { t: 0.22, v: 0, kind: 'lin' },
    ]);
  });

  it('shuffle: 16 deal bursts 28 ms apart at 0.12, then one play', () => {
    const vs = schedule('shuffle', mid);
    expect(SHUFFLE_BURSTS).toBe(16);
    close(SHUFFLE_GAP, 0.028);
    expect(vs).toHaveLength(16 + 2);
    const deal = noise(schedule('deal', mid)[0]);
    for (let i = 0; i < 16; i++) {
      const n = noise(vs[i]);
      close(n.start, i * 0.028);
      expect(n.filter).toEqual(deal.filter);
      close(n.dur, deal.dur);
      expect(peak(n.gain)).toBe(0.12);
    }
    const play = schedule('play', mid);
    for (const [k, v] of vs.slice(16).entries()) {
      close(v.start, 16 * 0.028);
      expect({ ...v, start: 0, offset: 0 }).toEqual({ ...play[k], start: 0, offset: 0 });
    }
    // The whole shuffle fits in one riffle of the table timing (SHUFFLE, 600 ms in spec 11.6).
    expect(scheduleLength(vs)).toBeLessThan(0.6);
  });

  it('tento: sines at 1,046.5 and 1,568 Hz, 90 ms, 0.12 with exponential decay', () => {
    const vs = schedule('tento', mid).map(tone);
    expect(vs.map((v) => v.freq)).toEqual([1046.5, 1568]);
    for (const v of vs) {
      close(v.start, 0);
      close(v.dur, 0.09);
      expect(v.gain[0]).toEqual({ t: 0, v: 0.12, kind: 'set' });
      expect(v.gain).toContainEqual({ t: 0.09, v: FLOOR, kind: 'exp' });
    }
  });

  it('turn: 660 Hz for 40 ms, then 990 Hz for 30 ms, at 0.1', () => {
    const [a, b, ...rest] = schedule('turn', mid).map(tone);
    expect(rest).toHaveLength(0);
    expect([a.freq, b.freq]).toEqual([660, 990]);
    close(a.start, 0);
    close(a.dur, 0.04);
    close(b.start, 0.04);
    close(b.dur, 0.03);
    for (const v of [a, b]) {
      expect(peak(v.gain)).toBe(0.1);
      expect(v.gain[0]).toEqual({ t: 0, v: 0.1, kind: 'set' });
      // A short release ends each tone at zero, inside its own time.
      const last = v.gain[v.gain.length - 1];
      expect(last.v).toBe(0);
      close(last.t, v.dur);
    }
  });

  it('tiles: 10 noise clicks of 8 ms through a bandpass at 4,500 Hz, 40 ms apart, at 0.1', () => {
    const vs = schedule('tiles', mid).map(noise);
    expect(vs).toHaveLength(10);
    vs.forEach((n, i) => {
      close(n.start, i * 0.04);
      close(n.dur, 0.008);
      expect(n.filter.type).toBe('bandpass');
      expect(n.filter.freq).toBe(4500);
      expect(peak(n.gain)).toBe(0.1);
    });
  });

  it('every voice stays inside the 1 s noise buffer and every gain ends at zero', () => {
    for (const name of ALL) {
      for (const r of [0, 0.5, 0.999999]) {
        for (const v of schedule(name, () => r)) {
          const last = v.gain[v.gain.length - 1];
          expect(last.v).toBe(0);
          expect(v.gain.every((g) => g.t >= 0 && g.t <= v.dur + 1e-12)).toBe(true);
          expect(v.gain.filter((g) => g.kind === 'exp').every((g) => g.v > 0)).toBe(true);
          if (v.type === 'noise') {
            expect(v.offset).toBeGreaterThanOrEqual(0);
            expect(v.offset + v.dur * v.rate).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('each sound is short: the longest is the shuffle', () => {
    const len = Object.fromEntries(ALL.map((n) => [n, scheduleLength(schedule(n, mid))]));
    close(len.deal, 0.035);
    close(len.play, 0.07);
    close(len.gather, 0.22);
    close(len.tento, 0.09);
    close(len.turn, 0.07);
    close(len.tiles, 9 * 0.04 + 0.008);
    close(len.shuffle, 16 * 0.028 + 0.07);
  });
});

describe('noise buffer', () => {
  it('is filled by a seeded generator (seed 2026): same seed, same samples', () => {
    expect(NOISE_SEED).toBe(2026);
    const a = fillNoise(new Float32Array(48000));
    const b = fillNoise(new Float32Array(48000), 2026);
    expect(a).toEqual(b);
    expect(fillNoise(new Float32Array(16), 7)).not.toEqual(fillNoise(new Float32Array(16)));
  });

  it('is white noise from -1 to 1 centered on zero', () => {
    const a = fillNoise(new Float32Array(48000));
    let sum = 0;
    let sq = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of a) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      sum += x;
      sq += x * x;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThan(1);
    expect(Math.abs(sum / a.length)).toBeLessThan(0.02);
    // Uniform on [-1, 1): variance 1/3.
    expect(sq / a.length).toBeGreaterThan(0.3);
    expect(sq / a.length).toBeLessThan(0.36);
  });
});

// A context that records what render() builds.
type Call = [string, number, number];
class Param {
  value = 0;
  calls: Call[] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['lin', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(['exp', v, t]);
  }
}
class FakeNode {
  out: FakeNode[] = [];
  readonly kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(n: FakeNode) {
    this.out.push(n);
    return n;
  }
  disconnect() {}
}
class Gain extends FakeNode {
  gain = new Param();
}
class Filter extends FakeNode {
  type = '';
  Q = new Param();
  frequency = new Param();
}
class Source extends FakeNode {
  started: number[] = [];
  stopped = -1;
  start(...a: number[]) {
    this.started = a;
  }
  stop(t: number) {
    this.stopped = t;
  }
}
class BufferSource extends Source {
  buffer: unknown = null;
  playbackRate = new Param();
}
class Osc extends Source {
  type = '';
  frequency = new Param();
}
class Ctx {
  nodes: FakeNode[] = [];
  private add<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return this.add(new Gain('gain'));
  }
  createBiquadFilter() {
    return this.add(new Filter('filter'));
  }
  createBufferSource() {
    return this.add(new BufferSource('buffer'));
  }
  createOscillator() {
    return this.add(new Osc('osc'));
  }
}

describe('render', () => {
  it('builds source, filter and gain per noise voice, oscillator and gain per tone, all into the output', () => {
    const ctx = new Ctx();
    const out = new FakeNode('panner');
    const buf = { noise: true };
    const voices = schedule('play', mid);
    const last = render(ctx as unknown as BaseAudioContext, voices, buf as unknown as AudioBuffer, out as unknown as AudioNode, 10);
    const kinds = ctx.nodes.map((n) => n.kind);
    expect(kinds.sort()).toEqual(['buffer', 'filter', 'gain', 'gain', 'osc']);
    const src = ctx.nodes.find((n) => n.kind === 'buffer') as BufferSource;
    const filter = ctx.nodes.find((n) => n.kind === 'filter') as Filter;
    const osc = ctx.nodes.find((n) => n.kind === 'osc') as Osc;
    const gains = ctx.nodes.filter((n) => n.kind === 'gain') as Gain[];
    expect(src.buffer).toBe(buf);
    expect(src.out).toEqual([filter]);
    expect(filter.type).toBe('lowpass');
    expect(filter.frequency.calls).toEqual([['set', 2200, 10]]);
    expect(gains.every((g) => g.out[0] === out)).toBe(true);
    expect(src.started[0]).toBe(10);
    expect(src.started[1]).toBeCloseTo((voices[0] as NoiseVoice).offset, 12);
    expect(src.stopped).toBeCloseTo(10.06, 12);
    expect(osc.type).toBe('sine');
    expect(osc.frequency.value).toBe(140);
    expect(osc.started).toEqual([10]);
    expect(osc.stopped).toBeCloseTo(10.07, 12);
    // The sine ends last, so it is the one whose end disconnects the panner.
    expect(last).toBe(osc);
    // Gain automation follows the schedule, shifted to context time.
    const noiseGain = gains.find((g) => src.out[0].out[0] === g)!;
    expect(noiseGain.gain.calls[0]).toEqual(['set', 0.35, 10]);
    expect(noiseGain.gain.calls.at(-1)![0]).toBe('set');
    expect(noiseGain.gain.calls.at(-1)![2]).toBeCloseTo(10.06, 12);
  });

  it('sweeps the gather filter exponentially over the voice', () => {
    const ctx = new Ctx();
    render(ctx as unknown as BaseAudioContext, schedule('gather', mid), {} as AudioBuffer, new FakeNode('p') as unknown as AudioNode, 2);
    const f = ctx.nodes.find((n) => n.kind === 'filter') as Filter;
    expect(f.type).toBe('bandpass');
    expect(f.frequency.calls[0]).toEqual(['set', 700, 2]);
    expect(f.frequency.calls[1][0]).toBe('exp');
    expect(f.frequency.calls[1][1]).toBe(2600);
    expect(f.frequency.calls[1][2]).toBeCloseTo(2.22, 12);
  });

  it('applies the deal jitter as the playback rate', () => {
    const ctx = new Ctx();
    render(ctx as unknown as BaseAudioContext, schedule('deal', () => 0), {} as AudioBuffer, new FakeNode('p') as unknown as AudioNode, 0);
    const src = ctx.nodes.find((n) => n.kind === 'buffer') as BufferSource;
    expect(src.playbackRate.value).toBeCloseTo(0.94, 12);
  });
});
