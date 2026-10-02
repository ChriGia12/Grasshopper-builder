// Layer change as a ramp: no vertical step at the seam; the bead climbs to the new layer while it
// keeps printing along the loop, over the first `layerRamp` mm.
import { describe, expect, it } from 'vitest';
import { buildToolpath, type Toolpath } from '../src/core/toolpath';
import { weld } from '../src/core/mesh';
import { DEFAULT_PRINT, type PrintSettings } from '../src/core/settings';
import { cylinder, frame } from './fixtures';

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

  it('near a flat top the loops move apart, the bead still climbs on a ramp (no lift, no vertical)', () => {
    // A low cone: the horizontal loops near its top are several mm apart in plan.
    const cone = weld(cylinder(90, 8, 12)); // loops ~10 mm apart in plan, more than maxBridge (8)
    const tp = buildToolpath(cone, { ...DEFAULT_PRINT, mode: 'planar' });
    expect(tp.travels).toBe(0);
    const ch = changes(tp);
    expect(ch.length).toBeGreaterThan(5);
    for (const c of ch) expect(c.steepest).toBeLessThan(0.2);
  });

  it('ramp 0: the old vertical step at the seam', () => {
    const ch = changes(buildToolpath(tube, { ...DEFAULT_PRINT, mode: 'planar', layerRamp: 0 }));
    expect(ch.every((c) => c.steepest > 1)).toBe(true); // 1.5 mm up within a fraction of a mm
  });
});

describe('always the same way round', () => {
  /** Sign of the area of every printed loop (+ = counter-clockwise from above). */
  const senses = (tp: Toolpath) =>
    tp.layerStart.map((st, i) => {
      const pts = tp.points.slice(st, tp.layerStart[i + 1] ?? tp.points.length).filter((p) => p.e);
      let a = 0;
      for (let j = 0; j < pts.length; j++) {
        const [p, q] = [pts[j], pts[(j + 1) % pts.length]];
        a += p.x * q.y - q.x * p.y;
      }
      return Math.sign(a);
    });

  it('contour layers of a frame (outer edge and hole): both loops counter-clockwise', () => {
    const f = weld(frame(80, 20, 12));
    const tp = buildToolpath(f, { ...DEFAULT_PRINT, mode: 'planar', thinWallMax: 0 });
    // The frame is centred on (40, 40) in its own frame: every printed move turns around it the
    // same way (the outer loop and the hole), apart from the short steps between the two loops.
    const pts = tp.points;
    const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
    const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
    let back = 0;
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      if (!pts[i].e) continue;
      let d = Math.atan2(pts[i].y - cy, pts[i].x - cx) - Math.atan2(pts[i - 1].y - cy, pts[i - 1].x - cx);
      d = ((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      total += Math.abs(d);
      if (d < 0) back += -d;
    }
    expect(total).toBeGreaterThan(20 * Math.PI);
    expect(back / total).toBeLessThan(0.01);
  });

  it('rings following the surface: every ring the same way round', () => {
    const tp = buildToolpath(weld(cylinder(60, 10, 30)), { ...DEFAULT_PRINT, mode: 'planar', adaptiveLayers: true });
    expect(senses(tp).every((x) => x > 0)).toBe(true);
  });
});
