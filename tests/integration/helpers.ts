// Black-box helpers for the integration tests. They talk to a running Worker (wrangler dev) over
// HTTP and WebSocket only: a device with its own cookie jar, raw WebSocket upgrades (to read the
// status code of a refused upgrade) and a buffered WebSocket client.
//
// BASE is the site to test, for example http://dev:8787 from inside the compose network.

import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH, type ClientMsg, type ServerMsg } from '../../shared/protocol.ts';

export const BASE = (process.env.BASE ?? '').replace(/\/+$/, '');
export const ORIGIN = BASE ? new URL(BASE).origin : '';
export const WS_BASE = BASE.replace(/^http/, 'ws');
/** Turnstile dummy token: passes with the local test secret key. */
export const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const FOREIGN_ORIGIN = 'https://evil.example';

export type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
export type GameMsg = Extract<ServerMsg, { t: 'game' }>;
export type ErrorMsg = Extract<ServerMsg, { t: 'error' }>;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A lock across the test files that change the local site's shared manifest (models.test.ts and
 * reading.test.ts). Vitest runs the files at the same time, so one file's manifest, or its removal
 * at the end, would reach the other file's matches and cron runs. The lock is a directory made
 * with mkdir in the site's state folder; one left behind by a run that died is taken over after 10
 * minutes. Returns the function that frees it.
 */
export async function lockManifest(state: string, waitMs = 300_000): Promise<() => void> {
  const dir = join(state, 'zap-test-manifest.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(dir).mtimeMs;
    } catch {
      continue; // freed meanwhile: try again at once
    }
    if (age > 600_000) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > until) throw new Error(`the manifest lock ${dir} stayed taken for ${waitMs} ms`);
    await sleep(250);
  }
}

/**
 * Every device secret, IP and deleted id the tests create goes to this file, so the storage scan
 * (storage-scan.test.ts, run after the suite) can look for them in the local D1 and R2 files.
 */
export const TRACE_FILE = fileURLToPath(new URL('../../.cache/integration/trace.jsonl', import.meta.url));

export type TraceEntry =
  | { t: 'device'; secret: string }
  | { t: 'ip'; ip: string }
  | { t: 'deleted'; id: string; pseudonym: string | null }
  | { t: 'nickname'; value: string };

export function trace(e: TraceEntry): void {
  try {
    mkdirSync(fileURLToPath(new URL('../../.cache/integration/', import.meta.url)), { recursive: true });
    appendFileSync(TRACE_FILE, JSON.stringify(e) + '\n');
  } catch {
    // The scan is optional; the tests themselves do not depend on the file.
  }
}

/** The device id the server stores: SHA-256 of the cookie secret (worker/src/auth.ts). */
export function deviceIdOf(secret: string): string {
  return createHash('sha256').update(`zap-device:${secret}`).digest('hex');
}

/** A well-formed room code, almost surely unused (31^5 codes). */
export function randomCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/**
 * Each device sends its own address in CF-Connecting-IP (from the benchmark range 198.18.0.0/15),
 * so the per-IP limit of the human check does not couple tests. Cloudflare overwrites this header
 * in production; wrangler dev keeps it.
 */
function randomIp(): string {
  const b = randomBytes(3);
  return `198.${18 + (b[0] & 1)}.${b[1]}.${b[2]}`;
}

export interface ApiResponse {
  status: number;
  body: any;
  text: string;
  headers: Headers;
  setCookies: string[];
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  /** Origin header: our own origin by default, null for none. */
  origin?: string | null;
  headers?: Record<string, string>;
  /** Send the cookie jar (default true). */
  cookies?: boolean;
}

/** A browser on one device: its own cookies and its own IP. */
export class Device {
  readonly jar = new Map<string, string>();
  readonly ip = randomIp();
  private traced = false;

