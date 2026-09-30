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
