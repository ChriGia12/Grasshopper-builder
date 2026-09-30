// Turns the part into an ordered robot path: contour layers (planar or spiral / vase mode),
// solid serpentine layers, or a non-planar serpentine over the top surface.
import { computeBounds, type MeshData } from './mesh';
import { densify, pointInPolygon, polylineLength, rotateToNearest, signedArea, simplifyClosed, simplifyOpen, type Vec2 } from './polyline';
import type { PrintMode, PrintSettings } from './settings';
import { cFromNormal, HeightField, topSurfacePasses, type SurfaceOptions, type SurfacePoint, type SurfaceRun } from './surface';
import { sliceAt, type Contour, type Layer } from './slicer';
import { buildWalls, collapseThinWalls, intersectContours, islands, offsetContours } from './walls';
import { scanFill, serpentine, type Pass } from './zigzag';

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** true when the move that reaches this point deposits material */
  e: boolean;
  /** tool tilt C for this point (surface mode with tilt); otherwise the robot setting */
  c?: number;
}

export interface Toolpath {
  points: PathPoint[];
  mode: PrintMode;
  layerCount: number;
  layerHeight: number;
  /** index in `points` where each layer starts (for the viewer's layer slider) */
  layerStart: number[];
  printLength: number; // mm
  travelLength: number; // mm
  travels: number;
  warnings: string[];
}

export interface LayerSummary {
  layers: Layer[];
  singleLoop: boolean; // spiral possible (see spiralRange)
  /** Layers [from, to] printable as one continuous spiral; the others are printed planar. */
  spiral: [number, number] | null;
  maxIslands: number;
  openLayers: number; // layers with open contours (non-watertight mesh)
  emptyLayers: number;
}

/** Contour taken at mid-bead height (i + ½)·h; nozzle at firstLayerZ + i·h above the table. */
export function sliceForPrint(mesh: MeshData, s: PrintSettings): LayerSummary {
  const b = computeBounds(mesh);
  const height = b.max[2] - b.min[2];
  const n = Math.max(1, Math.round(height / s.layerHeight));
  const zs = Array.from({ length: n }, (_, i) => b.min[2] + (i + 0.5) * s.layerHeight);
  const raw = sliceAt(mesh, zs);
  const layers = raw.map((l, i) => ({
    z: s.firstLayerZ + i * s.layerHeight,
    // A solid filled layer must keep its real outline: no shell → mid-line collapse there.
    contours: collapseThinWalls(l.contours, s.mode === 'zigzag' ? 0 : s.thinWallMax).filter(
      (c) => polylineLength(c.pts, c.closed) >= s.minContourLength,
    ),
  }));
  fixEdgeSlivers(layers, s.wallSpacing / 2);
  let maxIslands = 0;
  let openLayers = 0;
  let emptyLayers = 0;
  for (const l of layers) {
    const outers = l.contours.filter((c) => c.closed && c.depth % 2 === 0).length;
    maxIslands = Math.max(maxIslands, outers);
    if (l.contours.some((c) => !c.closed)) openLayers++;
    if (!l.contours.length) emptyLayers++;
  }
  const spiral = spiralRange(layers);
  return { layers, singleLoop: spiral !== null, spiral, maxIslands, openLayers, emptyLayers };
}

/** Mean width of a closed loop's region (2·area / perimeter). */
const loopWidth = (c: Contour) => (c.closed ? (2 * Math.abs(signedArea(c.pts))) / polylineLength(c.pts, true) : 0);

/**
 * Rounded bottoms and rims slice into slivers thinner than a bead (e.g. two half-rings at the
 * first layer), which would print as scraps joined by lifted travels. The bottom layers take the
 * contour of the first full layer, so printing starts with the whole footprint on the table
 * (as Tavolino1 does); sliver layers at the top are dropped.
 */
