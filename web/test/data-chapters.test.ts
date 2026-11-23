// The data of the plan's four chapters (DATA-SPEC 4.6 to 4.9, WP6): web/src/data/parts/chapter-data.ts
// on fixtures, and the titles the chapters show for the generated files and facts-view.json as
// they stand, checked against _local/m6/claims.md (what the page may say about the AI).

import { describe, expect, it } from 'vitest';
import type { SummaryV2 } from '../../shared/cycle-formats.ts';
import { ladderOf, makeConfig, onzeRunPoints, onzeThreshold, onzeValue } from '../../engine/src/config.ts';
import * as find from '../src/data/findings.ts';
import factsView from '../src/data/generated/facts-view.json' with { type: 'json' };
import sim from '../src/data/generated/sim.json' with { type: 'json' };
import rules from '../src/data/generated/cycle-rules.json' with { type: 'json' };
import {
  answerTitle,
  breakEvenGrid,
  characterSet,
  historyItems,
  layerStates,
  modeRows,
  modesTitle,
  reachableScores,
  RIVALS,
  servedVersion,
  summaryOf,
  twinRows,
  typesAverage,
  variantCells,
  versionSeries,
  versionStrengths,
  weekSeries,
  weeksTitle,
  type FactsView,
  type Thresholds,
} from '../src/data/parts/chapter-data.ts';
import { F, plain } from './data-text.ts';

const FV = factsView as unknown as FactsView;
const TH = rules.thresholds as unknown as Thresholds;
const CAST = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];

/** A summary with every field empty; tests fill what they need. */
function summary(over: Partial<SummaryV2> = {}): SummaryV2 {
  const layer = { on: false, why: 'x', progress: {} as Record<string, number | null> };
  return {
    schema: 'zap-summary/2',
    generatedAt: Date.UTC(2026, 11, 4),
    minPeople: 20,
    training: { state: 'ok', finishedAt: null, current: 'v2', nextAfter: null },
    humansVsZap: { matches: 0, humanWins: 0, since: null },
    versions: [],
    ab: null,
    layers: { humanModel: layer, priors: layer, adaptation: layer, playerTypes: layer, ranking: layer, openData: layer, flags: layer },
    cells: [],
    playerTypes: null,
    seedNoise: null,
    scoreboard: [],
    disagreements: null,
    ...over,
  } as SummaryV2;
}

const anchors = (m: number) => ({ random: { mean: m + 0.2, lo: m + 0.19, hi: m + 0.21 }, base: { mean: m, lo: m - 0.01, hi: m + 0.01 }, tuned: { mean: m + 0.1, lo: m + 0.09, hi: m + 0.11 }, v1: { mean: m - 0.1, lo: m - 0.11, hi: m - 0.09 } });

describe('run time inputs', () => {
  it('reads the summary only when it is ready', () => {
    expect(summaryOf({ kind: 'loading' })).toBeNull();
    expect(summaryOf({ kind: 'none' })).toBeNull();
    expect(summaryOf({ kind: 'unavailable' })).toBeNull();
    const s = summary();
    expect(summaryOf({ kind: 'ready', summary: s })).toBe(s);
  });

  it('takes the version in play from /api/live only when it is a version label', () => {
    expect(servedVersion('v3', 'v2')).toBe('v3');
    expect(servedVersion('heuristic', 'v2')).toBe('v2');
    expect(servedVersion(null, 'v2')).toBe('v2');
  });
});

describe('F15 the break even grid', () => {
  const scores = (variant: 'paulista' | 'mineiro') => {
    const c = makeConfig(variant, 4);
    return reachableScores([...ladderOf(c), onzeValue(c), onzeRunPoints(c)], onzeThreshold(c));
  };

  it('keeps every paulista score and only the even mineiro scores', () => {
    expect(scores('paulista')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(scores('mineiro')).toEqual([0, 2, 4, 6, 8]);
  });

  it('picks the cells of the reachable scores, your score first', () => {
    const grid = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
    ];
    expect(breakEvenGrid(grid, [0, 2])).toEqual([
      [0.1, 0.3],
      [0.7, 0.9],
    ]);
  });

  it('gives the paulista title from the simulated outcomes', () => {
    const grid = breakEvenGrid(sim.game['paulista-4'].breakEven, scores('paulista'));
    const found = find.breakEvenTitle(grid, F.pt)!;
    expect(plain(find.say(F.pt, found.title))).toMatch(/^No 0 a 0, aceite o truco com \d+% de chance de ganhar a mão ou mais\.$/);
  });
});

