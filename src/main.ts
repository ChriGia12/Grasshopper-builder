import './style.css';
import { ACCEPTED, combineParts, loadModel, pickPieces, type CellRegion } from './core/loaders';
import { sanitizeProgramName } from './core/kuka';
import { IDENTITY, dropToOrigin, meshStats, mulMat3, rotX, rotY, rotZ, type Mat3, type MeshData } from './core/mesh';
import type { OrientationCandidate } from './core/orientation';
import { placementOffset } from './core/pipeline';
import { KR16, linkTransforms, poseAt, robotRootFrame, type Joints, type ReachReport } from './core/robot';
import { DEFAULT_PRINT, DEFAULT_ROBOT, type PrintSettings, type RobotSettings } from './core/settings';
import type { Toolpath } from './core/toolpath';
import { Viewer } from './viewer';
import type { WorkerRequest } from './worker';

// ---------- state ----------

const load = <T,>(key: string, def: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...structuredClone(def), ...JSON.parse(raw) } : structuredClone(def);
  } catch {
    return structuredClone(def);
  }
};
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
};

const print: PrintSettings = load('gb.print', DEFAULT_PRINT);
if ((print.mode as string) === 'auto') print.mode = 'planar'; // old saved setting
const robot: RobotSettings = load('gb.robot', DEFAULT_ROBOT);
// The cell is fixed (robot, table, controller frames): never take these from old saved settings.
const CELL_KEYS = ['worldBaseX', 'worldBaseY', 'worldBaseZ', 'bedSizeX', 'bedSizeY', 'bedCenterX', 'bedCenterY', 'baseData', 'toolData'] as const;
for (const k of CELL_KEYS) (robot as unknown as Record<string, unknown>)[k] = structuredClone(DEFAULT_ROBOT[k]);
try {
  if (localStorage.getItem('gb.cellVersion') !== '2') {
    robot.originZ = DEFAULT_ROBOT.originZ; // table top moved from a guess (37) to the measured plate (38)
    localStorage.setItem('gb.cellVersion', '2');
  }
} catch {
  /* storage unavailable: defaults already apply */
}

let sourceName = '';
let mesh: MeshData | null = null;
let orientations: OrientationCandidate[] = [];
let orientIdx = 0;
let manual: Mat3 = [...IDENTITY] as Mat3;
let lastSrc = '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const li = (text: string, className = '') => Object.assign(document.createElement('li'), { textContent: text, className });
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const viewer = new Viewer($('viewport'));

// ---------- workers (restarted when a newer request supersedes a running one) ----------

const makeWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pools: Record<'analyze' | 'build', { worker: Worker; busy: boolean }> = {
  analyze: { worker: makeWorker(), busy: false },
  build: { worker: makeWorker(), busy: false },
};
let reqId = 0;

class Superseded extends Error {}

const cancelers: Record<'analyze' | 'build', (() => void) | null> = { analyze: null, build: null };

type RequestBody = WorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

function run<T>(kind: 'analyze' | 'build', req: RequestBody): Promise<T> {
  const pool = pools[kind];
  if (pool.busy) {
    pool.worker.terminate();
    pool.worker = makeWorker();
    cancelers[kind]?.();
  }
  pool.busy = true;
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    cancelers[kind] = () => reject(new Superseded());
    pool.worker.onmessage = (ev) => {
      if (ev.data.id !== id) return;
      pool.busy = false;
      cancelers[kind] = null;
      if (ev.data.type === 'error') reject(new Error(ev.data.message));
      else resolve(ev.data as T);
    };
    pool.worker.onerror = (e) => {
      pool.busy = false;
      cancelers[kind] = null;
      reject(new Error(e.message || 'Errore nel worker'));
    };
    pool.worker.postMessage({ ...req, id });
  });
}

let busyCount = 0;
async function busy<T>(text: string, fn: () => Promise<T>): Promise<T> {
  busyCount++;
  $('busyText').textContent = text;
  $('busy').hidden = false;
  try {
    return await fn();
  } finally {
    if (--busyCount === 0) $('busy').hidden = true;
  }
}

