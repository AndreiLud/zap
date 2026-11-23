// Simulated players for the local end to end test of the training cycle: people who pass the
// local human check, set their choices, play quick play matches over the WebSocket with a betting
// style and a pace of their own, and some delete their data at the end. Some move to a second
// device halfway, with a recovery code, after one match on the new device as a stranger. They play
// through the real local site, so the records, the D1 rows and the daily export are the ones
// people would make. The site marks the records as test data (TEST_RECORDS), not the players.
//
//   docker compose run --rm -T node node training/cycle/sim/run.ts --base http://dev:8787 \
//     --devices 12 --matches 4 --seed 7 --concurrency 4 --out .cache/sim/last.json
//
// Options: --think-ms N gives every person the same median think time (the pinned match test of
// tests/sim/ uses a slow one); --ready-file PATH is written when the first match has started;
// --trace adds the device secrets, IP addresses and deleted or moved device ids to the trace file
// of the integration suite, so the storage scan looks for them too.
//
// A player thinks only after the events of a game message are shown (the AI cards land one by one,
// as in the browser): the server starts the turn clock at that moment, so the decision times in
// the records are the players' think times.
//
// Only the local sites of training/cycle/sim/base.ts are allowed (exit code 2 before any request
// otherwise). The players keep under the site's limits: new sessions at most 10 per minute in
// total, at most 60 API calls and 6 WebSocket connections per minute per device, at most 4
// messages per second (no think time under 260 ms).

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mulberry32 } from '../../../engine/src/rng.ts';
import type { ServerMsg } from '../../../shared/protocol.ts';
import { checkedBase } from './base.ts';
import { STYLES, styleMove, type Style } from './styles.ts';

type GameMsg = Extract<ServerMsg, { t: 'game' }>;

const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const MIN_THINK_MS = 260;
/** The trace file of tests/integration/helpers.ts, read by tests/integration/storage-scan.test.ts. */
export const TRACE_FILE = '.cache/integration/trace.jsonl';

/** How fast a person decides: the median of their think time. */
export const TEMPOS = ['fast', 'normal', 'slow'] as const;
export type Tempo = (typeof TEMPOS)[number];
const TEMPO_RANGE: Record<Tempo, [number, number]> = { fast: [300, 500], normal: [500, 1200], slow: [1800, 3500] };

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** At most `max` uses in any window of `windowMs`; take() waits for a free slot. */
export class Limiter {
  private readonly times: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private chain: Promise<void> = Promise.resolve();
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  take(now: () => number = Date.now, wait: (ms: number) => Promise<void> = sleep): Promise<void> {
    const run = async () => {
      for (;;) {
        const t = now();
        while (this.times.length > 0 && t - this.times[0] >= this.windowMs) this.times.shift();
        if (this.times.length < this.max) {
          this.times.push(t);
          return;
        }
        await wait(this.times[0] + this.windowMs - t + 5);
      }
    };
    this.chain = this.chain.then(run);
    return this.chain;
  }
}

/** A person's pace: 30% fast, 50% normal, 20% slow. */
export function pickTempo(rand: () => number): Tempo {
  const r = rand();
  return r < 0.3 ? 'fast' : r < 0.8 ? 'normal' : 'slow';
}

/** The median think time of a person of this pace, in ms (fast from 300 to 500, normal from 500 to 1,200, slow from 1,800 to 3,500). */
export function tempoMedian(tempo: Tempo, rand: () => number): number {
  const [lo, hi] = TEMPO_RANGE[tempo];
  return lo + Math.round(rand() * (hi - lo));
}

/** Think time in ms: log-normal around the person's median (a metronome stays within 2%), never under 260 ms, and inside the time left. */
export function thinkMs(style: Style, median: number, rand: () => number, timeLeftMs: number | null): number {
  let t: number;
  if (style === 'metronome') t = median * (1 + (rand() - 0.5) * 0.04);
  else {
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    t = median * Math.exp(0.35 * z);
  }
  if (timeLeftMs !== null) t = Math.min(t, Math.max(MIN_THINK_MS, timeLeftMs * 0.6));
  return Math.max(MIN_THINK_MS, Math.round(t));
}

/** How long a browser takes to show the events of a game message (their display offsets, in ms after arrival). */
export function displayMs(events: readonly { at: number }[]): number {
  let last = 0;
  for (const e of events) if (e.at > last) last = e.at;
  return last;
}

