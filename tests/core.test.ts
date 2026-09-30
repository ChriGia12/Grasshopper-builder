import { describe, expect, it } from 'vitest';
import { applyMatrix, dropToOrigin, meshStats, orientOutward, rotX, weld } from '../src/core/mesh';
import { sliceAt } from '../src/core/slicer';
import { signedArea, polylineLength, simplifyClosed, rotateToNearest } from '../src/core/polyline';
import { buildToolpath, sliceForPrint } from '../src/core/toolpath';
import { analyzeOrientations } from '../src/core/orientation';
import { writeKukaSrc, sanitizeProgramName } from '../src/core/kuka';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box, cylinder, frame, tube, twoBoxes } from './fixtures';

describe('mesh', () => {
  it('orientOutward fixes inside-out meshes', () => {
    const b = box(10, 10, 10);
    const inv = { positions: b.positions, indices: b.indices.slice().reverse() };
    expect(orientOutward(inv).indices).not.toBe(inv.indices);
    expect(orientOutward(b)).toBe(b);
  });

  it('box is watertight with correct volume', () => {
    const s = meshStats(weld(box(10, 20, 30)));
    expect(s.openEdges).toBe(0);
    expect(s.volume).toBeCloseTo(6000, 3);
  });
});

describe('slicer', () => {
  it('slices a box into one closed CCW square per layer', () => {
    const layers = sliceAt(weld(box(10, 20, 30)), [5, 15, 25]);
    for (const l of layers) {
      expect(l.contours).toHaveLength(1);
      expect(l.contours[0].closed).toBe(true);
      expect(signedArea(l.contours[0].pts)).toBeCloseTo(200, 3);
      expect(polylineLength(l.contours[0].pts, true)).toBeCloseTo(60, 3);
    }
  });

  it('finds outer contour and hole with opposite orientation', () => {
    const [l] = sliceAt(weld(frame(100, 10, 20)), [10]);
    expect(l.contours).toHaveLength(2);
    const outer = l.contours.find((c) => c.depth === 0)!;
    const hole = l.contours.find((c) => c.depth === 1)!;
    expect(signedArea(outer.pts)).toBeCloseTo(10000, 1);
    expect(signedArea(hole.pts)).toBeCloseTo(-6400, 1);
  });

  it('follows the exact contour of a cone', () => {
    const [l] = sliceAt(weld(cylinder(50, 25, 100, 128)), [50]);
    const r = Math.hypot(l.contours[0].pts[0][0], l.contours[0].pts[0][1]);
    expect(r).toBeCloseTo(37.5 * Math.cos(Math.PI / 128), 0);
  });
});

describe('polyline', () => {
  it('simplify keeps corners and removes collinear points', () => {
    const sq: [number, number][] = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]];
    expect(simplifyClosed(sq, 0.01)).toHaveLength(4);
  });
  it('rotateToNearest inserts the seam point', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(rotateToNearest(sq, [5, -3])[0]).toEqual([5, 0]);
  });
});

describe('toolpath', () => {
  it('uses spiral mode for a single-contour vase', () => {
    const m = weld(cylinder(60, 40, 30));
    const tp = buildToolpath(m, { ...DEFAULT_PRINT, layerHeight: 1.5 });
    expect(tp.mode).toBe('spiral');
    expect(tp.layerCount).toBe(20);
    expect(tp.travels).toBe(0);
    // Z never decreases in vase mode
    for (let i = 1; i < tp.points.length; i++) expect(tp.points[i].z).toBeGreaterThanOrEqual(tp.points[i - 1].z - 1e-9);
    expect(tp.points[0].z).toBeCloseTo(1.5);
    expect(tp.points[tp.points.length - 1].z).toBeCloseTo(30);
  });

  it('uses planar mode with travels for separate islands', () => {
    const m = weld(twoBoxes());
    const tp = buildToolpath(m, { ...DEFAULT_PRINT, layerHeight: 3 });
    expect(tp.mode).toBe('planar');
    expect(tp.layerCount).toBe(10);
    expect(tp.travels).toBeGreaterThanOrEqual(10);
    expect(tp.points.some((p) => !p.e)).toBe(true);
  });

  it('prints a thin hollow shell as one mid-line spiral', () => {
    const m = weld(tube(100, 96, 30));
    const tp = buildToolpath(m, { ...DEFAULT_PRINT, layerHeight: 1.5, thinWallMax: 10 });
    expect(tp.mode).toBe('spiral');
    const r = Math.hypot(tp.points[5].x, tp.points[5].y);
    expect(r).toBeGreaterThan(97);
    expect(r).toBeLessThan(99);
    const off = buildToolpath(m, { ...DEFAULT_PRINT, layerHeight: 1.5, thinWallMax: 0 });
    expect(off.mode).toBe('planar');
  });

  it('adds inner walls', () => {
    const m = weld(box(100, 100, 6));
    const one = sliceForPrint(m, { ...DEFAULT_PRINT, layerHeight: 3 });
    const tp = buildToolpath(m, { ...DEFAULT_PRINT, layerHeight: 3, walls: 3, wallSpacing: 5 }, one);
    expect(tp.mode).toBe('planar');
    // 3 squares of perimeter 400, 360, 320 per layer, 2 layers
    expect(tp.printLength).toBeGreaterThan(2 * (400 + 360 + 320) * 0.98);
  });
});

