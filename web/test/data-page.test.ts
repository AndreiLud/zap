// The data page's part 1 and reading section (DATA-SPEC 4.0 to 4.5): the pure pieces behind the
// figures, run on the generated files, and the claims of _local/m6/claims.md that the reading
// section's words depend on. Every number checked here is read from facts-view.json, never typed.

import { describe, expect, it } from 'vitest';
import { budget } from '../../ai/src/safety.ts';
import { baseFinding, curveTitle, evidenceTitle, explorerTitle, floorTitle, gainTitle, headToHeadTitle, readingCurveTitle } from '../src/data/findings.ts';
import { CURVE, DERIVED, READING, SERVED, allVerdicts, lineage, storyVersion, summaryFrom, type CurveRow } from '../src/data/load.ts';
import { storyRows } from '../src/data/parts/Curve.tsx';
import { firstSearch, floorOf, parseExplorer, readingByHand, switchPoint } from '../src/data/parts/Reading.tsx';
import { DEFAULT_HANDS, simulate } from '../src/data/parts/ReadingSimulator.tsx';
import { F, textFor } from './data-text.ts';

const pt = textFor('pt');
const fv = (m: { mean: number; ci95: [number, number] }) => ({ mean: m.mean, lo: m.ci95[0], hi: m.ci95[1] });

describe('the training lineage (F2, F3)', () => {
  const row = (version: string, from: string | null, offset: number, snapshot: number, steps: number[]): CurveRow =>
    ({ version, from, offset, snapshot, points: steps.map((step) => ({ step, mean: 0.5, half95: 0.02, iteration: step - offset - 1, phase: 'selfplay' })) }) as unknown as CurveRow;
  const rows = [row('v1', null, 0, 150, [20, 140, 160, 300]), row('v2', 'v1', 150, 390, [170, 530])];

  it('follows `from` back to the first version', () => {
    expect(lineage(rows, 'v2').map((r) => r.version)).toEqual(['v1', 'v2']);
    expect(lineage(rows, 'v1').map((r) => r.version)).toEqual(['v1']);
    expect(lineage(rows, 'heuristic')).toEqual([]);
    expect(storyVersion(rows, 'heuristic')).toBe('v2');
  });

  it('cuts a parent at the step its child started from, and puts each snapshot on the lineage axis', () => {
    const parts = storyRows(lineage(rows, 'v2'));
    expect(parts[0].points.map((p) => p.step)).toEqual([20, 140]);
    expect(parts[1].points.map((p) => p.step)).toEqual([170, 530]);
    expect(parts.map((p) => p.snapshotStep)).toEqual([150, 540]);
  });

  it('the generated curve tells the served version from its lineage start, or the newest curve while the served version has none', () => {
    const story = storyVersion(CURVE.rows, SERVED.version);
    const parts = storyRows(lineage(CURVE.rows, story));
    // A version the cycle promoted has no curve until tools/data/sources.json names its run; the
    // chapter then tells the newest curve without naming a version in play (data.curve.read0).
    const hasCurve = CURVE.rows.some((r) => r.version === SERVED.version);
    expect(story).toBe(hasCurve ? SERVED.version : CURVE.rows.at(-1)?.version);
    expect(parts.at(-1)?.row.version).toBe(story);
    const all = parts.flatMap((p) => p.points);
    // Steps grow along the lineage; the title is one of the curve variants.
    expect(all.every((p, i) => i === 0 || p.step > all[i - 1].step)).toBe(true);
    expect(curveTitle(all.map((p) => ({ iteration: p.step, mean: p.mean, half95: p.half95 })), F.pt).key).toMatch(/^data\.curve\.h\./);
  });
});

