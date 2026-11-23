// The JSON formats shared with the training cycle (shared/cycle-formats.ts): every valid file of
// tests/fixtures/cycle is accepted and every invalid one refused (training/cycle/tests/test_formats.py
// runs the same files through the Python checks), plus the helpers both sides use.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  SCHEMAS,
  VALIDATORS,
  cardKey,
  cycleIdOf,
  exportKey,
  modelKey,
  nextVersion,
  normalizeSummary,
  parseChecked,
  receiptKey,
  utcDate,
  validateManifest,
  validatePriorsFile,
  validateSummary,
  type AnySummary,
} from '../../shared/cycle-formats.ts';

const DIR = 'tests/fixtures/cycle';
const schemas = readdirSync(DIR).filter((d) => d.startsWith('zap-'));
/** The folder of a schema: its name without the version (zap-summary/1 and /2 share one folder). */
const family = (schema: string) => schema.replace(/\/\d+$/, '');

/** The errors of a check, none when it passed. */
const errorsOf = (r: { ok: true } | { ok: false; errors: string[] }): string[] => (r.ok ? [] : r.errors);

describe('cycle formats: shared fixtures', () => {
  it('cover every format with at least 2 valid and 5 invalid files', () => {
    expect(schemas.sort()).toEqual([...new Set(Object.keys(VALIDATORS).map(family))].sort());
    for (const s of schemas) {
      expect(readdirSync(join(DIR, s, 'valid')).length, s).toBeGreaterThanOrEqual(2);
      expect(readdirSync(join(DIR, s, 'invalid')).length, s).toBeGreaterThanOrEqual(5);
    }
  });

  for (const s of schemas) {
    const validate = VALIDATORS[`${s}/1` as keyof typeof VALIDATORS] as (j: unknown) => { ok: boolean; errors?: string[] };
    for (const kind of ['valid', 'invalid'] as const) {
      for (const f of readdirSync(join(DIR, s, kind))) {
        it(`${s} ${kind} ${f}`, () => {
          const r = validate(JSON.parse(readFileSync(join(DIR, s, kind, f), 'utf8')));
          if (kind === 'valid') expect(r.errors ?? []).toEqual([]);
          else expect(r.ok).toBe(false);
        });
      }
    }
  }
});

describe('cycle formats: helpers', () => {
  it('keys, dates, cycle ids and version numbers', () => {
    expect(exportKey('2026-11-21')).toBe('exports/2026-11-21.json');
    expect(receiptKey('2026-11-21')).toBe('receipts/2026-11-21.json');
    expect(modelKey('v12')).toBe('models/v12.zapw');
    expect(cardKey('v12')).toBe('cards/v12.json');
    expect(utcDate(Date.UTC(2026, 10, 21, 23, 59))).toBe('2026-11-21');
    expect(cycleIdOf(Date.UTC(2026, 10, 21, 1, 7))).toBe('20261121-0107');
    expect(nextVersion(['v1', 'v3', 'heuristic', 'v2'])).toBe('v4');
    expect(nextVersion([])).toBe('v1');
  });

  it('checks the size before parsing', () => {
    const big = `{"x":"${'a'.repeat(LIMITS.manifest)}"}`;
    const r = parseChecked('manifest', big, validateManifest);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/bytes, over/);
    expect(parseChecked('manifest', '{', validateManifest)).toEqual({ ok: false, errors: ['manifest: not JSON'] });
  });

  it('the bundled default priors are a valid zap-priors/1 file from self-play', () => {
    const p = JSON.parse(readFileSync('shared/profile-priors-default.json', 'utf8'));
    expect(errorsOf(validatePriorsFile(p))).toEqual([]);
    expect(p.source).toBe('selfplay');
  });
});

describe('cycle formats: summary.json in both schemas', () => {
  const read = (kind: string, name: string) => JSON.parse(readFileSync(join(DIR, 'zap-summary', kind, `${name}.json`), 'utf8'));

  it('the fixtures hold valid files of both schemas, and both schema names reach the same validator', () => {
    const valid = readdirSync(join(DIR, 'zap-summary', 'valid')).map((f) => read('valid', f.replace(/\.json$/, '')));
    expect(valid.filter((s) => s.schema === SCHEMAS.summary).length).toBeGreaterThanOrEqual(2);
    expect(valid.filter((s) => s.schema === SCHEMAS.summary2).length).toBeGreaterThanOrEqual(2);
    expect(VALIDATORS[SCHEMAS.summary2]).toBe(validateSummary);
    expect(readdirSync(join(DIR, 'zap-summary', 'invalid')).filter((f) => f.startsWith('v2-')).length).toBeGreaterThanOrEqual(5);
  });

  it('normalizeSummary gives a /2 view of a /1 file, empty where /1 had nothing, and leaves /2 as it is', () => {
    const v1 = read('valid', 'full') as AnySummary;
    const n = normalizeSummary(v1);
    expect(n.schema).toBe(SCHEMAS.summary2);
    expect(errorsOf(validateSummary(n))).toEqual([]);
    expect(n.versions.map((v) => [v.version, v.twin, v.personas, v.data])).toEqual(v1.versions.map((v) => [v.version, null, null, null]));
    expect(n.versions.map((v) => v.anchors)).toEqual(v1.versions.map((v) => v.anchors));
    expect([n.seedNoise, n.scoreboard, n.disagreements]).toEqual([null, [], null]);
    const { schema: _a, versions: _b, ...rest1 } = v1;
    const { schema: _c, versions: _d, seedNoise: _e, scoreboard: _f, disagreements: _g, ...restN } = n;
    expect(restN).toEqual(rest1);
    const v2 = read('valid', 'v2-full') as AnySummary;
    expect(normalizeSummary(v2)).toBe(v2);
  });

  it('the pages can take normalizeSummary without the validators: its module imports types only', () => {
    const src = readFileSync('shared/summary-view.ts', 'utf8');
    const imports = src.split('\n').filter((l) => /^import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/^import type /);
  });

  it('a number from fewer than 20 people never passes: scoreboard rows, people per version, disagreements', () => {
    const v2 = read('valid', 'v2-full');
    for (const broken of [
      (x: any) => (x.scoreboard[1].people = 19),
      (x: any) => (x.versions[2].data.people = 19),
      (x: any) => (x.disagreements.types[0].people = 19),
      (x: any) => (x.cells[0].people = 19),
    ]) {
      const x = JSON.parse(JSON.stringify(v2));
      broken(x);
      expect(validateSummary(x).ok).toBe(false);
    }
    // people null keeps the count hidden and is valid.
    const hidden = JSON.parse(JSON.stringify(v2));
    hidden.versions[2].data.people = null;
    expect(errorsOf(validateSummary(hidden))).toEqual([]);
  });
});
