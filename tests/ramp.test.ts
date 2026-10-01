// Layer change as a ramp: no vertical step at the seam; the bead climbs to the new layer while it
// keeps printing along the loop, over the first `layerRamp` mm.
import { describe, expect, it } from 'vitest';
import { buildToolpath, type Toolpath } from '../src/core/toolpath';
import { weld } from '../src/core/mesh';
import { DEFAULT_PRINT, type PrintSettings } from '../src/core/settings';
import { cylinder } from './fixtures';

const tube = weld(cylinder(40, 40, 9));

/**
 * Every layer change that climbs: from the last point of the layer below to where the new loop
 * reaches its height — the steepest single move and the length (in plan) of the climb.
 */
function changes(tp: Toolpath) {
  const pts = tp.points;
  return tp.layerStart
    .slice(1)
    .map((start, k) => {
      const end = k + 2 < tp.layerStart.length ? tp.layerStart[k + 2] : pts.length;
      const top = pts[end - 1].z; // the loop closes at the height of its layer
      let i = start - 1;
      const from = pts[i].z;
      let steepest = 0;
      let length = 0;
      while (i < end - 1 && pts[i].z < top - 1e-9) {
        const [a, b] = [pts[i], pts[i + 1]];
        const plan = Math.hypot(b.x - a.x, b.y - a.y);
        steepest = Math.max(steepest, plan < 1e-6 ? (b.z - a.z > 1e-9 ? Infinity : 0) : (b.z - a.z) / plan);
        length += plan;
        i++;
      }
      return { climb: top - from, steepest, length };
    })
    .filter((c) => c.climb > 0.1);
}

describe('layer change ramp', () => {
  for (const [name, s] of [
    ['contour layers', { ...DEFAULT_PRINT, mode: 'planar' }],
    ['rings following the surface', { ...DEFAULT_PRINT, mode: 'planar', adaptiveLayers: true }],
  ] as [string, PrintSettings][])
    it(`${name}: the bead climbs gradually over 20 mm, never straight up`, () => {
      const tp = buildToolpath(tube, s);
      expect(tp.travels).toBe(0);
      expect(tp.points.slice(1).every((p) => p.e)).toBe(true);
      const ch = changes(tp);
      expect(ch.length).toBeGreaterThan(3);
      for (const c of ch) {
        expect(c.steepest).toBeLessThan(0.2); // 1.5 mm over 20 mm ≈ 0.075
        expect(c.length).toBeGreaterThan(19);
        expect(c.length).toBeLessThan(25);
      }
    });

  it('ramp 0: the old vertical step at the seam', () => {
    const ch = changes(buildToolpath(tube, { ...DEFAULT_PRINT, mode: 'planar', layerRamp: 0 }));
    expect(ch.every((c) => c.steepest > 1)).toBe(true); // 1.5 mm up within a fraction of a mm
  });
});
