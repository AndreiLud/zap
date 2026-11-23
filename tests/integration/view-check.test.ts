// The view checker used by the integration tests must catch leaks, or the match tests prove
// nothing. These cases run without a server: real observations from the engine, then one leak
// planted at a time.

import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/src/config.ts';
import { applyAction, expectedActor, legalMask, newMatch, type MatchState } from '../../engine/src/engine.ts';
import { observe, type Observation } from '../../engine/src/observe.ts';
import type { ServerMsg, TimedEvent } from '../../shared/protocol.ts';
import { ViewChecker, crossCheck } from './view-check.ts';

const SEED = 'ab'.repeat(32);

/** A 2 against 2 paulista match after the first round, so there are plays to look at. */
function midHand(): MatchState {
  const s = newMatch(makeConfig('paulista', 4, { signals: 'p25' }), SEED);
  for (let i = 0; i < 4; i++) {
    const seat = expectedActor(s);
    const mask = legalMask(s, seat);
    applyAction(s, seat, [0, 1, 2].find((a) => mask & (1 << a))!);
  }
  return s;
}

function gameMsg(obs: Observation, events: TimedEvent[] = []): ServerMsg {
  return { t: 'game', now: 1, seq: 7, matchNo: 1, obs, events, deadline: { seat: obs.seat, at: null } };
}

function problemsFor(mutate: (o: Observation) => ServerMsg | void, seat = 0): string[] {
  const s = midHand();
  const v = new ViewChecker('test');
  v.seat = seat;
  const first = observe(s, seat);
  v.check(gameMsg(first), JSON.stringify(gameMsg(first)));
  const o = structuredClone(first);
  const msg = mutate(o) ?? gameMsg(o);
  v.check(msg, JSON.stringify(msg));
  return v.problems;
}

describe('view checker', () => {
  it('accepts the real observation of every seat', () => {
    const s = midHand();
    for (let seat = 0; seat < 4; seat++) {
      const v = new ViewChecker(`seat ${seat}`);
      v.seat = seat;
      const m = gameMsg(observe(s, seat));
      v.check(m, JSON.stringify(m));
      expect(v.problems).toEqual([]);
    }
    expect(problemsFor(() => undefined)).toEqual([]);
  });

  it('catches another seat\'s face-down card shown with its value', () => {
    const p = problemsFor((o) => {
      o.rounds[0].plays.find((x) => x.seat !== o.seat)!.faceDown = true;
    });
    expect(p.join('\n')).toMatch(/face-down card visible/);
  });

  it('catches the partner\'s cards outside a mão de onze', () => {
    const p = problemsFor((o) => {
      o.partnerHand = [1, 2, 3];
    });
    expect(p.join('\n')).toMatch(/partnerHand sent/);
  });

  it('catches a seed, an unknown field and a 64-hex value', () => {
    const p = problemsFor((o) => {
      (o as unknown as Record<string, unknown>).seed = SEED;
    });
    expect(p.join('\n')).toMatch(/forbidden key "seed"/);
    expect(p.join('\n')).toMatch(/unexpected key "seed"/);
    expect(p.join('\n')).toMatch(/64-hex/);
  });

  it('catches a card in two places and a hand slot that changes', () => {
    const dup = problemsFor((o) => {
      const played = o.rounds[0].plays.find((x) => x.seat !== o.seat)!.card;
      o.hand[o.hand.findIndex((c) => c >= 0)] = played;
    });
    expect(dup.join('\n')).toMatch(/repeated|changed/);
  });

  it('catches a signal event that tells who caught it, and an unknown event', () => {
    const p = problemsFor((o) =>
      gameMsg(o, [
        { at: 0, e: { t: 'signal', seat: 1, signal: 0, seenBy: 0b0101 } },
        { at: 0, e: { t: 'peek', cards: [1, 2, 3] } as never },
      ]),
    );
    expect(p.join('\n')).toMatch(/signal event tells who caught it/);
    expect(p.join('\n')).toMatch(/unknown event peek/);
  });

  it('cross-check catches one person\'s card in the other person\'s hand', () => {
    const s = midHand();
    const a = new ViewChecker('A');
    const b = new ViewChecker('B');
    a.seat = 0;
    b.seat = 1;
    const oa = observe(s, 0);
    const ob = observe(s, 1);
    b.check(gameMsg(ob), JSON.stringify(gameMsg(ob)));
    a.check(gameMsg(oa), JSON.stringify(gameMsg(oa)));
    expect(crossCheck(a, b)).toEqual([]);
    const leaked = new ViewChecker('A');
    leaked.seat = 0;
    const bad = structuredClone(oa);
    bad.hand[bad.hand.findIndex((c) => c >= 0)] = ob.hand.find((c) => c >= 0)!;
    leaked.check(gameMsg(bad), JSON.stringify(gameMsg(bad)));
    expect(crossCheck(leaked, b).join('\n')).toMatch(/saw B's card/);
  });
});
