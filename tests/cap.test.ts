// Cutting a part in two: closed solids get a flat face on the cut, the volumes add up.
import { expect, it } from 'vitest';
import { isOpenMesh, meshStats, weld } from '../src/core/mesh';
import { cutPiece, splitPiece } from '../src/core/split';
import { box, lathe } from './fixtures';
it('cutting a closed solid in two keeps both pieces closed, volumes add up', () => {
  const h = weld(lathe([[40, 0], [10, 30], [40, 60]]));
  const full = meshStats(h).volume;
  for (const axis of [0, 1, 2] as const) {
    const parts = ([-1, 1] as const).map((side) => splitPiece(h, axis, axis === 2 ? 30 : 0, side));
    const vols = parts.map((m) => meshStats(m).volume);

    for (const m of parts) expect(isOpenMesh(m)).toBe(false);
    expect(vols[0] + vols[1]).toBeCloseTo(full, -2);
    for (const v of vols) expect(v).toBeGreaterThan(0);
  }
  const b = weld(box(40, 40, 40));
  for (const axis of [0, 1, 2] as const) for (const side of [-1, 1] as const) expect(meshStats(splitPiece(b, axis, 15, side)).volume).toBeCloseTo(side < 0 ? 40 * 40 * 15 : 40 * 40 * 25, 0);
});

it('an oblique cut: both pieces closed, volumes add up', () => {
  const b = weld(box(40, 40, 40));
  const k = 1 / Math.sqrt(3);
  const n: [number, number, number] = [k, k, k];
  const parts = [cutPiece(b, n, 30), cutPiece(b, [-k, -k, -k], -30)];
  for (const m of parts) expect(isOpenMesh(m)).toBe(false);
  expect(meshStats(parts[0]).volume + meshStats(parts[1]).volume).toBeCloseTo(64000, -1);
});