function fixEdgeSlivers(layers: Layer[], minWidth: number) {
  const sliver = (l: Layer) => l.contours.length > 0 && l.contours.every((c) => loopWidth(c) < minWidth);
  const first = layers.findIndex((l) => l.contours.length > 0 && !sliver(l));
  if (first < 0) return;
  for (let i = 0; i < first; i++) layers[i].contours = layers[first].contours.map((c) => ({ ...c, pts: c.pts.map((p) => [...p] as Vec2) }));
  while (layers.length > first + 1 && (sliver(layers[layers.length - 1]) || !layers[layers.length - 1].contours.length)) layers.pop();
}

const isSingleLoop = (l: Layer) => l.contours.length === 1 && l.contours[0].closed;

/**
 * Longest run of single-loop layers. Spiral is used when that run covers ≥ 90% of the part
 * and only bottom/top layers fall outside it (e.g. rounded rims that slice into slivers).
 */
export function spiralRange(layers: Layer[]): [number, number] | null {
  let bestA = -1;
  let bestB = -2;
  let start = -1;
  for (let i = 0; i < layers.length; i++) {
    if (!isSingleLoop(layers[i])) {
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (i - start > bestB - bestA) {
      bestA = start;
      bestB = i;
    }
  }
  if (bestA < 0) return null;
  return bestB - bestA + 1 >= Math.max(1, 0.9 * layers.length) ? [bestA, bestB] : null;
}

/** Spiral only when the part allows it; otherwise the chosen mode. */
export function resolveMode(summary: LayerSummary, s: PrintSettings): PrintMode {
  if (s.mode === 'spiral') return summary.singleLoop && s.walls === 1 ? 'spiral' : 'planar';
  return s.mode;
}

export function buildToolpath(
  mesh: MeshData,
  s: PrintSettings,
  summaryIn?: LayerSummary,
  /** Seam target in the mesh's own frame; defaults to the front-left corner. */
  startTarget?: Vec2,
): Toolpath {
  const b0 = computeBounds(mesh);
  if (s.mode === 'surface') return buildSurface(mesh, s, startTarget ?? [b0.min[0], b0.min[1]]);
  const summary = summaryIn ?? sliceForPrint(mesh, s);
  const mode = resolveMode(summary, s);
  const warnings: string[] = [];
  if (s.mode === 'spiral' && mode !== 'spiral')
    warnings.push('Modalità spirale non possibile (più contorni per strato o più pareti): uso strati planari.');
  if (summary.openLayers)
    warnings.push(`${summary.openLayers} strati con contorni aperti: la mesh non è chiusa, controlla il modello.`);
  if (summary.emptyLayers) warnings.push(`${summary.emptyLayers} strati vuoti.`);

  const b = computeBounds(mesh);
  const start: Vec2 = startTarget ?? [b.min[0], b.min[1]];
  const tp: Toolpath = {
    points: [],
    mode,
    layerCount: summary.layers.length,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings,
  };
  if (mode === 'spiral' && summary.spiral) {
    const [a, b] = summary.spiral;
    let cur = buildPlanar(tp, summary.layers.slice(0, a), s, start);
    cur = buildSpiral(tp, summary.layers.slice(a, b + 1), s, cur);
    buildPlanar(tp, summary.layers.slice(b + 1), s, cur);
    if (a > 0 || b < summary.layers.length - 1)
      warnings.push(`Spirale sugli strati ${a + 1}–${b + 1}; ${summary.layers.length - (b - a + 1)} strati di bordo stampati planari.`);
  } else if (mode === 'zigzag') buildZigzag(tp, mesh, summary.layers, s, start);
  else buildPlanar(tp, summary.layers, s, start);
  return tp;
}

function push(tp: Toolpath, p: PathPoint) {
  const last = tp.points[tp.points.length - 1];
  if (last) {
    if (Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.y - p.y) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) return;
    const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
    if (p.e) tp.printLength += d;
    else tp.travelLength += d;
  }
  tp.points.push(p);
}

function prepareLoop(c: Contour, s: PrintSettings, near: Vec2): Vec2[] {
  const simple = simplifyClosed(c.pts, s.tolerance);
  return densify(rotateToNearest(simple, near), s.maxSegment, true);
}

