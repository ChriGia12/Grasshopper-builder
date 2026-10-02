import { describe, expect, it } from 'vitest';
import { abcMatrix, alongPtp, flangeTarget, programChangePoses, reachReport, robotRootInBase, type Joints } from '../src/core/robot';
import { DEFAULT_ROBOT } from '../src/core/settings';

describe('robot frames', () => {
  it('A-180 B0 C180 points the tool Z axis down', () => {
    const m = abcMatrix(-180, 0, 180);
    expect(m[8]).toBeCloseTo(-1); // z·z
    expect(m[0]).toBeCloseTo(-1); // x·x
  });

  it('works vertically: at A-180 B0 C180 the flange is straight above the nozzle', () => {
    // TCP at BASE origin; BASE is at (1448, 0, 5) from the robot root.
    const f = flangeTarget([0, 0, 0], DEFAULT_ROBOT);
    expect(f.p[0]).toBeCloseTo(1448 - 78.111, 3);
    expect(f.p[1]).toBeCloseTo(0, 3);
    expect(f.p[2]).toBeCloseTo(5 + 372.65, 3);
    // the spindle (FLANGE X) points down; the flange face (FLANGE Z) looks sideways along +X
    expect(f.R[6]).toBeCloseTo(-1, 6);
    expect(f.R[2]).toBeCloseTo(1, 6);
  });

  it('C tilts the spindle: C 90 lays it horizontal', () => {
    const f = flangeTarget([0, 0, 0], { ...DEFAULT_ROBOT, c: 90 });
    expect(Math.abs(f.R[6])).toBeLessThan(1e-9);
  });

  it('robot root sits 1448 mm behind BASE, same Y (world 0, -1000, 0)', () => {
    const r = robotRootInBase(DEFAULT_ROBOT);
    expect(r[0]).toBeCloseTo(-1448);
    expect(r[1]).toBeCloseTo(0);
    expect(r[2]).toBeCloseTo(-5);
  });

  it('reports points out of reach', () => {
    const rep = reachReport([0, 500, 40, 0, 3000, 40], DEFAULT_ROBOT);
    // the far end and the LIN samples on the way to it are out of reach
    expect(rep.unreachable).toBeGreaterThan(1);
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

describe('PTP moves between two programs', () => {
  const from: Joints = [-20, -55, 113, -23, -60, 12];
  const to: Joints = [-22, -43, 113, -24, -71, 8];

  it('the support program ends at the safe position and homing, the part program starts from the safe position', () => {
    const safe = [...DEFAULT_ROBOT.safeAxes];
    const home = [safe[0], safe[1], 0, safe[3], safe[4], safe[5]];
    expect(programChangePoses(from, to, DEFAULT_ROBOT)).toEqual([from, safe, home, safe, to]);
    expect(programChangePoses(from, to, { ...DEFAULT_ROBOT, useHoming: false })).toEqual([from, safe, to]);
  });

  it('the axes move linearly along each leg and stop at the last pose', () => {
    const poses = programChangePoses(from, to, DEFAULT_ROBOT);
    const first = Math.max(...from.map((v, j) => Math.abs(poses[1][j] - v))); // degrees of the first leg
    const mid = alongPtp(poses, first / 2);
    expect(mid.leg).toBe(0);
    mid.q.forEach((v, j) => expect(v).toBeCloseTo((from[j] + poses[1][j]) / 2, 9));
    expect(alongPtp(poses, first + 1e-9).leg).toBe(1);
    const end = alongPtp(poses, 1e6);
    expect(end.done).toBe(true);
    expect(end.q).toEqual(to);
  });
});

