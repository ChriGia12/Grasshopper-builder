// Non-planar top surface: serpentine passes drawn in plan and dropped vertically onto the
// highest surface of the part (like Contour/Divide Curve on the surface in Grasshopper).
import { computeBounds, type MeshData } from './mesh';
import { simplifyOpen, type Vec2 } from './polyline';

export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  /** unit surface normal (pointing up) */
  n: [number, number, number];
}

/** Vertical ray queries against a mesh, bucketed on an XY grid. */
export class HeightField {
  private cell: number;
  private x0: number;
  private y0: number;
  private nx: number;
  private ny: number;
  private buckets: Map<number, number[]> = new Map();

  constructor(private mesh: MeshData) {
    const b = computeBounds(mesh);
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 1);
    this.cell = size / 128;
    this.x0 = b.min[0];
    this.y0 = b.min[1];
    this.nx = Math.ceil((b.max[0] - b.min[0]) / this.cell) + 1;
    this.ny = Math.ceil((b.max[1] - b.min[1]) / this.cell) + 1;
    const p = mesh.positions;
    const ix = mesh.indices;
    for (let t = 0; t < ix.length / 3; t++) {
      let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = ix[t * 3 + k] * 3;
        xmin = Math.min(xmin, p[v]);
        xmax = Math.max(xmax, p[v]);
        ymin = Math.min(ymin, p[v + 1]);
        ymax = Math.max(ymax, p[v + 1]);
      }
      for (let i = this.ci(xmin); i <= this.ci(xmax); i++)
        for (let j = this.cj(ymin); j <= this.cj(ymax); j++) {
          const key = j * this.nx + i;
          let l = this.buckets.get(key);
          if (!l) this.buckets.set(key, (l = []));
          l.push(t);
        }
    }
  }

  private ci(x: number) {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.cell)));
  }
  private cj(y: number) {
    return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / this.cell)));
  }

  /** Highest surface point above (x, y), with its upward normal; null outside the part. */
  top(x: number, y: number): SurfacePoint | null {
    const list = this.buckets.get(this.cj(y) * this.nx + this.ci(x));
    if (!list) return null;
    const p = this.mesh.positions;
    const ix = this.mesh.indices;
    let best: SurfacePoint | null = null;
    for (const t of list) {
      const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
      const d = (p[b + 1] - p[c + 1]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 1] - p[c + 1]);
      if (Math.abs(d) < 1e-12) continue; // vertical triangle
      const l1 = ((p[b + 1] - p[c + 1]) * (x - p[c]) + (p[c] - p[b]) * (y - p[c + 1])) / d;
      const l2 = ((p[c + 1] - p[a + 1]) * (x - p[c]) + (p[a] - p[c]) * (y - p[c + 1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const z = l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2];
      if (best && z <= best.z) continue;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const len = Math.hypot(...n);
      n = n.map((v) => v / len) as [number, number, number];
      if (n[2] < 0) n = n.map((v) => -v) as [number, number, number];
      best = { x, y, z, n };
    }
    return best;
  }
}

/** A pass on the surface, with its scan line and span for serpentine ordering. */
export interface SurfaceRun {
  pts: SurfacePoint[];
  line: number;
  lo: number;
  hi: number;
}

export interface SurfaceOptions {
  spacing: number; // mm between passes (bead width)
  angle: number; // deg, direction of the passes in plan
  maxSlope: number; // deg from horizontal: steeper faces are walls, not top surface
  tolerance: number; // mm, chord tolerance along each pass
  minLength: number; // mm, drop shorter passes
  inset: number; // mm kept from the surface border
}

/** Passes over the top surface, each as a list of surface points (unordered). */
export function topSurfacePasses(mesh: MeshData, o: SurfaceOptions, hf = new HeightField(mesh)): SurfaceRun[] {
  const b = computeBounds(mesh);
  const a = (o.angle * Math.PI) / 180;
  const dir: Vec2 = [Math.cos(a), Math.sin(a)];
  const nrm: Vec2 = [-dir[1], dir[0]];
  const corners: Vec2[] = [
    [b.min[0], b.min[1]],
    [b.max[0], b.min[1]],
    [b.max[0], b.max[1]],
    [b.min[0], b.max[1]],
  ];
  const along = corners.map((c) => c[0] * dir[0] + c[1] * dir[1]);
  const across = corners.map((c) => c[0] * nrm[0] + c[1] * nrm[1]);
  // Loops, not Math.min(...array): long arrays overflow the argument limit in Safari.
  let [t0, t1, s0, s1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const v of along) [t0, t1] = [Math.min(t0, v), Math.max(t1, v)];
  for (const v of across) [s0, s1] = [Math.min(s0, v), Math.max(s1, v)];
  const step = Math.max(0.5, Math.min(2, o.spacing / 4));
  const minNz = Math.cos((o.maxSlope * Math.PI) / 180);
  const passes: SurfaceRun[] = [];
  let line = 0;

  for (let s = s0 + o.spacing / 2; s < s1; s += o.spacing, line++) {
    let run: SurfacePoint[] = [];
    const flush = () => {
      const trimmed = trim(run, o.inset);
      if (trimmed.length >= 2 && runLength(trimmed) >= o.minLength) {
        const pts = simplifyRun(trimmed, o.tolerance);
        const t = (q: SurfacePoint) => q.x * dir[0] + q.y * dir[1];
        passes.push({ pts, line, lo: t(pts[0]), hi: t(pts[pts.length - 1]) });
      }
      run = [];
    };
    for (let t = t0; t <= t1 + 1e-9; t += step) {
      const x = dir[0] * t + nrm[0] * s;
      const y = dir[1] * t + nrm[1] * s;
      const h = hf.top(x, y);
      if (h && h.n[2] >= minNz) run.push(h);
      else flush();
    }
    flush();
  }
  return passes;
}

const runLength = (r: SurfacePoint[]) => r.slice(1).reduce((l, p, i) => l + Math.hypot(p.x - r[i].x, p.y - r[i].y, p.z - r[i].z), 0);

/** Cut `d` mm (in plan) from both ends of a run, so the bead stays on the surface. */
function trim(r: SurfacePoint[], d: number): SurfacePoint[] {
  if (d <= 0 || r.length < 2) return r;
  const planLen = (i: number) => Math.hypot(r[i].x - r[0].x, r[i].y - r[0].y);
  const total = planLen(r.length - 1);
  if (total <= 2 * d) return [];
  return r.filter((_, i) => planLen(i) >= d - 1e-9 && planLen(i) <= total - d + 1e-9);
}

/** Douglas–Peucker in the (distance along pass, z) plane: the pass is straight in plan. */
function simplifyRun(r: SurfacePoint[], tol: number): SurfacePoint[] {
  const prof: Vec2[] = r.map((p) => [Math.hypot(p.x - r[0].x, p.y - r[0].y), p.z]);
  const kept = simplifyOpen(prof, tol);
  const keep = new Set(kept.map((k) => prof.indexOf(k)));
  return r.filter((_, i) => keep.has(i));
}

/** Tool tilt from the calibration map: with A −180, B 0 the tool axis turns with C in the Y-Z plane. */
export function cFromNormal(n: [number, number, number]): number {
  const c = (Math.atan2(-n[1], -n[2]) * 180) / Math.PI;
  return ((c % 360) + 360) % 360;
}
