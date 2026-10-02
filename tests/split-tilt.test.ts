// Cut in two pieces when a part cannot be printed whole, and tool tilt along the walls.
import { describe, expect, it } from 'vitest';
import { analyzeOrientations } from '../src/core/orientation';
import { splitPiece, suggestSplit } from '../src/core/split';
import { buildToolpath } from '../src/core/toolpath';
import { runBuild } from '../src/core/pipeline';
import { IDENTITY, weld, type Mat3 } from '../src/core/mesh';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box, lathe } from './fixtures';

const I = [...IDENTITY] as Mat3;
const whole = (m: ReturnType<typeof weld>) => {
  const o = analyzeOrientations(m, DEFAULT_PRINT.overhangAngle, DEFAULT_PRINT.layerHeight, DEFAULT_PRINT.thinWallMax)[0];
  return { o, info: { overhang: o.overhangRatio, islands: o.unsupportedIslands } };
};

describe('cut in two pieces', () => {
  // Hourglass: wide – narrow – wide. Every orientation overhangs; cut in two, both halves can rest
  // on a flat face and print without supports.
  const hourglass = weld(lathe([[40, 0], [10, 30], [40, 60]]));

  it('a part printable whole needs no cut', () => {
    const block = weld(box(60, 40, 30));
    const w = whole(block);
    expect(w.o.valid).toBe(true);
  });

  it('a part that cannot be printed whole gets a cut where both pieces print without supports', () => {
    const w = whole(hourglass);
    expect(w.o.valid).toBe(false);
    const plan = suggestSplit(hourglass, DEFAULT_PRINT, w.info)!;
    expect(plan).not.toBeNull();
    expect(plan.valid).toBe(true);
    expect(plan.pieces.every((p) => p.valid && p.islands === 0)).toBe(true);
  });

  it('the pieces, oriented as suggested, really pass the support check', () => {
    const plan = suggestSplit(hourglass, DEFAULT_PRINT, whole(hourglass).info)!;
    for (const q of plan.pieces) {
      const piece = splitPiece(hourglass, plan.axis, plan.d, q.side);
      const o = analyzeOrientations(piece, DEFAULT_PRINT.overhangAngle, DEFAULT_PRINT.layerHeight).find(
        (c) => c.down[0] * q.down[0] + c.down[1] * q.down[1] + c.down[2] * q.down[2] > 0.999,
      )!;
      expect(o.valid).toBe(true);
    }
  });
});

describe('tool tilt along the walls', () => {
  const s = { ...DEFAULT_PRINT, mode: 'planar' as const, toolTilt: true, maxTilt: 30 };

  it('vertical walls: the tool stays vertical', () => {
    const r = runBuild(weld(box(60, 40, 20)), I, s, DEFAULT_ROBOT, 't');
    for (const p of r.toolpath.points) expect(Math.abs(((p.c! - 180 + 540) % 360) - 180)).toBeLessThan(1);
  });

  it('a 45° overhang: the tool leans up to the maximum on the walls facing ±Y', () => {
    // Cone widening upwards at 45°: the walls lean 45° out, the tool leans 30° (the maximum).
    const cone = weld(lathe([[20, 0], [50, 30]]));
    const tp = buildToolpath(cone, s);
    const r = runBuild(cone, I, s, DEFAULT_ROBOT, 't');
    const lean = r.toolpath.points.map((p) => Math.abs(((p.c! - 180 + 540) % 360) - 180));
    expect(Math.max(...lean)).toBeGreaterThan(25);
    expect(Math.max(...lean)).toBeLessThanOrEqual(30.5);
    expect(tp.points.length).toBeGreaterThan(0);
    // The walls facing ±X lean along X: C cannot follow there, and it is counted.
    expect(r.toolpath.tiltX).toBeGreaterThan(0);
  });

  it('off by default: no C on the points', () => {
    const r = runBuild(weld(lathe([[20, 0], [50, 30]])), I, { ...DEFAULT_PRINT, mode: 'planar' }, DEFAULT_ROBOT, 't');
    expect(r.toolpath.points.every((p) => p.c === undefined)).toBe(true);
  });
});
