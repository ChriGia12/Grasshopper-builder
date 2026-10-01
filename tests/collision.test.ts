// Collisions of the arm and the mandrino with the plate, the printed part and on the PTP moves.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellBodies, collisionReport, Obstacles, type CellPart } from '../src/core/collision';
import { reachReport } from '../src/core/robot';
import { runBuild } from '../src/core/pipeline';
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
});