describe('F16 strength by version', () => {
  it('reads v1 and v2 from facts.json, never a version against itself', () => {
    const v = versionStrengths(FV, null);
    expect(v.map((x) => x.version)).toEqual(['v1', 'v2']);
    expect(v[0].rows.v1).toBeUndefined();
    expect(Object.keys(v[1].rows).sort()).toEqual([...RIVALS].sort());
    expect(v[1].source).toBe('facts');
    expect(v[1].pairs).toBe(4000);
  });

  it('adds the versions the summary promotes, and keeps facts.json for the ones it measured', () => {
    const s = summary({
      versions: [
        { version: 'v2', promotedAt: 1, result: 'promoted', anchors: anchors(0.5), twin: null, personas: null, data: null },
        { version: 'v3', promotedAt: 2, result: 'promoted', anchors: anchors(0.8), twin: null, personas: null, data: null },
      ],
    });
    const v = versionStrengths(FV, s);
    expect(v.map((x) => x.version)).toEqual(['v1', 'v2', 'v3']);
    expect(v[1].source).toBe('facts');
    expect(v[2].source).toBe('summary');
    expect(v[2].rows.heuristic?.mean).toBe(0.8);
  });

  it('colors the version in play, then the newest other, and quiets the rest', () => {
    const m = versionSeries(['v1', 'v2', 'v3', 'v4'], 'v3');
    expect(m.get('v3')).toEqual({ series: 1, shape: 'circle', labeled: true });
    expect(m.get('v4')).toEqual({ series: 2, shape: 'square', labeled: true });
    expect(m.get('v2')).toEqual({ series: 0, shape: 'diamond', labeled: true });
    expect(m.get('v1')?.labeled).toBe(false);
  });

  it('says what claims.md 1 allows: v2 beats v1 in about 7 of 10 games', () => {
    const v2 = versionStrengths(FV, null).find((x) => x.version === 'v2')!;
    const rows = RIVALS.flatMap((r) => (v2.rows[r] ? [{ id: r, est: v2.rows[r]! }] : []));
    expect(plain(find.say(F.pt, find.rivalsTitleVersions({ version: 'v2', rows }, F.pt)!))).toBe('A versão em jogo, v2, vence 7 de cada 10 partidas contra a v1.');
    expect(plain(find.say(F.en, find.rivalsTitleVersions({ version: 'v2', rows }, F.en)!))).toBe('The version in play, v2, wins 7 out of 10 games against v1.');
  });
});

describe('F17 people against Zap', () => {
  const s = summary({
    scoreboard: [
      { variant: 'paulista', players: 2, aiVersion: 'v3', partnerVersion: null, people: 22, matches: 400, humanWins: 200 },
      { variant: 'mineiro', players: 4, aiVersion: 'v3', partnerVersion: 'v2', people: 31, matches: 400, humanWins: 80 },
    ],
  });

  it('names the mode where people win most only when its interval is apart', () => {
    const rows = modeRows(s);
    expect(rows.map((r) => r.key)).toEqual(['paulista-2-v3-solo', 'mineiro-4-v3-v2']);
    const top = modesTitle(rows);
    expect(top.key).toBe('data.f17.modes.h.top');
    expect(top.row?.variant).toBe('paulista');
    const close = modeRows(summary({ scoreboard: s.scoreboard.map((r) => ({ ...r, humanWins: 100 + (r.players === 2 ? 4 : 0) })) }));
    expect(modesTitle(close).key).toBe('data.f17.modes.h.same');
    expect(modesTitle(rows.slice(0, 1)).key).toBe('data.f17.modes.h.one');
  });

  it('draws weeks by mode and calls a change only when the first and last weeks are apart', () => {
    const cell = (week: string, rate: number) => ({ week, variant: 'paulista' as const, players: 2 as const, people: 25, matches: 500, humanWinRate: rate });
    const up = summary({ cells: [cell('2026-W47', 0.2), cell('2026-W48', 0.25), cell('2026-W49', 0.4)] });
    const w = weekSeries(up);
    expect(w.weeks).toEqual(['2026-W47', '2026-W48', '2026-W49']);
    expect(w.series[0].points.map((p) => p.wins)).toEqual([100, 125, 200]);
    expect(weeksTitle(w.series, w.weeks)).toBe('data.f17.weeks.h.up');
    const flat = weekSeries(summary({ cells: [cell('2026-W47', 0.3), cell('2026-W48', 0.31), cell('2026-W49', 0.31)] }));
    expect(weeksTitle(flat.series, flat.weeks)).toBe('data.f17.weeks.h.same');
  });
});

