import { describe, expect, it } from 'vitest';
import { abcMatrix, flangeInRoot, reachReport, robotRootInBase } from '../src/core/robot';
import { DEFAULT_ROBOT } from '../src/core/settings';

describe('robot frames', () => {
  it('A-180 B0 C180 points the tool Z axis down', () => {
    const m = abcMatrix(-180, 0, 180);
    expect(m[8]).toBeCloseTo(-1); // z·z
    expect(m[0]).toBeCloseTo(-1); // x·x
  });

  it('places the flange 372.65 / 78.111 mm away from the nozzle', () => {
    // BASE_DATA {0,1000,0}, TCP at BASE origin, tool pointing down.
    const f = flangeInRoot([0, 0, 0], DEFAULT_ROBOT);
    expect(f[0]).toBeCloseTo(372.65, 3);
    expect(f[1]).toBeCloseTo(1000, 3);
    expect(f[2]).toBeCloseTo(78.111, 3);
  });

  it('robot root lies 1000 mm behind BASE along −Y', () => {
    const r = robotRootInBase(DEFAULT_ROBOT);
    expect(r[0]).toBeCloseTo(0);
    expect(r[1]).toBeCloseTo(-1000);
    expect(r[2]).toBeCloseTo(0);
  });

  it('flags points beyond the reach', () => {
    const rep = reachReport([0, 500, 40, 0, 2000, 40], DEFAULT_ROBOT);
    expect(rep.outOfReach).toBe(1);
    expect(rep.maxRadius).toBeGreaterThan(3000);
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
