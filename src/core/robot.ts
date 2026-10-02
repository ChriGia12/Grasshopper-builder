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

// ---------- KR16 R2010 kinematics ----------
// Axes measured from the CAD links (home pose = KUKA A2 −90°, A3 +90°, flange along +X):
// A1 vertical through the root, A2 at (160, 0, 520), A3 980 mm above A2, wrist centre at
// (1020, 0, 1650), flange 153.9 mm beyond the wrist.
export const KR16 = {
  a1: 160,
  d1: 520,
  a2: 980,
  a3: 150, // A3 → A4 axis vertical offset
  d4: 860, // A3 → wrist centre along the forearm
  d6: 153.9, // wrist centre → flange
  flangeHome: [1173.9, 0, 1650] as V3,
  /** approximate KR16 R2010-2 software limits (deg) */
  limits: [
    [-185, 185],
    [-185, 65],
    [-138, 175],
    [-350, 350],
    [-130, 130],
    [-350, 350],
  ] as [number, number][],
};

export type Joints = [number, number, number, number, number, number];
type Mat4 = number[]; // row-major 4×4

const rotAxis = (axis: 'x' | 'y' | 'z', deg: number): M3 => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const mat4 = (R: M3, t: V3): Mat4 => [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1];
const mul4 = (a: Mat4, b: Mat4): Mat4 => {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return r;
};
/** Rotation about an axis through point p. */
const rotAbout = (axis: 'x' | 'y' | 'z', deg: number, p: V3): Mat4 => {
  const R = rotAxis(axis, deg);
  const Rp = mulMV(R, p);
  return mat4(R, [p[0] - Rp[0], p[1] - Rp[1], p[2] - Rp[2]]);
};

/**
 * Forward kinematics: transform of each link (BASE, A1…A6) from its home-pose geometry to the
 * robot root frame. KUKA sign conventions: A1 about −Z, A2/A3/A5 about +Y, A4/A6 about −X.
 */
export function linkTransforms(q: Joints): Mat4[] {
  const k = KR16;
  const zw = k.d1 + k.a2 + k.a3;
  const steps: Mat4[] = [
    rotAbout('z', -q[0], [0, 0, 0]),
    rotAbout('y', q[1] + 90, [k.a1, 0, k.d1]),
    rotAbout('y', q[2] - 90, [k.a1, 0, k.d1 + k.a2]),
    rotAbout('x', -q[3], [0, 0, zw]),
    rotAbout('y', q[4], [k.a1 + k.d4, 0, zw]),
    rotAbout('x', -q[5], [0, 0, zw]),
  ];
  const out: Mat4[] = [mat4([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0])];
  let T = out[0];
  for (const s of steps) {
    T = mul4(T, s);
    out.push(T);
  }
  return out;
}

/**
 * KUKA FLANGE frame in the link-6 frame of linkTransforms (whose X is the A6 axis, out of the
 * flange): Z out of the flange and X down at the home pose — the controller shows A 0, B 90, C 0
 * there. TOOL_DATA and the mandrino drawing (layer Mandrino of BASE ROBOT.3dm, mounting plate on
 * z = 0) are both expressed in this frame.
 */
export const FLANGE_FRAME: M3 = rotAxisY(90);

/** KUKA FLANGE pose (rotation, position) in the robot root frame. */
export function flangePose(q: Joints): { R: M3; p: V3 } {
  const T = linkTransforms(q)[6];
  const f = KR16.flangeHome;
  return {
    R: mulMM([T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]], FLANGE_FRAME),
    p: [T[0] * f[0] + T[1] * f[1] + T[2] * f[2] + T[3], T[4] * f[0] + T[5] * f[1] + T[6] * f[2] + T[7], T[8] * f[0] + T[9] * f[1] + T[10] * f[2] + T[11]],
  };
}