// ---------- step 1: the piece ----------
// Robot, table and mandrino are fixed in the cell; the user only brings one piece
// (a mesh or a BREP). A new file replaces the previous one. A whole Rhino scene is
// reduced to the object standing on the work table.

let pieceFormat = '';
let pieceNotes: string[] = [];

const fileInput = $<HTMLInputElement>('file');
fileInput.accept = ACCEPTED;
const drop = $('drop');
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) openFile(fileInput.files[0]);
  fileInput.value = '';
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) openFile(f);
});

function setNotes(notes: string[], error?: string) {
  $('modelNotes').replaceChildren(...notes.map((n) => li(n)), ...(error ? [li(error, 'error')] : []));
}

async function openFile(file: File) {
  const cell: CellRegion = {
    worldBase: [robot.worldBaseX, robot.worldBaseY, robot.worldBaseZ],
    bedCenter: [robot.bedCenterX, robot.bedCenterY],
    bedSize: [robot.bedSizeX, robot.bedSizeY],
  };
  let piece: MeshData;
  const notes: string[] = [];
  try {
    const model = await busy(`Lettura ${file.name}…`, () => loadModel(file));
    const { parts, note } = pickPieces(model, cell);
    if (note) notes.push(note);
    if (!parts.length) throw new Error(note ?? 'Nessun oggetto stampabile nel file.');
    piece = combineParts(parts);
    notes.push(...model.notes.filter((n) => !/ignorati/.test(n)));
    pieceFormat = model.format;
  } catch (e) {
    setNotes(notes, e instanceof Error ? e.message : String(e));
    return;
  }
  pieceNotes = notes;
  sourceName = file.name;
  robot.programName = sanitizeProgramName(file.name);
  save('gb.robot', robot);
  renderRobotFields();
  mesh = piece;
  $('pieceName').textContent = file.name;
  $('pieceName').hidden = false;
  setNotes(pieceNotes);
  showModelInfo(mesh);
  $('empty').hidden = true;
  lastSrc = '';
  viewer.setToolpath(null, null, [], [0, 0, 0]);
  const off = placementOffset(mesh, robot);
  viewer.setModel(dropToOrigin(mesh), off, 1);
  viewer.setBed(robot.bedSizeX, robot.bedSizeY, [robot.bedCenterX, robot.bedCenterY, off[2]]);
  viewer.fit();
  await analyze();
}

function showModelInfo(m: MeshData) {
  const s = meshStats(m);
  const rows: [string, string][] = [
    ['Formato', pieceFormat],
    ['Triangoli', s.triangles.toLocaleString('it-IT')],
    ['Dimensioni', `${s.size.map((v) => v.toFixed(1)).join(' × ')} mm`],
    ['Chiusa', s.openEdges ? `no — ${s.openEdges} bordi aperti` : 'sì (watertight)'],
    ['Volume', s.openEdges ? '—' : `${(s.volume / 1e6).toFixed(2)} L`],
  ];
  const dl = document.createElement('dl');
  dl.className = 'info';
  for (const [k, v] of rows)
    dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
  $('modelInfo').hidden = false;
  $('modelInfo').replaceChildren(dl);
}

// ---------- step 2: orientation ----------

async function analyze() {
  if (!mesh) return;
  const m = mesh;
  try {
    const res = await busy('Analisi orientamenti…', () =>
      run<{ orientations: OrientationCandidate[] }>('analyze', { type: 'analyze', mesh: m, print: { ...print } }),
    );
    if (m !== mesh) return;
    orientations = res.orientations;
  } catch (e) {
    if (!(e instanceof Superseded) && m === mesh) setNotes(pieceNotes, e instanceof Error ? e.message : String(e));
    return;
  }
  orientIdx = 0;
  manual = [...IDENTITY] as Mat3;
  fitNext = true;
  for (const id of ['step-orient', 'step-print', 'step-robot', 'step-out']) $(id).hidden = false;
  renderOrientations();
  return build();
}

