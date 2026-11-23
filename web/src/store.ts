// One small store for the whole client. Components read it with useStore() and re-render on any
// change, or with useStoreSelect(selector) and re-render only when their slice changes (the table
// regions use the second, so a timer tick never re-renders the whole table).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { GameEvent } from '../../engine/src/engine.ts';
import type { LimitInfo, PhraseKey, ServerMsg } from '../../shared/protocol.ts';
import type { ConnState } from './connection.ts';
import type { Key, Lang } from './i18n.ts';
import { readFourColor, readKeysOn, readSoundOn } from './prefs.ts';
import type { Route } from './routes.ts';
import type { GameMsg, TableView } from './table-view.ts';

export type { Route, RouteName } from './routes.ts';
export type RoomMsg = Extract<ServerMsg, { t: 'room' }>;

export type FeedItem =
  | { id: number; kind: 'event'; e: GameEvent; you: number; players: number }
  | { id: number; kind: 'phrase'; seat: number; key: PhraseKey; you: number };

export type RoomProblem = 'not_found' | 'started' | 'full' | 'check' | 'blocked' | 'expired' | 'gone' | 'network' | 'replaced' | 'closed' | 'forgotten' | 'age' | 'gate';

/** What a Turnstile token is for: a game credential, or one sensitive action of the You page (/voce). */
export type CheckPurpose = 'play' | 'delete' | 'recover';

/** The question open before an action: the age gate, its answer for under 18, or the notice. */
export type GateStep = 'closed' | 'age' | 'under' | 'notice';

export interface AppState {
  lang: Lang;
  route: Route;
  /** An API call started from the home page is running. */
  busy: boolean;
  homeError: string | null;
  /** With homeError limit_reached: which limit of the brake ran out and when it starts again. */
  homeLimit: LimitInfo | null;
  check: { open: boolean; failed: boolean; purpose: CheckPurpose };
  gate: GateStep;
  rulesOpen: boolean;
  /** The phone menu sheet is open (below 64em). */
  menuOpen: boolean;
  /** Four-color deck (prefs.ts); applied as html[data-deck="four"]. */
  fourColor: boolean;
  /** Sound and vibration (prefs.ts, sound/index.ts). */
  soundOn: boolean;
  /** Single key shortcuts at the table and R for the rules (prefs.ts; WCAG 2.1.4 lets them be turned off). */
  keysOn: boolean;
  /** Bumped each time a legal dictionary finishes loading (i18n.ts loadLegal), so pages re-render. */
  legalLoads: number;
  conn: ConnState;
  roomProblem: RoomProblem | null;
  room: RoomMsg | null;
  game: GameMsg | null;
  view: TableView | null;
  /** Events of the last message are still being shown. */
  playing: boolean;
  /** Server clock minus this device's clock, in ms. */
  clockOffset: number;
  feed: FeedItem[];
  bubbles: Record<number, { key: PhraseKey; id: number }>;
  notice: Key | null;
  /** The brake refused a start or a rematch in the room: shown like a notice, a little longer. */
  noticeLimit: LimitInfo | null;
  /** Phrases and signals of the other seats are not shown. */
  muteOthers: boolean;
  /** The next card goes face down. */
  cover: boolean;
  /** An action was sent and its answer has not arrived. */
  sending: boolean;
  /** The server accepts one phrase every 5 s: the phrase button waits until this time. */
  phraseReadyAt: number;
}

type Listener = () => void;

export const MUTE_KEY = 'zap-mute-phrases';

function readMute(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

let state: AppState = {
  lang: 'pt',
  route: { name: 'start' },
  busy: false,
  homeError: null,
  homeLimit: null,
  check: { open: false, failed: false, purpose: 'play' },
  gate: 'closed',
  rulesOpen: false,
  menuOpen: false,
  fourColor: readFourColor(),
  soundOn: readSoundOn(),
  keysOn: readKeysOn(),
  legalLoads: 0,
  conn: 'connecting',
  roomProblem: null,
  room: null,
  game: null,
  view: null,
  playing: false,
  clockOffset: 0,
  feed: [],
  bubbles: {},
  notice: null,
  noticeLimit: null,
  muteOthers: readMute(),
  cover: false,
  sending: false,
  phraseReadyAt: 0,
};

const listeners = new Set<Listener>();

export const store = {
  get(): AppState {
    return state;
  },
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useStore(): AppState {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((x) => x + 1)), []);
  return store.get();
}

/**
 * Reads one slice of the store and re-renders only when that slice changes (by `equal`, Object.is
 * by default). For slices built fresh on each call (objects, arrays), pass an equality that
 * compares their parts, or the component re-renders on every store change.
 */
export function useStoreSelect<T>(select: (s: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const [, setTick] = useState(0);
  const value = select(store.get());
  const last = useRef(value);
  const sel = useRef(select);
  const eq = useRef(equal);
  last.current = value;
  sel.current = select;
  eq.current = equal;
  useEffect(
    () =>
      store.subscribe(() => {
        const next = sel.current(store.get());
        if (!eq.current(last.current, next)) {
          last.current = next;
          setTick((x) => x + 1);
        }
      }),
    [],
  );
  return value;
}

/** Shallow equality of two flat objects or arrays, for useStoreSelect. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Server time now, as this device best knows it. */
export function serverNow(): number {
  return Date.now() + state.clockOffset;
}

let nextId = 1;
export function newId(): number {
  return nextId++;
}
