// 2D polyline helpers used on slice contours.
export type Vec2 = [number, number];

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return a / 2; // > 0 → counter-clockwise
}

export function polylineLength(pts: Vec2[], closed: boolean): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 1) {
    const a = pts[pts.length - 1];
    l += Math.hypot(pts[0][0] - a[0], pts[0][1] - a[1]);
  }
  return l;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker on an open polyline (iterative to survive very long contours). */
export function simplifyOpen(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3 || tol <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed loop: split at the vertex farthest from the first one. */
export function simplifyClosed(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 4 || tol <= 0) return pts.slice();
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplifyOpen(pts.slice(0, far + 1), tol);
  const b = simplifyOpen([...pts.slice(far), pts[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : pts.slice();
}

/** Split any segment longer than `maxLen` (0 disables). Like Grasshopper "Divide Length". */
export function densify(pts: Vec2[], maxLen: number, closed: boolean): Vec2[] {
  if (maxLen <= 0 || pts.length < 2) return pts.slice();
  const out: Vec2[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.ceil(d / maxLen);
    for (let s = 1; s < k; s++) out.push([a[0] + ((b[0] - a[0]) * s) / k, a[1] + ((b[1] - a[1]) * s) / k]);
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Rotate a closed loop so it starts at the point nearest to `target`. If that location lies
 * inside a segment, a vertex is inserted there so the seam sits exactly where requested.
 */
export function rotateToNearest(pts: Vec2[], target: Vec2): Vec2[] {
  let bestD = Infinity;
  let bestI = 0;
  let bestP: Vec2 = pts[0];
  let bestT = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const p: Vec2 = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(target[0] - p[0], target[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
      bestP = p;
      bestT = t;
    }
  }
  if (bestT < 1e-6) return [...pts.slice(bestI), ...pts.slice(0, bestI)];
  if (bestT > 1 - 1e-6) {
    const j = (bestI + 1) % pts.length;
    return [...pts.slice(j), ...pts.slice(0, j)];
  }
  return [bestP, ...pts.slice(bestI + 1), ...pts.slice(0, bestI + 1)];
}