  /** The device id behind the current cookie, or null without one. */
  get id(): string | null {
    const secret = this.jar.get('zap_device') ?? this.jar.get('__Host-zap_device');
    return secret ? deviceIdOf(secret) : null;
  }

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    if (!this.traced) {
      this.traced = true;
      trace({ t: 'ip', ip: this.ip });
    }
    const headers: Record<string, string> = { 'cf-connecting-ip': this.ip, ...opts.headers };
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    if (origin !== null) headers.origin = origin;
    const cookie = this.cookieHeader();
    if (cookie && opts.cookies !== false) headers.cookie = cookie;
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const name = kv.slice(0, i).trim();
      const value = kv.slice(i + 1).trim();
      // Max-Age=0 expires the cookie, as a browser would.
      if (/;\s*max-age=0\s*(;|$)/i.test(c)) {
        this.jar.delete(name);
        continue;
      }
      this.jar.set(name, value);
      if (name.endsWith('zap_device')) trace({ t: 'device', secret: value });
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, headers: res.headers, setCookies };
  }

  get(path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('GET', path, opts);
  }

  post(path: string, body?: unknown, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('POST', path, { ...opts, body });
  }

  /** The human check, declaring 18 or older. Retries while the per-IP limit answers 429, for servers that ignore CF-Connecting-IP. */
  async verify(token: string = DUMMY_TOKEN): Promise<ApiResponse> {
    const until = Date.now() + 75_000;
    for (;;) {
      const res = await this.post('/api/session', { token, adult: true });
      if (res.status !== 429 || Date.now() > until) return res;
      await sleep(5_000);
    }
  }

  /** Human check that must pass. */
  async verified(): Promise<this> {
    const res = await this.verify();
    if (res.status !== 200) throw new Error(`human check failed: ${res.status} ${res.text}`);
    return this;
  }

  /** Quick play (solo); returns the room code. */
  async play(settings: Record<string, unknown> = {}): Promise<string> {
    const res = await this.post('/api/play', settings);
    if (res.status !== 200) throw new Error(`/api/play: ${res.status} ${res.text}`);
    return res.body.code as string;
  }

  /** A room by code; returns the code. */
  async createRoom(settings: Record<string, unknown> = {}): Promise<string> {
    const res = await this.post('/api/rooms', settings);
    if (res.status !== 200) throw new Error(`/api/rooms: ${res.status} ${res.text}`);
    return res.body.code as string;
  }

  wsHeaders(origin: string | null = ORIGIN): Record<string, string> {
    const h: Record<string, string> = {};
    if (origin !== null) h.origin = origin;
    const cookie = this.cookieHeader();
    if (cookie) h.cookie = cookie;
    return h;
  }

  /** Opens the room's WebSocket like the site does. */
  connect(code: string, origin: string | null = ORIGIN): Promise<Conn> {
    return Conn.open(`${WS_BASE}/api/rooms/${code}/ws`, this.wsHeaders(origin));
  }

  /** A raw upgrade request, to read the status code of a refusal. A 101 is closed right away. */
  upgrade(code: string, origin: string | null = ORIGIN): Promise<UpgradeResult> {
    return rawUpgrade(`/api/rooms/${code}/ws`, this.wsHeaders(origin));
  }

  /** The room's WebSocket read frame by frame, to see a close the server sends from outside it (see RawConn). */
  connectRaw(code: string): Promise<RawConn> {
    return RawConn.open(`/api/rooms/${code}/ws`, this.wsHeaders(ORIGIN));
  }
}

/**
 * A WebSocket read frame by frame, for connections the server closes from outside their own
 * events (a deletion or a recovery elsewhere, the owner closing the lobby). Local wrangler dev
 * sends the close frame then but keeps the TCP connection open, so a standard client waits in
 * CLOSING and never reports the code; browsers give up on the TCP close after a moment and do.
 * Here the close frame itself is read. The client sends nothing.
 */
export class RawConn {
  readonly messages: ServerMsg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private buf = Buffer.alloc(0);
  private done!: (c: { code: number; reason: string }) => void;
  private readonly socket: Duplex;