function renderOrientations() {
  $('orientList').replaceChildren(
    ...orientations.map((o, i) => {
      const item = document.createElement('li');
      if (i === orientIdx) item.className = 'sel';
      const facts = [
        `h ${o.height.toFixed(0)} mm`,
        `appoggio ${(o.baseArea / 100).toFixed(0)} cm²`,
        `sbalzi ${(o.overhangRatio * 100).toFixed(1)}%`,
        o.maxIslands > 1 ? `${o.maxIslands} isole` : '1 contorno',
      ].join(' · ');
      item.innerHTML =
        `<span class="title">${escapeHtml(o.label)}</span>` +
        (i === 0 ? '<span class="badge">Migliore</span>' : `<span class="muted">#${i + 1}</span>`) +
        `<span class="sub">${facts}${o.notes.length ? '<br>' + o.notes.map(escapeHtml).join(' · ') : ''}</span>`;
      item.onclick = () => {
        orientIdx = i;
        manual = [...IDENTITY] as Mat3;
        renderOrientations();
        build();
      };
      return item;
    }),
  );
}

document.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => {
  b.onclick = () => {
    const r = { x: rotX, y: rotY, z: rotZ }[b.dataset.rot as 'x' | 'y' | 'z'](90);
    manual = mulMat3(r, manual);
    build();
  };
});

// ---------- steps 3/4: settings forms ----------

type Field =
  | { group: string }
  | { key: string; label: string; kind: 'number' | 'text' | 'select' | 'check'; step?: number; min?: number; options?: [string, string][]; full?: boolean };

const PRINT_FIELDS: Field[] = [
  {
    key: 'mode',
    label: 'Modo di stampa',
    kind: 'select',
    full: true,
    options: [
      ['planar', 'Strati planari: Z fissa per strato, +altezza strato (come Tavolino1)'],
      ['spiral', 'Spirale continua: Z sale lungo il giro (vase mode)'],
    ],
  },
  { key: 'layerHeight', label: 'Altezza strato (mm)', kind: 'number', step: 0.1, min: 0.1 },
  { key: 'walls', label: 'Pareti (n°)', kind: 'number', step: 1, min: 1 },
  { key: 'wallSpacing', label: 'Larghezza cordolo (mm)', kind: 'number', step: 0.5, min: 0.1 },
  { key: 'tolerance', label: 'Tolleranza contorno (mm)', kind: 'number', step: 0.05, min: 0 },
  { key: 'maxSegment', label: 'LIN max (mm, 0 = off)', kind: 'number', step: 1, min: 0 },
  { key: 'minContourLength', label: 'Contorno minimo (mm)', kind: 'number', step: 1, min: 0 },
  { key: 'maxBridge', label: 'Salto senza stop (mm)', kind: 'number', step: 1, min: 0 },
  { key: 'travelLift', label: 'Sollevamento spost. (mm)', kind: 'number', step: 1, min: 0 },
  { key: 'overhangAngle', label: 'Sbalzo critico (°)', kind: 'number', step: 1, min: 1 },
  { key: 'thinWallMax', label: 'Guscio → linea media fino a (mm)', kind: 'number', step: 1, min: 0 },
  {
    key: 'startMode',
    label: 'Punto iniziale',
    kind: 'select',
    full: true,
    options: [
      ['auto', 'Automatico (angolo davanti-sinistra)'],
      ['point', 'Punto scelto (X/Y in BASE)'],
    ],
  },
  { key: 'startX', label: 'Inizio X in BASE', kind: 'number', step: 5 },
  { key: 'startY', label: 'Inizio Y in BASE', kind: 'number', step: 5 },
];

