// Collision check of the arm and the mandrino against the work plate and the material already
// deposited, along the print path (LIN) and on the PTP moves to and from the safe position.
// Bodies are point samples of the cell meshes (public/cell.bin); the printed part is a voxel set
// grown bead by bead while the path is replayed.
import { FLANGE_FRAME, KR16, linkTransforms, robotRootFrame, type Joints } from './robot';
import type { PrintSettings, RobotSettings } from './settings';

type V3 = [number, number, number];

/** Cell part as stored in public/cell.json (offsets into public/cell.bin). */
export interface CellPart {
  name: string;
  kind: 'static' | 'link' | 'tool';
  color: string;
  link?: number;
  positions: [number, number];
  indices: [number, number];
}

/**
 * Point samples of a moving body in its link-home frame (the frame linkTransforms moves).
 * `needle`: the nozzle tip region, which touches the bead on purpose — checked only against
 * the plate.
 */
export interface Body {
  name: string;
  link: number;
  needle: boolean;
  pts: Float32Array;
}

/** Around the TCP the needle and the nozzle touch the bead on purpose (mm). */
export const NEEDLE_LENGTH = 45;

/** Keep one vertex per `cell`-mm grid cell: a light but faithful sampling of the surface. */
function downsample(pos: Float32Array, cell: number): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${Math.floor(pos[i] / cell)},${Math.floor(pos[i + 1] / cell)},${Math.floor(pos[i + 2] / cell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pos[i], pos[i + 1], pos[i + 2]);
  }
  return out;
}

/**
 * Bodies to check, from the cell: forearm and wrist links (A3…A6) and the mandrino, which is
 * drawn in the KUKA FLANGE frame and moved here into the link-6 home frame. `tip` is the TCP in
 * the FLANGE frame (TOOL_DATA).
 */
export function cellBodies(parts: CellPart[], bin: ArrayBuffer, tip: V3): Body[] {
  const bodies: Body[] = [];
  for (const part of parts) {
    const pos = new Float32Array(bin, part.positions[0], part.positions[1]);
    if (part.kind === 'link' && part.link !== undefined && part.link >= 3) {
      bodies.push({ name: part.name, link: part.link, needle: false, pts: Float32Array.from(downsample(pos, 25)) });
    } else if (part.kind === 'tool') {
      const F = FLANGE_FRAME;
      const h = KR16.flangeHome;
      const body: number[] = [];
      const needle: number[] = [];
      const s = downsample(pos, 8);
      for (let i = 0; i < s.length; i += 3) {
        const [x, y, z] = [s[i], s[i + 1], s[i + 2]];
        const near = Math.hypot(x - tip[0], y - tip[1], z - tip[2]) < NEEDLE_LENGTH;
        (near ? needle : body).push(
          h[0] + F[0] * x + F[1] * y + F[2] * z,
          h[1] + F[3] * x + F[4] * y + F[5] * z,
          h[2] + F[6] * x + F[7] * y + F[8] * z,
        );
      }
      bodies.push({ name: part.name, link: 6, needle: false, pts: Float32Array.from(body) });
      bodies.push({ name: 'ugello', link: 6, needle: true, pts: Float32Array.from(needle) });
    }
  }
  return bodies;
}

const VOXEL = 4; // mm
const vkey = (ix: number, iy: number, iz: number) => (ix + 2048) * 16777216 + (iy + 2048) * 4096 + (iz + 2048);

/** Obstacles in BASE: the work plate and the printed material (voxels). */
export class Obstacles {
  private voxels = new Set<number>();
  private readonly bed: [number, number, number, number];
  private readonly root: { p: V3; R: number[] };

  constructor(
    private readonly r: RobotSettings,
    private readonly bodies: Body[],
  ) {
    this.bed = [r.bedCenterX - r.bedSizeX / 2, r.bedCenterY - r.bedSizeY / 2, r.bedCenterX + r.bedSizeX / 2, r.bedCenterY + r.bedSizeY / 2];
    this.root = robotRootFrame(r);
  }

