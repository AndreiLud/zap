// The age gate and the notice, asked before anything that reaches the server about the person:
// the first match, a room, joining by code or invite, and the actions of the You page (/voce).
//
// The gate is a neutral question (birth year, no default). Only "adult" is remembered, in this
// browser; the year never leaves the page. A person under 18 sees a kind message, can read the
// rules and the legal pages, and nothing about them is sent. The notice comes once per version,
// before the first match.

import { ApiError, api } from './api.ts';
import { ADULT_KEY, NOTICE_KEY, NOTICE_VERSION, noticeVersion } from './consent-keys.ts';
import { loadLegal } from './i18n.ts';
import { store, type GateStep } from './store.ts';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the answer lasts for this page only (kept below).
  }
}

// When storage is blocked, the answers last for this page.
let adultHere = false;
let noticeHere = false;

export function isAdult(): boolean {
  return adultHere || read(ADULT_KEY) === '1';
}

/** The notice version this site asks for: "+ads" while /api/config reports ads on (CLIENT-SPEC 16.6). */
let wanted = NOTICE_VERSION;

async function currentNoticeVersion(): Promise<string> {
  try {
    const ads = ((await api.config()) as { ads?: unknown }).ads;
    return noticeVersion(Boolean(ads) && typeof ads === 'object');
  } catch {
    // No answer: ads cannot be on in this page either (ads/index.ts reads the same config).
    return NOTICE_VERSION;
  }
}

export function noticeSeen(): boolean {
  return noticeHere || read(NOTICE_KEY) === wanted;
}

/** After "Apagar meus dados": this browser starts from zero, so it asks again. */
export function forgetPerson(): void {
  adultHere = false;
  noticeHere = false;
  write(ADULT_KEY, null);
  write(NOTICE_KEY, null);
}

let pending: { step: 'age' | 'notice'; promise: Promise<void>; resolve(): void; reject(e: Error): void } | null = null;

function openGate(step: 'age' | 'notice'): Promise<void> {
  if (pending) {
    if (pending.step === step) return pending.promise;
    // Another question is open: ask this one after it.
    return pending.promise.then(() => (step === 'age' ? ensureAdult() : ensureNotice()));
  }
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const p = { step, promise, resolve, reject };
  pending = p;
  // The gate and the notice speak with the legal texts, which load on demand (i18n.ts).
  loadLegal().then(
    () => {
      if (pending === p) store.set({ gate: step });
    },
    () => {
      if (pending === p) settle(false, 'network');
    },
  );
  return promise;
}

function settle(ok: boolean, code = ''): void {
  const p = pending;
  pending = null;
  if (!p) return;
  if (ok) p.resolve();
  else p.reject(new ApiError(code, 0));
}

/** Resolves once the person declared being 18 or older (asks only the first time). */
export function ensureAdult(): Promise<void> {
  return isAdult() ? Promise.resolve() : openGate('age');
}

/** Resolves once the person read the current notice (shows it only the first time, and again when ads turn on). */
export async function ensureNotice(): Promise<void> {
  // The version first: someone who read the notice before ads were on reads it again.
  const v = await currentNoticeVersion();
  if (v !== wanted) {
    wanted = v;
    noticeHere = false;
  }
  if (!noticeSeen()) await openGate('notice');
}

/** Before a match: the age gate, then the notice. */
export async function ensureReady(): Promise<void> {
  await ensureAdult();
  await ensureNotice();
}

/** The gate's answer. Under 18, the dialog stays open with the message and the action stops. */
export function answerAge(adult: boolean): void {
  if (adult) {
    adultHere = true;
    write(ADULT_KEY, '1');
    store.set({ gate: 'closed' });
    settle(true);
  } else {
    store.set({ gate: 'under' });
    settle(false, 'age_under');
  }
}

export function acceptNotice(): void {
  noticeHere = true;
  write(NOTICE_KEY, wanted);
  store.set({ gate: 'closed' });
  settle(true);
}

/** Closes the gate without an answer (Esc, Cancelar) or after the under-18 message. */
export function closeGate(): void {
  store.set({ gate: 'closed' as GateStep });
  settle(false, 'gate_cancelled');
}

/** The codes a stopped gate leaves behind: nothing went wrong, so nothing to show. */
export function isGateStop(code: string): boolean {
  return code === 'age_under' || code === 'gate_cancelled' || code === 'check_cancelled';
}
