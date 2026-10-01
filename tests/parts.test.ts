// Several parts: from one part to the next the extruder stops and the robot moves with a PTP.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/core/pipeline';
import { cellBodies, type CellPart } from '../src/core/collision';
import { IDENTITY, mergeMeshes, weld, type Mat3 } from '../src/core/mesh';
import { PART_CHANGE_CLEARANCE, type PartBox } from '../src/core/parts';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box } from './fixtures';

const header = JSON.parse(readFileSync('public/cell.json', 'utf8')) as { parts: CellPart[] };
const cell = readFileSync('public/cell.bin');
const bodies = cellBodies(header.parts, cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength), [372.65, 0, 78.111]);
const I = [...IDENTITY] as Mat3;
const print = { ...DEFAULT_PRINT, layerHeight: 2 };

// Two blocks 60 mm apart along Y; the build centres the pair on (5, 515) in BASE.
const pair = weld(mergeMeshes([box(50, 40, 10), box(50, 40, 10, 0, 100, 0)]));
const robot = { ...DEFAULT_ROBOT, originX: 5, originY: 515 };
// mesh spans x 0…50, y 0…140 → BASE x −20…30, y 445…585
const boxes: PartBox[] = [
  [-20, 445, 30, 485],
  [-20, 545, 30, 585],
];

describe('change of part', () => {
  const r = runBuild(pair, I, print, robot, 't', bodies, boxes);
  const pts = r.toolpath.points;

  it('every move between the two parts is a PTP above them, with the extruder off', () => {
    const changes = r.toolpath.partChanges!;
    expect(changes).toBeGreaterThanOrEqual(r.toolpath.layerCount - 1); // about one per layer
    const ptp = pts.flatMap((p, i) => (p.ptp ? [i] : []));
    expect(ptp.length).toBe(changes);
    for (const i of ptp) {
      const [from, up, over, down] = [pts[i - 2], pts[i - 1], pts[i], pts[i + 1]];
      expect(from.e).toBe(true);
      expect([up.e, over.e, down.e]).toEqual([false, false, false]);
      expect(over.z).toBeGreaterThanOrEqual(from.z + PART_CHANGE_CLEARANCE - 1e-6); // above what is printed
      expect([up.x, up.y, up.z]).toEqual([from.x, from.y, over.z]); // straight up…
      expect([down.x, down.y]).toEqual([over.x, over.y]); // …across with the PTP, straight down
    }
  });

  it('no extruded move goes from one part to the other', () => {
    const partOf = (y: number) => (y + r.offset[1] < 515 ? 0 : 1);
    for (let i = 1; i < pts.length; i++) if (pts[i].e) expect(partOf(pts[i].y)).toBe(partOf(pts[i - 1].y));
  });

  it('the .src switches the extruder off and moves with PTP between the parts', () => {
    const lines = r.src.split('\r\n');
    // Cartesian PTPs: the one to the first point + one per change of part (safe and homing PTPs are axis PTPs)
    const ptpLines = lines.flatMap((l, i) => (l.startsWith('PTP {X') ? [i] : []));
    expect(ptpLines.length).toBe(1 + r.toolpath.partChanges!);
    for (const i of ptpLines.slice(1)) expect(lines.slice(Math.max(0, i - 6), i).join('\n')).toContain('$OUT[16]=FALSE');
    // the lift before each PTP stops exactly: no C_DIS, the arm is up before it swings
    for (const i of ptpLines.slice(1)) expect(lines[i - 1]).toMatch(/^LIN \{.*\}$/);
  });

  it('the moves are reachable and free of collisions', () => {
    expect(r.reach.unreachable).toBe(0);
    expect(r.collision?.count).toBe(0);
    expect(r.collision?.ptp).toEqual([]);
  });

  it('layer markers still point at the start of each layer', () => {
    const ls = r.toolpath.layerStart;
    for (let k = 1; k < ls.length; k++) expect(ls[k]).toBeGreaterThan(ls[k - 1]);
    expect(ls[ls.length - 1]).toBeLessThan(pts.length);
  });

  it('a single part keeps its LIN travels', () => {
    const one = runBuild(weld(box(50, 40, 10)), I, print, robot, 't', bodies);
    expect(one.toolpath.partChanges ?? 0).toBe(0);
    expect(one.toolpath.points.some((p) => p.ptp)).toBe(false);
  });
});
