// All user-tunable parameters. Robot defaults reproduce Tavolino1.src / CODICE PYTHON.txt.

export type PrintMode = 'auto' | 'spiral' | 'planar';

export interface PrintSettings {
  layerHeight: number; // mm
  walls: number; // number of concentric perimeters
  wallSpacing: number; // mm, bead width / distance between perimeters
  tolerance: number; // mm, max chord deviation from the exact contour
  maxSegment: number; // mm, split longer LINs (0 = off)
  mode: PrintMode;
  minContourLength: number; // mm, ignore smaller loops (noise)
  maxBridge: number; // mm, jumps shorter than this keep extruding (like Tavolino layer changes)
  travelLift: number; // mm, Z lift for travels with extruder off
  overhangAngle: number; // deg from vertical considered critical
  thinWallMax: number; // mm, hollow shells up to this thickness print as one mid-line (0 = off)
  /** 'auto': start at the front-left of the part; 'point': start at the contour point nearest (startX, startY) in BASE. */
  startMode: 'auto' | 'point';
  startX: number;
  startY: number;
}

export interface RobotSettings {
  programName: string;
  toolNumber: number;
  baseNumber: number;
  velCP: number; // m/s ($VEL.CP)
  advance: number;
  a: number;
  b: number;
  c: number;
  e1: number;
  e2: number;
  e3: number;
  e4: number;
  extruderAnout: number; // ON/OFF analog out
  extruderSpeedAnout: number; // speed analog out
  extruderSpeed: number; // 10 = 100%
  extruderDelay: number; // s
  useHoming: boolean;
  /**
   * 'file': keep the position the part has in the Rhino file (world) and convert to BASE by
   * subtracting worldBase — same as CODICE PYTHON.txt. 'origin': put the part's bbox
   * center/bottom at originX/Y/Z in the BASE frame.
   */
  placement: 'file' | 'origin';
  worldBaseX: number;
  worldBaseY: number;
  worldBaseZ: number;
  originX: number;
  originY: number;
  originZ: number;
  /** Rotation of the part around its vertical axis on the bed (deg). */
  rotationZ: number;
  bedSizeX: number;
  bedSizeY: number;
  /** Centre of the work table in BASE (the table stays put while the part moves). */
  bedCenterX: number;
  bedCenterY: number;
  safeAxes: [number, number, number, number, number, number];
  /** Controller BASE_DATA[baseNumber] {X,Y,Z,A,B,C}, relative to the robot root. */
  baseData: [number, number, number, number, number, number];
  /** Controller TOOL_DATA[toolNumber] {X,Y,Z,A,B,C}, relative to the flange. */
  toolData: [number, number, number, number, number, number];
  /** mm, max horizontal distance of the flange from axis A1 (KR16 R2010 ≈ 2010). */
  maxReach: number;
}

export const DEFAULT_PRINT: PrintSettings = {
  layerHeight: 1.5,
  walls: 1,
  wallSpacing: 6,
  tolerance: 0.2,
  maxSegment: 0,
  mode: 'auto',
  minContourLength: 10,
  maxBridge: 8,
  travelLift: 10,
  overhangAngle: 45,
  thinWallMax: 10,
  startMode: 'auto',
  startX: 0,
  startY: 0,
};

export const DEFAULT_ROBOT: RobotSettings = {
  programName: 'Pezzo1',
  toolNumber: 11,
  baseNumber: 1,
  velCP: 0.8,
  advance: 5,
  a: -180,
  b: 0,
  c: 180,
  e1: 0,
  e2: 0,
  e3: 0,
  e4: 0,
  extruderAnout: 7,
  extruderSpeedAnout: 6,
  extruderSpeed: 2,
  extruderDelay: 1,
  useHoming: true,
  placement: 'origin',
  worldBaseX: 1448,
  worldBaseY: -1000,
  worldBaseZ: 5,
  originX: 5,
  originY: 515,
  originZ: 37,
  rotationZ: 0,
  bedSizeX: 800,
  bedSizeY: 800,
  bedCenterX: 5,
  bedCenterY: 515,
  safeAxes: [0, -90, 90, 0, -1, 0],
  baseData: [0, 1000, 0, 0, 0, 0],
  toolData: [372.65, 0, 78.111, 0, 0, 0],
  maxReach: 2010,
};