  /** Material of one bead along a→b (BASE): nozzle `firstLayerZ` above the bead bottom. */
  addBead(a: V3, b: V3, s: Pick<PrintSettings, 'layerHeight' | 'firstLayerZ' | 'wallSpacing'>) {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (VOXEL / 2)));
    const hw = s.wallSpacing / 2;
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const y = a[1] + ((b[1] - a[1]) * k) / n;
      const z = a[2] + ((b[2] - a[2]) * k) / n;
      const z0 = Math.floor((z - s.firstLayerZ) / VOXEL);
      const z1 = Math.floor((z - s.firstLayerZ + s.layerHeight) / VOXEL);
      for (let ix = Math.floor((x - hw) / VOXEL); ix <= Math.floor((x + hw) / VOXEL); ix++)
        for (let iy = Math.floor((y - hw) / VOXEL); iy <= Math.floor((y + hw) / VOXEL); iy++)
          for (let iz = z0; iz <= z1; iz++) this.voxels.add(vkey(ix, iy, iz));
    }
  }

  /** What the arm hits in pose q, or null. `part`: also check the printed material. */
  hit(q: Joints, part: boolean): { what: 'plate' | 'part'; body: string } | null {
    const T = linkTransforms(q);
    const { p: o, R } = this.root;
    const top = this.r.bedTopZ - 1; // 1 mm tolerance on the plate
    const [bx0, by0, bx1, by1] = this.bed;
    for (const b of this.bodies) {
      const m = T[b.link];
      const pts = b.pts;
      for (let i = 0; i < pts.length; i += 3) {
        const x0 = m[0] * pts[i] + m[1] * pts[i + 1] + m[2] * pts[i + 2] + m[3];
        const y0 = m[4] * pts[i] + m[5] * pts[i + 1] + m[6] * pts[i + 2] + m[7];
        const z0 = m[8] * pts[i] + m[9] * pts[i + 1] + m[10] * pts[i + 2] + m[11];
        const x = R[0] * x0 + R[1] * y0 + R[2] * z0 + o[0];
        const y = R[3] * x0 + R[4] * y0 + R[5] * z0 + o[1];
        const z = R[6] * x0 + R[7] * y0 + R[8] * z0 + o[2];
        if (z < top && x > bx0 && x < bx1 && y > by0 && y < by1) return { what: 'plate', body: b.name };
        if (part && !b.needle && this.voxels.has(vkey(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL))))
          return { what: 'part', body: b.name };
      }
    }
    return null;
  }
}

export interface CollisionReport {
  /** Path points where the arm or the mandrino hits the plate or the printed part. */
  count: number;
  /** Index of the first one (−1 if none), what is hit and by which body. */
  first: number;
  what: 'plate' | 'part' | null;
  body: string;
  /** Up to 500 colliding path indices, for the viewer. */
  points: number[];
  /** PTP moves (start, end, homing) that hit something: move name, what, body. */
  ptp: { move: 'start' | 'end' | 'home'; what: 'plate' | 'part'; body: string }[];
}

/**
 * Replays the path: before checking pose i the beads up to i are deposited. Poses are checked
 * every `step` mm of nozzle motion. Then the PTP moves of the program (joint interpolation):
 * safe → first point, last point → safe, safe → homing (A3 = 0) → safe.
 */
export function collisionReport(
  pts: ArrayLike<number>,
  ext: ArrayLike<number | boolean>,
  joints: Float64Array,
  bodies: Body[],
  r: RobotSettings,
  s: Pick<PrintSettings, 'layerHeight' | 'firstLayerZ' | 'wallSpacing'>,
  ends: { first: Joints | null; last: Joints | null },
  step = 3,
): CollisionReport {
  const rep: CollisionReport = { count: 0, first: -1, what: null, body: '', points: [], ptp: [] };
  const obs = new Obstacles(r, bodies);
  const n = pts.length / 3;
  const at = (i: number): V3 => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  let checkedAt: V3 | null = null;

  const ptp = (move: 'start' | 'end' | 'home', a: Joints, b: Joints, part: boolean) => {
    const steps = Math.max(2, Math.ceil(Math.max(...a.map((v, k) => Math.abs(b[k] - v))) / 2)); // every 2° of the largest axis
    for (let k = 1; k < steps; k++) {
      const q = a.map((v, j) => v + ((b[j] - v) * k) / steps) as Joints;
      const h = obs.hit(q, part);
      if (h) {
        rep.ptp.push({ move, ...h });
        return;
      }
    }
  };
  const safe = [...r.safeAxes] as Joints;
  if (ends.first) ptp('start', safe, ends.first, false);

  for (let i = 0; i < n; i++) {
    const p = at(i);
    if (i > 0 && ext[i]) obs.addBead(at(i - 1), p, s);
    const q = Array.from(joints.subarray(i * 6, i * 6 + 6)) as Joints;
    if (!Number.isFinite(q[0])) continue; // unreachable: reported by reachReport
    if (checkedAt && i < n - 1 && Math.hypot(p[0] - checkedAt[0], p[1] - checkedAt[1], p[2] - checkedAt[2]) < step) continue;
    checkedAt = p;
    const h = obs.hit(q, true);
    if (!h) continue;
    rep.count++;
    if (rep.first < 0) Object.assign(rep, { first: i, what: h.what, body: h.body });
    if (rep.points.length < 500) rep.points.push(i);
  }

  if (ends.last) ptp('end', ends.last, safe, true);
  if (r.useHoming) {
    const home = [safe[0], safe[1], 0, safe[3], safe[4], safe[5]] as Joints;
    ptp('home', safe, home, true);
  }
  return rep;
}