const ROBOT_FIELDS: Field[] = [
  { group: 'Programma' },
  { key: 'programName', label: 'Nome programma (DEF)', kind: 'text', full: true },
  { key: 'toolNumber', label: 'TOOL_DATA[n]', kind: 'number', step: 1 },
  { key: 'baseNumber', label: 'BASE_DATA[n]', kind: 'number', step: 1 },
  { key: 'velCP', label: '$VEL.CP (m/s)', kind: 'number', step: 0.01 },
  { key: 'advance', label: '$ADVANCE', kind: 'number', step: 1 },
  { group: 'Orientamento utensile' },
  { key: 'a', label: 'A (°)', kind: 'number', step: 1 },
  { key: 'b', label: 'B (°)', kind: 'number', step: 1 },
  { key: 'c', label: 'C (°)', kind: 'number', step: 1 },
  { group: 'Assi esterni' },
  { key: 'e1', label: 'E1', kind: 'number', step: 1 },
  { key: 'e2', label: 'E2', kind: 'number', step: 1 },
  { key: 'e3', label: 'E3', kind: 'number', step: 1 },
  { key: 'e4', label: 'E4', kind: 'number', step: 1 },
  { group: 'Estrusore' },
  { key: 'extruderAnout', label: 'ANOUT on/off', kind: 'number', step: 1 },
  { key: 'extruderSpeedAnout', label: 'ANOUT velocità', kind: 'number', step: 1 },
  { key: 'extruderSpeed', label: 'Velocità (10 = 100%)', kind: 'number', step: 0.1 },
  { key: 'extruderDelay', label: 'Attesa accensione (s)', kind: 'number', step: 0.5 },
  { key: 'useHoming', label: 'Macro finale di homing', kind: 'check', full: true },
  { group: 'Posizionamento sul piano' },
  {
    key: 'placement',
    label: 'Posizione del pezzo',
    kind: 'select',
    full: true,
    options: [
      ['origin', 'Centra sul punto indicato (BASE)'],
      ['file', 'Mantieni posizione del file (mondo → BASE)'],
    ],
  },
  { key: 'originX', label: 'Centro X in BASE', kind: 'number', step: 1 },
  { key: 'originY', label: 'Centro Y in BASE', kind: 'number', step: 1 },
  { key: 'originZ', label: 'Piano Z in BASE', kind: 'number', step: 0.5 },
  { key: 'rotationZ', label: 'Rotazione pezzo Z (°)', kind: 'number', step: 15 },
  { group: 'Posizione sicura (assi)' },
  ...[1, 2, 3, 4, 5, 6].map((n): Field => ({ key: `safeAxes.${n - 1}`, label: `A${n} (°)`, kind: 'number', step: 1 })),
];

function getPath(obj: Record<string, unknown>, key: string): unknown {
  const [k, i] = key.split('.');
  return i === undefined ? obj[k] : (obj[k] as unknown[])[+i];
}
function setPath(obj: Record<string, unknown>, key: string, v: unknown) {
  const [k, i] = key.split('.');
  if (i === undefined) obj[k] = v;
  else (obj[k] as unknown[])[+i] = v;
}

function renderFields(host: HTMLElement, fields: Field[], target: Record<string, unknown>, onChange: (key: string) => void) {
  host.replaceChildren(
    ...fields.map((f) => {
      if ('group' in f) return Object.assign(document.createElement('div'), { className: 'group', textContent: f.group });
      const wrap = document.createElement('label');
      wrap.className = 'field' + (f.full ? ' full' : '') + (f.kind === 'check' ? ' check' : '');
      const val = getPath(target, f.key);
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.kind === 'select') {
        input = document.createElement('select');
        for (const [v, t] of f.options!) input.append(new Option(t, v, false, v === val));
      } else {
        input = document.createElement('input');
        input.type = f.kind === 'check' ? 'checkbox' : f.kind;
        if (f.kind === 'check') input.checked = Boolean(val);
        else input.value = String(val);
        input.step = 'any'; // free decimals; `f.step` only drives the spinner arrows below
        if (f.min !== undefined) input.min = String(f.min);
        if (f.kind === 'number' && f.step !== undefined) {
          const step = f.step;
          input.addEventListener('keydown', (e) => {
            const k = (e as KeyboardEvent).key;
            if (k !== 'ArrowUp' && k !== 'ArrowDown') return;
            e.preventDefault();
            const v = parseFloat(input.value) || 0;
            input.value = String(+(v + (k === 'ArrowUp' ? step : -step)).toFixed(4));
            input.dispatchEvent(new Event('change'));
          });
        }
      }
      input.addEventListener('change', () => {
        let v: unknown;
        if (f.kind === 'check') v = (input as HTMLInputElement).checked;
        else if (f.kind === 'number') {
          const n = parseFloat(input.value);
          if (!Number.isFinite(n)) return;
          v = f.min !== undefined ? Math.max(f.min, n) : n;
        } else v = input.value;
        setPath(target, f.key, v);
        onChange(f.key);
      });
      if (f.kind === 'check') wrap.append(input, f.label);
      else wrap.append(f.label, input);
      return wrap;
    }),
  );
}