/** The device id the server stores for a device secret (worker/src/auth.ts). */
export function deviceIdOf(secret: string): string {
  return createHash('sha256').update(`zap-device:${secret}`).digest('hex');
}

type TraceEntry = { t: 'device'; secret: string } | { t: 'ip'; ip: string } | { t: 'deleted'; id: string; pseudonym: null };

interface Shared {
  base: string;
  sessions: Limiter;
  trace: ((e: TraceEntry) => void) | null;
  readyFile: string | null;
}

interface PersonOut {
  style: Style;
  tempo: Tempo;
  medianMs: number;
  matches: number;
  prefs: { noAdapt: boolean; openDataOptOut: boolean };
  deleted: boolean;
  /** 2 when the person moved to a second device with a recovery code. */
  devicesUsed: 1 | 2;
  recovered: boolean;
}

/** One browser: its own cookie jar and address. */
class Browser {
  private readonly jar = new Map<string, string>();
  private readonly calls = new Limiter(50, 60_000);
  private readonly connects = new Limiter(5, 60_000);
  private readonly ip: string;
  private readonly shared: Shared;
  private traced = false;

  constructor(shared: Shared, ip: string) {
    this.shared = shared;
    this.ip = ip;
  }

  /** The id the server stores for this browser now, or null before its first session. */
  deviceId(): string | null {
    const secret = this.jar.get('zap_device');
    return secret ? deviceIdOf(secret) : null;
  }

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    await this.calls.take();
    if (!this.traced) {
      this.traced = true;
      this.shared.trace?.({ t: 'ip', ip: this.ip });
    }
    const base = this.shared.base;
    const headers: Record<string, string> = { origin: new URL(base).origin, 'cf-connecting-ip': this.ip };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let text: string | undefined;
    if (body !== undefined) {
      text = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, { method, headers, body: text, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const name = kv.slice(0, i).trim();
      const value = kv.slice(i + 1).trim();
      if (/;\s*max-age=0\s*(;|$)/i.test(c)) this.jar.delete(name);
      else {
        this.jar.set(name, value);
        if (name.endsWith('zap_device')) this.shared.trace?.({ t: 'device', secret: value });
      }
    }
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: res.status, body: parsed };
  }

  async session(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      await this.shared.sessions.take();
      const res = await this.api('POST', '/api/session', { token: DUMMY_TOKEN, adult: true });
      if (res.status === 200) return;
      if (res.status !== 429) throw new Error(`session: ${res.status} ${JSON.stringify(res.body)}`);
      await sleep(5_000);
    }
    throw new Error('session: too many refusals');
  }

  /** Quick play with varied settings; a new human check when the site asks for one. */
  async start(rand: () => number): Promise<string> {
    const players = rand() < 0.5 ? 2 : 4;
    const variant = rand() < 0.5 ? 'paulista' : 'mineiro';
    const names = ['zap', 'otavio', 'bento', 'lia', 'ravi', 'iara'];
    const opponents = players === 2 ? [names[Math.floor(rand() * names.length)]] : [names[Math.floor(rand() * 6)], names[Math.floor(rand() * 6)]];
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await this.api('POST', '/api/play', { players, variant, opponents });
      if (res.status === 200) return res.body.code as string;
      if (res.status === 401) await this.session();
      else if (res.status === 429 || res.status === 503) await sleep(3_000);
      else throw new Error(`play: ${res.status} ${JSON.stringify(res.body)}`);
    }
    throw new Error('play: too many refusals');
  }

  /** Plays the match to its end over the room's WebSocket. */
  async playMatch(code: string, style: Style, median: number, rand: () => number): Promise<void> {
    await this.connects.take();
    const base = this.shared.base;
    const url = `${base.replace(/^http/, 'ws')}/api/rooms/${code}/ws`;
    // Node's WebSocket (undici) accepts headers, which browsers do not.
    const ws = new WebSocket(url, { headers: { origin: new URL(base).origin, cookie: this.cookieHeader() } } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      let game: GameMsg | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const acted = new Set<string>();
      const overall = setTimeout(() => finish(new Error(`match ${code} did not end in 15 minutes`)), 15 * 60_000);
      const finish = (err: Error | null) => {
        clearTimeout(overall);
        if (timer) clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closed
        }
        if (err) reject(err);
        else resolve();
      };
      const key = (g: GameMsg) => `${g.seq}:${g.obs.legal}`;
      const consider = () => {
        const g = game;
        if (!g) return;
        if (g.obs.over) return finish(null);
        if (timer || !g.deadline || g.deadline.seat !== g.obs.seat || g.obs.legal === 0 || acted.has(key(g))) return;
        // A browser shows the events one by one (the AI cards, the end of a hand) and the person
        // thinks only after the last one; the server starts the turn clock at that moment too.
        const shown = displayMs(g.events);
        const left = g.deadline.at === null ? null : g.deadline.at - g.now - shown;
        timer = setTimeout(() => {
          timer = null;
          const now = game;
          if (!now || key(now) !== key(g) || now.obs.over) return consider();
          acted.add(key(now));
          ws.send(JSON.stringify({ t: 'act', seq: now.seq, a: styleMove(style, now.obs, rand) }));
        }, shown + thinkMs(style, median, rand, left));
      };
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as ServerMsg;
        if (msg.t === 'game') {
          if (!game && this.shared.readyFile) {
            mkdirSync(dirname(this.shared.readyFile), { recursive: true });
            writeFileSync(this.shared.readyFile, JSON.stringify({ code, at: Date.now() }) + '\n');
          }
          game = msg;
          consider();
        } else if (msg.t === 'error' && msg.code !== 'stale' && msg.code !== 'not_your_turn') {
          finish(new Error(`match ${code}: server error ${msg.code}`));
        }
      });
      ws.addEventListener('close', (e) => finish(game?.obs.over ? null : new Error(`match ${code}: socket closed (${e.code})`)));
      ws.addEventListener('error', () => finish(new Error(`match ${code}: WebSocket refused`)));
    });
  }
}

