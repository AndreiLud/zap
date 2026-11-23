// The only sites the simulated players may reach: the two local wrangler dev sites, by compose
// service name or loopback address. Anything else stops the run before any request.

export const ALLOWED_BASES = [
  'http://dev:8787',
  'http://dev-e2e:8788',
  'http://127.0.0.1:8787',
  'http://127.0.0.1:8788',
  'http://localhost:8787',
  'http://localhost:8788',
] as const;

/** The base without a trailing slash when it is allowed, or null. */
export function checkedBase(base: string | undefined): string | null {
  const b = (base ?? '').replace(/\/+$/, '');
  return (ALLOWED_BASES as readonly string[]).includes(b) ? b : null;
}
