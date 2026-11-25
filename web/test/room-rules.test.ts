// Who leads after a match and in the lobby (M15 spec 6.5), which refusals become a notice, and when
// the page drops a finished match on its way back to the lobby (6.6): web/src/room-rules.ts.

import { describe, expect, it } from 'vitest';
import type { PublicRoom } from '../../shared/protocol.ts';
import { ERROR_NOTICE, SETUP_DRAW, SETUP_TABLE, dropsFinishedMatch, leadOf, noticeFor, type RoomView } from '../src/room-rules.ts';

type Room = RoomView['room'];

function room(o: Partial<Room> & { mode?: 'solo' | 'room' } = {}): Room {
  const { mode = 'room', ...rest } = o;
  return {
    status: 'ended',
    matchNo: 1,
    settings: { mode, players: 4, variant: 'paulista', options: {}, opponents: ['iara', 'zap'], partner: 'lia', turnSeconds: 30 },
    setup: SETUP_TABLE,
    ownerAway: false,
    ...rest,
  } as Room;
}

const view = (r: Room, o: { owner?: boolean; you?: number | null } = {}): RoomView => ({ owner: o.owner ?? false, you: o.you === undefined ? 1 : o.you, room: r });

describe('leadOf', () => {
  it('quick play: the person plays again, nothing to arrange, no line', () => {
    for (const setup of [undefined, SETUP_DRAW, SETUP_TABLE]) {
      expect(leadOf(view(room({ mode: 'solo', setup, ownerAway: undefined }), { owner: true, you: 0 }))).toEqual({ lead: true, arrange: false, line: null });
    }
  });

  it('a room on older code (no setup, or setup 1): anyone seated plays again, the lobby stays the owner\'s', () => {
    for (const setup of [undefined, SETUP_DRAW]) {
      expect(leadOf(view(room({ setup, ownerAway: undefined }), { owner: true, you: 0 }))).toEqual({ lead: true, arrange: false, line: null });
      expect(leadOf(view(room({ setup, ownerAway: undefined })))).toEqual({ lead: true, arrange: false, line: null });
      expect(leadOf(view(room({ setup, status: 'lobby', matchNo: 0 }), { owner: true, you: 0 }))).toEqual({ lead: true, arrange: false, line: null });
      expect(leadOf(view(room({ setup, status: 'lobby', matchNo: 0 })))).toEqual({ lead: false, arrange: false, line: 'play.lobby.waitOwner' });
      expect(leadOf(view(room({ setup, status: 'lobby', matchNo: 2 })))).toEqual({ lead: false, arrange: false, line: 'play.lobby.waitOwner' });
    }
  });

  it('a room that arranges: the owner leads and arranges, in the lobby and after a match, away or not', () => {
    for (const status of ['lobby', 'ended'] as const) {
      for (const matchNo of [0, 1, 3]) {
        if (status === 'ended' && matchNo === 0) continue;
        for (const ownerAway of [false, true]) {
          expect(leadOf(view(room({ status, matchNo, ownerAway }), { owner: true, you: 0 }))).toEqual({ lead: true, arrange: true, line: null });
        }
      }
    }
  });

  it('a friend with the owner connected waits: "Esperando..." on the end screen and in the first lobby, "A partida acabou..." between matches', () => {
    expect(leadOf(view(room({ status: 'ended', matchNo: 1 })))).toEqual({ lead: false, arrange: false, line: 'play.lobby.waitOwner' });
    expect(leadOf(view(room({ status: 'lobby', matchNo: 0 })))).toEqual({ lead: false, arrange: false, line: 'play.lobby.waitOwner' });
    expect(leadOf(view(room({ status: 'lobby', matchNo: 2 })))).toEqual({ lead: false, arrange: false, line: 'play.lobby.back' });
  });

  it('a seated friend with the owner away after a match may start; never in the first lobby, never unseated', () => {
    expect(leadOf(view(room({ status: 'ended', ownerAway: true })))).toEqual({ lead: true, arrange: false, line: 'play.lobby.ownerAway' });
    expect(leadOf(view(room({ status: 'lobby', matchNo: 1, ownerAway: true })))).toEqual({ lead: true, arrange: false, line: 'play.lobby.ownerAway' });
    expect(leadOf(view(room({ status: 'lobby', matchNo: 0, ownerAway: true })))).toEqual({ lead: false, arrange: false, line: 'play.lobby.waitOwner' });
    expect(leadOf(view(room({ status: 'ended', ownerAway: true }), { you: null })).lead).toBe(false);
  });

  it('reads a later setup level as one that arranges', () => {
    expect(leadOf(view(room({ setup: SETUP_TABLE + 1 }), { owner: true, you: 0 })).arrange).toBe(true);
  });
});

describe('noticeFor', () => {
  it('keeps the notices of the old mapping', () => {
    expect(ERROR_NOTICE).toMatchObject({
      too_fast: 'notice.too_fast',
      not_owner: 'notice.not_owner',
      seat_taken: 'notice.seat_taken',
      room_full: 'notice.room_full',
      not_in_lobby: 'notice.not_in_lobby',
      expired: 'notice.expired',
      needs_people: 'notice.needs_people',
    });
    for (const status of ['lobby', 'playing', 'ended', undefined] as const) {
      expect(noticeFor('not_owner', status)).toBe('notice.not_owner');
      expect(noticeFor('seat_taken', status)).toBe('notice.seat_taken');
      expect(noticeFor('stale', status)).toBeNull();
      expect(noticeFor('check_needed', status)).toBeNull();
    }
  });

  it('says "A partida já começou." for not_ended only while a match runs', () => {
    expect(noticeFor('not_ended', 'playing')).toBe('notice.not_in_lobby');
    expect(noticeFor('not_ended', 'lobby')).toBeNull();
    expect(noticeFor('not_ended', 'ended')).toBeNull();
    expect(noticeFor('not_ended', undefined)).toBeNull();
  });
});

describe('dropsFinishedMatch', () => {
  const msg = (status: PublicRoom['status'], matchNo: number) => ({ room: { status, matchNo } });
  it('drops a held match when the room is back in the lobby after a match', () => {
    expect(dropsFinishedMatch({ game: {} }, msg('lobby', 1))).toBe(true);
    expect(dropsFinishedMatch({ game: {} }, msg('lobby', 4))).toBe(true);
  });
  it('keeps everything else', () => {
    expect(dropsFinishedMatch({ game: null }, msg('lobby', 1))).toBe(false);
    expect(dropsFinishedMatch({ game: {} }, msg('lobby', 0))).toBe(false);
    expect(dropsFinishedMatch({ game: {} }, msg('ended', 1))).toBe(false);
    expect(dropsFinishedMatch({ game: {} }, msg('playing', 2))).toBe(false);
  });
});