  private constructor(socket: Duplex, head: Buffer) {
    this.socket = socket;
    this.closed = new Promise((resolve) => (this.done = resolve));
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.done({ code: 1006, reason: '' }));
    socket.on('error', () => {});
    this.feed(head);
  }

  static open(path: string, headers: Record<string, string>): Promise<RawConn> {
    const u = new URL(BASE + path);
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request({
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'GET',
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers },
      });
      req.setTimeout(10_000, () => req.destroy(new Error('upgrade timed out')));
      req.on('upgrade', (_res, socket, head) => resolve(new RawConn(socket, head)));
      req.on('response', (res) => {
        res.resume();
        reject(new Error(`upgrade refused: ${res.statusCode}`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Server frames are never masked; the site sends neither fragments nor compressed frames. */
  private feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        at = 10;
      }
      if (this.buf.length < at + len) return;
      const payload = this.buf.subarray(at, at + len);
      this.buf = this.buf.subarray(at + len);
      if (op === 1) this.messages.push(JSON.parse(payload.toString('utf8')) as ServerMsg);
      if (op === 8) {
        this.done({ code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString('utf8') });
        this.socket.destroy();
        return;
      }
    }
  }

  /** Waits for a message that matches, among all received so far and later ones. */
  async waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const m = this.messages.find(pred);
      if (m) return m;
      if (Date.now() > until) throw new Error('timed out waiting for a message');
      await sleep(20);
    }
  }

  async waitClose(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closed,
      sleep(timeoutMs).then(() => {
        throw new Error('no close frame in time');
      }),
    ]);
  }

  close(): void {
    this.socket.destroy();
  }
}

export interface UpgradeResult {
  status: number;
  body: string;
}

export function rawUpgrade(path: string, headers: Record<string, string>): Promise<UpgradeResult> {
  const u = new URL(BASE + path);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.setTimeout(10_000, () => req.destroy(new Error('upgrade timed out')));
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve({ status: 101, body: '' });
    });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export interface Received {
  raw: string;
  msg: ServerMsg;
  at: number;
}

/** A WebSocket that keeps every message, so a test can wait for the next one it cares about. */
export class Conn {
  readonly log: Received[] = [];
  room: RoomMsg | null = null;
  game: GameMsg | null = null;
  closeInfo: { code: number; reason: string } | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;
  private listeners = new Set<(msg: ServerMsg, raw: string) => void>();
  private cursor = 0;
  private wake: (() => void)[] = [];

  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => {
        this.closeInfo = { code: e.code, reason: e.reason };
        resolve(this.closeInfo);
        this.notify();
      });
    });
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
      const msg = JSON.parse(raw) as ServerMsg;
      if (msg.t === 'room') this.room = msg;
      if (msg.t === 'game') this.game = msg;
      this.log.push({ raw, msg, at: Date.now() });
      for (const f of [...this.listeners]) f(msg, raw);
      this.notify();
    });
  }

  static open(url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<Conn> {
    return new Promise((resolve, reject) => {
      // Node's WebSocket (undici) accepts headers, which browsers do not.
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      ws.binaryType = 'arraybuffer';
      const conn = new Conn(ws);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket open timed out'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(conn);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket refused'));
      });
    });
  }

  /** Calls fn for every message received so far and every later one, until the returned function is called. */
  watch(fn: (msg: ServerMsg, raw: string) => void, replay = true): () => void {
    if (replay) for (const r of this.log) fn(r.msg, r.raw);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: ClientMsg | string): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** The next unread message that matches; messages before it are marked read. */
  async next<T extends ServerMsg = ServerMsg>(pred: (m: ServerMsg) => boolean = () => true, timeoutMs = 10_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.log.length) {
        const m = this.log[this.cursor++].msg;
        if (pred(m)) return m as T;
      }
      if (this.closeInfo) throw new Error(`socket closed (${this.closeInfo.code} ${this.closeInfo.reason}) while waiting for a message`);
      const left = until - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a message');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  nextGame(pred: (g: GameMsg) => boolean = () => true, timeoutMs?: number): Promise<GameMsg> {
    return this.next<GameMsg>((m) => m.t === 'game' && pred(m), timeoutMs);
  }

  nextRoom(pred: (r: RoomMsg) => boolean = () => true, timeoutMs?: number): Promise<RoomMsg> {
    return this.next<RoomMsg>((m) => m.t === 'room' && pred(m), timeoutMs);
  }

  nextError(timeoutMs?: number): Promise<ErrorMsg> {
    return this.next<ErrorMsg>((m) => m.t === 'error', timeoutMs);
  }

  /** Marks every message received so far as read. */
  skip(): void {
    this.cursor = this.log.length;
  }

  /** Unread messages so far, without waiting. */
  unread(): ServerMsg[] {
    return this.log.slice(this.cursor).map((r) => r.msg);
  }

  async waitClose(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closed,
      sleep(timeoutMs).then(() => {
        throw new Error('socket did not close in time');
      }),
    ]);
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // already closed
    }
  }

  private notify(): void {
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }
}

