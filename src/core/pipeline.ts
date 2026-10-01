// End-to-end build used by the worker: orient → slice → toolpath → KUKA .src.
import { msg, SettingsError, type Msg } from '../i18n';
import { validateSettings } from './validate';
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
  /** Problems of the result that block the export (path below the plate). */
  errors: Msg[];
  /** The path leaves the work table: export needs an explicit confirmation. */
  offBed: boolean;
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
  // Parameters are checked before any geometry: an out-of-range value (e.g. thousands of passes)
  // must not start a computation that could take minutes or exhaust memory.
  const invalid = validateSettings(print, robot);
  if (invalid.length) throw new SettingsError(invalid);
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
  const errors: Msg[] = [];
  const bx0 = robot.bedCenterX - robot.bedSizeX / 2;
  const by0 = robot.bedCenterY - robot.bedSizeY / 2;
  const offBed = min[0] < bx0 || min[1] < by0 || max[0] > bx0 + robot.bedSizeX || max[1] > by0 + robot.bedSizeY;
  if (offBed) toolpath.warnings.push(msg('w.offBed', { sx: robot.bedSizeX, sy: robot.bedSizeY, cx: robot.bedCenterX, cy: robot.bedCenterY }));
  // The plate is fixed: a point below its top would drive the nozzle into it — never exportable.
  const below = toolpath.points.filter((p) => p.z + offset[2] < robot.bedTopZ - 1e-6).length;
  if (below) errors.push(msg('v.belowTable', { n: below, z: robot.bedTopZ, min: min[2].toFixed(1) }));

  const basePts = new Float64Array(toolpath.points.length * 3);
  toolpath.points.forEach((p, i) => basePts.set([p.x + offset[0], p.y + offset[1], p.z + offset[2]], i * 3));
  const cs = Float64Array.from(toolpath.points, (p) => p.c ?? NaN);
  const reach = reachReport(basePts, robot, cs);
  if (reach.unreachable)
    toolpath.warnings.push(msg('w.unreachable', { n: reach.unreachable }));
  if (reach.outOfLimits) toolpath.warnings.push(msg('w.limits', { n: reach.outOfLimits }));
  if (reach.jumps) toolpath.warnings.push(msg('w.jumps', { n: reach.jumps }));
  if (toolpath.tiltX) toolpath.warnings.push(msg('w.tiltX', { n: toolpath.tiltX }));
  return { toolpath, src, offset, mesh, min, max, reach, errors, offBed };
}
