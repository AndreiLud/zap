// The practice hand behind a message boundary. The guided page runs this in a Web Worker
// (engine.worker.ts): the worker bundle carries its own copy of the engine's match code (setup,
// seeding, actions), so that code never joins the chunks every page and the table load. The host
// is a plain function from request to reply, so the unit test drives it directly.

import type { HandPhase } from '../../../engine/src/engine.ts';
import type { Observation } from '../../../engine/src/observe.ts';
import type { TimedEvent } from '../../../shared/protocol.ts';
import { GuidedGame } from './script.ts';

export type SceneName = 'meio' | 'truco' | 'fim';

export type GuidedRequest =
  /** A new practice hand, before the deal. */
  | { op: 'new' }
  /** The deal and Iara's signal. */
  | { op: 'start' }
  /** The person's action, and the AI seats after it up to the next pause. */
  | { op: 'human'; a: number }
  /** The AI seats, up to the next pause. */
  | { op: 'ai' }
  /** A new hand played with the demo moves up to a scene (?cena=). */
  | { op: 'scene'; scene: SceneName };

/** What the page needs to know about the hand after each reply. */
export interface GuidedState {
  /** Seat 0's observation (the table before the deal, before the start and after the hand). */
  obs: Observation;
  /** The seat the table waits for, null before the deal and after the hand. */
  deadlineSeat: number | null;
  started: boolean;
  ended: boolean;
  phase: HandPhase;
  /** The person must act now. */
  humanTurn: boolean;
  /** The Zap's call waits for the person's answer. */
  waitingAnswer: boolean;
  /** The person's legal actions. */
  legal: number;
  /** The move ?demo=1 makes for the person now. */
  demoAction: number;
}

/** One stretch of a scene, in order: events the table would have shown, or a turn the coach suggests on. */
export type SceneStep = { t: 'events'; events: TimedEvent[] } | { t: 'turn' };

export interface GuidedReply {
  events: TimedEvent[];
  state: GuidedState;
  scene?: SceneStep[];
}

function stateOf(g: GuidedGame): GuidedState {
  return {
    obs: g.observation(),
    deadlineSeat: g.deadlineSeat(),
    started: g.isStarted,
    ended: g.ended,
    phase: g.phase(),
    humanTurn: g.humanTurn(),
    waitingAnswer: g.waitingAnswer(),
    legal: g.legal(),
    demoAction: g.humanTurn() ? g.demoAction() : -1,
  };
}

/**
 * Plays the demo moves up to a scene: "truco" stops when the Zap's call waits for the person,
 * "meio" right after the person accepts it (the Zap to play), "fim" when the hand ended.
 */
function playScene(g: GuidedGame, scene: SceneName): SceneStep[] {
  const steps: SceneStep[] = [{ t: 'events', events: g.start() }];
  for (let guard = 0; guard < 60 && !g.ended; guard++) {
    if (scene === 'truco' && g.waitingAnswer()) break;
    if (g.humanTurn()) {
      if (g.phase() === 'play') steps.push({ t: 'turn' });
      const answer = g.waitingAnswer();
      steps.push({ t: 'events', events: g.human(g.demoAction()) });
      if (scene === 'meio' && answer) break;
      continue;
    }
    steps.push({ t: 'events', events: g.runAI() });
  }
  return steps;
}

export function createHost(): (req: GuidedRequest) => GuidedReply {
  let g = new GuidedGame();
  return (req) => {
    let events: TimedEvent[] = [];
    let scene: SceneStep[] | undefined;
    switch (req.op) {
      case 'new':
        g = new GuidedGame();
        break;
      case 'start':
        events = g.start();
        break;
      case 'human':
        events = g.human(req.a);
        break;
      case 'ai':
        events = g.humanTurn() ? [] : g.runAI();
        break;
      case 'scene':
        g = new GuidedGame();
        scene = playScene(g, req.scene);
        break;
    }
    return scene ? { events, state: stateOf(g), scene } : { events, state: stateOf(g) };
  };
}