describe('orientation', () => {
  it('puts an upside-down cone on its wide base', () => {
    const cone = weld(applyMatrix(cylinder(50, 10, 80), rotX(180)));
    const [best] = analyzeOrientations(cone, 45, 2);
    const m = dropToOrigin(applyMatrix(cone, best.matrix));
    const [bottom] = sliceAt(m, [1]);
    const r = Math.hypot(bottom.contours[0].pts[0][0], bottom.contours[0].pts[0][1]);
    expect(r).toBeGreaterThan(40);
    expect(best.unsupportedIslands).toBe(0);
  });

  it('lays a T shape so nothing starts in mid-air', () => {
    // T: vertical stem with a wide top bar → printing upright leaves the bar overhanging.
    const t = orientOutward(weld(dropToOrigin(twoBar())));
    const [best] = analyzeOrientations(t, 45, 2);
    expect(best.unsupportedIslands).toBe(0);
    expect(best.overhangRatio).toBeLessThan(0.05);
  });
});

function twoBar() {
  // Extruded T profile along Y (prism), standing with the bar on top.
  const pts: [number, number][] = [[-5, 0], [5, 0], [5, 40], [25, 40], [25, 50], [-25, 50], [-25, 40], [-5, 40]];
  const n = pts.length;
  const pos: number[] = [];
  for (const y of [0, 30]) for (const [x, z] of pts) pos.push(x, y, z);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, i, n + j, n + i);
  }
  // caps: stem + bar triangulated by hand (winding fixed later by orientOutward)
  const capA = [[0, 1, 2], [0, 2, 7], [6, 3, 4], [6, 4, 5], [6, 7, 2], [6, 2, 3]];
  for (const [a, b, c] of capA) {
    idx.push(a, c, b);
    idx.push(n + a, n + b, n + c);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

describe('kuka writer', () => {
  it('matches the Tavolino1.src structure', () => {
    const m = weld(cylinder(60, 60, 4.5));
    const tp = buildToolpath(m, { ...DEFAULT_PRINT, layerHeight: 1.5 });
    const src = writeKukaSrc(tp, { ...DEFAULT_ROBOT, programName: 'Test1' }, { sourceName: 'test.stl', layerHeight: 1.5 });
    const lines = src.split('\r\n');
    expect(lines[0]).toBe('DEF Test1 ( )');
    expect(lines[1]).toBe('GLOBAL INTERRUPT DECL 3 WHEN $STOPMESS==TRUE DO IR_STOPM ( )');
    expect(lines.at(-1)).toBe('END');
    expect(src).toContain('$BASE=BASE_DATA[1]');
    expect(src).toContain('$TOOL=TOOL_DATA[11]');
    expect(src).toContain('$VEL.CP=0.8\r\n');
    expect(src).toContain('PTP {A1 0.000, A2 -90.000, A3 90.000, A4 0.000, A5 -1.000, A6 0.000, E1 0, E2 0, E3 0, E4 0, E5 0, E6 0}');
    expect(src).toContain('$ANOUT[6]=2\r\n$ANOUT[7]=1\r\nWAIT SEC 1\r\n$OUT[16]=TRUE');
    const lin = lines.filter((l) => l.startsWith('LIN '));
    expect(lin.length).toBe(tp.points.length);
    for (const l of lin)
      expect(l).toMatch(/^LIN \{X -?\d+\.\d{3}, Y -?\d+\.\d{3}, Z -?\d+\.\d{3}, A -180\.000, B 0\.000, C 180\.000, E1 0\.000, E2 0\.000, E3 0\.000, E4 0\.000\} C_DIS$/);
    // first layer Z = originZ + layer height, like Tavolino1 (37 + 1.5)
    expect(lin[0]).toContain('Z 38.500');
    // PTP approach equals first LIN target
    const ptp = lines.find((l) => l.startsWith('PTP {X'))!;
    expect(ptp.slice(4)).toBe(lin[0].slice(4, -6));
  });

  it('turns the extruder off for travels and back on', () => {
    const tp = buildToolpath(weld(twoBoxes()), { ...DEFAULT_PRINT, layerHeight: 10 });
    const src = writeKukaSrc(tp, DEFAULT_ROBOT, { sourceName: 'x', layerHeight: 10 });
    const offs = src.split('; ESTRUSORE OFF').length - 1;
    const ons = src.split('; RIACCENSIONE ESTRUSORE').length - 1;
    expect(offs).toBe(tp.travels);
    expect(ons).toBe(tp.travels);
  });

  it('sanitizes program names', () => {
    expect(sanitizeProgramName('1 vaso-prova.stl')).toBe('P1_vaso_prova');
  });
});
