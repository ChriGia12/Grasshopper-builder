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