/** Reach `to` either extruding (short hop, e.g. aligned seams between layers) or with a lifted travel. */
function moveTo(tp: Toolpath, to: Vec2, z: number, s: PrintSettings, c?: number, link: boolean | Contour[] = false) {
  const last = tp.points[tp.points.length - 1];
  if (!last) {
    push(tp, { x: to[0], y: to[1], z, e: false, c });
    return;
  }
  const hop = Math.hypot(to[0] - last.x, to[1] - last.y);
  // `link`: connection inside the area being filled — true for the serpentine step to the
  // neighbouring pass, or the island outline when the segment stays inside it. Printed up to
  // 8 beads, so a sloped border or a branch of the fill does not stop the extruder.
  const inside = Array.isArray(link) ? segmentInside([last.x, last.y], to, link) : link;
  if (hop <= s.maxBridge || (inside && hop <= 8 * s.wallSpacing)) {
    push(tp, { x: to[0], y: to[1], z, e: true, c });
    return;
  }
  tp.travels++;
  const zUp = Math.max(last.z, z) + s.travelLift;
  push(tp, { x: last.x, y: last.y, z: zUp, e: false, c: last.c });
  push(tp, { x: to[0], y: to[1], z: zUp, e: false, c });
  push(tp, { x: to[0], y: to[1], z, e: false, c });
}

function nearestIndex(contours: Contour[], cur: Vec2): number {
  let bi = 0;
  let bd = Infinity;
  contours.forEach((c, i) => {
    for (const p of c.pts) {
      const d = Math.hypot(p[0] - cur[0], p[1] - cur[1]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
  });
  return bi;
}

function buildPlanar(tp: Toolpath, layers: Layer[], s: PrintSettings, start: Vec2): Vec2 {
  let cur: Vec2 = start;
  for (const layer of layers) {
    tp.layerStart.push(tp.points.length);
    const closed = layer.contours.filter((c) => c.closed);
    for (const wall of buildWalls(closed, s.walls, s.wallSpacing)) {
      const pending = [...wall];
      while (pending.length) {
        const loop = prepareLoop(pending.splice(nearestIndex(pending, cur), 1)[0], s, cur);
        moveTo(tp, loop[0], layer.z, s);
        for (let i = 1; i < loop.length; i++) push(tp, { x: loop[i][0], y: loop[i][1], z: layer.z, e: true });
        push(tp, { x: loop[0][0], y: loop[0][1], z: layer.z, e: true });
        cur = loop[0];
      }
    }
    for (const c of layer.contours.filter((c) => !c.closed)) {
      let pts = densify(simplifyOpen(c.pts, s.tolerance), s.maxSegment, false);
      const dStart = Math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1]);
      const dEnd = Math.hypot(pts[pts.length - 1][0] - cur[0], pts[pts.length - 1][1] - cur[1]);
      if (dEnd < dStart) pts = pts.reverse();
      moveTo(tp, pts[0], layer.z, s);
      for (let i = 1; i < pts.length; i++) push(tp, { x: pts[i][0], y: pts[i][1], z: layer.z, e: true });
      cur = pts[pts.length - 1];
    }
  }
  return cur;
}

/** Vase mode: Z rises continuously along each contour, so there is no seam and no stop. */
function buildSpiral(tp: Toolpath, layers: Layer[], s: PrintSettings, start: Vec2): Vec2 {
  let cur: Vec2 = start;
  const h = s.layerHeight;
  layers.forEach((layer, li) => {
    tp.layerStart.push(tp.points.length);
    const loop = prepareLoop(layer.contours[0], s, cur);
    const ring = [...loop, loop[0]];
    if (li === 0) {
      // Flat first layer for adhesion.
      moveTo(tp, loop[0], layer.z, s);
      for (let i = 1; i < ring.length; i++) push(tp, { x: ring[i][0], y: ring[i][1], z: layer.z, e: true });
    } else {
      const total = polylineLength(ring, false);
      let acc = 0;
      moveTo(tp, loop[0], layer.z - h, s);
      for (let i = 1; i < ring.length; i++) {
        acc += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
        push(tp, { x: ring[i][0], y: ring[i][1], z: layer.z - h + (h * acc) / total, e: true });
      }
    }
    if (li === layers.length - 1 && li > 0) {
      // Flat closing lap to level the rim.
      for (let i = 1; i < ring.length; i++) push(tp, { x: ring[i][0], y: ring[i][1], z: layer.z, e: true });
    }
    cur = loop[0];
  });
  return cur;
}

