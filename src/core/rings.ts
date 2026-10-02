// Non-planar contour rings that follow the surface of the part (shells, hulls, domes).
//
// With planar layers a whole ring shares one Z, so on a shallow surface consecutive rings drift
// apart and on a steep one they squash. Here every point of a ring is placed at the right
// distance from the previous ring, measured along the surface, and that distance depends on the
// local slope and on the bead: one layer height in Z on steep walls, one bead width sideways on
// flat areas (beads side by side), and in between Δz = min(layerHeight, wallSpacing · tan slope).
//
// The rings are the level lines of a "bead count" field φ grown over the mesh from where the part
// touches the table (Dijkstra on the mesh edges, edge cost = length / local step). Ring k is the
// line φ = k + ½. The surface closes up to the top: the last rings shrink to nothing.
import { msg } from '../i18n';
import type { MeshData } from './mesh';
import { computeBounds, cutBelow, translate } from './mesh';
import type { PrintSettings } from './settings';
import { buildPlanar, rampPoints, sliceForPrint, type PathPoint, type Toolpath } from './toolpath';
import { pointInPolygon, signedArea, type Vec2 } from './polyline';
import { sliceAt } from './slicer';

type V3 = [number, number, number];

/** Bead step along the surface (mm) for a surface sloping `sin`/`cos` from horizontal. */
export function beadStep(sin: number, cos: number, s: PrintSettings): number {
  return Math.min(s.layerHeight / Math.max(sin, 1e-6), s.wallSpacing / Math.max(cos, 1e-6));
}

/** φ per vertex: how many beads lie between the table and the vertex, along the surface. */
export function beadField(mesh: MeshData, s: PrintSettings): Float64Array {
  const p = mesh.positions;
  const ix = mesh.indices;
  const nv = p.length / 3;
  // Bead step of every face from its own slope; an edge costs its length over the mean step of the
  // faces that share it (vertex normals would blend a wall with the lid it meets).
  const faceStep = new Float64Array(ix.length / 3);
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const cos = Math.abs(nz) / len;
    faceStep[t / 3] = beadStep(Math.sqrt(Math.max(0, 1 - cos * cos)), cos, s);
  }
  const edgeSteps = new Map<number, number[]>();
  for (let t = 0; t < ix.length; t += 3)
    for (const [u, v] of [
      [ix[t], ix[t + 1]],
      [ix[t + 1], ix[t + 2]],
      [ix[t + 2], ix[t]],
    ]) {
      const key = u < v ? u * nv + v : v * nv + u;
      (edgeSteps.get(key) ?? edgeSteps.set(key, []).get(key)!).push(faceStep[t / 3]);
    }
  const adj: [number, number][][] = Array.from({ length: nv }, () => []);
  for (const [key, steps] of edgeSteps) {
    const u = Math.floor(key / nv);
    const v = key % nv;
    const len = Math.hypot(p[v * 3] - p[u * 3], p[v * 3 + 1] - p[u * 3 + 1], p[v * 3 + 2] - p[u * 3 + 2]);
    const cost = (len * steps.length) / steps.reduce((a, b) => a + b, 0);
    adj[u].push([v, cost]);
    adj[v].push([u, cost]);
  }
  const zMin = computeBounds(mesh).min[2];
  const phi = new Float64Array(nv).fill(Infinity);
  const heap = new MinHeap();
  const seed = (v: number, value: number) => {
    if (value < phi[v]) {
      phi[v] = value;
      heap.push(value, v);
    }
  };
  // Triangles around every vertex, for the fast-marching update across a face.
  const vertTris: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < ix.length; t += 3) for (let k = 0; k < 3; k++) vertTris[ix[t + k]].push(t / 3);
  const done = new Uint8Array(nv);
  /**
   * Arrival at C through the face (A, B, C) when A and B are already known: a straight front that
   * crosses the face at its own slowness (1 / bead step), as long as the front really comes from
   * the edge AB; otherwise null and the edge updates apply.
   */
  const across = (a: number, b: number, c: number, f: number): number | null => {
    let [A, B] = [a, b];
    if (phi[A] > phi[B]) [A, B] = [B, A];
    const P = (v: number): V3 => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
    const [pa, pb, pc] = [P(A), P(B), P(c)];
    const ab: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const ac: V3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const d = Math.hypot(...ab);
    if (!d) return null;
    const e1: V3 = [ab[0] / d, ab[1] / d, ab[2] / d];
    const cx = ac[0] * e1[0] + ac[1] * e1[1] + ac[2] * e1[2];
    const cy = Math.hypot(ac[0] - cx * e1[0], ac[1] - cx * e1[1], ac[2] - cx * e1[2]);
    if (cy < 1e-9) return null;
    const alpha = (phi[B] - phi[A]) / d;
    if (alpha * alpha >= f * f) return null;
    const beta = Math.sqrt(f * f - alpha * alpha);
    const hit = cx - (cy / beta) * alpha; // where the front through C left the edge AB
    if (hit < 0 || hit > d) return null;
    return phi[A] + alpha * cx + beta * cy;
  };
    const run = () => {
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > phi[u] || done[u]) continue;
      done[u] = 1;
      for (const [w, cost] of adj[u]) if (!done[w]) seed(w, d + cost);
      for (const t of vertTris[u]) {
        const tri = [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]];
        const others = tri.filter((v) => v !== u);
        for (const [x, y] of [
          [others[0], others[1]],
          [others[1], others[0]],
        ]) {
          if (!done[x] || done[y]) continue;
          const v = across(u, x, y, 1 / faceStep[t]);
          if (v !== null) seed(y, v);
        }
      }
    }
  };
  // Grown from what touches the table; parts not connected to it start from their lowest point
  // as if built up from the table (they are islands: the support check reports them).
  for (let v = 0; v < nv; v++) if (p[v * 3 + 2] <= zMin + 0.25 * s.layerHeight) seed(v, 0);
  run();
  for (;;) {
    let low = -1;
    for (let v = 0; v < nv; v++) if (phi[v] === Infinity && adj[v].length && (low < 0 || p[v * 3 + 2] < p[low * 3 + 2])) low = v;
    if (low < 0) break;
    seed(low, (p[low * 3 + 2] - zMin) / s.layerHeight);
    run();
  }
  return phi;
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (k[j] <= k[i]) break;
      [k[i], k[j]] = [k[j], k[i]];
      [v[i], v[j]] = [v[j], v[i]];
      i = j;
    }
  }
  pop(): [number, number] {
    const { k, v } = this;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[i], k[m]] = [k[m], k[i]];
        [v[i], v[m]] = [v[m], v[i]];
        i = m;
      }
    }
    return top;
  }
}

