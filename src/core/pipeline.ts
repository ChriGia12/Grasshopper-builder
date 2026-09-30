// End-to-end build used by the worker: orient → slice → toolpath → KUKA .src.
import { writeKukaSrc } from './kuka';
import { applyMatrix, computeBounds, dropToOrigin, mulMat3, rotZ, type Mat3, type MeshData } from './mesh';
import type { PrintSettings, RobotSettings } from './settings';
import { reachReport, type ReachReport } from './robot';
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
  reach: ReachReport;
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
  const mesh = dropToOrigin(applyMatrix(original, mulMat3(rotZ(robot.rotationZ), matrix)));
  const offset = placementOffset(original, robot);
  const start: [number, number] | undefined =
    print.startMode === 'point' ? [print.startX - offset[0], print.startY - offset[1]] : undefined;
  const toolpath = buildToolpath(mesh, print, undefined, start);
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
  const bx0 = robot.bedCenterX - robot.bedSizeX / 2;
  const by0 = robot.bedCenterY - robot.bedSizeY / 2;
  if (min[0] < bx0 || min[1] < by0 || max[0] > bx0 + robot.bedSizeX || max[1] > by0 + robot.bedSizeY)
    toolpath.warnings.push(
      `Il percorso esce dal piano (${robot.bedSizeX}×${robot.bedSizeY} mm centrato in X ${robot.bedCenterX}, Y ${robot.bedCenterY}): sposta o ruota il pezzo.`,
    );
  if (min[2] < 0) toolpath.warnings.push('Alcuni punti hanno Z negativa nel sistema BASE: controlla la posizione.');

  const basePts = new Float64Array(toolpath.points.length * 3);
  toolpath.points.forEach((p, i) => basePts.set([p.x + offset[0], p.y + offset[1], p.z + offset[2]], i * 3));
  const cs = Float64Array.from(toolpath.points, (p) => p.c ?? NaN);
  const reach = reachReport(basePts, robot, cs);
  if (reach.unreachable)
    toolpath.warnings.push(`${reach.unreachable} punti fuori portata del robot con questo orientamento utensile: avvicina il pezzo al robot.`);
  if (reach.outOfLimits) toolpath.warnings.push(`${reach.outOfLimits} punti richiedono assi oltre i limiti del KR16.`);
  return { toolpath, src, offset, mesh, min, max, reach };
}
