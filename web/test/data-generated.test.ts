// The generated files of the data page (DATA-SPEC 2.1, WP1), in web/src/data/generated/. The cheap
// ones are made again here from their inputs and must match the files byte for byte in their data
// (the time, machine and command of the run aside), so a change in facts.json, the engine's deck,
// a training run or the cycle's config fails this test until the file is made again. The slow
// simulation is checked by its provenance: it must name the story model of tools/data/sources.json
// with that file's current hash, the seed and the sizes of sources.json.

import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeConfig, MAX_STEP } from '../../engine/src/config.ts';
import { A_RAISE, A_RUN, A_SIGNAL0, replay, teamOf } from '../../engine/src/engine.ts';
import { isSafetyNet } from '../../ai/src/safety.ts';
import { defaultOutcomes } from '../../ai/src/winprob.ts';
import { buildCycleRules, type CycleRules } from '../../tools/data/cycle-rules.ts';
import { buildCurve, curveInputs, type Curve, type Headline } from '../../tools/data/curve.ts';
import { buildExact, type Exact } from '../../tools/data/exact.ts';
import { buildFactsView, type FactsView } from '../../tools/data/facts-view.ts';
import { servedView } from '../../tools/docs/releases.ts';
import { factsForPages } from '../../tools/data/page-keys.ts';
import { characterSet, historyItems, versionStrengths, type FactsView as ChapterFacts } from '../src/data/parts/chapter-data.ts';
import { anchorBook } from '../src/you-vs-zap/rating.ts';
import { breakEvenTable } from '../../tools/data/lib/outcomes.ts';
import { abs, readGenerated, readJson, sha256File, stable, type Provenance } from '../../tools/data/lib/provenance.ts';
import { readSources } from '../../tools/data/lib/sources.ts';
import { REPLAY_KINDS, SEGMENTS, segmentConfig } from '../../tools/data/sim-worker.ts';
import type { ReplaysFile, SimFile } from '../../tools/data/simulate.ts';

const sources = readSources();
const file = <T>(name: string): T => {
  const f = readGenerated<T>(name);
  if (!f) throw new Error(`web/src/data/generated/${name} is missing: run the scripts of tools/data/`);
  return f;
};
/** Each file is read when a test first needs it, so a missing file fails only its own tests. */
const lazy = <T>(name: string): (() => T) => {
  let v: T | undefined;
  return () => (v ??= file<T>(name));
};
const facts = lazy<FactsView>('facts-view.json');
const exact = lazy<Exact>('exact.json');
const curve = lazy<Curve>('curve.json');
const headline = lazy<Headline>('headline.json');
const rules = lazy<CycleRules>('cycle-rules.json');
const sim = lazy<SimFile>('sim.json');
const replays = lazy<ReplaysFile>('replays.json');
const runsPresent = curveInputs().every((p) => existsSync(abs(p)));

function checkProvenance(p: Provenance): void {
  expect(typeof p.script).toBe('string');
  expect(p.command).toContain(p.script);
  expect(Number.isNaN(Date.parse(p.measuredAt))).toBe(false);
  expect(p.node).toMatch(/^v\d+/);
  expect(typeof p.cpu).toBe('string');
  expect(p.inputs.length).toBeGreaterThan(0);
  for (const i of p.inputs) expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
}

describe('generated files of the data page', () => {
  it('every file but headline.json starts with its provenance', () => {
    for (const f of [facts(), exact(), curve(), rules(), sim(), replays()] as { provenance: Provenance }[]) {
      expect(Object.keys(f)[0]).toBe('provenance');
      checkProvenance(f.provenance);
    }
    // headline.json is imported by the entry chunk: version keys only, its provenance is curve.json's.
    expect(curve().provenance.outputs).toContain('web/src/data/generated/headline.json');
    for (const v of Object.values(headline())) expect(Object.keys(v)).toEqual(['trainingHands']);
  });
});

