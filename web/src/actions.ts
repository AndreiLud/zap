// Navigation, language and the Play page actions. Addresses and routes come from routes.ts; this
// module moves between them, keeps the room connection of a room route and registers it as the
// table's controller (controller.ts).

import { CODE_PATTERN } from '../../shared/protocol.ts';
import { ApiError, api, type NewMatch } from './api.ts';
import { resetPageChrome } from './chrome.ts';
import { withCheck } from './check.ts';
import { setController, type TableController } from './controller.ts';
import { defaultLimit, heldLimit, holdLimit, readLimit } from './limit.ts';
import { ensureReady, forgetPerson, isGateStop } from './consent.ts';
import { applyLang, onLegalLoaded, savedLang, type Lang } from './i18n.ts';
import { applyFourColor, saveFourColor, saveKeysOn, saveSoundOn } from './prefs.ts';
import { RoomController } from './room.ts';
import { cleanCode, pathFor, routeFromPath, withLang, type Route, type RouteName } from './routes.ts';
import { sound } from './sound/index.ts';
import { store } from './store.ts';

export { cleanCode } from './routes.ts';

let room: RoomController | null = null;

export function currentRoom(): RoomController | null {
  return room;
}

const LAST_ROOM_KEY = 'zap-last-room';

export function lastRoom(): string | null {
  try {
    const v = sessionStorage.getItem(LAST_ROOM_KEY);
    return v && CODE_PATTERN.test(v) ? v : null;
  } catch {
    return null;
  }
}

