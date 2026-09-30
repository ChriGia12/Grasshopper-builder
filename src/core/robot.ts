// KUKA frame math: BASE_DATA / TOOL_DATA are {X,Y,Z,A,B,C} with A,B,C rotations about Z,Y,X
// (R = Rz(A)·Ry(B)·Rx(C)). Used to find where the robot flange must be for every path point
// and to check it stays inside the arm's reach.
import type { RobotSettings } from './settings';

export type Frame6 = [number, number, number, number, number, number];
type V3 = [number, number, number];
type M3 = [number, number, number, number, number, number, number, number, number];

const rad = (d: number) => (d * Math.PI) / 180;

export function abcMatrix(a: number, b: number, c: number): M3 {
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(rad(a)), Math.sin(rad(a)), Math.cos(rad(b)), Math.sin(rad(b)), Math.cos(rad(c)), Math.sin(rad(c))];
  return [
    ca * cb, ca * sb * sc - sa * cc, ca * sb * cc + sa * sc,
    sa * cb, sa * sb * sc + ca * cc, sa * sb * cc - ca * sc,
    -sb, cb * sc, cb * cc,
  ];
}

const mulMV = (m: M3, v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const mulMM = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
const transpose = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Robot root (ROBROOT) origin expressed in the BASE frame, for the viewer. */
export function robotRootInBase(r: RobotSettings): V3 {
  const [x, y, z, a, b, c] = r.baseData;
  // p_base = Rᵀ · (p_root − t) with p_root = 0
  return mulMV(transpose(abcMatrix(a, b, c)), [-x, -y, -z]);
}

/**
 * Flange position in ROBROOT for a TCP point given in BASE:
 * TCP = BASE · p; R_tcp = R_base · R(A,B,C of the path); flange = TCP − R_flange · t_tool,
 * with R_flange = R_tcp · R_toolᵀ.
 */
export function flangeInRoot(p: V3, r: RobotSettings): V3 {
  const [bx, by, bz, ba, bb, bc] = r.baseData;
  const Rb = abcMatrix(ba, bb, bc);
  const tcp = mulMV(Rb, p);
  tcp[0] += bx;
  tcp[1] += by;
  tcp[2] += bz;
  const Rtcp = mulMM(Rb, abcMatrix(r.a, r.b, r.c));
  const [tx, ty, tz, ta, tb, tc] = r.toolData;
  const Rf = mulMM(Rtcp, transpose(abcMatrix(ta, tb, tc)));
  const off = mulMV(Rf, [tx, ty, tz]);
  return [tcp[0] - off[0], tcp[1] - off[1], tcp[2] - off[2]];
}

export interface ReachReport {
  minRadius: number; // horizontal distance of the flange from axis A1 (mm)
  maxRadius: number;
  minZ: number; // flange height in ROBROOT
  maxZ: number;
  outOfReach: number; // points with radius > maxReach
}

/** Approximate reach check (flange distance from A1), until the full kinematics is modelled. */
export function reachReport(pointsBase: ArrayLike<number>, r: RobotSettings): ReachReport {
  const rep: ReachReport = { minRadius: Infinity, maxRadius: 0, minZ: Infinity, maxZ: -Infinity, outOfReach: 0 };
  for (let i = 0; i < pointsBase.length; i += 3) {
    const f = flangeInRoot([pointsBase[i], pointsBase[i + 1], pointsBase[i + 2]], r);
    const d = Math.hypot(f[0], f[1]);
    rep.minRadius = Math.min(rep.minRadius, d);
    rep.maxRadius = Math.max(rep.maxRadius, d);
    rep.minZ = Math.min(rep.minZ, f[2]);
    rep.maxZ = Math.max(rep.maxZ, f[2]);
    if (d > r.maxReach) rep.outOfReach++;
  }
  return rep;
}
