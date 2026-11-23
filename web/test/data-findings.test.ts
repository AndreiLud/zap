// The data driven titles (DATA-SPEC 3.8): every variant from fixtures, in both languages, and with
// random inputs the rule that no title claims a direction its interval does not support. Fixture
// numbers are those of facts.json on 2026-11-23 where a figure reads them.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as find from '../src/data/findings.ts';
import type { Finding } from '../src/data/findings.ts';
import type { Est } from '../src/data/words.ts';
import { DICT, F, plain } from './data-text.ts';

const seen: Finding[] = [];
/** The title in a language; every finding goes through here so the last test can check them all. */
function say(x: Finding, lang: 'pt' | 'en' = 'pt'): string {
  seen.push(x);
  return plain(find.say(F[lang], x));
}

const est = (mean: number, lo: number, hi: number): Est => ({ mean, lo, hi });

/** Random estimates: lo <= mean <= hi inside [a, b]. */
const arbEst = (a: number, b: number) =>
  fc.tuple(fc.double({ min: a, max: b, noNaN: true }), fc.double({ min: a, max: b, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })).map(([x, y, w]) => {
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    return est(lo + w * (hi - lo), lo, hi);
  });

describe('cover', () => {
  it('says "now it learns from people" only after a promoted version trained with people', () => {
    expect(find.h1Title(null).key).toBe('data.h1.selfplay');
    expect(find.h1Title({ versions: [{ result: 'initial', data: null }] }).key).toBe('data.h1.selfplay');
    expect(find.h1Title({ versions: [{ result: 'rolledBack', data: { validMatches: 900 } }] }).key).toBe('data.h1.selfplay');
    expect(find.h1Title({ versions: [{ result: 'promoted', data: { validMatches: 900 } }] }).key).toBe('data.h1.people');
  });
});

describe('F3 curve', () => {
  const pt = (iteration: number, mean: number, half95 = 0.015) => ({ iteration, mean, half95 });
  it('fast then slow, fast then flat, steady, flat and fell', () => {
    const fastSlow = [pt(0, 0.44), pt(20, 0.6), pt(40, 0.7), pt(60, 0.73), pt(80, 0.76), pt(100, 0.79), pt(120, 0.81), pt(140, 0.83), pt(160, 0.85)];
    expect(say(find.curveTitle(fastSlow, F.pt))).toBe('Aprendeu rápido no começo. Depois subiu devagar.');
    const fastFlat = [pt(0, 0.44), pt(20, 0.7), pt(40, 0.8), pt(60, 0.8), pt(80, 0.805), pt(100, 0.8), pt(120, 0.81), pt(140, 0.8), pt(160, 0.805)];
    expect(find.curveTitle(fastFlat, F.pt).key).toBe('data.curve.h.fastThenFlat');
    const steady = [0, 20, 40, 60, 80, 100].map((i) => pt(i, 0.5 + i * 0.002));
    expect(say(find.curveTitle(steady, F.pt))).toBe('Subiu de 50% para 70% ao longo do treino.');
    expect(say(find.curveTitle(steady, F.en), 'en')).toBe('It climbed from 50% to 70% during training.');
    const flat = [pt(0, 0.5), pt(20, 0.51), pt(40, 0.505)];
    expect(find.curveTitle(flat, F.pt).key).toBe('data.curve.h.flat');
    const fell = [pt(0, 0.7), pt(20, 0.6), pt(40, 0.5)];
    expect(say(find.curveTitle(fell, F.pt))).toBe('Caiu de 70% para 50% ao longo do treino.');
  });
  it('never says it climbed when the two ends are within their margins', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double({ min: 0.3, max: 0.9, noNaN: true }), fc.double({ min: 0.001, max: 0.05, noNaN: true })), { minLength: 2, maxLength: 12 }), (rows) => {
        const pts = rows.map(([m, h], i) => pt(i * 20, m, h));
        const k = find.curveTitle(pts, F.pt).key;
        const first = pts[0];
        const last = pts[pts.length - 1];
        const noise = Math.hypot(first.half95, last.half95);
        if (k === 'data.curve.h.steady' || k === 'data.curve.h.fastThenSlow' || k === 'data.curve.h.fastThenFlat') expect(last.mean - first.mean).toBeGreaterThan(noise);
        if (k === 'data.curve.h.fell') expect(first.mean - last.mean).toBeGreaterThan(noise);
      }),
    );
  });
});

