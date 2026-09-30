// End-to-end build used by the worker: orient → slice → toolpath → KUKA .src.
import { writeKukaSrc } from './kuka';
import { applyMatrix, computeBounds, dropToOrigin, type Mat3, type MeshData } from './mesh';
import type { PrintSettings, RobotSettings } from './settings';
import { buildToolpath, type Toolpath } from './toolpath';

export interface BuildResult {
  toolpath: Toolpath;
  src: string;
  /** Translation from the local (centered, z=0) frame to the robot BASE frame. */
  offset: [number, number, number];
  /** Oriented mesh in local frame, for the viewer. */
  mesh: MeshData;
  /** Toolpath extents in the BASE frame. */
  min: [number, number, number];
  max: [number, number, number];
}

/** Where the local part frame lands in BASE coordinates. */
export function placementOffset(original: MeshData, r: RobotSettings): [number, number, number] {
  if (r.placement === 'origin') return [r.originX, r.originY, r.originZ];
  // Keep the Rhino world position (bbox center XY, bottom Z) and convert world → BASE.
  const b = computeBounds(original);
  return [
    (b.min[0] + b.max[0]) / 2 - r.worldBaseX,
    (b.min[1] + b.max[1]) / 2 - r.worldBaseY,
    b.min[2] - r.worldBaseZ,
  ];
}

export function runBuild(
  original: MeshData,
  matrix: Mat3,
  print: PrintSettings,
  robot: RobotSettings,
  sourceName: string,
): BuildResult {
  const mesh = dropToOrigin(applyMatrix(original, matrix));
  const toolpath = buildToolpath(mesh, print);
  const offset = placementOffset(original, robot);
  const placed: RobotSettings = { ...robot, originX: offset[0], originY: offset[1], originZ: offset[2] };
  const src = writeKukaSrc(toolpath, placed, { sourceName, layerHeight: print.layerHeight });

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of toolpath.points) {
    const v = [p.x + offset[0], p.y + offset[1], p.z + offset[2]];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[k]);
      max[k] = Math.max(max[k], v[k]);
    }
  }
  const b = computeBounds(mesh);
  const sx = b.max[0] - b.min[0];
  const sy = b.max[1] - b.min[1];
  if (sx > robot.bedSizeX || sy > robot.bedSizeY)
    toolpath.warnings.push(`Il pezzo (${sx.toFixed(0)}×${sy.toFixed(0)} mm) è più grande del piano (${robot.bedSizeX}×${robot.bedSizeY} mm).`);
  if (min[2] < 0) toolpath.warnings.push('Alcuni punti hanno Z negativa nel sistema BASE: controlla la posizione.');
  return { toolpath, src, offset, mesh, min, max };
}
