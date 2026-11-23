// Runs the daily Cron Trigger of a local site once: wrangler dev serves the scheduled handler at
// /cdn-cgi/handler/scheduled with no extra flag. Only local sites.
//
//   docker compose run --rm -T node node worker/dev/trigger-cron.ts --base http://dev-e2e:8788

import { request } from 'node:http';
import { isLocalHost } from '../src/site-guard.ts';

const i = process.argv.indexOf('--base');
const base = (i >= 0 ? process.argv[i + 1] : 'http://dev:8787') ?? '';
let url: URL;
try {
  url = new URL('/cdn-cgi/handler/scheduled?cron=0+4+*+*+*', base);
} catch {
  console.error(`trigger-cron: bad --base ${base}`);
  process.exit(2);
}
if (url.protocol !== 'http:' || !isLocalHost(url.hostname)) {
  console.error(`trigger-cron: refused ${base}: only a local site over http`);
  process.exit(2);
}
// wrangler dev answers /cdn-cgi/ only for a localhost Host header, so the request names
// localhost while it goes to the compose service (dev, dev-e2e) or the loopback address.
const answer = await new Promise<{ status: number; body: string }>((done, fail) => {
  const req = request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, headers: { host: `localhost:${url.port || 80}` } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => (body += c));
    res.on('end', () => done({ status: res.statusCode ?? 0, body: body.trim() }));
  });
  req.on('error', fail);
  req.end();
});
console.log(JSON.stringify({ base, status: answer.status, body: answer.body.slice(0, 200) }));
process.exit(answer.status === 200 ? 0 : 1);
