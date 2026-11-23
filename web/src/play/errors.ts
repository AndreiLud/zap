// What the Play page says when a match or a room could not start (moved from the old home page).

import type { LimitInfo } from '../../../shared/protocol.ts';
import { t, type Key } from '../i18n.ts';
import { defaultLimit, limitText } from '../limit.ts';

const ERRORS: Record<string, Key> = {
  blocked: 'error.blocked',
  too_many: 'error.too_many',
  too_many_rooms: 'error.too_many_rooms',
  room_failed: 'error.room_failed',
  bad_settings: 'error.bad_settings',
  bad_code: 'error.bad_code',
  network: 'error.network',
};

export function errorText(code: string, limit: LimitInfo | null = null): string {
  // The brake refused the match (limit.ts): until when, in Brasília time.
  if (code === 'limit_reached') return limitText(limit ?? defaultLimit(Date.now()));
  return t(ERRORS[code] ?? 'error.generic');
}
