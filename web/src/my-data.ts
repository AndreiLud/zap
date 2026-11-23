// "Baixar meus dados": the browser builds one JSON file from /api/me/data and the record of every
// match this device sat in (/api/me/matches/:id), fetched in batches of 10.

import type { MatchRecord } from '../../shared/match-record.ts';
import { CODE_ALPHABET } from '../../shared/protocol.ts';
import { ApiError, api, type MyData } from './api.ts';
import { withCheck } from './check.ts';

export const DOWNLOAD_BATCH = 10;
export const MY_DATA_FORMAT = 'zap-my-data/1';

export interface MyDataFile {
  format: typeof MY_DATA_FORMAT;
  generatedAt: string;
  /** What the server keeps about this device. */
  data: MyData;
  /** The full record of each match, with the seat that was this device's. */
  matches: { matchId: string; yourSeat: number | null; record: MatchRecord | null }[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The record of one match this device sat in, as stored ("zap-match/1" or "/2"), with the seat that
 * was this device's. A record the server no longer has comes back as null; the per-minute limit is
 * waited out. Shared by the download and "You against Zap" (web/src/you-vs-zap/).
 */
export async function fetchRecord(matchId: string): Promise<MyDataFile['matches'][number]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await withCheck(() => api.matchRecord(matchId));
      return { matchId, yourSeat: r.yourSeat, record: r.record };
    } catch (e) {
      // A record the server no longer has stays in the file as missing, so the list is complete.
      if (e instanceof ApiError && e.code === 'not_found') return { matchId, yourSeat: null, record: null };
      // Very long histories can meet the per-minute limit: wait and go on. A block by the zone's
      // rate limiting rule (DEPLOY.md section 5.5) answers 429 with a page that is not JSON.
      if (e instanceof ApiError && (e.code === 'too_many' || e.code === 'http_429') && attempt < 12) {
        await wait(5_000);
        continue;
      }
      throw e;
    }
  }
}

export async function collectMyData(onProgress: (done: number, total: number) => void): Promise<MyDataFile> {
  const data = await withCheck(() => api.myData());
  const total = data.matches.length;
  const matches: MyDataFile['matches'] = [];
  onProgress(0, total);
  for (let i = 0; i < total; i += DOWNLOAD_BATCH) {
    const batch = data.matches.slice(i, i + DOWNLOAD_BATCH);
    matches.push(...(await Promise.all(batch.map((m) => fetchRecord(m.matchId)))));
    onProgress(matches.length, total);
  }
  return { format: MY_DATA_FORMAT, generatedAt: new Date(data.generatedAt).toISOString(), data, matches };
}

/** Hands the file to the browser as a download. */
export function saveJson(file: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A recovery code as typed (any case, spaces or dashes) to its 20 characters, or null. */
export function cleanRecoveryCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s-]+/g, '');
  return c.length === 20 && [...c].every((x) => CODE_ALPHABET.includes(x)) ? c : null;
}
