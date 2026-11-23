// The sound module (CLIENT-SPEC 15.1, 15.4, 15.5) on a recording fake of Web Audio: when sound may
// play, the graph, the shouts and the vibration. Also the mapping from game events to shouts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RANKS, SUIT_CLUBS, makeCard, manilhaRankForVira, parseCard, strengthTable } from '../../engine/src/cards.ts';
import type { GameEvent } from '../../engine/src/engine.ts';
import { shoutForCall, shoutForEvent, zapCard } from '../src/sound/shouts.ts';

type Mod = typeof import('../src/sound/index.ts');

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class FakeNode {
  readonly kind: string;
  out: FakeNode[] = [];
  disconnects = 0;
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(n: FakeNode) {
    this.out.push(n);
    return n;
  }
  disconnect() {
    this.disconnects++;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakePanner extends FakeNode {
  pan = new FakeParam();
}
class FakeFilter extends FakeNode {
  type = '';
  Q = new FakeParam();
  frequency = new FakeParam();
}
class FakeSource extends FakeNode {
  type = '';
  buffer: unknown = null;
  playbackRate = new FakeParam();
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  started: number[] | null = null;
  stops = 0;
  start(...a: number[]) {
    this.started = a;
  }
  stop() {
    this.stops++;
  }
}
class FakeContext {
  static made: FakeContext[] = [];
  static startState: 'running' | 'suspended' = 'running';
  static resumeWorks = true;
  static decode: (b: ArrayBuffer) => Promise<unknown> = (b) => Promise.resolve({ decoded: b });
  state: string;
  currentTime = 1;
  sampleRate = 8000;
  destination = new FakeNode('destination');
  nodes: FakeNode[] = [];
  noise: Float32Array | null = null;
  decodes = 0;
  constructor() {
    FakeContext.made.push(this);
    this.state = FakeContext.startState;
  }
  private add<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return this.add(new FakeGain('gain'));
  }
  createStereoPanner() {
    return this.add(new FakePanner('panner'));
  }
  createDynamicsCompressor() {
    return this.add(new FakeNode('compressor'));
  }
  createBiquadFilter() {
    return this.add(new FakeFilter('filter'));
  }
  createBufferSource() {
    return this.add(new FakeSource('buffer'));
  }
  createOscillator() {
    return this.add(new FakeSource('osc'));
  }
  createBuffer(_ch: number, length: number, rate: number) {
    this.noise = new Float32Array(length);
    const data = this.noise;
    return { length, sampleRate: rate, getChannelData: () => data };
  }
  resume() {
    if (FakeContext.resumeWorks) this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  decodeAudioData(b: ArrayBuffer) {
    this.decodes++;
    return FakeContext.decode(b);
  }
  /** Every node of this kind made since the last mark (settle() marks after the warm-up render). */
  of(kind: string) {
    return this.nodes.slice(this.since).filter((n) => n.kind === kind);
  }
  all(kind: string) {
    return this.nodes.filter((n) => n.kind === kind);
  }
  since = 0;
}


let doc: { hidden: boolean; fire(): void; addEventListener(t: string, fn: () => void): void };
let nav: { vibrate?: ReturnType<typeof vi.fn>; userActivation: { hasBeenActive: boolean } };
let canPlay: string;
let fetchMock: ReturnType<typeof vi.fn>;
let win: { press(type?: string): void; count(): number; addEventListener(t: string, fn: () => void, c?: boolean): void; removeEventListener(t: string, fn: () => void, c?: boolean): void };

async function load(): Promise<Mod> {
  vi.resetModules();
  return import('../src/sound/index.ts');
}
const ctx = () => FakeContext.made[0];
const flush = () => new Promise((r) => setTimeout(r, 0));
/** After unlock(): lets the deferred preparation run, then counts only the nodes made after it. */
async function settle() {
  await flush();
  ctx().since = ctx().nodes.length;
}

beforeEach(() => {
  FakeContext.made = [];
  FakeContext.startState = 'running';
  FakeContext.resumeWorks = true;
  FakeContext.decode = (b) => Promise.resolve({ decoded: b });
  const listeners: Array<() => void> = [];
  doc = {
    hidden: false,
    fire: () => listeners.forEach((f) => f()),
    addEventListener: (t, fn) => {
      if (t === 'visibilitychange') listeners.push(fn);
    },
  };
  nav = { vibrate: vi.fn(() => true), userActivation: { hasBeenActive: false } };
  canPlay = 'probably';
  fetchMock = vi.fn(async (url: string) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer }));
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal(
    'Audio',
    class {
      canPlayType() {
        return canPlay;
      }
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  const handlers = new Map<string, Set<() => void>>();
  win = {
    press: (type = 'pointerdown') => [...(handlers.get(type) ?? [])].forEach((fn) => fn()),
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    addEventListener: (t, fn) => {
      if (!handlers.has(t)) handlers.set(t, new Set());
      handlers.get(t)!.add(fn);
    },
    removeEventListener: (t, fn) => handlers.get(t)?.delete(fn),
  };
  vi.stubGlobal('window', win);
});

afterEach(async () => {
  // Let a preparation a test left pending run against that test's fakes, not the next test's.
  await flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('before a gesture', () => {
  it('nothing plays, nothing downloads, nothing vibrates', async () => {
    const { sound } = await load();
    sound.play('deal');
    sound.shout('truco');
    sound.vibrate(20);
    await flush();
    expect(FakeContext.made).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nav.vibrate).not.toHaveBeenCalled();
  });

  it('a page that already had a gesture (sticky activation) may start audio without unlock()', async () => {
    const { sound } = await load();
    nav.userActivation.hasBeenActive = true;
    sound.play('deal');
    expect(FakeContext.made).toHaveLength(1);
    // That first sound came before the preparation and was dropped; the next one plays.
    await settle();
    sound.play('deal');
    expect(ctx().of('buffer')).toHaveLength(1);
  });
});

describe('unlock and the graph', () => {
  it('makes one context: master gain 0.8, then a compressor, then the speakers', async () => {
    const { sound, MASTER_GAIN } = await load();
    sound.unlock();
    sound.unlock();
    expect(FakeContext.made).toHaveLength(1);
    expect(MASTER_GAIN).toBe(0.8);
    const [master] = ctx().all('gain') as FakeGain[];
    const [comp] = ctx().all('compressor');
    expect(master.gain.value).toBe(0.8);
    expect(master.out).toEqual([comp]);
    expect(comp.out).toEqual([ctx().destination]);
  });

  it('inside the gesture makes only the context; noise, warm-up and downloads wait for the next task', async () => {
    const { sound } = await load();
    sound.unlock();
    expect(ctx().noise).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    sound.play('deal');
    expect(ctx().all('buffer')).toHaveLength(0);
    await flush();
    expect(ctx().noise).toHaveLength(8000);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    // The warm-up is one card sound into a muted gain that reaches nothing.
    const [master, muted] = ctx().all('gain') as FakeGain[];
    expect(muted.gain.value).toBe(0);
    expect(muted.out).toEqual([]);
    expect(ctx().all('buffer')).toHaveLength(1);
    expect(ctx().all('osc')).toHaveLength(1);
    expect(master.out[0].kind).toBe('compressor');
  });

  it('fills one mono noise buffer of 1 s at the context rate', async () => {
    const { sound } = await load();
    sound.unlock();
    await flush();
    expect(ctx().noise).toHaveLength(8000);
    expect(ctx().noise!.some((x) => x !== 0)).toBe(true);
  });

  it('gives each sound its own stereo panner into the master gain', async () => {
    const { sound, PAN, panFor } = await load();
    expect(PAN).toEqual({ bottom: 0, right: 0.6, top: 0, left: -0.6 });
    sound.unlock();
    await settle();
    const master = ctx().all('gain')[0];
    sound.play('play', { pan: panFor('left') });
    sound.play('playMine');
    sound.play('deal', { pan: 3 });
    const pans = ctx().of('panner') as FakePanner[];
    expect(pans.map((p) => p.pan.value)).toEqual([-0.6, 0, 1]);
    expect(pans.every((p) => p.out[0] === master)).toBe(true);
    // The panner lets go when the last source of its sound ends.
    const sources = ctx().of('osc') as FakeSource[];
    sources[0].onended!();
    expect(pans[0].disconnects).toBe(1);
  });

  it('starts sounds just after the current time, never in the past', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.play('deal');
    const [src] = ctx().of('buffer') as FakeSource[];
    expect(src.started![0]).toBeGreaterThan(ctx().currentTime);
    expect(src.started![0]).toBeLessThan(ctx().currentTime + 0.05);
  });

  it('drops sounds while the context is not running, so nothing bursts out later', async () => {
    FakeContext.startState = 'suspended';
    FakeContext.resumeWorks = false;
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.play('deal');
    sound.shout('truco');
    await flush();
    expect(ctx().of('buffer')).toHaveLength(0);
  });

  it('stays silent where there is no Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const { sound } = await load();
    sound.unlock();
    await flush();
    expect(() => sound.play('deal')).not.toThrow();
    expect(() => sound.shout('zap')).not.toThrow();
  });
});

describe('the switch, the hidden page and the ads', () => {
  it('off: nothing plays and the context rests; on again: it wakes', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.setEnabled(false);
    expect(ctx().state).toBe('suspended');
    sound.play('deal');
    sound.vibrate(20);
    expect(ctx().of('buffer')).toHaveLength(0);
    expect(nav.vibrate).not.toHaveBeenCalled();
    sound.setEnabled(true);
    expect(ctx().state).toBe('running');
    sound.play('deal');
    expect(ctx().of('buffer')).toHaveLength(1);
  });

  it('a page that starts switched off opens no audio device and downloads no shout', async () => {
    const { sound } = await load();
    sound.setEnabled(false);
    sound.unlock();
    await flush();
    expect(FakeContext.made).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    sound.setEnabled(true);
    expect(FakeContext.made).toHaveLength(1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('hidden page: nothing plays; the context rests until the page shows again', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    doc.hidden = true;
    doc.fire();
    expect(ctx().state).toBe('suspended');
    sound.play('deal');
    sound.vibrate(20);
    expect(ctx().of('buffer')).toHaveLength(0);
    expect(nav.vibrate).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.fire();
    expect(ctx().state).toBe('running');
    sound.play('deal');
    expect(ctx().of('buffer')).toHaveLength(1);
  });

  it('suspend() for an ad silences everything until resume()', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.suspend();
    sound.play('turn');
    sound.vibrate(20);
    expect(ctx().of('osc')).toHaveLength(0);
    expect(nav.vibrate).not.toHaveBeenCalled();
    sound.resume();
    sound.play('turn');
    expect(ctx().of('osc')).toHaveLength(2);
  });
});

describe('shouts', () => {
  it('download the nine files at low priority after the gesture, once', async () => {
    const { sound } = await load();
    sound.unlock();
    sound.unlock();
    await flush();
    sound.unlock();
    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/\/sfx\/[a-z]+\.opus$/);
      expect(init).toEqual({ priority: 'low' });
    }
  });

  it('decode on first use, play through a panner, and decode each file only once', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('truco', { pan: 0.6 });
    await flush();
    const [src] = ctx().of('buffer') as FakeSource[];
    expect(src.buffer).toMatchObject({ decoded: expect.any(ArrayBuffer) });
    expect(src.started).not.toBeNull();
    const pan = src.out[0] as FakePanner;
    expect(pan.kind).toBe('panner');
    expect(pan.pan.value).toBe(0.6);
    sound.shout('truco');
    await flush();
    expect(ctx().decodes).toBe(1);
  });

  it('play one at a time: a new shout stops the one playing', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('truco');
    await flush();
    const [first] = ctx().of('buffer') as FakeSource[];
    sound.shout('desce');
    expect(first.stops).toBe(1);
    await flush();
    expect(ctx().of('buffer')).toHaveLength(2);
  });

  it('a shout overtaken while decoding never plays', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('seis');
    sound.shout('nove');
    await flush();
    const played = (ctx().of('buffer') as FakeSource[]).filter((s) => s.started);
    expect(played).toHaveLength(1);
    expect(new TextDecoder().decode((played[0].buffer as { decoded: ArrayBuffer }).decoded)).toMatch(/nove\.opus$/);
  });

  it('a shout that decodes too late is dropped', async () => {
    let finish: (v: unknown) => void = () => {};
    FakeContext.decode = () => new Promise((r) => (finish = r));
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('zap');
    await flush();
    now += 600;
    finish({ decoded: new ArrayBuffer(1) });
    await flush();
    expect(ctx().of('buffer')).toHaveLength(0);
  });

  it('switching off stops the shout that is playing', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('corro');
    await flush();
    const [src] = ctx().of('buffer') as FakeSource[];
    sound.setEnabled(false);
    expect(src.stops).toBe(1);
  });

  it('are skipped silently where Ogg Opus does not play, with no download', async () => {
    canPlay = '';
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('truco');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx().of('buffer')).toHaveLength(0);
    sound.play('deal');
    expect(ctx().of('buffer')).toHaveLength(1);
  });

  it('are skipped silently when a download or a decode fails', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }));
    const { sound } = await load();
    sound.unlock();
    await settle();
    sound.shout('truco');
    await flush();
    expect(ctx().of('buffer')).toHaveLength(0);
    expect(ctx().decodes).toBe(0);

    fetchMock.mockImplementation(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
    FakeContext.decode = () => Promise.reject(new Error('bad file'));
    const again = await load();
    FakeContext.made = [];
    again.sound.unlock();
    await settle();
    again.sound.shout('dez');
    await flush();
    expect(ctx().decodes).toBe(1);
    expect(ctx().of('buffer')).toHaveLength(0);
  });
});