describe('F18 and F19', () => {
  it('lists only versions trained with people that have a twin comparison', () => {
    const s = summary({
      versions: [
        { version: 'v2', promotedAt: 1, result: 'promoted', anchors: null, twin: { pairs: 400, mean: 0.5, lo: 0.47, hi: 0.53 }, personas: null, data: null },
        { version: 'v3', promotedAt: 2, result: 'promoted', anchors: null, twin: { pairs: 2000, mean: 0.52, lo: 0.505, hi: 0.535 }, personas: null, data: { validMatches: 1100, people: null } },
      ],
    });
    const rows = twinRows(s);
    expect(rows.map((r) => r.version)).toEqual(['v3']);
    expect(find.twinTitle({ version: 'v3', est: rows[0].est }).key).toBe('data.f18.h.up');
    expect(find.twinTitle(null).key).toBe('data.f18.empty');
  });

  it('builds the history from facts.json alone: v2 promoted and in play, v1 initial', () => {
    const items = historyItems(FV, null, 'v2');
    expect(items.map((i) => [i.version, i.result, i.inPlay])).toEqual([
      ['v2', 'promoted', true],
      ['v1', 'bootstrap', false],
    ]);
    expect(items[0].date).toBe(Date.parse(FV.ai.releases.v2!.date));
    expect(items[1].date).toBe(Date.parse(FV.ai.bootstrapModel.previous!.createdAt));
    expect(items.every((i) => i.data === null && i.tuned !== null)).toBe(true);
    expect(plain(find.say(F.pt, find.historyTitle(items, F.pt)))).toBe('2 versões até hoje.');
  });

  it('joins the summary: a newer version, its data and its window with people', () => {
    const ab = { version: 'v3', control: 'v2', share: 0.3, from: 5, until: 9, detectablePoints: null, result: null };
    const s = summary({ ab, versions: [{ version: 'v3', promotedAt: 7, result: 'promoted', anchors: anchors(0.8), twin: null, personas: null, data: { validMatches: 1100, people: 64 } }] });
    const items = historyItems(FV, s, 'v3');
    expect(items.map((i) => i.version)).toEqual(['v3', 'v2', 'v1']);
    expect(items[0]).toMatchObject({ date: 7, ab, inPlay: true, data: { validMatches: 1100, people: 64 } });
    expect(items[0].tuned?.mean).toBeCloseTo(0.9);
  });
});

describe('F21 the answer view', () => {
  const cell = (n: number, p: number) => ({ n, p });
  it('says the higher bet makes Zap run less only when the two steps are apart', () => {
    expect(answerTitle([[cell(1000, 0.3), cell(400, 0.5), cell(300, 0.8), cell(250, 0.9)]])).toBe('data.f21.h.answer.more');
    expect(answerTitle([[cell(1000, 0.6), cell(400, 0.5), cell(300, 0.3), cell(250, 0.2)]])).toBe('data.f21.h.answer.less');
    expect(answerTitle([[cell(1000, 0.5), cell(400, 0.5), cell(300, 0.5), cell(250, 0.51)]])).toBe('data.f21.h.answer.same');
    expect(answerTitle([[cell(1000, 0.3), cell(10, 0.9), cell(10, 0.9), cell(10, 0.9)]])).toBe('data.f21.h.answer.same');
  });
});