export interface Ring {
  pts: V3[];
  closed: boolean;
}

/**
 * Splits triangles until no edge is longer than `maxEdge` (red-green: a triangle is split along
 * its marked edges, midpoints shared with the neighbours, so the mesh stays conforming). Stops
 * growing the edge limit when the mesh would get too heavy.
 */
export function refine(mesh: MeshData, maxEdge: number, maxTriangles = 1_500_000): MeshData {
  let pos = Array.from(mesh.positions);
  let tris = Array.from(mesh.indices);
  for (let pass = 0; pass < 12; pass++) {
    const len = (u: number, v: number) => Math.hypot(pos[u * 3] - pos[v * 3], pos[u * 3 + 1] - pos[v * 3 + 1], pos[u * 3 + 2] - pos[v * 3 + 2]);
    let marked = 0;
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) if (len(tris[t + k], tris[t + ((k + 1) % 3)]) > maxEdge) marked++;
    if (!marked) break;
    if (tris.length / 3 + marked * 1.5 > maxTriangles) maxEdge *= 2;
    const mids = new Map<string, number>();
    const mid = (u: number, v: number) => {
      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      let m = mids.get(key);
      if (m === undefined) {
        m = pos.length / 3;
        mids.set(key, m);
        pos.push((pos[u * 3] + pos[v * 3]) / 2, (pos[u * 3 + 1] + pos[v * 3 + 1]) / 2, (pos[u * 3 + 2] + pos[v * 3 + 2]) / 2);
      }
      return m;
    };
    const out: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const ab = len(a, b) > maxEdge;
      const bc = len(b, c) > maxEdge;
      const ca = len(c, a) > maxEdge;
      if (ab && bc && ca) {
        const [x, y, z] = [mid(a, b), mid(b, c), mid(c, a)];
        out.push(a, x, z, x, b, y, z, y, c, x, y, z);
      } else if (ab && bc) {
        const [x, y] = [mid(a, b), mid(b, c)];
        out.push(a, x, c, x, y, c, x, b, y);
      } else if (bc && ca) {
        const [y, z] = [mid(b, c), mid(c, a)];
        out.push(a, b, y, a, y, z, z, y, c);
      } else if (ca && ab) {
        const [z, x] = [mid(c, a), mid(a, b)];
        out.push(a, x, z, x, b, c, x, c, z);
      } else if (ab) {
        const x = mid(a, b);
        out.push(a, x, c, x, b, c);
      } else if (bc) {
        const y = mid(b, c);
        out.push(a, b, y, a, y, c);
      } else if (ca) {
        const z = mid(c, a);
        out.push(a, b, z, z, b, c);
      } else out.push(a, b, c);
    }
    tris = out;
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(tris) };
}

