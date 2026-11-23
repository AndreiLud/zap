// Training rows of the human behaviour model (contract 3.11): for every decision of a person with
// weight above 0 (build.ts leaves out friends, unlinked and flagged seats, automatic moves and
// forced moves), what that person saw as features v1 and what they chose, in the network's
// canonical action space (cards by strength, not by slot), so the model can play as a NetAgent.
//
// Usage: node training/cycle/node/human/features.ts --records DIR --tables DIR --out DIR
//          [--exclude-groups FILE] [--max-rows N]
// Writes OUT/human-x.f32 (rows of 431 float32), OUT/human-y.u8 (canonical action),
// OUT/human-mask.u16 (canonical legal mask), OUT/human-meta.jsonl ({group, type, w}, one per row).
// With more candidate rows than --max-rows, a stable hash of (match, decision) keeps a share of them.
// Prints one JSON line: {rows, groups, matches, skipped, sampledShare}.

import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strengthTable } from '../../../../engine/src/cards.ts';
import { encoderFor, NUM_FEATURES, toCanonical, toCanonicalAction } from '../../../../ai/src/features.ts';
import { forEachDecision } from '../replay.ts';
import { arg, decisionRows, fnv1a, loadRecord, readGroupSet, readRecordLines } from './tables.ts';

export interface FeatureSummary {
  rows: number;
  groups: number;
  matches: number;
  skipped: number;
  sampledShare: number;
}

interface Want {
  group: string;
  type: string;
  w: number;
}

export async function writeFeatures(opts: { records: string; tables: string; out: string; exclude?: Set<string>; maxRows?: number }): Promise<FeatureSummary> {
  const exclude = opts.exclude ?? new Set<string>();
  const lines = readRecordLines(opts.tables);
  const wanted = new Map<number, Map<number, Want>>();
  let candidates = 0;
  for await (const d of decisionRows(opts.tables)) {
    if (!(d.w > 0) || d.group === null || exclude.has(d.group)) continue;
    let m = wanted.get(d.m);
    if (!m) wanted.set(d.m, (m = new Map()));
    m.set(d.i, { group: d.group, type: d.type, w: d.w });
    candidates++;
  }
  const maxRows = opts.maxRows ?? Infinity;
  const share = candidates > maxRows ? maxRows / candidates : 1;
  const cut = Math.floor(share * 0x100000000);

  mkdirSync(opts.out, { recursive: true });
  const fx = openSync(join(opts.out, 'human-x.f32'), 'w');
  const ys: number[] = [];
  const masks: number[] = [];
  const meta: string[] = [];
  const groups = new Set<string>();
  const enc = encoderFor({ features: 'v1', inputs: NUM_FEATURES });
  const CHUNK = 1024;
  const buf = new Float32Array(CHUNK * enc.size);
  let filled = 0;
  const flush = () => {
    if (filled) writeSync(fx, new Uint8Array(buf.buffer, 0, filled * enc.size * 4));
    filled = 0;
  };
  let skipped = 0;
  let matches = 0;
  try {
    for (const m of [...wanted.keys()].sort((a, b) => a - b)) {
      const line = lines[m];
      const want = wanted.get(m)!;
      if (!line) {
        skipped += want.size;
        continue;
      }
      const rec = loadRecord(opts.records, line.key);
      let used = false;
      forEachDecision(rec, (obs, i, _seat, action) => {
        const wnt = want.get(i);
        if (!wnt) return;
        if (share < 1 && fnv1a(`${rec.matchId}:${i}`) >= cut) return;
        const canonical = toCanonical(obs, strengthTable(obs.variant, obs.manilhaRank));
        const y = toCanonicalAction(action, canonical);
        if (y < 0 || (canonical.mask & (1 << y)) === 0) {
          skipped++;
          return;
        }
        enc.encode(obs, buf.subarray(filled * enc.size, (filled + 1) * enc.size), undefined, 'empty');
        if (++filled === CHUNK) flush();
        ys.push(y);
        masks.push(canonical.mask);
        meta.push(JSON.stringify({ group: wnt.group, type: wnt.type, w: wnt.w }));
        groups.add(wnt.group);
        used = true;
      });
      if (used) matches++;
    }
    flush();
  } finally {
    closeSync(fx);
  }
  writeFileSync(join(opts.out, 'human-y.u8'), Uint8Array.from(ys));
  writeFileSync(join(opts.out, 'human-mask.u16'), new Uint8Array(Uint16Array.from(masks).buffer));
  writeFileSync(join(opts.out, 'human-meta.jsonl'), meta.length ? meta.join('\n') + '\n' : '');
  return { rows: ys.length, groups: groups.size, matches, skipped, sampledShare: Math.round(share * 1e6) / 1e6 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = arg('records');
  const tables = arg('tables');
  const out = arg('out');
  if (!records || !tables || !out) {
    console.error('usage: features.ts --records DIR --tables DIR --out DIR [--exclude-groups FILE] [--max-rows N]');
    process.exit(1);
  }
  const max = arg('max-rows');
  const summary = await writeFeatures({ records, tables, out, exclude: readGroupSet(arg('exclude-groups')), maxRows: max ? Number(max) : undefined });
  console.log(JSON.stringify(summary));
}
