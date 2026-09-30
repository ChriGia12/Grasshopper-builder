// Finds the best print orientation. Candidates: ±X/±Y/±Z plus the largest convex-hull facets
// (the faces a part can physically rest on). Each is scored on overhangs, unsupported islands,
// travel moves (extruder stops are bad for continuous extrusion), stability and height.
import { msg, type Msg } from '../i18n';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { Vector3 } from 'three';
import { applyMatrix, computeBounds, dropToOrigin, rotationBetween, type Mat3, type MeshData } from './mesh';
import { pointInPolygon } from './polyline';
import { sliceAt } from './slicer';
import { collapseThinWalls } from './walls';

export interface OrientationCandidate {
  id: number;
  label: Msg;
  down: [number, number, number]; // model direction that ends up pointing to the bed
  matrix: Mat3;
  height: number;
  baseArea: number; // mm² of flat contact with the bed
  overhangRatio: number; // share of surface steeper than the overhang limit
  unsupportedIslands: number; // contours starting in mid-air
  maxIslands: number; // max separate outer contours in one layer
  singleLoop: boolean; // ≥ 90% of sampled layers are one closed contour → spiral possible
  score: number; // lower is better
  notes: Msg[];
}

const AXES: { label: Msg; down: [number, number, number] }[] = [
  { label: msg('o.asImported'), down: [0, 0, -1] },
  { label: msg('o.upsideDown'), down: [0, 0, 1] },
  { label: msg('o.sideMinusY'), down: [0, -1, 0] },
  { label: msg('o.sidePlusY'), down: [0, 1, 0] },
  { label: msg('o.sideMinusX'), down: [-1, 0, 0] },
  { label: msg('o.sidePlusX'), down: [1, 0, 0] },
];

function hullFacets(mesh: MeshData, max: number): [number, number, number][] {
  const p = mesh.positions;
  // Subsample huge meshes: the hull only needs extreme points.
  const step = Math.max(1, Math.floor(p.length / 3 / 20000));
  const pts: Vector3[] = [];
  for (let i = 0; i < p.length / 3; i += step) pts.push(new Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
  if (pts.length < 4) return [];
  let hull: ConvexHull;
  try {
    hull = new ConvexHull().setFromPoints(pts);
  } catch {
    return [];
  }
  const groups: { n: Vector3; area: number }[] = [];
  for (const f of hull.faces) {
    const g = groups.find((q) => q.n.dot(f.normal) > 0.999);
    if (g) g.area += f.area;
    else groups.push({ n: f.normal.clone(), area: f.area });
  }
  return groups
    .sort((a, b) => b.area - a.area)
    .slice(0, max)
    .map((g) => [g.n.x, g.n.y, g.n.z]);
}

export function evaluateOrientation(
  mesh: MeshData,
  down: [number, number, number],
  overhangDeg: number,
  layerHeight: number,
  thinWallMax = 0,
) {
  const R = rotationBetween(down, [0, 0, -1]);
  const m = dropToOrigin(applyMatrix(mesh, R));
  const p = m.positions;
  const ix = m.indices;
  const b = computeBounds(m);
  const height = b.max[2] - b.min[2];
  const limit = -Math.sin((overhangDeg * Math.PI) / 180);
  let baseArea = 0;
  let overhangArea = 0;
  let totalArea = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const c1 = ix[t + 1] * 3;
    const c2 = ix[t + 2] * 3;
    const ux = p[c1] - p[a], uy = p[c1 + 1] - p[a + 1], uz = p[c1 + 2] - p[a + 2];
    const vx = p[c2] - p[a], vy = p[c2 + 1] - p[a + 1], vz = p[c2 + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const area = len / 2;
    totalArea += area;
    const cosZ = nz / len;
    const zTop = Math.max(p[a + 2], p[c1 + 2], p[c2 + 2]);
    if (zTop <= b.min[2] + layerHeight) {
      if (cosZ < -0.98) baseArea += area;
    } else if (cosZ < limit) overhangArea += area;
  }

  // Coarse slice to find floating islands and multi-contour layers.
  const samples = Math.max(8, Math.min(60, Math.round(height / layerHeight)));
  const zs = Array.from({ length: samples }, (_, i) => b.min[2] + ((i + 0.5) * height) / samples);
  const layers = sliceAt(m, zs).map((l) => ({ ...l, contours: collapseThinWalls(l.contours, thinWallMax) }));
  let unsupported = 0;
  let maxIslands = 0;
  let singleCount = 0;
  let prevOuters: [number, number][][] = [];
  layers.forEach((l, i) => {
    const outers = l.contours.filter((c) => c.closed && c.depth % 2 === 0).map((c) => c.pts);
    if (l.contours.length === 1 && l.contours[0].closed) singleCount++;
    maxIslands = Math.max(maxIslands, outers.length);
    if (i > 0) {
      for (const o of outers) {
        // Supported if some of its points lie over material of the layer below.
        const stride = Math.max(1, Math.floor(o.length / 16));
        const supported = o.some((q, k) => k % stride === 0 && prevOuters.some((po) => pointInPolygon(q, po)));
        if (!supported) unsupported++;
      }
    }
    prevOuters = outers;
  });

  const singleLoop = singleCount >= 0.9 * layers.length;
  return { matrix: R, height, baseArea, overhangArea, totalArea, unsupported, maxIslands, singleLoop };
}

export function analyzeOrientations(mesh: MeshData, overhangDeg: number, layerHeight: number, thinWallMax = 0): OrientationCandidate[] {
  const candidates = [...AXES];
  hullFacets(mesh, 8).forEach((d, i) => {
    if (!candidates.some((c) => c.down[0] * d[0] + c.down[1] * d[1] + c.down[2] * d[2] > 0.995))
      candidates.push({ label: msg('o.face', { n: i + 1 }), down: d });
  });

  const evals = candidates.map((c) => ({ c, e: evaluateOrientation(mesh, c.down, overhangDeg, layerHeight, thinWallMax) }));
  const maxBase = Math.max(1, ...evals.map((x) => x.e.baseArea));
  const maxH = Math.max(1, ...evals.map((x) => x.e.height));

  return evals
    .map(({ c, e }, id): OrientationCandidate => {
      const overhangRatio = e.totalArea ? e.overhangArea / e.totalArea : 0;
      const baseRatio = e.baseArea / maxBase;
      const notes: Msg[] = [];
      if (e.unsupported) notes.push(msg('o.note.unsupported', { n: e.unsupported }));
      if (overhangRatio > 0.02) notes.push(msg('o.note.overhang', { p: (overhangRatio * 100).toFixed(1) }));
      if (e.maxIslands > 1) notes.push(msg('o.note.islands', { n: e.maxIslands }));
      if (e.singleLoop) notes.push(msg('o.note.single'));
      if (baseRatio < 0.05) notes.push(msg('o.note.smallBase'));
      const score =
        4 * overhangRatio +
        1.5 * Math.min(1, e.unsupported / 2) +
        0.4 * Math.min(1, (e.maxIslands - 1) / 4) +
        (e.singleLoop ? -0.15 : 0) +
        0.6 * (1 - baseRatio) +
        0.3 * (e.height / maxH);
      return {
        id,
        label: c.label,
        down: c.down,
        matrix: e.matrix,
        height: e.height,
        baseArea: e.baseArea,
        overhangRatio,
        unsupportedIslands: e.unsupported,
        maxIslands: e.maxIslands,
        singleLoop: e.singleLoop,
        score,
        notes,
      };
    })
    .sort((a, b) => a.score - b.score);
}
