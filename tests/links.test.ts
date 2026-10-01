// Verified links: no extruded move may leave the material, whatever the heuristics choose;
// orientations and builds that need support are flagged instead of exported silently.
import { describe, expect, it } from 'vitest';
import { ShapeUtils, Vector2 } from 'three';
import { buildToolpath, linkPrintable } from '../src/core/toolpath';
import { analyzeOrientations } from '../src/core/orientation';
import { runBuild } from '../src/core/pipeline';
import { IDENTITY, mergeMeshes, weld, type Mat3, type MeshData } from '../src/core/mesh';
import { DEFAULT_PRINT, DEFAULT_ROBOT, type PrintSettings } from '../src/core/settings';
import type { Vec2 } from '../src/core/polyline';
import { box } from './fixtures';

const I = [...IDENTITY] as Mat3;

/** Closed prism: polygon (counter-clockwise) extruded from z0 to z1. */
function prism(poly: Vec2[], z0: number, z1: number): MeshData {
  const n = poly.length;
  const pos = [...poly.flatMap(([x, y]) => [x, y, z0]), ...poly.flatMap(([x, y]) => [x, y, z1])];
  const idx: number[] = [];
  for (const [a, b, c] of ShapeUtils.triangulateShape(poly.map(([x, y]) => new Vector2(x, y)), [])) idx.push(a, c, b, n + a, n + b, n + c);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, i, n + j, n + i);
  }
  return weld({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

/** Distance from q to the polygon border. */
function borderDist(q: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
  });
  return d;
}

function inPoly(q: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Samples (every 0.5 mm) of extruded moves that fall outside every polygon by more than `margin`. */
function strayExtrusion(points: { x: number; y: number; e: boolean }[], polys: Vec2[][], margin: number): number {
  let stray = 0;
  for (let i = 1; i < points.length; i++) {
    if (!points[i].e) continue;
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
    for (let k = 0; k <= n; k++) {
      const q: Vec2 = [a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n];
      if (!polys.some((p) => inPoly(q, p) || borderDist(q, p) <= margin)) stray++;
    }
  }
  return stray;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// C section: the notch (x 15…60, y 15…45) is open on the right.
const C: Vec2[] = [[0, 0], [60, 0], [60, 15], [15, 15], [15, 45], [60, 45], [60, 60], [0, 60]];
// Comb: a 10 mm spine with 5 teeth 8 mm wide, 30 mm long, 8 mm apart.
const COMB: Vec2[] = [
  [0, 0], [72, 0], [72, 40], [64, 40], [64, 10], [56, 10], [56, 40], [48, 40], [48, 10], [40, 10],
  [40, 40], [32, 40], [32, 10], [24, 10], [24, 40], [16, 40], [16, 10], [8, 10], [8, 40], [0, 40],
];
const MARGIN = Math.min(1, DEFAULT_PRINT.wallSpacing / 4) + 0.05;

describe('verified links', () => {
  it('linkPrintable: a link over a gap or longer than the limit is a travel', () => {
    const inBox = (a: Vec2, b: Vec2) => Math.max(a[0], b[0]) <= 30 && Math.min(a[0], b[0]) >= 0;
    const s = DEFAULT_PRINT;
    expect(linkPrintable([0, 0], [0.3, 0], s, undefined)).toBe(true); // same spot (seam on the vertical)
    expect(linkPrintable([0, 0], [5, 0], s, undefined)).toBe(false); // short, but not verified
    expect(linkPrintable([0, 0], [5, 0], s, inBox)).toBe(true);
    expect(linkPrintable([25, 0], [33, 0], s, inBox)).toBe(false); // leaves the material
    expect(linkPrintable([0, 0], [20, 0], s, inBox)).toBe(false); // > maxBridge
    expect(linkPrintable([0, 0], [20, 0], s, inBox, true)).toBe(true); // serpentine: up to 8 beads
    expect(linkPrintable([0, 0], [8 * s.wallSpacing + 1, 0], s, () => true, true)).toBe(false);
  });

  it('two islands 5 mm apart: contour layers never extrude across the gap', () => {
    const mesh = weld(mergeMeshes([box(30, 30, 10), box(30, 30, 10, 35, 0, 0)]));
    const tp = buildToolpath(mesh, { ...DEFAULT_PRINT, mode: 'planar', layerHeight: 2 });
    expect(strayExtrusion(tp.points, [rect(0, 0, 30, 30), rect(35, 0, 65, 30)], MARGIN)).toBe(0);
    expect(tp.travels).toBeGreaterThan(0); // the gap is crossed lifted
  });

  for (const [name, poly] of [['C section', C], ['comb', COMB]] as const)
    for (const fillAngle of [0, 45, 90, 135])
      it(`${name}, solid serpentine at ${fillAngle}°: every extruded move stays on the material`, () => {
        const s: PrintSettings = { ...DEFAULT_PRINT, mode: 'zigzag', layerHeight: 2, fillAngle, fillAutoAngle: false, fillAlternate: false };
        const tp = buildToolpath(prism(poly, 0, 6), s);
        expect(tp.points.length).toBeGreaterThan(10);
        expect(strayExtrusion(tp.points, [poly], MARGIN)).toBe(0);
      });

  it('the automatic fill direction also yields only verified links', () => {
    for (const poly of [C, COMB]) {
      const tp = buildToolpath(prism(poly, 0, 6), { ...DEFAULT_PRINT, mode: 'zigzag', layerHeight: 2 });
      expect(strayExtrusion(tp.points, [poly], MARGIN)).toBe(0);
    }
  });
});

describe('support checks', () => {
  // Mushroom: 10×10 stem 20 mm tall under a 50×50 cap → the cap underside overhangs at 90°.
  const mushroom = () => weld(mergeMeshes([box(10, 10, 20, 20, 20, 0), box(50, 50, 6, 0, 0, 20)]));
  // Two blocks apart in X, Y and Z: in every orientation one of them starts in mid-air.
  const floating = () => weld(mergeMeshes([box(20, 20, 20), box(20, 20, 20, 40, 40, 40)]));

  it('a plain block needs no confirmation', () => {
    expect(runBuild(weld(box(50, 50, 10)), I, DEFAULT_PRINT, DEFAULT_ROBOT, 't').support).toBeNull();
  });

  it('an overhanging cap needs an explicit confirmation', () => {
    const r = runBuild(mushroom(), I, { ...DEFAULT_PRINT, layerHeight: 2 }, DEFAULT_ROBOT, 't');
    expect(r.support).not.toBeNull();
    expect(r.support!.overhang).toBeGreaterThan(2);
    expect(r.toolpath.warnings.map((w) => w.k)).toContain('w.support');
  });

  it('orientations: the valid ones come first (mushroom upside down rests on its cap)', () => {
    const o = analyzeOrientations(mushroom(), DEFAULT_PRINT.overhangAngle, 2);
    expect(o[0].valid).toBe(true);
    const firstInvalid = o.findIndex((c) => !c.valid);
    expect(firstInvalid).toBeGreaterThan(0);
    expect(o.slice(firstInvalid).every((c) => !c.valid)).toBe(true);
  });

  it('no valid orientation: the build is flagged, never exported without confirmation', () => {
    const o = analyzeOrientations(floating(), DEFAULT_PRINT.overhangAngle, 2);
    expect(o.every((c) => !c.valid)).toBe(true);
    const r = runBuild(floating(), o[0].matrix, { ...DEFAULT_PRINT, layerHeight: 2 }, DEFAULT_ROBOT, 't');
    expect(r.support).not.toBeNull();
  });
});