describe('facts-view.json', () => {
  it('matches facts.json as it is now', () => {
    expect(stable(facts())).toEqual(stable(buildFactsView()));
  });

  it('describes the story model and what is served', () => {
    expect(facts().model.version).toBe(sources.storyModel.version);
    expect(facts().model.sha256).toBe(sha256File(sources.storyModel.path));
    expect(facts().model.weights).toBeGreaterThan(facts().model.inputs * facts().model.hidden[0]);
    const boot = facts().ai.bootstrapModel as { version: string; sha256: string };
    // The story model is the version the site serves; when it changes, sources.json and the simulation follow.
    expect(boot.version).toBe(sources.storyModel.version);
    expect(boot.sha256).toBe(facts().model.sha256);
    // The version in play: the bundled model, or the cycle's version recorded in ai.inPlay
    // (tools/docs/record-release.ts); it reads under GET /api/live's rule on the file in play.
    const raw = readJson<Record<string, unknown>>('facts.json');
    const inPlay = servedView(raw);
    expect(facts().served.version).toBe(inPlay.version);
    const file = (inPlay.cycle ?? facts().ai.bootstrapModel) as { features: string; adapt: unknown };
    expect(facts().served.readsOpponents).toBe(facts().served.AI_ADAPT === 'on' && file.features === 'v2' && isSafetyNet(file.adapt));
  });

  it('lists every key it could not find, and only those', () => {
    const at = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], facts() as unknown);
    for (const p of facts().missing) expect(at(p)).toBeNull();
  });

  it('leaves out the verdicts the page must not build a claim on', () => {
    const explorer = (facts().ai.adaptation as Record<string, Record<string, unknown>>).explorer;
    expect('pass' in explorer).toBe(false);
    expect(typeof (explorer.criterion as { pass: unknown }).pass).toBe('boolean');
    const seedCheck = (facts().ai.adaptation as Record<string, Record<string, Record<string, unknown>>>).perStyle.seedCheck;
    expect('exceedsSeedFloor' in seedCheck).toBe(false);
  });
});

describe('facts-view.json in the bundle (tools/data/page-keys.ts)', () => {
  it('keeps every key the pages read: the page functions answer the same on the trimmed copy', () => {
    const full = facts() as unknown as ChapterFacts & Record<string, unknown>;
    const page = factsForPages(full) as typeof full;
    const cast = ['otavio', 'bento', 'lia', 'ravi', 'iara', 'zap'];
    expect(versionStrengths(page, null)).toEqual(versionStrengths(full, null));
    for (const v of ['v1', 'v2']) {
      expect(historyItems(page, null, v)).toEqual(historyItems(full, null, v));
      for (const reads of [false, true]) expect(characterSet(page, null, v, reads, cast)).toEqual(characterSet(full, null, v, reads, cast));
    }
    const books = [anchorBook(page as never, null), anchorBook(full as never, null)];
    for (const v of ['v1', 'v2'])
      for (const size of [1, 2] as const) {
        expect(books[0].cast(v, size)).toEqual(books[1].cast(v, size));
        expect(books[0].seat('zap', v, size)).toEqual(books[1].seat('zap', v, size));
      }
    // The reading section and part 1 read these blocks whole (web/src/data/load.ts ReadingFacts, Learned, Cycle).
    const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | null | undefined)?.[k], o);
    // The style gains as the page reads them: the reading part with its count, the twin columns with
    // their interval, and the pooled rows without their one sided bound.
    type Gain = { mean: number; ci95: number[]; pairs: number };
    type Styles = Record<string, { gainVsAblated: Gain; gainVsTwin: Gain; ablatedVsTwin: Gain; heldOut: boolean }>;
    const span = (g: Gain) => ({ mean: g.mean, ci95: g.ci95 });
    const interval = (g: Gain) => ({ ...span(g), pairs: g.pairs });
    const fullStyles = at(full, 'ai.adaptation.perStyle.styles') as Styles;
    expect(at(page, 'ai.adaptation.perStyle.styles')).toEqual(
      Object.fromEntries(Object.entries(fullStyles).map(([k, s]) => [k, { gainVsAblated: interval(s.gainVsAblated), gainVsTwin: span(s.gainVsTwin), ablatedVsTwin: span(s.ablatedVsTwin), heldOut: s.heldOut }])),
    );
    const fullPooled = at(full, 'ai.adaptation.perStyle.pooled.allStyles') as Record<string, Gain>;
    expect(at(page, 'ai.adaptation.perStyle.pooled.allStyles')).toEqual(Object.fromEntries(Object.entries(fullPooled).map(([k, g]) => [k, interval(g)])));
    for (const path of [
      'model.version',
      'model.features',
      'model.inputs',
      'model.hidden',
      'model.bytes',
      'model.weights',
      'served.version',
      'served.readsOpponents',
      'derived.twinServed',
      'derived.evidenceModel',
      'derived.headToHeadJudged',
      'derived.controlJudged',
      'derived.controlMeasuredOnOwn',
      'cycle',
      'ai.decisionTime.decisionMs.p50',
      'ai.bootstrapModel.version',
      'ai.adaptation.design.alpha',
      'ai.adaptation.priors.segments.paulista-2.raise',
      'ai.adaptation.evidence.pooled',
      'ai.adaptation.evidence.nW',
      'ai.adaptation.safetyNet.nHalf',
      'ai.adaptation.readingCurve.styles',
      'ai.adaptation.explorer.requirement',
      'ai.adaptation.explorer.grid.size',
      'ai.adaptation.explorer.criterion',
      'ai.adaptation.perStyle.twinIterations',
      'ai.adaptation.headToHead.rows.adaptive-twin.mean',
      'ai.adaptation.headToHead.rows.adaptive-twin.ci95',
      'ai.adaptation.explorer.control.fresh.asServed',
      'ai.adaptation.explorer.criterion.verdicts.otherTrained.0.adaptationPart.upper95',
      'ai.adaptation.explorer.criterion.verdicts.otherTrained.0.trainedAgainst',
      'ai.adaptation.explorer.trained.training.against',
    ]) {
      const want = at(full, path);
      const got = at(page, path);
      if (path === 'ai.adaptation.explorer.criterion') {
        // Every field of a verdict the page reads, for every explorer judged.
        const c = got as { pass: unknown; requirement: unknown; verdicts: { scripted: { explorers: unknown[] }[] } };
        const w = want as typeof c;
        expect(c.pass).toEqual(w.pass);
        expect(c.requirement).toEqual(w.requirement);
        expect(c.verdicts.scripted.length).toBe(w.verdicts.scripted.length);
      } else expect(got, path).toEqual(want);
    }
  });

  it('is smaller than the file on disk', () => {
    const size = (x: unknown) => gzipSync(JSON.stringify(x), { level: 9 }).length;
    expect(size(factsForPages(facts()))).toBeLessThan(size(facts()) * 0.7);
  });
});