/** Pass direction of layer i: the chosen angle, turned 90° on every other layer if alternating. */
const passAngle = (s: PrintSettings, i: number) => s.fillAngle + (s.fillAlternate && i % 2 ? 90 : 0);

/** True when the segment a→b stays inside the region (even-odd over its loops), sampled every mm. */
function segmentInside(a: Vec2, b: Vec2, region: Contour[]): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
  for (let k = 1; k < n; k++) {
    const q: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
    let inside = false;
    for (const c of region) if (c.closed && pointInPolygon(q, c.pts)) inside = !inside;
    if (!inside) return false;
  }
  return true;
}

/** Print one layer's serpentine of straight passes at height z, inside `region`. */
function printPasses(tp: Toolpath, passes: Pass[], z: number, s: PrintSettings, cur: Vec2, region: Contour[] = []): Vec2 {
  for (const [p, flip, link] of serpentine(passes, cur, (q, end) => q[end])) {
    const [a, b] = flip ? [p.b, p.a] : [p.a, p.b];
    moveTo(tp, a, z, s, undefined, link || region);
    for (const q of densify([a, b], s.maxSegment, false).slice(1)) push(tp, { x: q[0], y: q[1], z, e: true });
    cur = b;
  }
  return cur;
}

/** Print surface runs (non-planar) raised by dz, with optional C from the normal. */
function printSurfaceRuns(tp: Toolpath, runs: SurfaceRun[], dz: number, s: PrintSettings, cur: Vec2): Vec2 {
  const end = (r: SurfaceRun, e: 'a' | 'b'): Vec2 => {
    const q = e === 'a' ? r.pts[0] : r.pts[r.pts.length - 1];
    return [q.x, q.y];
  };
  for (const [run, flip, link] of serpentine(runs, cur, end)) {
    const pts = flip ? [...run.pts].reverse() : run.pts;
    const cOf = (q: SurfacePoint) => (s.surfaceTilt ? cFromNormal(q.n) : undefined);
    moveTo(tp, [pts[0].x, pts[0].y], pts[0].z + dz, s, cOf(pts[0]), link);
    for (const q of pts.slice(1)) push(tp, { x: q.x, y: q.y, z: q.z + dz, e: true, c: cOf(q) });
    cur = [pts[pts.length - 1].x, pts[pts.length - 1].y];
  }
  return cur;
}

const surfaceOptions = (s: PrintSettings, k: number): SurfaceOptions => ({
  spacing: s.wallSpacing,
  angle: passAngle(s, k),
  maxSlope: s.surfaceMaxSlope,
  tolerance: s.tolerance,
  minLength: s.minContourLength,
  inset: s.wallSpacing / 2,
});

/**
 * Solid part in serpentine. The body is printed in planar layers, each filled with parallel
 * passes one bead apart (optionally after the outline), island by island. With the top finish
 * on, each body layer is limited to where the part is still thicker than the finish above it —
 * the section at (bead top + finish thickness) — so the body stops below the top surface and
 * `surfacePasses` layers following the surface close the part, the last on the real top.
 */