const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Analytic inverse kinematics for a KUKA FLANGE pose (elbow up, no flip); null when out of reach. */
export function inverseKinematics(Rf: M3, p: V3, prev?: Joints): Joints | null {
  const k = KR16;
  const R = mulMM(Rf, transpose(FLANGE_FRAME)); // link-6 frame: X along the A6 axis
  const w: V3 = [p[0] - k.d6 * R[0], p[1] - k.d6 * R[3], p[2] - k.d6 * R[6]];
  const q1 = -deg(Math.atan2(w[1], w[0]));
  const r = Math.hypot(w[0], w[1]) - k.a1;
  const z = w[2] - k.d1;
  const L3 = Math.hypot(k.d4, k.a3);
  const kk = (r * r + z * z - k.a2 * k.a2 - L3 * L3) / (2 * k.a2);
  if (Math.abs(kk) > L3) return null;
  const delta = Math.atan2(k.d4, k.a3);
  const b = Math.acos(kk / L3) - delta; // A3 − 90°
  // v = upper arm + rotated forearm, in the arm plane (r forward, z up)
  const vr = k.d4 * Math.cos(b) + k.a3 * Math.sin(b);
  const vz = k.a2 - k.d4 * Math.sin(b) + k.a3 * Math.cos(b);
  const a = Math.atan2(r, z) - Math.atan2(vr, vz); // A2 + 90°
  const q2 = deg(a) - 90;
  const q3 = deg(b) + 90;
  // Wrist: R = Rz(−q1)·Ry(a+b)·Rx(−q4)·Ry(q5)·Rx(−q6)
  const R03 = mulMM(rotAxis('z', -q1), rotAxis('y', deg(a + b)));
  const m = mulMM(transpose(R03), R);
  const candidates: Joints[] = [];
  for (const sign of [1, -1]) {
    const beta = sign * Math.acos(Math.max(-1, Math.min(1, m[0])));
    const sb = Math.sin(beta);
    let alpha = 0;
    let gamma = 0;
    if (Math.abs(sb) > 1e-6) {
      alpha = Math.atan2(m[3] / sb, -m[6] / sb);
      gamma = Math.atan2(m[1] / sb, m[2] / sb);
    } else {
      alpha = prev ? -rad(prev[3]) : 0;
      gamma = Math.atan2(-m[5], m[4]) - alpha;
    }
    candidates.push([q1, q2, q3, wrap(-deg(alpha)), deg(beta), wrap(-deg(gamma))]);
  }
  const cost = (c: Joints) => (prev ? c.reduce((s, v, i) => s + Math.abs(v - prev[i]), 0) : Math.abs(c[3]) + Math.abs(c[5]));
  return candidates.sort((x, y) => cost(x) - cost(y))[0];
}

/**
 * The spindle works along the TCP Z axis (calibrated on the robot: A −180, B 0, C 180 = tool
 * vertical, C tilts it — see "Riferimento orientamento utensile"). The spindle lies along the
 * FLANGE X axis (parallel to the flange face, 78 mm from it), so the TCP frame is the FLANGE
 * frame turned +90° about Y.
 */
