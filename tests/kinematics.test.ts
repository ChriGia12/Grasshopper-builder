import { describe, expect, it } from 'vitest';
import { flangePose, flangeTarget, inverseKinematics, KR16, type Joints } from '../src/core/robot';
import { DEFAULT_ROBOT } from '../src/core/settings';

describe('KR16 kinematics', () => {
  it('home pose puts the flange where the CAD has it', () => {
    const f = flangePose([0, -90, 90, 0, 0, 0]);
    expect(f.p[0]).toBeCloseTo(KR16.flangeHome[0], 6);
    expect(f.p[2]).toBeCloseTo(1650, 6);
  });

  it('IK inverts FK on random reachable poses', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 200; n++) {
      const q: Joints = [rnd() * 300 - 150, -130 + rnd() * 80, 30 + rnd() * 100, rnd() * 300 - 150, 10 + rnd() * 100, rnd() * 300 - 150];
      const f = flangePose(q);
      const s = inverseKinematics(f.R, f.p, q)!;
      expect(s).not.toBeNull();
      const g = flangePose(s);
      for (let i = 0; i < 3; i++) expect(g.p[i]).toBeCloseTo(f.p[i], 4);
      for (let i = 0; i < 9; i++) expect(g.R[i]).toBeCloseTo(f.R[i], 6);
    }
  });

  it('reaches the Tavolino start point with the tool pointing down', () => {
    const t = flangeTarget([-143, 569, 38.5], DEFAULT_ROBOT);
    const q = inverseKinematics(t.R, t.p);
    expect(q).not.toBeNull();
    const f = flangePose(q!);
    for (let i = 0; i < 3; i++) expect(f.p[i]).toBeCloseTo(t.p[i], 4);
  });

  it('rejects points out of reach', () => {
    const t = flangeTarget([0, 3000, 0], DEFAULT_ROBOT);
    expect(inverseKinematics(t.R, t.p)).toBeNull();
  });
});
