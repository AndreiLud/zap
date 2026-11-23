// Measures what matches really spend on a running local test site, for the brake's estimates
// (worker/src/brake.ts, wrangler.jsonc BRAKE_COST_SOLO and BRAKE_COST_PER_PERSON) and
// project_docs/brake.md. Each match keeps its own test ledger (x-zap-test-ledger), so the numbers
// are the room's own count: the swap written when the match ends ("match"), and once the people
// left, the room made to expire at once (POST /api/test/rooms/<code>/expire) and what its expiry
// wrote after the swap ("tail": the record's writes, closing sockets, the expiry, and the time they ran).
// A room with one match costs "match" plus "tail" ("total"), which the estimates are made from.
//
// Duration: the room counts the time its handlers run, from entry until their promise settles,
// with awaited I/O and its waitUntil promises, plus CPU_PER_INVOCATION_MS for each invocation
// (worker/src/brake.ts BusyClock). The summary gives that time per invocation (Durable Object
// requests plus messages), which project_docs/brake.md compares with production.
//
// The players decide like the simulated people of the training cycle (training/cycle/sim/styles.ts):
// the base heuristic's cards, a betting style, and a think time drawn around a median that starts
// only after the events of a message are shown, as in a browser.
//
//   docker compose run --rm -T -e BASE=http://dev:8787 node node tests/sim/brake-measure.ts \
//     --solo 3 --room4 1 --think-ms 2500 --linger-ms 5000 --out .cache/brake-measure/run.json

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mulberry32 } from '../../engine/src/rng.ts';
import { styleMove, type Style } from '../../training/cycle/sim/styles.ts';
import { BASE, Device, sleep, type Conn, type GameMsg } from '../integration/helpers.ts';

