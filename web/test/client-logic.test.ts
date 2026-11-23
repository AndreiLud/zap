// Pure pieces of the client: the age gate's verdict and recovery codes as typed. Page addresses
// are in routes.test.ts.

import { describe, expect, it } from 'vitest';
import { ageVerdict } from '../src/consent-keys.ts';
import { cleanRecoveryCode } from '../src/my-data.ts';

describe('age gate', () => {
  const year = 2026;
  it('decides from the year alone when the answer is clear', () => {
    expect(ageVerdict(1990, null, year)).toBe('adult');
    expect(ageVerdict(2007, null, year)).toBe('adult');
    expect(ageVerdict(2009, null, year)).toBe('under');
    expect(ageVerdict(2026, null, year)).toBe('under');
  });

  it('asks about the birthday only for the year that turns 18', () => {
    expect(ageVerdict(2008, null, year)).toBe('ask');
    expect(ageVerdict(2008, true, year)).toBe('adult');
    expect(ageVerdict(2008, false, year)).toBe('under');
  });
});

describe('recovery codes', () => {
  it('accepts the code as shown, in any case, with spaces or dashes', () => {
    expect(cleanRecoveryCode('ABCDE FGHJK MNPQR STUVW')).toBe('ABCDEFGHJKMNPQRSTUVW');
    expect(cleanRecoveryCode('abcde-fghjk-mnpqr-stuvw')).toBe('ABCDEFGHJKMNPQRSTUVW');
  });

  it('refuses anything that cannot be a code', () => {
    expect(cleanRecoveryCode('')).toBeNull();
    expect(cleanRecoveryCode('ABCDE FGHJK MNPQR STUV')).toBeNull();
    // 0, O, 1, I and L are not in the alphabet.
    expect(cleanRecoveryCode('ABCDE FGHJK MNPQR STUV0')).toBeNull();
    expect(cleanRecoveryCode('ABCDE FGHJK MNPQR STUVL')).toBeNull();
  });
});
