// Several parts on the plate: the move from one part to the next is a PTP above the parts
// (extruder off), not a LIN travel. The path goes up straight (LIN), across with a PTP to the
// point above the next part, and down straight (LIN) to where printing starts again.
import type { PathPoint, Toolpath } from './toolpath';
import type { PrintSettings } from './settings';

/** Footprint of a part on the plate in BASE: [xMin, yMin, xMax, yMax]. */
export type PartBox = [number, number, number, number];

/** Clearance of the PTP above everything printed so far (mm). */
export const PART_CHANGE_CLEARANCE = 30;

/**
 * Rewrites the travels between different parts in place and returns how many there are.
 * `offset` moves path points (part frame) to BASE, where the boxes are.
 */
export function separateParts(tp: Toolpath, offset: [number, number, number], boxes: PartBox[], s: PrintSettings): number {
  if (boxes.length < 2) return 0;
  const m = s.wallSpacing / 2 + 2;
  const partOf = (p: PathPoint) => {
    const x = p.x + offset[0];
    const y = p.y + offset[1];
    return boxes.findIndex((b) => x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m);
  };
  const pts = tp.points;
  const out: PathPoint[] = [];
  const newIdx = new Int32Array(pts.length);
  let lastPrinted = -1; // index in `out` of the last extruding point
  let lastPrintedOld = -1;
  let lastPart = -1;
  let zTop = -Infinity;
  let changes = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.e) {
      const part = partOf(p);
      const prev = pts[i - 1];
      if (part >= 0 && lastPart >= 0 && part !== lastPart && lastPrinted >= 0 && prev && !prev.e) {
        // The travel run (last printed → start of this contour) becomes lift + PTP + descent.
        const from = out[lastPrinted];
        const to = prev;
        const zSafe = Math.max(zTop, from.z, to.z) + Math.max(s.travelLift, PART_CHANGE_CLEARANCE);
        out.length = lastPrinted + 1;
        for (let k = lastPrintedOld + 1; k < i; k++) newIdx[k] = out.length;
        out.push(
          { x: from.x, y: from.y, z: zSafe, e: false, c: from.c },
          { x: to.x, y: to.y, z: zSafe, e: false, c: to.c, ptp: true },
          { x: to.x, y: to.y, z: to.z, e: false, c: to.c },
        );
        changes++;
      }
      if (part >= 0) lastPart = part;
    }
    newIdx[i] = out.length;
    out.push(p);
    if (p.e) {
      lastPrinted = out.length - 1;
      lastPrintedOld = i;
      zTop = Math.max(zTop, p.z);
    }
  }
  if (!changes) return 0;
  tp.points = out;
  tp.layerStart = tp.layerStart.map((k) => newIdx[k]);
  tp.printLength = 0;
  tp.travelLength = 0;
  for (let i = 1; i < out.length; i++) {
    const d = Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y, out[i].z - out[i - 1].z);
    if (out[i].e) tp.printLength += d;
    else tp.travelLength += d;
  }
  return changes;
}
