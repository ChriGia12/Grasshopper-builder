// Collisions of the arm and the mandrino with the plate, the printed part and on the PTP moves.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellBodies, collisionReport, Obstacles, type CellPart } from '../src/core/collision';
import { reachReport, type Joints } from '../src/core/robot';
import { runBuild } from '../src/core/pipeline';
import { joinInTurn } from '../src/core/parts';
import type { PathPoint, Toolpath } from '../src/core/toolpath';
import { IDENTITY, weld, type Mat3 } from '../src/core/mesh';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box } from './fixtures';

const header = JSON.parse(readFileSync('public/cell.json', 'utf8')) as { parts: CellPart[] };
const file = readFileSync('public/cell.bin');
const bin = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const tip = DEFAULT_ROBOT.toolData.slice(0, 3) as [number, number, number];
const bodies = cellBodies(header.parts, bin, tip);
const I = [...IDENTITY] as Mat3;

describe('collision bodies', () => {
  it('samples the wrist, the mandrino and its needle', () => {
    expect(bodies.map((b) => b.name)).toEqual(expect.arrayContaining(['A4', 'A5', 'A6', 'mandrino', 'ugello']));
    for (const b of bodies) expect(b.pts.length).toBeGreaterThan(0);
  });
});

describe('collisions on the print path', () => {
  it('a normal part printed with the tool vertical hits nothing', () => {
    const r = runBuild(weld(box(80, 80, 30)), I, DEFAULT_PRINT, DEFAULT_ROBOT, 't', bodies);
    expect(r.collision?.count).toBe(0);
    expect(r.collision?.ptp).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('the mandrino laid horizontal (C 90) close to the plate hits it', () => {
    const pts = [0, 500, 45, 50, 500, 45];
    const robot = { ...DEFAULT_ROBOT, c: 90 };
    const reach = reachReport(pts, robot, [90, 90]);
    expect(reach.unreachable).toBe(0);
    const rep = collisionReport(pts, [0, 1], reach.joints, bodies, robot, DEFAULT_PRINT, { first: null, last: null });
    expect(rep.count).toBeGreaterThan(0);
    expect(rep.what).toBe('plate');
  });

  it('material already printed under the mandrino body is a collision', () => {
    const pts = [0, 500, 60];
    const reach = reachReport(pts, DEFAULT_ROBOT);
    const obs = new Obstacles(DEFAULT_ROBOT, bodies);
    expect(obs.hit(reach.first!, true)).toBeNull();
    // a tall wall where the mandrino body is (78 mm beside the nozzle, 60…400 mm above it)
    for (let z = 40; z < 400; z += 1.5) obs.addBead([-90, 470, z], [-60, 530, z], DEFAULT_PRINT);
    expect(obs.hit(reach.first!, true)?.what).toBe('part');
  });

  it('a long LIN is checked along its whole length, not only at its ends', () => {
    // a tall wall where the mandrino body passes when the nozzle is at (0, 500, 60)…
    const pts: number[] = [];
    const ext: number[] = [];
    for (let z = 40; z < 400; z += 1.5) {
      pts.push(-90, 470, z, -60, 530, z);
      ext.push(pts.length > 6 ? 1 : 0, 1);
    }
    // …then a single 400 mm travel across it: both ends are clear, the middle is not
    pts.push(-60, 530, 450, 0, 300, 450, 0, 300, 60, 0, 700, 60);
    ext.push(0, 0, 0, 0);
    const reach = reachReport(pts, DEFAULT_ROBOT, undefined, 1000);
    expect(reach.unreachable).toBe(0);
    const obs = new Obstacles(DEFAULT_ROBOT, bodies);
    const n = pts.length / 3;
    const q = (i: number) => Array.from(reach.joints.subarray(i * 6, i * 6 + 6)) as Joints;
    for (let i = 1; i < n; i++) if (ext[i]) obs.addBead([pts[i * 3 - 3], pts[i * 3 - 2], pts[i * 3 - 1]], [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]], DEFAULT_PRINT);
    expect(obs.hit(q(n - 2), true)).toBeNull();
    expect(obs.hit(q(n - 1), true)).toBeNull();
    const rep = collisionReport(pts, ext, reach.joints, bodies, DEFAULT_ROBOT, DEFAULT_PRINT, { first: null, last: null });
    expect(rep.count).toBeGreaterThan(0);
    expect(rep.first).toBe(n - 1);
    expect(rep.what).toBe('part');
  });

  it('supports in their own program: the real end and start of the two programs are checked', () => {
    // support program: a 30 mm wide column 260 mm tall, 60 mm from where the part starts
    const sup: PathPoint[] = [];
    for (let z = 40; z < 300; z += 1.5) sup.push({ x: -15, y: 440, z, e: sup.length > 0, support: true }, { x: 15, y: 440, z, e: true, support: true });
    const part: PathPoint[] = [
      { x: 0, y: 500, z: 60, e: false },
      { x: 30, y: 520, z: 60, e: true },
    ];
    const tp = (points: PathPoint[]): Toolpath => ({ points, mode: 'planar', layerCount: 1, layerHeight: 1.5, layerStart: [0], printLength: 0, travelLength: 0, travels: 0, warnings: [] });
    const joined = joinInTurn(tp(sup), tp(part));
    const k = sup.length;
    // no invented moves between the two programs: the part program starts right after the supports
    expect(joined.points.length).toBe(sup.length + part.length);
    expect(joined.points[k]).toMatchObject({ x: 0, y: 500, z: 60, ptp: true, program: true });
    expect(part[0].program).toBeUndefined(); // the part program itself is not changed
    const pts = joined.points.flatMap((p) => [p.x, p.y, p.z]);
    const ptpAt = joined.points.map((p) => (p.ptp ? 1 : 0));
    const reach = reachReport(pts, DEFAULT_ROBOT, undefined, 20, ptpAt);
    expect(reach.unreachable).toBe(0);
    const rep = collisionReport(
      pts,
      joined.points.map((p) => (p.e ? 1 : 0)),
      reach.joints,
      bodies,
      DEFAULT_ROBOT,
      DEFAULT_PRINT,
      { first: reach.first, last: reach.last },
      3,
      ptpAt,
      undefined,
      joined.points.map((p) => (p.program ? 1 : 0)),
    );
    // from the safe position down to the part, the arm sweeps through the printed column
    expect(rep.ptp).toContainEqual(expect.objectContaining({ move: 'start', what: 'part' }));
  });
});
