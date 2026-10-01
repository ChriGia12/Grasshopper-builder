// Risk zones drawn on the part: overhangs, islands in mid-air, walls thinner than a bead.
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/core/pipeline';
import { IDENTITY, mergeMeshes, weld, type Mat3 } from '../src/core/mesh';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box } from './fixtures';

const I = [...IDENTITY] as Mat3;
const build = (parts: ReturnType<typeof box>[]) => runBuild(weld(mergeMeshes(parts)), I, { ...DEFAULT_PRINT, layerHeight: 2 }, DEFAULT_ROBOT, 't');

describe('risk zones', () => {
  it('a plain block has none', () => {
    const z = build([box(60, 60, 20)]).zones;
    expect([z.overhang.length, z.islands.length, z.thin.length]).toEqual([0, 0, 0]);
  });

  it('the underside of a cap over a stem overhangs', () => {
    const z = build([box(10, 10, 20, 20, 20, 0), box(50, 50, 6, 0, 0, 20)]).zones;
    expect(z.overhang.length).toBeGreaterThan(0);
  });

  it('a block starting in mid-air is an island', () => {
    const z = build([box(30, 30, 30), box(20, 20, 10, 60, 0, 15)]).zones;
    expect(z.islands.length).toBeGreaterThan(0);
  });

  it('a fin 3 mm thick (bead 6 mm) is a thin wall', () => {
    const z = build([box(40, 40, 10), box(3, 40, 10, 40, 0, 0)]).zones;
    expect(z.thin.length).toBeGreaterThan(0);
  });
});
