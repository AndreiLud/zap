// The game credential: signed, short-lived, and naming its device by a keyed hash of the device
// id, so the cookie never carries the id itself.

import { describe, expect, it } from 'vitest';
import { CRED_TTL_MS, DEVICE_MAX_AGE_S, b64url, cookie, credCookieName, credentialSubject, deviceCookieName, deviceIdFromSecret, fromB64url, newDeviceSecret, signCredential, verifyCredential } from '../src/auth.ts';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 10, 21, 12);

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromB64url(token.slice(0, token.indexOf('.')))));
}

describe('game credential', () => {
  it('names the device by a keyed hash of its id, never the id', async () => {
    const device = await deviceIdFromSecret(newDeviceSecret());
    const subject = await credentialSubject(SECRET, device);
    expect(subject).toMatch(/^[0-9a-f]{32}$/);
    expect(device).not.toContain(subject);
    // The same device gives the same subject; another key or device gives another one.
    expect(await credentialSubject(SECRET, device)).toBe(subject);
    expect(await credentialSubject(`${SECRET}x`, device)).not.toBe(subject);
    expect(await credentialSubject(SECRET, await deviceIdFromSecret(newDeviceSecret()))).not.toBe(subject);

    const token = await signCredential(SECRET, { d: subject, v: NOW, e: NOW + 1000 });
    expect(token).not.toContain(device);
    expect(payloadOf(token)).toEqual({ d: subject, v: NOW, e: NOW + 1000 });
    expect(await verifyCredential(SECRET, token, NOW)).toEqual({ d: subject, v: NOW, e: NOW + 1000 });
  });

  it('refuses a tampered, expired or foreign credential, and the old form that carried the device id', async () => {
    const device = await deviceIdFromSecret(newDeviceSecret());
    const subject = await credentialSubject(SECRET, device);
    const token = await signCredential(SECRET, { d: subject, v: NOW, e: NOW + 1000 });
    expect(await verifyCredential(SECRET, token, NOW + 1000)).toBeNull();
    expect(await verifyCredential('another-secret-0123456789abcdef0123456789', token, NOW)).toBeNull();
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ d: subject, v: NOW, e: NOW + 9e9 })));
    expect(await verifyCredential(SECRET, `${forged}${token.slice(token.indexOf('.'))}`, NOW)).toBeNull();
    const old = await signCredential(SECRET, { d: device, v: NOW, e: NOW + 1000 });
    expect(await verifyCredential(SECRET, old, NOW)).toBeNull();
    for (const bad of [null, undefined, '', 'x', '.', 'a'.repeat(600)]) expect(await verifyCredential(SECRET, bad, NOW)).toBeNull();
  });
});

describe('cookies', () => {
  it('on https: the __Host- prefix, Secure, Path=/ and no Domain, so no sibling site can plant one', () => {
    expect(cookie(deviceCookieName(true), 'v', DEVICE_MAX_AGE_S, true)).toBe('__Host-zap_device=v; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure');
    expect(cookie(credCookieName(true), 'v', CRED_TTL_MS / 1000, true)).toBe('__Host-zap_cred=v; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax; Secure');
    for (const c of [cookie(deviceCookieName(true), 'v', 1, true), cookie(credCookieName(true), 'v', 1, true)]) expect(c).not.toMatch(/domain=/i);
  });

  it('on http (the local sites): plain names, without Secure', () => {
    expect(cookie(deviceCookieName(false), 'v', DEVICE_MAX_AGE_S, false)).toBe('zap_device=v; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax');
    expect(cookie(credCookieName(false), 'v', CRED_TTL_MS / 1000, false)).toBe('zap_cred=v; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax');
  });
});
