// File importers → parts in mm, Z up. Mesh formats via three.js loaders; Rhino .3dm via
// rhino3dm (meshes + cached render meshes of Breps/Extrusions); STEP/IGES/BREP via OpenCascade.
// Every object keeps its layer so the user can pick the piece out of a whole robot-cell scene.
import { BufferGeometry, Mesh as ThreeMesh, type Object3D } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { computeBounds, mergeMeshes, orientOutward, weld, type MeshData } from './mesh';

export const RHINO3DM_URL = 'https://cdn.jsdelivr.net/npm/rhino3dm@8.35.0/rhino3dm.module.min.js';
export const OCCT_URL = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js';

export const ACCEPTED = '.stl,.obj,.ply,.3dm,.step,.stp,.iges,.igs,.brep';

export interface ModelPart {
  id: number;
  layer: string;
  name: string;
  type: string;
  visible: boolean;
  mesh: MeshData;
}

export interface LoadedModel {
  format: string;
  parts: ModelPart[];
  notes: string[];
}

function fromGeometry(g: BufferGeometry): MeshData {
  const pos = g.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);
  }
  const index = g.getIndex();
  const indices = index ? new Uint32Array(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { positions, indices };
}

function fromObject3D(root: Object3D): ModelPart[] {
  root.updateMatrixWorld(true);
  const parts: ModelPart[] = [];
  root.traverse((o) => {
    if ((o as ThreeMesh).isMesh) {
      const g = (o as ThreeMesh).geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      parts.push({ id: parts.length, layer: o.name || 'Oggetto', name: o.name, type: 'Mesh', visible: true, mesh: fromGeometry(g) });
    }
  });
  return parts;
}

// ---------- Rhino .3dm ----------

// rhino3dm is loaded at runtime from the CDN, so it is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let rhinoPromise: Promise<Any> | null = null;
export function loadRhino(): Promise<Any> {
  rhinoPromise ??= import(/* @vite-ignore */ RHINO3DM_URL).then((m) => m.default());
  return rhinoPromise;
}

const UNIT_TO_MM: Record<string, number> = {
  Millimeters: 1,
  Centimeters: 10,
  Meters: 1000,
  Inches: 25.4,
  Feet: 304.8,
};

function rhinoMeshToData(m: Any): MeshData | null {
  if (!m) return null;
  const json: Any = m.toThreejsJSON();
  const data = json.data ?? json;
  const pos = data.attributes?.position?.array;
  if (!pos?.length) return null;
  const positions = Float32Array.from(pos);
  const idx = data.index?.array;
  const indices = idx ? Uint32Array.from(idx) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { positions, indices };
}

export function parse3dm(rhino: Any, bytes: Uint8Array): LoadedModel {
  const doc = rhino.File3dm.fromByteArray(bytes);
  if (!doc) throw new Error('File .3dm non leggibile.');
  const notes: string[] = [];
  const unit = doc.settings().modelUnitSystem;
  let unitScale = 1;
  for (const [k, v] of Object.entries(UNIT_TO_MM)) if (rhino.UnitSystem[k] === unit) unitScale = v;

  const layerTable = doc.layers();
  const layers: { path: string; visible: boolean }[] = [];
  for (let i = 0; i < layerTable.count; i++) {
    const l = layerTable.get(i);
    layers.push({ path: l.fullPath ?? l.name, visible: l.visible !== false });
  }

  const parts: ModelPart[] = [];
  let skipped = 0;
  let blocks = 0;
  let brepsNoMesh = 0;
  const objects = doc.objects();
  for (let i = 0; i < objects.count; i++) {
    const obj = objects.get(i);
    const g = obj.geometry();
    const attr = obj.attributes();
    const type = g.objectType;
    const meshes: MeshData[] = [];
    let typeName = '';
    if (type === rhino.ObjectType.Mesh) {
      typeName = 'Mesh';
      const d = rhinoMeshToData(g);
      if (d) meshes.push(d);
    } else if (type === rhino.ObjectType.Brep) {
      typeName = 'Polisuperficie';
      const faces = g.faces();
      for (let f = 0; f < faces.count; f++) {
        const d = rhinoMeshToData(faces.get(f).getMesh(rhino.MeshType.Any));
        if (d) meshes.push(d);
      }
      if (!meshes.length) brepsNoMesh++;
    } else if (type === rhino.ObjectType.Extrusion) {
      typeName = 'Estrusione';
      const d = rhinoMeshToData(g.getMesh(rhino.MeshType.Any));
      if (d) meshes.push(d);
      else brepsNoMesh++;
    } else if (type === rhino.ObjectType.SubD) {
      typeName = 'SubD (rete controllo)';
      const d = rhinoMeshToData(rhino.Mesh.createFromSubDControlNet?.(g));
      if (d) meshes.push(d);
    } else if (type === rhino.ObjectType.InstanceReference) {
      blocks++;
      continue;
    } else {
      skipped++;
      continue;
    }
    if (!meshes.length) continue;
    const mesh = mergeMeshes(meshes);
    if (unitScale !== 1) for (let k = 0; k < mesh.positions.length; k++) mesh.positions[k] *= unitScale;
    const layer = layers[attr.layerIndex] ?? { path: 'Senza layer', visible: true };
    parts.push({
      id: parts.length,
      layer: layer.path,
      name: attr.name || '',
      type: typeName,
      visible: layer.visible && attr.visible !== false,
      mesh,
    });
  }
  if (brepsNoMesh)
    notes.push(
      `${brepsNoMesh} polisuperfici senza mesh di render salvata: in Rhino passa in vista ombreggiata e salva (non "Salva piccolo"), oppure esporta STEP/STL.`,
    );
  if (blocks) notes.push(`${blocks} blocchi (istanze) ignorati: esplodili in Rhino se contengono il pezzo.`);
  if (skipped) notes.push(`${skipped} oggetti non solidi ignorati (curve, punti, quote...).`);
  if (unitScale !== 1) notes.push(`Unità del file convertite in mm (×${unitScale}).`);
  if (!parts.length) throw new Error('Nessuna geometria stampabile nel .3dm. ' + notes.join(' '));
  return { format: '3DM', parts, notes };
}

