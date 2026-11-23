// The brake on a running site (worker/src/brake.ts): quick play refused, a room's start refused,
// a rematch refused, and the swap of each match's reservation for what the room really spent,
// checked against the plan's budgets of Durable Object rows written per match (60 for a solo
// match, 320 for a room with 4 people). Needs a local test site (BASE=http://dev:8787, with
// TEST_RECORDS in .dev.vars): every test keeps its own ledger (x-zap-test-ledger), so the day's
// real ledger and the other test files never meet the brake.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CPU_PER_INVOCATION_MS, DEFAULT_COST_PER_PERSON, DEFAULT_COST_SOLO } from '../../worker/src/brake.ts';
import { BASE, Device, playToEnd, sleep, type Conn } from './helpers.ts';

interface Usage {
  workerRequests: number;
  doRequests: number;
  doWsMessages: number;
  doRowsWritten: number;
  doActiveMs: number;
  d1RowsWritten: number;
  d1RowsRead: number;
}

interface Ledger {
  day: string;
  matches: number;
  settled: number;
  refused: number;
  reserved: Usage;
  spent: Usage;
}

/** The plan's budgets (section 14), held by test. */
const SOLO_DO_ROWS = 60;
const ROOM4_DO_ROWS = 320;

/** A new test ledger with room for `capacity` solo matches. */
function ledger(capacity: number): { id: string; header: Record<string, string> } {
  const id = randomBytes(8).toString('hex');
  return { id, header: { 'x-zap-test-ledger': `${id}:${capacity}` } };
}

async function readLedger(id: string): Promise<Ledger | null> {
  const res = await fetch(`${BASE}/api/test/ledger/${id}`);
  return res.status === 200 ? ((await res.json()) as Ledger) : null;
}

/** The ledger once `settled` matches were swapped (the room writes the swap with the match record, right after the end). */
async function settledLedger(id: string, settled: number): Promise<Ledger> {
  const until = Date.now() + 20_000;
  for (;;) {
    const l = await readLedger(id);
    if (l && l.settled >= settled) return l;
    if (Date.now() > until) throw new Error(`ledger ${id} not settled: ${JSON.stringify(l)}`);
    await sleep(250);
  }
}

/**
 * The room expires now (a local test site only: POST /api/test/rooms/<code>/expire), and the
 * ledger is read once its expiry wrote what the room spent after its last swap: the expiry's own
 * alarm adds at least one Durable Object request, so the sum of those grows.
 */
async function expiredLedger(d: Device, code: string, id: string, before: Ledger): Promise<Ledger> {
  const res = await d.post(`/api/test/rooms/${code}/expire`, {});
  expect(res.status).toBe(200);
  const until = Date.now() + 20_000;
  for (;;) {
    const l = (await readLedger(id))!;
    if (l.spent.doRequests > before.spent.doRequests) return l;
    if (Date.now() > until) throw new Error(`ledger ${id} got no expiry: ${JSON.stringify(l)}`);
    await sleep(250);
  }
}

const minus = (a: Usage, b: Usage): Usage => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v - b[k as keyof Usage]])) as unknown as Usage;

const nextUtcMidnight = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

async function matchesUsed(d: Device): Promise<number> {
  const res = await d.get('/api/me/data');
  return res.body.device.matchesSinceVerify as number;
}

const zero = (u: Usage) => Object.values(u).every((x) => x === 0);

function report(label: string, u: Usage): void {
  console.log(
    `${label}: DO rows written ${u.doRowsWritten}, WebSocket messages ${u.doWsMessages}, DO requests ${u.doRequests}, ` +
      `Worker requests ${u.workerRequests}, active ${(u.doActiveMs / 1000).toFixed(2)} s (${(u.doActiveMs / 8000).toFixed(2)} GB-s), D1 rows written ${u.d1RowsWritten}, read ${u.d1RowsRead}`,
  );
}

