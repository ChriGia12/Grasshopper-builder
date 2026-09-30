import { describe, expect, it } from 'vitest';
import { weld, type MeshData } from '../src/core/mesh';
import { buildToolpath } from '../src/core/toolpath';
import { cFromNormal } from '../src/core/surface';
import { DEFAULT_PRINT } from '../src/core/settings';
import { box } from './fixtures';

/** Wedge: 100 × 60 base, top rising along Y (z = 20 + 0.5·y). */
function wedge(): MeshData {
  const m = box(100, 60, 20);
  const p = m.positions.slice();
  for (let v = 4; v < 8; v++) p[v * 3 + 2] = 20 + 0.5 * p[v * 3 + 1];
  return weld({ positions: p, indices: m.indices });
}

describe('pieno a serpentina', () => {
  const s = { ...DEFAULT_PRINT, mode: 'zigzag' as const, layerHeight: 3, firstLayerZ: 3, wallSpacing: 6, fillPerimeter: false, fillAlternate: false };
  const tp = buildToolpath(weld(box(100, 60, 6)), s);

  it('fills each layer with passes one bead apart, without stopping', () => {
    expect(tp.mode).toBe('zigzag');
    expect(tp.travels).toBe(0);
    const layer0 = tp.points.slice(0, tp.layerStart[1]);
    const ys = [...new Set(layer0.map((p) => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b);
    expect(ys.length).toBe(10); // 60 mm / 6 mm
    expect(ys[1] - ys[0]).toBeCloseTo(6, 6);
    for (const p of layer0) {
      expect(p.z).toBe(3);
      expect(p.x).toBeGreaterThanOrEqual(3 - 1e-6); // half bead inside the outline
      expect(p.x).toBeLessThanOrEqual(97 + 1e-6);
    }
  });

  it('adds the perimeter first when asked', () => {
    const t2 = buildToolpath(weld(box(100, 60, 6)), { ...s, fillPerimeter: true });
    const first = t2.points.slice(0, 6);
    expect(first.some((p) => Math.abs(p.x) < 1e-6 || Math.abs(p.x - 100) < 1e-6)).toBe(true);
  });
});

describe('pieno a serpentina con finitura superiore', () => {
  const s = { ...DEFAULT_PRINT, mode: 'zigzag' as const, layerHeight: 1.5, firstLayerZ: 0.5, wallSpacing: 6, fillPerimeter: false, fillTopSurface: true, surfacePasses: 1 };
  const tp = buildToolpath(wedge(), s);
  const last = tp.layerStart[tp.layerStart.length - 1];

  it('stops the planar body below the top surface', () => {
    for (const p of tp.points.slice(0, last).filter((q) => q.e)) {
      const beadTop = p.z + (1.5 - 0.5);
      expect(beadTop).toBeLessThanOrEqual(20 + 0.5 * p.y - 1.5 + 1e-3 + 0.5 * 2); // within one sample step
    }
  });

  it('closes with one layer following the surface (bead top on the real top)', () => {
    const top = tp.points.slice(last).filter((q) => q.e);
    expect(top.length).toBeGreaterThan(10);
    for (const p of top) expect(p.z + 1).toBeCloseTo(20 + 0.5 * p.y, 3);
  });

  it('orders passes as a clean serpentine (no travels on a simple block)', () => {
    const flat = buildToolpath(weld(box(100, 60, 9)), { ...s, fillTopSurface: false });
    expect(flat.travels).toBe(0);
  });
});

describe('superficie superiore a serpentina', () => {
  const s = { ...DEFAULT_PRINT, mode: 'surface' as const, firstLayerZ: 0.5, wallSpacing: 6, tolerance: 0.05 };

  it('follows the top surface height point by point', () => {
    const tp = buildToolpath(wedge(), s);
    expect(tp.mode).toBe('surface');
    expect(tp.points.length).toBeGreaterThan(10);
    for (const p of tp.points.filter((q) => q.e)) expect(p.z).toBeCloseTo(20 + 0.5 * p.y + 0.5, 3);
    // no point on the vertical sides
    for (const p of tp.points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(100);
    }
  });

  it('tilts the tool with C from the normal when asked', () => {
    const tp = buildToolpath(wedge(), { ...s, surfaceTilt: true });
    const expected = cFromNormal([0, -0.5 / Math.hypot(0.5, 1), 1 / Math.hypot(0.5, 1)]);
    // same as the calibration formula C = 180° − arccos(Nz)
    expect(expected).toBeCloseTo(180 - (Math.acos(1 / Math.hypot(0.5, 1)) * 180) / Math.PI, 6);
    for (const p of tp.points.filter((q) => q.e)) expect(p.c).toBeCloseTo(expected, 6);
  });

  it('flat top keeps C at 180 (vertical)', () => {
    expect(cFromNormal([0, 0, 1])).toBeCloseTo(180, 9);
  });
});