describe('exact.json', () => {
  it('matches the engine', () => {
    expect(stable(exact())).toEqual(stable(buildExact()));
  });

  it('holds the check values of DATA-SPEC 2.1.2', () => {
    expect(exact().manilha.paulista.atLeastOne).toBe(0.2838);
    expect(exact().manilha.mineiro.atLeastOne).toBe(0.2773);
    expect(exact().manilha.paulista.team).toBe(0.5025);
    expect(exact().manilha.mineiro.team).toBe(0.4925);
  });

  it('shares add up', () => {
    for (const v of ['paulista', 'mineiro'] as const) {
      const m = exact().manilha[v];
      expect(m.p0 + m.p1 + m.p2 + m.p3).toBeCloseTo(1, 3);
      expect(exact().cards[v]).toHaveLength(14);
      for (const c of exact().cards[v]) expect(c.beats + c.ties + c.loses).toBeCloseTo(1, 3);
      expect(exact().cards[v][13]).toEqual({ beats: 1, ties: 0, loses: 0 });
      for (let k = 1; k < 14; k++) expect(exact().cards[v][k].beats).toBeGreaterThan(exact().cards[v][k - 1].beats);
    }
    expect(exact().rankLabels[9]).toBe('3');
  });
});

describe('curve.json and headline.json', () => {
  it.skipIf(!runsPresent)('match the training runs of sources.json', () => {
    const made = buildCurve();
    expect(stable(curve())).toEqual(stable(made.curve));
    expect(headline()).toEqual(made.headline);
  });

  it('agree with each other and with sources.json', () => {
    expect(curve().rows.map((r) => r.version)).toEqual(sources.curve.map((r) => r.version));
    for (const r of curve().rows) {
      expect(headline()[r.version]).toEqual({ trainingHands: r.hands });
      const parent = curve().rows.find((p) => p.version === r.from);
      expect(r.offset).toBe(parent ? parent.offset + parent.snapshot : 0);
      if (parent) expect(r.hands).toBeGreaterThan(parent.hands);
      for (const p of r.points) {
        expect(p.step).toBe(r.offset + p.iteration + 1);
        expect(p.half95).toBeCloseTo(1.96 * Math.sqrt((p.mean * (1 - p.mean)) / r.pairs), 3);
      }
    }
  });
});

describe('cycle-rules.json', () => {
  it('matches training/cycle/config/prod.toml', () => {
    expect(stable(rules())).toEqual(stable(buildCycleRules()));
    expect(rules().gate.p1).toBeGreaterThan(rules().gate.p0);
    expect(rules().MIN_PEOPLE).toBeGreaterThan(0);
  });
});

