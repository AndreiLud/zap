// The Play page's choice (web/src/play/state.ts): defaults, the saved mode and variant, the address
// parameters, the partner, the random switches, the request it sends, the summary under the button,
// the first in first out picker and the code field.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PersonaId } from '../../ai/src/personas.ts';
import { FILL_ORDER, PERSONA_ORDER, firstFree, lineupProblem } from '../../shared/lineup.ts';
import type { Key, Vars } from '../src/i18n.ts';
import { DEFAULT_ROOM } from '../src/play/RoomSettings.tsx';
import {
  applyParams,
  applySaved,
  cleanCodeInput,
  defaultChoice,
  initialChoice,
  isComplete,
  partnerOf,
  pick,
  requestOf,
  roomRequestOf,
  savedHasLineup,
  serialize,
  summaryOf,
  takenByOpponents,
  takenByPartner,
  withLineup,
  type PlayChoice,
} from '../src/play/state.ts';

/** A t that shows the key and its values, so a test sees which text and which parts were chosen. */
const fakeT = (key: Key, vars?: Vars): string => (vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(';')})` : key);

/** t over the real dictionaries of one language (shared file plus the play area). */
function realT(lang: 'pt-BR' | 'en'): (key: Key, vars?: Vars) => string {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../../locales/${f}`, import.meta.url), 'utf8')) as Record<string, string>;
  const dict = { ...read(`${lang}.json`), ...read(`play.${lang}.json`) };
  return (key, vars) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
}

/** What the Worker's readSettings would store for a quick play request (a missing partner is firstFree). */
function asSettings(r: ReturnType<typeof requestOf>) {
  return { mode: 'solo' as const, players: r.players, opponents: r.opponents, partner: r.partner ?? firstFree(r.opponents), randomOpponents: r.randomOpponents, randomPartner: r.randomPartner };
}

