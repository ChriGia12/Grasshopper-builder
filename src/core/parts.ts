// Several parts on the plate are printed one after the other: the whole first part, then the
// whole second one, and so on. Between two parts the extruder is off and the robot goes straight
// up (LIN, exact stop), moves above the next part with a PTP and goes straight down (LIN) to
// where that part starts; the extruder is switched on again with its first printed move.
import type { MeshData } from './mesh';
import type { PrintSettings } from './settings';
import type { Vec2 } from './polyline';
import { buildToolpath, type PathPoint, type Toolpath } from './toolpath';

/** Footprint of a part on the plate in BASE: [xMin, yMin, xMax, yMax]. */
export type PartBox = [number, number, number, number];

/** Clearance of the PTP above everything printed so far (mm). */
export const PART_CHANGE_CLEARANCE = 30;

/** The triangles of `mesh` whose centre lies in the box (part frame + `offset` = BASE). */
function partMesh(mesh: MeshData, box: PartBox, offset: [number, number, number]): MeshData | null {
  const p = mesh.positions;
  const ix = mesh.indices;
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const x = (p[a * 3] + p[b * 3] + p[c * 3]) / 3 + offset[0];
    const y = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3 + offset[1];
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    for (const v of [a, b, c]) {
      let k = remap.get(v);
      if (k === undefined) {
        k = pos.length / 3;
        remap.set(v, k);
        pos.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      }
      idx.push(k);
    }
  }
  return idx.length ? { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) } : null;
}

/**
 * The toolpath of every part in turn (order of `boxes`), joined by a change of part. `start`:
 * where the first part starts (part frame); each next part starts near where the previous ended.
 */
export function printPartsInTurn(mesh: MeshData, s: PrintSettings, boxes: PartBox[], offset: [number, number, number], start?: Vec2): Toolpath {
  const meshes = boxes.map((b) => partMesh(mesh, b, offset)).filter((m): m is MeshData => !!m);
  const out: Toolpath = {
    points: [],
    mode: s.mode,
    layerCount: 0,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings: [],
    partChanges: 0,
  };
  const seen = new Set<string>();
  let coveredArea = 0;
  let topArea = 0;
  let zTop = -Infinity;
  let from: Vec2 | undefined = start;
  meshes.forEach((m, k) => {
    const tp = buildToolpath(m, s, undefined, from);
    if (!tp.points.length) return;
    if (out.points.length) {
      // Change of part: straight up from the last printed point, PTP above where the next part
      // starts; its first point (a non-extruding move down to the start) follows.
      const last = out.points[out.points.length - 1];
      const next = tp.points[0];
      const zSafe = Math.max(zTop, last.z, next.z) + Math.max(s.travelLift, PART_CHANGE_CLEARANCE);
      const lift: PathPoint = { x: last.x, y: last.y, z: zSafe, e: false, c: last.c };
      const over: PathPoint = { x: next.x, y: next.y, z: zSafe, e: false, c: next.c, ptp: true };
      out.travelLength += zSafe - last.z + Math.hypot(next.x - last.x, next.y - last.y) + zSafe - next.z;
      out.points.push(lift, over);
      out.partChanges!++;
    }
    const base = out.points.length;
    // One by one: spreading a long array into push() overflows the argument limit in Safari.
    for (const q of tp.points) out.points.push(q);
    for (const i of tp.layerStart) out.layerStart.push(i + base);
    out.layerCount += tp.layerCount;
    out.printLength += tp.printLength;
    out.travelLength += tp.travelLength;
    out.travels += tp.travels;
    if (k === 0) out.mode = tp.mode;
    if (tp.tiltX) out.tiltX = (out.tiltX ?? 0) + tp.tiltX;
    if (tp.coverage !== undefined && tp.topArea) {
      coveredArea += tp.coverage * tp.topArea;
      topArea += tp.topArea;
    }
    for (const w of tp.warnings) {
      const key = JSON.stringify(w);
      if (!seen.has(key)) {
        seen.add(key);
        out.warnings.push(w);
      }
    }
    for (const p of tp.points) if (p.e) zTop = Math.max(zTop, p.z);
    const end = tp.points[tp.points.length - 1];
    from = [end.x, end.y];
  });
  if (topArea) {
    out.coverage = coveredArea / topArea;
    out.topArea = topArea;
  }
  return out;
}

/**
 * Two programs run one after the other (supports printed first, then the part): one path for the
 * simulation and the checks, joined like a change of part (up, PTP above, down).
 */
export function joinInTurn(first: Toolpath, second: Toolpath, s: PrintSettings): Toolpath {
  if (!first.points.length) return second;
  if (!second.points.length) return first;
  const last = first.points[first.points.length - 1];
  const next = second.points[0];
  let top = -Infinity;
  for (const p of first.points) top = Math.max(top, p.z);
  const zSafe = Math.max(top, next.z) + Math.max(s.travelLift, PART_CHANGE_CLEARANCE);
  const points: PathPoint[] = [...first.points, { x: last.x, y: last.y, z: zSafe, e: false }, { x: next.x, y: next.y, z: zSafe, e: false, ptp: true }, ...second.points];
  const base = first.points.length + 2;
  return {
    ...second,
    points,
    layerStart: [...first.layerStart, ...second.layerStart.map((i) => i + base)],
    layerCount: first.layerCount + second.layerCount,
    printLength: first.printLength + second.printLength,
    travelLength: first.travelLength + second.travelLength + (zSafe - last.z) + Math.hypot(next.x - last.x, next.y - last.y) + (zSafe - next.z),
    travels: first.travels + second.travels,
    partChanges: (second.partChanges ?? 0) + 1,
    warnings: [...second.warnings],
  };
}
