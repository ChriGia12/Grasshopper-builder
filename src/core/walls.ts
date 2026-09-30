// Inner perimeters: offset each layer's closed contours inward with Clipper.
import ClipperLib from 'clipper-lib';
import { pointInPolygon, polylineLength, signedArea, type Vec2 } from './polyline';
import { classify, type Contour } from './slicer';

const SCALE = 1000; // Clipper works on integers: 1 unit = 1 µm

export function offsetContours(contours: Contour[], delta: number): Contour[] {
  const closed = contours.filter((c) => c.closed);
  if (!closed.length) return [];
  const paths = closed.map((c) => c.pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: { X: number; Y: number }[][] = [];
  co.Execute(out, delta * SCALE);
  return classify(
    out
      .filter((p) => p.length >= 3)
      .map((p) => ({ pts: p.map((q) => [q.X / SCALE, q.Y / SCALE] as Vec2), closed: true, depth: 0 })),
  );
}

/** Contours for every perimeter, outermost first. Wall i is offset inward by i * spacing. */
export function buildWalls(contours: Contour[], walls: number, spacing: number): Contour[][] {
  const result: Contour[][] = [contours];
  for (let i = 1; i < walls; i++) {
    const inner = offsetContours(contours, -i * spacing);
    if (!inner.length) break;
    result.push(inner);
  }
  return result;
}

/**
 * A hollow shell (outer skin + one inner skin) whose thickness is about one bead would be
 * printed twice. Replace each such outer/hole pair with its mid-line so the bead follows
 * the centre of the wall. Thickness is estimated as area difference / mean perimeter.
 */
export function collapseThinWalls(contours: Contour[], maxThickness: number): Contour[] {
  if (maxThickness <= 0) return contours;
  const loops = contours.filter((c) => c.closed);
  const used = new Set<Contour>();
  const out: Contour[] = [];
  for (const o of loops) {
    if (o.depth % 2 !== 0) continue;
    const children = loops.filter((h) => h.depth === o.depth + 1 && pointInPolygon(h.pts[0], o.pts));
    if (children.length !== 1) continue;
    const h = children[0];
    const t = (Math.abs(signedArea(o.pts)) - Math.abs(signedArea(h.pts))) / ((polylineLength(o.pts, true) + polylineLength(h.pts, true)) / 2);
    if (!(t > 0 && t <= maxThickness)) continue;
    const mid = offsetContours([{ ...o, depth: 0 }], -t / 2);
    if (!mid.length) continue;
    mid.sort((a, b) => Math.abs(signedArea(b.pts)) - Math.abs(signedArea(a.pts)));
    used.add(o);
    used.add(h);
    out.push({ ...mid[0], depth: o.depth });
  }
  if (!used.size) return contours;
  return classify([...contours.filter((c) => !used.has(c)), ...out]);
}

/** Boolean intersection of two sets of closed contours (holes included). */
export function intersectContours(a: Contour[], b: Contour[]): Contour[] {
  const toPaths = (cs: Contour[]) =>
    cs.filter((c) => c.closed).map((c) => c.pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toPaths(a), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(toPaths(b), ClipperLib.PolyType.ptClip, true);
  const out: { X: number; Y: number }[][] = [];
  clipper.Execute(ClipperLib.ClipType.ctIntersection, out, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return classify(
    out.filter((p) => p.length >= 3).map((p) => ({ pts: p.map((q) => [q.X / SCALE, q.Y / SCALE] as Vec2), closed: true, depth: 0 })),
  );
}

/** Group classified loops into islands: each outer loop with the holes directly inside it. */
export function islands(contours: Contour[]): Contour[][] {
  const loops = contours.filter((c) => c.closed);
  return loops
    .filter((o) => o.depth % 2 === 0)
    .map((o) => [o, ...loops.filter((h) => h.depth === o.depth + 1 && pointInPolygon(h.pts[0], o.pts))]);
}