describe('F6 to F9, the reading', () => {
  it('F6 says half of the adjustment at nHalf, singular at 1, with the test version words when off', () => {
    expect(say(find.evidenceTitle({ nHalf: 1, reads: true }, F.pt))).toBe('Sem provas, o Zap não muda nada. Com 1 prova, já pode usar metade do ajuste.');
    expect(say(find.evidenceTitle({ nHalf: 2, reads: true }, F.pt))).toBe('Sem provas, o Zap não muda nada. Com 2 provas, pode usar metade do ajuste.');
    expect(say(find.evidenceTitle({ nHalf: 1, reads: false }, F.pt))).toBe('Na versão em teste, nada muda sem provas. Com 1 prova, ela já pode usar metade do ajuste.');
    expect(say(find.evidenceTitle({ nHalf: 2, reads: false }, F.en), 'en')).toBe(
      'In the test version, nothing changes without evidence. With 2 pieces of evidence, it may use half of its adjustment.',
    );
  });

  it('F7 grows only from nothing at hand 1 to more at hand 6 than at hand 2', () => {
    const grows = [0.001, 0.05, 0.08, 0.1, 0.11, 0.12, 0.12, 0.13, 0.13, 0.13];
    expect(say(find.readingCurveTitle({ values: grows, decisions: Array(10).fill(20000), reads: true }, F.pt))).toBe(
      'Na primeira mão o Zap não muda nada. Na 6ª, muda 12,0% das decisões de truco.',
    );
    expect(find.readingCurveTitle({ values: grows, reads: false }, F.pt).key).toBe('data.read.f7.h.grows.test');
    expect(find.readingCurveTitle({ values: [0.02, ...grows.slice(1)], reads: true }, F.pt).key).toBe('data.read.f7.h.flat');
    expect(find.readingCurveTitle({ values: [0.001, 0.1, 0.1, 0.1, 0.1, 0.09], reads: false }, F.pt).key).toBe('data.read.f7.h.flat.test');
  });

  it('F8 gain, loss and noise, on and off', () => {
    const pooled = est(0.00312, 0.00191, 0.00434);
    expect(say(find.gainTitle({ est: pooled, reads: true }, F.pt))).toBe('Ler o adversário rende 0,3 partida em cada 100 a mais.');
    expect(say(find.gainTitle({ est: pooled, reads: false }, F.pt))).toBe('Na versão em teste, ler o adversário rende 0,3 partida em cada 100 a mais.');
    expect(say(find.gainTitle({ est: pooled, reads: false }, F.en), 'en')).toBe('In the test version, reading the opponent brings 0.3 games in every 100 more.');
    expect(say(find.gainTitle({ est: est(-0.012, -0.02, -0.004), reads: true }, F.pt))).toBe('Até agora, ler o adversário custou 1,2 partida em cada 100.');
    expect(find.gainTitle({ est: est(-0.012, -0.02, -0.004), reads: false }, F.pt).key).toBe('data.read.f8.h.loss.test');
    expect(find.gainTitle({ est: est(0.001, -0.002, 0.004), reads: true }, F.pt).key).toBe('data.read.f8.h.noise');
    expect(find.gainTitle({ est: est(0.001, -0.002, 0.004), reads: false }, F.pt).key).toBe('data.read.f8.h.noise.test');
  });

  it('F8 never claims a gain or a loss its interval does not support', () => {
    fc.assert(
      fc.property(arbEst(-0.05, 0.05), fc.boolean(), (e, reads) => {
        const k = find.gainTitle({ est: e, reads }, F.pt).key;
        if (k.startsWith('data.read.f8.h.gain')) expect(e.lo).toBeGreaterThan(0);
        if (k.startsWith('data.read.f8.h.loss')) expect(e.hi).toBeLessThan(0);
        if (k.startsWith('data.read.f8.h.noise')) expect(e.lo <= 0 && e.hi >= 0).toBe(true);
        expect(k.endsWith('.test')).toBe(!reads);
      }),
    );
  });

  it('F9 pass, pass with nothing to gain, and the gap with reading off or on', () => {
    // The explorer of attempts 2 and 4 against the tighter net: reading part 0.79, one sided bound 1.046, limit 1 (claim 9).
    const gap = { pass: false, upper95: 0.01046, mean: 0.00794, requirement: 0.01, n: 9 };
    expect(say(find.explorerTitle({ ...gap, reads: false }, F.pt))).toBe(
      'O teste achou uma brecha: um explorador tira em média 0,8 partida em cada 100 da leitura e, contando a margem de erro, até 1,05. Passa do limite de 1, por isso a leitura segue desligada.',
    );
    expect(say(find.explorerTitle({ ...gap, reads: false }, F.en), 'en')).toBe(
      'The test found a gap: one explorer takes 0.8 games in every 100 from the reading on average and, counting the margin of error, up to 1.05. That is over the limit of 1, so reading stays off.',
    );
    expect(find.explorerTitle({ ...gap, reads: true }, F.pt).key).toBe('data.read.f9.h.failOn');
    expect(say(find.explorerTitle({ ...gap, mean: -0.0002, reads: false }, F.pt))).toBe(
      'O teste achou uma brecha: contando a margem de erro, um explorador pode tirar da leitura até 1,05 partida em cada 100. Passa do limite de 1, por isso a leitura segue desligada.',
    );
    expect(find.explorerTitle({ ...gap, mean: -0.0002, reads: true }, F.pt).key).toBe('data.read.f9.h.failOn.bound');
    expect(say(find.explorerTitle({ pass: true, upper95: 0.0072, mean: 0.004, requirement: 0.01, reads: true, n: 9 }, F.pt))).toBe('Nenhum dos 9 exploradores medidos tira mais de 0,7 partida em cada 100 da leitura, contando a margem de erro.');
    expect(say(find.explorerTitle({ pass: true, upper95: -0.0007, mean: -0.004, requirement: 0.01, reads: true, n: 9 }, F.en), 'en')).toBe(
      'None of the 9 explorers we measured gets anything out of the reading, counting the margin of error.',
    );
  });

  it('F9 says "nothing" only when even the upper bound is at or below zero', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.double({ min: -0.02, max: 0.03, noNaN: true }), fc.double({ min: -0.02, max: 0.02, noNaN: true }), fc.boolean(), (pass, up, mean, reads) => {
        const k = find.explorerTitle({ pass, upper95: up, mean, requirement: 0.01, reads, n: 9 }, F.pt).key;
        if (k === 'data.read.f9.h.passNone') expect(up).toBeLessThanOrEqual(0);
        if (k.startsWith('data.read.f9.h.fail') && !k.startsWith('data.read.f9.h.failOn')) expect(reads).toBe(false);
        if (!pass) expect(k.startsWith('data.read.f9.h.fail')).toBe(true);
      }),
    );
  });

  it('F9 never shows a bound as the limit unless it is the limit (claim 9: 1.046 is "1,05", not "1")', () => {
    expect(find.boundNumber(F.pt, 0.01046, 0.01)).toBe('1,05');
    expect(find.boundNumber(F.pt, 0.0100001, 0.01)).toBe('1,01');
    expect(find.boundNumber(F.pt, 0.0099999, 0.01)).toBe('0,99');
    expect(find.boundNumber(F.pt, 0.01, 0.01)).toBe('1');
    expect(find.boundNumber(F.pt, 0.00769, 0.01, true)).toBe('+0,8');
    expect(find.boundNumber(F.pt, -0.00147, 0.01, true)).toBe(`${'−'}0,1`);
    fc.assert(
      fc.property(fc.double({ min: -0.02, max: 0.04, noNaN: true }), (v) => {
        const shown = find.boundNumber(F.en, v, 0.01);
        if (v !== 0.01) expect(shown).not.toBe('1');
        if (v > 0.01) expect(Number(shown.replace('−', '-'))).toBeGreaterThan(1);
        if (v < 0.01) expect(Number(shown.replace('−', '-'))).toBeLessThan(1);
      }),
    );
  });

  it('under F8, "mostly chance" only when the reading part is small and the rest sits within the seed floor (claim 6)', () => {
    // perStyle.pooled.allStyles: gain over the twin 1.20, reading part 0.25, reading off against the twin 0.95, second twin 0.80.
    const twin = est(0.012, 0.0096, 0.0143);
    const read = est(0.0025, 0.0013, 0.0036);
    const rest = est(0.0095, 0.0071, 0.0118);
    const floor = est(0.008, 0.0056, 0.0104);
    expect(say(find.floorTitle({ twin, read, rest, floor }))).toBe('A maior parte da diferença para a gêmea é acaso entre dois treinos.');
    expect(find.floorTitle({ twin, read, rest, floor: est(0.001, -0.001, 0.003) }).key).toBe('data.read.floor.h');
    expect(find.floorTitle({ twin, read: est(0.008, 0.007, 0.009), rest, floor }).key).toBe('data.read.floor.h');
    expect(find.floorTitle({ twin, read, rest, floor: null }).key).toBe('data.read.floor.h');
  });

  it('under F8, head to head against the twin: "beats" only when the whole interval is above even', () => {
    // ai.adaptation.headToHead.rows.adaptive-twin on 2026-11-23: 49.1% (from 48.3% to 49.9%).
    const h2h = est(0.49113, 0.48287, 0.49938);
    expect(say(find.headToHeadTitle(h2h, F.pt))).toBe('No confronto direto, a rede que lê não é mais forte que a gêmea: vence 49,1% das partidas (de 48,3% a 49,9%).');
    expect(say(find.headToHeadTitle(h2h, F.en), 'en')).toBe('Head to head, the reading network is not stronger than its twin: it wins 49.1% of the games (from 48.3% to 49.9%).');
    expect(say(find.headToHeadTitle(est(0.52, 0.51, 0.53), F.pt))).toBe('No confronto direto, a rede que lê vence a gêmea: 52% das partidas (de 51% a 53%).');
    expect(find.headToHeadTitle(est(0.501, 0.493, 0.509), F.pt).key).toBe('data.read.floor.h.notAhead');
    fc.assert(
      fc.property(arbEst(0.4, 0.6), (e) => {
        const k = find.headToHeadTitle(e, F.pt).key;
        expect(k === 'data.read.floor.h.ahead').toBe(e.lo > 0.5);
      }),
    );
  });

  it('under F9, the control explorer: "easier to exploit" only when the whole interval is above zero', () => {
    // ai.adaptation.explorer.control.fresh.asServed on 2026-11-23: 3.44 (from 2.60 to 4.29) games per 100.
    const diff = est(0.03444, 0.026, 0.04287);
    expect(say(find.baseFinding(diff, F.pt))).toBe('Fora da regra: um explorador treinado contra a rede que lê tira dela 3,4 partidas em cada 100 a mais (de 2,6 a 4,3 partidas em cada 100) do que o controle tira da gêmea. Por essa medida, a base dela é mais fácil de explorar.');
    expect(say(find.baseFinding(diff, F.en), 'en')).toBe('Outside the rule: an explorer trained against the reading network takes 3.4 games in every 100 more from it (from 2.6 to 4.3 games in every 100) than the control takes from the twin. By this measure its base is easier to exploit.');
    expect(say(find.baseFinding(est(-0.0151, -0.0234, -0.0068), F.pt))).toBe('Fora da regra: um explorador treinado contra a rede que lê não tira dela mais do que o controle tira da gêmea (de −2,3 a −0,7 partidas em cada 100).');
    expect(find.baseFinding(est(0.0058, -0.0023, 0.0138), F.pt).key).toBe('data.read.f9.base.notMore');
    fc.assert(
      fc.property(arbEst(-0.05, 0.05), (e) => {
        expect(find.baseFinding(e, F.pt).key === 'data.read.f9.base.more').toBe(e.lo > 0);
      }),
    );
  });
});