let buildTimer = 0;
const buildSoon = () => {
  clearTimeout(buildTimer);
  buildTimer = window.setTimeout(build, 400);
};

function renderPrintFields() {
  renderFields($('printFields'), PRINT_FIELDS, print as unknown as Record<string, unknown>, (key) => {
    save('gb.print', print);
    if (ANALYSIS_KEYS.includes(key)) analyze();
    else buildSoon();
  });
}
const ANALYSIS_KEYS = ['overhangAngle', 'layerHeight', 'thinWallMax'];
renderPrintFields();

function renderRobotFields() {
  renderFields($('robotFields'), ROBOT_FIELDS, robot as unknown as Record<string, unknown>, () => {
    save('gb.robot', robot);
    buildSoon();
  });
}
renderRobotFields();

$('resetRobot').onclick = () => {
  const name = robot.programName;
  Object.assign(robot, structuredClone(DEFAULT_ROBOT), { programName: name });
  save('gb.robot', robot);
  renderRobotFields();
  buildSoon();
};

// ---------- step 5: build ----------

interface BuildMsg {
  xyz: Float32Array;
  ext: Uint8Array;
  meta: Toolpath;
  src: string;
  offset: [number, number, number];
  mesh: MeshData;
  min: [number, number, number];
  max: [number, number, number];
  reach: ReachReport;
}

let currentMeta: Toolpath | null = null;
let lastBuild: BuildMsg | null = null;
/** Re-frame the camera only on a new model/orientation, not on every tweak. */
let fitNext = true;

async function build(): Promise<BuildMsg | null> {
  if (!mesh || !orientations.length) return null;
  const matrix = mulMat3(manual, orientations[orientIdx].matrix);
  const m = mesh;
  let r: BuildMsg;
  try {
    r = await busy('Calcolo percorso…', () =>
      run<BuildMsg>('build', { type: 'build', mesh: m, matrix, print: { ...print }, robot: structuredClone(robot), sourceName }),
    );
  } catch (e) {
    if (!(e instanceof Superseded)) $('warnings').replaceChildren(li(e instanceof Error ? e.message : String(e)));
    return null;
  }
  if (m !== mesh) return null;
  lastSrc = r.src;
  currentMeta = r.meta;
  viewer.setModel(r.mesh, r.offset, parseFloat($<HTMLInputElement>('opacity').value));
  viewer.setBed(robot.bedSizeX, robot.bedSizeY, [robot.bedCenterX, robot.bedCenterY, r.offset[2]]);
  viewer.setToolpath(r.xyz, r.ext, r.meta.layerStart, r.offset);
  viewer.setStartMarker(r.xyz.length ? [r.xyz[0] + r.offset[0], r.xyz[1] + r.offset[1], r.xyz[2] + r.offset[2]] : null);
  const slider = $<HTMLInputElement>('layerSlider');
  slider.max = String(Math.max(0, r.meta.layerStart.length - 1));
  slider.value = slider.max;
  updateLayerLabel();
  $('vpTools').hidden = false;
  if (fitNext) viewer.fit();
  fitNext = false;
  lastBuild = r;
  resetSim(r);
  renderStats(r);
  if (!$('srcPreview').hidden) showPreview();
  return r;
}

function updateLayerLabel() {
  if (!currentMeta) return;
  const i = +$<HTMLInputElement>('layerSlider').value;
  $('layerOut').textContent = `${i + 1} / ${currentMeta.layerStart.length} · Z ${((i + 1) * currentMeta.layerHeight).toFixed(1)}`;
}
$<HTMLInputElement>('layerSlider').addEventListener('input', (e) => {
  const layer = +(e.target as HTMLInputElement).value;
  updateLayerLabel();
  if (lastBuild && currentMeta) {
    const n = lastBuild.xyz.length / 3;
    const end = layer + 1 < currentMeta.layerStart.length ? currentMeta.layerStart[layer + 1] : n;
    stopSim();
    setSimIndex(Math.max(0, end - 1));
  }
});

