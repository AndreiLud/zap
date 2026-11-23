// Checks of the local end to end proof (tests/sim/cycle-e2e.sh) on the match records a local site
// wrote, as the bridge mirrored them (.cache/bridge/<state>/events/matches/). Each check prints one
// JSON line and exits 1 when a rule fails.
//
//   window --state dev --from MS --to MS --candidate vX --control vY
//        records that started in the window, during an A/B test: quick play in both arms, the
//        candidate only on opponent seats, a person's AI partner always the control version, the
//        control share of quick play near the manifest's share
//   window --state dev --from MS --to MS --version vZ
//        no test: every AI seat plays vZ, no arm
//   served --state dev --after MS --ttl-ms N --version vX
//        how long after the manifest reached the site the first match with vX started, and that
//        no match started later than the cache time with the previous version
//   pinned --state dev --sim FILE --after MS --ttl-ms N --old vY --new vX
//        the match of the sim output FILE started before the manifest changed and ended after
//        other matches had started on vX, and every one of its AI seats played vY

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRecord, validateMatchRecord, type MatchRecord } from '../../shared/match-record.ts';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.json') ? [p] : [];
  });
}

export function loadRecords(state: string): MatchRecord[] {
  const out: MatchRecord[] = [];
  for (const f of files(join('.cache', 'bridge', state, 'events', 'matches'))) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (j.schema !== 'zap-match/2') continue;
    out.push(normalizeRecord(j));
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

const SOLO = new Set(['solo1', 'solo2']);

/** Problems of one record against the A/B rules of contract 2.3 (empty when it follows them). */
export function abProblems(r: MatchRecord, candidate: string, control: string): string[] {
  const p: string[] = [];
  if (r.test !== true) p.push('not marked test');
  const solo = SOLO.has(r.kind);
  if (solo) {
    if (r.arm === 'control' && (r.aiVersion !== control || r.partnerVersion !== control)) p.push('control arm with other versions');
    if (r.arm === 'candidate' && (r.aiVersion !== candidate || r.partnerVersion !== control)) p.push('candidate arm with other versions');
    if (r.arm === null) p.push('quick play without an arm during the test');
  } else if (r.arm !== null || r.aiVersion !== candidate || r.partnerVersion !== control) p.push('friends match with an arm or other versions');
  const humans = new Set(r.seats.flatMap((s, i) => (s.kind === 'human' ? [i] : [])));
  r.seats.forEach((s, i) => {
    if (s.kind !== 'ai') return;
    const partnerHuman = r.config.players === 4 && humans.has(i ^ 2);
    if (partnerHuman && s.aiVersion !== control) p.push(`seat ${i} is a person's partner and played ${s.aiVersion}`);
    if (!partnerHuman && s.aiVersion !== r.aiVersion) p.push(`opponent seat ${i} played ${s.aiVersion}, not ${r.aiVersion}`);
  });
  return p;
}

/** Wilson 95% interval of a share. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function versionsOf(r: MatchRecord): string[] {
  return [...new Set(r.seats.flatMap((s) => (s.kind === 'ai' && s.aiVersion ? [s.aiVersion] : [])))].sort();
}

function done(ok: boolean, out: Record<string, unknown>): never {
  console.log(JSON.stringify({ ok, ...out }));
  process.exit(ok ? 0 : 1);
}

function main(): void {
  const cmd = process.argv[2];
  const state = arg('state', 'dev');
  const recs = loadRecords(state);
  if (cmd === 'window') {
    const from = Number(arg('from'));
    const to = Number(arg('to', String(Date.now())));
    const inWin = recs.filter((r) => r.startedAt >= from && r.startedAt < to);
    const invalid = inWin.filter((r) => !validateMatchRecord(r).ok).map((r) => r.matchId);
    const kinds: Record<string, number> = {};
    for (const r of inWin) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    const version = arg('version');
    if (version) {
      const bad = inWin.filter((r) => r.arm !== null || r.aiVersion !== version || r.partnerVersion !== version || versionsOf(r).some((v) => v !== version) || r.test !== true);
      done(inWin.length > 0 && bad.length === 0 && invalid.length === 0, { check: 'window', version, records: inWin.length, kinds, invalid, problems: bad.map((r) => r.matchId).slice(0, 5) });
    }
    const candidate = arg('candidate');
    const control = arg('control');
    const problems = inWin.flatMap((r) => abProblems(r, candidate, control).map((p) => `${r.matchId.slice(0, 8)}: ${p}`));
    const solo = inWin.filter((r) => SOLO.has(r.kind));
    const arms = { candidate: solo.filter((r) => r.arm === 'candidate').length, control: solo.filter((r) => r.arm === 'control').length };
    const share = solo.length ? arms.control / solo.length : 0;
    const [lo, hi] = wilson(arms.control, solo.length);
    // Partner seats: AI seats next to a person in four player matches.
    let partnerSeats = 0;
    let candidateOnPartner = 0;
    let candidateOnOpponent = 0;
    for (const r of inWin) {
      const humans = new Set(r.seats.flatMap((s, i) => (s.kind === 'human' ? [i] : [])));
      r.seats.forEach((s, i) => {
        if (s.kind !== 'ai') return;
        const partnerHuman = r.config.players === 4 && humans.has(i ^ 2);
        if (partnerHuman) partnerSeats++;
        if (partnerHuman && s.aiVersion === candidate) candidateOnPartner++;
        if (!partnerHuman && s.aiVersion === candidate) candidateOnOpponent++;
      });
    }
    // The share check allows 4.5 binomial standard deviations around 30%, as the unit test of 10,000 draws does.
    const share0 = Number(arg('share', '0.3'));
    const withinShare = Math.abs(arms.control - share0 * solo.length) <= 4.5 * Math.sqrt(solo.length * share0 * (1 - share0));
    const ok = inWin.length > 0 && problems.length === 0 && invalid.length === 0 && arms.candidate > 0 && arms.control > 0 && candidateOnPartner === 0 && withinShare;
    done(ok, {
      check: 'window',
      candidate,
      control,
      records: inWin.length,
      kinds,
      arms,
      controlShare: Math.round(share * 1000) / 1000,
      controlShare95: [Math.round(lo * 1000) / 1000, Math.round(hi * 1000) / 1000],
      partnerSeats,
      candidateOnPartner,
      candidateOnOpponent,
      invalid,
      problems: problems.slice(0, 8),
    });
  }
  if (cmd === 'served') {
    const after = Number(arg('after'));
    const ttl = Number(arg('ttl-ms', '5000'));
    const version = arg('version');
    const later = recs.filter((r) => r.startedAt >= after);
    const first = later.find((r) => versionsOf(r).includes(version) || r.aiVersion === version);
    // A match on the new manifest: quick play has an arm during a test (the control arm plays the
    // previous version on purpose), any other match plays the new version on its opponent seats.
    const onNew = (r: MatchRecord) => (SOLO.has(r.kind) ? r.arm !== null || r.aiVersion === version : r.aiVersion === version);
    const stale = later.filter((r) => r.startedAt > after + ttl && !onNew(r));
    done(first !== undefined && stale.length === 0, {
      check: 'served',
      version,
      firstMatchStartedAfterMs: first ? first.startedAt - after : null,
      matchesStartedAfter: later.length,
      startedAfterCacheTimeOnOldManifest: stale.map((r) => r.matchId).slice(0, 5),
    });
  }
  if (cmd === 'pinned') {
    const sim = JSON.parse(readFileSync(arg('sim'), 'utf8')) as { matchIds: string[] };
    const after = Number(arg('after'));
    const ttl = Number(arg('ttl-ms', '5000'));
    const oldV = arg('old');
    const newV = arg('new');
    const r = recs.find((x) => x.matchId === sim.matchIds[0]);
    if (!r) done(false, { check: 'pinned', error: 'the long match has no record', id: sim.matchIds[0] ?? null });
    const overlapping = recs.filter((x) => x.matchId !== r.matchId && x.startedAt > after + ttl && x.startedAt < r.endedAt && (versionsOf(x).includes(newV) || x.aiVersion === newV));
    const ok = r.startedAt < after && r.endedAt > after + ttl && r.arm === null && r.aiVersion === oldV && r.partnerVersion === oldV && versionsOf(r).every((v) => v === oldV) && overlapping.length > 0;
    done(ok, {
      check: 'pinned',
      matchId: r.matchId,
      kind: r.kind,
      startedBeforeManifestMs: after - r.startedAt,
      endedAfterManifestMs: r.endedAt - after,
      aiVersion: r.aiVersion,
      partnerVersion: r.partnerVersion,
      arm: r.arm,
      seatVersions: r.seats.map((s) => s.aiVersion),
      matchesOnNewVersionDuringIt: overlapping.length,
    });
  }
  console.error('usage: check-records.ts window|served|pinned --state dev ...');
  process.exit(1);
}

if (process.argv[1]?.endsWith('check-records.ts')) main();
