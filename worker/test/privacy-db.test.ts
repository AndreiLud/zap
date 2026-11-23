// The D1 side of privacy, run on node:sqlite with the real migrations: deleting a device removes
// every link, recovery moves a device and its history, retention removes what is older than 12
// months, the data export shows nothing about other people, room memberships and waiting room
// calls, and the match allowance cannot be overspent.

import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET } from '../../shared/protocol.ts';
import { MATCHES_PER_CHECK, refundMatch, reserveMatch } from '../src/allowance.ts';
import {
  RETENTION_MS,
  checkedDevice,
  deleteDevice,
  matchRowStatements,
  myData,
  seatStatementIndexes,
  newPseudonym,
  newRecoveryCode,
  normalizeRecoveryCode,
  recoverDevice,
  recoveryHash,
  roomListingStatements,
  roomMemberStatement,
  roomsOf,
  runRetention,
  type SqlDb,
} from '../src/privacy.ts';
import { doneStatements, queueStatements, queuedCalls } from '../src/room-calls.ts';
import { importFlags } from '../src/cycle-jobs.ts';
import { emptyProfile } from '../../shared/profile.ts';
import type { MatchRow } from '../src/privacy.ts';
import { testDb } from './sqlite-db.ts';

const NOW = Date.UTC(2026, 10, 21, 12);
const DAY = 86_400_000;

function addDevice(db: ReturnType<typeof testDb>, id: string, over: Record<string, unknown> = {}): string {
  const pseudonym = (over.pseudonym as string) ?? newPseudonym();
  const row = { id, created_at: NOW - 10 * DAY, verified_at: NOW, pseudonym, adult_at: NOW, last_seen: NOW, ...over };
  const cols = Object.keys(row);
  db.raw.prepare(`INSERT INTO devices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number | null)[]));
  return pseudonym;
}

async function addMatch(db: SqlDb, id: string, seats: { seat: number; device: string }[], endedAt = NOW): Promise<void> {
  await db.batch(
    matchRowStatements(db, {
      matchId: id,
      startedAt: endedAt - 60_000,
      endedAt,
      kind: 'mixed',
      variant: 'paulista',
      players: 4,
      aiVersion: 'v1',
      recordKey: `matches/v1/x/${id}.json`,
      seats: seats.map((s) => ({ ...s, verified: true })),
    }),
  );
}

/** A membership row written directly (roomMemberStatement writes only for devices D1 has). */
function addMember(db: ReturnType<typeof testDb>, code: string, device: string, expiresAt = NOW + DAY): void {
  db.raw.prepare('INSERT INTO room_members (code, device, expires_at) VALUES (?, ?, ?)').run(code, device, expiresAt);
}

function addReport(db: ReturnType<typeof testDb>, reporter: string | null, target: string | null, createdAt = NOW): void {
  db.raw.prepare("INSERT INTO reports (created_at, match_id, room_code, seat, reason, reporter, target) VALUES (?, 'm1', 'ABCDE', 1, 'nickname', ?, ?)").run(createdAt, reporter, target);
}

/** A style counter row and an export group token, written directly. */
function addProfile(db: ReturnType<typeof testDb>, pseudonym: string, segment = 'paulista-2', over: Record<string, number> = {}): void {
  const row = { pseudonym, segment, matches: 1, decisions: 10, h: 5, k: 2, u: 1, a: 1, x: 0, s: 1, q: 2, v: 0, w: 1, bc: 3, br: 1, g: 2, gt: 1, tn: 8, tl: 60, tl2: 460, updated_at: NOW, ...over };
  const cols = Object.keys(row);
  db.raw.prepare(`INSERT INTO profiles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number)[]));
}

function addGroup(db: ReturnType<typeof testDb>, pseudonym: string, date: string, grp: string): void {
  db.raw.prepare('INSERT INTO export_groups (export_date, grp, pseudonym) VALUES (?, ?, ?)').run(date, grp, pseudonym);
}

/** Every text value in every table, to look for an id anywhere. */
function everyValue(db: ReturnType<typeof testDb>, skip: string[] = []): string[] {
  const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  const out: string[] = [];
  for (const t of tables) {
    for (const row of db.raw.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]) {
      for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && !skip.includes(`${t}.${k}`)) out.push(v);
    }
  }
  return out;
}

const dev = (c: string) => c.repeat(64);