/** Level lines φ = level, chained through the mesh topology (like the planar slicer). */
export function levelRings(mesh: MeshData, phi: Float64Array, level: number): Ring[] {
  const p = mesh.positions;
  const ix = mesh.indices;
  const nv = p.length / 3;
  const nodePos = new Map<number, V3>();
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  const crossing = (u: number, v: number): number | null => {
    const fu = phi[u];
    const fv = phi[v];
    if (!Number.isFinite(fu) || !Number.isFinite(fv) || fu > level === fv > level) return null;
    const key = u < v ? u * nv + v : v * nv + u;
    if (!nodePos.has(key)) {
      const t = (level - fu) / (fv - fu);
      nodePos.set(key, [0, 1, 2].map((k) => p[u * 3 + k] + t * (p[v * 3 + k] - p[u * 3 + k])) as V3);
    }
    return key;
  };
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const lo = Math.min(phi[a], phi[b], phi[c]);
    const hi = Math.max(phi[a], phi[b], phi[c]);
    if (!(lo <= level && hi > level)) continue;
    const hits: number[] = [];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = crossing(u, v);
      if (k !== null) hits.push(k);
    }
    if (hits.length === 2 && hits[0] !== hits[1]) link(hits[0], hits[1]);
  }
  const used = new Set<string>();
  const id = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const walk = (start: number): Ring => {
    const nodes = [start];
    let prev = -1;
    let cur = start;
    for (;;) {
      const next = (links.get(cur) ?? []).find((n) => n !== prev && !used.has(id(cur, n)));
      if (next === undefined) return { pts: nodes.map((k) => nodePos.get(k)!), closed: false };
      used.add(id(cur, next));
      if (next === start) return { pts: nodes.map((k) => nodePos.get(k)!), closed: true };
      nodes.push(next);
      prev = cur;
      cur = next;
    }
  };
  const rings: Ring[] = [];
  for (const [n, l] of links) if (l.length === 1 && !used.has(id(n, l[0]))) rings.push(walk(n));
  for (const [n, l] of links) if (l.some((m) => !used.has(id(n, m)))) rings.push(walk(n));
  return rings.filter((r) => r.pts.length >= 2);
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ringLength = (r: Ring) =>
  r.pts.reduce((sum, q, i) => (i ? sum + dist(q, r.pts[i - 1]) : 0), 0) + (r.closed && r.pts.length > 2 ? dist(r.pts[0], r.pts[r.pts.length - 1]) : 0);

