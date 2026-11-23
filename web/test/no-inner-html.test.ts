// The client never parses markup from strings (CLIENT-SPEC 2): no innerHTML and its relatives, so
// the content security policy can keep style-src 'self' without 'unsafe-inline', and nothing a
// server or a player sends can become markup. SVG is JSX; colors come from classes and custom
// properties, and styles set from code go through Preact style objects (the CSSOM).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const FORBIDDEN = ['innerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write'];

describe('no markup from strings', () => {
  it('no source file of the client uses innerHTML, dangerouslySetInnerHTML, insertAdjacentHTML, outerHTML or document.write', () => {
    const bad: string[] = [];
    for (const f of files(src)) {
      const text = readFileSync(f, 'utf8');
      for (const name of FORBIDDEN) if (text.includes(name)) bad.push(`${relative(src, f)}: ${name}`);
    }
    expect(bad).toEqual([]);
  });

  it('no JSX element carries a style string (use a class, or a style object for values computed in code)', () => {
    const bad: string[] = [];
    for (const f of files(src)) {
      if (!f.endsWith('.tsx')) continue;
      const text = readFileSync(f, 'utf8');
      if (/\sstyle=["'`]/.test(text) || /\sstyle=\{\s*["'`]/.test(text)) bad.push(relative(src, f));
    }
    expect(bad).toEqual([]);
  });
});
