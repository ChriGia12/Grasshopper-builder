// Rings that follow the surface: every point one bead from the previous ring, the surface closes,
// the path is continuous (rings joined by a printed step, or one spiral).
import { describe, expect, it } from 'vitest';
import { beadField, beadStep, buildRings, levelRings } from '../src/core/rings';
import { buildToolpath } from '../src/core/toolpath';
import { applyMatrix, dropToOrigin, mergeMeshes, rotX, weld, type MeshData } from '../src/core/mesh';
import { DEFAULT_PRINT, type PrintSettings } from '../src/core/settings';
import { box, cylinder } from './fixtures';
import { FaceGrid, pointTriangle } from '../src/core/tilt';

const s: PrintSettings = { ...DEFAULT_PRINT, adaptiveLayers: true, minContourLength: 0, tolerance: 0.05 };
type V3 = [number, number, number];
const d3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Closed dome: hemisphere of radius r on a flat bottom. */
function dome(r: number, seg = 48, rings = 24): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = ((i / rings) * Math.PI) / 2;
    for (let j = 0; j < seg; j++) {
      const b = (j / seg) * Math.PI * 2;
      pos.push(r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a));
    }
  }
  const c = pos.length / 3;
  pos.push(0, 0, 0);
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      idx.push(a, b, b + seg, a, b + seg, a + seg);
    }
  for (let j = 0; j < seg; j++) idx.push(c, (j + 1) % seg, j);
  return weld({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

describe('bead step along the surface', () => {
  it('one layer height up a wall, one bead width across a flat area', () => {
    expect(beadStep(1, 0, s)).toBeCloseTo(1.5); // vertical
    expect(beadStep(0, 1, s)).toBeCloseTo(6); // horizontal
    const t = (deg: number) => [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)] as const;
    expect(beadStep(...t(45), s) * t(45)[0]).toBeCloseTo(1.5); // steep enough: Δz = 1.5
    expect(beadStep(...t(5), s) * t(5)[1]).toBeCloseTo(6); // shallow: 6 mm sideways
  });
});

describe('rings on a shallow cone (6.8° slope)', () => {
  const cone = weld(cylinder(60, 10, 6));
  const phi = beadField(cone, s);
  const ring = (k: number) => levelRings(cone, phi, k + 0.5)[0].pts as V3[];

  it('every point of a ring is one bead (≈ 6 mm) from the previous ring, not only the start', () => {
    const [a, b] = [ring(2), ring(3)];
    const gaps = b.map((q) => Math.min(...a.map((p) => d3(p, q))));
    // the rings are polylines through the mesh, the nearest vertex is a slight overestimate
    for (const g of gaps) {
      expect(g).toBeGreaterThan(6 * 0.85);
      expect(g).toBeLessThan(6 * 1.2);
    }
  });

  it('the surface closes: rings go on across the flat top until nothing is left', () => {
    const tp = buildRings(cone, s, [0, 0], false);
    const last = tp.points.slice(tp.layerStart[tp.layerStart.length - 1]);
    const radius = Math.max(...last.map((p) => Math.hypot(p.x, p.y)));
    expect(radius).toBeLessThan(2 * s.wallSpacing);
  });
});

describe('rings on a dome', () => {
  const d = dome(60);

  it('one continuous bead: rings joined by printed steps, no lifted travel', () => {
    const tp = buildToolpath(d, { ...s, mode: 'planar' });
    expect(tp.travels).toBe(0);
    expect(tp.points.slice(1).every((p) => p.e)).toBe(true);
    const top = tp.points.slice(tp.layerStart[tp.layerStart.length - 1]);
    expect(Math.max(...top.map((p) => Math.hypot(p.x, p.y)))).toBeLessThan(2 * s.wallSpacing); // closed at the top
  });

  it('on the steep flank the rings climb 1.5 mm, near the top they get closer in Z', () => {
    const tp = buildToolpath(d, { ...s, mode: 'planar' });
    // height of every ring where it closes (its start is on the ramp from the ring below)
    const z = tp.layerStart.map((_, k) => tp.points[(tp.layerStart[k + 1] ?? tp.points.length) - 1].z);
    expect(z[2] - z[1]).toBeCloseTo(1.5, 0);
    expect(z[z.length - 1] - z[z.length - 2]).toBeLessThan(1);
  });

  it('spiral: one path, Z rising turn after turn without steps', () => {
    const tp = buildToolpath(d, { ...s, mode: 'spiral' });
    expect(tp.mode).toBe('spiral');
    expect(tp.travels).toBe(0);
    const pts = tp.points;
    const jumps = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y, p.z - pts[i].z));
    expect(Math.max(...jumps)).toBeLessThan(2 * s.wallSpacing);
    // within a turn Z changes smoothly (no 1.5 mm step at one point)
    for (let i = tp.layerStart[3]; i < tp.layerStart[4]; i++) expect(Math.abs(pts[i + 1].z - pts[i].z)).toBeLessThan(0.75);
  });
});

describe('an open shell whose edge is not flat (like an upside-down hull)', () => {
  // An open dome (no bottom) tilted 15°: its edge touches the table at one point only. The rings
  // must not fan out from that point: the bottom is printed like contour layers (a base with the
  // first full outline) and from the first complete loop the rings go round the part.
  const open = dome(60);
  const shell = weld({ positions: open.positions, indices: open.indices.slice(0, open.indices.length - 48 * 3) });
  const tilted = dropToOrigin(applyMatrix(shell, rotX(15)));

  it('every printed point lies on the mesh: no base invented under it, rings round the part above', () => {
    const tp = buildToolpath(tilted, { ...s, mode: 'planar' });
    const grid = new FaceGrid(tilted, 12);
    const P = tilted.positions;
    const I = tilted.indices;
    const V = (k: number): [number, number, number] => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
    for (const q of tp.points) {
      if (!q.e) continue;
      // the nozzle sits half a bead lower than where the surface was cut
      const at: [number, number, number] = [q.x, q.y, q.z + s.layerHeight / 2 - s.firstLayerZ];
      const t = grid.nearest(at, 20);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(pointTriangle(at, V(I[t * 3]), V(I[t * 3 + 1]), V(I[t * 3 + 2]))).toBeLessThan(1.5);
    }
  });
});

describe('fallbacks', () => {
  it('two separate towers cannot be one spiral: joined rings instead, with a note', () => {
    const towers = weld(mergeMeshes([box(30, 30, 20), box(30, 30, 20, 60, 0, 0)]));
    const tp = buildToolpath(towers, { ...s, mode: 'spiral' });
    expect(tp.mode).toBe('planar');
    expect(tp.warnings.map((w) => w.k)).toContain('w.spiralRings');
  });

  it('without the option nothing changes', () => {
    const plain = buildToolpath(dome(60), { ...DEFAULT_PRINT, mode: 'planar' });
    expect(plain.points.every((p, i, a) => i === 0 || p.z >= a[i - 1].z - 1e-9 || !p.e)).toBe(true);
  });
});
