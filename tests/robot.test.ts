import { describe, expect, it } from 'vitest';
import { abcMatrix, flangeTarget, reachReport, robotRootInBase } from '../src/core/robot';
import { DEFAULT_ROBOT } from '../src/core/settings';

describe('robot frames', () => {
  it('A-180 B0 C180 points the tool Z axis down', () => {
    const m = abcMatrix(-180, 0, 180);
    expect(m[8]).toBeCloseTo(-1); // z·z
    expect(m[0]).toBeCloseTo(-1); // x·x
  });

  it('works vertically: at A-180 B0 C180 the flange is straight above the nozzle', () => {
    // TCP at BASE origin; BASE is at (1448, -1000, 5) from the robot root.
    const f = flangeTarget([0, 0, 0], DEFAULT_ROBOT);
    expect(f.p[0]).toBeCloseTo(1448 - 78.111, 3);
    expect(f.p[1]).toBeCloseTo(-1000, 3);
    expect(f.p[2]).toBeCloseTo(5 + 372.65, 3);
    // flange normal (KUKA flange X) points down, like the spindle
    expect(f.R[6]).toBeCloseTo(-1, 6);
  });

  it('C tilts the spindle: C 90 lays it horizontal', () => {
    const f = flangeTarget([0, 0, 0], { ...DEFAULT_ROBOT, c: 90 });
    expect(Math.abs(f.R[6])).toBeLessThan(1e-9);
  });

  it('robot root sits 1448 / 1000 / 5 mm from BASE (Rhino world origin)', () => {
    const r = robotRootInBase(DEFAULT_ROBOT);
    expect(r[0]).toBeCloseTo(-1448);
    expect(r[1]).toBeCloseTo(1000);
    expect(r[2]).toBeCloseTo(-5);
  });

  it('reports points out of reach', () => {
    const rep = reachReport([0, 500, 40, 0, 3000, 40], DEFAULT_ROBOT);
    expect(rep.unreachable).toBe(1);
    expect(rep.first).not.toBeNull();
  });
});

import { runBuild } from '../src/core/pipeline';
import { IDENTITY, weld } from '../src/core/mesh';
import { DEFAULT_PRINT } from '../src/core/settings';
import { box } from './fixtures';

describe('placement and start point', () => {
  const part = weld(box(100, 60, 6));
  it('starts at the contour point nearest the requested BASE point', () => {
    const robot = { ...DEFAULT_ROBOT, placement: 'origin' as const, originX: 0, originY: 500, originZ: 0 };
    const r = runBuild(part, [...IDENTITY] as never, { ...DEFAULT_PRINT, layerHeight: 3, startMode: 'point', startX: 50, startY: 540 }, robot, 't');
    const p = r.toolpath.points[0];
    // back-right corner of a 100×60 box centred at (0,500)
    expect(p.x + r.offset[0]).toBeCloseTo(50, 3);
    expect(p.y + r.offset[1]).toBeCloseTo(530, 3);
  });
  it('rotates the part on the bed', () => {
    const robot = { ...DEFAULT_ROBOT, placement: 'origin' as const, rotationZ: 90 };
    const r = runBuild(part, [...IDENTITY] as never, { ...DEFAULT_PRINT, layerHeight: 3 }, robot, 't');
    expect(r.max[0] - r.min[0]).toBeCloseTo(60, 1);
    expect(r.max[1] - r.min[1]).toBeCloseTo(100, 1);
  });
});