class SimPerson {
  readonly style: Style;
  readonly tempo: Tempo;
  readonly median: number;
  readonly prefs: { noAdapt: boolean; openDataOptOut: boolean };
  readonly deletes: boolean;
  readonly twoDevices: boolean;
  played = 0;
  deleted = false;
  recovered = false;
  matchIds: string[] = [];
  private readonly rand: () => number;
  private readonly shared: Shared;
  private readonly ips: [string, string];

  constructor(shared: Shared, index: number, seed: number, thinkMedian: number | null) {
    this.shared = shared;
    this.rand = mulberry32(seed * 1000 + index);
    this.style = STYLES[(seed + index) % STYLES.length];
    // The first draws keep the choices of earlier versions of this file for the same seed.
    const legacyMedian = 300 + Math.round(this.rand() * 900);
    this.prefs = { noAdapt: this.rand() < 0.2, openDataOptOut: this.rand() < 0.2 };
    this.deletes = this.rand() < 0.1;
    this.tempo = thinkMedian !== null ? 'slow' : this.style === 'metronome' ? 'normal' : pickTempo(this.rand);
    this.median = thinkMedian ?? (this.style === 'metronome' ? legacyMedian : tempoMedian(this.tempo, this.rand));
    this.twoDevices = this.rand() < 0.15;
    // RFC 2544 benchmark addresses: never a real person's. The second device has its own.
    this.ips = [`198.18.${(seed * 7 + index) % 256}.${(index * 13 + 1) % 256}`, `198.19.${(seed * 7 + index) % 256}.${(index * 13 + 1) % 256}`];
  }

  private async play(b: Browser): Promise<void> {
    const code = await b.start(this.rand);
    try {
      await b.playMatch(code, this.style, this.median, this.rand);
      this.played++;
    } catch (e) {
      console.error(`${this.style}: ${(e as Error).message}`);
    }
  }

  private async setPrefs(b: Browser): Promise<void> {
    if (!this.prefs.noAdapt && !this.prefs.openDataOptOut) return;
    const res = await b.api('POST', '/api/me/prefs', this.prefs);
    if (res.status !== 200) throw new Error(`prefs: ${res.status}`);
  }

  /** Moves to a second browser: a recovery code on the first, one match there as a stranger, then the recovery. */
  private async moveDevice(first: Browser): Promise<Browser> {
    const rc = await first.api('POST', '/api/me/recovery');
    if (rc.status !== 200 || typeof rc.body?.code !== 'string') throw new Error(`recovery code: ${rc.status}`);
    const second = new Browser(this.shared, this.ips[1]);
    await second.session();
    await this.play(second);
    const before = [first.deviceId(), second.deviceId()];
    for (let attempt = 0; attempt < 5 && !this.recovered; attempt++) {
      const res = await second.api('POST', '/api/recover', { code: rc.body.code, token: DUMMY_TOKEN, adult: true });
      this.recovered = res.status === 200;
      if (!this.recovered) {
        if (res.status !== 429 && res.status !== 503) throw new Error(`recover: ${res.status} ${JSON.stringify(res.body)}`);
        await sleep(5_000);
      }
    }
    if (!this.recovered) throw new Error('recover: too many refusals');
    // Both earlier ids are gone from D1: the history now belongs to the second browser's new id.
    for (const id of before) if (id) this.shared.trace?.({ t: 'deleted', id, pseudonym: null });
    return second;
  }

