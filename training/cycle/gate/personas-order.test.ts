import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderFromCalibration } from './gate-core.ts';
import { Z, describeMargins, orderMargins, type Score } from './personas-order.ts';

const s = (mean: number, se = 0.01): Score => ({ mean, se });

describe('characters order on fresh deals', () => {
  it('fails only when the order is reversed beyond noise', () => {
    const v = { otavio: s(0.3), bento: s(0.31), lia: s(0.32), ravi: s(0.315), iara: s(0.4), zap: s(0.5) };
    const m = orderMargins(v);
    expect(m.otavio).toMatchObject({ against: 'bento', holds: true });
    expect(m.otavio.diff).toBeCloseTo(-0.01, 12);
    expect(m.otavio.ci95[0]).toBeCloseTo(-0.01 - 1.96 * m.otavio.se, 12);
    expect(m.otavio.ci95[1]).toBeCloseTo(-0.01 + 1.96 * m.otavio.se, 12);
    expect(m.iara).toMatchObject({ against: 'lia', holds: true });
    // Otávio 1 point above Bento with a standard error of the difference of 1.41 points: noise.
    expect(orderMargins({ ...v, otavio: s(0.32) }).otavio.holds).toBe(true);
    // 3 points above: reversed beyond 1.645 standard errors.
    const bad = orderMargins({ ...v, otavio: s(0.34) });
    expect(bad.otavio.holds).toBe(false);
    expect(bad.otavio.diff).toBeGreaterThan(Z * bad.otavio.se);
    // Iara clearly easier than Lia.
    expect(orderMargins({ ...v, iara: s(0.28) }).iara.holds).toBe(false);
    expect(describeMargins(m, 200)).toBe(
      'Otávio minus the easiest of Bento, Lia and Ravi (bento): -1.0 points (se 1.4, 95% from -3.8 to 1.8); the hardest of them (lia) minus Iara: -8.0 points (se 1.4, 95% from -10.8 to -5.2); reversed beyond noise above 1.645 se; 200 fresh pairs per segment.',
    );
  });

  it('measures the bundled model with its knobs on a seed of the cycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zap-order-'));
    const cal = join(dir, 'personas.json');
    const manifest = JSON.parse(readFileSync('ai/models/bootstrap/manifest.json', 'utf8'));
    writeFileSync(cal, JSON.stringify({ knobs: manifest.personas, order: { otavioEasiest: true, iaraHardestAfterZap: true } }));
    const out = join(dir, 'order.json');
    execFileSync('node', ['training/cycle/gate/personas-order.ts', '--model', 'ai/models/bootstrap/zap-v1.zapw', '--calibration', cal, '--pairs', '2', '--seed', 'ab'.repeat(32), '--out', out], { env: { ...process.env, ZAP_FACTS: join(dir, 'facts.json') } });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(r.vsZap).sort()).toEqual(['bento', 'iara', 'lia', 'otavio', 'ravi', 'zap']);
    expect(r.pairsPerSegment).toBe(2);
    expect(r.order).toEqual({ otavioEasiest: r.margins.otavio.holds, iaraHardestAfterZap: r.margins.iara.holds });
    expect(orderFromCalibration(r)).toBe(r.margins.otavio.holds && r.margins.iara.holds);
    expect(r.summary).toContain('fresh pairs per segment');
  }, 60_000);
});
