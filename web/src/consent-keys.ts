// What this browser remembers about the age gate and the notice (localStorage), and the version
// of the notice. No imports, so the end-to-end tests can read the same names.

/** "1" once the person declared being 18 or older. The birth year is never kept nor sent. */
export const ADULT_KEY = 'zap.adult';
/** The version of the notice the person read ("Entendi"). A new version shows the notice again. */
export const NOTICE_KEY = 'zap.notice';
export const NOTICE_VERSION = '2026-11-25';

/**
 * The version of the notice to show: NOTICE_VERSION while ads are off, and its "+ads" form while
 * /api/config reports them on, so turning ads on shows the notice (with its ads row) to everyone
 * again (CLIENT-SPEC 16.6). The ads consent is stored with the "+ads" form too.
 */
export function noticeVersion(adsOn: boolean): string {
  return adsOn ? `${NOTICE_VERSION}+ads` : NOTICE_VERSION;
}

export type AgeVerdict = 'adult' | 'under' | 'ask';

/**
 * The answer of the age gate: from the birth year alone when it is clear; for the year that turns
 * 18 this year, 'ask' until the person says whether the birthday already passed.
 */
export function ageVerdict(year: number, birthdayPassed: boolean | null, thisYear: number): AgeVerdict {
  const age = thisYear - year;
  if (age > 18) return 'adult';
  if (age < 18) return 'under';
  if (birthdayPassed === null) return 'ask';
  return birthdayPassed ? 'adult' : 'under';
}
