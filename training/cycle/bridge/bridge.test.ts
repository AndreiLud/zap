import { describe, expect, it } from 'vitest';
import { carries, importOrder, stateOf } from './bridge.ts';

describe('bridge (Node half)', () => {
  it('accepts only the two local sites', () => {
    expect(stateOf('dev')).toBe('dev');
    expect(stateOf('e2e')).toBe('e2e');
    expect(() => stateOf('prod')).toThrow();
    expect(() => stateOf('../state')).toThrow();
    expect(() => stateOf(undefined)).toThrow();
  });

  it('carries only match records marked test; exports and receipts always', () => {
    const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
    expect(carries('matches/v1/2026/11/22/a.json', enc({ schema: 'zap-match/2', test: true }))).toBe(true);
    expect(carries('matches/v1/2026/11/22/a.json', enc({ schema: 'zap-match/2', test: false }))).toBe(false);
    expect(carries('matches/v1/2026/11/21/a.json', enc({ schema: 'zap-match/1' }))).toBe(false);
    expect(carries('matches/v1/2026/11/21/a.json', new TextEncoder().encode('not json'))).toBe(false);
    expect(carries('exports/2026-11-22.json', enc({ schema: 'zap-export/1' }))).toBe(true);
    expect(carries('receipts/2026-11-22.json', enc({ schema: 'zap-receipt/1' }))).toBe(true);
  });

  it('imports models and cards before the manifest', () => {
    expect(importOrder(['manifest.json', 'status/training.json', 'cards/v2.json', 'models/v2.zapw'])).toEqual(['models/v2.zapw', 'cards/v2.json', 'status/training.json', 'manifest.json']);
  });
});
