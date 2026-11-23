// The numbers of README.md and README.pt-BR.md (tools/docs/readme-facts.ts) and the merge of
// documented values into facts.json (tools/docs/facts-docs.ts). This file sits with the web tests
// because the web project type-checks the tools it imports, as with tools/data.
//
// The last test runs `readme-facts.ts --check` on the repository: when it fails because facts.json
// changed (a training run writes it), render the READMEs again with
//   docker compose run --rm -T node node tools/docs/readme-facts.ts

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFacts, missingDocs, mergeDocs, readDocValues, ROOT, validateDocValues, writeFactsDocs, type DocValues } from '../../tools/docs/facts-docs.ts';
import {
  blockContent,
  collectVerdicts,
  compareLanguages,
  docsValues,
  formatDate,
  formatNumber,
  formatValue,
  parseReadme,
  readmeValues,
  renderReadme,
  renderTemplate,
  runReadmes,
} from '../../tools/docs/readme-facts.ts';

const DIR = join(ROOT, '.cache', 'tmp', 'facts-docs-test');
const doc = (value: number | string, extra: Record<string, unknown> = {}) => ({ value, unit: 'u', source: 'https://example.org/limits', readAt: '2026-11-23', kind: 'documented', ...extra });

function freshDir(): string {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  return DIR;
}

describe('facts-docs', () => {
  it('merges docs into a copy of facts.json and leaves every other key as it was, byte for byte', () => {
    const dir = freshDir();
    const copy = join(dir, 'facts.json');
    copyFileSync(join(ROOT, 'facts.json'), copy);
    const before = readFileSync(copy, 'utf8');
    const measured = { value: 1234, unit: 'bytes', source: 'stat -c %s x.gif', measuredAt: '2026-11-23T10:00:00Z', kind: 'measured' };
    const values = { 'test.price': doc(5), 'test.gif.bytes': measured } as DocValues;
    expect(writeFactsDocs(copy, values).sort()).toEqual(['test.gif.bytes', 'test.price']);
    const after = JSON.parse(readFileSync(copy, 'utf8')) as Record<string, unknown>;
    // facts.json may already hold docs values (the integration merged them): those stay as they were.
    const held = (JSON.parse(before) as { docs?: Record<string, unknown> }).docs ?? {};
    expect(after.docs).toEqual({ ...held, ...values });
    const withoutDocs = { ...after };
    delete withoutDocs.docs;
    const original = JSON.parse(before) as Record<string, unknown>;
    delete original.docs;
    expect(formatFacts(withoutDocs)).toBe(formatFacts(original));
    if (!('docs' in JSON.parse(before))) expect(formatFacts(withoutDocs)).toBe(before);
    // Nothing left behind but the file itself.
    expect(readdirSync(dir)).toEqual(['facts.json']);
    // A second merge with the same values writes nothing.
    expect(writeFactsDocs(copy, values)).toEqual([]);
  });

  it('keeps keys already under docs, replaces a key given again and sorts them', () => {
    const facts = { a: 1, docs: { 'z.old': doc(1), 'b.change': doc(2) }, c: { d: 2 } };
    const merged = mergeDocs(facts, { 'b.change': doc(3), 'a.new': doc(4) } as DocValues);
    expect(Object.keys(merged)).toEqual(['a', 'docs', 'c']);
    expect(Object.keys(merged.docs as object)).toEqual(['a.new', 'b.change', 'z.old']);
    expect((merged.docs as DocValues)['b.change'].value).toBe(3);
    expect(merged.c).toBe(facts.c);
    expect(missingDocs(merged, { 'b.change': doc(3) } as DocValues)).toEqual([]);
    expect(missingDocs(facts, { 'b.change': doc(3) } as DocValues)).toEqual(['b.change']);
    expect(() => mergeDocs({ docs: [] }, {})).toThrow(/not an object/);
  });

  it('refuses values without a unit, a source, a date or a kind, and keys that clash between files', () => {
    expect(() => validateDocValues({ 'x y': { value: null, unit: 3, source: '', kind: 'guess' } }, 'bad.json')).toThrow(/a key starts with a letter[\s\S]*value must be[\s\S]*unit must be[\s\S]*source must[\s\S]*kind must[\s\S]*readAt or measuredAt/);
    expect(() => validateDocValues({ k: doc(1, { readAt: '23/11/2026' }) }, 'bad.json')).toThrow(/ISO date/);
    expect(() => validateDocValues([], 'bad.json')).toThrow(/one JSON object/);
    const dir = freshDir();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ k: doc(1) }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ k: doc(2) }));
    expect(() => readDocValues([join(dir, 'a.json'), join(dir, 'b.json')])).toThrow(/different values/);
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ k: doc(1) }));
    expect(readDocValues([join(dir, 'a.json'), join(dir, 'b.json')]).k.value).toBe(1);
  });

  it('runs from the command line on a copy, and --check reports what is missing', () => {
    const dir = freshDir();
    const copy = join(dir, 'facts.json');
    writeFileSync(copy, formatFacts({ engine: { speed: 1 } }));
    mkdirSync(join(dir, 'in'));
    writeFileSync(join(dir, 'in', 'area.json'), JSON.stringify({ 'area.value': doc(7) }));
    const run = (...args: string[]) => {
      try {
        execFileSync(process.execPath, [join(ROOT, 'tools/docs/facts-docs.ts'), '--facts', copy, ...args], { stdio: 'pipe' });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(run('--check', join(dir, 'in'))).toBe(1);
    expect(run(join(dir, 'in'))).toBe(0);
    expect(run('--check', join(dir, 'in'))).toBe(0);
    expect(JSON.parse(readFileSync(copy, 'utf8'))).toEqual({ engine: { speed: 1 }, docs: { 'area.value': doc(7) } });
  });
});