describe('the reading explainer (F5)', () => {
  it('starts at the population value and moves toward what was seen, by (K + alpha p) / (H + alpha)', () => {
    const net = { bmax: 0.5, nHalf: 1 };
    const s = simulate([true, false, true], 2, 0.6, net);
    expect(s.map((x) => x.h)).toEqual([0, 1, 2, 3]);
    expect(s[0]).toEqual({ h: 0, k: 0, raw: null, read: 0.6, room: 0 });
    expect(s[1].read).toBeCloseTo((1 + 1.2) / 3, 12);
    expect(s[3].raw).toBeCloseTo(2 / 3, 12);
    expect(s[3].read).toBeCloseTo((2 + 1.2) / 5, 12);
    // Nothing may move without evidence; half of the cap at nHalf.
    expect(s[1].room).toBeCloseTo(budget(1, net) / net.bmax, 12);
    expect(s[1].room).toBeCloseTo(0.5, 12);
    expect(simulate([false, false], 2, 0.6, null).every((x) => x.room === null)).toBe(true);
  });

  it('runs on the facts: alpha, the paulista 1 against 1 prior and the safety net', () => {
    expect(READING.design && READING.priors).toBeTruthy();
    const p = READING.priors!.segments['paulista-2'].raise;
    const s = simulate(DEFAULT_HANDS, READING.design!.alpha, p, READING.safetyNet);
    const last = s.at(-1)!;
    expect(last.h).toBe(DEFAULT_HANDS.length);
    expect(last.k).toBe(DEFAULT_HANDS.filter(Boolean).length);
    // The reading sits between the prior and the raw share.
    expect(last.read).toBeGreaterThanOrEqual(Math.min(p, last.raw!) - 1e-12);
    expect(last.read).toBeLessThanOrEqual(Math.max(p, last.raw!) + 1e-12);
  });
});

describe('the reading by hand of the match (F7)', () => {
  it('weights the styles by their decisions and keeps the extremes', () => {
    const rows = readingByHand({
      a: { bet: { '1': { changedShare: 0, meanN: 0, decisions: 100 }, '2': { changedShare: 0.02, meanN: 1, decisions: 100 } } },
      b: { bet: { '1': { changedShare: 0, meanN: 0, decisions: 300 }, '2': { changedShare: 0.06, meanN: 2, decisions: 300 } } },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].mean).toBeCloseTo((0.02 * 100 + 0.06 * 300) / 400, 12);
    expect(rows[1].meanN).toBeCloseTo((100 + 600) / 400, 12);
    expect(rows[1].lo).toEqual({ id: 'a', v: 0.02 });
    expect(rows[1].hi).toEqual({ id: 'b', v: 0.06 });
    expect(rows[1].decisions).toBe(400);
  });

  it('on the facts, the first hand changes nothing', () => {
    const rows = readingByHand(READING.readingCurve!.styles);
    expect(rows[0].hand).toBe(1);
    expect(rows[0].mean).toBe(0);
    expect(rows.at(-1)!.hand).toBe(10);
  });
});

describe('the explorer label', () => {
  it('reads a>b@k/partner and the evidence trigger', () => {
    expect(parseExplorer('trapper>bluffer@3/v1')).toEqual({ a: 'trapper', b: 'bluffer', k: 3, trigger: 'hand', partner: 'v1' });
    expect(parseExplorer('rock>runsAll@e4/same')).toEqual({ a: 'rock', b: 'runsAll', k: 4, trigger: 'evidence', partner: 'same' });
    expect(parseExplorer('training/runs/m6-explorer/explorer.zapw')).toBeNull();
  });

  // ai/src/styles.ts switches when handIndex (from 0) reaches k: k = 3 plays three hands, then bluffs
  // from hand 4, which is how F7 numbers hands. Evidence is counted as it is.
  const words = (lang: 'pt' | 'en', label: string) => {
    const e = parseExplorer(label)!;
    const s = switchPoint(e.k, e.trigger);
    return textFor(lang)(s.key, { k: F[lang].int(s.k) });
  };

  it('a hand trigger names the first hand of the new style, counted from 1', () => {
    expect(words('pt', 'trapper>bluffer@3/v1')).toBe('na mão 4');
    expect(words('en', 'trapper>bluffer@3/v1')).toBe('at hand 4');
  });

  it('an evidence trigger names the evidence as counted', () => {
    expect(words('pt', 'a>b@e4/v1')).toBe('depois de mostrar 4 provas');
    expect(words('en', 'a>b@e4/v1')).toBe('after showing 4 pieces of evidence');
  });
});

describe('the summary answer', () => {
  it('404 is no summary yet; anything but a summary is unavailable', () => {
    expect(summaryFrom(404, null)).toEqual({ kind: 'none' });
    expect(summaryFrom(503, null)).toEqual({ kind: 'unavailable' });
    expect(summaryFrom(200, { schema: 'zap-summary/9', versions: [], training: {} })).toEqual({ kind: 'unavailable' });
  });
});