describe('sim.json and replays.json', () => {
  it('were made with the story model and the settings of sources.json', () => {
    const p = sim().provenance as Provenance & { seed: string; sizes: Record<string, number>; model: Record<string, string> };
    expect(p.model.version).toBe(sources.storyModel.version);
    expect(p.model.path).toBe(sources.storyModel.path);
    expect(p.model.sha256).toBe(sha256File(sources.storyModel.path));
    expect(p.model.manifestSha256).toBe(sha256File(sources.storyModel.manifest));
    expect(p.model.stats).toBe(sources.storyModel.stats);
    expect(p.seed).toBe(sources.sim.seed);
    expect(p.sizes).toEqual({ matchesPerSegment: sources.sim.matchesPerSegment, personaMatchesPerSegment: sources.sim.personaMatchesPerSegment });
    expect(replays().provenance).toEqual(sim().provenance);
  });

  it('count what they say', () => {
    expect(sim().segments).toEqual([...SEGMENTS]);
    let normal = 0;
    for (const seg of SEGMENTS) {
      const g = sim().game[seg];
      expect(g.matches).toBe(sources.sim.matchesPerSegment);
      expect(g.handByBestCard).toHaveLength(14);
      expect(g.handByBestCard.reduce((t, c) => t + c.n, 0)).toBe(g.normalHands);
      expect(g.firstPlayer.n).toBe(g.normalHands);
      normal += g.normalHands;
    }
    expect(sim().normalHands).toBe(normal);
    expect(sim().play.matchesPerPersona).toBe(4 * sources.sim.personaMatchesPerSegment);
  });

  it('breakEven follows from the fitted outcomes', () => {
    SEGMENTS.forEach((seg, g) => {
      const config = segmentConfig(g);
      const made = breakEvenTable(config, sim().game[seg].outcomes);
      const stored = sim().game[seg].breakEven;
      expect(stored).toHaveLength(made.length);
      made.forEach((row, a) => row.forEach((x, b) => expect(Math.abs(stored[a][b] - x)).toBeLessThan(2e-3)));
    });
  });

  it('the replays rebuild with the engine and show what their name says', () => {
    expect(replays().replays.map((r) => r.id)).toEqual([...REPLAY_KINDS]);
    for (const r of replays().replays) {
      const s = replay(r.config, r.seed, r.log);
      expect(s.history.length).toBe(r.handIndex + 1);
      const hand = s.history[r.handIndex];
      expect(r.actions[r.actions.length - 1].i).toBe(r.log.length - 1);
      for (const a of r.actions) {
        expect(r.log[a.i]).toBe(a.seat * 16 + a.action);
        if (a.chance !== null) expect(a.chance).toBeGreaterThanOrEqual(0);
      }
      if (r.id === 'virada') {
        expect(hand.result.winner).toBeGreaterThanOrEqual(0);
        expect(hand.rounds[0].result).toBe(1 - hand.result.winner);
      }
      if (r.id === 'blefe') {
        const j = r.actions.findIndex((a) => a.i === r.detail.at);
        expect(r.actions[j]).toMatchObject({ seat: r.detail.seat, action: A_RAISE });
        const answer = r.actions.slice(j + 1).find((a) => a.action < A_SIGNAL0);
        expect(answer?.action).toBe(A_RUN);
        expect(teamOf(answer!.seat)).not.toBe(teamOf(r.detail.seat));
        expect(r.detail.estimate).toBeLessThan(0.25);
      }
      if (r.id === 'doze') expect(hand.step).toBe(MAX_STEP);
      if (r.id === 'onze') {
        expect(hand.kind).toBe('onze');
        expect(hand.result.winner).toBe(hand.onzeTeam);
      }
    }
  });

  it('replays.json fits its 12 KB budget (DATA-SPEC 1.3)', () => {
    expect(gzipSync(JSON.stringify(replays()), { level: 9 }).length).toBeLessThanOrEqual(12_000);
  });
});

describe('the break-even formula (DATA-SPEC 4.6, F15)', () => {
  it('gives 0.343 at 0 to 0 in paulista 1 against 1 with the default outcome model', () => {
    const config = makeConfig('paulista', 2);
    expect(breakEvenTable(config, defaultOutcomes(config))[0][0]).toBeCloseTo(0.343, 3);
  });
});