describe('chapter 1, the game in numbers', () => {
  it('F10 almost 3 in 10 hands; half or both team values', () => {
    const exact = { paulista: { atLeastOne: 0.2838, team: 0.5025 }, mineiro: { atLeastOne: 0.2773, team: 0.4925 } };
    expect(say(find.manilhaTitle(exact, F.pt))).toBe('Quase 3 de cada 10 mãos têm manilha. Em dupla, 50,3% no paulista e 49,3% no mineiro.');
    expect(say(find.manilhaTitle({ paulista: { atLeastOne: 0.3, team: 0.501 }, mineiro: { atLeastOne: 0.27, team: 0.499 } }, F.en), 'en')).toBe(
      '3 out of 10 hands hold a manilha. As a team, half.',
    );
  });

  it('F11 the 3 and the floor of the manilhas, strictly below the smallest', () => {
    const beats = [0.0, 0.03, 0.12, 0.2, 0.3, 0.38, 0.46, 0.55, 0.68, 0.8126, 0.921, 0.95, 0.97, 0.99];
    expect(say(find.cardsTitle({ beats, c3: '3' }, F.pt))).toBe('O 3 vence 81,3% das outras cartas. Qualquer manilha vence mais de 92%.');
    expect(say(find.cardsTitle({ beats: beats.map((v, i) => (i === 10 ? 0.92 : v)), c3: '3' }, F.pt))).toContain('mais de 91%');
  });

  it('F12 title and the team reading only when 2 against 2 sits below at every class', () => {
    const one = [
      { cls: 9, n: 4000, mean: 0.62, lo: 0.6, hi: 0.64 },
      { cls: 10, n: 1000, mean: 0.8, lo: 0.77, hi: 0.83 },
      { cls: 13, n: 1000, mean: 0.9, lo: 0.88, hi: 0.92 },
    ];
    const below = one.map((r) => ({ ...r, mean: r.mean - 0.1, lo: r.lo - 0.1, hi: r.lo - 0.05 }));
    const r = find.bestCardTitle({ one, two: below, c3: '3', mode: '1 contra 1' }, F.pt)!;
    expect(say(r.title)).toBe('No 1 contra 1, com uma manilha na mão, você leva 85% das mãos. Com o 3 como melhor carta, 62%.');
    expect(r.reading?.key).toBe('data.f12.read');
    expect(find.bestCardTitle({ one, two: one, c3: '3', mode: '1 contra 1' }, F.pt)!.reading).toBeNull();
    expect(find.bestCardTitle({ one: [], two: [], c3: '3', mode: '1 contra 1' }, F.pt)).toBeNull();
  });

  it('F13 first, last or none, from both rows, with the numbers the chart shows', () => {
    const first: [find.ModeEst, find.ModeEst] = [
      { mode: '1 contra 1', n: 50000, mean: 0.53, lo: 0.525, hi: 0.535 },
      { mode: '2 contra 2', n: 50000, mean: 0.52, lo: 0.515, hi: 0.525 },
    ];
    expect(say(find.positionTitle(first, F.pt))).toBe('Quem joga primeiro leva vantagem: 53,0% das mãos no 1 contra 1, 52,0% no 2 contra 2.');
    const last = first.map((r) => ({ ...r, mean: 1 - r.mean, lo: 1 - r.hi, hi: 1 - r.lo })) as [find.ModeEst, find.ModeEst];
    expect(say(find.positionTitle(last, F.pt))).toBe('Quem joga por último leva vantagem: quem joga primeiro leva só 47,0% das mãos no 1 contra 1 e 48,0% no 2 contra 2.');
    expect(find.positionTitle([first[0], last[1]], F.pt).key).toBe('data.f13.h.none');
  });

  it('F13 claims an edge only when both intervals leave 50% out on the same side', () => {
    fc.assert(
      fc.property(arbEst(0.4, 0.6), arbEst(0.4, 0.6), (a, b) => {
        const k = find.positionTitle([{ ...a, n: 1000, mode: 'a' }, { ...b, n: 1000, mode: 'b' }], F.pt).key;
        if (k === 'data.f13.h.first') expect(a.lo > 0.5 && b.lo > 0.5).toBe(true);
        if (k === 'data.f13.h.last') expect(a.hi < 0.5 && b.hi < 0.5).toBe(true);
      }),
    );
  });

  it('F14 the side that leads and wins round 1, per table size', () => {
    const won: [find.ModeEst, find.ModeEst] = [
      { mode: '1 contra 1', n: 30000, mean: 0.8, lo: 0.795, hi: 0.805 },
      { mode: '2 contra 2', n: 10000, mean: 0.7, lo: 0.69, hi: 0.71 },
    ];
    expect(say(find.round1Title(won, F.pt))).toBe('Quem abre a mão e vence a primeira rodada leva a mão em 80,0% das vezes no 1 contra 1 e em 70% no 2 contra 2.');
  });

  it('F15 the break even at 0 to 0 and the range over the grid', () => {
    const grid = [
      [0.343, 0.3, null],
      [0.4, 0.2, 0.25],
      [0.45, 0.5, 0.62],
    ];
    const r = find.breakEvenTitle(grid, F.pt)!;
    expect(say(r.title)).toBe('No 0 a 0, aceite o truco com 34% de chance de ganhar a mão ou mais.');
    expect(say(r.reading!)).toBe('Vai de 20%, com 1 a 1, a 62%, com 2 a 2.');
    expect(say(find.breakEvenTitle(grid, F.en)!.title, 'en')).toBe('At 0 to 0, accept a truco with a 34% chance of winning the hand or more.');
    expect(find.breakEvenTitle([[null]], F.pt)).toBeNull();
  });
});

