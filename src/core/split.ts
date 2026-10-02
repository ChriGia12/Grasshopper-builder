// Parts that cannot be printed whole without supports in any orientation: find where to cut them
// in two so that both pieces can, and how to print each piece (which side down, which mode).
//
// Candidate cuts are planes across each of the three sides of the part, at 25…75 % of its length.
// Each piece is tried resting on the cut and turned over; it passes when it meets the same hard
// checks as an orientation (no islands in mid-air, overhangs within the limit).
import { ShapeUtils, Vector2 } from 'three';
import { computeBounds, cutByPlane, isOpenMesh, type MeshData } from './mesh';
import { evaluateOrientation, OVERHANG_LIMIT, supportOk } from './orientation';
import type { PrintSettings } from './settings';

type V3 = [number, number, number];

export interface SplitPiece {
  /** Which side of the cut: +1 the part beyond the plane, −1 the part before it. */
  side: 1 | -1;
  /** Model direction that goes down on the table (as in OrientationCandidate.down). */
  down: V3;
  /** Rests on the cut face (true) or turned over (false). */
  onCut: boolean;
  valid: boolean;
  overhang: number; // share of the surface beyond the critical angle
  islands: number;
  /** Suggested print mode: spiral when every layer is one loop. */
  mode: 'spiral' | 'planar';
}

export interface SplitPlan {
  /** Plane: n·p = d in the frame of the part as loaded; n is one of the axes. */
  n: V3;
  d: number;
  axis: 0 | 1 | 2;
  /** Length of the part along the axis and where the cut is from its start (mm). */
  length: number;
  at: number;
  pieces: [SplitPiece, SplitPiece];
  /** Both pieces print without supports. */
  valid: boolean;
}

const FRACTIONS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.25, 0.75];

/**
 * The piece of `mesh` on one side of the plane x[axis] = value. A closed solid stays closed: the
 * cut section is filled with a flat face (holes kept); an open shell stays an open shell.
 */
export function splitPiece(mesh: MeshData, axis: 0 | 1 | 2, value: number, side: 1 | -1): MeshData {
  const n: V3 = [0, 0, 0];
  n[axis] = side;
  const piece = cutByPlane(mesh, n, side * value);
  return isOpenMesh(mesh) ? piece : capCut(piece, axis, value, side);
}

/** Fills the boundary loops lying on the plane x[axis] = value with flat triangles facing −side. */
function capCut(m: MeshData, axis: 0 | 1 | 2, value: number, side: 1 | -1): MeshData {
  const p = m.positions;
  const ix = m.indices;
  const nv = p.length / 3;
  const on = (v: number) => Math.abs(p[v * 3 + axis] - value) < 1e-4;
  // Boundary edges (used once) on the plane, kept with their direction in the triangle.
  const count = new Map<number, number>();
  const dir = new Map<number, [number, number]>();
  for (let t = 0; t < ix.length; t += 3)
    for (const [u, v] of [
      [ix[t], ix[t + 1]],
      [ix[t + 1], ix[t + 2]],
      [ix[t + 2], ix[t]],
    ]) {
      const key = u < v ? u * nv + v : v * nv + u;
      count.set(key, (count.get(key) ?? 0) + 1);
      dir.set(key, [u, v]);
    }
  const next = new Map<number, number>();
  for (const [key, c] of count) {
    if (c !== 1) continue;
    const [u, v] = dir.get(key)!;
    if (on(u) && on(v)) next.set(v, u); // the cap runs the edge the other way round
  }
  // Chain into loops, in the 2D coordinates of the plane.
  const [a, b] = [0, 1, 2].filter((k) => k !== axis);
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !used.has(v)) {
      used.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length >= 3 && v === start) loops.push(loop);
  }
  if (!loops.length) return m;
  const pt = (v: number) => new Vector2(p[v * 3 + a], p[v * 3 + b]);
  const area = (l: number[]) => ShapeUtils.area(l.map(pt));
  const inside = (q: Vector2, l: number[]) => {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const [pi, pj] = [pt(l[i]), pt(l[j])];
      if (pi.y > q.y !== pj.y > q.y && q.x < ((pj.x - pi.x) * (q.y - pi.y)) / (pj.y - pi.y) + pi.x) c = !c;
    }
    return c;
  };
  const depth = loops.map((l) => loops.filter((o) => o !== l && inside(pt(l[0]), o)).length);
  const idx = Array.from(ix);
  const want = -side; // outward normal of the cap along the axis
  loops.forEach((outer, k) => {
    if (depth[k] % 2) return;
    const holes = loops.filter((h, j) => depth[j] === depth[k] + 1 && inside(pt(h[0]), outer));
    const ccw = (l: number[]) => (area(l) > 0 ? l : [...l].reverse());
    const cw = (l: number[]) => (area(l) < 0 ? l : [...l].reverse());
    const o = ccw(outer);
    const hs = holes.map(cw);
    const all = [...o, ...hs.flat()];
    for (const [i, j, l] of ShapeUtils.triangulateShape(o.map(pt), hs.map((h) => h.map(pt)))) {
      const [u, v, w] = [all[i], all[j], all[l]];
      // Normal along the axis of (u, v, w) in plane coordinates: sign of the 2D cross product,
      // turned into the axis direction by the handedness of (a, b, axis).
      const cross = (p[v * 3 + a] - p[u * 3 + a]) * (p[w * 3 + b] - p[u * 3 + b]) - (p[v * 3 + b] - p[u * 3 + b]) * (p[w * 3 + a] - p[u * 3 + a]);
      const hand = axis === 1 ? -1 : 1; // (z, x, y) for the Y axis is (a=x, b=z): reversed
      idx.push(...(Math.sign(cross) * hand === want ? [u, v, w] : [u, w, v]));
    }
  });
  return { positions: p, indices: Uint32Array.from(idx) };
}

