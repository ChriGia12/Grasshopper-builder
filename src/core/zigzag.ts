// Serpentine (zig-zag) paths: parallel passes one bead apart, joined end to end so the
// extruder keeps running. Used for solid planar layers and for the non-planar top surface.
import type { Vec2 } from './polyline';
import type { Contour } from './slicer';

/** A straight pass: from a to b, on scan line `line`, spanning [lo, hi] along the line direction. */
export interface Pass {
  a: Vec2;
  b: Vec2;
  line: number;
  lo: number;
  hi: number;
}

/** Anything laid out on numbered scan lines (planar passes, surface runs). */
export interface OnLine {
  line: number;
  lo: number;
  hi: number;
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
  let line = 0;
  for (let y = yMin + spacing / 2; y < yMax; y += spacing, line++) {
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
      passes.push({ a: rot([x0, y], cb, sb), b: rot([x1, y], cb, sb), line, lo: x0, hi: x1 });
    }
  }
  return passes;
}

const overlap = (p: OnLine, q: OnLine) => Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo);

/**
 * Order passes into a serpentine, like mowing a lawn: after a pass continue on the next scan
 * line with a pass that overlaps it (entering from the nearer end), keep going in the same
 * direction, and jump to a new area only when the current one is finished.
 * Returns [pass, reversed, adjacent] — adjacent: reached from the neighbouring scan line of the
 * same area, i.e. the connection is part of the serpentine and can be printed.
 */
export function serpentine<T extends OnLine>(passes: T[], start: Vec2, endpoint: (p: T, end: 'a' | 'b') => Vec2): [T, boolean, boolean][] {
  const pending = [...passes];
  const out: [T, boolean, boolean][] = [];
  let cur = start;
  let last: T | null = null;
  let dir = 0;
  while (pending.length) {
    let cands = pending;
    if (last) {
      const l = last;
      const along = (d: number) => pending.filter((p) => p.line === l.line + d && overlap(p, l) > 0);
      const next = dir ? along(dir) : [...along(1), ...along(-1)];
      const back = dir ? along(-dir) : [];
      if (next.length) cands = next;
      else if (back.length) cands = back;
    }
    let best = cands[0];
    let bestD = Infinity;
    let flip = false;
    for (const p of cands) {
      for (const end of ['a', 'b'] as const) {
        const q = endpoint(p, end);
        const d = Math.hypot(q[0] - cur[0], q[1] - cur[1]);
        if (d < bestD) {
          bestD = d;
          best = p;
          flip = end === 'b';
        }
      }
    }
    pending.splice(pending.indexOf(best), 1);
    const adjacent = !!last && Math.abs(best.line - last.line) === 1 && overlap(best, last) > 0;
    out.push([best, flip, adjacent]);
    dir = adjacent ? best.line - last!.line : 0;
    last = best;
    cur = endpoint(best, flip ? 'a' : 'b');
  }
  return out;
}
