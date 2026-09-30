// Turns slice contours into an ordered robot path (spiral / vase mode or planar layers).
import { computeBounds, type MeshData } from './mesh';
import { densify, polylineLength, rotateToNearest, simplifyClosed, simplifyOpen, type Vec2 } from './polyline';
import type { PrintSettings } from './settings';
import { sliceAt, type Contour, type Layer } from './slicer';
import { buildWalls, collapseThinWalls } from './walls';

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** true when the move that reaches this point deposits material */
  e: boolean;
}

export interface Toolpath {
  points: PathPoint[];
  mode: 'spiral' | 'planar';
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

/** Slice at mid-bead height: nozzle at z = (i+1)·h, contour taken at z − h/2. */
export function sliceForPrint(mesh: MeshData, s: PrintSettings): LayerSummary {
  const b = computeBounds(mesh);
  const height = b.max[2] - b.min[2];
  const n = Math.max(1, Math.round(height / s.layerHeight));
  const zs = Array.from({ length: n }, (_, i) => b.min[2] + (i + 0.5) * s.layerHeight);
  const raw = sliceAt(mesh, zs);
  const layers = raw.map((l, i) => ({
    z: (i + 1) * s.layerHeight,
    contours: collapseThinWalls(l.contours, s.thinWallMax).filter((c) => polylineLength(c.pts, c.closed) >= s.minContourLength),
  }));
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

export function resolveMode(summary: LayerSummary, s: PrintSettings): 'spiral' | 'planar' {
  if (s.mode === 'planar') return 'planar';
  return summary.singleLoop && s.walls === 1 ? 'spiral' : 'planar';
}

export function buildToolpath(mesh: MeshData, s: PrintSettings, summary = sliceForPrint(mesh, s)): Toolpath {
  const mode = resolveMode(summary, s);
  const warnings: string[] = [];
  if (s.mode === 'spiral' && mode !== 'spiral')
    warnings.push('Modalità spirale non possibile (più contorni per strato o più pareti): uso strati planari.');
  if (summary.openLayers)
    warnings.push(`${summary.openLayers} strati con contorni aperti: la mesh non è chiusa, controlla il modello.`);
  if (summary.emptyLayers) warnings.push(`${summary.emptyLayers} strati vuoti.`);

  const b = computeBounds(mesh);
  const start: Vec2 = [b.min[0], b.min[1]];
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
  } else buildPlanar(tp, summary.layers, s, start);
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
function moveTo(tp: Toolpath, to: Vec2, z: number, s: PrintSettings) {
  const last = tp.points[tp.points.length - 1];
  if (!last) {
    push(tp, { x: to[0], y: to[1], z, e: false });
    return;
  }
  const hop = Math.hypot(to[0] - last.x, to[1] - last.y);
  if (hop <= s.maxBridge) {
    push(tp, { x: to[0], y: to[1], z, e: true });
    return;
  }
  tp.travels++;
  const zUp = Math.max(last.z, z) + s.travelLift;
  push(tp, { x: last.x, y: last.y, z: zUp, e: false });
  push(tp, { x: to[0], y: to[1], z: zUp, e: false });
  push(tp, { x: to[0], y: to[1], z, e: false });
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