/** null when the part does not need to be cut (or cannot usefully be). */
export function suggestSplit(
  mesh: MeshData,
  s: Pick<PrintSettings, 'overhangAngle' | 'layerHeight' | 'thinWallMax'>,
  /** The best orientation of the part whole, to tell whether cutting really helps. */
  whole: { overhang: number; islands: number },
): SplitPlan | null {
  const b = computeBounds(mesh);
  const size = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  const heavy = mesh.indices.length / 3 > 200_000;
  const fractions = heavy ? [0.5] : FRACTIONS;
  const tri = mesh.indices.length / 3;
  let best: { plan: SplitPlan; score: number } | null = null;

  for (const axis of [0, 1, 2] as const) {
    if (size[axis] < 4 * s.layerHeight) continue;
    for (const f of fractions) {
      const value = b.min[axis] + f * size[axis];
      const pieces: SplitPiece[] = [];
      let score = 0;
      for (const side of [-1, 1] as const) {
        const m = splitPiece(mesh, axis, value, side);
        if (m.indices.length / 3 < Math.max(4, tri * 0.02)) {
          score = Infinity;
          break;
        }
        let pick: { piece: SplitPiece; score: number } | null = null;
        for (const onCut of [true, false]) {
          // Resting on the cut, the cut face goes down: towards the plane from the piece.
          const down: V3 = [0, 0, 0];
          down[axis] = onCut ? side * -1 : side;
          const e = evaluateOrientation(m, down, s.overhangAngle, s.layerHeight, s.thinWallMax);
          const overhang = e.totalArea ? e.overhangArea / e.totalArea : 0;
          const valid = supportOk(e);
          const sc = 4 * overhang + 0.75 * e.unsupported + (onCut ? 0 : 0.05) + (valid ? 0 : 1);
          if (!pick || sc < pick.score)
            pick = { score: sc, piece: { side, down, onCut, valid, overhang, islands: e.unsupported, mode: e.singleLoop ? 'spiral' : 'planar' } };
        }
        pieces.push(pick!.piece);
        score += pick!.score;
      }
      if (!Number.isFinite(score)) continue;
      score += 0.2 * Math.abs(f - 0.5); // a cut near the middle gives two similar pieces
      const n: V3 = [0, 0, 0];
      n[axis] = 1;
      const plan: SplitPlan = {
        n,
        d: value,
        axis,
        length: size[axis],
        at: f * size[axis],
        pieces: pieces as [SplitPiece, SplitPiece],
        valid: pieces.every((p) => p.valid),
      };
      if (!best || score < best.score) best = { plan, score };
    }
  }
  // Worth suggesting only if it really helps: both pieces pass, or the worst piece is clearly
  // better than the part whole (a third less overhang, no more islands) and not far off the limit.
  if (!best) return null;
  if (best.plan.valid) return best.plan;
  const worst = Math.max(...best.plan.pieces.map((p) => p.overhang));
  const islands = Math.max(...best.plan.pieces.map((p) => p.islands));
  return worst < (2 / 3) * whole.overhang && islands <= whole.islands && worst < 2 * OVERHANG_LIMIT ? best.plan : null;
}
