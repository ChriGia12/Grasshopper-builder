// The mesh is printed whole and as it is: every printed point of the part lies on its surface,
// every section of the mesh is printed, and supports are only added outside it.
import { describe, expect, it } from 'vitest';
import { buildToolpath, sliceForPrint, type Toolpath } from '../src/core/toolpath';
import { sliceAt } from '../src/core/slicer';
import { applyMatrix, dropToOrigin, rotX, weld, type MeshData } from '../src/core/mesh';
import { polylineLength } from '../src/core/polyline';
import { DEFAULT_PRINT, type PrintSettings } from '../src/core/settings';
import { FaceGrid, pointTriangle } from '../src/core/tilt';
import { lathe } from './fixtures';

/** An open bowl (dome without bottom) tilted: its rim touches the table at one point only. */
function tiltedBowl(): MeshData {
  const seg = 48;
  const rings = 16;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = ((i / rings) * Math.PI) / 2;
    for (let j = 0; j < seg; j++) {
      const b = (j / seg) * Math.PI * 2;
      pos.push(60 * Math.cos(a) * Math.cos(b), 60 * Math.cos(a) * Math.sin(b), 60 * Math.sin(a));
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      idx.push(a, b, b + seg, a, b + seg, a + seg);
    }
  return dropToOrigin(applyMatrix(weld({ positions: new Float32Array(pos), indices: new Uint32Array(idx) }), rotX(20)));
}

/** Largest distance of the printed points of the part (supports excluded) from the mesh. */
function offMesh(tp: Toolpath, m: MeshData, s: PrintSettings): number {
  const grid = new FaceGrid(m, 12);
  const P = m.positions;
  const I = m.indices;
  const V = (k: number): [number, number, number] => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]];
  let worst = 0;
  for (const q of tp.points) {
    if (!q.e || q.support) continue;
    const at: [number, number, number] = [q.x, q.y, q.z + s.layerHeight / 2 - s.firstLayerZ];
    const t = grid.nearest(at, 30);
    worst = Math.max(worst, t < 0 ? Infinity : pointTriangle(at, V(I[t * 3]), V(I[t * 3 + 1]), V(I[t * 3 + 2])));
  }
  return worst;
}

describe('the mesh is printed whole and as it is', () => {
  const s: PrintSettings = { ...DEFAULT_PRINT, mode: 'planar' };

  it('every layer prints exactly the section of the mesh (no base copied under it)', () => {
    const bowl = tiltedBowl();
    const printed = sliceForPrint(bowl, s).layers;
    const raw = sliceAt(bowl, printed.map((_, i) => (i + 0.5) * s.layerHeight));
    printed.forEach((l, i) => {
      const len = (cs: typeof l.contours) => cs.reduce((a, c) => a + polylineLength(c.pts, c.closed), 0);
      expect(len(l.contours)).toBeCloseTo(len(raw[i].contours), 0);
    });
  });

  it('every printed point of the part lies on the mesh', () => {
    const bowl = tiltedBowl();
    expect(offMesh(buildToolpath(bowl, s), bowl, s)).toBeLessThan(s.layerHeight + 0.5); // on the ramp the bead is up to one layer below
  });

  it('a part standing on a point keeps its point (no footprint invented at the bottom)', () => {
    const top = weld(lathe([[1, 0], [40, 30], [40, 40]])); // a cone standing on its tip
    const first = sliceForPrint(top, s).layers[0];
    const r = Math.max(...first.contours.flatMap((c) => c.pts.map(([x, y]) => Math.hypot(x, y))));
    expect(r).toBeLessThan(5);
  });
});

describe('supports', () => {
  const s: PrintSettings = { ...DEFAULT_PRINT, mode: 'planar', supports: true };

  it('the rim that rises off the table gets a wall under it; the part is unchanged', () => {
    const bowl = tiltedBowl();
    const tp = buildToolpath(bowl, s);
    const sup = tp.points.filter((p) => p.support);
    expect(sup.length).toBeGreaterThan(20);
    expect(tp.warnings.map((w) => w.k)).toContain('w.supports');
    // the part itself is printed exactly as without supports
    expect(offMesh(tp, bowl, s)).toBeLessThan(s.layerHeight + 0.5); // on the ramp the bead is up to one layer below
    const plain = buildToolpath(bowl, { ...s, supports: false });
    const partLen = (t: Toolpath) => t.points.reduce((a, p, i) => (i && p.e && !p.support ? a + Math.hypot(p.x - t.points[i - 1].x, p.y - t.points[i - 1].y) : a), 0);
    expect(partLen(tp)).toBeGreaterThan(0.9 * partLen(plain));
    // every support column stands on the table: the lowest layer has supports
    const z0 = Math.min(...tp.points.filter((p) => p.e).map((p) => p.z));
    expect(sup.some((p) => Math.abs(p.z - z0) < 1e-6)).toBe(true);
  });

  it('a part standing well on the table needs none', () => {
    const tp = buildToolpath(weld(lathe([[40, 0], [40, 30]])), s);
    expect(tp.points.some((p) => p.support)).toBe(false);
  });
});
