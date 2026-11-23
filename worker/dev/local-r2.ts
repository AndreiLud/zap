// The R2 buckets of a local site (wrangler dev), opened from Node with Miniflare, the engine
// wrangler dev itself runs, on the same files. Used by the local bridge of the training cycle
// (training/cycle/bridge/) and by the integration tests: list the match records a local site
// wrote, put a manifest and models it will serve, put the summary.json the data page reads.
//
// It opens only the persisted state of this project's two local sites (.wrangler/state for "dev",
// .wrangler/e2e-state for "dev-e2e") and only the buckets zap-events, zap-models and zap-public,
// so it can never reach anything remote.
//
// From the command line (the e2e suite places its summary fixtures this way):
//
//   docker compose run --rm -T node node worker/dev/local-r2.ts put-summary <file> [--state .wrangler/e2e-state] [--unchecked]
//   docker compose run --rm -T node node worker/dev/local-r2.ts delete-summary [--state .wrangler/e2e-state]
//
// put-summary refuses a file that validateSummary refuses, unless --unchecked (to test the
// site's answer to a broken file). The state defaults to .wrangler/state (the "dev" site).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUMMARY_KEY, parseChecked, validateSummary } from '../../shared/cycle-formats.ts';

export interface LocalR2 {
  list(prefix: string): Promise<{ key: string; size: number; etag: string }[]>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

export const LOCAL_STATES = ['.wrangler/state', '.wrangler/e2e-state'] as const;
export const LOCAL_BUCKETS = ['zap-events', 'zap-models', 'zap-public'] as const;
export type LocalBucket = (typeof LOCAL_BUCKETS)[number];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * workerd refuses to start without CA certificates, which the plain Node image lacks (the site's
 * image installs them). Node's own root list, written under .cache/, stands in for them. Nothing
 * here connects anywhere: the certificates only let the runtime start.
 */
async function loadMiniflare(): Promise<typeof import('miniflare')> {
  if (!existsSync('/etc/ssl/certs/ca-certificates.crt') && !process.env.NODE_EXTRA_CA_CERTS) {
    const dir = resolve(ROOT, '.cache/local-r2');
    mkdirSync(dir, { recursive: true });
    const pem = resolve(dir, 'node-root-certificates.pem');
    writeFileSync(pem, rootCertificates.join('\n') + '\n');
    process.env.NODE_EXTRA_CA_CERTS = pem;
    process.env.SSL_CERT_FILE = pem;
  }
  return import('miniflare');
}

/** The persisted state folder of a local site, or an error for anything else. */
export function checkedStateDir(persistDir: string): string {
  const abs = resolve(ROOT, persistDir);
  if (!LOCAL_STATES.some((s) => resolve(ROOT, s) === abs)) throw new Error(`local-r2: refused ${persistDir} (only ${LOCAL_STATES.join(' or ')} of this project)`);
  return abs;
}

export async function openLocalR2(persistDir: string, bucket: LocalBucket): Promise<LocalR2> {
  const dir = checkedStateDir(persistDir);
  if (!(LOCAL_BUCKETS as readonly string[]).includes(bucket)) throw new Error(`local-r2: refused bucket ${String(bucket)}`);
  const { Miniflare, convertV4MiniflareOptions } = await loadMiniflare();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } }',
      resourcePersistencePath: resolve(dir, 'v3'),
      r2Buckets: { BUCKET: bucket },
    }),
  );
  const b = await mf.getR2Bucket('BUCKET');
  return {
    async list(prefix) {
      const out: { key: string; size: number; etag: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await b.list({ prefix, cursor, limit: 1000 });
        for (const o of page.objects) out.push({ key: o.key, size: o.size, etag: o.etag });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async get(key) {
      const o = await b.get(key);
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async put(key, body, contentType) {
      await b.put(key, body, { httpMetadata: { contentType } });
    },
    async delete(key) {
      await b.delete(key);
    },
    close: () => mf.dispose(),
  };
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Puts summary.json in a local site's public bucket; a file validateSummary refuses only with `unchecked`. */
export async function putSummary(persistDir: string, body: string, unchecked = false): Promise<void> {
  if (!unchecked) {
    const c = parseChecked('summary', body, validateSummary);
    if (!c.ok) throw new Error(`local-r2: summary refused (${c.errors.slice(0, 3).join('; ')}); pass --unchecked to put it anyway`);
  }
  const r2 = await openLocalR2(persistDir, 'zap-public');
  try {
    await r2.put(SUMMARY_KEY, body, JSON_TYPE);
  } finally {
    await r2.close();
  }
}

/** Removes summary.json from a local site's public bucket (the site then answers no_summary). */
export async function deleteSummary(persistDir: string): Promise<void> {
  const r2 = await openLocalR2(persistDir, 'zap-public');
  try {
    await r2.delete(SUMMARY_KEY);
  } finally {
    await r2.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const state = flag('--state') ?? LOCAL_STATES[0];
  const [cmd, file] = argv;
  if (cmd === 'put-summary' && file && !file.startsWith('--')) {
    await putSummary(state, readFileSync(file, 'utf8'), argv.includes('--unchecked'));
    console.log(`summary.json put in ${state} (zap-public)`);
  } else if (cmd === 'delete-summary') {
    await deleteSummary(state);
    console.log(`summary.json removed from ${state} (zap-public)`);
  } else {
    console.error('usage: local-r2.ts put-summary <file> [--state DIR] [--unchecked] | delete-summary [--state DIR]');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  });
}