// ---------- simulation: the robot runs the LIN moves of the .src ----------

let simIndex = 0;
let simPos = 0; // mm travelled along the path
let simCum = new Float64Array(0); // cumulative path length per point
let playing = false;
let lastFrame = 0;

function resetSim(r: BuildMsg) {
  const n = r.xyz.length / 3;
  simCum = new Float64Array(n);
  for (let i = 1; i < n; i++)
    simCum[i] = simCum[i - 1] + Math.hypot(r.xyz[i * 3] - r.xyz[i * 3 - 3], r.xyz[i * 3 + 1] - r.xyz[i * 3 - 2], r.xyz[i * 3 + 2] - r.xyz[i * 3 - 1]);
  const slider = $<HTMLInputElement>('simSlider');
  slider.max = String(Math.max(0, n - 1));
  stopSim();
  setSimIndex(n - 1);
}

function setSimIndex(i: number) {
  if (!lastBuild) return;
  const r = lastBuild;
  const n = r.xyz.length / 3;
  simIndex = Math.max(0, Math.min(n - 1, i));
  simPos = simCum[simIndex] ?? 0;
  $<HTMLInputElement>('simSlider').value = String(simIndex);
  viewer.showProgress(simIndex);
  const o = r.offset;
  const p: [number, number, number] = [r.xyz[simIndex * 3] + o[0], r.xyz[simIndex * 3 + 1] + o[1], r.xyz[simIndex * 3 + 2] + o[2]];
  const q = poseAt(p, robot, robotPose);
  if (q) showRobot(q);
  const f = (v: number) => v.toFixed(1);
  const move = r.ext[simIndex] ? 'stampa' : 'spostamento (estrusore spento)';
  $('simReadout').innerHTML =
    `LIN ${simIndex + 1} / ${n} · ${move}\nX ${f(p[0])}  Y ${f(p[1])}  Z ${f(p[2])}  A ${robot.a}  B ${robot.b}  C ${robot.c}\n` +
    (q ? q.map((v, k) => `A${k + 1} ${v.toFixed(1)}°`).join('  ') : '<span class="bad">punto fuori portata del robot</span>');
}

function stopSim() {
  playing = false;
  $('playBtn').textContent = '▶ Simula';
}

function tick(t: number) {
  if (!playing || !lastBuild) return;
  const dt = Math.min(0.1, (t - lastFrame) / 1000);
  lastFrame = t;
  simPos += dt * robot.velCP * 1000 * +$<HTMLSelectElement>('simSpeed').value;
  let i = simIndex;
  while (i < simCum.length - 1 && simCum[i + 1] <= simPos) i++;
  setSimIndex(i);
  simPos = Math.max(simPos, simCum[i]);
  if (i >= simCum.length - 1) stopSim();
  else requestAnimationFrame(tick);
}

$('playBtn').onclick = () => {
  if (!lastBuild) return;
  if (playing) return stopSim();
  if (simIndex >= simCum.length - 1) setSimIndex(0);
  playing = true;
  $('playBtn').textContent = '⏸ Pausa';
  lastFrame = performance.now();
  requestAnimationFrame(tick);
};
$<HTMLInputElement>('simSlider').addEventListener('input', (e) => {
  stopSim();
  setSimIndex(+(e.target as HTMLInputElement).value);
});
$<HTMLInputElement>('opacity').addEventListener('input', (e) => viewer.setModelOpacity(+(e.target as HTMLInputElement).value));
$('fitBtn').onclick = () => viewer.fit();

// ---------- fixed robot cell ----------

let robotPose: Joints = [...robot.safeAxes] as Joints;
function showRobot(q: Joints) {
  robotPose = q;
  const f = robotRootFrame(robot);
  viewer.setRobotPose(f.p, f.R, linkTransforms(q), KR16.flangeHome);
}
viewer
  .loadCell('./cell')
  .then(() => {
    showRobot(robotPose);
    if (!mesh) viewer.fit();
  })
  .catch(() => setNotes([], 'Impossibile caricare la cella del robot (cell.bin).'));

// ---------- click-to-place / click-to-start ----------