describe('coming back after the browser stops the sound', () => {
  it('a resume refused outside a gesture is retried on the next press, once', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    doc.hidden = true;
    doc.fire();
    expect(ctx().state).toBe('suspended');
    // Safari: no resume without a gesture.
    FakeContext.resumeWorks = false;
    doc.hidden = false;
    doc.fire();
    expect(ctx().state).toBe('suspended');
    sound.play('deal');
    expect(ctx().of('buffer')).toHaveLength(0);
    expect(win.count()).toBe(2);
    FakeContext.resumeWorks = true;
    win.press('keydown');
    await flush();
    expect(ctx().state).toBe('running');
    expect(win.count()).toBe(0);
    sound.play('deal');
    expect(ctx().of('buffer')).toHaveLength(1);
  });

  it('a context the browser interrupts comes back on the next press', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    const c = ctx() as FakeContext & { onstatechange: (() => void) | null };
    FakeContext.resumeWorks = false;
    c.state = 'interrupted';
    c.onstatechange!();
    // Armed by the state change alone, before any sound is asked for.
    expect(win.count()).toBe(2);
    sound.play('turn');
    expect(ctx().of('osc')).toHaveLength(0);
    FakeContext.resumeWorks = true;
    win.press();
    expect(ctx().state).toBe('running');
    sound.play('turn');
    expect(ctx().of('osc')).toHaveLength(2);
  });

  it('switching off or an ad does not wait for a press', async () => {
    const { sound } = await load();
    sound.unlock();
    await settle();
    const c = ctx() as FakeContext & { onstatechange: (() => void) | null };
    sound.setEnabled(false);
    c.onstatechange!();
    sound.setEnabled(true);
    sound.suspend();
    c.onstatechange!();
    await flush();
    expect(win.count()).toBe(0);
  });
});

