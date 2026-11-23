// Cloudflare's Turnstile test keys are recognized, so the public site never runs with one.

import { describe, expect, it } from 'vitest';
import { isTestKey } from '../src/turnstile.ts';

describe('Turnstile keys', () => {
  it('recognizes every test site key and secret, and nothing else', () => {
    for (const key of [
      '1x00000000000000000000AA',
      '2x00000000000000000000AB',
      '3x00000000000000000000FF',
      '1x00000000000000000000BB',
      '1x0000000000000000000000000000000AA',
      '2x0000000000000000000000000000000AA',
      '3x0000000000000000000000000000000AA',
    ]) {
      expect(isTestKey(key), key).toBe(true);
    }
    // Made-up values in the production format (0x4AAAAAAA and filler): a site key and a secret that are not test keys.
    for (const key of ['0x4AAAAAAA' + 'Y'.repeat(14), '0x4AAAAAAA' + 'X'.repeat(27), '', undefined, '1x00000000000000000000AA ']) {
      expect(isTestKey(key), String(key)).toBe(false);
    }
  });
});
