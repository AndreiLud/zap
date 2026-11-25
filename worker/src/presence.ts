// Whether the owner of a room with friends is really still there (M15, owner decision D6). After a
// match, while the room counts the owner as connected, only the owner starts the next match. That
// flag changes only on a close event, and a connection can die without one: a lost network, a phone
// asleep, a room restarted by a deploy. Friends would then wait for nobody until the room expires.
//
// So the Durable Object checks the owner's sockets itself while friends wait. The page pings every
// 25 s (web/src/connection.ts) and the platform answers without waking the room; the room reads when
// it last answered (getWebSocketAutoResponseTimestamp) and when the page last sent a message (the
// socket attachment's `at`). Platform free, with structural types, so the tests pass a fake state.

import type { RoomCore } from './room-core.ts';

/** Three of the page's pings: a connection the room has not heard from for this long is gone. */
export const SILENT_MS = 75_000;
/** The close code for a connection the room gave up on (going away): a page that was only asleep reconnects by itself. */
export const CLOSE_SILENT = 1001;
/** WebSocket.OPEN. */
const OPEN = 1;

/** What the check reads of a hibernatable WebSocket: its attachment holds `opened` and `at` (cf/room.ts). */
export interface PresenceSocket {
  readonly readyState: number;
  deserializeAttachment(): unknown;
  close(code?: number, reason?: string): void;
}

/** What the check reads of the Durable Object's state (DurableObjectState fits). */
export interface PresenceState<S extends PresenceSocket> {
  getWebSockets(tag?: string): S[];
  getWebSocketAutoResponseTimestamp(ws: S): Date | null;
}

type Core = Pick<RoomCore, 'r' | 'waitsForOwner' | 'disconnect' | 'seatedDevices'>;

function attachment(ws: PresenceSocket): { opened: number; at: number } {
  const a = ws.deserializeAttachment() as { opened?: unknown; at?: unknown } | null;
  const num = (x: unknown) => (typeof x === 'number' ? x : 0);
  return { opened: num(a?.opened), at: num(a?.at) };
}

const open = <S extends PresenceSocket>(ctx: PresenceState<S>, tag?: string) => ctx.getWebSockets(tag).filter((ws) => ws.readyState === OPEN);

/**
 * When the room last heard from a device: the last message or ping answer of its open sockets. With
 * none, when the room's oldest open connection opened: sockets do not outlive a restart, so after a
 * deploy, when every page reconnects, the owner gets SILENT_MS from the first page back; in a room
 * that did not restart, an owner with no socket lost a close event, and is gone at once.
 */
function lastHeard<S extends PresenceSocket>(ctx: PresenceState<S>, device: string, now: number): number {
  const mine = open(ctx, device);
  if (mine.length) return Math.max(...mine.map((ws) => Math.max(attachment(ws).at, ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0)));
  return Math.min(now, ...open(ctx).map((ws) => attachment(ws).opened));
}

/**
 * Checks the owner while friends wait after a match. When the room has not heard from the owner for
 * SILENT_MS, the owner's sockets are closed and the owner counts as away, so anyone seated may start.
 * Returns true when it changed the room (the caller stores it and tells everyone).
 */
export function checkOwner<S extends PresenceSocket>(ctx: PresenceState<S>, core: Core, now: number): boolean {
  if (!core.waitsForOwner()) return false;
  const owner = core.r.owner;
  if (now - lastHeard(ctx, owner, now) < SILENT_MS) return false;
  for (const ws of ctx.getWebSockets(owner)) {
    try {
      ws.close(CLOSE_SILENT, 'silent');
    } catch {
      // Already closing.
    }
  }
  core.disconnect(owner);
  return true;
}

/**
 * When the room should check the owner next: once the owner's last sign of life is SILENT_MS old.
 * Null when nobody waits for the owner: no match just ended, the owner is away already, or no
 * friend has a live connection (a friend who left keeps no alarm running).
 */
export function nextOwnerCheck<S extends PresenceSocket>(ctx: PresenceState<S>, core: Core, now: number): number | null {
  if (!core.waitsForOwner()) return null;
  const owner = core.r.owner;
  const waiting = core.seatedDevices().some((d) => d !== owner && open(ctx, d).length > 0 && now - lastHeard(ctx, d, now) < SILENT_MS);
  return waiting ? lastHeard(ctx, owner, now) + SILENT_MS : null;
}
