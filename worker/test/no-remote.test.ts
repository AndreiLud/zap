// Simulated data never reaches production (contract 4.5): the local sites run wrangler dev with
// local bindings only, test records are marked by a variable that lives only in .dev.vars, and
// the configuration names the production buckets the cycle reads.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUCKETS } from '../../shared/cycle-formats.ts';

/** wrangler.jsonc parsed: comments outside strings and trailing commas removed. */
function wranglerConfig(): Record<string, any> {
  const src = readFileSync('wrangler.jsonc', 'utf8');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      const start = i;
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
      out += src.slice(start, i + 1);
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Every key anywhere in a JSON value. */
function keys(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) keys(v, out);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) out.push(k, ...keys(v, []));
  return out;
}

/** The command line of one service in docker-compose.yml. */
function composeCommand(service: string): string {
  const lines = readFileSync('docker-compose.yml', 'utf8').split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  expect(start, service).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^  \S/.test(l)) break;
    body.push(l);
  }
  const cmd = body.find((l) => l.trim().startsWith('command:'));
  expect(cmd, `${service} command`).toBeDefined();
  return cmd!;
}

describe('no remote binding, no test variable in production', () => {
  const cfg = wranglerConfig();

  it('wrangler.jsonc has no "remote" key and the dev sites never pass --remote', () => {
    expect(keys(cfg)).not.toContain('remote');
    for (const service of ['dev', 'dev-e2e']) {
      const cmd = composeCommand(service);
      expect(cmd).toContain('wrangler dev');
      expect(cmd).not.toContain('--remote');
      expect(cmd).toMatch(/--persist-to \.wrangler\/(state|e2e-state)/);
    }
  });

  it('TEST_RECORDS and MANIFEST_TTL_S live only in .dev.vars.example, never in wrangler.jsonc', () => {
    const vars = cfg.vars as Record<string, string>;
    expect(Object.keys(vars)).not.toContain('TEST_RECORDS');
    expect(Object.keys(vars)).not.toContain('MANIFEST_TTL_S');
    expect(JSON.stringify(cfg)).not.toContain('TEST_RECORDS');
    const example = readFileSync('.dev.vars.example', 'utf8');
    expect(example).toMatch(/^TEST_RECORDS=true$/m);
    expect(example).toMatch(/^MANIFEST_TTL_S=\d+$/m);
  });

  it('binds the production buckets, the email sender without a destination, and keeps the one daily cron', () => {
    expect(cfg.r2_buckets).toEqual([
      { binding: 'EVENTS', bucket_name: BUCKETS.events },
      { binding: 'MODELS', bucket_name: BUCKETS.models },
      { binding: 'PUBLIC', bucket_name: BUCKETS.public },
    ]);
    expect(cfg.send_email).toEqual([{ name: 'EMAIL' }]);
    // Empty in the repository until the owner fills it (DEPLOY.md section 1.6): only an address on the zone.
    expect(cfg.vars.ALERT_FROM).toMatch(/^$|^[^@\s]+@andreiludescher\.com$/);
    expect(JSON.stringify(cfg)).not.toContain('ALERT_EMAIL');
    expect(cfg.vars.AI_MODE).toBe('net');
    expect(cfg.vars.AI_ADAPT).toBe('off');
    expect(cfg.triggers).toEqual({ crons: ['0 4 * * *'] });
  });
});
