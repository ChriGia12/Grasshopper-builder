// Several parts are printed one after the other; between two parts the extruder stops, the robot
// goes up, moves with a PTP above the next part, comes down and switches the extruder on again.
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

// Two blocks 70 mm apart along Y; the build centres the pair on (5, 515) in BASE.
const pair = weld(mergeMeshes([box(50, 40, 10), box(50, 40, 10, 0, 110, 0)]));
const robot = { ...DEFAULT_ROBOT, originX: 5, originY: 515 };
// mesh spans x 0…50, y 0…150 → BASE x −20…30, y 440…590
const boxes: PartBox[] = [
  [-20, 440, 30, 480],
  [-20, 550, 30, 590],
];

describe('several parts, one after the other', () => {
  const r = runBuild(pair, I, print, robot, 't', bodies, boxes);
  const pts = r.toolpath.points;
  const partOf = (y: number) => (y + r.offset[1] < 515 ? 0 : 1);

  it('the first part is printed whole, then the second', () => {
    const order = pts.filter((p) => p.e).map((p) => partOf(p.y));
    const firstOfSecond = order.indexOf(1);
    expect(firstOfSecond).toBeGreaterThan(0);
    expect(order.slice(0, firstOfSecond).every((k) => k === 0)).toBe(true);
    expect(order.slice(firstOfSecond).every((k) => k === 1)).toBe(true);
    expect(r.toolpath.layerCount).toBe(10); // 5 layers each
  });

  it('one change of part: up, PTP above the next part, down, then printing again', () => {
    expect(r.toolpath.partChanges).toBe(1);
    const i = pts.findIndex((p) => p.ptp);
    const [from, up, over, down] = [pts[i - 2], pts[i - 1], pts[i], pts[i + 1]];
    expect(from.e).toBe(true);
    expect([up.e, over.e, down.e]).toEqual([false, false, false]);
    expect(over.z).toBeGreaterThanOrEqual(Math.max(...pts.slice(0, i).filter((p) => p.e).map((p) => p.z)) + PART_CHANGE_CLEARANCE - 1e-6);
    expect([up.x, up.y, up.z]).toEqual([from.x, from.y, over.z]); // straight up…
    expect([down.x, down.y]).toEqual([over.x, over.y]); // …across with the PTP, straight down
    expect(partOf(down.y)).toBe(1);
    expect(pts.slice(i + 2).find((p) => p.e)).toBeDefined(); // printing goes on on the second part
  });

  it('the .src switches the extruder off before and on again after the PTP', () => {
    const lines = r.src.split('\r\n');
    // Cartesian PTPs: the one to the first point + the change of part (safe and homing PTPs are axis PTPs)
    const ptpLines = lines.flatMap((l, k) => (l.startsWith('PTP {X') ? [k] : []));
    expect(ptpLines.length).toBe(2);
    const k = ptpLines[1];
    expect(lines.slice(k - 6, k).join('\n')).toContain('$OUT[16]=FALSE');
    expect(lines[k - 1]).toMatch(/^LIN \{.*\}$/); // lift with exact stop: up before swinging across
    expect(lines[k + 1]).toMatch(/^LIN \{/); // down onto the second part
    const after = lines.slice(k + 2, k + 14).join('\n');
    expect(after).toContain('RIACCENSIONE ESTRUSORE');
    expect(after).toContain('$OUT[16]=TRUE');
    expect(after.indexOf('$OUT[16]=TRUE')).toBeLessThan(after.indexOf('\nLIN {'));
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

describe('a part lower than the base cut', () => {
  it('is reported, not silently dropped', () => {
    // a 5 mm block and a 20 mm block 70 mm apart; base cut at 10 mm leaves nothing of the first
    const two = weld(mergeMeshes([box(50, 40, 5), box(50, 40, 20, 0, 110, 0)]));
    const r = runBuild(two, I, { ...print, baseCut: 10 }, robot, 't', bodies, boxes);
    expect(r.toolpath.warnings.map((w) => w.k)).toContain('w.partEmpty');
  });
});