function buildZigzag(tp: Toolpath, mesh: MeshData, layers: Layer[], s: PrintSettings, start: Vec2) {
  const h = s.layerHeight;
  const w = s.wallSpacing;
  const top = s.fillTopSurface;
  const zTop = computeBounds(mesh).max[2];
  const shell = s.surfacePasses * h;
  // Section of the part just under the finish: body material is allowed only inside it.
  const beadTops = layers.map((l) => l.z + (h - s.firstLayerZ));
  const upper = top ? sliceAt(mesh, beadTops.map((t) => Math.min(t + shell, zTop - 1e-3))) : [];
  let cur: Vec2 = start;
  let prevAngle: number | null = null;

  layers.forEach((layer, li) => {
    tp.layerStart.push(tp.points.length);
    let region = layer.contours.filter((c) => c.closed);
    if (top) region = beadTops[li] + shell > zTop + 1e-6 ? [] : intersectContours(region, upper[li].contours);
    // Islands smaller than ~3×3 beads cannot be filled: the top finish covers them.
    const parts = islands(region).filter((g) => Math.abs(signedArea(g[0].pts)) >= 9 * w * w);
    const fillRegionOf = (island: Contour[]) => (s.fillPerimeter ? offsetContours(island, -(s.walls - 0.5) * w) : island);
    const fillOf = (island: Contour[], angle: number) => scanFill(fillRegionOf(island), w, angle, s.fillPerimeter ? w / 4 : w / 2);
    // Pass direction: fixed (alternating 90° if asked) or automatic — the one of 0/45/90/135°
    // whose serpentine breaks least on this layer (excluding the previous layer's direction
    // when alternating, so layers still cross).
    let angle = passAngle(s, li);
    if (s.fillAutoAngle && parts.length) {
      const breaks = (a: number) =>
        parts.reduce((n, g) => n + serpentine(fillOf(g, a), cur, (q, e) => q[e]).filter(([, , link], i) => i > 0 && !link).length, 0);
      const cands = [0, 45, 90, 135].map((a) => (s.fillAngle + a) % 180).filter((a) => !s.fillAlternate || prevAngle === null || a !== prevAngle);
      angle = cands.reduce((best, a) => (breaks(a) < breaks(best) ? a : best), cands[0]);
    }
    if (parts.length) prevAngle = angle;
    while (parts.length) {
      const island = parts.splice(nearestIndex(parts.map((p) => p[0]), cur), 1)[0];
      if (s.fillPerimeter) {
        for (const wall of buildWalls(island, s.walls, w)) {
          const pending = [...wall];
          while (pending.length) {
            const loop = prepareLoop(pending.splice(nearestIndex(pending, cur), 1)[0], s, cur);
            moveTo(tp, loop[0], layer.z, s);
            for (let i = 1; i < loop.length; i++) push(tp, { x: loop[i][0], y: loop[i][1], z: layer.z, e: true });
            push(tp, { x: loop[0][0], y: loop[0][1], z: layer.z, e: true });
            cur = loop[0];
          }
        }
      }
      // Region edge = where material must end: the outline, or the inner edge of the innermost
      // perimeter bead. Passes keep half a bead from it; with perimeters their ends overlap the
      // perimeter bead by a quarter bead so the two fuse.
      cur = printPasses(tp, fillOf(island, angle), layer.z, s, cur, island);
    }
  });

  if (!top) return;
  // Top finish: surfacePasses layers following the top surface; the last one is the real top.
  const hf = new HeightField(mesh);
  for (let k = 0; k < s.surfacePasses; k++) {
    tp.layerStart.push(tp.points.length);
    const dz = -(s.surfacePasses - 1 - k) * h - (h - s.firstLayerZ);
    cur = printSurfaceRuns(tp, topSurfacePasses(mesh, surfaceOptions(s, layers.length + k), hf), dz, s, cur);
  }
  tp.layerCount = layers.length + s.surfacePasses;
}

/**
 * Non-planar: serpentine over the top surface only, printed on top of an existing part. Every
 * point takes the surface height (+ first-layer offset, + one layer height per extra pass).
 */
function buildSurface(mesh: MeshData, s: PrintSettings, start: Vec2): Toolpath {
  const tp: Toolpath = {
    points: [],
    mode: 'surface',
    layerCount: s.surfacePasses,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings: [],
  };
  const hf = new HeightField(mesh);
  let cur: Vec2 = start;
  for (let k = 0; k < s.surfacePasses; k++) {
    tp.layerStart.push(tp.points.length);
    const runs = topSurfacePasses(mesh, surfaceOptions(s, k), hf);
    if (!runs.length) {
      tp.warnings.push("Nessuna superficie superiore trovata: controlla l'orientamento del pezzo.");
      break;
    }
    cur = printSurfaceRuns(tp, runs, s.firstLayerZ + k * s.layerHeight, s, cur);
  }
  return tp;
}
