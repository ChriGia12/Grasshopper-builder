// Extracts the fixed robot cell from the Rhino file into public/cell.bin (+ cell.json):
//   - work table (tavole "Livello 03" + lastra) in the BASE frame
//   - KUKA KR16 R2010 links BASE, A1…A6 in the robot home frame (KUKA A2=-90, A3=+90)
//   - mandrino in the flange frame
// Meshes are simplified by vertex clustering so the site stays light.
// Usage: node scripts/build-cell.mjs "/path/BASE ROBOT.3dm"
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import rhino3dm from 'rhino3dm';

const WORLD_BASE = [1448, -1000, 5]; // BASE origin in Rhino world (CODICE PYTHON.txt)

const rhino = await rhino3dm();
const doc = rhino.File3dm.fromByteArray(new Uint8Array(readFileSync(process.argv[2])));
const objs = doc.objects();
const idefs = doc.instanceDefinitions();
const layers = [];
for (let i = 0; i < layers.length || i < doc.layers().count; i++) layers.push(doc.layers().get(i).fullPath);

function meshOf(g) {
  const out = [];
  const add = (m) => {
    if (!m) return;
    const j = m.toThreejsJSON();
    const d = j.data ?? j;
    const p = d.attributes.position.array;
    const idx = d.index ? d.index.array : [...Array(p.length / 3).keys()];
    out.push({ p: Float64Array.from(p), i: Uint32Array.from(idx) });
  };
  const t = g.constructor.name;
  if (t === 'Mesh') add(g);
  else if (t === 'Brep') { const f = g.faces(); for (let k = 0; k < f.count; k++) add(f.get(k).getMesh(rhino.MeshType.Any)); }
  else if (t === 'Extrusion') add(g.getMesh(rhino.MeshType.Any));
  return out;
}

/** Vertex clustering: snap to a grid of `cell` mm, drop collapsed and duplicate triangles. */
function simplify(parts, cell) {
  const map = new Map();
  const pos = [];
  const idx = [];
  const seen = new Set();
  for (const { p, i } of parts) {
    const remap = new Uint32Array(p.length / 3);
    for (let v = 0; v < p.length / 3; v++) {
      const key = `${Math.round(p[v * 3] / cell)},${Math.round(p[v * 3 + 1] / cell)},${Math.round(p[v * 3 + 2] / cell)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        pos.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
        map.set(key, id);
      }
      remap[v] = id;
    }
    for (let t = 0; t < i.length; t += 3) {
      const a = remap[i[t]], b = remap[i[t + 1]], c = remap[i[t + 2]];
      if (a === b || b === c || a === c) continue;
      const k = [a, b, c].sort((x, y) => x - y).join('_');
      if (seen.has(k)) continue;
      seen.add(k);
      idx.push(a, b, c);
    }
  }
  return { p: Float32Array.from(pos), i: Uint32Array.from(idx) };
}

const byName = (n) => { for (let k = 0; k < idefs.count; k++) if (idefs.get(k).name === n) return idefs.get(k); };
const defGeometry = (name) => byName(name).getObjectIds().flatMap((id) => {
  const g = objs.findId(id).geometry();
  const b = g.getBoundingBox();
  // skip bolts, labels and other tiny details
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  if (diag < 12) return [];
  // A3 carries a flat 1.5 m ring (cable guide drawing) that is not part of the arm
  if (diag > 1800) return [];
  return meshOf(g);
});

const out = [];
const push = (name, kind, color, mesh, extra = {}) => { out.push({ name, kind, color, ...extra, mesh }); console.log(name.padEnd(12), 'tris', mesh.i.length / 3); };

// Robot links (home frame).
const links = ['BASE', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
links.forEach((l, k) => push(l, 'link', l === 'BASE' || l === 'A6' ? '#3a3f45' : '#ff6a13', simplify(defGeometry(`KR16R2010_${l}_TUTTO`), 5), { link: k }));

// Top-level objects: mandrino (flange frame) and table (world → BASE).
const mandrino = [];
const table = [];
const plate = [];
for (let k = 0; k < objs.count; k++) {
  const o = objs.get(k);
  const a = o.attributes();
  if (a.isInstanceDefinitionObject) continue;
  const g = o.geometry();
  const layer = layers[a.layerIndex];
  if (layer === 'Mandrino') mandrino.push(...meshOf(g));
  else if (layer === 'Livello 03' && g.constructor.name === 'Brep') table.push(...meshOf(g));
  else if (g.constructor.name === 'Extrusion') plate.push(...meshOf(g));
}
const toBase = (parts) => parts.map(({ p, i }) => { const q = Float64Array.from(p); for (let v = 0; v < q.length; v += 3) { q[v] -= WORLD_BASE[0]; q[v + 1] -= WORLD_BASE[1]; q[v + 2] -= WORLD_BASE[2]; } return { p: q, i }; });
push('mandrino', 'tool', '#c9ced6', simplify(mandrino, 2));
push('tavole', 'static', '#8b6b4a', simplify(toBase(table), 5));
push('lastra', 'static', '#e8e4dc', simplify(toBase(plate), 2));

// Pack: JSON header + float/uint arrays.
mkdirSync('public', { recursive: true });
let offset = 0;
const chunks = [];
const header = out.map(({ mesh, ...rest }) => {
  const e = { ...rest, positions: [offset, mesh.p.length] };
  chunks.push(Buffer.from(mesh.p.buffer)); offset += mesh.p.byteLength;
  e.indices = [offset, mesh.i.length];
  chunks.push(Buffer.from(mesh.i.buffer)); offset += mesh.i.byteLength;
  return e;
});
writeFileSync('public/cell.bin', Buffer.concat(chunks));
writeFileSync('public/cell.json', JSON.stringify({ source: 'BASE ROBOT.3dm', worldBase: WORLD_BASE, parts: header }, null, 1));
console.log('cell.bin', (offset / 1e6).toFixed(2), 'MB');
