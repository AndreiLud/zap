// A small reader for the cycle's TOML files (training/cycle/config/*.toml). It accepts only what
// those files use: comments, [section] and [section.sub] headers, and `key = value` lines where the
// value is a number, a double quoted string without escapes, true, false, or a one line array of
// those. Anything else is refused with its line number, so a file the page cannot read correctly
// fails loudly instead of being read wrong.

export type TomlScalar = number | string | boolean;
export type TomlValue = TomlScalar | TomlScalar[];
/** Sections by name ('' for keys before the first header); dotted headers keep their dots. */
export type TomlDoc = Record<string, Record<string, TomlValue>>;

const KEY = /^[A-Za-z0-9_-]+$/;
const SECTION = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

/** The line without its comment: a '#' outside a string starts a comment. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inString = !inString;
    else if (c === '#' && !inString) return line.slice(0, i);
  }
  if (inString) throw new Error('unterminated string');
  return line;
}

function scalar(text: string): TomlScalar {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (NUMBER.test(t)) return Number(t);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1);
    if (inner.includes('"') || inner.includes('\\')) throw new Error(`string with quotes or escapes: ${t}`);
    return inner;
  }
  throw new Error(`value not supported: ${t}`);
}

/** Splits the inside of a one line array on commas outside strings. */
function arrayItems(inner: string): string[] {
  const items: string[] = [];
  let inString = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"') inString = !inString;
    else if (c === ',' && !inString) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const last = inner.slice(start);
  if (last.trim() !== '') items.push(last);
  return items;
}

function value(text: string): TomlValue {
  const t = text.trim();
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new Error(`array must end on the same line: ${t}`);
    const inner = t.slice(1, -1);
    if (inner.includes('[') || inner.includes('{')) throw new Error(`nested arrays and tables are not supported: ${t}`);
    return arrayItems(inner).map(scalar);
  }
  return scalar(t);
}

export function parseToml(text: string): TomlDoc {
  const doc: TomlDoc = { '': {} };
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    try {
      const line = stripComment(lines[i]).trim();
      if (line === '') continue;
      const header = SECTION.exec(line);
      if (header) {
        section = header[1];
        if (doc[section]) throw new Error(`section [${section}] appears twice`);
        doc[section] = {};
        continue;
      }
      const eq = line.indexOf('=');
      if (eq < 0) throw new Error(`not a key = value line: ${line}`);
      const key = line.slice(0, eq).trim();
      if (!KEY.test(key)) throw new Error(`key not supported: ${key}`);
      if (key in doc[section]) throw new Error(`key ${key} appears twice in [${section}]`);
      doc[section][key] = value(line.slice(eq + 1));
    } catch (e) {
      throw new Error(`toml-lite, line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return doc;
}

/** A number from a section, or an error naming what is missing. */
export function tomlNumber(doc: TomlDoc, section: string, key: string): number {
  const v = doc[section]?.[key];
  if (typeof v !== 'number') throw new Error(`[${section}] ${key} must be a number, found ${JSON.stringify(v)}`);
  return v;
}

export function tomlString(doc: TomlDoc, section: string, key: string): string {
  const v = doc[section]?.[key];
  if (typeof v !== 'string') throw new Error(`[${section}] ${key} must be a string, found ${JSON.stringify(v)}`);
  return v;
}
