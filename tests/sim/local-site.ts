// Small tools of the local end to end proof (tests/sim/cycle-e2e.sh) on the R2 files of a local
// site, through worker/dev/local-r2.ts (only .wrangler/state and .wrangler/e2e-state of this
// project, only zap-events and zap-models):
//
//   node tests/sim/local-site.ts models --state dev            list zap-models
//   node tests/sim/local-site.ts clear-models --state dev      delete every object of zap-models
//   node tests/sim/local-site.ts status --state dev --value ok|failed --age-days N --message TEXT
//                                                              put a valid status/training.json
//   node tests/sim/local-site.ts receipt --state dev           today's receipt, one JSON line
//   node tests/sim/local-site.ts export --state dev            today's export: rows, flagged rows, groups
//   node tests/sim/local-site.ts reading --base http://dev:8787
//                                                              a new person's "How Zap reads you" (priors source)

import { STATUS_KEY, SCHEMAS, exportKey, receiptKey, utcDate, validateStatus, type TrainingStatus } from '../../shared/cycle-formats.ts';
import { openLocalR2 } from '../../worker/dev/local-r2.ts';
import { checkedBase } from '../../training/cycle/sim/base.ts';

const STATES: Record<string, string> = { dev: '.wrangler/state', e2e: '.wrangler/e2e-state' };
const JSON_TYPE = 'application/json; charset=utf-8';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function stateDir(): string {
  const s = STATES[arg('state', 'dev')];
  if (!s) {
    console.error('--state must be dev or e2e');
    process.exit(2);
  }
  return s;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'reading') {
    const base = checkedBase(arg('base'));
    if (!base) {
      console.error('reading: only a local site');
      process.exit(2);
    }
    const jar: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: { origin: base, 'cf-connecting-ip': '198.18.250.1', 'content-type': 'application/json', cookie: jar.join('; ') },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) jar.push(c.split(';')[0]);
      return { status: res.status, body: (await res.json()) as any };
    };
    const s = await call('POST', '/api/session', { token: 'XXXX.DUMMY.TOKEN.XXXX', adult: true });
    if (s.status !== 200) throw new Error(`session ${s.status}`);
    const r = await call('GET', '/api/me/reading');
    console.log(JSON.stringify({ status: r.status, priors: r.body.priors, population: Object.fromEntries((r.body.numbers ?? []).map((n: any) => [n.key, n.population])), source: Object.fromEntries((r.body.numbers ?? []).map((n: any) => [n.key, n.source])) }));
    // This device leaves nothing behind.
    await call('POST', '/api/me/delete', { token: 'XXXX.DUMMY.TOKEN.XXXX' });
    return;
  }
  const dir = stateDir();
  if (cmd === 'models' || cmd === 'clear-models' || cmd === 'status') {
    const r2 = await openLocalR2(dir, 'zap-models');
    try {
      if (cmd === 'models') {
        for (const o of await r2.list('')) console.log(`${o.key} ${o.size}`);
      } else if (cmd === 'clear-models') {
        const keys = (await r2.list('')).map((o) => o.key);
        for (const k of keys) await r2.delete(k);
        console.log(JSON.stringify({ deleted: keys.length, keys }));
      } else {
        const now = Date.now();
        const value = arg('value', 'ok') as TrainingStatus['state'];
        const updatedAt = now - Number(arg('age-days', '0')) * 86_400_000;
        const status: TrainingStatus = {
          schema: SCHEMAS.status,
          state: value,
          startedAt: updatedAt - 3_600_000,
          finishedAt: value === 'running' ? null : updatedAt,
          updatedAt,
          cycleId: null,
          step: 'idle',
          lastPromotion: null,
          message: arg('message', 'Status written by the local end to end proof.'),
        };
        const checked = validateStatus(status);
        if (!checked.ok) throw new Error(checked.errors.join('; '));
        await r2.put(STATUS_KEY, JSON.stringify(status), JSON_TYPE);
        console.log(JSON.stringify({ put: STATUS_KEY, state: status.state, updatedAt: new Date(updatedAt).toISOString() }));
      }
    } finally {
      await r2.close();
    }
    return;
  }
  if (cmd === 'receipt' || cmd === 'export') {
    const r2 = await openLocalR2(dir, 'zap-events');
    try {
      const date = utcDate(Date.now());
      const body = await r2.get(cmd === 'receipt' ? receiptKey(date) : exportKey(date));
      if (!body) {
        console.log(JSON.stringify({ missing: cmd === 'receipt' ? receiptKey(date) : exportKey(date) }));
        process.exit(1);
      }
      const j = JSON.parse(decode(body));
      if (cmd === 'receipt') console.log(JSON.stringify({ date: j.date, jobs: j.jobs }));
      else {
        const rows = j.rows as { matchId: string; flagged: boolean; weight: number; group: string; noAdapt: boolean; openDataOptOut: boolean }[];
        const flagged = rows.filter((r) => r.flagged);
        console.log(
          JSON.stringify({
            date: j.date,
            partial: j.partial,
            rows: rows.length,
            groups: new Set(rows.map((r) => r.group)).size,
            noAdapt: rows.filter((r) => r.noAdapt).length,
            openDataOptOut: rows.filter((r) => r.openDataOptOut).length,
            flaggedRows: flagged.length,
            flaggedWeights: [...new Set(flagged.map((r) => r.weight))],
            flaggedMatchIds: flagged.map((r) => r.matchId),
            reports: j.reports.length,
          }),
        );
      }
    } finally {
      await r2.close();
    }
    return;
  }
  console.error('usage: local-site.ts models|clear-models|status|receipt|export --state dev|e2e, or reading --base URL');
  process.exit(1);
}

await main();
