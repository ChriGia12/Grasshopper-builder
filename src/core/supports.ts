// Supports: removable walls printed under the parts of the mesh that hang in the air, from the
// table up to them. The mesh itself is never changed — supports are only added next to it.
//
// Each layer covers an area (its closed sections, and a bead-wide band along open ones). The part
// of that area that does not rest on the layer below — beyond what the critical angle lets a bead
// stick out — hangs. Everything that hangs above a layer, projected down, is the area to hold up
// there: a column from the table to the overhang. In every layer the outline of that column is
// printed where the part is not, so the support stands on the table and ends right under what it
// holds (an open rim that is not flat, the lip of a cap, the top of a shell dome).
import ClipperLib from 'clipper-lib';
import type { Vec2 } from './polyline';
import type { Contour, Layer } from './slicer';

const SCALE = 1000;
/** Columns closer than this many beads become one block. */
const MERGE = 3;
type IntPath = { X: number; Y: number }[];
const toInt = (pts: Vec2[]): IntPath => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromInt = (p: IntPath): Vec2[] => p.map((q) => [q.X / SCALE, q.Y / SCALE]);

function bool(type: number, a: IntPath[], b: IntPath[]): IntPath[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const out: IntPath[] = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

function offset(paths: IntPath[], d: number): IntPath[] {
  if (!paths.length) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: IntPath[] = [];
  co.Execute(out, d * SCALE);
  return out;
}

/** Area printed by a layer: closed sections filled, open ones as a band one bead wide. */
function covered(layer: Layer, w: number): IntPath[] {
  const closed = layer.contours.filter((c) => c.closed && !c.support);
  const open = layer.contours.filter((c) => !c.closed && !c.support);
  // Closed loops are classified (outer CCW, holes CW): NonZero union keeps the holes.
  const regions = closed.length ? bool(ClipperLib.ClipType.ctUnion, closed.map((c) => toInt(c.pts)), []) : [];
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  if (closed.length) co.AddPaths(closed.map((c) => toInt(c.pts)), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedLine);
  if (open.length) co.AddPaths(open.map((c) => toInt(c.pts)), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const bands: IntPath[] = [];
  co.Execute(bands, (w / 2) * SCALE);
  return bool(ClipperLib.ClipType.ctUnion, regions, bands);
}

const area = (paths: IntPath[]) => paths.reduce((a, p) => a + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);

/**
 * Adds support contours (open paths, `support: true`) to the layers. `h`: layer height, `w`: bead
 * width, `overhangDeg`: critical angle. Returns how many layers got supports.
 */
export function addSupports(layers: Layer[], h: number, w: number, overhangDeg: number): number {
  const cover = layers.map((l) => covered(l, w));
  // A bead may stick out over the one below by this much and still hold.
  const allow = h * Math.tan((overhangDeg * Math.PI) / 180);
  let column: IntPath[] = [];
  let count = 0;
  for (let i = layers.length - 2; i >= 0; i--) {
    // What layer i+1 prints that does not rest on layer i: it hangs, and joins the column.
    const hangs = bool(ClipperLib.ClipType.ctDifference, cover[i + 1], offset(cover[i], allow));
    if (area(hangs) > w * w * 0.25) column = ClipperLib.Clipper.CleanPolygons(bool(ClipperLib.ClipType.ctUnion, column, hangs), 0.05 * SCALE);
    if (!column.length) continue;
    // In layer i the column is held up where the part is not. Columns closer than a few beads
    // are merged into one block (closing: grow, then shrink back): fewer, sturdier outlines and a
    // continuous bead instead of a jump to every strip.
    const merged = offset(offset(column, MERGE * w), -MERGE * w);
    const hold = bool(ClipperLib.ClipType.ctDifference, merged, cover[i]);
    const loops = hold.map(fromInt).filter((pts) => {
      let len = 0;
      for (let k = 0; k < pts.length; k++) len += Math.hypot(pts[(k + 1) % pts.length][0] - pts[k][0], pts[(k + 1) % pts.length][1] - pts[k][1]);
      return len >= 2 * w; // smaller than a bead: nothing to print
    });
    if (!loops.length) continue;
    count++;
    layers[i].contours.push(...loops.map((pts): Contour => ({ pts: [...pts, pts[0]], closed: false, depth: 0, support: true })));
  }
  return count;
}
