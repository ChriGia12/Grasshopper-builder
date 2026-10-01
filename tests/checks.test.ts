import { describe, expect, it } from 'vitest';
import { validateSettings } from '../src/core/validate';
import { runBuild } from '../src/core/pipeline';
import { reachReport } from '../src/core/robot';
import { writeKukaSrc } from '../src/core/kuka';
import { buildToolpath, surfaceCoverage } from '../src/core/toolpath';
import { HeightField, topSurfacePasses } from '../src/core/surface';
import { IDENTITY, weld, type Mat3 } from '../src/core/mesh';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box, cylinder } from './fixtures';
import { SettingsError } from '../src/i18n';

const I = [...IDENTITY] as Mat3;

describe('parameter validation', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_PRINT, DEFAULT_ROBOT)).toEqual([]);
  });
  it('rejects the cases from the review: A1 = 999°, $VEL.CP = −1, TOOL = −2', () => {
    const r = { ...DEFAULT_ROBOT, velCP: -1, toolNumber: -2, safeAxes: [999, -90, 90, 0, -1, 0] as typeof DEFAULT_ROBOT.safeAxes };
    const keys = validateSettings(DEFAULT_PRINT, r).map((m) => m.k + ':' + (m.p?.field ?? m.p?.axis));
    expect(keys).toContain('v.range:f.velCP');
    expect(keys).toContain('v.fixed:f.toolNumber');
    expect(keys).toContain('v.safe:A1');
    expect(keys).toContain('v.home:A1');
  });
  it('locks BASE 1, TOOL 11 and E1–E4 = 0 (the only frames the simulation knows)', () => {
    const keys = (r: Partial<typeof DEFAULT_ROBOT>) => validateSettings(DEFAULT_PRINT, { ...DEFAULT_ROBOT, ...r }).map((m) => m.k + ':' + m.p?.field);
    expect(keys({ baseNumber: 2 })).toEqual(['v.fixed:f.baseNumber']);
    expect(keys({ toolNumber: 12 })).toEqual(['v.fixed:f.toolNumber']);
    expect(keys({ e3: 10 })).toEqual(['v.fixed:f.e3']);
  });
  it('rejects the parameters before generating anything', () => {
    expect(() => runBuild(weld(box(50, 50, 6)), I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, velCP: -1 }, 't')).toThrow(SettingsError);
    // A huge layer count would run for minutes: it must fail at once.
    const t0 = performance.now();
    expect(() => runBuild(weld(box(50, 50, 6)), I, { ...DEFAULT_PRINT, mode: 'surface', surfacePasses: 1e6 }, DEFAULT_ROBOT, 't')).toThrow(SettingsError);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('table and reach checks', () => {
  it('flags a path that leaves the table', () => {
    const r = runBuild(weld(box(50, 50, 6)), I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, originX: 335 }, 't');
    expect(r.offBed).toBe(true);
    const ok = runBuild(weld(box(50, 50, 6)), I, DEFAULT_PRINT, DEFAULT_ROBOT, 't');
    expect(ok.offBed).toBe(false);
  });
  it('checks the intermediate points of a long LIN, not only its ends', () => {
    // With the tool vertical the flange face looks along +X: wrist centre = TCP + (−78.1, 0, 372.65)
    // − 153.9 along X. Both ends keep the wrist ~180 mm from the A2 axis; the straight line between
    // them crosses the A2 axis itself (dead zone of radius |980 − 873| ≈ 107 mm), so its middle is
    // unreachable.
    const tcp = (y: number) => [160 + 78.111 + 153.9 - 1448, y, 520 - 372.65 - 5];
    const ends = [...tcp(-300), ...tcp(300)];
    const withSamples = reachReport(ends, DEFAULT_ROBOT);
    const endsOnly = reachReport(ends, DEFAULT_ROBOT, undefined, 1e9);
    expect(endsOnly.unreachable).toBe(0);
    expect(withSamples.unreachable).toBeGreaterThan(0);
  });
});

describe('work table height', () => {
  it('blocks a toolpath that goes below the plate (originZ = 0 → Z 0.5 < 38)', () => {
    const r = runBuild(weld(box(50, 50, 6)), I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, originZ: 0 }, 't');
    expect(r.errors.map((e) => e.k)).toContain('v.belowTable');
  });
  it('accepts the first pass 0.5 mm above the plate', () => {
    const r = runBuild(weld(box(50, 50, 6)), I, DEFAULT_PRINT, DEFAULT_ROBOT, 't');
    expect(r.errors).toEqual([]);
  });
});

describe('surface coverage (union of the deposited beads)', () => {
  it('is close to full on a flat top and sees the holes when passes are missing', () => {
    const top = weld(box(120, 80, 20));
    const s = { ...DEFAULT_PRINT, mode: 'surface' as const, wallSpacing: 6 };
    const hf = new HeightField(top);
    const runs = topSurfacePasses(top, { spacing: 6, angle: 0, maxSlope: 75, tolerance: 0.2, minLength: 10, inset: 3 }, hf);
    const [full] = surfaceCoverage(top, runs, s, hf);
    const [half] = surfaceCoverage(top, runs.filter((_, i) => i % 2 === 0), s, hf);
    expect(full).toBeGreaterThan(0.9);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
  });
});

describe('LIN approximation', () => {
  const tp = buildToolpath(weld(cylinder(60, 60, 3)), { ...DEFAULT_PRINT, layerHeight: 1.5 });
  it('C_DIS by default, like Tavolino1', () => {
    expect(writeKukaSrc(tp, DEFAULT_ROBOT)).toMatch(/^LIN \{.*\} C_DIS$/m);
  });
  it('no approximation when asked: exact stop on every point', () => {
    const src = writeKukaSrc(tp, { ...DEFAULT_ROBOT, linApprox: 'none' });
    expect(src).not.toContain('C_DIS');
    expect(src).toMatch(/^LIN \{.*\}$/m);
  });
});
