// Serpentine (zig-zag) paths: parallel passes one bead apart, joined end to end so the
// extruder keeps running. Used for solid planar layers and for the non-planar top surface.
import type { Vec2 } from './polyline';
import type { Contour } from './slicer';

export interface Pass {
  a: Vec2;
  b: Vec2;
}

const rot = (p: Vec2, c: number, s: number): Vec2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];

/**
 * Scan-line fill of the region bounded by closed contours (holes included, even-odd rule).
 * Lines run along `angleDeg`, `spacing` apart, the first half a spacing inside the region;
 * each segment is shortened by `endInset` at both ends (bead cap inside the border).
 */
export function scanFill(contours: Contour[], spacing: number, angleDeg: number, endInset = 0): Pass[] {
  const loops = contours.filter((c) => c.closed && c.pts.length >= 3);
  if (!loops.length || spacing <= 0) return [];
  const a = (angleDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(-a), Math.sin(-a)];
  const local = loops.map((l) => l.pts.map((p) => rot(p, c, s)));
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const l of local)
    for (const p of l) {
      yMin = Math.min(yMin, p[1]);
      yMax = Math.max(yMax, p[1]);
    }
  const passes: Pass[] = [];
  const [cb, sb] = [Math.cos(a), Math.sin(a)];
  for (let y = yMin + spacing / 2; y < yMax; y += spacing) {
    const xs: number[] = [];
    for (const l of local) {
      for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        const [x1, y1] = l[j];
        const [x2, y2] = l[i];
        if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = xs[k] + endInset;
      const x1 = xs[k + 1] - endInset;
      if (x1 - x0 < 1e-6) continue;
      passes.push({ a: rot([x0, y], cb, sb), b: rot([x1, y], cb, sb) });
    }
  }
  return passes;
}

/**
 * Order passes into a serpentine: always continue with the pass whose end is nearest to the
 * current position, entering it from that end. Returns [pass, reversed].
 */
export function serpentine<T>(passes: T[], start: Vec2, endpoint: (p: T, end: 'a' | 'b') => Vec2): [T, boolean][] {
  const pending = [...passes];
  const out: [T, boolean][] = [];
  let cur = start;
  while (pending.length) {
    let best = 0;
    let bestD = Infinity;
    let flip = false;
    pending.forEach((p, i) => {
      const pa = endpoint(p, 'a');
      const pb = endpoint(p, 'b');
      const da = Math.hypot(pa[0] - cur[0], pa[1] - cur[1]);
      const db = Math.hypot(pb[0] - cur[0], pb[1] - cur[1]);
      if (da < bestD) {
        bestD = da;
        best = i;
        flip = false;
      }
      if (db < bestD) {
        bestD = db;
        best = i;
        flip = true;
      }
    });
    const p = pending.splice(best, 1)[0];
    out.push([p, flip]);
    cur = endpoint(p, flip ? 'a' : 'b');
  }
  return out;
}