describe('chapter 2, how the AI progressed', () => {
  it('F16 versions: v2 against the toughest rival, v1 (claim 1: about 7 of 10)', () => {
    const rows = [
      { id: 'random', est: est(0.96, 0.955, 0.964) },
      { id: 'heuristic', est: est(0.788, 0.78, 0.796) },
      { id: 'tuned', est: est(0.875, 0.868, 0.882) },
      { id: 'v1', est: est(0.696, 0.687, 0.704) },
    ];
    expect(say(find.rivalsTitleVersions({ version: 'v2', rows }, F.pt)!)).toBe('A versão em jogo, v2, vence 7 de cada 10 partidas contra a v1.');
    expect(say(find.rivalsTitleVersions({ version: 'v2', rows }, F.en)!, 'en')).toBe('The version in play, v2, wins 7 out of 10 games against v1.');
    expect(find.rivalsTitleVersions({ version: 'v3', rows: [{ id: 'v2', est: est(0.5, 0.49, 0.51) }] }, F.pt)!.key).toBe('data.f16.h.versions.even');
    expect(find.rivalsTitleVersions({ version: 'v3', rows: [{ id: 'v2', est: est(0.45, 0.44, 0.46) }] }, F.pt)!.key).toBe('data.f16.h.versions.below');
  });

  it('F16 says "wins" only above 50% and "ties" only when the interval holds 50%', () => {
    fc.assert(
      fc.property(arbEst(0.3, 0.7), (e) => {
        const k = find.rivalsTitleVersions({ version: 'v2', rows: [{ id: 'v1', est: e }] }, F.pt)!.key;
        if (k === 'data.f16.h.versions') expect(e.lo).toBeGreaterThan(0.5);
        if (k === 'data.f16.h.versions.even') expect(e.lo <= 0.5 && e.hi >= 0.5).toBe(true);
        if (k === 'data.f16.h.versions.below') expect(e.hi).toBeLessThan(0.5);
      }),
    );
  });

  it('F17 empty, one game, many games with the Wilson interval', () => {
    expect(find.peopleTitle({ matches: 0, humanWins: 0 }, F.pt).title.key).toBe('data.f17.h.empty');
    expect(say(find.peopleTitle({ matches: 1, humanWins: 0 }, F.pt).title)).toBe('Pessoas venceram 0 de 1 partida contra o Zap.');
    const r = find.peopleTitle({ matches: 1200, humanWins: 300 }, F.pt);
    expect(say(r.title)).toBe('Pessoas venceram 300 de 1.200 partidas contra o Zap.');
    expect(plain(r.reading!)).toMatch(/^25%, provavelmente entre 23% e 28%\.$/);
  });

  it('F18 up, down, even and empty', () => {
    expect(find.twinTitle(null).key).toBe('data.f18.empty');
    expect(say(find.twinTitle({ version: 'v3', est: est(0.53, 0.52, 0.54) }))).toBe('Os dados de pessoas deixaram a v3 mais forte que a gêmea.');
    expect(find.twinTitle({ version: 'v3', est: est(0.47, 0.46, 0.48) }).key).toBe('data.f18.h.down');
    expect(find.twinTitle({ version: 'v3', est: est(0.506, 0.498, 0.515) }).key).toBe('data.f18.h.even');
    fc.assert(
      fc.property(arbEst(0.4, 0.6), (e) => {
        const k = find.twinTitle({ version: 'v3', est: e }).key;
        if (k === 'data.f18.h.up') expect(e.lo).toBeGreaterThan(0.5);
        if (k === 'data.f18.h.down') expect(e.hi).toBeLessThan(0.5);
        if (k === 'data.f18.h.even') expect(e.lo <= 0.5 && e.hi >= 0.5).toBe(true);
      }),
    );
  });

  it('F19 one version, one with people, many', () => {
    expect(say(find.historyTitle([{ version: 'v1', data: null }], F.pt))).toBe('Uma versão até hoje: a v1, treinada só contra si mesma.');
    expect(find.historyTitle([{ version: 'v1', data: { validMatches: 10 } }], F.pt).key).toBe('data.f19.h.oneOnly');
    expect(say(find.historyTitle([{ version: 'v1', data: null }, { version: 'v2', data: null }], F.en), 'en')).toBe('2 versions so far.');
  });
});