// ---------- STEP / IGES / BREP ----------

let occtPromise: Promise<Any> | null = null;
function loadOcct(): Promise<Any> {
  occtPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = OCCT_URL;
    s.onload = () =>
      (window as Any).occtimportjs({ locateFile: (f: string) => OCCT_URL.replace(/[^/]+$/, f) }).then(resolve, reject);
    s.onerror = () => reject(new Error('Impossibile caricare OpenCascade (serve connessione internet).'));
    document.head.appendChild(s);
  });
  return occtPromise;
}

async function parseCad(bytes: Uint8Array, ext: string): Promise<LoadedModel> {
  const occt = await loadOcct();
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.1, angularDeflection: 0.2 };
  const res =
    ext === 'brep'
      ? occt.ReadBrepFile(bytes, params)
      : ext === 'iges' || ext === 'igs'
        ? occt.ReadIgesFile(bytes, params)
        : occt.ReadStepFile(bytes, params);
  if (!res.success || !res.meshes.length) throw new Error('OpenCascade non è riuscito a leggere il file.');
  const parts: ModelPart[] = res.meshes.map((m: Any, i: number) => ({
    id: i,
    layer: m.name || `Solido ${i + 1}`,
    name: m.name || '',
    type: 'BREP',
    visible: true,
    mesh: { positions: Float32Array.from(m.attributes.position.array), indices: Uint32Array.from(m.index.array) },
  }));
  return { format: ext.toUpperCase(), parts, notes: ['BREP tassellato con tolleranza 0.1 mm.'] };
}

// ---------- entry points ----------

export async function loadModel(file: File): Promise<LoadedModel> {
  const ext = file.name.split('.').pop()!.toLowerCase();
  const buf = await file.arrayBuffer();
  const single = (mesh: MeshData, format: string, notes: string[]): LoadedModel => ({
    format,
    notes,
    parts: [{ id: 0, layer: file.name, name: file.name, type: 'Mesh', visible: true, mesh }],
  });
  switch (ext) {
    case 'stl':
      return single(fromGeometry(new STLLoader().parse(buf)), 'STL', ['STL senza unità: assunto in mm.']);
    case 'ply':
      return single(fromGeometry(new PLYLoader().parse(buf)), 'PLY', []);
    case 'obj':
      return { format: 'OBJ', parts: fromObject3D(new OBJLoader().parse(new TextDecoder().decode(buf))), notes: ['OBJ senza unità: assunto in mm.'] };
    case '3dm':
      return parse3dm(await loadRhino(), new Uint8Array(buf));
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
      return parseCad(new Uint8Array(buf), ext);
    default:
      throw new Error(`Formato .${ext} non supportato. Usa: ${ACCEPTED}`);
  }
}