// _local/m6/claims.md: the words of the reading section follow these facts.
describe('the reading section says what the facts support', () => {
  const ex = READING.explorer!;
  const c = ex.criterion!;
  const verdicts = allVerdicts(c);

  it('the titles speak of the test version exactly when the served version does not read', () => {
    const reads = SERVED.readsOpponents;
    const test = (key: string) => key.split('.').includes('test');
    const f = F.pt;
    expect(test(evidenceTitle({ nHalf: READING.safetyNet!.nHalf, reads }, f).key)).toBe(!reads);
    const rows = readingByHand(READING.readingCurve!.styles);
    for (const r of [false, true]) {
      expect(test(readingCurveTitle({ values: rows.map((x) => x.mean), decisions: rows.map((x) => x.decisions), reads: r }, f).key)).toBe(!r);
      expect(test(gainTitle({ est: fv(READING.perStyle!.pooled.allStyles.gainVsAblated), reads: r }, f).key)).toBe(!r);
    }
  });

  it('what reading adds is the same network with and without it (claim 5), not the gain over the twin', () => {
    const all = READING.perStyle!.pooled.allStyles;
    expect(all.gainVsAblated.mean).toBeLessThan(all.gainVsTwin.mean);
    const title = gainTitle({ est: fv(all.gainVsAblated), reads: false }, F.pt);
    expect(pt(title.key, title.vars)).toContain(F.pt.per100(all.gainVsAblated.mean));
    expect(pt(title.key, title.vars)).not.toContain(F.pt.per100(all.gainVsTwin.mean));
  });

  it('the explorer verdict follows the criterion, with the largest upper bound among every explorer judged (claim 9)', () => {
    const worst = [...verdicts].sort((a, b) => (b.adaptationPart.upper95 ?? b.adaptationPart.ci95[1]) - (a.adaptationPart.upper95 ?? a.adaptationPart.ci95[1]))[0];
    const upper = worst.adaptationPart.upper95 ?? worst.adaptationPart.ci95[1];
    const title = explorerTitle({ pass: c.pass, upper95: upper, mean: worst.adaptationPart.mean, requirement: c.requirement, reads: SERVED.readsOpponents, n: verdicts.length }, F.pt);
    expect(title.key).toBe(c.pass ? (upper <= 0 ? 'data.read.f9.h.passNone' : 'data.read.f9.h.pass') : 'data.read.f9.h.fail');
    // A failing bound never reads as the limit (claim 9: 1.046 against 1).
    if (!c.pass) expect(String(title.vars.up)).not.toBe(String(title.vars.lim));
    // The older rule: count the explorers aimed at the reading network that fail it (the control is apart).
    const aimed = verdicts.filter((v) => v !== c.verdicts.control);
    expect(aimed.filter((v) => !v.passTwinRule).length).toBeLessThanOrEqual(aimed.length);
    expect(verdicts.filter((v) => !v.pass).length > 0).toBe(!c.pass);
  });

  it('the gap to the twin comes with the reading part, and the head to head on the same file says whether it is stronger (claim 6)', () => {
    const all = READING.perStyle!.pooled.allStyles;
    // The twin of this test is the fine-tuned twin, not the file in play: never "the version that plays today".
    expect(DERIVED.twinServed).toBe(false);
    // The second twin trained for fewer iterations, so it is no seed floor and the title cannot say "mostly chance".
    const iters = READING.perStyle!.twinIterations!;
    expect(iters.twin).not.toBe(iters.twin2);
    expect(floorOf()).toBeUndefined();
    expect(floorTitle({ twin: fv(all.gainVsTwin), read: fv(all.gainVsAblated), rest: fv(all.ablatedVsTwin), floor: null }).key).toBe('data.read.floor.h');
    // Head to head against its twin the test version is not stronger, and the title says so with its share.
    expect(DERIVED.headToHeadJudged).toBe(true);
    const h2h = READING.headToHead!.rows['adaptive-twin'];
    const title = headToHeadTitle(fv(h2h), F.pt);
    expect(title.key).toBe('data.read.floor.h.notAhead');
    expect(pt(title.key, title.vars)).toContain(F.pt.pct(h2h.mean, 1));
  });

  it('the trained explorer trained against the judged file and the reading costs it; the control comparison says it is less clean (claims 9 and 13)', () => {
    expect(ex.trained!.training!.against!.adapt.bmax).toBe(c.servedModel!.adapt.bmax);
    expect(c.verdicts.trained!.adaptationPart.upper95!).toBeLessThan(0);
    expect(DERIVED.controlJudged).toBe(true);
    expect(DERIVED.controlTrainedOnServed).toBe(true);
    expect(DERIVED.controlMeasuredOnOwn).toBe(false);
    expect(baseFinding(fv(ex.control!.fresh.asServed), F.pt).key).toBe('data.read.f9.base.more');
    // The old rule changed after search 1, which later attempts measured again on this file.
    expect(firstSearch(ex)).toBe(1);
    expect(DERIVED.evidenceModel).toBe('v1');
  });
});
