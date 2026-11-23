// The WebSocket to one room. It reconnects on its own with a growing wait (1 s, 2 s, 4 s, 8 s,
// then every 15 s), asks for the full state after each reconnection, and sends a keep-alive ping
// every 25 s that Cloudflare answers without waking the room.

import { CLOSE_FORGOTTEN, CLOSE_REPLACED, CLOSE_ROOM_CLOSED, type ClientMsg, type ServerMsg } from '../../shared/protocol.ts';

export type ConnState = 'connecting' | 'online' | 'reconnecting' | 'offline';

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';
const PING_EVERY_MS = 25_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/**
 * Close codes after which trying again would not help, with the reason given to ended(): opened
 * in another tab or device; the owner closed the room; this browser's data was deleted or moved
 * to another browser.
 */
const FINAL_CLOSES: Record<number, string> = { [CLOSE_REPLACED]: 'replaced', [CLOSE_ROOM_CLOSED]: 'closed', [CLOSE_FORGOTTEN]: 'forgotten' };

export interface SocketHandlers {
  message(m: ServerMsg): void;
  state(s: ConnState): void;
  /** The server closed the room for good (we left, it expired, we were too fast, or see FINAL_CLOSES). */
  ended(reason: string): void;
  /**
   * The socket closed before it opened (the upgrade was refused or the network failed). Returns
   * whether to keep trying; it may wait for a human check first.
   */
  refused(): Promise<'retry' | 'stop'>;
}

export function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** attempt);
}

export class RoomSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private everOpened = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;
  private readonly h: SocketHandlers;
  private readonly onOnline = () => {
    if (this.stopped || this.ws) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  };
  private readonly onOffline = () => {
    if (!this.stopped && !this.isOpen) this.h.state('offline');
  };

  constructor(url: string, h: SocketHandlers) {
    this.url = url;
    this.h = h;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.h.state('connecting');
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000, 'bye');
  }

  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Tries again now (after the person fixed what blocked the connection). */
  retryNow(): void {
    if (this.stopped || this.ws) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.h.state('connecting');
    this.connect();
  }

  private connect(): void {
    this.retryTimer = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry(false);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      const again = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.h.state('online');
      if (again) this.send({ t: 'sync' });
      this.startPing();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string' || ev.data === PONG) return;
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (m && typeof m === 'object' && typeof m.t === 'string') this.h.message(m);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.stopped) return;
      if (ev.code === 1000 && (ev.reason === 'left' || ev.reason === 'expired')) {
        this.stopped = true;
        this.h.state('offline');
        this.h.ended(ev.reason);
        return;
      }
      const final = FINAL_CLOSES[ev.code];
      if (final) {
        this.stopped = true;
        this.h.state('offline');
        this.h.ended(final);
        return;
      }
      if (ev.code === 1008) {
        // Policy: flooding or a gone room. Waiting is the only fix.
        this.stopped = true;
        this.h.state('offline');
        this.h.ended(ev.reason === 'too fast' ? 'blocked' : 'gone');
        return;
      }
      this.scheduleRetry(!opened);
    };
  }

  private scheduleRetry(refused: boolean): void {
    if (this.stopped) return;
    this.h.state(navigator.onLine === false ? 'offline' : 'reconnecting');
    const delay = retryDelay(this.attempt);
    this.attempt++;
    const later = () => {
      if (this.stopped || this.ws) return;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    if (!refused) {
      later();
      return;
    }
    this.h.refused().then(
      (what) => {
        if (what === 'stop') {
          this.stopped = true;
          return;
        }
        later();
      },
      () => later(),
    );
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(PING);
    }, PING_EVERY_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
