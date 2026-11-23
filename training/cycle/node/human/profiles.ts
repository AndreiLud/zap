// Style counters per person for the human layers (contract 3.11): shared/profile.ts profileCounts
// for every counted seat, summed per group (one person in the latest export) and per group and
// segment; the population priors fitted with fitPriors, the bundled default as fallback; and each
// person's reading under the fitted priors (for player types and the open data style figures).
//
// A seat counts when it is linked (has a group), its weight is above 0, it is not flagged, the
// person did not ask "Don't adapt to me" (no profile is kept for them), the match is not between
// friends, and the group is not in --exclude-groups (flags found in this cycle).
//
// Usage: node training/cycle/node/human/profiles.ts --records DIR --tables DIR --out DIR
//          --fallback FILE --min-people N --now MS [--exclude-groups FILE]
// Writes OUT/priors.json (zap-priors/1), OUT/readings.jsonl ({group, matches, decisions, shown,
// values}), and prints one JSON line {groups, people, source, seats}.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePriorsFile } from '../../../../shared/cycle-formats.ts';
import { addCounts, emptyProfile, fitPriors, profileCounts, readProfile, type PersonCounts, type ProfilePriors } from '../../../../shared/profile.ts';
import { arg, loadRecord, readGroupSet, readRecordLines, type HumanSeat, type RecordLine } from './tables.ts';

/** One person (a group of the export): the total and the counters per segment. */
export type GroupProfile = PersonCounts;

/** Whether a person's seat counts towards profiles (rules in the file comment). */
export function counts(line: RecordLine, h: HumanSeat, exclude: Set<string>): boolean {
  return line.kind !== 'friends' && h.group !== null && (h.weight ?? 0) > 0 && !h.flagged && !h.noAdapt && !exclude.has(h.group);
}

export function groupProfiles(records: string, lines: RecordLine[], exclude: Set<string>): { groups: Map<string, GroupProfile>; seats: number } {
  const groups = new Map<string, GroupProfile>();
  let seats = 0;
  for (const line of lines) {
    const take = new Map(line.humans.filter((h) => counts(line, h, exclude)).map((h) => [h.seat, h.group!]));
    if (take.size === 0) continue;
    const rec = loadRecord(records, line.key);
    for (const { seat, segment, counts: c } of profileCounts(rec)) {
      const g = take.get(seat);
      if (g === undefined) continue;
      seats++;
      let p = groups.get(g);
      if (!p) groups.set(g, (p = { total: emptyProfile(), perSegment: {} }));
      p.total = addCounts(p.total, c);
      p.perSegment[segment] = addCounts(p.perSegment[segment] ?? emptyProfile(), c);
    }
  }
  return { groups, seats };
}

export function fitFromGroups(groups: Map<string, GroupProfile>, fallback: ProfilePriors, minPeople: number, now: number): ProfilePriors {
  const fitted = fitPriors([...groups.values()], fallback, minPeople);
  fitted.createdAt = now;
  const v = validatePriorsFile(fitted);
  if (!v.ok) throw new Error(`fitted priors are not valid: ${v.errors.slice(0, 3).join('; ')}`);
  return fitted;
}

export interface ReadingLine {
  group: string;
  matches: number;
  decisions: number;
  /** Every one of the 8 numbers is shown (10 observations and an 80% interval narrower than 30 points). */
  shown: boolean;
  /** Posterior means in READING_KEYS order (3 decimals), null when that number is not shown. */
  values: (number | null)[];
  /** The population value of each number at this person's mix of rules segments (3 decimals). */
  population: number[];
}

export function readings(groups: Map<string, GroupProfile>, priors: ProfilePriors): ReadingLine[] {
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, g]) => {
      const r = readProfile(g.total, priors, { perSegment: g.perSegment });
      return { group, matches: g.total.matches, decisions: g.total.D, shown: r.numbers.every((n) => n.shown), values: r.numbers.map((n) => n.value), population: r.numbers.map((n) => n.population) };
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = arg('records');
  const tables = arg('tables');
  const out = arg('out');
  const fallbackFile = arg('fallback');
  if (!records || !tables || !out || !fallbackFile) {
    console.error('usage: profiles.ts --records DIR --tables DIR --out DIR --fallback FILE --min-people N --now MS [--exclude-groups FILE]');
    process.exit(1);
  }
  const fallback = validatePriorsFile(JSON.parse(readFileSync(fallbackFile, 'utf8')));
  if (!fallback.ok) throw new Error(`fallback priors are not valid: ${fallback.errors[0]}`);
  const { groups, seats } = groupProfiles(records, readRecordLines(tables), readGroupSet(arg('exclude-groups')));
  const priors = fitFromGroups(groups, fallback.value, Number(arg('min-people') ?? 100), Number(arg('now') ?? Date.now()));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'priors.json'), JSON.stringify(priors, null, 2) + '\n');
  writeFileSync(join(out, 'readings.jsonl'), readings(groups, priors).map((r) => JSON.stringify(r) + '\n').join(''));
  console.log(JSON.stringify({ groups: groups.size, people: priors.people, source: priors.source, seats }));
}