export function legalActions(mask: number): number[] {
  const out: number[] = [];
  for (let a = 0; a < 15; a++) if (mask & (1 << a)) out.push(a);
  return out;
}

/** A random legal move; card plays (face up or down) 80% of the time, so matches end sooner. */
export function randomMove(mask: number): number {
  const acts = legalActions(mask);
  const cards = acts.filter((a) => a < 6);
  const pool = cards.length > 0 && Math.random() < 0.8 ? cards : acts;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The game state if this connection must act now and has not acted on it yet. */
export function myTurn(g: GameMsg | null, acted: Set<string>): GameMsg | null {
  if (!g || g.obs.over || !g.deadline || g.deadline.seat !== g.obs.seat || g.obs.legal === 0 || acted.has(turnKey(g))) return null;
  return g;
}

/**
 * Identifies one decision. A signal keeps the same seq (it changes nobody else's moves), so the
 * key also includes the legal moves, which lose the signals after one is sent.
 */
export function turnKey(g: GameMsg): string {
  return `${g.seq}:${g.obs.legal}`;
}

export interface PlayResult {
  moves: number;
  stale: number;
  final: GameMsg;
  room: RoomMsg | null;
}

/**
 * Plays random legal moves at a human pace (paceMs after the state arrives) until the match ends.
 * A 'stale' error is fine (the state moved on; a fresh state follows); any other error fails.
 */
export function playToEnd(conn: Conn, opts: { paceMs?: number; timeoutMs?: number } = {}): Promise<PlayResult> {
  const pace = opts.paceMs ?? 300;
  return new Promise((resolve, reject) => {
    const acted = new Set<string>();
    let moves = 0;
    let stale = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    let unwatch = () => {};
    const finish = (err: Error | null, res?: PlayResult) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      if (timer) clearTimeout(timer);
      unwatch();
      if (err) reject(err);
      else resolve(res!);
    };
    const overall = setTimeout(() => finish(new Error(`match did not end in time after ${moves} moves`)), opts.timeoutMs ?? 100_000);
    const fire = () => {
      timer = null;
      if (done) return;
      const g = myTurn(conn.game, acted);
      if (!g) return;
      acted.add(turnKey(g));
      moves++;
      conn.send({ t: 'act', seq: g.seq, a: randomMove(g.obs.legal) });
    };
    const consider = () => {
      const g = conn.game;
      if (g?.obs.over) {
        finish(null, { moves, stale, final: g, room: conn.room });
        return;
      }
      if (!timer && myTurn(g, acted)) timer = setTimeout(fire, pace);
    };
    unwatch = conn.watch((m) => {
      if (m.t === 'error') {
        if (m.code === 'stale') stale++;
        else finish(new Error(`server answered error ${m.code} during play`));
        return;
      }
      consider();
    }, false);
    void conn.closed.then((c) => finish(new Error(`socket closed during play (${c.code} ${c.reason})`)));
    consider();
  });
}
