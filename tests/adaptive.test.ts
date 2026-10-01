// Adaptive layers: on shallow surfaces consecutive curves stay one layer height apart along the
// surface, instead of drifting apart as Z grows by a fixed step.
import { describe, expect, it } from 'vitest';
import { sliceForPrint } from '../src/core/toolpath';
import { weld } from '../src/core/mesh';
import { DEFAULT_PRINT, type PrintSettings } from '../src/core/settings';
import { cylinder } from './fixtures';

// Shallow cone: radius 60 → 10 over 20 mm, slope 21.8° from horizontal (a dome-like flank).
const cone = weld(cylinder(60, 10, 20));
const radius = (pts: [number, number][]) => Math.max(...pts.map(([x, y]) => Math.hypot(x, y)));

/** Distance along the surface between consecutive curves (radius step and Z step together). */
function gaps(s: PrintSettings) {
  const { layers } = sliceForPrint(cone, s);
  const rings = layers.filter((l) => l.contours.length).map((l) => ({ z: l.z, r: radius(l.contours[0].pts) }));
  return rings.slice(1).map((c, i) => Math.hypot(c.r - rings[i].r, c.z - rings[i].z));
}

describe('adaptive layers', () => {
  const s: PrintSettings = { ...DEFAULT_PRINT, mode: 'planar', thinWallMax: 0, minContourLength: 0 };

  it('with a fixed 1.5 mm step the curves on a 22° flank are about 4 mm apart', () => {
    const g = gaps(s);
    expect(Math.max(...g)).toBeGreaterThan(3.5);
  });

  it('adaptive: every curve is at most one layer height (1.5 mm) from the next', () => {
    const g = gaps({ ...s, adaptiveLayers: true, minLayerHeight: 0.3 });
    expect(Math.max(...g.slice(0, -2))).toBeLessThanOrEqual(1.5 * 1.05); // the last rings close the top
    expect(g.length).toBeGreaterThan(30);
  });

  it('vertical walls keep the full layer height', () => {
    const wall = weld(cylinder(40, 40, 30));
    const uniform = sliceForPrint(wall, s).layers.length;
    const adaptive = sliceForPrint(wall, { ...s, adaptiveLayers: true }).layers.length;
    expect(adaptive).toBe(uniform);
  });

  it('only for contour layers: the other modes keep the fixed step', () => {
    const n = sliceForPrint(cone, { ...s, mode: 'zigzag' }).layers.length;
    expect(sliceForPrint(cone, { ...s, mode: 'zigzag', adaptiveLayers: true }).layers.length).toBe(n);
  });
});
