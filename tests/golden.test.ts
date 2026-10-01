// Reference part: tests/data/sella.stp goes through the whole chain (STEP import, orientation,
// toolpath, checks, .src) and the result must not change unless on purpose. The expected files
// are in tests/golden/; after an intended change regenerate them with `npx vitest run -u`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import occtimportjs from 'occt-import-js';
import { cadToModel, combineParts, pickPieces } from '../src/core/loaders';
import { analyzeOrientations } from '../src/core/orientation';
import { runBuild } from '../src/core/pipeline';
import { cellBodies, type CellPart } from '../src/core/collision';
import { DEFAULT_PRINT, DEFAULT_ROBOT, type PrintSettings } from '../src/core/settings';

const header = JSON.parse(readFileSync('public/cell.json', 'utf8')) as { parts: CellPart[] };
const cell = readFileSync('public/cell.bin');
const bodies = cellBodies(header.parts, cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength), [372.65, 0, 78.111]);

async function sella() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const occt = await (occtimportjs as any)();
  const model = cadToModel(occt, new Uint8Array(readFileSync('tests/data/sella.stp')), 'stp');
  const r = DEFAULT_ROBOT;
  const { parts } = pickPieces(model, { worldBase: [r.worldBaseX, r.worldBaseY, r.worldBaseZ], bedCenter: [r.bedCenterX, r.bedCenterY], bedSize: [r.bedSizeX, r.bedSizeY] });
  return combineParts(parts);
}

describe('reference part: sella.stp', async () => {
  const mesh = await sella();
  const orientations = analyzeOrientations(mesh, DEFAULT_PRINT.overhangAngle, DEFAULT_PRINT.layerHeight, DEFAULT_PRINT.thinWallMax);

  it('chooses the same orientation', () => {
    expect(orientations.map((o) => `${o.label.k} ${o.valid ? 'ok' : 'no'}`).slice(0, 4)).toMatchSnapshot();
  });

  for (const mode of ['planar', 'zigzag', 'surface'] as PrintSettings['mode'][])
    it(`${mode}: same path, same checks, same .src`, async () => {
      const r = runBuild(mesh, orientations[0].matrix, { ...DEFAULT_PRINT, mode }, DEFAULT_ROBOT, 'sella.stp', bodies);
      const tp = r.toolpath;
      expect({
        layers: tp.layerCount,
        points: tp.points.length,
        travels: tp.travels,
        printLength: Math.round(tp.printLength),
        min: r.min.map((v) => +v.toFixed(1)),
        max: r.max.map((v) => +v.toFixed(1)),
        unreachable: r.reach.unreachable,
        outOfLimits: r.reach.outOfLimits,
        collisions: r.collision?.count,
        ptp: r.collision?.ptp.length,
        support: r.support,
        errors: r.errors.map((e) => e.k),
        warnings: tp.warnings.map((w) => w.k),
      }).toMatchSnapshot();
      await expect(r.src).toMatchFileSnapshot(`golden/sella-${mode}.src`);
    });
});
