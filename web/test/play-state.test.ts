// The Play page's choice (web/src/play/state.ts): defaults, the saved choice, the address
// parameters, the first in first out picker, the partner, the match it starts and the code field.

import { describe, expect, it } from 'vitest';
import {
  applyParams,
  applySaved,
  cleanCodeInput,
  defaultChoice,
  initialChoice,
  isComplete,
  lineupOf,
  matchOf,
  partnerFor,
  pick,
  serialize,
  withLineup,
} from '../src/play/state.ts';

describe('play choice', () => {
  it('starts with 2 against 2, paulista, against Zap and Bento (1 against 1: Zap)', () => {
    const c = defaultChoice();
    expect(c).toEqual({ modo: 'dupla', variante: 'paulista', contra: { dupla: ['zap', 'bento'], solo: ['zap'] } });
    expect(matchOf(c, 4)).toEqual({ players: 4, variant: 'paulista', opponents: ['zap', 'bento'], partner: 'iara' });
  });

  it('reads a saved choice and ignores malformed fields one by one', () => {
    const saved = serialize({ modo: 'solo', variante: 'mineiro', contra: { dupla: ['lia', 'ravi'], solo: ['otavio'] } });
    expect(applySaved(defaultChoice(), saved)).toEqual({ modo: 'solo', variante: 'mineiro', contra: { dupla: ['lia', 'ravi'], solo: ['otavio'] } });
    const bad = JSON.stringify({ modo: 'x', variante: 'mineiro', contra: { dupla: ['zap', 'nobody'], solo: [] } });
    expect(applySaved(defaultChoice(), bad)).toEqual({ ...defaultChoice(), variante: 'mineiro' });
    expect(applySaved(defaultChoice(), JSON.stringify({ contra: { dupla: ['zap', 'zap'] } })).contra.dupla).toEqual(['zap', 'bento']);
    expect(applySaved(defaultChoice(), JSON.stringify({ contra: { dupla: ['zap', 'lia', 'ravi'] } })).contra.dupla).toEqual(['zap', 'bento']);
    expect(applySaved(defaultChoice(), '{not json')).toEqual(defaultChoice());
    expect(applySaved(defaultChoice(), 'null')).toEqual(defaultChoice());
    expect(applySaved(defaultChoice(), null)).toEqual(defaultChoice());
  });

  it('lets the address win over the saved choice', () => {
    const saved = serialize({ modo: 'dupla', variante: 'paulista', contra: { dupla: ['lia', 'ravi'], solo: ['iara'] } });
    const c = initialChoice(saved, '?modo=solo&variante=mineiro&contra=otavio');
    expect(c.modo).toBe('solo');
    expect(c.variante).toBe('mineiro');
    expect(c.contra.solo).toEqual(['otavio']);
    expect(c.contra.dupla).toEqual(['lia', 'ravi']);
    expect(matchOf(c, 4)).toEqual({ players: 2, variant: 'mineiro', opponents: ['otavio'], partner: 'iara' });
  });

  it('validates the address parameters against the six characters and completes a single opponent for 2 against 2', () => {
    expect(applyParams(defaultChoice(), '?modo=nope&variante=gaucho').modo).toBe('dupla');
    expect(applyParams(defaultChoice(), '?contra=ravi,otavio,lia').contra.dupla).toEqual(['ravi', 'otavio']);
    expect(applyParams(defaultChoice(), '?contra=otavio').contra.dupla).toEqual(['otavio', 'zap']);
    expect(applyParams(defaultChoice(), '?contra=zap').contra.dupla).toEqual(['zap', 'bento']);
    expect(applyParams(defaultChoice(), '?contra=nobody').contra).toEqual(defaultChoice().contra);
    expect(applyParams(defaultChoice(), '?modo=sala&contra=LIA,lia').contra.dupla).toEqual(['lia', 'zap']);
  });

  it('picks the partner as the first of Iara, Lia, Ravi, Bento, Otávio, Zap that is not an opponent', () => {
    expect(partnerFor(['zap', 'bento'])).toBe('iara');
    expect(partnerFor(['iara', 'zap'])).toBe('lia');
    expect(partnerFor(['iara', 'lia'])).toBe('ravi');
  });

  it('keeps two opponents first in, first out, and one opponent by replacement', () => {
    expect(pick(['zap', 'bento'], 'lia', true, 2)).toEqual({ kind: 'swap', list: ['bento', 'lia'], out: 'zap', in: 'lia' });
    expect(pick(['zap', 'bento'], 'bento', false, 2)).toEqual({ kind: 'missing', list: ['zap'] });
    expect(pick(['zap'], 'lia', true, 2)).toEqual({ kind: 'now', list: ['zap', 'lia'] });
    expect(pick([], 'lia', true, 2)).toEqual({ kind: 'missing', list: ['lia'] });
    expect(pick(['zap'], 'otavio', true, 1)).toEqual({ kind: 'now', list: ['otavio'] });
  });

  it('knows when the line up is complete, also for rooms by their number of players', () => {
    const c = withLineup(defaultChoice(), 'dupla', ['zap']);
    expect(isComplete(c, 4)).toBe(false);
    expect(isComplete({ ...c, modo: 'solo' }, 4)).toBe(true);
    const room = { ...c, modo: 'sala' as const };
    expect(lineupOf(room, 4)).toBe('dupla');
    expect(lineupOf(room, 2)).toBe('solo');
    expect(isComplete(room, 4)).toBe(false);
    expect(isComplete(room, 2)).toBe(true);
    expect(matchOf(room, 2)).toEqual({ players: 2, variant: 'paulista', opponents: ['zap'], partner: 'iara' });
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
