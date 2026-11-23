// The guided match's engine, in a module Web Worker (see engine-host.ts). Requests and replies are
// plain data, answered in order: { id, req } in, { id, reply } out.

import { createHost, type GuidedRequest } from './engine-host.ts';

const handle = createHost();

self.onmessage = (e: MessageEvent<{ id: number; req: GuidedRequest }>) => {
  const { id, req } = e.data;
  self.postMessage({ id, reply: handle(req) });
};
