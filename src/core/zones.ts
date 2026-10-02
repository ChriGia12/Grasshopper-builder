// Risk zones shown on the part before printing: faces overhanging beyond the critical angle,
// islands that start in mid-air and walls thinner than one bead (they would not be printed).
import type { MeshData } from './mesh';
import { computeBounds, isOpenMesh } from './mesh';
import { pointInPolygon, signedArea } from './polyline';
import type { PrintSettings } from './settings';
import type { Contour, Layer } from './slicer';
import { differenceContours, offsetContours } from './walls';

export interface Zones {
  /** Indices of the triangles of the part that overhang beyond the critical angle. */
  overhang: Uint32Array;
  /** Outline of islands starting in mid-air, as line segments (x, y, z pairs, part frame). */
  islands: Float32Array;
  /** Outline of walls thinner than one bead, as line segments. */
  thin: Float32Array;
}

const MAX_SEGMENTS = 60000;

function pushLoops(out: number[], loops: Contour[], z: number) {
  for (const c of loops) {
    const p = c.pts;
    for (let i = 0; i < p.length && out.length < MAX_SEGMENTS * 6; i++) {
      const q = p[(i + 1) % p.length];
      if (!c.closed && i === p.length - 1) break;
      out.push(p[i][0], p[i][1], z, q[0], q[1], z);
    }
  }
}

/** True when a point lies on material of the region (even-odd over its closed loops). */
function onRegion(q: [number, number], region: Contour[]): boolean {
  let inside = false;
  for (const c of region) if (c.closed && pointInPolygon(q, c.pts)) inside = !inside;
  return inside;
}

/**
 * `layers`: the sliced layers of the part (null in surface mode: then only the overhangs).
 * Layer outlines are drawn at the layer's nozzle height.
 */
export function riskZones(mesh: MeshData, layers: Layer[] | null, s: PrintSettings): Zones {
  // Overhangs: same rule as the orientation analysis (faces resting on the table excluded).
  const p = mesh.positions;
  const ix = mesh.indices;
  const minZ = computeBounds(mesh).min[2];
  const limit = -Math.sin((s.overhangAngle * Math.PI) / 180);
  const shell = isOpenMesh(mesh); // one bead thick: flatter than the limit overhangs on both sides
  const over: number[] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const b = ix[t + 1] * 3;
    const c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    if (Math.max(p[a + 2], p[b + 2], p[c + 2]) <= minZ + s.layerHeight) continue;
    if (shell ? Math.abs(nz / len) > -limit : nz / len < limit) over.push(t / 3);
  }

  const islands: number[] = [];
  const thin: number[] = [];
  if (layers) {
    const w = s.wallSpacing;
    // Thin walls: what survives no inward offset of half a bead (opening) is narrower than a bead.
    // On very tall parts only some layers are examined, the outline still shows where the issue is.
    const every = Math.max(1, Math.ceil(layers.length / 300));
    let prev: Contour[] = [];
    layers.forEach((layer, i) => {
      const region = layer.contours.filter((c) => c.closed);
      if (i > 0) {
        const lone = region.filter((c) => c.depth % 2 === 0).filter((o) => {
          const stride = Math.max(1, Math.floor(o.pts.length / 24));
          return !o.pts.some((q, k) => k % stride === 0 && onRegion(q, prev));
        });
        pushLoops(islands, lone, layer.z);
      }
      if (i % every === 0 && region.length) {
        const opened = offsetContours(offsetContours(region, -w / 2 + 0.05), w / 2 - 0.05);
        const narrow = differenceContours(region, opened).filter((c) => Math.abs(signedArea(c.pts)) > (w * w) / 2);
        pushLoops(thin, narrow, layer.z);
      }
      if (region.length) prev = region;
    });
  }
  return { overhang: Uint32Array.from(over), islands: Float32Array.from(islands), thin: Float32Array.from(thin) };
}