  async run(matches: number): Promise<void> {
    let b = new Browser(this.shared, this.ips[0]);
    await b.session();
    await this.setPrefs(b);
    const split = this.twoDevices && matches >= 2 ? Math.max(1, Math.floor(matches / 2)) : matches;
    for (let m = 0; m < split; m++) await this.play(b);
    if (split < matches) {
      b = await this.moveDevice(b);
      for (let m = split + 1; m < matches; m++) await this.play(b);
    }
    // The ids before any deletion (they go with the data).
    for (let attempt = 0; attempt < 20; attempt++) {
      const data = await b.api('GET', '/api/me/data');
      const ids = ((data.body?.matches ?? []) as { matchId: string }[]).map((x) => x.matchId);
      this.matchIds = ids;
      if (ids.length >= this.played) break;
      await sleep(500);
    }
    if (this.deletes) {
      const id = b.deviceId();
      for (let attempt = 0; attempt < 3 && !this.deleted; attempt++) {
        const res = await b.api('POST', '/api/me/delete', { token: DUMMY_TOKEN });
        this.deleted = res.status === 200;
        if (!this.deleted) await sleep(1_000);
      }
      if (this.deleted && id) this.shared.trace?.({ t: 'deleted', id, pseudonym: null });
    }
  }

  out(): PersonOut {
    return {
      style: this.style,
      tempo: this.tempo,
      medianMs: this.median,
      matches: this.played,
      prefs: this.prefs,
      deleted: this.deleted,
      devicesUsed: this.recovered ? 2 : 1,
      recovered: this.recovered,
    };
  }
}

async function main(): Promise<void> {
  const base = checkedBase(arg('base', ''));
  if (!base) {
    console.error(`sim: refused --base ${arg('base', '(none)')}: only a local site (training/cycle/sim/base.ts)`);
    process.exit(2);
  }
  const devices = Number(arg('devices', '12'));
  const matches = Number(arg('matches', '4'));
  const seed = Number(arg('seed', '7'));
  const concurrency = Math.max(1, Number(arg('concurrency', '4')));
  const outFile = arg('out', '.cache/sim/last.json');
  const think = arg('think-ms', '');
  const thinkMedian = think === '' ? null : Math.max(MIN_THINK_MS, Number(think));
  const readyFile = arg('ready-file', '') || null;
  const trace = process.argv.includes('--trace')
    ? (e: TraceEntry) => {
        mkdirSync(dirname(TRACE_FILE), { recursive: true });
        appendFileSync(TRACE_FILE, JSON.stringify(e) + '\n');
      }
    : null;
  const startedAt = Date.now();
  const shared: Shared = { base, sessions: new Limiter(10, 60_000), trace, readyFile };
  const sims = Array.from({ length: devices }, (_, i) => new SimPerson(shared, i, seed, thinkMedian));
  let next = 0;
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, devices) }, async () => {
      while (next < sims.length) {
        const d = sims[next++];
        try {
          await d.run(matches);
        } catch (e) {
          failures.push(`${d.style}: ${(e as Error).message}`);
        }
      }
    }),
  );
  const out = {
    base,
    startedAt,
    endedAt: Date.now(),
    devices: sims.map((d) => d.out()),
    matches: sims.reduce((s, d) => s + d.played, 0),
    matchIds: [...new Set(sims.flatMap((d) => d.matchIds))],
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  const people = out.devices;
  console.log(
    JSON.stringify({
      out: outFile,
      people: devices,
      matches: out.matches,
      ids: out.matchIds.length,
      twoDevices: people.filter((p) => p.recovered).length,
      deleted: people.filter((p) => p.deleted).length,
      noAdapt: people.filter((p) => p.prefs.noAdapt).length,
      openDataOptOut: people.filter((p) => p.prefs.openDataOptOut).length,
      tempos: Object.fromEntries(TEMPOS.map((t) => [t, people.filter((p) => p.tempo === t).length])),
      failures: failures.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  );
  for (const f of failures) console.error(f);
  process.exit(failures.length > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith('run.ts')) await main();
