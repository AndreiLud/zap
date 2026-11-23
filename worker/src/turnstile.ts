// Server-side check of a Turnstile token (Siteverify). Tokens last 300 s and can be used once.
// The visitor's IP is not sent: the check works without it and the project avoids handling IPs.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare's Turnstile test keys, site or secret (1x00000000000000000000AA and the like): they
 * pass or fail anyone, answer without an action, and belong only on a local http site.
 */
export function isTestKey(key: string | undefined): boolean {
  return /^[123]x0+[A-Z]{2}$/.test(key ?? '');
}

export interface TurnstileResult {
  ok: boolean;
  errors: string[];
  hostname?: string;
  action?: string;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  opts: { expectedHostnames?: string[]; expectedAction?: string; fetcher?: typeof fetch } = {},
): Promise<TurnstileResult> {
  if (!token || token.length > 2048) return { ok: false, errors: ['missing-input-response'] };
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  body.append('idempotency_key', crypto.randomUUID());
  type Answer = { success?: boolean; 'error-codes'?: string[]; hostname?: string; action?: string };
  let data: Answer;
  try {
    const res = await (opts.fetcher ?? fetch)(SITEVERIFY_URL, { method: 'POST', body });
    data = (await res.json()) as Answer;
  } catch {
    return { ok: false, errors: ['siteverify-unreachable'] };
  }
  const errors = data['error-codes'] ?? [];
  if (!data.success) return { ok: false, errors, hostname: data.hostname, action: data.action };
  // In production TURNSTILE_HOSTNAMES lists the site's hosts; in development it is empty (test keys).
  if (opts.expectedHostnames && opts.expectedHostnames.length > 0 && !opts.expectedHostnames.includes(data.hostname ?? '')) {
    return { ok: false, errors: ['hostname-mismatch'], hostname: data.hostname };
  }
  if (opts.expectedAction && data.action !== opts.expectedAction) {
    return { ok: false, errors: ['action-mismatch'], action: data.action };
  }
  return { ok: true, errors: [], hostname: data.hostname, action: data.action };
}
