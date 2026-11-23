// Display preferences kept in this browser: the four-color deck, the sound switch and the single
// key shortcuts. They are read once at load (store.ts) and applied without a re-render where
// possible: the deck colors are a CSS switch on <html data-deck="four">, so no card redraws
// (CLIENT-SPEC 7.4).

export const FOUR_COLOR_KEY = 'zap-four-color';
export const SOUND_KEY = 'zap-sound';
export const KEYS_KEY = 'zap-keys';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** Four-color deck, off unless the person turned it on. */
export function readFourColor(): boolean {
  return read(FOUR_COLOR_KEY) === '1';
}

/** Sound and vibration, on unless the person turned them off ('0'). */
export function readSoundOn(): boolean {
  return read(SOUND_KEY) !== '0';
}

/** The single key shortcuts (1, 2, 3, T, A, C, E and R), on unless the person turned them off ('0'). */
export function readKeysOn(): boolean {
  return read(KEYS_KEY) !== '0';
}

export function saveKeysOn(on: boolean): void {
  write(KEYS_KEY, on ? '1' : '0');
}

/** Sets the deck colors on the document: CSS swaps the suit variables, nothing re-renders. */
export function applyFourColor(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (on) document.documentElement.dataset.deck = 'four';
  else delete document.documentElement.dataset.deck;
}

export function saveFourColor(on: boolean): void {
  write(FOUR_COLOR_KEY, on ? '1' : '0');
  applyFourColor(on);
}

export function saveSoundOn(on: boolean): void {
  write(SOUND_KEY, on ? '1' : '0');
}