describe('readme-facts formats', () => {
  it('writes numbers the English and the Portuguese way, with a real minus sign', () => {
    expect(formatNumber(1153.5, 1, 'en')).toBe('1,153.5');
    expect(formatNumber(1153.5, 1, 'pt')).toBe('1.153,5');
    expect(formatNumber(1153, 0, 'pt')).toBe('1.153');
    expect(formatNumber(-0.58, 2, 'pt')).toBe('−0,58');
    expect(formatNumber(-0.0001, 2, 'en')).toBe('0.00');
    expect(formatValue(0.9595, 'pct1', 'en', 'k')).toBe('96.0%');
    expect(formatValue(0.9595, 'pct1', 'pt', 'k')).toBe('96,0%');
    expect(formatValue(-0.00575, 'pts2', 'en', 'k')).toBe('−0.58');
    expect(formatValue(0.7025, 'pct1', 'en', 'k')).toBe('70.3%');
    expect(formatValue(193512, 'kb', 'en', 'k')).toBe('194');
    expect(formatValue('2026-11-22T16:36:22.619Z', 'date', 'en', 'k')).toBe('22 Nov 2026');
    expect(formatDate('2026-11-02', 'pt')).toBe('02/11/2026');
    expect(() => formatValue(1, undefined, 'en', 'k')).toThrow(/needs a format/);
    expect(() => formatValue('v2', 'int', 'en', 'k')).toThrow(/takes no format/);
  });

  it('keeps a section only when its value matches, and collapses the blank lines left behind', () => {
    const t = 'A {n:int}.\n\n{?s=on}\nOn {w}.\n{/?}\n\n{?s!=on}\nOff.\n{/?}\n\nEnd.';
    expect(renderTemplate(t, { n: 1234, s: 'on', w: 'x' }, 'pt')).toBe('A 1.234.\n\nOn x.\n\nEnd.');
    expect(renderTemplate(t, { n: 1234, s: 'off', w: 'x' }, 'en')).toBe('A 1,234.\n\nOff.\n\nEnd.');
    expect(() => renderTemplate('{missing:int}', {}, 'en')).toThrow(/no value "missing"/);
    expect(() => renderTemplate('{?s=on}never closed', { s: 'on' }, 'en')).toThrow(/not closed/);
  });

  it('renders blocks from the template before them and reports the blocks that changed', () => {
    const text = 'Intro\n\n<!-- facts-template:one\nValue {v:n1}.\n-->\n<!-- facts:one -->\nold\n<!-- /facts:one -->\n\nEnd\n';
    const res = renderReadme(text, 'pt', { v: 1153.5 }, 'X.md');
    expect(res.changed).toEqual(['one']);
    expect(res.text).toBe(`Intro\n\n<!-- facts-template:one\nValue {v:n1}.\n-->\n<!-- facts:one -->\n${blockContent('Value 1.153,5.')}<!-- /facts:one -->\n\nEnd\n`);
    expect(renderReadme(res.text, 'pt', { v: 1153.5 }, 'X.md').changed).toEqual([]);
    expect(() => parseReadme('<!-- facts:a -->\nx\n<!-- /facts:a -->', 'X.md')).toThrow(/has no template/);
    expect(() => parseReadme('<!-- facts-template:a\nx\n-->', 'X.md')).toThrow(/has no block/);
    expect(() => parseReadme('<!-- facts-template:a\nx\n-->\n<!-- facts:a -->\nx\n', 'X.md')).toThrow(/no closing/);
    const a = parseReadme('<!-- facts-template:a\n{x:int} {?s=on}y{/?}\n-->\n<!-- facts:a -->\n<!-- /facts:a -->', 'A.md');
    const b = parseReadme('<!-- facts-template:a\n{x:int}\n-->\n<!-- facts:a -->\n<!-- /facts:a -->', 'B.md');
    expect(compareLanguages(a, a, ['A.md', 'A.md'])).toEqual([]);
    expect(compareLanguages(a, b, ['A.md', 'B.md'])[0]).toMatch(/reads other keys/);
  });
});