describe('play choice', () => {
  it('starts with 2 against 2, paulista, Zap and Iara with a random partner; 1 against 1 against Zap', () => {
    const c = defaultChoice();
    expect(c).toEqual({
      modo: 'dupla',
      variante: 'paulista',
      contra: { dupla: ['zap', 'iara'], solo: ['zap'] },
      parceiro: 'lia',
      sorteio: { dupla: false, solo: false, parceiro: true },
    });
    expect(requestOf(c)).toEqual({ players: 4, variant: 'paulista', opponents: ['zap', 'iara'], partner: 'lia', randomOpponents: false, randomPartner: true });
    expect(requestOf({ ...c, modo: 'solo' })).toEqual({ players: 2, variant: 'paulista', opponents: ['zap'], randomOpponents: false });
    // Every visit from the menu starts here: two calls never share state.
    defaultChoice().contra.dupla.push('bento');
    expect(defaultChoice().contra.dupla).toEqual(['zap', 'iara']);
  });

  it('reads only the saved mode and variant; a stored line up is ignored and flagged for the purge', () => {
    const old = JSON.stringify({ modo: 'solo', variante: 'mineiro', contra: { dupla: ['lia', 'ravi'], solo: ['otavio'] } });
    expect(applySaved(defaultChoice(), old)).toEqual({ ...defaultChoice(), modo: 'solo', variante: 'mineiro' });
    expect(applySaved(defaultChoice(), JSON.stringify({ modo: 'x', variante: 'mineiro' }))).toEqual({ ...defaultChoice(), variante: 'mineiro' });
    expect(applySaved(defaultChoice(), JSON.stringify({ parceiro: 'ravi', sorteio: { dupla: true } }))).toEqual(defaultChoice());
    for (const raw of ['{not json', 'null', '[]', '"dupla"', null]) expect(applySaved(defaultChoice(), raw)).toEqual(defaultChoice());
    expect(savedHasLineup(old)).toBe(true);
    expect(savedHasLineup(JSON.stringify({ modo: 'solo', variante: 'mineiro' }))).toBe(false);
    expect(savedHasLineup('{not json')).toBe(false);
    expect(savedHasLineup(null)).toBe(false);
  });

  it('stores the mode and the variant only: never a line up, a switch or the partner', () => {
    const c: PlayChoice = { modo: 'solo', variante: 'mineiro', contra: { dupla: ['lia', 'ravi'], solo: ['otavio'] }, parceiro: 'bento', sorteio: { dupla: true, solo: true, parceiro: false } };
    expect(JSON.parse(serialize(c))).toEqual({ modo: 'solo', variante: 'mineiro' });
    expect(savedHasLineup(serialize(c))).toBe(false);
    // What is stored comes back as the same mode and variant, the rest from the defaults.
    expect(initialChoice(serialize(c), '')).toEqual({ ...defaultChoice(), modo: 'solo', variante: 'mineiro' });
  });

  it('lets the address preset the line up and turns that line up switch off', () => {
    const zap = applyParams(defaultChoice(), '?contra=zap');
    expect(zap.contra.dupla).toEqual(['zap', 'iara']);
    expect(zap.sorteio).toEqual({ dupla: false, solo: false, parceiro: true });
    const random = { ...defaultChoice(), sorteio: { dupla: true, solo: true, parceiro: true } };
    expect(applyParams(random, '?contra=otavio').sorteio).toEqual({ dupla: false, solo: true, parceiro: true });
    expect(applyParams(random, '?contra=otavio').contra.dupla).toEqual(['otavio', 'zap']);
    expect(applyParams(random, '?modo=solo&contra=otavio').sorteio).toEqual({ dupla: true, solo: false, parceiro: true });
    // The guided lesson's outro link (web/src/guided/Coach.tsx).
    const outro = initialChoice(JSON.stringify({ modo: 'dupla', variante: 'mineiro' }), '?modo=solo&contra=otavio');
    expect(outro.modo).toBe('solo');
    expect(outro.variante).toBe('mineiro');
    expect(outro.contra.solo).toEqual(['otavio']);
    expect(requestOf(outro)).toEqual({ players: 2, variant: 'mineiro', opponents: ['otavio'], randomOpponents: false });
    // Unknown values change nothing; at most two distinct ids, in order.
    expect(applyParams(defaultChoice(), '?modo=nope&variante=gaucho')).toEqual(defaultChoice());
    expect(applyParams(defaultChoice(), '?contra=ravi,otavio,lia').contra.dupla).toEqual(['ravi', 'otavio']);
    expect(applyParams(defaultChoice(), '?contra=iara').contra.dupla).toEqual(['iara', 'zap']);
    expect(applyParams(defaultChoice(), '?contra=nobody')).toEqual(defaultChoice());
    expect(applyParams(defaultChoice(), '?modo=sala&contra=LIA,lia').contra.dupla).toEqual(['lia', 'zap']);
    // A preset opponent that was the partner: the opponents win, the partner moves on.
    expect(initialChoice(null, '?contra=lia,ravi').parceiro).toBe('iara');
  });

  it('keeps the manual partner unless the opponents take it', () => {
    const c = defaultChoice();
    expect(partnerOf(c)).toBe('lia');
    expect(partnerOf({ ...c, parceiro: 'ravi' })).toBe('ravi');
    expect(partnerOf({ ...c, parceiro: 'zap' })).toBe('lia');
    expect(partnerOf({ ...c, contra: { ...c.contra, dupla: ['iara', 'lia'] } })).toBe('ravi');
    expect(partnerOf({ ...c, contra: { ...c.contra, dupla: ['lia'] } })).toBe('iara');
  });

  it('with "Adversários" on, the partner chosen by hand stays, whatever the hidden list holds (D1)', () => {
    const base: PlayChoice = { ...defaultChoice(), sorteio: { dupla: true, solo: false, parceiro: false } };
    // Zap and Iara wait in the hidden manual list; picking Zap as the partner keeps Zap.
    const zap: PlayChoice = { ...base, parceiro: 'zap' };
    expect(takenByOpponents(zap)).toEqual([]);
    expect(partnerOf(zap)).toBe('zap');
    const r = requestOf(zap);
    expect(r).toMatchObject({ players: 4, partner: 'zap', opponents: ['iara', 'lia'], randomOpponents: true, randomPartner: false });
    expect(lineupProblem(asSettings(r))).toBeNull();
    // An incomplete list behind the switch: the summary and the request name the same partner.
    const one: PlayChoice = { ...withLineup(base, 'dupla', ['zap']), parceiro: 'iara' };
    expect(summaryOf(one, 4, fakeT)).toBe('play.sum.dupla(v=play.v.paulista;p=play.who.iara;o=play.who.drawnOpp2)');
    expect(requestOf(one)).toMatchObject({ partner: 'iara', opponents: ['zap', 'lia'] });
    // The switch off again: the opponents picked by hand win the clash, as before.
    expect(partnerOf({ ...zap, sorteio: { ...zap.sorteio, dupla: false } })).toBe('lia');
  });

  it('disables a character on the other side only while both sides are picked by hand', () => {
    const manual: PlayChoice = { ...defaultChoice(), parceiro: 'ravi', sorteio: { dupla: false, solo: false, parceiro: false } };
    expect(takenByOpponents(manual)).toEqual(['zap', 'iara']);
    expect(takenByPartner(manual)).toEqual(['ravi']);
    for (const sorteio of [
      { dupla: true, solo: false, parceiro: false },
      { dupla: false, solo: false, parceiro: true },
      { dupla: true, solo: false, parceiro: true },
    ]) {
      expect(takenByOpponents({ ...manual, sorteio })).toEqual([]);
      expect(takenByPartner({ ...manual, sorteio })).toEqual([]);
    }
    expect(takenByOpponents({ ...manual, modo: 'solo' })).toEqual([]);
    expect(takenByPartner({ ...manual, modo: 'sala' })).toEqual([]);
  });

  it('knows when the button can start: rooms always, a random line up always, else a full manual list', () => {
    const one = withLineup(defaultChoice(), 'dupla', ['zap']);
    expect(isComplete(one)).toBe(false);
    expect(isComplete({ ...one, sorteio: { ...one.sorteio, dupla: true } })).toBe(true);
    expect(isComplete({ ...one, modo: 'solo' })).toBe(true);
    expect(isComplete({ ...withLineup(one, 'solo', []), modo: 'solo' })).toBe(false);
    expect(isComplete({ ...withLineup(one, 'solo', []), modo: 'solo', sorteio: { ...one.sorteio, solo: true } })).toBe(true);
    expect(isComplete({ ...withLineup(one, 'solo', []), modo: 'sala' })).toBe(true);
  });

  it('sends a valid request for every mode, switch and partner, even behind a random switch', () => {
    const lists: Record<'dupla' | 'solo', PersonaId[][]> = { dupla: [['zap', 'iara'], ['otavio', 'lia'], ['lia'], []], solo: [['bento'], []] };
    let n = 0;
    for (const modo of ['dupla', 'solo'] as const) {
      for (const dupla of [false, true]) {
        for (const solo of [false, true]) {
          for (const parceiro of [false, true]) {
            for (const list of modo === 'dupla' ? lists.dupla : lists.solo) {
              for (const partner of PERSONA_ORDER) {
                const c: PlayChoice = { ...withLineup(defaultChoice(), modo, list), modo, parceiro: partner, sorteio: { dupla, solo, parceiro } };
                const random = modo === 'dupla' ? dupla : solo;
                if (!isComplete(c)) {
                  expect(random).toBe(false);
                  continue;
                }
                const r = requestOf(c);
                n++;
                expect(lineupProblem(asSettings(r)), JSON.stringify(c)).toBeNull();
                expect(r.players).toBe(modo === 'solo' ? 2 : 4);
                expect(r.randomOpponents).toBe(random);
                if (modo === 'solo') {
                  expect('partner' in r || 'randomPartner' in r).toBe(false);
                } else {
                  expect(r.randomPartner).toBe(parceiro);
                  expect(r.opponents).not.toContain(r.partner);
                  // A manual partner that is not an opponent is the one sent.
                  if (!list.includes(partner) && list.length === 2) expect(r.partner).toBe(partner);
                }
                if (modo === 'dupla' && dupla) {
                  // "Adversários" draws them: the partner chosen by hand is sent whatever the hidden
                  // list holds, with opponents that leave it free (the list first when it can).
                  expect(r.partner).toBe(partner);
                  const around = [...new Set([...list, 'zap', 'iara', ...FILL_ORDER])].filter((p) => p !== partner).slice(0, 2);
                  expect(r.opponents).toEqual(list.length === 2 && !list.includes(partner) ? list : around);
                } else {
                  // A full manual list is sent as it is; an incomplete one behind a switch sends the defaults.
                  expect(r.opponents).toEqual(list.length === (modo === 'solo' ? 1 : 2) ? list : modo === 'solo' ? ['zap'] : ['zap', 'iara']);
                }
              }
            }
          }
        }
      }
    }
    // 144 tables of 2 against 2 and 72 of 1 against 1 can start (the rest wait for a full manual list).
    expect(n).toBe(216);
  });

  it('sends no line up for a room: the table is set up in the room', () => {
    const c = { ...defaultChoice(), modo: 'sala' as const, variante: 'mineiro' as const };
    const r = roomRequestOf(c, { ...DEFAULT_ROOM, players: 2, turn: 'none', bestOf3: true });
    expect(r).toEqual({ players: 2, variant: 'mineiro', options: { bestOf: 3 }, turnSeconds: null });
    expect(roomRequestOf(c, DEFAULT_ROOM)).toEqual({ players: 4, variant: 'mineiro', options: {}, turnSeconds: 30 });
  });

  it('says under the button what starts, for every switch', () => {
    const c = defaultChoice();
    const manual = { ...c, parceiro: 'ravi' as const, sorteio: { dupla: false, solo: false, parceiro: false } };
    expect(summaryOf(c, 4, fakeT)).toBe('play.sum.dupla(v=play.v.paulista;p=play.who.drawnPartner;o=play.opp.pair(a=play.who.zap;b=play.who.iara))');
    expect(summaryOf(manual, 4, fakeT)).toBe('play.sum.dupla(v=play.v.paulista;p=play.who.ravi;o=play.opp.pair(a=play.who.zap;b=play.who.iara))');
    expect(summaryOf({ ...manual, sorteio: { ...manual.sorteio, dupla: true } }, 4, fakeT)).toBe('play.sum.dupla(v=play.v.paulista;p=play.who.ravi;o=play.who.drawnOpp2)');
    expect(summaryOf({ ...c, sorteio: { ...c.sorteio, dupla: true } }, 4, fakeT)).toBe('play.sum.dupla(v=play.v.paulista;p=play.who.drawnPartner;o=play.who.drawnOpp2)');
    expect(summaryOf(withLineup(manual, 'dupla', ['zap']), 4, fakeT)).toBe('play.opp.missing');
    expect(summaryOf({ ...withLineup(manual, 'dupla', ['zap']), sorteio: { ...manual.sorteio, dupla: true } }, 4, fakeT)).toBe('play.sum.dupla(v=play.v.paulista;p=play.who.ravi;o=play.who.drawnOpp2)');
    const solo = { ...c, modo: 'solo' as const, variante: 'mineiro' as const };
    expect(summaryOf(solo, 4, fakeT)).toBe('play.sum.solo(v=play.v.mineiro;a=play.who.zap)');
    expect(summaryOf({ ...solo, sorteio: { ...c.sorteio, solo: true } }, 4, fakeT)).toBe('play.sum.solo(v=play.v.mineiro;a=play.who.drawnOpp1)');
    expect(summaryOf(withLineup(solo, 'solo', []), 4, fakeT)).toBe('play.opp.missing');
    expect(summaryOf({ ...c, modo: 'sala' }, 2, fakeT)).toBe('play.sum.sala(v=play.v.paulista;m=mode.2)');
    // The sentences people read (tests/e2e/play-lineup.spec.ts and keyboard.spec.ts read them too).
    const pt = realT('pt-BR');
    const en = realT('en');
    expect(summaryOf(c, 4, pt)).toBe('Paulista, 2 contra 2: você e um parceiro sorteado contra o Zap e a Iara.');
    expect(summaryOf(c, 4, en)).toBe('Paulista, 2 against 2: you and a random partner against Zap and Iara.');
    expect(summaryOf(manual, 4, pt)).toBe('Paulista, 2 contra 2: você e o Ravi contra o Zap e a Iara.');
    expect(summaryOf({ ...c, modo: 'solo' }, 4, en)).toBe('Paulista, 1 against 1: you against Zap.');
    expect(summaryOf({ ...c, modo: 'solo', sorteio: { ...c.sorteio, solo: true } }, 4, pt)).toBe('Paulista, 1 contra 1: você contra um adversário sorteado.');
    expect(summaryOf({ ...c, sorteio: { dupla: true, solo: false, parceiro: true } }, 4, pt)).toBe('Paulista, 2 contra 2: você e um parceiro sorteado contra dois adversários sorteados.');
  });

  it('keeps two opponents first in, first out, and one opponent by replacement', () => {
    expect(pick(['zap', 'bento'], 'lia', true, 2)).toEqual({ kind: 'swap', list: ['bento', 'lia'], out: 'zap', in: 'lia' });
    expect(pick(['zap', 'bento'], 'bento', false, 2)).toEqual({ kind: 'missing', list: ['zap'] });
    expect(pick(['zap'], 'lia', true, 2)).toEqual({ kind: 'now', list: ['zap', 'lia'] });
    expect(pick([], 'lia', true, 2)).toEqual({ kind: 'missing', list: ['lia'] });
    expect(pick(['zap'], 'otavio', true, 1)).toEqual({ kind: 'now', list: ['otavio'] });
  });

  it('cleans the room code field and says why a character was dropped', () => {
    expect(cleanCodeInput('k7qxm')).toEqual({ code: 'K7QXM', dropped: null });
    expect(cleanCodeInput('k7q-xm')).toEqual({ code: 'K7QXM', dropped: null });
    expect(cleanCodeInput('K7Q XM')).toEqual({ code: 'K7QXM', dropped: null });
    expect(cleanCodeInput('ab0cd')).toEqual({ code: 'ABCD', dropped: 'chars' });
    expect(cleanCodeInput('abIOL')).toEqual({ code: 'AB', dropped: 'chars' });
    expect(cleanCodeInput('ab*c')).toEqual({ code: 'ABC', dropped: 'other' });
    expect(cleanCodeInput('a*1')).toEqual({ code: 'A', dropped: 'chars' });
    expect(cleanCodeInput('ABCDEFGH')).toEqual({ code: 'ABCDE', dropped: null });
  });
});
