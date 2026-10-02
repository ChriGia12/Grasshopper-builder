// Range checks on every parameter that ends up in the KRL program or drives the toolpath.
// Anything outside its admitted range blocks the export: the .src must never carry it.
import { msg, type Msg } from '../i18n';
import { KR16 } from './robot';
import type { PrintSettings, RobotSettings } from './settings';

interface Rule {
  min: number;
  max: number;
  int?: boolean;
}

/** Admitted ranges (mm, deg, s, m/s). */
export const PRINT_RULES: Partial<Record<keyof PrintSettings, Rule>> = {
  layerHeight: { min: 0.1, max: 20 },
  maxTilt: { min: 0, max: 60 },
  layerRamp: { min: 0, max: 500 },
  baseCut: { min: 0, max: 2000 },
  firstLayerZ: { min: 0, max: 20 },
  walls: { min: 1, max: 20, int: true },
  wallSpacing: { min: 0.5, max: 50 },
  tolerance: { min: 0, max: 5 },
  maxSegment: { min: 0, max: 1000 },
  minContourLength: { min: 0, max: 1000 },
  maxBridge: { min: 0, max: 200 },
  travelLift: { min: 0, max: 200 },
  overhangAngle: { min: 1, max: 89 },
  thinWallMax: { min: 0, max: 100 },
  fillAngle: { min: -360, max: 360 },
  surfacePasses: { min: 1, max: 50, int: true },
  surfaceMaxSlope: { min: 1, max: 89 },
};

export const ROBOT_RULES: Partial<Record<keyof RobotSettings, Rule>> = {
  velCP: { min: 0.001, max: 2 },
  advance: { min: 0, max: 5, int: true },
  a: { min: -360, max: 360 },
  b: { min: -360, max: 360 },
  c: { min: -360, max: 360 },
  extruderAnout: { min: 1, max: 32, int: true },
  extruderSpeedAnout: { min: 1, max: 32, int: true },
  extruderSpeed: { min: 0, max: 10 },
  extruderDelay: { min: 0, max: 60 },
  originX: { min: -5000, max: 5000 },
  originY: { min: -5000, max: 5000 },
  originZ: { min: -1000, max: 2000 },
  rotationZ: { min: -360, max: 360 },
};

/**
 * The simulation and the reach check know only these controller frames and no external axes:
 * any other value would put references in the .src that were never verified.
 */
export const FIXED_ROBOT = { baseNumber: 1, toolNumber: 11, e1: 0, e2: 0, e3: 0, e4: 0 } as const;

function check<T>(obj: T, rules: Partial<Record<keyof T, Rule>>, out: Msg[]) {
  for (const [key, r] of Object.entries(rules) as [string, Rule][]) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min || v > r.max || (r.int && !Number.isInteger(v)))
      out.push(msg(r.int ? 'v.rangeInt' : 'v.range', { field: `f.${key}`, v: String(v), min: r.min, max: r.max }));
  }
}

/** Every problem with the parameters; an empty list means the program can be written. */
export function validateSettings(print: PrintSettings, robot: RobotSettings): Msg[] {
  const out: Msg[] = [];
  check(print, PRINT_RULES, out);
  check(robot, ROBOT_RULES, out);
  for (const [k, v] of Object.entries(FIXED_ROBOT) as [keyof typeof FIXED_ROBOT, number][])
    if (robot[k] !== v) out.push(msg('v.fixed', { field: `f.${k}`, v: String(robot[k]), fixed: v }));
  // 0 = off; a tiny split length would turn every contour into millions of LIN points.
  if (print.maxSegment > 0 && print.maxSegment < 1)
    out.push(msg('v.range', { field: 'f.maxSegment', v: String(print.maxSegment), min: 1, max: PRINT_RULES.maxSegment!.max }));
  if (robot.extruderAnout === robot.extruderSpeedAnout) out.push(msg('v.sameAnout'));
  if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(robot.programName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_')))
    out.push(msg('v.programName'));
  // Safe position and homing pose (A3 = 0) are PTP targets: they must be inside the axis limits.
  const [a1, a2, , a4, a5, a6] = robot.safeAxes;
  const poses: [string, number[]][] = [
    ['v.safe', robot.safeAxes],
    ['v.home', [a1, a2, 0, a4, a5, a6]],
  ];
  for (const [k, q] of poses)
    q.forEach((v, i) => {
      const [lo, hi] = KR16.limits[i];
      if (!Number.isFinite(v) || v < lo || v > hi) out.push(msg(k, { axis: `A${i + 1}`, v: String(v), lo, hi }));
    });
  return out;
}