function rememberRoom(code: string | null): void {
  try {
    if (code) sessionStorage.setItem(LAST_ROOM_KEY, code);
    else sessionStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/** The address of a route in a language (the current one by default), without query or hash. */
export function urlFor(route: Route, l: Lang = store.get().lang): string {
  // A page that does not exist keeps its own path; only the language prefix changes.
  if (route.name === 'notFound') return withLang(location.pathname, l);
  return pathFor(route, l);
}

/**
 * The address of the current route in a language, keeping its query (?modo=, ?variante=, ?cena=...)
 * and hash. The room's query is its code, already in urlFor; the start page keeps none.
 */
function currentAddress(route: Route, l: Lang): string {
  const keepSearch = route.name !== 'room' && route.name !== 'start';
  return urlFor(route, l) + (keepSearch ? location.search : '') + location.hash;
}

function routeFromLocation(): Route {
  const r = routeFromPath(location.pathname, location.search);
  return r.code ? { name: r.name, code: r.code } : { name: r.name };
}

/** The table's controller for a room: the room's connection, and "Sair" goes back to the Play page. */
function roomController(r: RoomController): TableController {
  return {
    kind: 'room',
    act: (a, auto) => r.act(a, auto),
    phrase: (k) => r.phrase(k),
    rematch: (next) => r.rematch(next),
    changeTable: () => r.toLobby(),
    resume: () => r.resume(),
    leave: leaveRoom,
    notice: (k) => r.notice(k),
  };
}

let routeChanges = 0;

/** True after the person moved inside the site (not on the first page load): pages then move the focus to their title. */
export function movedInSite(): boolean {
  return routeChanges > 1;
}

function enterRoute(route: Route): void {
  routeChanges++;
  const code = route.name === 'room' ? (route.code ?? null) : null;
  if (room && room.code !== code) {
    room.close();
    room = null;
    setController(null);
  }
  resetPageChrome();
  store.set({ route, menuOpen: false, homeError: null, homeLimit: null });
  if (code && !room) {
    room = new RoomController(code);
    setController(roomController(room));
    rememberRoom(code);
    void room.open();
  }
  window.scrollTo(0, 0);
}

/**
 * Moves to a route inside the site without reloading. `search` (with its "?") and `hash` (with its
 * "#") are added to the address: the Play page reads ?modo=, the rules page scrolls to its hash.
 */
export function navigate(route: Route, opts: { replace?: boolean; search?: string; hash?: string } = {}): void {
  const url = urlFor(route) + (opts.search ?? '') + (opts.hash ?? '');
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  enterRoute(route);
}

/** A link target by name, for the few places that only know where to go. */
export function go(name: Exclude<RouteName, 'room' | 'notFound'>): void {
  navigate({ name });
}

/** "Pick another table" and leaving a table land on the Play page. */
export function goPlay(): void {
  navigate({ name: 'play' });
}

/** Switches the language in place: same page, same connection, new text. */
export function setLang(l: Lang): void {
  applyLang(l, true);
  history.replaceState(history.state, '', currentAddress(store.get().route, l));
  store.set({ lang: l });
}

export function boot(): void {
  let l = routeFromPath(location.pathname, location.search).lang;
  // A remembered English choice applies on the bare root address; the browser language never decides.
  if (location.pathname === '/' && savedLang() === 'en') l = 'en';
  applyLang(l, false);
  applyFourColor(store.get().fourColor);
  sound.setEnabled(store.get().soundOn);
  // Pages that wait for the legal texts re-render when a dictionary arrives.
  onLegalLoaded(() => store.set((st) => ({ legalLoads: st.legalLoads + 1 })));
  store.set({ lang: l });
  const route = routeFromLocation();
  // Cross-language slugs (/en/jogar) and the remembered language get their canonical address.
  history.replaceState(null, '', currentAddress(route, l));
  enterRoute(route);
  window.addEventListener('popstate', () => {
    const pl = routeFromPath(location.pathname, location.search).lang;
    if (pl !== store.get().lang) {
      applyLang(pl, false);
      store.set({ lang: pl });
    }
    enterRoute(routeFromLocation());
  });
}

/** The four-color deck switch (sheet and header): a CSS switch, saved in this browser. */
export function setFourColor(on: boolean): void {
  saveFourColor(on);
  store.set({ fourColor: on });
}

/** The sound and vibration switch, saved in this browser. */
export function setSoundOn(on: boolean): void {
  saveSoundOn(on);
  sound.setEnabled(on);
  store.set({ soundOn: on });
}

/** The single key shortcuts (table keys and R), saved in this browser. */
export function setKeysOn(on: boolean): void {
  saveKeysOn(on);
  store.set({ keysOn: on });
}

/** Opens the quick rules dialog (key R, the rules button on a table, the under-18 message). */
export function openRules(): void {
  store.set({ rulesOpen: true, menuOpen: false });
}

async function startMatch(kind: 'solo' | 'room', m: NewMatch): Promise<void> {
  if (store.get().busy) return;
  // Quick play starts a match at once: a refusal of the brake the page still keeps (limit.ts) is
  // shown again without asking the server. A new room starts no match, so it goes ahead.
  const held = kind === 'solo' ? heldLimit() : null;
  if (held) {
    store.set({ homeError: 'limit_reached', homeLimit: held });
    return;
  }
  store.set({ busy: true, homeError: null, homeLimit: null });
  try {
    // The age gate and the notice come before anything reaches the server.
    await ensureReady();
    const { code } = await withCheck(() => (kind === 'solo' ? api.play(m) : api.createRoom(m)));
    store.set({ busy: false });
    navigate({ name: 'room', code });
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'network';
    // The brake refused the match: the page says until when (limit.ts).
    const data = e instanceof ApiError ? (e.data as { limit?: unknown } | null) : null;
    const limit = code === 'limit_reached' ? (readLimit(data?.limit) ?? defaultLimit(Date.now())) : null;
    if (limit) holdLimit(limit);
    store.set({ busy: false, homeError: isGateStop(code) ? null : code, homeLimit: limit });
  }
}

export function playSolo(m: NewMatch): Promise<void> {
  return startMatch('solo', m);
}

export function createRoom(m: NewMatch): Promise<void> {
  return startMatch('room', m);
}

export function joinByCode(raw: string): boolean {
  const code = cleanCode(raw);
  if (!code) {
    store.set({ homeError: 'bad_code' });
    return false;
  }
  navigate({ name: 'room', code });
  return true;
}

/** After the person deleted their data: this browser forgets the room, the age answer and the notice. */
export function forgetLocal(): void {
  rememberRoom(null);
  forgetPerson();
}

export function leaveRoom(): void {
  room?.leave();
  rememberRoom(null);
  goPlay();
}
