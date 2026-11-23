// facts.json writer of the milestone 6 benches (ai/bench/bench-util.ts writeAdaptationFacts): child
// keys such as "explorer.trained" write only that child, and a full write of the parent keeps them.
// A value about another adaptive file (models.adaptive.sha256) moves to ai.adaptation.history.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeAdaptationFacts } from '../bench/bench-util.ts';

const DIR = '.cache/tmp/facts-writer-test';
const v = (x: Record<string, unknown>) => ({ measuredAt: '2026-11-22T00:00:00.000Z', method: 'test', ...x });

describe('writeAdaptationFacts', () => {
  it('writes a child key alone and keeps it when the parent is written again', () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const path = `${DIR}/facts.json`;
    writeFileSync(path, JSON.stringify({ other: { keep: 1 }, ai: { adaptation: { explorer: v({ pass: false, attempts: [1] }) } } }));
    writeAdaptationFacts('explorer.trained', v({ pass: true }), path);
    writeAdaptationFacts('explorer.criterion', v({ primary: 'adaptationPart' }), path);
    writeAdaptationFacts('explorer.control', v({ fresh: { seed: 'fa' } }), path);
    writeAdaptationFacts('explorer.netTightening', v({ explorer: 'x' }), path);
    let f = JSON.parse(readFileSync(path, 'utf8'));
    expect(f.other).toEqual({ keep: 1 });
    expect(f.ai.adaptation.explorer.attempts).toEqual([1]);
    expect(f.ai.adaptation.explorer.trained.pass).toBe(true);
    writeAdaptationFacts('explorer', v({ pass: false, attempts: [1, 2] }), path);
    f = JSON.parse(readFileSync(path, 'utf8'));
    expect(f.ai.adaptation.explorer.attempts).toEqual([1, 2]);
    expect(f.ai.adaptation.explorer.trained.pass).toBe(true);
    expect(f.ai.adaptation.explorer.criterion.primary).toBe('adaptationPart');
    expect(f.ai.adaptation.explorer.control.fresh.seed).toBe('fa');
    expect(f.ai.adaptation.explorer.netTightening.explorer).toBe('x');
    expect(() => writeAdaptationFacts('explorer.other', v({}), path)).toThrow(/child/);
    expect(() => writeAdaptationFacts('explorer.trained', { pass: true }, path)).toThrow(/method/);
  });

  it('keeps a value about another adaptive file under history, with its children, and merges nothing across files', () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const path = `${DIR}/facts.json`;
    const OLD = 'a'.repeat(64);
    const NEW = 'b'.repeat(64);
    const m = (sha: string) => ({ models: { adaptive: { path: `runs/${sha[0]}/export/zap-v2.zapw`, sha256: sha } } });
    writeFileSync(path, JSON.stringify({ ai: { adaptation: { regularizer: v({ beta: 0.1 }) } } }));
    writeAdaptationFacts('perStyle', v({ x: 1, ...m(OLD) }), path);
    writeAdaptationFacts('headToHead', v({ rows: { a: 1, b: 2 }, ...m(OLD) }), path);
    writeAdaptationFacts('explorer', v({ attempts: [4], ...m(OLD) }), path);
    writeAdaptationFacts('explorer.criterion', v({ pass: false, history: ['own list'], ...m(OLD) }), path);
    // The same file again: plain replacement, rows merged, children kept, no history.
    writeAdaptationFacts('perStyle', v({ x: 2, ...m(OLD) }), path);
    writeAdaptationFacts('headToHead', v({ rows: { b: 3 }, ...m(OLD) }), path);
    let f = JSON.parse(readFileSync(path, 'utf8'));
    expect(f.ai.adaptation.history).toBeUndefined();
    expect(f.ai.adaptation.headToHead.rows).toEqual({ a: 1, b: 3 });
    // Another file: the old values move to history, nothing of them stays in the new values.
    writeAdaptationFacts('perStyle', v({ x: 9, ...m(NEW) }), path);
    writeAdaptationFacts('headToHead', v({ rows: { c: 5 }, ...m(NEW) }), path);
    writeAdaptationFacts('explorer', v({ attempts: [5], ...m(NEW) }), path);
    f = JSON.parse(readFileSync(path, 'utf8'));
    const a = f.ai.adaptation;
    expect(a.perStyle.x).toBe(9);
    expect(a.headToHead.rows).toEqual({ c: 5 });
    expect(a.explorer.attempts).toEqual([5]);
    expect(a.explorer.criterion).toBeUndefined();
    expect(Object.keys(a.history)).toEqual([OLD]);
    const h = a.history[OLD];
    expect(h.model).toEqual({ path: 'runs/a/export/zap-v2.zapw', sha256: OLD });
    expect(h.keys.perStyle.x).toBe(2);
    expect(h.keys.headToHead.rows).toEqual({ a: 1, b: 3 });
    expect(h.keys.explorer.attempts).toEqual([4]);
    expect(h.keys.explorer.criterion.history).toEqual(['own list']);
    expect(typeof h.keys.perStyle.keptAt).toBe('string');
    // A child about the new file joins the new parent; an old child of another file moves alone.
    writeAdaptationFacts('explorer.criterion', v({ pass: true, ...m(NEW) }), path);
    writeAdaptationFacts('headToHead', v({ rows: { d: 6 }, ...m(NEW) }), path);
    f = JSON.parse(readFileSync(path, 'utf8'));
    expect(f.ai.adaptation.explorer.criterion.pass).toBe(true);
    expect(f.ai.adaptation.headToHead.rows).toEqual({ c: 5, d: 6 });
    writeAdaptationFacts('explorer.criterion', v({ pass: false, ...m(OLD) }), path);
    f = JSON.parse(readFileSync(path, 'utf8'));
    expect(f.ai.adaptation.history[NEW].keys['explorer.criterion'].pass).toBe(true);
    // Values without an adaptive file are replaced as before.
    writeAdaptationFacts('regularizer', v({ beta: 0.3 }), path);
    expect(JSON.parse(readFileSync(path, 'utf8')).ai.adaptation.regularizer.beta).toBe(0.3);
    expect(() => writeAdaptationFacts('history', v({}), path)).toThrow(/history/);
  });
});
