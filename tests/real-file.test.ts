// Optional end-to-end check on a real Rhino file:
//   GB_SAMPLE_3DM="/path/file.3dm" GB_SAMPLE_LAYER="Livello 04" npx vitest run tests/real-file.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import rhino3dm from 'rhino3dm';
import { combineParts, parse3dm } from '../src/core/loaders';
import { analyzeOrientations } from '../src/core/orientation';
import { runBuild } from '../src/core/pipeline';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';

const file = process.env.GB_SAMPLE_3DM ?? '';
const layer = process.env.GB_SAMPLE_LAYER;

describe.skipIf(!file || !existsSync(file))('real .3dm file', () => {
  it('loads, orients and exports', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rhino = await (rhino3dm as any)();
    const model = parse3dm(rhino, new Uint8Array(readFileSync(file)));
    console.log('layers:', [...new Set(model.parts.map((p) => p.layer))].join(' | '));
    const parts = model.parts.filter((p) => !layer || p.layer === layer);
    // GB_SAMPLE_INDEX picks a single object of the layer (e.g. to skip duplicates).
    const idx = process.env.GB_SAMPLE_INDEX;
    const mesh = combineParts(idx === undefined ? parts : [parts[+idx]]);
    const cands = analyzeOrientations(mesh, DEFAULT_PRINT.overhangAngle, DEFAULT_PRINT.layerHeight, DEFAULT_PRINT.thinWallMax);
    for (const c of cands.slice(0, 4)) console.log(c.label, c.score.toFixed(3), c.notes.join('; '));
    for (const placement of ['file', 'origin'] as const) {
      const r = runBuild(mesh, cands[0].matrix, DEFAULT_PRINT, { ...DEFAULT_ROBOT, placement }, file);
      console.log(placement, r.toolpath.mode, r.toolpath.layerCount, r.toolpath.points.length, r.min.map(Math.round), r.max.map(Math.round), r.toolpath.warnings, r.reach);
      expect(r.src.startsWith('DEF ')).toBe(true);
      if (process.env.GB_OUT) writeFileSync(`${process.env.GB_OUT}/${placement}.src`, r.src);
    }
  });
});