describe('F22 the characters', () => {
  it('reads v2 from facts.json: the fresh deals of the gate (claims.md 10), Zap last', () => {
    const set = characterSet(FV, null, 'v2', false, CAST)!;
    expect(set.source).toBe('facts');
    expect(set.chars.map((c) => c.id)).toEqual(CAST);
    const fresh = FV.ai.personasByVersion.v2!.freshCheck!.vsZap;
    for (const c of set.chars) expect(c.vsZap).toEqual({ mean: fresh[c.id]!.mean, lo: fresh[c.id]!.ci95[0], hi: fresh[c.id]!.ci95[1] });
    expect(set.chars.every((c) => c.rates !== null && !c.bound)).toBe(true);
  });

  it('names Iara as the closest to Zap and no order among Bento, Lia and Ravi', () => {
    const set = characterSet(FV, null, 'v2', false, CAST)!;
    const names: Record<string, string> = { otavio: 'Otávio', bento: 'Bento', lia: 'Lia', ravi: 'Ravi', iara: 'Iara' };
    const chars = set.chars.filter((c) => c.id !== 'zap').map((c) => ({ name: names[c.id], est: c.vsZap! }));
    const found = find.charactersTitle({ chars, control: set.chars.find((c) => c.id === 'zap')!.vsZap }, F.pt)!;
    const title = plain(find.say(F.pt, found.title));
    expect(title).toBe('Iara é quem mais chega perto do Zap.');
    expect(title).not.toMatch(/Bento|Lia|Ravi/);
  });

  it('takes the score against Zap of the adaptive check only while reading is on', () => {
    const on = characterSet(FV, null, 'v2', true, CAST)!;
    expect(on.source).toBe(FV.ai.adaptation?.switchOnCheck?.personas?.freshCheck ? 'adaptive' : 'facts');
  });

  it('prefers the version card in the summary, with a margin bound', () => {
    const s = summary({
      versions: [
        {
          version: 'v3',
          promotedAt: 3,
          result: 'promoted',
          anchors: null,
          twin: null,
          personas: { pairs: 1600, stats: { zap: { trucoRate: 0.4, bluffRate: 0.1, runRate: 0.3, reraiseRate: 0.05, signalTruth: 0.9, vsZap: 0.5 } } },
          data: null,
        },
      ],
    });
    const set = characterSet(FV, s, 'v3', false, CAST)!;
    expect(set.source).toBe('summary');
    const zap = set.chars.find((c) => c.id === 'zap')!;
    expect(zap.bound).toBe(true);
    expect(zap.vsZap!.hi - zap.vsZap!.mean).toBeCloseTo(1.96 * Math.sqrt(0.25 / 1600));
    expect(set.chars.find((c) => c.id === 'otavio')!.vsZap).toBeNull();
    expect(characterSet(FV, null, 'v9', false, CAST)).toBeNull();
  });
});

describe('F24 to F27, the people chapter', () => {
  it('fills each meter from the layer progress and the cycle thresholds', () => {
    const none = layerStates(null, TH);
    expect(none.map((l) => l.key)).toEqual(['humanModel', 'priors', 'playerTypes', 'ranking', 'openData']);
    expect(none.every((l) => !l.on && l.meters.every((m) => m.value === null))).toBe(true);
    expect(none[0].meters.map((m) => m.needed)).toEqual([TH.human_model_matches, TH.human_model_devices]);
    const ranking = none.find((l) => l.key === 'ranking')!;
    expect(ranking.each).toEqual({ people: TH.ranking_people, matches: TH.ranking_matches_each });
    expect(ranking.meters[0].needed).toBe(TH.ranking_people * TH.ranking_matches_each);

    const s = summary();
    s.layers.humanModel = { on: false, why: 'x', progress: { matches: 120, matchesNeeded: 600, people: null, peopleNeeded: 70 } };
    s.layers.priors = { on: true, why: 'x', progress: { people: 140, peopleNeeded: 100 } };
    const got = layerStates(s, TH);
    expect(got[0].meters).toEqual([
      { unit: 'matches', value: 120, needed: 600 },
      { unit: 'people', value: null, needed: 70 },
    ]);
    expect(got[1]).toMatchObject({ on: true, meters: [{ unit: 'people', value: 140, needed: 100 }] });
    expect(find.layersTitle({ on: got.filter((l) => l.on).length, total: got.length }, F.pt).key).toBe('data.f24.h.some');
  });

  it("averages the types in logit space and keeps accept as 1 minus run and reraise", () => {
    const center = (v: number) => ({ raise: v, run: 0.3, accept: 0.6, reraise: 0.1, shown: v, cover: v, bluff: v, signalTruth: v });
    const avg = typesAverage([
      { share: 0.5, center: center(0.2) },
      { share: 0.5, center: center(0.8) },
    ]);
    expect(avg.raise).toBeCloseTo(0.5);
    expect(avg.run).toBeCloseTo(0.3);
    expect(avg.accept).toBeCloseTo(0.6);
  });

  it('pools the cells over weeks by variant and table size', () => {
    const s = summary({
      cells: [
        { week: '2026-W47', variant: 'paulista', players: 2, people: 25, matches: 100, humanWinRate: 0.333 },
        { week: '2026-W48', variant: 'paulista', players: 2, people: 25, matches: 200, humanWinRate: 0.5 },
        { week: '2026-W48', variant: 'mineiro', players: 4, people: 25, matches: 300, humanWinRate: 0.2 },
      ],
    });
    const v = variantCells(s);
    expect(v.paulista.two).toEqual({ wins: 133, n: 300 });
    expect(v.paulista.four).toBeNull();
    expect(v.mineiro.all).toEqual({ wins: 60, n: 300 });
    expect(find.variantsTitle({ paulista: v.paulista.all, mineiro: v.mineiro.all, min: 20 }, F.pt).key).toBe('data.f27.h.paulista');
  });
});