let pick: 'none' | 'place' | 'start' = 'none';
function setPick(mode: 'none' | 'place' | 'start') {
  pick = pick === mode ? 'none' : mode;
  viewer.setPickMode(pick);
  $('placeBtn').classList.toggle('active', pick === 'place');
  $('startBtn').classList.toggle('active', pick === 'start');
  $('pickHint').hidden = pick === 'none';
  $('pickHint').textContent = pick === 'place' ? 'Clicca sul piano dove mettere il centro del pezzo' : 'Clicca vicino al punto dove iniziare a stampare';
}
$('placeBtn').onclick = () => setPick('place');
$('startBtn').onclick = () => setPick('start');
viewer.onPick = (mode, x, y) => {
  if (mode === 'place') {
    Object.assign(robot, { placement: 'origin', originX: Math.round(x), originY: Math.round(y) });
    save('gb.robot', robot);
    renderRobotFields();
  } else {
    Object.assign(print, { startMode: 'point', startX: Math.round(x), startY: Math.round(y) });
    save('gb.print', print);
    renderPrintFields();
  }
  setPick('none');
  build();
};

function fmtTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function renderStats(r: BuildMsg) {
  const t = r.meta;
  const seconds = (t.printLength + t.travelLength) / (robot.velCP * 1000) + t.travels * robot.extruderDelay;
  const kb = new Blob([r.src]).size / 1024;
  const modeText =
    t.mode === 'spiral'
      ? 'Spirale continua — la Z sale lungo il contorno: nessuna giunzione, estrusore mai fermo.'
      : t.travels
        ? `Strati planari — ${t.travels} spostamenti con estrusore spento tra contorni separati.`
        : 'Strati planari — cambio strato sulla stessa verticale senza fermare l’estrusore (come Tavolino1).';
  const items: [string, string, boolean?][] = [
    ['Modo scelto', modeText, true],
    ['Strati', `${t.layerCount}`],
    ['Punti LIN', `${r.xyz.length / 3}`],
    ['Lunghezza stampa', `${(t.printLength / 1000).toFixed(2)} m`],
    ['Tempo stimato', fmtTime(seconds)],
    [
      'Estensione in BASE (mm)',
      `X ${r.min[0].toFixed(1)} … ${r.max[0].toFixed(1)}\nY ${r.min[1].toFixed(1)} … ${r.max[1].toFixed(1)}\nZ ${r.min[2].toFixed(1)} … ${r.max[2].toFixed(1)}`,
      true,
    ],
    [
      'Assi robot (min … max)',
      r.reach.unreachable === r.xyz.length / 3
        ? 'nessun punto raggiungibile'
        : r.reach.jointMin.map((v, i) => `A${i + 1} ${v.toFixed(0)} … ${r.reach.jointMax[i].toFixed(0)}°`).join('\n'),
      true,
    ],
    ['File .src', kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`],
    ['Materiale ≈', `${((t.printLength * print.layerHeight * print.wallSpacing) / 1e6).toFixed(2)} L`],
  ];
  $('stats').replaceChildren(
    ...items.map(([k, v, wide]) => {
      const d = document.createElement('div');
      d.className = 'stat' + (wide ? ' wide' : '');
      const val = Object.assign(document.createElement('div'), { className: 'v' + (wide ? ' small' : ''), textContent: v });
      val.style.whiteSpace = 'pre-line';
      d.append(Object.assign(document.createElement('div'), { className: 'k', textContent: k }), val);
      return d;
    }),
  );
  $('warnings').replaceChildren(...t.warnings.map((w) => li(w)));
}

$('download').onclick = () => {
  if (!lastSrc) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastSrc], { type: 'text/plain' }));
  a.download = sanitizeProgramName(robot.programName) + '.src';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

function showPreview() {
  const lines = lastSrc.split('\r\n');
  $('srcPreview').textContent =
    lines.length > 140 ? [...lines.slice(0, 110), `; … ${lines.length - 134} righe …`, ...lines.slice(-24)].join('\n') : lines.join('\n');
}
$('previewBtn').onclick = () => {
  const pre = $('srcPreview');
  pre.hidden = !pre.hidden;
  if (!pre.hidden) showPreview();
};