/** Merge the chosen parts into one clean, welded, outward-facing mesh. */
export function combineParts(parts: ModelPart[]): MeshData {
  if (!parts.length) throw new Error('Seleziona almeno un oggetto.');
  const mesh = orientOutward(weld(mergeMeshes(parts.map((p) => p.mesh)), 1e-3));
  if (!mesh.indices.length) throw new Error('Gli oggetti selezionati non contengono triangoli.');
  return mesh;
}

export function partSize(p: ModelPart): [number, number, number] {
  const b = computeBounds(p.mesh);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

const TYPE_PRIORITY: Record<string, number> = { Mesh: 0, Polisuperficie: 1, BREP: 1, Estrusione: 2, 'SubD (rete controllo)': 3 };

export interface CellRegion {
  /** BASE origin in world coordinates (worldBaseX/Y/Z). */
  worldBase: [number, number, number];
  bedCenter: [number, number];
  bedSize: [number, number];
}

type Box = ReturnType<typeof computeBounds>;
const CELL_LAYER = /base di lavorazione|robot|kuka|mandrino|dima|cella/i;
const volume = (b: Box) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);

/** One object per group of objects occupying the same box (same piece saved as mesh, BREP, SubD…), preferring meshes. */
function dedupe(items: { p: ModelPart; b: Box }[]): { parts: ModelPart[]; b: Box }[] {
  const groups: { b: Box; items: ModelPart[] }[] = [];
  for (const { p, b } of items) {
    const tol = 0.05 * Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const g = groups.find((g) => [0, 1, 2].every((k) => Math.abs(g.b.min[k] - b.min[k]) <= tol && Math.abs(g.b.max[k] - b.max[k]) <= tol));
    if (g) g.items.push(p);
    else groups.push({ b, items: [p] });
  }
  return groups.map((g) => ({
    b: g.b,
    parts: [g.items.sort((a, c) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[c.type] ?? 9) || c.mesh.indices.length - a.mesh.indices.length)[0]],
  }));
}

/**
 * The robot cell is fixed, so a Rhino file may be the whole scene (robot, table, fixtures…).
 * The piece is what stands on the work table: keep objects whose box lies inside the table
 * area (world → BASE) and rests near its surface; drop duplicates and small leftovers.
 * Files with a few objects (a piece or a set of pieces) are taken as they are.
 */
export function pickPieces(model: LoadedModel, cell: CellRegion): { parts: ModelPart[]; note: string | null } {
  // A file with a few objects is the piece itself (e.g. a BREP split in solids): merge them all.
  if (model.parts.length <= 5) {
    const g = dedupe(model.parts.map((p) => ({ p, b: computeBounds(p.mesh) })));
    return { parts: g.flatMap((x) => x.parts), note: null };
  }
  const [wx, wy, wz] = cell.worldBase;
  const margin = 0.1;
  const x0 = cell.bedCenter[0] - (cell.bedSize[0] / 2) * (1 + margin) + wx;
  const x1 = cell.bedCenter[0] + (cell.bedSize[0] / 2) * (1 + margin) + wx;
  const y0 = cell.bedCenter[1] - (cell.bedSize[1] / 2) * (1 + margin) + wy;
  const y1 = cell.bedCenter[1] + (cell.bedSize[1] / 2) * (1 + margin) + wy;
  const onTable = model.parts
    .map((p) => ({ p, b: computeBounds(p.mesh) }))
    .filter(({ b }) => b.min[0] >= x0 && b.max[0] <= x1 && b.min[1] >= y0 && b.max[1] <= y1 && b.min[2] >= wz - 20 && b.min[2] <= wz + 150);
  let groups = dedupe(onTable.filter(({ p }) => !CELL_LAYER.test(p.layer)));
  // A fixture or old table model has the piece standing inside its bounding box: drop it.
  const inside = (i: Box, o: Box) => [0, 1, 2].every((k) => i.min[k] >= o.min[k] - 1 && i.max[k] <= o.max[k] + 1);
  groups = groups.filter((g) => !groups.some((o) => o !== g && inside(o.b, g.b))).sort((a, b) => volume(b.b) - volume(a.b));
  if (!groups.length)
    return {
      parts: [],
      note: `Il file contiene ${model.parts.length} oggetti ma nessuno sul piano di lavoro: esporta da Rhino solo il pezzo (Esporta selezionati) e ricaricalo.`,
    };
  // One piece only: the biggest object standing on the table.
  const parts = groups[0].parts;
  const names = parts.map((p) => `${p.type}${p.name ? ' ' + p.name : ''} (layer "${p.layer}")`).join(', ');
  return { parts, note: `Scena Rhino con ${model.parts.length} oggetti: usato solo ciò che sta sul piano → ${names}.` };
}