interface Usage {
  workerRequests: number;
  doRequests: number;
  doWsMessages: number;
  doRowsWritten: number;
  doActiveMs: number;
  d1RowsWritten: number;
  d1RowsRead: number;
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const SOLO = Number(arg('solo', '2'));
const ROOM4 = Number(arg('room4', '1'));
const THINK_MS = Number(arg('think-ms', '2500'));
const OUT = arg('out', '');
const SEED = Number(arg('seed', '7'));
/** How long the people stay at the table after the match ends, before they close it. */
const LINGER_MS = Number(arg('linger-ms', '5000'));
const STYLES: Style[] = ['cautious', 'caller', 'aggressive', 'bluffer'];

/** Think time: log-normal around the median, as training/cycle/sim/run.ts draws it, never under 260 ms and inside the time left. */
function thinkMs(median: number, rand: () => number, leftMs: number | null): number {
  const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let t = median * Math.exp(0.35 * z);
  if (leftMs !== null) t = Math.min(t, Math.max(260, leftMs * 0.6));
  return Math.max(260, Math.round(t));
}

/** Plays one seat until the match ends; answers the number of moves sent. */
function playSeat(conn: Conn, style: Style, median: number, rand: () => number): Promise<number> {
  return new Promise((resolve, reject) => {
    const acted = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let moves = 0;
    const key = (g: GameMsg) => `${g.seq}:${g.obs.legal}`;
    const overall = setTimeout(() => reject(new Error('match too long')), 30 * 60_000);
    const consider = () => {
      const g = conn.game;
      if (!g) return;
      if (g.obs.over) {
        clearTimeout(overall);
        if (timer) clearTimeout(timer);
        resolve(moves);
        return;
      }
      if (timer || !g.deadline || g.deadline.seat !== g.obs.seat || g.obs.legal === 0 || acted.has(key(g))) return;
      const shown = g.events.reduce((m, e) => Math.max(m, e.at), 0);
      const left = g.deadline.at === null ? null : g.deadline.at - g.now - shown;
      timer = setTimeout(() => {
        timer = null;
        const now = conn.game;
        if (!now || key(now) !== key(g) || now.obs.over) return consider();
        acted.add(key(now));
        moves++;
        conn.send({ t: 'act', seq: now.seq, a: styleMove(style, now.obs, rand) });
      }, shown + thinkMs(median, rand, left));
    };
    conn.watch((m) => {
      if (m.t === 'error' && m.code !== 'stale' && m.code !== 'not_your_turn') reject(new Error(`server error ${m.code}`));
      else consider();
    });
    void conn.closed.then((c) => reject(new Error(`socket closed ${c.code}`)));
  });
}

function ledger(): { id: string; header: Record<string, string> } {
  const id = randomBytes(8).toString('hex');
  return { id, header: { 'x-zap-test-ledger': `${id}:100` } };
}

async function ledgerUntil(id: string, done: (l: { settled: number; spent: Usage; reserved: Usage }) => boolean, what: string): Promise<{ spent: Usage; reserved: Usage }> {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${BASE}/api/test/ledger/${id}`);
    if (res.status === 200) {
      const l = (await res.json()) as { settled: number; spent: Usage; reserved: Usage };
      if (done(l)) return l;
    }
    await sleep(250);
  }
  throw new Error(`ledger ${id}: ${what}`);
}

const settled = (id: string) => ledgerUntil(id, (l) => l.settled >= 1, 'never settled');

/** Makes the room expire now and answers the ledger once the expiry wrote (its alarm adds a Durable Object request). */
async function expired(d: Device, code: string, id: string, before: Usage): Promise<Usage> {
  const res = await d.post(`/api/test/rooms/${code}/expire`, {});
  if (res.status !== 200) throw new Error(`expire ${res.status} ${res.text}`);
  return (await ledgerUntil(id, (l) => l.spent.doRequests > before.doRequests, 'no expiry written')).spent;
}

const KEYS: (keyof Usage)[] = ['workerRequests', 'doRequests', 'doWsMessages', 'doRowsWritten', 'doActiveMs', 'd1RowsWritten', 'd1RowsRead'];
const minus = (a: Usage, b: Usage): Usage => Object.fromEntries(KEYS.map((k) => [k, a[k] - b[k]])) as unknown as Usage;

interface Result {
  kind: 'solo' | 'room4';
  style: string;
  thinkMedianMs: number;
  /** Hands dealt in the match. */
  hands: number;
  moves: number;
  wallMs: number;
  /** The swap: the match, from the room's creation to its end. */
  spent: Usage;
  /** What the room wrote at its expiry, after the swap. */
  tail: Usage;
  /** Both: the room with its one match until it expired. */
  total: Usage;
}

async function solo(i: number): Promise<Result> {
  const rand = mulberry32(SEED * 1000 + i);
  const style = STYLES[i % STYLES.length];
  const d = await new Device().verified();
  const l = ledger();
  const t0 = Date.now();
  const res = await d.post('/api/play', { players: 4, variant: 'paulista' }, { headers: l.header });
  if (res.status !== 200) throw new Error(`/api/play ${res.status} ${res.text}`);
  const conn = await d.connect(res.body.code as string);
  const moves = await playSeat(conn, style, THINK_MS, rand);
  const wallMs = Date.now() - t0;
  const { spent } = await settled(l.id);
  const hands = conn.game!.obs.handIndex + 1;
  // The person reads the result for a moment and closes the tab.
  await sleep(LINGER_MS);
  conn.close();
  await sleep(500);
  const total = await expired(d, res.body.code as string, l.id, spent);
  return { kind: 'solo', style, thinkMedianMs: THINK_MS, hands, moves, wallMs, spent, tail: minus(total, spent), total };
}

async function room4(i: number): Promise<Result> {
  const people = await Promise.all([0, 1, 2, 3].map(() => new Device().verified()));
  const l = ledger();
  const t0 = Date.now();
  const res = await people[0].post('/api/rooms', { players: 4, variant: 'paulista', turnSeconds: 30 }, { headers: l.header });
  if (res.status !== 200) throw new Error(`/api/rooms ${res.status} ${res.text}`);
  const code = res.body.code as string;
  const conns: Conn[] = [];
  for (const p of people) {
    // People arrive at the lobby a little apart, as they do when a link goes round.
    await sleep(1_000);
    const c = await p.connect(code);
    await c.nextRoom((r) => r.you !== null);
    conns.push(c);
  }
  await conns[0].nextRoom((r) => r.room.seats.every((s) => s.kind === 'human' && s.connected));
  await sleep(2_000);
  conns[0].send({ t: 'start' });
  const moves = await Promise.all(conns.map((c, k) => playSeat(c, STYLES[(i + k) % STYLES.length], THINK_MS, mulberry32(SEED * 2000 + i * 10 + k))));
  const wallMs = Date.now() - t0;
  const { spent } = await settled(l.id);
  const hands = conns[0].game!.obs.handIndex + 1;
  await sleep(LINGER_MS);
  for (const c of conns) c.close();
  await sleep(500);
  const total = await expired(people[0], code, l.id, spent);
  return { kind: 'room4', style: 'mixed', thinkMedianMs: THINK_MS, hands, moves: moves.reduce((a, b) => a + b, 0), wallMs, spent, tail: minus(total, spent), total };
}

function mean(rs: Result[], f: (r: Result) => number): number {
  return rs.length ? rs.reduce((s, r) => s + f(r), 0) / rs.length : NaN;
}

async function main(): Promise<void> {
  if (!BASE) throw new Error('BASE is not set');
  const runs: Promise<Result>[] = [];
  for (let i = 0; i < SOLO; i++) runs.push(solo(i));
  for (let i = 0; i < ROOM4; i++) runs.push(room4(i));
  const results = await Promise.all(runs);
  const summary: Record<string, unknown> = { base: BASE, thinkMedianMs: THINK_MS, lingerMs: LINGER_MS, seed: SEED, at: new Date().toISOString() };
  const range = (rs: Result[], f: (r: Result) => number) => ({ min: Math.min(...rs.map(f)), mean: mean(rs, f), max: Math.max(...rs.map(f)) });
  for (const kind of ['solo', 'room4'] as const) {
    const rs = results.filter((r) => r.kind === kind);
    if (!rs.length) continue;
    const out: Record<string, unknown> = { matches: rs.length, hands: range(rs, (r) => r.hands), moves: range(rs, (r) => r.moves), wallSeconds: mean(rs, (r) => r.wallMs) / 1000 };
    for (const part of ['spent', 'tail', 'total'] as const) {
      const avg: Record<string, unknown> = {};
      for (const k of KEYS) avg[k] = range(rs, (r) => r[part][k]);
      avg.doGbSeconds = range(rs, (r) => r[part].doActiveMs / 8000);
      avg.invocations = range(rs, (r) => r[part].doRequests + r[part].doWsMessages);
      avg.activeMsPerInvocation = range(rs, (r) => r[part].doActiveMs / Math.max(1, r[part].doRequests + r[part].doWsMessages));
      out[part === 'spent' ? 'match' : part] = avg;
    }
    summary[kind] = out;
  }
  const out = { summary, results };
  console.log(JSON.stringify(out, null, 2));
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  }
}

await main();