describe.skipIf(!BASE)('the brake', () => {
  it('quick play refused: 503 limit_reached with the next 00:00 UTC, and nothing taken from the person', async () => {
    const d = await new Device().verified();
    const l = ledger(1);
    const first = await d.post('/api/play', { players: 4 }, { headers: l.header });
    expect(first.status).toBe(200);
    const before = await matchesUsed(d);
    expect(before).toBe(1);
    const refused = await d.post('/api/play', { players: 4 }, { headers: l.header });
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: 'limit_reached', limit: { period: 'day', resetAt: nextUtcMidnight(Date.now()) } });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await matchesUsed(d)).toBe(before);
    const row = (await readLedger(l.id))!;
    expect(row).toMatchObject({ matches: 1, refused: 1, settled: 0 });
  });

  it('a solo match swaps its reservation for what it spent, within 60 rows written, and its rematch is refused', async () => {
    const d = await new Device().verified();
    const l = ledger(1);
    const code = (await d.post('/api/play', { players: 4, variant: 'paulista' }, { headers: l.header })).body.code as string;
    const c = await d.connect(code);
    const open = (await readLedger(l.id))!;
    expect(open.matches).toBe(1);
    expect(zero(open.reserved)).toBe(false);
    const started = Date.now();
    const res = await playToEnd(c, { paceMs: 300, timeoutMs: 110_000 });
    expect(res.final.obs.over).toBe(true);
    const done = await settledLedger(l.id, 1);
    const wall = Date.now() - started;
    report('solo match, 2 against 2, paulista, fast random play', done.spent);
    expect(zero(done.reserved)).toBe(true);
    expect(done.spent.doRowsWritten).toBeGreaterThan(0);
    expect(done.spent.doRowsWritten).toBeLessThanOrEqual(SOLO_DO_ROWS);
    expect(done.spent.doWsMessages).toBeGreaterThanOrEqual(res.moves);
    expect(done.spent.workerRequests).toBeGreaterThanOrEqual(2);
    expect(done.spent.d1RowsWritten).toBeGreaterThan(0);
    // The room is billed while its handlers run (brake.ts BusyClock): at least the CPU allowance of
    // each request and message, and less than the match took on the clock, idle time between moves
    // left out.
    expect(done.spent.doActiveMs).toBeGreaterThanOrEqual(CPU_PER_INVOCATION_MS * (done.spent.doRequests + done.spent.doWsMessages));
    expect(done.spent.doActiveMs).toBeLessThan(wall);

    // The rematch would pass the ledger's room for one match: refused, and the room stays as it was.
    const used = await matchesUsed(d);
    await sleep(300);
    c.skip();
    c.send({ t: 'rematch' });
    const err = await c.nextError();
    expect(err).toEqual({ t: 'error', code: 'limit_reached', limit: { period: 'day', resetAt: nextUtcMidnight(Date.now()) } });
    expect(c.room!.room.status).toBe('ended');
    expect(c.room!.room.matchNo).toBe(1);
    expect(await matchesUsed(d)).toBe(used);
    // The refusal's own cost (its message and the ledger row) is in the ledger at once.
    const refusedRow = (await readLedger(l.id))!;
    expect(refusedRow).toMatchObject({ matches: 1, refused: 1, settled: 1 });
    expect(refusedRow.spent.doWsMessages).toBe(done.spent.doWsMessages + 1);
    expect(refusedRow.spent.d1RowsWritten).toBe(done.spent.d1RowsWritten + 1);
    c.close();

    // The room expires: what it spent after the swap (the record's writes, the close, the expiry,
    // the time they ran) is written once, with no reservation and no second count of the refusal.
    await sleep(500);
    const end = await expiredLedger(d, code, l.id, refusedRow);
    const tail = minus(end.spent, refusedRow.spent);
    report('after the swap until the room expired', tail);
    expect(end).toMatchObject({ matches: 1, settled: 1, refused: 1 });
    expect(zero(end.reserved)).toBe(true);
    expect(tail.doWsMessages).toBe(0);
    expect(tail.doActiveMs).toBeGreaterThanOrEqual(CPU_PER_INVOCATION_MS * tail.doRequests);
    expect(tail.doActiveMs).toBeLessThan(20_000);
    expect(tail.d1RowsWritten).toBeGreaterThan(0);
    report('solo match with its room until expiry', end.spent);
    expect(end.spent.doRowsWritten).toBeLessThanOrEqual(SOLO_DO_ROWS);
    // Nothing more is written after the expiry.
    await sleep(1_500);
    expect((await readLedger(l.id))!.spent).toEqual(end.spent);
  }, 160_000);

  it('a room\'s start refused: the owner reads limit_reached, the room stays in its lobby, nothing is taken', async () => {
    const a = await new Device().verified();
    const l = ledger(0);
    const code = (await a.post('/api/rooms', { players: 2, turnSeconds: 30 }, { headers: l.header })).body.code as string;
    const c = await a.connect(code);
    await c.nextRoom();
    const used = await matchesUsed(a);
    await sleep(300);
    c.send({ t: 'start' });
    const err = await c.nextError();
    expect(err.code).toBe('limit_reached');
    expect(err.limit?.period).toBe('day');
    await sleep(300);
    c.send({ t: 'sync' });
    expect((await c.nextRoom()).room.status).toBe('lobby');
    expect(await matchesUsed(a)).toBe(used);
    expect((await readLedger(l.id))!).toMatchObject({ matches: 0, refused: 1 });
    c.close();
  });

  it('a room with 4 people reserves for 4 at its start and swaps within 320 rows written', async () => {
    const people = await Promise.all([0, 1, 2, 3].map(() => new Device().verified()));
    const l = ledger(100);
    const code = (await people[0].post('/api/rooms', { players: 4, variant: 'paulista', turnSeconds: 30 }, { headers: l.header })).body.code as string;
    const conns: Conn[] = [];
    for (const p of people) {
      const c = await p.connect(code);
      await c.nextRoom((r) => r.you !== null);
      conns.push(c);
    }
    await conns[0].nextRoom((r) => r.room.seats.every((s) => s.kind === 'human' && s.connected));
    const before = (await readLedger(l.id)) ?? { matches: 0 };
    expect(before.matches).toBe(0);
    await sleep(300);
    conns[0].send({ t: 'start' });
    await conns[0].nextGame();
    // The reservation is the estimate for 4 people (wrangler.jsonc, the same values as brake.ts's fallbacks).
    const open = (await readLedger(l.id))!;
    expect(open.matches).toBe(1);
    expect(open.reserved.doRowsWritten).toBe(DEFAULT_COST_SOLO.doRowsWritten + 3 * DEFAULT_COST_PER_PERSON.doRowsWritten);
    const results = await Promise.all(conns.map((c) => playToEnd(c, { paceMs: 300, timeoutMs: 150_000 })));
    expect(results.every((r) => r.final.obs.over)).toBe(true);
    const done = await settledLedger(l.id, 1);
    report('room with 4 people, paulista, fast random play', done.spent);
    expect(zero(done.reserved)).toBe(true);
    expect(done.spent.doRowsWritten).toBeGreaterThan(0);
    expect(done.spent.doRowsWritten).toBeLessThanOrEqual(ROOM4_DO_ROWS);
    for (const c of conns) c.close();
    // With what the room spent until it expired, still within the budget.
    await sleep(500);
    const end = await expiredLedger(people[0], code, l.id, done);
    report('room with 4 people until expiry', end.spent);
    expect(end).toMatchObject({ matches: 1, settled: 1 });
    expect(zero(end.reserved)).toBe(true);
    expect(end.spent.doRowsWritten).toBeLessThanOrEqual(ROOM4_DO_ROWS);
  }, 200_000);

  it('a match nobody finished: the room\'s expiry gives its reservation back, with what it spent', async () => {
    const d = await new Device().verified();
    const l = ledger(3);
    const code = (await d.post('/api/play', { players: 4, variant: 'paulista' }, { headers: l.header })).body.code as string;
    const c = await d.connect(code);
    await c.nextGame();
    const open = (await readLedger(l.id))!;
    expect(zero(open.reserved)).toBe(false);
    c.close();
    await sleep(500);
    const end = await expiredLedger(d, code, l.id, open);
    expect(end).toMatchObject({ matches: 1, settled: 1, refused: 0 });
    expect(zero(end.reserved)).toBe(true);
    expect(end.spent.doRowsWritten).toBeGreaterThan(0);
    // The route exists only for rooms on a test ledger.
    const plain = await new Device().verified();
    const other = (await plain.post('/api/play', { players: 4 })).body.code as string;
    expect((await plain.post(`/api/test/rooms/${other}/expire`, {})).status).toBe(404);
  });
});
