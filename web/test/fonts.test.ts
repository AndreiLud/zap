// The self-hosted fonts (CLIENT-SPEC 6.2): a small WOFF2 reader (table directory, brotli stream,
// fvar and cmap formats 4 and 12) checks the axes the design uses, the Portuguese letters and
// punctuation, and that SOURCE.md records the right SHA-256 of each file.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'src', 'fonts');

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** The uncompressed tables of a WOFF2 file, by tag (transformed tables keep their transformed bytes). */
function readWoff2(buf: Buffer): Map<string, Buffer> {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const dirEntries: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    const tag = (flags & 0x3f) === 0x3f ? buf.toString('latin1', p, (p += 4)) : KNOWN_TAGS[flags & 0x3f];
    const version = (flags >> 6) & 3;
    const origLength = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128() : origLength;
    dirEntries.push({ tag, length });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + compressedSize));
  const tables = new Map<string, Buffer>();
  let off = 0;
  for (const e of dirEntries) {
    tables.set(e.tag, data.subarray(off, off + e.length));
    off += e.length;
  }
  return tables;
}

function axes(fvar: Buffer): Map<string, { min: number; max: number }> {
  const offset = fvar.readUInt16BE(4);
  const count = fvar.readUInt16BE(8);
  const size = fvar.readUInt16BE(10);
  const out = new Map<string, { min: number; max: number }>();
  for (let i = 0; i < count; i++) {
    const a = offset + i * size;
    out.set(fvar.toString('latin1', a, a + 4), { min: fvar.readInt32BE(a + 4) / 65536, max: fvar.readInt32BE(a + 12) / 65536 });
  }
  return out;
}

/** Code points with a glyph, from the Unicode subtables (formats 4 and 12) of cmap. */
function codePoints(cmap: Buffer): Set<number> {
  const out = new Set<number>();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const rec = 4 + i * 8;
    const platform = cmap.readUInt16BE(rec);
    const encoding = cmap.readUInt16BE(rec + 2);
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const st = cmap.readUInt32BE(rec + 4);
    const format = cmap.readUInt16BE(st);
    if (format === 4) {
      const segs = cmap.readUInt16BE(st + 6) / 2;
      const ends = st + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(ends + s * 2);
        const start = cmap.readUInt16BE(starts + s * 2);
        const delta = cmap.readInt16BE(deltas + s * 2);
        const ro = cmap.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const at = ranges + s * 2 + ro + (c - start) * 2;
            g = cmap.readUInt16BE(at);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(st + 12);
      for (let gi = 0; gi < groups; gi++) {
        const g = st + 16 + gi * 12;
        const start = cmap.readUInt32BE(g);
        const end = cmap.readUInt32BE(g + 4);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

const PORTUGUESE = [...'ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ·ªº“”’'];

function inspect(file: string) {
  const buf = readFileSync(join(dir, file));
  const tables = readWoff2(buf);
  return { buf, axes: axes(tables.get('fvar')!), cps: codePoints(tables.get('cmap')!) };
}

describe('fonts', () => {
  it('Bricolage Grotesque has opsz, wght and wdth, with weights 700 to 800 and width 78', () => {
    const f = inspect('bricolage-grotesque-latin-full.woff2');
    expect([...f.axes.keys()].sort()).toEqual(['opsz', 'wdth', 'wght']);
    const wght = f.axes.get('wght')!;
    const wdth = f.axes.get('wdth')!;
    expect(wght.min).toBeLessThanOrEqual(700);
    expect(wght.max).toBeGreaterThanOrEqual(800);
    expect(wdth.min).toBeLessThanOrEqual(78);
    expect(wdth.max).toBeGreaterThanOrEqual(78);
    expect(f.axes.get('opsz')!.max).toBeGreaterThanOrEqual(96);
  });

  it('Figtree has wght covering 550 to 800', () => {
    const f = inspect('figtree-latin-wght.woff2');
    const wght = f.axes.get('wght')!;
    expect(wght.min).toBeLessThanOrEqual(550);
    expect(wght.max).toBeGreaterThanOrEqual(800);
  });

  it('both cover every Portuguese letter and the punctuation the texts use', () => {
    for (const file of ['bricolage-grotesque-latin-full.woff2', 'figtree-latin-wght.woff2']) {
      const f = inspect(file);
      const missing = PORTUGUESE.filter((ch) => !f.cps.has(ch.codePointAt(0)!));
      expect(missing, file).toEqual([]);
    }
  });

  it('SOURCE.md records the SHA-256 of both files', () => {
    const source = readFileSync(join(dir, 'SOURCE.md'), 'utf8');
    for (const file of ['bricolage-grotesque-latin-full.woff2', 'figtree-latin-wght.woff2']) {
      const sha = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
      const row = source.split('\n').find((l) => l.startsWith(`| \`${file}\``));
      expect(row, file).toBeDefined();
      expect(row).toContain(sha);
    }
  });
});