/** Douglas–Peucker in 3D (the rings are not flat). */
function simplify3(pts: V3[], tol: number): V3[] {
  if (pts.length < 3 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [a, b] = [pts[i], pts[j]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    let worst = -1;
    let wd = tol;
    for (let k = i + 1; k < j; k++) {
      const q = pts[k];
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / L2));
      const d = Math.hypot(q[0] - a[0] - t * ab[0], q[1] - a[1] - t * ab[1], q[2] - a[2] - t * ab[2]);
      if (d > wd) {
        wd = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** The ring starting at its point nearest to `near` (open rings: from the nearer end). */
function rotateRing(r: Ring, near: V3): V3[] {
  if (!r.closed) return dist(r.pts[0], near) <= dist(r.pts[r.pts.length - 1], near) ? r.pts : [...r.pts].reverse();
  let best = 0;
  r.pts.forEach((q, k) => {
    if (dist(q, near) < dist(r.pts[best], near)) best = k;
  });
  return [...r.pts.slice(best), ...r.pts.slice(0, best)];
}

/** Nearest point of a closed polyline to q. */
function nearestOn(pts: V3[], q: V3): V3 {
  let best: V3 = pts[0];
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / L2));
    const c: V3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
    const d = dist(c, q);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/**
 * The whole path from the rings. `spiral`: one continuous path, each turn climbing from its ring
 * to the next one point by point (vase mode on the surface); otherwise ring after ring, joined by
 * a printed step when the next ring is within reach (one continuous bead), lifted travel if not.
 */
export function buildRings(input: MeshData, s: PrintSettings, start: Vec2, spiral: boolean): Toolpath {
  // The rings always go round the part. Where the horizontal sections are not complete loops yet
  // (an open edge that is not flat, a part touching the table at a point) rings grown from there
  // would fan out across the part: that bottom is printed in planar layers, and the rings start
  // from the first layer that goes all the way round.
  const planar = sliceForPrint(input, { ...s, mode: 'planar' });
  // Judge the real sections (the planar layers below a complete loop are already turned into a
  // base with the outline of the first full layer). A loop counts once the sections stay complete
  // loops for the next ~10 mm: the tip of a part resting on a point is a tiny loop or an arc.
  const zMin0 = computeBounds(input).min[2];
  const raw = sliceAt(input, planar.layers.map((_, i) => zMin0 + (i + 0.5) * s.layerHeight));
  const whole = (i: number) => raw[i].contours.length > 0 && raw[i].contours.every((c) => c.closed) && planar.layers[i].contours.length === raw[i].contours.length;
  const span = Math.max(1, Math.ceil(10 / s.layerHeight));
  const firstWhole = raw.findIndex((_, i) => {
    for (let k = i; k < Math.min(raw.length, i + span); k++) if (!whole(k)) return false;
    return true;
  });
  // Also wait for the real section to be as large as the base printed under it.
  const area = (i: number) => planar.layers[i].contours.reduce((a, c) => a + Math.abs(signedArea(c.pts)), 0);
  const rawArea = (i: number) => raw[i].contours.reduce((a, c) => a + (c.closed ? Math.abs(signedArea(c.pts)) : 0), 0);
  let first = firstWhole;
  while (first >= 0 && first < raw.length && rawArea(first) < 0.9 * area(first)) first++;
  if (first >= raw.length) first = -1;
  const zBase = first > 0 ? first * s.layerHeight : 0;
  const zMin = computeBounds(input).min[2];
  const upper = zBase > 0 ? translate(cutBelow(input, zMin + zBase), 0, 0, -zBase) : input;
  // Large faces (a flat lid made of two triangles) need points inside to carry the rings that
  // close them: split every edge longer than half a bead.
  const mesh = refine(upper, s.wallSpacing / 2);
  const phi = beadField(mesh, s);
  let top = 0;
  for (const f of phi) if (Number.isFinite(f)) top = Math.max(top, f);
  const levels: Ring[][] = [];
  for (let k = 0; k + 0.5 < top; k++) {
    const rings = levelRings(mesh, phi, k + 0.5)
      .filter((r) => ringLength(r) >= Math.max(s.minContourLength, 0.5)) // below 0.5 mm: a point, not a ring
      .map((r) => {
        const pts = simplify3(r.closed ? [...r.pts, r.pts[0]] : r.pts, s.tolerance);
        return { closed: r.closed, pts: r.closed ? pts.slice(0, -1) : pts };
      })
      // Every closed ring runs the same way round (counter-clockwise seen from above): the
      // chaining through the mesh gives either sense, and a reversal would print the ramp back
      // over the ring just done.
      .map((r) => {
        if (!r.closed) return r;
        let a2 = 0;
        for (let i = 0; i < r.pts.length; i++) {
          const [p, q] = [r.pts[i], r.pts[(i + 1) % r.pts.length]];
          a2 += p[0] * q[1] - q[0] * p[1];
        }
        return a2 < 0 ? { closed: true, pts: [...r.pts].reverse() } : r;
      })
      .filter((r) => r.pts.length >= 2);
    // Every ring is printed: a small loop beside the main one is surface too.
    if (rings.length) levels.push(rings);
  }
  const single = first >= 0 && levels.length > 1 && levels.every((l) => l.length === 1 && l[0].closed);
  const tp: Toolpath = {
    points: [],
    mode: spiral && single ? 'spiral' : 'planar',
    layerCount: Math.max(0, first) + levels.length,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings: [],
  };
  if (spiral && !single) tp.warnings.push(msg('w.spiralRings'));
  // The nozzle sits on the surface line lowered by half a bead less the first-layer squash,
  // never below the first-layer height.
  const dz = s.firstLayerZ - s.layerHeight / 2;
  const at = (q: V3): V3 => [q[0], q[1], Math.max(s.firstLayerZ, q[2] + dz) + zBase];
  const add = (q: V3, e: boolean) => {
    const last = tp.points[tp.points.length - 1];
    if (last) {
      const d = Math.hypot(q[0] - last.x, q[1] - last.y, q[2] - last.z);
      if (e) tp.printLength += d;
      else tp.travelLength += d;
    }
    const pt: PathPoint = { x: q[0], y: q[1], z: q[2], e };
    tp.points.push(pt);
  };
  /** Plan of the ring printed last: a step that stays inside it runs over printed material. */
  let below: Vec2[] | null = null;
  const overBelow = (q: V3) => {
    const last = tp.points[tp.points.length - 1];
    if (!below || !last) return false;
    const n = Math.max(2, Math.ceil(Math.hypot(q[0] - last.x, q[1] - last.y) / 2));
    for (let k = 1; k < n; k++) if (!pointInPolygon([last.x + ((q[0] - last.x) * k) / n, last.y + ((q[1] - last.y) * k) / n], below)) return false;
    return true;
  };
  /**
   * Can the step from the last point to q be printed? From a ring to the next one: up to three
   * beads on the surface between them, or longer when it stays over the ring just printed (at the
   * top of a long ridge the last rings end at different spots); otherwise a lifted travel.
   */
  const printable = (q: V3, nextRing: boolean) => {
    const last = tp.points[tp.points.length - 1];
    if (!last) return false;
    const d = Math.hypot(q[0] - last.x, q[1] - last.y, q[2] - last.z);
    return d <= (nextRing ? 3 : 1.5) * Math.max(s.wallSpacing, s.layerHeight) || (nextRing && overBelow(q));
  };
  /** Reach q from the last point: printed step when possible, lifted travel otherwise. */
  const reach = (q: V3, nextRing: boolean) => {
    const last = tp.points[tp.points.length - 1];
    if (!last) return add(q, false);
    if (printable(q, nextRing)) return add(q, true);
    tp.travels++;
    const zUp = Math.max(last.z, q[2]) + s.travelLift;
    add([last.x, last.y, zUp], false);
    add([q[0], q[1], zUp], false);
    add(q, false);
  };

  // Seams: every ring starts where it crosses the line from the start point to the top of the part,
  // so consecutive rings start next to each other all the way up (the top region is where the last
  // rings are). Rings that are not nested (branches) start nearest to where the nozzle is.
  const lastRing = levels[levels.length - 1]?.[0].pts ?? [];
  const topXY: Vec2 = lastRing.length
    ? [lastRing.reduce((a, q) => a + q[0], 0) / lastRing.length, lastRing.reduce((a, q) => a + q[1], 0) / lastRing.length]
    : start;
  // Across the top region (normal to its long axis), on the side of the start point: there the
  // rings are closest to each other, at the ends of a long ridge they spread apart.
  let rayAngle = Math.atan2(start[1] - topXY[1], start[0] - topXY[0]);
  if (lastRing.length > 2) {
    let sxx = 0, sxy = 0, syy = 0;
    for (const q of lastRing) {
      const [dx, dy] = [q[0] - topXY[0], q[1] - topXY[1]];
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const major = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    if (Math.abs(sxx - syy) + Math.abs(sxy) > 1e-6) {
      const across: Vec2 = [-Math.sin(major), Math.cos(major)];
      const side = (start[0] - topXY[0]) * across[0] + (start[1] - topXY[1]) * across[1] >= 0 ? 1 : -1;
      rayAngle = Math.atan2(side * across[1], side * across[0]);
    }
  }
  /** How far q is, in angle seen from the top, from the direction of the start point. */
  const offRay = (q: V3) => {
    const d = Math.abs(Math.atan2(q[1] - topXY[1], q[0] - topXY[0]) - rayAngle) % (2 * Math.PI);
    return Math.min(d, 2 * Math.PI - d);
  };
  /** Direction the nozzle is moving in (last printed segment), to never start a ring behind it. */
  const heading = (): Vec2 | null => {
    const n = tp.points.length;
    if (n < 2) return null;
    const [a, b] = [tp.points[n - 2], tp.points[n - 1]];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return l > 1e-6 ? [(b.x - a.x) / l, (b.y - a.y) / l] : null;
  };
  const seamed = (r: Ring, near: V3, nested: boolean): V3[] => {
    if (!r.closed || !nested) return rotateRing(r, near);
    // Continuity first: only points about as close as the nearest one (within one bead); among
    // them the one most in line with the seam direction, so the seam does not drift.
    const dmin = Math.min(...r.pts.map((q) => dist(q, near)));
    let best = -1;
    r.pts.forEach((q, k) => {
      if (dist(q, near) > dmin + s.wallSpacing) return;
      if (best < 0 || offRay(q) < offRay(r.pts[best])) best = k;
    });
    // Rings run the same way round: step the start forward until it is not behind the nozzle.
    const dir = heading();
    if (dir) {
      const n = r.pts.length;
      for (let k = 0; k < n / 4; k++) {
        const q = r.pts[best];
        if ((q[0] - near[0]) * dir[0] + (q[1] - near[1]) * dir[1] >= 0) break;
        const next = (best + 1) % n;
        if (dist(r.pts[next], near) > dmin + s.wallSpacing) break; // keep the step short
        best = next;
      }
    }
    return [...r.pts.slice(best), ...r.pts.slice(0, best)];
  };

  let cur: V3 = [start[0], start[1], 0];
  // Never a complete loop (an open strip): planar layers only. Otherwise the open bottom first.
  if (first < 0) {
    buildPlanar(tp, planar.layers, s, start);
    tp.layerCount = planar.layers.length;
    return tp;
  }
  if (first > 0) {
    const end = buildPlanar(tp, planar.layers.slice(0, first), s, start);
    cur = [end[0], end[1], tp.points[tp.points.length - 1]?.z ?? 0];
    // The first ring may start over the last base layer: that layer carries the step to it.
    const top = planar.layers[first - 1].contours.filter((c) => c.closed);
    if (top.length) below = top.reduce((a, c) => (Math.abs(signedArea(c.pts)) > Math.abs(signedArea(a.pts)) ? c : a)).pts;
  }
  levels.forEach((rings, li) => {
    tp.layerStart.push(tp.points.length);
    if (tp.mode === 'spiral') {
      const ring = seamed(rings[0], cur, true).map(at);
      const nextPts = levels[li + 1]?.[0].pts.map(at) ?? null;
      reach(ring[0], true);
      const loop = [...ring, ring[0]];
      let total = 0;
      for (let i = 1; i < loop.length; i++) total += dist(loop[i], loop[i - 1]);
      let acc = 0;
      for (let i = 1; i < loop.length; i++) {
        acc += dist(loop[i], loop[i - 1]);
        const f = acc / total;
        // First turn flat on its ring (adhesion); then each turn climbs towards the next ring.
        if (li === 0 || !nextPts) add(loop[i], true);
        else {
          const q = nearestOn(nextPts, loop[i]);
          add([loop[i][0] + f * (q[0] - loop[i][0]), loop[i][1] + f * (q[1] - loop[i][1]), loop[i][2] + f * (q[2] - loop[i][2])], true);
        }
      }
      const end = tp.points[tp.points.length - 1];
      cur = [end.x, end.y, end.z];
      return;
    }
    const pending = [...rings];
    while (pending.length) {
      let bi = 0;
      pending.forEach((r, k) => {
        if (dist(rotateRing(r, cur)[0], cur) < dist(rotateRing(pending[bi], cur)[0], cur)) bi = k;
      });
      const r = pending.splice(bi, 1)[0];
      const pts = seamed(r, cur, rings.length === 1).map(at);
      const last = tp.points[tp.points.length - 1];
      if (s.layerRamp > 0 && last?.e && r.closed && rings.length === 1 && pts[0][2] > last.z && printable(pts[0], true)) {
        // Ring change as a ramp: the bead goes on along the new ring, climbing from the height
        // where the last ring ended to the ring's own height over the first `layerRamp` mm.
        // The climb starts where the last ring ended: the step to the new ring already rises.
        const ring: V3[] = [[last.x, last.y, pts[0][2]], ...pts, pts[0]];
        const ramped = rampPoints(
          ring.map((q) => [q[0], q[1]] as Vec2),
          (i) => ring[i][2],
          last.z,
          s.layerRamp,
        );
        for (const q of ramped.slice(1)) add([q.x, q.y, q.z], true);
      } else {
        reach(pts[0], rings.length === 1);
        for (const q of pts.slice(1)) add(q, true);
        if (r.closed) add(pts[0], true);
      }
      if (r.closed) below = pts.map((q) => [q[0], q[1]] as Vec2);
      const end = tp.points[tp.points.length - 1];
      cur = [end.x, end.y, end.z];
    }
  });
  return tp;
}
