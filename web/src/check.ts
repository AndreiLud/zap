// The human check: a dialog shows the Turnstile widget.
//
// * For play (purpose "play"): when the server answers check_needed, the token goes to
//   /api/session; after the server accepts it, the action that asked for the check runs again.
// * For "delete" and "recover" on the You page (/voce): a fresh token for that one action, handed to
//   the caller, which sends it with its request.

import { ApiError, api } from './api.ts';
import { store, type CheckPurpose } from './store.ts';

type Pending<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void };

function deferred<T>(): Pending<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let pending: Pending<void> | null = null;
let pendingToken: Pending<string> | null = null;

/** Credential known to be valid until this time (from /api/session or /api/me). */
let verifiedUntil = 0;

export function noteVerifiedUntil(t: number | null): void {
  verifiedUntil = t ?? 0;
}

/** True when this device holds a game credential for at least a few more seconds. */
export async function hasCredential(): Promise<boolean> {
  if (verifiedUntil > Date.now() + 10_000) return true;
  try {
    const me = await api.me();
    noteVerifiedUntil(me.verifiedUntil);
  } catch {
    return false;
  }
  return verifiedUntil > Date.now() + 10_000;
}

export function requestHumanCheck(): Promise<void> {
  if (pending) return pending.promise;
  pendingToken?.reject(new ApiError('check_cancelled', 0));
  pendingToken = null;
  pending = deferred<void>();
  store.set({ check: { open: true, failed: false, purpose: 'play' } });
  return pending.promise;
}

/** A fresh Turnstile token for one sensitive action (delete, recover). */
export function requestToken(purpose: Exclude<CheckPurpose, 'play'>): Promise<string> {
  if (pending) return Promise.reject(new ApiError('check_busy', 0));
  pendingToken?.reject(new ApiError('check_cancelled', 0));
  pendingToken = deferred<string>();
  store.set({ check: { open: true, failed: false, purpose } });
  return pendingToken.promise;
}

/** Called by the dialog with a Turnstile token. Returns false when the server refused it. */
export async function submitToken(token: string): Promise<boolean> {
  const purpose = store.get().check.purpose;
  if (purpose !== 'play') {
    const p = pendingToken;
    pendingToken = null;
    store.set({ check: { open: false, failed: false, purpose } });
    p?.resolve(token);
    return true;
  }
  try {
    const r = await api.session(token);
    noteVerifiedUntil(r.verifiedUntil);
  } catch {
    store.set({ check: { open: true, failed: true, purpose } });
    return false;
  }
  store.set({ check: { open: false, failed: false, purpose } });
  const p = pending;
  pending = null;
  p?.resolve();
  return true;
}

export function widgetFailed(): void {
  store.set((s) => ({ check: { ...s.check, open: true, failed: true } }));
}

export function cancelCheck(): void {
  store.set((s) => ({ check: { ...s.check, open: false, failed: false } }));
  const p = pending;
  const q = pendingToken;
  pending = null;
  pendingToken = null;
  p?.reject(new ApiError('check_cancelled', 0));
  q?.reject(new ApiError('check_cancelled', 0));
}

/** Runs an API call; on check_needed, asks for the human check and runs it once more. */
export async function withCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'check_needed') {
      await requestHumanCheck();
      return fn();
    }
    throw e;
  }
}