const TOOL_AXIS = rotAxisY(90);
function rotAxisY(d: number): M3 {
  const c = Math.cos(rad(d));
  const s = Math.sin(rad(d));
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function toolRotation(r: RobotSettings): M3 {
  const [, , , ta, tb, tc] = r.toolData;
  return mulMM(abcMatrix(ta, tb, tc), TOOL_AXIS);
}

/** Flange pose in the robot root frame for a TCP point given in BASE. */
export function flangeTarget(p: V3, r: RobotSettings): { R: M3; p: V3 } {
  const [bx, by, bz, ba, bb, bc] = r.baseData;
  const Rb = abcMatrix(ba, bb, bc);
  const tcp = mulMV(Rb, p);
  const Rf = mulMM(mulMM(Rb, abcMatrix(r.a, r.b, r.c)), transpose(toolRotation(r)));
  const off = mulMV(Rf, [r.toolData[0], r.toolData[1], r.toolData[2]]);
  return { R: Rf, p: [tcp[0] + bx - off[0], tcp[1] + by - off[1], tcp[2] + bz - off[2]] };
}

export const withinLimits = (q: Joints) => q.every((v, i) => v >= KR16.limits[i][0] - 1e-6 && v <= KR16.limits[i][1] + 1e-6);

export interface ReachReport {
  unreachable: number; // poses the arm cannot reach (path points and intermediate LIN samples)
  outOfLimits: number; // reachable, but some axis beyond its limits
  jumps: number; // consecutive poses whose axes jump > 45°: possible wrist flip / reconfiguration
  jointMin: number[];
  jointMax: number[];
  first: Joints | null; // pose at the first point, for the viewer
  last: Joints | null; // pose at the last point (start of the final PTP)
  /** Axes A1…A6 at every path point (6 per point), NaN where the point is unreachable. */
  joints: Float64Array;
}

/**
 * Solve the arm pose along the whole path (BASE coordinates, flat xyz array): every point and,
 * on long LIN moves, intermediate samples every `segStep` mm, since the controller moves the
 * TCP on the straight line between points.
 */
export function reachReport(
  pointsBase: ArrayLike<number>,
  r: RobotSettings,
  cs?: ArrayLike<number>,
  segStep = 20,
  /** Points reached with a PTP: the TCP does not follow the straight line, no samples on it. */
  ptp?: ArrayLike<number | boolean>,
): ReachReport {
  const n = pointsBase.length / 3;
  const rep: ReachReport = {
    unreachable: 0,
    outOfLimits: 0,
    jumps: 0,
    jointMin: Array(6).fill(Infinity),
    jointMax: Array(6).fill(-Infinity),
    first: null,
    last: null,
    joints: new Float64Array(n * 6).fill(NaN),
  };
  let prev: Joints | undefined;
  /** `at`: index of the path point, or −1 for an intermediate LIN sample. */
  const solve = (p: V3, c: number | undefined, at: number) => {
    const counted = at >= 0;
    const t = flangeTarget(p, c !== undefined && Number.isFinite(c) ? { ...r, c } : r);
    const q = inverseKinematics(t.R, t.p, prev);
    if (!q) {
      rep.unreachable++;
      return;
    }
    if (prev && q.some((v, k) => Math.abs(v - prev![k]) > 45)) rep.jumps++;
    if (!withinLimits(q)) rep.outOfLimits++;
    if (counted) {
      if (!rep.first) rep.first = q;
      rep.last = q;
      rep.joints.set(q, at * 6);
      q.forEach((v, k) => {
        rep.jointMin[k] = Math.min(rep.jointMin[k], v);
        rep.jointMax[k] = Math.max(rep.jointMax[k], v);
      });
    }
    prev = q;
  };
  for (let i = 0; i < n; i++) {
    const p: V3 = [pointsBase[i * 3], pointsBase[i * 3 + 1], pointsBase[i * 3 + 2]];
    if (i > 0 && !ptp?.[i]) {
      const a: V3 = [pointsBase[i * 3 - 3], pointsBase[i * 3 - 2], pointsBase[i * 3 - 1]];
      const steps = Math.ceil(Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) / segStep);
      const c0 = cs?.[i - 1];
      const c1 = cs?.[i];
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        const c = c0 !== undefined && c1 !== undefined && Number.isFinite(c0) && Number.isFinite(c1) ? c0 + (c1 - c0) * f : undefined;
        solve([a[0] + (p[0] - a[0]) * f, a[1] + (p[1] - a[1]) * f, a[2] + (p[2] - a[2]) * f], c, -1);
      }
    }
    solve(p, cs?.[i], i);
  }
  return rep;
}

/** Robot root frame expressed in BASE: origin and rotation (row-major), for drawing the arm. */
export function robotRootFrame(r: RobotSettings): { p: V3; R: M3 } {
  const [, , , a, b, c] = r.baseData;
  return { p: robotRootInBase(r), R: transpose(abcMatrix(a, b, c)) };
}

/** Arm pose that puts the TCP on a BASE point (null if unreachable). */
export function poseAt(pBase: V3, r: RobotSettings, prev?: Joints): Joints | null {
  const t = flangeTarget(pBase, r);
  return inverseKinematics(t.R, t.p, prev);
}

/**
 * Axis poses the robot passes through between two programs run one after the other (supports
 * in a separate file, then the part): the first ends with a PTP to the safe position and the
 * homing, the second starts from the safe position with a PTP to its first point. Every leg is a
 * PTP: the axes move linearly from one pose to the next.
 */
export function programChangePoses(from: Joints, to: Joints, r: RobotSettings): Joints[] {
  const safe = [...r.safeAxes] as Joints;
  const home = [safe[0], safe[1], 0, safe[3], safe[4], safe[5]] as Joints;
  return r.useHoming ? [from, safe, home, safe, to] : [from, safe, to];
}

/** Pose at `t` degrees along PTP legs through `poses` (each leg as long as its largest axis move). */
export function alongPtp(poses: Joints[], t: number): { q: Joints; leg: number; done: boolean } {
  let left = Math.max(0, t);
  for (let k = 1; k < poses.length; k++) {
    const [a, b] = [poses[k - 1], poses[k]];
    const len = Math.max(...a.map((v, j) => Math.abs(b[j] - v)));
    if (left < len) return { q: a.map((v, j) => v + ((b[j] - v) * left) / len) as Joints, leg: k - 1, done: false };
    left -= len;
  }
  return { q: poses[poses.length - 1], leg: poses.length - 2, done: true };
}