describe('vibration (spec 15.5)', () => {
  it('uses the three patterns of the spec', async () => {
    const { VIBRATION } = await load();
    expect(VIBRATION).toEqual({ turn: 20, answer: [40, 60, 40], won: [30, 50, 30, 50, 80] });
  });

  it('vibrates after a gesture, on a visible page, with the switch on', async () => {
    const { sound, VIBRATION } = await load();
    sound.unlock();
    sound.vibrate(VIBRATION.turn);
    sound.vibrate(VIBRATION.answer);
    expect(nav.vibrate!.mock.calls).toEqual([[20], [[40, 60, 40]]]);
  });

  it('does nothing where the browser has no vibration', async () => {
    delete nav.vibrate;
    const { sound } = await load();
    sound.unlock();
    expect(() => sound.vibrate(20)).not.toThrow();
  });
});

describe('event to shout (spec 15.4)', () => {
  const pt = JSON.parse(readFileSync(fileURLToPath(new URL('../../locales/pt-BR.json', import.meta.url)), 'utf8')) as Record<string, string>;
  const LADDERS = { paulista: [1, 3, 6, 9, 12], mineiro: [2, 4, 6, 10, 12], mineiro8: [2, 4, 8, 10, 12] };

  it('every bet of every ladder has the shout of its spoken call name', () => {
    for (const ladder of Object.values(LADDERS)) {
      for (let step = 1; step < ladder.length; step++) {
        const value = ladder[step];
        const word = pt[`callw.${step <= 1 ? 'truco' : value}`];
        expect(shoutForCall(value, step), `${value} at step ${step}`).toBe(word);
      }
    }
  });

  const paulista = { variant: 'paulista' as const, manilhaRank: manilhaRankForVira(parseCard('6h')) };
  const mineiro = { variant: 'mineiro' as const, manilhaRank: -1 };

  it('raise, accept, run and the mão de onze run', () => {
    const ev = (e: GameEvent) => shoutForEvent(e, paulista);
    expect(ev({ t: 'raise', seat: 1, step: 1, value: 3 })).toBe('truco');
    expect(ev({ t: 'raise', seat: 1, step: 2, value: 6 })).toBe('seis');
    expect(ev({ t: 'raise', seat: 1, step: 4, value: 12 })).toBe('doze');
    expect(shoutForEvent({ t: 'raise', seat: 0, step: 1, value: 4 }, mineiro)).toBe('truco');
    expect(shoutForEvent({ t: 'raise', seat: 0, step: 2, value: 8 }, mineiro)).toBe('oito');
    expect(shoutForEvent({ t: 'raise', seat: 0, step: 3, value: 10 }, mineiro)).toBe('dez');
    expect(ev({ t: 'accept', seat: 2, step: 1, value: 3 })).toBe('desce');
    expect(ev({ t: 'run', seat: 3 })).toBe('corro');
    expect(ev({ t: 'onze', seat: 0, play: false })).toBe('corro');
    expect(ev({ t: 'onze', seat: 0, play: true })).toBeNull();
  });

  it('the zap is the strongest card of the hand in both variants', () => {
    for (let vira = 0; vira < 40; vira++) {
      const m = manilhaRankForVira(vira);
      const z = zapCard('paulista', m);
      expect(z).toBe(makeCard(m, SUIT_CLUBS));
      expect(strengthTable('paulista', m)[z]).toBe(13);
    }
    expect(zapCard('mineiro', -1)).toBe(parseCard('4c'));
    expect(strengthTable('mineiro', -1)[zapCard('mineiro', -1)]).toBe(13);
    expect(zapCard('paulista', -1)).toBe(-1);
  });

  it('ZAP! only for the zap played face up', () => {
    // Vira 6 of hearts: the manilhas are the sevens, the zap is the 7 of clubs.
    expect(RANKS[paulista.manilhaRank]).toBe('7');
    const play = (card: number, faceDown = false) => shoutForEvent({ t: 'play', seat: 1, card, faceDown, slot: 0 }, paulista);
    expect(play(parseCard('7c'))).toBe('zap');
    expect(play(parseCard('7c'), true)).toBeNull();
    expect(play(parseCard('7h'))).toBeNull();
    expect(play(parseCard('4c'))).toBeNull();
    expect(play(-1)).toBeNull();
    expect(shoutForEvent({ t: 'play', seat: 1, card: parseCard('4c'), faceDown: false, slot: 0 }, mineiro)).toBe('zap');
    expect(shoutForEvent({ t: 'play', seat: 1, card: parseCard('7h'), faceDown: false, slot: 0 }, mineiro)).toBeNull();
  });

  it('no shout for the other events', () => {
    const quiet: GameEvent[] = [
      { t: 'deal', hand: 1, dealer: 0, mao: 1, vira: 2, kind: 'normal', onzeTeam: -1 },
      { t: 'signal', seat: 2, signal: 0, seenBy: 0 },
      { t: 'round', round: 0, result: 0, winnerSeat: 0 },
      { t: 'hand', winner: 0, points: 1, reason: 'rounds', score: [1, 0] },
      { t: 'game', winner: 0, games: [1, 0] },
      { t: 'match', winner: 0 },
    ];
    for (const e of quiet) expect(shoutForEvent(e, paulista), e.t).toBeNull();
  });
});
