// Where the API runs as the public site, and whether the human check may run there. Local
// development is told apart by the host name, never by the protocol alone: a request that names
// a public host over plain http must not pass for local development.

import { isTestKey } from './turnstile.ts';

/**
 * A host only local development uses: loopback, a private network address, a name under
 * .localhost, or a single label such as a Docker Compose service (dev, dev-e2e). The public site
 * (PUBLIC_ORIGIN), the Worker's workers.dev address and any other domain are none of these.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const a = Number(ip[1]);
    const b = Number(ip[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return h !== '' && !h.includes('.') && !h.includes(':');
}

/**
 * The API on a public host over plain http: refused before anything else, since its cookies would
 * travel without Secure and without the __Host- prefix. Always Use HTTPS (DEPLOY.md) normally
 * stops such a request before the Worker.
 */
export function httpsRequired(url: URL): boolean {
  return url.protocol !== 'https:' && !isLocalHost(url.hostname);
}

export interface CheckSecrets {
  SESSION_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_HOSTNAMES?: string;
}

/**
 * The human check can run: both secrets set and, unless this is local development over http, a
 * real Turnstile key pair and a hostname list over https, never the test keys (DEPLOY.md).
 */
export function secretsReady(env: CheckSecrets, url: URL): boolean {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.TURNSTILE_SECRET_KEY) return false;
  if (url.protocol === 'http:' && isLocalHost(url.hostname)) return true;
  return url.protocol === 'https:' && !isTestKey(env.TURNSTILE_SECRET_KEY) && !isTestKey(env.TURNSTILE_SITE_KEY) && Boolean(env.TURNSTILE_HOSTNAMES?.trim());
}
