// Procedural closed meshes for tests.
import { mergeMeshes, type MeshData } from '../src/core/mesh';

export function box(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): MeshData {
  const v = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ].flatMap(([x, y, z]) => [x + ox, y + oy, z + oz]);
  const f = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return { positions: new Float32Array(v), indices: new Uint32Array(f) };
}

/** Closed cylinder / cone frustum (r0 at bottom, r1 at top). */
export function cylinder(r0: number, r1: number, h: number, seg = 64): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(r0 * Math.cos(a), r0 * Math.sin(a), 0, r1 * Math.cos(a), r1 * Math.sin(a), h);
  }
  const cb = pos.length / 3;
  pos.push(0, 0, 0, 0, 0, h);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const b0 = i * 2, t0 = i * 2 + 1, b1 = j * 2, t1 = j * 2 + 1;
    idx.push(b0, b1, t1, b0, t1, t0, cb, b1, b0, cb + 1, t0, t1);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export const twoBoxes = () => mergeMeshes([box(20, 20, 30), box(20, 20, 30, 50, 0, 0)]);

/** Square frame (box with a square hole through Z) built from 4 boxes, welded later. */
export function frame(outer: number, wall: number, h: number): MeshData {
  // Built as a single manifold ring so the hole is a true inner contour.
  const o = outer, w = wall;
  const ring = [[0, 0], [o, 0], [o, o], [0, o]];
  const hole = [[w, w], [o - w, w], [o - w, o - w], [w, o - w]];
  const pos: number[] = [];
  for (const z of [0, h]) for (const p of [...ring, ...hole]) pos.push(p[0], p[1], z);
  // indices: bottom ring 0-3, bottom hole 4-7, top ring 8-11, top hole 12-15
  const idx: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // outer wall (normal outward)
    idx.push(i, j, 8 + j, i, 8 + j, 8 + i);
    // inner wall (normal toward hole center)
    idx.push(4 + j, 4 + i, 12 + i, 4 + j, 12 + i, 12 + j);
    // bottom face (normal -Z)
    idx.push(i, 4 + i, 4 + j, i, 4 + j, j);
    // top face (normal +Z)
    idx.push(8 + i, 8 + j, 12 + j, 8 + i, 12 + j, 12 + i);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Hollow tube (closed shell with outer and inner skin), like a vase modelled with thickness. */
export function tube(rOut: number, rIn: number, h: number, seg = 96): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // 0 outer bottom, 1 outer top, 2 inner bottom, 3 inner top
    pos.push(rOut * c, rOut * s, 0, rOut * c, rOut * s, h, rIn * c, rIn * s, 0, rIn * c, rIn * s, h);
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const [ob0, ot0, ib0, it0] = [i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 3];
    const [ob1, ot1, ib1, it1] = [j * 4, j * 4 + 1, j * 4 + 2, j * 4 + 3];
    idx.push(ob0, ob1, ot1, ob0, ot1, ot0); // outer skin
    idx.push(ib1, ib0, it0, ib1, it0, it1); // inner skin
    idx.push(ob0, ib0, ib1, ob0, ib1, ob1); // bottom ring
    idx.push(ot0, ot1, it1, ot0, it1, it0); // top ring
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Closed solid of revolution about Z: profile = [radius, z] from bottom to top, flat caps. */
export function lathe(profile: [number, number][], seg = 48): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const [r, z] of profile)
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(r * Math.cos(a), r * Math.sin(a), z);
    }
  const bottom = pos.length / 3;
  pos.push(0, 0, profile[0][1]);
  const top = pos.length / 3;
  pos.push(0, 0, profile[profile.length - 1][1]);
  for (let i = 0; i + 1 < profile.length; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      idx.push(a, b, b + seg, a, b + seg, a + seg);
    }
  const last = (profile.length - 1) * seg;
  for (let j = 0; j < seg; j++) {
    idx.push(bottom, (j + 1) % seg, j);
    idx.push(top, last + j, last + ((j + 1) % seg));
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
