// All user-tunable parameters. Robot defaults reproduce Tavolino1.src / CODICE PYTHON.txt.

/**
 * planar: outline per layer, constant Z (Tavolino1) · spiral: outline with Z rising along the
 * turn (vase mode) · zigzag: solid layers filled in serpentine · surface: serpentine over the
 * top surface only, following its height (non-planar).
 */
export type PrintMode = 'planar' | 'spiral' | 'zigzag' | 'surface';

export interface PrintSettings {
  layerHeight: number; // mm
  firstLayerZ: number; // mm, nozzle height of the first layer above the table (Tavolino1: 0.5)
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
  fillAngle: number; // deg, direction of serpentine passes in plan
  fillAlternate: boolean; // turn passes 90° on every other layer / pass
  fillAutoAngle: boolean; // zigzag: per layer, the direction (0/45/90/135° from fillAngle) with fewest breaks
  fillPerimeter: boolean; // zigzag: print the outline (walls) before filling
  fillTopSurface: boolean; // zigzag: finish with layers that follow the top surface (non-planar)
  surfacePasses: number; // surface: how many layers stacked on the top surface
  surfaceMaxSlope: number; // surface: faces steeper than this (deg) are walls, not top
  surfaceTilt: boolean; // surface: tilt the tool with C following the surface normal
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
}

export const DEFAULT_PRINT: PrintSettings = {
  layerHeight: 1.5,
  firstLayerZ: 0.5,
  walls: 1,
  wallSpacing: 6,
  tolerance: 0.2,
  maxSegment: 0,
  mode: 'planar',
  minContourLength: 10,
  maxBridge: 8,
  travelLift: 10,
  overhangAngle: 45,
  thinWallMax: 10,
  fillAngle: 0,
  fillAlternate: true,
  fillAutoAngle: true,
  fillPerimeter: true,
  fillTopSurface: true,
  surfacePasses: 1,
  surfaceMaxSlope: 75,
  surfaceTilt: false,
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
  originZ: 38, // top of the work plate (lastra) in BASE
  rotationZ: 0,
  bedSizeX: 640,
  bedSizeY: 1350,
  bedCenterX: 0,
  bedCenterY: 450,
  safeAxes: [0, -90, 90, 0, -1, 0],
  // Robot at the Rhino world origin (point in BASE ROBOT.3dm, 32 mm below the table top), so
  // BASE_DATA equals the offset used by CODICE PYTHON.txt.
  baseData: [1448, -1000, 5, 0, 0, 0],
  toolData: [372.65, 0, 78.111, 0, 0, 0],
};