describe('chapter 3, how the AI plays', () => {
  const sw = (name: string, isZap: boolean, strong: number, weak: number, h = 0.005) => ({
    name,
    isZap,
    strong: est(strong, strong - h, strong + h),
    weak: est(weak, weak - h, weak + h),
  });
  it('F20 Zap strong and weak; who bluffs most, two names when they tie', () => {
    const rows = [sw('Zap', true, 0.62, 0.08), sw('Bento', false, 0.5, 0.25), sw('Lia', false, 0.4, 0.1)];
    const r = find.bluffTitle(rows, F.pt)!;
    expect(say(r.title)).toBe('O Zap pede truco em 62,0% das chances com mão forte e em 8,0% das chances com mão fraca.');
    expect(say(r.reading!)).toBe('Bento é quem mais blefa: pede em 25,0% das chances com mão fraca.');
    const tie = find.bluffTitle([...rows, sw('Ravi', false, 0.5, 0.245)], F.pt)!;
    expect(tie.reading!.key).toBe('data.f20.read.two');
    expect(find.bluffTitle([sw('Lia', false, 0.4, 0.1)], F.pt)).toBeNull();
  });

  it('F21 behind, ahead or the same, by the interval of the difference', () => {
    const cells = (p: number, n = 2000) => [{ n, p }, { n, p }, { n, p }];
    expect(find.mapTitle({ behind: cells(0.4), ahead: cells(0.3) }).key).toBe('data.f21.h.behind');
    expect(find.mapTitle({ behind: cells(0.3), ahead: cells(0.4) }).key).toBe('data.f21.h.ahead');
    expect(find.mapTitle({ behind: cells(0.35, 30), ahead: cells(0.33, 30) }).key).toBe('data.f21.h.same');
    expect(find.mapTitle({ behind: [], ahead: cells(0.3) }).key).toBe('data.f21.h.same');
  });

  it('F22 one name, two names when the top two overlap, and the control', () => {
    // v2's fresh check (claim 10): Iara 41.0% (39.7 to 42.4), Bento 32.0% (30.6 to 33.3).
    const chars = [
      { name: 'Otávio', est: est(0.266, 0.253, 0.279) },
      { name: 'Ravi', est: est(0.303, 0.289, 0.317) },
      { name: 'Lia', est: est(0.318, 0.305, 0.332) },
      { name: 'Bento', est: est(0.32, 0.306, 0.333) },
      { name: 'Iara', est: est(0.41, 0.397, 0.424) },
    ];
    const r = find.charactersTitle({ chars, control: est(0.5, 0.495, 0.505) }, F.pt)!;
    expect(say(r.title)).toBe('Iara é quem mais chega perto do Zap.');
    expect(say(r.reading!)).toBe('Zap contra Zap dá 50,0%, então a medida está calibrada.');
    const close = find.charactersTitle({ chars: chars.slice(0, 4), control: est(0.53, 0.52, 0.54) }, F.pt)!;
    expect(say(close.title)).toBe('Bento e Lia são quem mais chega perto do Zap.');
    expect(close.reading).toBeNull();
  });
});