describe('privacy in D1', () => {
  it('match rows link seats to pseudonyms inside D1, skip devices without one, and can be written twice', async () => {
    const db = testDb();
    const pa = addDevice(db, dev('a'));
    addDevice(db, dev('b'), { pseudonym: null });
    await addMatch(db, 'm1', [
      { seat: 0, device: dev('a') },
      { seat: 2, device: dev('b') },
      { seat: 3, device: dev('c') },
    ]);
    await addMatch(db, 'm1', [{ seat: 0, device: dev('a') }]);
    expect(db.raw.prepare('SELECT match_id, seat, pseudonym, verified FROM match_seats').all()).toEqual([{ match_id: 'm1', seat: 0, pseudonym: pa, verified: 1 }]);
    // Written again, a seat already linked counts as linked (and stays as it was); a device D1 lacks does not.
    const again = await db.batch(
      matchRowStatements(db, { matchId: 'm1', startedAt: 0, endedAt: 0, kind: 'mixed', variant: 'paulista', players: 4, aiVersion: 'v1', recordKey: 'k', seats: [{ seat: 0, device: dev('b'), verified: false }, { seat: 3, device: dev('c'), verified: true }] }),
    );
    // The public counters (first) and the match row count nothing the second time.
    expect(again.map((r) => r.meta.changes)).toEqual([0, 0, 0, 0]);
    const linked = await db.batch(matchRowStatements(db, { matchId: 'm1', startedAt: 0, endedAt: 0, kind: 'mixed', variant: 'paulista', players: 4, aiVersion: 'v1', recordKey: 'k', seats: [{ seat: 0, device: dev('a'), verified: false }] }));
    expect(linked.map((r) => r.meta.changes)).toEqual([0, 0, 1]);
    expect(db.raw.prepare('SELECT match_id, seat, pseudonym, verified FROM match_seats').all()).toEqual([{ match_id: 'm1', seat: 0, pseudonym: pa, verified: 1 }]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 1 });
    expect(everyValue(db, ['devices.id']).some((v) => v.includes(dev('a')))).toBe(false);
  });

  it('deleting a device removes every link at once and leaves other people and the matches alone', async () => {
    const db = testDb();
    const pa = addDevice(db, dev('a'), { nickname: 'Tatu', recovery_hash: 'h'.repeat(64) });
    const pb = addDevice(db, dev('b'));
    await addMatch(db, 'm1', [
      { seat: 0, device: dev('a') },
      { seat: 1, device: dev('b') },
    ]);
    await addMatch(db, 'm2', [{ seat: 0, device: dev('a') }]);
    addReport(db, pa, pb);
    addReport(db, pb, pa);
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, ref) VALUES (?, 'volume', ?, '2026-11-20:00000000000000aa')").run(pa, NOW);
    addProfile(db, pa);
    addProfile(db, pa, 'mineiro-4');
    addProfile(db, pb);
    addGroup(db, pa, '2026-11-20', '00000000000000aa');
    addGroup(db, pb, '2026-11-20', '00000000000000bb');
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('ABCDE', ?, ?, ?, 'room'), ('MNPQR', ?, ?, ?, 'room')").run(dev('a'), NOW, NOW + DAY, dev('a'), NOW, NOW + DAY);
    await db.batch([
      roomMemberStatement(db, 'ABCDE', dev('a'), NOW + DAY),
      roomMemberStatement(db, 'ABCDE', dev('b'), NOW + DAY),
      roomMemberStatement(db, 'FGHJK', dev('a'), NOW + DAY),
      roomMemberStatement(db, 'GONEA', dev('a'), NOW),
    ]);
    // A recovery to them still waiting for a room goes too; a call about someone else stays.
    await db.batch(queueStatements(db, [{ code: 'FGHJK', from: [dev('x')], to: dev('a') }, { code: 'ABCDE', from: [dev('y')], to: dev('b') }], NOW));

    // It answers every live room D1 listed for them, so a room joined after the Worker read the list is told too.
    expect((await deleteDevice(db, dev('a'), NOW)).sort()).toEqual(['ABCDE', 'FGHJK', 'MNPQR']);

    const values = everyValue(db);
    for (const gone of [dev('a'), pa, 'Tatu', 'h'.repeat(64)]) expect(values.some((v) => v.includes(gone)), gone).toBe(false);
    // The rooms they created stay reachable for the others, with no creator; their memberships are gone.
    expect(db.raw.prepare('SELECT code, device FROM open_rooms').all()).toEqual([
      { code: 'ABCDE', device: '' },
      { code: 'MNPQR', device: '' },
    ]);
    expect(db.raw.prepare('SELECT code, device FROM room_members').all()).toEqual([{ code: 'ABCDE', device: dev('b') }]);
    expect(db.raw.prepare('SELECT code, device, to_device FROM room_calls').all()).toEqual([{ code: 'ABCDE', device: dev('y'), to_device: dev('b') }]);
    // Nothing is left to answer the second time.
    expect(await deleteDevice(db, dev('a'), NOW)).toEqual([]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 2 });
    expect(db.raw.prepare('SELECT match_id, pseudonym FROM match_seats').all()).toEqual([{ match_id: 'm1', pseudonym: pb }]);
    // The report about them stays, without a target; the one they made is gone.
    expect(db.raw.prepare('SELECT reporter, target FROM reports').all()).toEqual([{ reporter: pb, target: null }]);
    // Their style counters and export group tokens are gone (a flag from the cycle no longer finds them); the others' stay.
    expect(db.raw.prepare('SELECT pseudonym, segment FROM profiles').all()).toEqual([{ pseudonym: pb, segment: 'paulista-2' }]);
    expect(db.raw.prepare('SELECT grp FROM export_groups').all()).toEqual([{ grp: '00000000000000bb' }]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 0 });
    expect((await myData(db, dev('a'), NOW))).toBeNull();
    expect((await myData(db, dev('b'), NOW))!.matches).toHaveLength(1);
  });

  it('recovery moves the device to a new id with its history, uses the code up and merges this browser', async () => {
    const db = testDb();
    const code = normalizeRecoveryCode(newRecoveryCode())!;
    const hash = await recoveryHash(code);
    const pa = addDevice(db, dev('a'), { recovery_hash: hash, abandons: 1, nickname: 'Ana' });
    const pc = addDevice(db, dev('c'), { abandons: 2, flagged: 1 });
    await addMatch(db, 'm1', [{ seat: 0, device: dev('a') }]);
    await addMatch(db, 'm2', [{ seat: 1, device: dev('c') }]);
    addReport(db, pc, null);
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at) VALUES (?, 'automation', ?)").run(pc, NOW);
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('ABCDE', ?, ?, ?, 'room'), ('FGHJK', ?, ?, ?, 'room')").run(dev('a'), NOW, NOW + DAY, dev('c'), NOW, NOW + DAY);
    // Both browsers sit in MNPQR (the new id keeps the later expiry); each also sits in a room of its own.
    for (const [code, d, until] of [['ABCDE', 'a', NOW + DAY], ['MNPQR', 'a', NOW + DAY], ['MNPQR', 'c', NOW + 2 * DAY], ['RSTVW', 'c', NOW + DAY], ['RSTVW', 'b', NOW + DAY]] as const) {
      addMember(db, code, dev(d), until);
    }
    // An earlier recovery to this browser that still waits for a room now ends at the new id.
    await db.batch(queueStatements(db, [{ code: 'RSTVW', from: [dev('x')], to: dev('c') }], NOW));

    expect(await recoverDevice(db, { codeHash: await recoveryHash('X'.repeat(20)), newId: dev('n'), currentId: dev('c'), now: NOW })).toBeNull();
    // It answers the recovered device's former id, so the Worker can tell its rooms.
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW + 5 })).toBe(dev('a'));

    const devices = db.raw.prepare('SELECT id, pseudonym, recovery_hash, abandons, flagged, nickname, last_seen FROM devices').all();
    expect(devices).toEqual([{ id: dev('n'), pseudonym: pa, recovery_hash: null, abandons: 3, flagged: 1, nickname: 'Ana', last_seen: NOW + 5 }]);
    expect(db.raw.prepare('SELECT match_id, pseudonym FROM match_seats ORDER BY match_id').all()).toEqual([
      { match_id: 'm1', pseudonym: pa },
      { match_id: 'm2', pseudonym: pa },
    ]);
    expect(db.raw.prepare('SELECT reporter FROM reports').all()).toEqual([{ reporter: pa }]);
    expect(db.raw.prepare('SELECT pseudonym FROM flags').all()).toEqual([{ pseudonym: pa }]);
    expect(db.raw.prepare('SELECT DISTINCT device FROM open_rooms').all()).toEqual([{ device: dev('n') }]);
    // Every room of either browser now lists the new id, once per room.
    expect(db.raw.prepare('SELECT code, device, expires_at FROM room_members ORDER BY code, device').all()).toEqual([
      { code: 'ABCDE', device: dev('n'), expires_at: NOW + DAY },
      { code: 'MNPQR', device: dev('n'), expires_at: NOW + 2 * DAY },
      { code: 'RSTVW', device: dev('b'), expires_at: NOW + DAY },
      { code: 'RSTVW', device: dev('n'), expires_at: NOW + DAY },
    ]);
    expect((await roomsOf(db, dev('n'), NOW)).sort()).toEqual(['ABCDE', 'FGHJK', 'MNPQR', 'RSTVW']);
    expect(await queuedCalls(db, dev('n'))).toEqual([{ code: 'RSTVW', from: [dev('x')], to: dev('n') }]);
    for (const gone of [dev('a'), dev('c'), pc, hash]) expect(everyValue(db).some((v) => v.includes(gone)), gone).toBe(false);

    // The code works once.
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('m'), currentId: null, now: NOW })).toBeNull();
    expect(db.raw.prepare('SELECT id FROM devices').all()).toEqual([{ id: dev('n') }]);
  });

  it('recovery in a browser with no device of its own, or in the same browser, keeps everything', async () => {
    const db = testDb();
    const hash = await recoveryHash('2'.repeat(20));
    const pa = addDevice(db, dev('a'), { recovery_hash: hash });
    await addMatch(db, 'm1', [{ seat: 0, device: dev('a') }]);
    // A room whose creator deleted their data belongs to nobody, and a recovery does not take it.
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('ABCDE', '', ?, ?, 'room')").run(NOW, NOW + DAY);
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: null, now: NOW })).toBe(dev('a'));
    expect(db.raw.prepare('SELECT device FROM open_rooms').all()).toEqual([{ device: '' }]);
    expect((await myData(db, dev('n'), NOW))!.matches.map((m) => m.matchId)).toEqual(['m1']);
    db.raw.prepare('UPDATE devices SET recovery_hash = ?').run(hash);
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('m'), currentId: dev('n'), now: NOW })).toBe(dev('n'));
    expect(db.raw.prepare('SELECT id, pseudonym FROM devices').all()).toEqual([{ id: dev('m'), pseudonym: pa }]);
    expect((await myData(db, dev('m'), NOW))!.matches).toHaveLength(1);
  });

  it('recovery keeps an objection made in either browser', async () => {
    for (const [mine, theirs] of [
      [{ open_data_opt_out: 1, no_adapt: 1 }, {}],
      [{}, { open_data_opt_out: 1, no_adapt: 1 }],
      [{ open_data_opt_out: 1 }, { no_adapt: 1 }],
    ]) {
      const db = testDb();
      const hash = await recoveryHash('3'.repeat(20));
      addDevice(db, dev('a'), { recovery_hash: hash, ...theirs });
      addDevice(db, dev('c'), mine);
      expect(await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW })).toBe(dev('a'));
      expect(db.raw.prepare('SELECT open_data_opt_out, no_adapt FROM devices').all(), JSON.stringify([mine, theirs])).toEqual([{ open_data_opt_out: 1, no_adapt: 1 }]);
    }
    // Neither objected: neither switch turns on.
    const db = testDb();
    const hash = await recoveryHash('4'.repeat(20));
    addDevice(db, dev('a'), { recovery_hash: hash });
    addDevice(db, dev('c'));
    await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW });
    expect(db.raw.prepare('SELECT open_data_opt_out, no_adapt FROM devices').all()).toEqual([{ open_data_opt_out: 0, no_adapt: 0 }]);
  });

  it('recovery keeps an open flag over a cleared one, so the owner can still review it', async () => {
    const db = testDb();
    const hash = await recoveryHash('6'.repeat(20));
    const pa = addDevice(db, dev('a'), { recovery_hash: hash });
    const pc = addDevice(db, dev('c'), { flagged: 1 });
    // The recovered device: a flag the owner cleared 10 days ago (inside the 15 day grace).
    // This browser: an open flag of the cycle, ref R, 2 days old.
    const R = `2026-11-20:${'c'.repeat(16)}`;
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, reviewed_at, decision, ref) VALUES (?, 'volume', ?, ?, 'cleared', ?)").run(pa, NOW - 18 * DAY, NOW - 10 * DAY, `2026-10-25:${'a'.repeat(16)}`);
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, ref) VALUES (?, 'regular-times', ?, ?)").run(pc, NOW - 2 * DAY, R);
    db.raw.prepare("INSERT INTO export_groups (export_date, grp, pseudonym) VALUES ('2026-11-20', ?, ?)").run('c'.repeat(16), pc);
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW })).toBe(dev('a'));
    const row = () => db.raw.prepare('SELECT d.flagged AS flagged, f.ref AS ref, f.decision AS decision FROM devices d JOIN flags f ON f.pseudonym = d.pseudonym').all();
    expect(row()).toEqual([{ flagged: 1, ref: R, decision: null }]);
    // The owner clears R with the flags tool: the flag is reviewed and the person is back in.
    const lists = await importFlags(
      db,
      [
        { ref: R, op: 'flag', reason: 'regular-times', evidence: 'x', at: NOW - 2 * DAY },
        { ref: R, op: 'clear', at: NOW + 3_600_000 },
      ],
      'f'.repeat(64),
      NOW + 7_200_000,
    );
    expect(lists).toEqual({ applied: [], ignored: [], unresolved: [], reviewed: [R] });
    expect(row()).toEqual([{ flagged: 0, ref: R, decision: 'cleared' }]);

    // Both cleared: the recovered device's row stays, as before.
    const db2 = testDb();
    const hash2 = await recoveryHash('7'.repeat(20));
    const qa = addDevice(db2, dev('a'), { recovery_hash: hash2 });
    const qc = addDevice(db2, dev('c'));
    db2.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, reviewed_at, decision, ref) VALUES (?, 'volume', ?, ?, 'cleared', 'ra')").run(qa, NOW - 18 * DAY, NOW - 10 * DAY);
    db2.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, reviewed_at, decision, ref) VALUES (?, 'volume', ?, ?, 'cleared', 'rc')").run(qc, NOW - 8 * DAY, NOW - 7 * DAY);
    await recoverDevice(db2, { codeHash: hash2, newId: dev('n'), currentId: dev('c'), now: NOW });
    expect(db2.raw.prepare('SELECT ref, decision FROM flags').all()).toEqual([{ ref: 'ra', decision: 'cleared' }]);
  });

  it('recovery of a row from before the privacy migration gives it a pseudonym and the age declaration, and loses no seat', async () => {
    const db = testDb();
    const hash = await recoveryHash('5'.repeat(20));
    addDevice(db, dev('a'), { recovery_hash: hash, pseudonym: null, adult_at: null });
    const pc = addDevice(db, dev('c'));
    await addMatch(db, 'm9', [{ seat: 2, device: dev('c') }]);
    expect(db.raw.prepare('SELECT pseudonym FROM match_seats').all()).toEqual([{ pseudonym: pc }]);
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW + 7 })).toBe(dev('a'));
    const row = db.raw.prepare('SELECT id, pseudonym, adult_at FROM devices').get() as { id: string; pseudonym: string | null; adult_at: number | null };
    expect(row.id).toBe(dev('n'));
    expect(row.pseudonym).toMatch(/^[0-9a-f]{32}$/);
    expect(row.adult_at).toBe(NOW + 7);
    // The current browser's seat moved to the new pseudonym instead of losing its link.
    expect(db.raw.prepare('SELECT match_id, seat, pseudonym FROM match_seats').all()).toEqual([{ match_id: 'm9', seat: 2, pseudonym: row.pseudonym }]);
    expect((await myData(db, dev('n'), NOW))!.matches.map((m) => m.matchId)).toEqual(['m9']);
    // An earlier declaration is kept as it was.
    const db2 = testDb();
    addDevice(db2, dev('a'), { recovery_hash: hash, adult_at: NOW - DAY });
    await recoverDevice(db2, { codeHash: hash, newId: dev('n'), currentId: null, now: NOW });
    expect(db2.raw.prepare('SELECT adult_at FROM devices').get()).toEqual({ adult_at: NOW - DAY });
  });

  it('rooms of a device: the live ones it created or sits in, each once', async () => {
    const db = testDb();
    addDevice(db, dev('a'));
    addDevice(db, dev('b'));
    db.raw
      .prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('ABCDE', ?, ?, ?, 'room'), ('FGHJK', ?, ?, ?, 'solo'), ('GONEA', ?, ?, ?, 'solo')")
      .run(dev('a'), NOW, NOW + DAY, dev('b'), NOW, NOW + DAY, dev('a'), NOW - DAY, NOW);
    await db.batch([
      roomMemberStatement(db, 'ABCDE', dev('a'), NOW + DAY),
      roomMemberStatement(db, 'MNPQR', dev('a'), NOW + DAY),
      roomMemberStatement(db, 'FGHJK', dev('b'), NOW + DAY),
      roomMemberStatement(db, 'GONEB', dev('a'), NOW),
    ]);
    // Expired rows (a room that is gone) are left out.
    expect((await roomsOf(db, dev('a'), NOW)).sort()).toEqual(['ABCDE', 'MNPQR']);
    expect(await roomsOf(db, dev('z'), NOW)).toEqual([]);
    // Writing again never moves an expiry back.
    await roomMemberStatement(db, 'MNPQR', dev('a'), NOW + 60_000).run();
    expect(db.raw.prepare("SELECT expires_at FROM room_members WHERE code = 'MNPQR'").all()).toEqual([{ expires_at: NOW + DAY }]);
    await roomMemberStatement(db, 'MNPQR', dev('a'), NOW + 2 * DAY).run();
    expect(db.raw.prepare("SELECT expires_at FROM room_members WHERE code = 'MNPQR'").all()).toEqual([{ expires_at: NOW + 2 * DAY }]);
    // A device D1 does not have (deleted, or moved to another browser) gets no row back.
    expect((await roomMemberStatement(db, 'MNPQR', dev('z'), NOW + DAY).run()).meta.changes).toBe(0);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM room_members WHERE device = ?').get(dev('z'))).toEqual({ n: 0 });
    // The listing rewrite carries everyone seated along with it.
    await db.batch(roomListingStatements(db, 'ABCDE', NOW + 3 * DAY, [dev('a'), dev('b'), dev('z')]));
    expect(db.raw.prepare("SELECT expires_at FROM open_rooms WHERE code = 'ABCDE'").get()).toEqual({ expires_at: NOW + 3 * DAY });
    expect(db.raw.prepare("SELECT device, expires_at FROM room_members WHERE code = 'ABCDE' ORDER BY device").all()).toEqual([
      { device: dev('a'), expires_at: NOW + 3 * DAY },
      { device: dev('b'), expires_at: NOW + 3 * DAY },
    ]);
  });

  it('waiting room calls: one row per id and room, grouped per room and target, removed once done', async () => {
    const db = testDb();
    await db.batch(
      queueStatements(
        db,
        [
          { code: 'ABCDE', from: [dev('a'), dev('c')], to: dev('n') },
          { code: 'FGHJK', from: [dev('d')], to: null },
        ],
        NOW,
      ),
    );
    // A newer call for the same id in the same room replaces the older one.
    await db.batch(queueStatements(db, [{ code: 'ABCDE', from: [dev('c')], to: dev('m') }], NOW + 1));
    expect(await queuedCalls(db)).toEqual([
      { code: 'ABCDE', from: [dev('a')], to: dev('n') },
      { code: 'FGHJK', from: [dev('d')], to: null },
      { code: 'ABCDE', from: [dev('c')], to: dev('m') },
    ]);
    expect(await queuedCalls(db, dev('n'))).toEqual([{ code: 'ABCDE', from: [dev('a')], to: dev('n') }]);
    // Only the call delivered leaves: the same ids with another target (a later recovery) stay.
    await db.batch(doneStatements(db, [{ code: 'ABCDE', from: [dev('a'), dev('c')], to: null }]));
    expect(await queuedCalls(db)).toHaveLength(3);
    await db.batch(doneStatements(db, [{ code: 'ABCDE', from: [dev('a')], to: dev('n') }, { code: 'ABCDE', from: [dev('c')], to: dev('m') }]));
    expect(await queuedCalls(db)).toEqual([{ code: 'FGHJK', from: [dev('d')], to: null }]);
    await db.batch(doneStatements(db, [{ code: 'FGHJK', from: [dev('d')], to: null }]));
    expect(await queuedCalls(db)).toEqual([]);
  });

  it('the human check keeps the browser\'s own device, and a deleted or moved one never comes back', async () => {
    const db = testDb();
    const pa = addDevice(db, dev('a'), { matches_since_verify: 7, verified_at: NOW - DAY, last_seen: NOW - DAY, nickname: 'Ana' });
    // Its own device: the check and the allowance start over, the rest stays.
    expect(await checkedDevice(db, dev('a'), dev('f'), NOW)).toBe(dev('a'));
    expect(db.raw.prepare('SELECT id, pseudonym, matches_since_verify, verified_at, last_seen, nickname FROM devices').all()).toEqual([
      { id: dev('a'), pseudonym: pa, matches_since_verify: 0, verified_at: NOW, last_seen: NOW, nickname: 'Ana' },
    ]);
    // A browser without a cookie gets the new device.
    expect(await checkedDevice(db, null, dev('g'), NOW)).toBe(dev('g'));
    // A cookie whose device D1 no longer has (deleted, moved, removed by retention) gets the new one too, never its old id.
    await deleteDevice(db, dev('a'), NOW);
    expect(await checkedDevice(db, dev('a'), dev('h'), NOW + 1)).toBe(dev('h'));
    const rows = db.raw.prepare('SELECT id, pseudonym, adult_at, verified_at, matches_since_verify FROM devices ORDER BY id').all() as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual([dev('g'), dev('h')]);
    expect(rows[1]).toMatchObject({ adult_at: NOW + 1, verified_at: NOW + 1, matches_since_verify: 0 });
    expect(rows[1].pseudonym).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[1].pseudonym).not.toBe(pa);
    // A row from before the privacy migration gets a pseudonym on its next check.
    addDevice(db, dev('p'), { pseudonym: null });
    await checkedDevice(db, dev('p'), dev('q'), NOW);
    expect((db.raw.prepare('SELECT pseudonym FROM devices WHERE id = ?').get(dev('p')) as { pseudonym: string }).pseudonym).toMatch(/^[0-9a-f]{32}$/);
  });

  it('retention removes devices unseen for 12 months with their links, old reports, reviewed flags and expired rooms', async () => {
    const db = testDb();
    const old = NOW - RETENTION_MS - DAY;
    const recent = NOW - 30 * DAY;
    const po = addDevice(db, dev('o'), { last_seen: old, created_at: old - DAY });
    const pr = addDevice(db, dev('r'), { last_seen: recent });
    await addMatch(db, 'm1', [
      { seat: 0, device: dev('o') },
      { seat: 1, device: dev('r') },
    ]);
    addReport(db, po, pr, recent);
    addReport(db, pr, po, recent);
    addReport(db, pr, null, old);
    db.raw.prepare('INSERT INTO flags (pseudonym, reason, created_at, reviewed_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)').run(
      po, 'a', old, null,
      'p'.repeat(32), 'b', old, old,
      pr, 'c', old, null,
    );
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('AAAAA', ?, ?, ?, 'room'), ('BBBBB', ?, ?, ?, 'solo')").run(dev('r'), NOW - 2 * DAY, NOW - DAY, dev('r'), NOW, NOW + DAY);
    // A room still in use that the stale device created and still sits in (it left a match; the
    // others kept playing rematches), and another live room it sits in.
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('LIVE1', ?, ?, ?, 'room'), ('LIVE2', ?, ?, ?, 'room')").run(dev('o'), NOW - 2 * DAY, NOW + DAY, dev('r'), NOW - DAY, NOW + DAY);
    // A stale device's membership goes with it; an expired one goes on its own; a current one stays.
    await db.batch([
      roomMemberStatement(db, 'CCCCC', dev('o'), NOW + DAY),
      roomMemberStatement(db, 'DDDDD', dev('r'), NOW - 1),
      roomMemberStatement(db, 'BBBBB', dev('r'), NOW + DAY),
      roomMemberStatement(db, 'LIVE1', dev('o'), NOW + DAY),
      roomMemberStatement(db, 'LIVE1', dev('r'), NOW + DAY),
      roomMemberStatement(db, 'LIVE2', dev('o'), NOW + DAY),
    ]);
    // A waiting call for a room that is gone (expired or never listed) goes; one for a live room stays.
    await db.batch(
      queueStatements(
        db,
        [
          { code: 'AAAAA', from: [dev('x')], to: null },
          { code: 'ZZZZZ', from: [dev('x')], to: null },
          { code: 'BBBBB', from: [dev('y')], to: dev('r') },
          // A recovery to the stale device that still waits for a live room.
          { code: 'LIVE2', from: [dev('z')], to: dev('o') },
        ],
        NOW - DAY,
      ),
    );

    // Style counters go with the device; group tokens with the device or after 30 days.
    addProfile(db, po);
    addProfile(db, pr);
    addGroup(db, po, '2026-11-20', '00000000000000a1');
    addGroup(db, pr, '2026-11-20', '00000000000000a2');
    addGroup(db, pr, '2026-10-22', '00000000000000a3');
    addGroup(db, pr, '2026-10-21', '00000000000000a4');

    const res = await runRetention(db, NOW);
    expect(res).toEqual({ devices: 1, reports: 1, flags: 1, rooms: 1, members: 1, calls: 2, exportGroups: 2, profiles: 1 });
    expect(db.raw.prepare('SELECT pseudonym FROM profiles').all()).toEqual([{ pseudonym: pr }]);
    expect(db.raw.prepare('SELECT grp FROM export_groups ORDER BY grp').all()).toEqual([{ grp: '00000000000000a2' }, { grp: '00000000000000a3' }]);
    expect(db.raw.prepare('SELECT id FROM devices').all()).toEqual([{ id: dev('r') }]);
    expect(db.raw.prepare('SELECT pseudonym FROM match_seats').all()).toEqual([{ pseudonym: pr }]);
    expect(db.raw.prepare('SELECT reporter, target FROM reports').all()).toEqual([{ reporter: pr, target: null }]);
    expect(db.raw.prepare('SELECT pseudonym FROM flags').all()).toEqual([{ pseudonym: pr }]);
    // The live room the stale device created stays listed, with no creator, for the others there.
    expect(db.raw.prepare('SELECT code, device FROM open_rooms ORDER BY code').all()).toEqual([
      { code: 'BBBBB', device: dev('r') },
      { code: 'LIVE1', device: '' },
      { code: 'LIVE2', device: dev('r') },
    ]);
    expect(db.raw.prepare('SELECT code, device FROM room_members ORDER BY code').all()).toEqual([
      { code: 'BBBBB', device: dev('r') },
      { code: 'LIVE1', device: dev('r') },
    ]);
    // Each live room that holds the stale device is called, like after a deletion (no call for
    // CCCCC, which is not listed any more); the recovery to it ends as a deletion.
    const calls = await queuedCalls(db);
    expect(calls).toEqual([
      { code: 'BBBBB', from: [dev('y')], to: dev('r') },
      { code: 'LIVE2', from: [dev('z'), dev('o')], to: null },
      { code: 'LIVE1', from: [dev('o')], to: null },
    ]);
    // The scheduled handler delivers them right after; once the rooms answered, the stale device is gone everywhere.
    await db.batch(doneStatements(db, calls.filter((c) => c.code !== 'BBBBB')));
    expect(db.raw.prepare('SELECT code FROM room_calls').all()).toEqual([{ code: 'BBBBB' }]);
    for (const gone of [dev('o'), po]) expect(everyValue(db).some((v) => v.includes(gone)), gone).toBe(false);
    // A second run finds nothing more.
    expect(await runRetention(db, NOW)).toEqual({ devices: 0, reports: 0, flags: 0, rooms: 0, members: 0, calls: 0, exportGroups: 0, profiles: 0 });
  });

  it('a reviewed flag loses its ref 30 days after the review; one waiting for review keeps it', async () => {
    const db = testDb();
    const rows: [string, number | null, string | null][] = [
      ['2026-10-01:00000000000000b1', NOW - 31 * DAY, 'cleared'],
      ['2026-10-01:00000000000000b2', NOW - 29 * DAY, 'confirmed'],
      ['2026-10-01:00000000000000b3', null, null],
    ];
    rows.forEach(([ref, reviewedAt, decision], i) =>
      db.raw.prepare('INSERT INTO flags (pseudonym, reason, created_at, ref, reviewed_at, decision) VALUES (?, ?, ?, ?, ?, ?)').run(String(i).repeat(32), 'volume', NOW - 40 * DAY, ref, reviewedAt, decision),
    );
    await runRetention(db, NOW);
    expect(db.raw.prepare('SELECT ref, decision FROM flags ORDER BY pseudonym').all()).toEqual([
      { ref: null, decision: 'cleared' },
      { ref: '2026-10-01:00000000000000b2', decision: 'confirmed' },
      { ref: '2026-10-01:00000000000000b3', decision: null },
    ]);
  });

  it('the data export shows this device only: its pseudonym and matches, its reports without the target, flags', async () => {
    const db = testDb();
    const pa = addDevice(db, dev('a'), { nickname: 'Ana', no_adapt: 1, recovery_hash: 'h'.repeat(64) });
    const pb = addDevice(db, dev('b'), { nickname: 'Bia' });
    await addMatch(db, 'm1', [
      { seat: 0, device: dev('a') },
      { seat: 1, device: dev('b') },
    ]);
    addReport(db, pa, pb);
    addReport(db, pb, pa);
    db.raw.prepare("INSERT INTO open_rooms (code, device, created_at, expires_at, mode) VALUES ('ABCDE', ?, ?, ?, 'room')").run(dev('a'), NOW, NOW + DAY);
    await db.batch([roomMemberStatement(db, 'ABCDE', dev('a'), NOW + DAY), roomMemberStatement(db, 'FGHJK', dev('a'), NOW - 1), roomMemberStatement(db, 'MNPQR', dev('b'), NOW + DAY)]);
    addProfile(db, pa, 'mineiro-2');
    addProfile(db, pb);
    addGroup(db, pa, '2026-11-20', '00000000000000aa');
    addGroup(db, pb, '2026-11-20', '00000000000000bb');
    db.raw.prepare("INSERT INTO flags (pseudonym, reason, created_at, ref) VALUES (?, 'volume', ?, '2026-11-20:00000000000000aa')").run(pa, NOW);
    const data = (await myData(db, dev('a'), NOW))!;
    expect(data.pseudonym).toBe(pa);
    expect(data.profile).toEqual([
      { segment: 'mineiro-2', matches: 1, decisions: 10, H: 5, K: 2, U: 1, A: 1, X: 0, S: 1, Q: 2, V: 0, W: 1, BC: 3, BR: 1, G: 2, GT: 1, TN: 8, TL: 60, TL2: 460 },
    ]);
    expect(data.exportGroups).toEqual([{ exportDate: '2026-11-20', group: '00000000000000aa' }]);
    expect(data.flags).toEqual([{ reason: 'volume', createdAt: NOW, reviewedAt: null, decision: null, ref: '2026-11-20:00000000000000aa' }]);
    expect(data.device).toMatchObject({ nickname: 'Ana', prefs: { openDataOptOut: false, noAdapt: true }, hasRecoveryCode: true, flagged: false });
    expect(data.matches).toEqual([{ matchId: 'm1', seat: 0, startedAt: NOW - 60_000, endedAt: NOW, kind: 'mixed', verified: true }]);
    expect(data.openRooms).toEqual([{ code: 'ABCDE', createdAt: NOW, expiresAt: NOW + DAY, mode: 'room' }]);
    expect(data.joinedRooms).toEqual([{ code: 'ABCDE', expiresAt: NOW + DAY }]);
    expect(data.reportsMade).toEqual([{ createdAt: NOW, matchId: 'm1', roomCode: 'ABCDE', seat: 1, reason: 'nickname', status: 'open' }]);
    // A report about you shows only its day: the exact time could point to the reporter.
    expect(data.reportsAboutYou).toEqual([{ createdAt: Date.UTC(2026, 10, 21), reason: 'nickname', status: 'open' }]);
    const text = JSON.stringify(data);
    for (const hidden of [dev('a'), dev('b'), pb, 'Bia', 'h'.repeat(64), '00000000000000bb']) expect(text, hidden).not.toContain(hidden);
  });

  it('style counters: added with the seat link, once, never for a person with "Don\'t adapt to me" on', async () => {
    const db = testDb();
    const pa = addDevice(db, dev('a'));
    addDevice(db, dev('n'), { no_adapt: 1 });
    const counts = { ...emptyProfile(), matches: 1, D: 12, H: 6, K: 2, U: 1, A: 2, X: 1, S: 1, Q: 2, V: 1, W: 3, BC: 4, BR: 1, G: 2, GT: 1, TN: 10, TL: 75.5, TL2: 580.25 };
    const row = (seats: MatchRow['seats'], profiles: MatchRow['profiles']): MatchRow => ({
      matchId: 'm1', startedAt: NOW - 60_000, endedAt: NOW, kind: 'mixed', variant: 'paulista', players: 4, aiVersion: 'v1', recordKey: 'k', seats, profiles,
    });
    const m = row(
      [{ seat: 0, device: dev('a'), verified: true }, { seat: 1, device: dev('n'), verified: true }, { seat: 2, device: dev('z'), verified: true }],
      [{ seat: 0, device: dev('a'), segment: 'paulista-4', counts }, { seat: 1, device: dev('n'), segment: 'paulista-4', counts }, { seat: 2, device: dev('z'), segment: 'paulista-4', counts }],
    );
    // Each seat's statement comes right after its counters (after the public counters and the match row).
    expect(seatStatementIndexes(m)).toEqual([3, 5, 7]);
    expect(seatStatementIndexes(row(m.seats, [m.profiles![1]]))).toEqual([2, 4, 5]);
    const res = await db.batch(matchRowStatements(db, m));
    expect(res.map((r) => r.meta.changes)).toEqual([1, 1, 1, 1, 0, 1, 0, 0]);
    const read = () => db.raw.prepare('SELECT pseudonym, segment, matches, decisions, h, k, u, a, x, s, q, v, w, bc, br, g, gt, tn, tl, tl2, updated_at FROM profiles').all();
    const once = [{ pseudonym: pa, segment: 'paulista-4', matches: 1, decisions: 12, h: 6, k: 2, u: 1, a: 2, x: 1, s: 1, q: 2, v: 1, w: 3, bc: 4, br: 1, g: 2, gt: 1, tn: 10, tl: 75.5, tl2: 580.25, updated_at: NOW }];
    expect(read()).toEqual(once);
    // A repeated flush (a retry, or a recovery that landed meanwhile) counts nothing again.
    await db.batch(matchRowStatements(db, m));
    expect(read()).toEqual(once);
    // Another match in the same segment adds up; another segment gets its own row.
    await db.batch(matchRowStatements(db, { ...m, matchId: 'm2' }));
    await db.batch(matchRowStatements(db, { ...m, matchId: 'm3', profiles: [{ ...m.profiles![0], segment: 'mineiro-2' }] }));
    expect(db.raw.prepare('SELECT segment, matches, decisions, tl FROM profiles ORDER BY segment').all()).toEqual([
      { segment: 'mineiro-2', matches: 1, decisions: 12, tl: 75.5 },
      { segment: 'paulista-4', matches: 2, decisions: 24, tl: 151 },
    ]);
    // A seat whose device D1 lacks gets its counters when it is linked later (pending-records.ts).
    addDevice(db, dev('z'));
    await db.batch(matchRowStatements(db, row([m.seats[2]], [m.profiles![2]])));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM profiles').get()).toEqual({ n: 3 });
    expect(everyValue(db, ['devices.id']).some((v) => v.includes(dev('a')))).toBe(false);
  });

  it('recovery adds this browser\'s counters into the recovered ones and moves its export groups', async () => {
    const db = testDb();
    const hash = await recoveryHash('6'.repeat(20));
    const pa = addDevice(db, dev('a'), { recovery_hash: hash });
    const pc = addDevice(db, dev('c'));
    addProfile(db, pa, 'paulista-2', { matches: 3, decisions: 30, tl: 100, updated_at: NOW - DAY });
    addProfile(db, pc, 'paulista-2', { matches: 1, decisions: 5, tl: 20, updated_at: NOW });
    addProfile(db, pc, 'mineiro-4', { matches: 2 });
    addGroup(db, pa, '2026-11-20', '00000000000000a1');
    addGroup(db, pc, '2026-11-20', '00000000000000c1');
    addGroup(db, pc, '2026-11-19', '00000000000000c2');
    expect(await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW })).toBe(dev('a'));
    expect(db.raw.prepare('SELECT pseudonym, segment, matches, decisions, tl, updated_at FROM profiles ORDER BY segment').all()).toEqual([
      { pseudonym: pa, segment: 'mineiro-4', matches: 2, decisions: 10, tl: 60, updated_at: NOW },
      { pseudonym: pa, segment: 'paulista-2', matches: 4, decisions: 35, tl: 120, updated_at: NOW },
    ]);
    // Both had a group in the 2026-11-20 export: the recovered one's stays, and a flag on the other one no longer finds anyone.
    expect(db.raw.prepare('SELECT export_date, grp, pseudonym FROM export_groups ORDER BY export_date').all()).toEqual([
      { export_date: '2026-11-19', grp: '00000000000000c2', pseudonym: pa },
      { export_date: '2026-11-20', grp: '00000000000000a1', pseudonym: pa },
    ]);
    for (const gone of [pc, dev('c')]) expect(everyValue(db).some((v) => v.includes(gone)), gone).toBe(false);
    const data = (await myData(db, dev('n'), NOW))!;
    expect(data.profile.map((p) => [p.segment, p.matches, p.decisions])).toEqual([['mineiro-4', 2, 10], ['paulista-2', 4, 35]]);
    expect(data.exportGroups).toEqual([{ exportDate: '2026-11-19', group: '00000000000000c2' }, { exportDate: '2026-11-20', group: '00000000000000a1' }]);
  });

  it('recovery with "Don\'t adapt to me" on in either browser keeps no counters', async () => {
    for (const [mine, theirs] of [[{ no_adapt: 1 }, {}], [{}, { no_adapt: 1 }]]) {
      const db = testDb();
      const hash = await recoveryHash('7'.repeat(20));
      const pa = addDevice(db, dev('a'), { recovery_hash: hash, ...theirs });
      const pc = addDevice(db, dev('c'), mine);
      if (!theirs.no_adapt) addProfile(db, pa);
      if (!mine.no_adapt) addProfile(db, pc);
      await recoverDevice(db, { codeHash: hash, newId: dev('n'), currentId: dev('c'), now: NOW });
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM profiles').get(), JSON.stringify([mine, theirs])).toEqual({ n: 0 });
    }
  });

  it('recovery codes: 20 characters of the room alphabet in groups of 5, typed in any case', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newRecoveryCode();
      expect(c).toMatch(new RegExp(`^[${CODE_ALPHABET}]{5}( [${CODE_ALPHABET}]{5}){3}$`));
      seen.add(c);
    }
    expect(seen.size).toBe(200);
    expect(normalizeRecoveryCode('abcde fghjk mnpqr stuvw')).toBe('ABCDEFGHJKMNPQRSTUVW');
    expect(normalizeRecoveryCode('ABCDE-FGHJK-MNPQR-STUVW')).toBe('ABCDEFGHJKMNPQRSTUVW');
    for (const bad of ['ABCDE', 'ABCDE FGHJK MNPQR STUV0', 'IIIII IIIII IIIII IIIII', 12, null, 'A'.repeat(100)]) expect(normalizeRecoveryCode(bad)).toBeNull();
    expect(newPseudonym()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('match allowance', () => {
  it('takes one match at a time up to 10, then refuses until the next check', async () => {
    const db = testDb();
    addDevice(db, dev('a'), { last_seen: NOW - DAY });
    const left: (number | null)[] = [];
    for (let i = 0; i < MATCHES_PER_CHECK + 2; i++) left.push(await reserveMatch(db, dev('a'), NOW));
    expect(left).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, null, null]);
    expect(db.raw.prepare('SELECT matches_since_verify, last_seen FROM devices').get()).toEqual({ matches_since_verify: MATCHES_PER_CHECK, last_seen: NOW });
    // A start that did not happen gives its match back, never below zero.
    await refundMatch(db, dev('a'));
    expect(await reserveMatch(db, dev('a'), NOW)).toBe(0);
    db.raw.prepare('UPDATE devices SET matches_since_verify = 0').run();
    await refundMatch(db, dev('a'));
    expect(db.raw.prepare('SELECT matches_since_verify FROM devices').get()).toEqual({ matches_since_verify: 0 });
  });

  it('parallel starts cannot overspend it', async () => {
    const db = testDb();
    addDevice(db, dev('a'), { matches_since_verify: 7 });
    const res = await Promise.all(Array.from({ length: 8 }, () => reserveMatch(db, dev('a'), NOW)));
    expect(res.filter((x) => x !== null).sort()).toEqual([0, 1, 2]);
    expect(db.raw.prepare('SELECT matches_since_verify FROM devices').get()).toEqual({ matches_since_verify: MATCHES_PER_CHECK });
  });

  it('refuses a device that is blocked, never passed the check, never declared its age, or does not exist', async () => {
    const db = testDb();
    addDevice(db, dev('b'), { blocked_until: NOW + 60_000 });
    addDevice(db, dev('v'), { verified_at: null });
    addDevice(db, dev('y'), { adult_at: null });
    for (const d of ['b', 'v', 'y', 'z']) expect(await reserveMatch(db, dev(d), NOW), d).toBeNull();
    // The block ends.
    expect(await reserveMatch(db, dev('b'), NOW + 60_000)).toBe(9);
  });
});