describe('readme-facts values', () => {
  const facts = JSON.parse(readFileSync(join(ROOT, 'facts.json'), 'utf8')) as Record<string, unknown>;
  const { docs } = docsValues(facts);

  it('finds every explorer verdict of the criterion, wherever it sits', () => {
    const verdicts = collectVerdicts({
      scripted: [{ explorers: [{ explorer: 'a', pass: true, adaptationPart: { mean: 0, ci95: [0, 0], upper95: 0.001 } }] }],
      trained: { explorer: 'training/runs/x/explorer.zapw', pass: false, adaptationPart: { mean: 0.01, ci95: [0, 0.02], upper95: 0.015 } },
    });
    expect(verdicts.map((v) => v.explorer)).toEqual(['a', 'training/runs/x/explorer.zapw']);
  });

  it('states the reading from facts.json: off unless the served file reads, and the explorer verdict', () => {
    const v = readmeValues(facts, docs);
    expect(['on', 'off-fails', 'off-passes', 'off-unmeasured']).toContain(v['reading.state']);
    const pass = (facts as { ai: { adaptation: { explorer: { criterion: { pass: boolean } } } } }).ai.adaptation.explorer.criterion.pass;
    if (v['reading.state'] !== 'on') expect(v['reading.state']).toBe(pass ? 'off-passes' : 'off-fails');
    const off = JSON.parse(JSON.stringify(facts)) as { ai: { adaptation: { explorer: { criterion?: Record<string, unknown> } } } };
    delete off.ai.adaptation.explorer.criterion;
    expect(readmeValues(off as unknown as Record<string, unknown>, docs)['reading.state']).toBe('off-unmeasured');
  });

  it('names every missing key at once', () => {
    expect(() => readmeValues({ ai: {} }, {})).toThrow(/ai\.bootstrapModel\.version[\s\S]*engine\.speed\.results[\s\S]*docs\.readme\.cycle\.gate\.p0/);
  });

  it('README.md and README.pt-BR.md are in step with facts.json (readme-facts --check)', () => {
    expect(existsSync(join(ROOT, 'README.md')) && existsSync(join(ROOT, 'README.pt-BR.md'))).toBe(true);
    expect(runReadmes().problems).toEqual([]);
    let out = '';
    try {
      out = execFileSync(process.execPath, [join(ROOT, 'tools/docs/readme-facts.ts'), '--check'], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      throw new Error(`readme-facts --check exited ${err.status}:\n${err.stderr}`);
    }
    expect(out).toMatch(/in step/);
  });
});