describe('chapter 4 and the personal page', () => {
  it('F24 none or some', () => {
    expect(find.layersTitle({ on: 0, total: 5 }, F.pt).key).toBe('data.f24.h.none');
    expect(say(find.layersTitle({ on: 2, total: 5 }, F.pt))).toBe('2 de 5 partes já ligaram.');
  });

  it('F25 types or the people still needed', () => {
    expect(say(find.typesTitle({ types: null, need: 60 }, F.pt))).toBe('Os grupos aparecem com 60 pessoas.');
    expect(say(find.typesTitle({ types: 4, need: 60 }, F.en), 'en')).toBe('People form 4 style groups.');
  });

  it('F27 a variant only when the Wilson intervals are apart', () => {
    expect(find.variantsTitle({ paulista: null, mineiro: null, min: 20 }, F.pt).key).toBe('data.f27.empty');
    expect(find.variantsTitle({ paulista: { wins: 400, n: 1000 }, mineiro: { wins: 300, n: 1000 }, min: 20 }, F.pt).key).toBe('data.f27.h.paulista');
    expect(find.variantsTitle({ paulista: { wins: 300, n: 1000 }, mineiro: { wins: 400, n: 1000 }, min: 20 }, F.pt).key).toBe('data.f27.h.mineiro');
    expect(find.variantsTitle({ paulista: { wins: 31, n: 100 }, mineiro: { wins: 29, n: 100 }, min: 20 }, F.pt).key).toBe('data.f27.h.same');
  });

  it('P2 early while few games or a wide band; then the nearest character', () => {
    const anchors = [
      { id: 'otavio' as const, name: 'Otávio', mu: 18 },
      { id: 'bento' as const, name: 'Bento', mu: 20 },
      { id: 'lia' as const, name: 'Lia', mu: 20.5 },
      { id: 'ravi' as const, name: 'Ravi', mu: 21 },
      { id: 'iara' as const, name: 'Iara', mu: 23 },
      { id: 'zap' as const, name: 'Zap', mu: 25 },
    ];
    expect(say(find.ratingTitle({ n: 3, mu: 25, sigma: 8.33, anchors }, F.pt)!)).toBe('Com 3 partidas, sua {t:faixa} ainda é larga: entre Otávio e Zap.');
    expect(find.ratingTitle({ n: 1, mu: 25, sigma: 8.33, anchors }, F.pt)!.key).toBe('data.vs.p2.h.early.one');
    expect(find.ratingTitle({ n: 40, mu: 20.4, sigma: 0.4, anchors }, F.pt)!.key).toBe('data.vs.p2.h.early');
    expect(say(find.ratingTitle({ n: 40, mu: 22.8, sigma: 0.3, anchors }, F.pt)!)).toBe('Você joga perto do nível da Iara.');
    expect(say(find.ratingTitle({ n: 40, mu: 22.8, sigma: 0.3, anchors }, F.en)!, 'en')).toBe("You play close to Iara's level.");
  });
});

describe('every finding', () => {
  it('names a key of both languages and leaves no placeholder unfilled', () => {
    expect(seen.length).toBeGreaterThan(40);
    for (const x of seen) {
      expect(DICT.pt[x.key], x.key).toBeTruthy();
      expect(DICT.en[x.key], x.key).toBeTruthy();
      for (const lang of ['pt', 'en'] as const) {
        const s = find.say(F[lang], x);
        expect(s.replace(/\{t:\w+\}/g, ''), `${lang} ${x.key}`).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
