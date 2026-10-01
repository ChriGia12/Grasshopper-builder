// Heavy geometry runs here so the page stays responsive on million-triangle models.
import { analyzeOrientations } from './core/orientation';
import { runBuild } from './core/pipeline';
import { MsgError, SettingsError } from './i18n';
import type { Mat3, MeshData } from './core/mesh';
import type { PrintSettings, RobotSettings } from './core/settings';
import type { Body } from './core/collision';
import type { PartBox } from './core/parts';

export type WorkerRequest =
  | { type: 'ping'; id: number }
  | { type: 'analyze'; id: number; mesh: MeshData; print: PrintSettings }
  | { type: 'build'; id: number; mesh: MeshData; matrix: Mat3; print: PrintSettings; robot: RobotSettings; sourceName: string; bodies?: Body[]; partBoxes?: PartBox[] };

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'ping') {
      self.postMessage({ type: 'pong', id: req.id });
    } else if (req.type === 'analyze') {
      const orientations = analyzeOrientations(req.mesh, req.print.overhangAngle, req.print.layerHeight, req.print.thinWallMax);
      self.postMessage({ type: 'analyze', id: req.id, orientations });
    } else {
      const r = runBuild(req.mesh, req.matrix, req.print, req.robot, req.sourceName, req.bodies, req.partBoxes);
      // Flatten the path into typed arrays for a cheap transfer to the viewer.
      const pts = r.toolpath.points;
      const xyz = new Float32Array(pts.length * 3);
      const ext = new Uint8Array(pts.length);
      const cc = Float32Array.from(pts, (p) => p.c ?? NaN); // per-point tool tilt (surface mode)
      const ptp = Uint8Array.from(pts, (p) => (p.ptp ? 1 : 0)); // moves between parts
      pts.forEach((p, i) => {
        xyz[i * 3] = p.x;
        xyz[i * 3 + 1] = p.y;
        xyz[i * 3 + 2] = p.z;
        ext[i] = p.e ? 1 : 0;
      });
      const meta = { ...r.toolpath, points: [] };
      self.postMessage(
        { type: 'build', id: req.id, xyz, ext, cc, ptp, meta, src: r.src, offset: r.offset, mesh: r.mesh, min: r.min, max: r.max, reach: r.reach, errors: r.errors, offBed: r.offBed, support: r.support, zones: r.zones, collision: r.collision },
        { transfer: [xyz.buffer, ext.buffer, cc.buffer, ptp.buffer] },
      );
    }
  } catch (e) {
    // Translatable core errors travel as a message key; others as plain text.
    self.postMessage({
      type: 'error',
      id: req.id,
      message: e instanceof Error ? e.message : String(e),
      msg: e instanceof MsgError ? e.m : undefined,
      errors: e instanceof SettingsError ? e.errors : undefined,
    });
  }
};
