// Device identity and the short-lived game credential.
//
// * zap_device: a random 128-bit secret in an HttpOnly cookie. The server only ever stores its
//   SHA-256 hash (the device id). Losing the cookie loses the history; there is no login.
// * zap_cred: a signed credential (HMAC-SHA-256 with SESSION_SECRET) that says this device passed
//   the human check (Turnstile) at a given time. It lasts 2 hours. The WebSocket accepts only
//   this credential, never the device secret itself. It names the device by a keyed hash of the
//   device id (credentialSubject), so the cookie does not carry the id itself.

export const DEVICE_COOKIE = 'zap_device';
export const CRED_COOKIE = 'zap_cred';

/**
 * On https the cookies use the __Host- prefix: the browser then refuses any version set from
 * another subdomain (Domain attribute) or without Secure, so a sibling site cannot plant one.
 */
export const deviceCookieName = (secure: boolean) => (secure ? `__Host-${DEVICE_COOKIE}` : DEVICE_COOKIE);
export const credCookieName = (secure: boolean) => (secure ? `__Host-${CRED_COOKIE}` : CRED_COOKIE);
export const CRED_TTL_MS = 2 * 3600_000;
export const DEVICE_MAX_AGE_S = 400 * 24 * 3600;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacKey(secret: string): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message)));
}

export function newDeviceSecret(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b64url(b);
}

/** The device id stored server side: SHA-256 of the cookie secret. */
export async function deviceIdFromSecret(secret: string): Promise<string> {
  return sha256Hex(`zap-device:${secret}`);
}

export interface Credential {
  /** credentialSubject() of the device id: 32 hex characters, never the id itself. */
  d: string;
  /** When the human check passed (ms). */
  v: number;
  /** Expiry (ms). */
  e: number;
}

export async function signCredential(secret: string, c: Credential): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(c)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** How a credential names its device: a keyed hash of the device id, checked by recomputing it. */
export async function credentialSubject(secret: string, device: string): Promise<string> {
  return (await hmacHex(secret, `cred:${device}`)).slice(0, 32);
}

/** Returns the credential if the signature is valid and it has not expired; null otherwise. */
export async function verifyCredential(secret: string, token: string | null | undefined, now: number): Promise<Credential | null> {
  if (!token || token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let sig: Uint8Array;
  try {
    sig = fromB64url(token.slice(dot + 1));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(payload));
  if (!ok) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Credential;
    if (typeof c.d !== 'string' || !/^[0-9a-f]{32}$/.test(c.d) || typeof c.e !== 'number' || typeof c.v !== 'number') return null;
    return c.e > now ? c : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Rate-limit key for an IP that is never stored: HMAC of the IP with a salt that changes every day. */
export async function ipKey(secret: string, ip: string, now: number): Promise<string> {
  const day = Math.floor(now / 86_400_000);
  return (await hmacHex(`${secret}:ip:${day}`, ip)).slice(0, 32);
}
