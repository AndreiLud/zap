// Local development is told apart from the public site by the host name: the public hostname over
// plain http is refused outright, and the human check never runs there with Cloudflare's test keys.

import { describe, expect, it } from 'vitest';
import { httpsRequired, isLocalHost, secretsReady } from '../src/site-guard.ts';

const SESSION_SECRET = 's'.repeat(40);
const LOCAL = { SESSION_SECRET, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_HOSTNAMES: '' };
// Made-up values in the production format (0x4AAAAAAA and filler), used only to test that real keys are told apart from test keys.
const REAL = { SESSION_SECRET, TURNSTILE_SECRET_KEY: '0x4AAAAAAA' + 'X'.repeat(27), TURNSTILE_SITE_KEY: '0x4AAAAAAA' + 'Y'.repeat(14), TURNSTILE_HOSTNAMES: 'zap.andreiludescher.com' };
const PUBLIC = ['zap.andreiludescher.com', 'zap.example.workers.dev', 'example.com', '203.0.113.9', '[2001:db8::1]'];
const LOCALS = ['127.0.0.1', '127.1.2.3', 'localhost', 'zap.localhost', '[::1]', 'dev', 'dev-e2e', '10.0.0.5', '172.16.0.2', '172.31.255.1', '192.168.1.20'];

const url = (protocol: string, host: string) => new URL(`${protocol}//${host}/api/session`);

describe('public site or local development', () => {
  it('local hosts are loopback, private addresses, .localhost names and single labels; nothing else', () => {
    for (const h of LOCALS) expect(isLocalHost(new URL(`http://${h}/`).hostname), h).toBe(true);
    for (const h of [...PUBLIC, '172.32.0.1', '11.0.0.1', '192.169.0.1']) expect(isLocalHost(new URL(`http://${h}/`).hostname), h).toBe(false);
    expect(isLocalHost('')).toBe(false);
  });

  it('the API on a public host needs https; local development keeps plain http', () => {
    for (const h of PUBLIC) {
      expect(httpsRequired(url('http:', h)), h).toBe(true);
      expect(httpsRequired(url('https:', h)), h).toBe(false);
    }
    for (const h of LOCALS) expect(httpsRequired(url('http:', h)), h).toBe(false);
  });

  it('the human check runs with test keys only on a local host over http', () => {
    for (const h of LOCALS) expect(secretsReady(LOCAL, url('http:', h)), h).toBe(true);
    for (const h of PUBLIC) {
      // The test keys are refused on the public site whatever the protocol (the http case is the one that slipped through before).
      expect(secretsReady(LOCAL, url('http:', h)), `http ${h}`).toBe(false);
      expect(secretsReady(LOCAL, url('https:', h)), `https ${h}`).toBe(false);
      // Real keys work over https only.
      expect(secretsReady(REAL, url('https:', h)), `https ${h}`).toBe(true);
      expect(secretsReady(REAL, url('http:', h)), `http ${h}`).toBe(false);
    }
    // https is the public setup even on a local name.
    expect(secretsReady(LOCAL, url('https:', 'localhost'))).toBe(false);
    expect(secretsReady(REAL, url('https:', 'localhost'))).toBe(true);
  });

  it('missing or weak secrets, a test site key or an empty hostname list stop the check', () => {
    const https = url('https:', 'zap.andreiludescher.com');
    const http = url('http:', 'dev');
    for (const env of [{ ...LOCAL, SESSION_SECRET: '' }, { ...LOCAL, SESSION_SECRET: 'short' }, { ...LOCAL, TURNSTILE_SECRET_KEY: '' }]) expect(secretsReady(env, http)).toBe(false);
    expect(secretsReady({ ...REAL, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }, https)).toBe(false);
    expect(secretsReady({ ...REAL, TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' }, https)).toBe(false);
    expect(secretsReady({ ...REAL, TURNSTILE_HOSTNAMES: '  ' }, https)).toBe(false);
    expect(secretsReady({ ...REAL, TURNSTILE_HOSTNAMES: undefined }, https)).toBe(false);
  });
});
