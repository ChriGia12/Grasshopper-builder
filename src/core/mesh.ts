// Indexed triangle mesh used by every stage of the pipeline (units: mm, Z up).
export interface MeshData {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function computeBounds(m: MeshData): Bounds {
  const p = m.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function mergeMeshes(parts: MeshData[]): MeshData {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.positions.length;
    ni += p.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + base;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return { positions, indices };
}

/**
 * Weld coincident vertices (tolerance in mm). Slicing chains contour segments through shared
 * edges, so STL "triangle soup" and BREP face meshes must be welded first. Degenerate
 * triangles are dropped.
 */
export function weld(m: MeshData, tol = 1e-3): MeshData {
  const inv = 1 / tol;
  const map = new Map<string, number>();
  const src = m.positions;
  const remap = new Uint32Array(src.length / 3);
  const out: number[] = [];
  for (let i = 0; i < src.length / 3; i++) {
    const x = src[i * 3];
    const y = src[i * 3 + 1];
    const z = src[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      out.push(x, y, z);
      map.set(key, id);
    }
    remap[i] = id;
  }
  const idx: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = remap[m.indices[t]];
    const b = remap[m.indices[t + 1]];
    const c = remap[m.indices[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(idx) };
}

export function applyMatrix(m: MeshData, r: Mat3): MeshData {
  const p = m.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z;
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z;
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z;
  }
  return { positions: out, indices: m.indices };
}

export function translate(m: MeshData, dx: number, dy: number, dz: number): MeshData {
  const p = m.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] + dx;
    out[i + 1] = p[i + 1] + dy;
    out[i + 2] = p[i + 2] + dz;
  }
  return { positions: out, indices: m.indices };
}

export function scale(m: MeshData, s: number): MeshData {
  if (s === 1) return m;
  const out = new Float32Array(m.positions.length);
  for (let i = 0; i < out.length; i++) out[i] = m.positions[i] * s;
  return { positions: out, indices: m.indices };
}

/** Place the mesh with its bbox centered on the XY origin and resting on Z=0. */
export function dropToOrigin(m: MeshData): MeshData {
  const b = computeBounds(m);
  return translate(m, -(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]);
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function rotX(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation mapping unit vector `from` onto unit vector `to` (Rodrigues). */
export function rotationBetween(from: [number, number, number], to: [number, number, number]): Mat3 {
  const [ax, ay, az] = from;
  const [bx, by, bz] = to;
  const vx = ay * bz - az * by;
  const vy = az * bx - ax * bz;
  const vz = ax * by - ay * bx;
  const c = ax * bx + ay * by + az * bz;
  if (c > 1 - 1e-9) return [...IDENTITY] as Mat3;
  if (c < -1 + 1e-9) {
    // 180°: half-turn about any axis perpendicular to `from`
    const axis: [number, number, number] = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let px = ay * axis[2] - az * axis[1];
    let py = az * axis[0] - ax * axis[2];
    let pz = ax * axis[1] - ay * axis[0];
    const l = Math.hypot(px, py, pz);
    px /= l;
    py /= l;
    pz /= l;
    return [
      2 * px * px - 1, 2 * px * py, 2 * px * pz,
      2 * py * px, 2 * py * py - 1, 2 * py * pz,
      2 * pz * px, 2 * pz * py, 2 * pz * pz - 1,
    ];
  }
  const k = 1 / (1 + c);
  return [
    vx * vx * k + c, vx * vy * k - vz, vx * vz * k + vy,
    vy * vx * k + vz, vy * vy * k + c, vy * vz * k - vx,
    vz * vx * k - vy, vz * vy * k + vx, vz * vz * k + c,
  ];
}

export interface MeshStats {
  triangles: number;
  vertices: number;
  size: [number, number, number];
  area: number; // mm²
  volume: number; // mm³, meaningful only for closed meshes
  openEdges: number; // 0 → watertight
}

export function meshStats(m: MeshData): MeshStats {
  const b = computeBounds(m);
  const p = m.positions;
  const ix = m.indices;
  let area = 0;
  let vol = 0;
  const edges = new Map<number, number>();
  const nv = p.length / 3;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const bb = ix[t + 1] * 3;
    const c = ix[t + 2] * 3;
    const ux = p[bb] - p[a], uy = p[bb + 1] - p[a + 1], uz = p[bb + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    vol +=
      (p[a] * (p[bb + 1] * p[c + 2] - p[bb + 2] * p[c + 1]) -
        p[a + 1] * (p[bb] * p[c + 2] - p[bb + 2] * p[c]) +
        p[a + 2] * (p[bb] * p[c + 1] - p[bb + 1] * p[c])) / 6;
    for (let e = 0; e < 3; e++) {
      const u = ix[t + e];
      const v = ix[t + ((e + 1) % 3)];
      const key = u < v ? u * nv + v : v * nv + u;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of edges.values()) if (n === 1) open++;
  return {
    triangles: ix.length / 3,
    vertices: nv,
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    area,
    volume: Math.abs(vol),
    openEdges: open,
  };
}

/** Flip all triangles when the mesh is inside-out (negative signed volume), so normals point outward. */
export function orientOutward(m: MeshData): MeshData {
  const p = m.positions;
  const ix = m.indices;
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const b = ix[t + 1] * 3;
    const c = ix[t + 2] * 3;
    vol +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (vol >= 0) return m;
  const flipped = new Uint32Array(ix.length);
  for (let t = 0; t < ix.length; t += 3) {
    flipped[t] = ix[t];
    flipped[t + 1] = ix[t + 2];
    flipped[t + 2] = ix[t + 1];
  }
  return { positions: p, indices: flipped };
}
