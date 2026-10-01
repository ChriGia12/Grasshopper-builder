import './style.css';
import { ACCEPTED, combineParts, loadModel, pickPieces, type CellRegion } from './core/loaders';
import { sanitizeProgramName } from './core/kuka';
import { IDENTITY, dropToOrigin, meshStats, mulMat3, rotX, rotY, rotZ, type Mat3, type MeshData } from './core/mesh';
import type { OrientationCandidate } from './core/orientation';
import { placementOffset } from './core/pipeline';
import { FIXED_ROBOT, validateSettings } from './core/validate';
import { KR16, linkTransforms, poseAt, robotRootFrame, type Joints, type ReachReport } from './core/robot';
import { DEFAULT_PRINT, DEFAULT_ROBOT, type PrintSettings, type RobotSettings } from './core/settings';
import type { Toolpath } from './core/toolpath';
import { Viewer } from './viewer';
import { applyStatic, getLang, locale, msg, MsgError, setLang, t, tm, type Msg } from './i18n';
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
const CELL_KEYS = ['worldBaseX', 'worldBaseY', 'worldBaseZ', 'bedSizeX', 'bedSizeY', 'bedCenterX', 'bedCenterY', 'bedTopZ', 'baseData', 'toolData'] as const;
for (const k of CELL_KEYS) (robot as unknown as Record<string, unknown>)[k] = structuredClone(DEFAULT_ROBOT[k]);
Object.assign(robot, FIXED_ROBOT); // only BASE 1 / TOOL 11 without external axes are modelled
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
const offBedOk = $<HTMLInputElement>('offBedOk');
const tiltOk = $<HTMLInputElement>('tiltOk');

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
      if (ev.data.type === 'error') reject(ev.data.msg ? new MsgError(ev.data.msg) : new Error(ev.data.message));
      else resolve(ev.data as T);
    };
    pool.worker.onerror = (e) => {
      pool.busy = false;
      cancelers[kind] = null;
      reject(e.message ? new Error(e.message) : new MsgError(msg('e.worker')));
    };
    pool.worker.postMessage({ ...req, id });
  });
}

/** Text of an error in the current language. */
const errText = (e: unknown): Msg | string => (e instanceof MsgError ? e.m : e instanceof Error ? e.message : String(e));

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
let pieceNotes: Msg[] = [];
let pieceError: Msg | string | undefined;

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

function setNotes(notes: Msg[], error?: Msg | string) {
  pieceError = error;
  $('modelNotes').replaceChildren(...notes.map((n) => li(tm(n))), ...(error ? [li(tm(error), 'error')] : []));
}

async function openFile(file: File) {
  invalidate();
  const cell: CellRegion = {
    worldBase: [robot.worldBaseX, robot.worldBaseY, robot.worldBaseZ],
    bedCenter: [robot.bedCenterX, robot.bedCenterY],
    bedSize: [robot.bedSizeX, robot.bedSizeY],
  };
  let piece: MeshData;
  const notes: Msg[] = [];
  try {
    const model = await busy(t('busy.read', { name: file.name }), () => loadModel(file));
    const { parts, note } = pickPieces(model, cell);
    if (note) notes.push(note);
    if (!parts.length) throw new MsgError(note ?? msg('e.noPrintable'));
    piece = combineParts(parts);
    // Ignored blocks / curves are the rest of the scene: not worth a note.
    notes.push(...model.notes.filter((n) => n.k !== 'n.blocks' && n.k !== 'n.skipped'));
    pieceFormat = model.format;
  } catch (e) {
    setNotes(notes, errText(e));
    return;
  }
  pieceNotes = notes;
  sourceName = file.name;
  robot.programName = sanitizeProgramName(file.name);
  save('gb.robot', robot);
  renderRobotFields();
  mesh = piece;
  // The orientations belong to the previous part: if this analysis stops (invalid parameter), the
  // next build must analyse the new part again instead of reusing them.
  orientations = [];
  orientIdx = 0;
  manual = [...IDENTITY] as Mat3;
  renderOrientations();
  $('step-orient').hidden = true;
  $('pieceName').textContent = file.name;
  $('pieceName').hidden = false;
  setNotes(pieceNotes);
  showModelInfo(mesh);
  $('empty').hidden = true;
  lastSrc = '';
  viewer.setToolpath(null, null, [], [0, 0, 0]);
  const off = placementOffset(mesh, robot);
  viewer.setModel(dropToOrigin(mesh), off, 1);
  viewer.setBed(robot.bedSizeX, robot.bedSizeY, [robot.bedCenterX, robot.bedCenterY, robot.bedTopZ]);
  viewer.fit();
  await analyze();
}

function showModelInfo(m: MeshData) {
  const s = meshStats(m);
  const rows: [string, string][] = [
    [t('info.format'), pieceFormat],
    [t('info.tris'), s.triangles.toLocaleString(locale())],
    [t('info.size'), `${s.size.map((v) => v.toFixed(1)).join(' × ')} mm`],
    [t('info.closed'), s.openEdges ? t('info.closed.no', { n: s.openEdges }) : t('info.closed.yes')],
    [t('info.volume'), s.openEdges ? '—' : `${(s.volume / 1e6).toFixed(2)} L`],
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
  invalidate();
  if (!mesh) return;
  if (!checkSettings()) {
    for (const id of ['step-print', 'step-robot', 'step-out']) $(id).hidden = false;
    return;
  }
  const m = mesh;
  try {
    const res = await busy(t('busy.orient'), () =>
      run<{ orientations: OrientationCandidate[] }>('analyze', { type: 'analyze', mesh: m, print: { ...print } }),
    );
    if (m !== mesh) return;
    orientations = res.orientations;
  } catch (e) {
    if (!(e instanceof Superseded) && m === mesh) setNotes(pieceNotes, errText(e));
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
  // The section is folded by default: its title shows the orientation in use.
  const cur = orientations[orientIdx];
  $('orientChosen').textContent = cur ? t('orient.chosen', { label: tm(cur.label) }) : '';
  $('orientList').replaceChildren(
    ...orientations.map((o, i) => {
      const item = document.createElement('li');
      if (i === orientIdx) item.className = 'sel';
      const facts = [
        t('orient.h', { h: o.height.toFixed(0) }),
        t('orient.base', { a: (o.baseArea / 100).toFixed(0) }),
        t('orient.overhang', { p: (o.overhangRatio * 100).toFixed(1) }),
        o.maxIslands > 1 ? t('orient.islands', { n: o.maxIslands }) : t('orient.oneLoop'),
      ].join(' · ');
      const notes = o.notes.map((n) => escapeHtml(tm(n)));
      item.innerHTML =
        `<span class="title">${escapeHtml(tm(o.label))}</span>` +
        (i === 0 ? `<span class="badge">${escapeHtml(t('orient.best'))}</span>` : `<span class="muted">#${i + 1}</span>`) +
        `<span class="sub">${facts}${notes.length ? '<br>' + notes.join(' · ') : ''}</span>`;
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
  | {
      key: string;
      label: string;
      kind: 'number' | 'text' | 'select' | 'check';
      step?: number;
      min?: number;
      options?: [string, string][];
      full?: boolean;
      /** Shown but not editable (see FIXED_ROBOT). */
      locked?: boolean;
    };

const PRINT_FIELDS: Field[] = [
  {
    key: 'mode',
    label: 'f.mode',
    kind: 'select',
    full: true,
    options: [
      ['planar', 'mode.planar'],
      ['spiral', 'mode.spiral'],
      ['zigzag', 'mode.zigzag'],
      ['surface', 'mode.surface'],
    ],
  },
  { key: 'layerHeight', label: 'f.layerHeight', kind: 'number', step: 0.1, min: 0.1 },
  { key: 'walls', label: 'f.walls', kind: 'number', step: 1, min: 1 },
  { key: 'wallSpacing', label: 'f.wallSpacing', kind: 'number', step: 0.5, min: 0.1 },
  { key: 'tolerance', label: 'f.tolerance', kind: 'number', step: 0.05, min: 0 },
  { key: 'maxSegment', label: 'f.maxSegment', kind: 'number', step: 1, min: 0 },
  { key: 'minContourLength', label: 'f.minContourLength', kind: 'number', step: 1, min: 0 },
  { key: 'maxBridge', label: 'f.maxBridge', kind: 'number', step: 1, min: 0 },
  { key: 'travelLift', label: 'f.travelLift', kind: 'number', step: 1, min: 0 },
  { key: 'overhangAngle', label: 'f.overhangAngle', kind: 'number', step: 1, min: 1 },
  { key: 'thinWallMax', label: 'f.thinWallMax', kind: 'number', step: 1, min: 0 },
  { group: 'g.serpentine' },
  { key: 'fillAngle', label: 'f.fillAngle', kind: 'number', step: 15 },
  { key: 'fillAlternate', label: 'f.fillAlternate', kind: 'check', full: true },
  { key: 'fillAutoAngle', label: 'f.fillAutoAngle', kind: 'check', full: true },
  { key: 'fillPerimeter', label: 'f.fillPerimeter', kind: 'check', full: true },
  { key: 'fillTopSurface', label: 'f.fillTopSurface', kind: 'check', full: true },
  { key: 'surfacePasses', label: 'f.surfacePasses', kind: 'number', step: 1, min: 1 },
  { key: 'surfaceMaxSlope', label: 'f.surfaceMaxSlope', kind: 'number', step: 5, min: 1 },
  { key: 'surfaceTilt', label: 'f.surfaceTilt', kind: 'check', full: true },
  { group: 'g.start' },
  {
    key: 'startMode',
    label: 'f.startMode',
    kind: 'select',
    full: true,
    options: [
      ['auto', 'start.auto'],
      ['point', 'start.point'],
    ],
  },
  { key: 'startX', label: 'f.startX', kind: 'number', step: 5 },
  { key: 'startY', label: 'f.startY', kind: 'number', step: 5 },
];

const ROBOT_FIELDS: Field[] = [
  { group: 'g.program' },
  { key: 'programName', label: 'f.programName', kind: 'text', full: true },
  { key: 'toolNumber', label: 'TOOL_DATA[n]', kind: 'number', step: 1, locked: true },
  { key: 'baseNumber', label: 'BASE_DATA[n]', kind: 'number', step: 1, locked: true },
  { key: 'velCP', label: '$VEL.CP (m/s)', kind: 'number', step: 0.01 },
  { key: 'advance', label: '$ADVANCE', kind: 'number', step: 1 },
  { group: 'g.toolOrient' },
  { key: 'a', label: 'A (°)', kind: 'number', step: 1 },
  { key: 'b', label: 'B (°)', kind: 'number', step: 1 },
  { key: 'c', label: 'C (°)', kind: 'number', step: 1 },
  { group: 'g.external' },
  { key: 'e1', label: 'E1', kind: 'number', step: 1, locked: true },
  { key: 'e2', label: 'E2', kind: 'number', step: 1, locked: true },
  { key: 'e3', label: 'E3', kind: 'number', step: 1, locked: true },
  { key: 'e4', label: 'E4', kind: 'number', step: 1, locked: true },
  { group: 'g.extruder' },
  { key: 'extruderAnout', label: 'f.extruderAnout', kind: 'number', step: 1 },
  { key: 'extruderSpeedAnout', label: 'f.extruderSpeedAnout', kind: 'number', step: 1 },
  { key: 'extruderSpeed', label: 'f.extruderSpeed', kind: 'number', step: 0.1 },
  { key: 'extruderDelay', label: 'f.extruderDelay', kind: 'number', step: 0.5 },
  { key: 'useHoming', label: 'f.useHoming', kind: 'check', full: true },
  {
    key: 'linApprox',
    label: 'f.linApprox',
    kind: 'select',
    full: true,
    options: [
      ['C_DIS', 'approx.cdis'],
      ['none', 'approx.none'],
    ],
  },
  { group: 'g.placement' },
  {
    key: 'placement',
    label: 'f.placement',
    kind: 'select',
    full: true,
    options: [
      ['origin', 'place.origin'],
      ['file', 'place.file'],
    ],
  },
  { key: 'originX', label: 'f.originX', kind: 'number', step: 1 },
  { key: 'originY', label: 'f.originY', kind: 'number', step: 1 },
  { key: 'originZ', label: 'f.originZ', kind: 'number', step: 0.5 },
  { key: 'rotationZ', label: 'f.rotationZ', kind: 'number', step: 15 },
  { group: 'g.safe' },
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

/** Number fields currently holding no valid number: they block the export. */
const fieldErrors = new Set<string>();

function renderFields(host: HTMLElement, fields: Field[], target: Record<string, unknown>, onChange: (key: string) => void) {
  // Redrawn inputs show the real (valid) internal values again: their pending errors are gone,
  // and the result must be recomputed for those values (the old one was discarded).
  let cleared = false;
  for (const f of fields) if (!('group' in f)) cleared = fieldErrors.delete(f.key) || cleared;
  if (cleared && mesh) queueMicrotask(buildSoon);
  host.replaceChildren(
    ...fields.map((f) => {
      if ('group' in f) return Object.assign(document.createElement('div'), { className: 'group', textContent: t(f.group) });
      const wrap = document.createElement('label');
      wrap.className = 'field' + (f.full ? ' full' : '') + (f.kind === 'check' ? ' check' : '');
      const val = getPath(target, f.key);
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.kind === 'select') {
        input = document.createElement('select');
        for (const [v, label] of f.options!) input.append(new Option(t(label), v, false, v === val));
      } else {
        input = document.createElement('input');
        input.type = f.kind === 'check' ? 'checkbox' : f.kind;
        if (f.kind === 'check') input.checked = Boolean(val);
        else input.value = String(val);
        input.step = 'any'; // free decimals; `f.step` only drives the spinner arrows below
        if (f.min !== undefined) input.min = String(f.min);
        if (f.locked) {
          input.disabled = true;
          wrap.title = t('h.fixedCell');
        }
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
          if (!Number.isFinite(n)) {
            // An empty or invalid field must not leave an old program downloadable.
            fieldErrors.add(f.key);
            input.classList.add('invalid');
            invalidate();
            return;
          }
          fieldErrors.delete(f.key);
          input.classList.remove('invalid');
          v = f.min !== undefined ? Math.max(f.min, n) : n;
        } else v = input.value;
        setPath(target, f.key, v);
        onChange(f.key);
      });
      if (f.kind === 'check') wrap.append(input, t(f.label));
      else wrap.append(t(f.label), input);
      return wrap;
    }),
  );
}

/**
 * Every change (model, orientation, parameters) makes the current .src obsolete at once: the
 * download stays disabled until the latest computation has finished and passed every check.
 * `buildSeq` numbers the computations so a late result of an older one is ignored.
 */
let buildSeq = 0;
function invalidate() {
  buildSeq++;
  lastSrc = '';
  // A confirmation refers to one result: any change asks for it again.
  offBedOk.checked = false;
  tiltOk.checked = false;
  updateExport();
}

let buildTimer = 0;
const buildSoon = () => {
  invalidate();
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
  cc: Float32Array;
  meta: Toolpath;
  src: string;
  offset: [number, number, number];
  mesh: MeshData;
  min: [number, number, number];
  max: [number, number, number];
  reach: ReachReport;
  errors: Msg[];
  offBed: boolean;
}

let currentMeta: Toolpath | null = null;
let lastBuild: BuildMsg | null = null;
/** Re-frame the camera only on a new model/orientation, not on every tweak. */
let fitNext = true;

async function build(): Promise<BuildMsg | null> {
  invalidate();
  if (!mesh) return null;
  if (!checkSettings()) return null;
  if (!orientations.length) return (await analyze()) ?? null;
  const seq = buildSeq;
  const matrix = mulMat3(manual, orientations[orientIdx].matrix);
  const m = mesh;
  let r: BuildMsg;
  try {
    r = await busy(t('busy.path'), () =>
      run<BuildMsg>('build', { type: 'build', mesh: m, matrix, print: { ...print }, robot: structuredClone(robot), sourceName }),
    );
  } catch (e) {
    if (!(e instanceof Superseded) && seq === buildSeq) $('warnings').replaceChildren(li(tm(errText(e))));
    return null;
  }
  if (m !== mesh || seq !== buildSeq) return null;
  lastSrc = r.src;
  currentMeta = r.meta;
  lastBuild = r;
  viewer.setModel(r.mesh, r.offset, parseFloat($<HTMLInputElement>('opacity').value));
  viewer.setBed(robot.bedSizeX, robot.bedSizeY, [robot.bedCenterX, robot.bedCenterY, robot.bedTopZ]);
  viewer.setToolpath(r.xyz, r.ext, r.meta.layerStart, r.offset);
  viewer.setStartMarker(r.xyz.length ? [r.xyz[0] + r.offset[0], r.xyz[1] + r.offset[1], r.xyz[2] + r.offset[2]] : null);
  const slider = $<HTMLInputElement>('layerSlider');
  slider.max = String(Math.max(0, r.meta.layerStart.length - 1));
  slider.value = slider.max;
  updateLayerLabel();
  $('vpTools').hidden = false;
  if (fitNext) viewer.fit();
  fitNext = false;
  resetSim(r);
  renderStats(r);
  if (!$('srcPreview').hidden) showPreview();
  return r;
}

function updateLayerLabel() {
  if (!currentMeta) return;
  const i = +$<HTMLInputElement>('layerSlider').value;
  const n = currentMeta.layerStart.length;
  // Z of the layer in BASE (table top + nozzle height); the surface mode follows the part instead.
  const z = (lastBuild?.offset[2] ?? 0) + print.firstLayerZ + i * currentMeta.layerHeight;
  const blended = currentMeta.planarLayers !== undefined && i >= currentMeta.planarLayers;
  $('layerOut').textContent =
    currentMeta.mode === 'surface'
      ? t('layer.pass', { i: i + 1, n })
      : blended
        ? t('layer.blend', { i: i + 1, n })
        : t('layer.z', { i: i + 1, n, z: z.toFixed(1) });
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

/** Jump to LIN i. `keepPos` keeps the fractional distance already travelled (used while playing). */
function setSimIndex(i: number, keepPos = false) {
  if (!lastBuild) return;
  const r = lastBuild;
  const n = r.xyz.length / 3;
  simIndex = Math.max(0, Math.min(n - 1, i));
  if (!keepPos) simPos = simCum[simIndex] ?? 0;
  $<HTMLInputElement>('simSlider').value = String(simIndex);
  viewer.showProgress(simIndex);
  const o = r.offset;
  const p: [number, number, number] = [r.xyz[simIndex * 3] + o[0], r.xyz[simIndex * 3 + 1] + o[1], r.xyz[simIndex * 3 + 2] + o[2]];
  const cPt = r.cc[simIndex];
  const c = Number.isFinite(cPt) ? cPt : robot.c;
  const q = poseAt(p, Number.isFinite(cPt) ? { ...robot, c } : robot, robotPose);
  if (q) showRobot(q);
  const f = (v: number) => v.toFixed(1);
  const move = r.ext[simIndex] ? t('sim.print') : t('sim.travel');
  $('simReadout').innerHTML =
    `LIN ${simIndex + 1} / ${n} · ${move}\nX ${f(p[0])}  Y ${f(p[1])}  Z ${f(p[2])}  A ${robot.a}  B ${robot.b}  C ${f(c)}\n` +
    (q ? q.map((v, k) => `A${k + 1} ${v.toFixed(1)}°`).join('  ') : `<span class="bad">${escapeHtml(t('sim.unreachable'))}</span>`);
}

function stopSim() {
  playing = false;
  $('playBtn').textContent = t('sim.play');
}

function tick(now: number) {
  if (!playing || !lastBuild) return;
  // rAF timestamps can precede the click time: never step backwards, cap long pauses.
  const dt = Math.max(0, Math.min(0.1, (now - lastFrame) / 1000));
  lastFrame = now;
  simPos += dt * robot.velCP * 1000 * +$<HTMLSelectElement>('simSpeed').value;
  let i = simIndex;
  while (i < simCum.length - 1 && simCum[i + 1] <= simPos) i++;
  if (i !== simIndex) setSimIndex(i, true);
  if (i >= simCum.length - 1) stopSim();
  else requestAnimationFrame(tick);
}

$('playBtn').onclick = () => {
  if (!lastBuild) return;
  if (playing) return stopSim();
  if (simIndex >= simCum.length - 1) setSimIndex(0);
  playing = true;
  $('playBtn').textContent = t('sim.pause');
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
  .catch(() => setNotes([], msg('e.cell')));

// ---------- click-to-place / click-to-start ----------

let pick: 'none' | 'place' | 'start' = 'none';
function setPick(mode: 'none' | 'place' | 'start') {
  pick = pick === mode ? 'none' : mode;
  viewer.setPickMode(pick);
  $('placeBtn').classList.toggle('active', pick === 'place');
  $('startBtn').classList.toggle('active', pick === 'start');
  $('pickHint').hidden = pick === 'none';
  $('pickHint').textContent = pick === 'place' ? t('pick.place') : t('pick.start');
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
  const tp = r.meta;
  const seconds = (tp.printLength + tp.travelLength) / (robot.velCP * 1000) + tp.travels * robot.extruderDelay;
  const kb = new Blob([r.src]).size / 1024;
  const stops = ' ' + (tp.travels ? t('r.stops', { n: tp.travels }) : t('r.noStops'));
  const items: [string, string, boolean?][] = [
    [t('r.mode'), t(`r.mode.${tp.mode}`) + stops, true],
    [t('r.layers'), `${tp.layerCount}`],
    [t('r.points'), (r.xyz.length / 3).toLocaleString(locale())],
    [t('r.length'), `${(tp.printLength / 1000).toFixed(2)} m`],
    [t('r.time'), fmtTime(seconds)],
    [
      t('r.extent'),
      `X ${r.min[0].toFixed(1)} … ${r.max[0].toFixed(1)}\nY ${r.min[1].toFixed(1)} … ${r.max[1].toFixed(1)}\nZ ${r.min[2].toFixed(1)} … ${r.max[2].toFixed(1)}`,
      true,
    ],
    [
      t('r.axes'),
      r.reach.unreachable === r.xyz.length / 3
        ? t('r.axes.none')
        : r.reach.jointMin.map((v, i) => `A${i + 1} ${v.toFixed(0)} … ${r.reach.jointMax[i].toFixed(0)}°`).join('\n'),
      true,
    ],
    [t('r.file'), kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`],
    ...(tp.coverage !== undefined
      ? ([[t('r.coverage'), t('r.coverage.v', { p: Math.round(tp.coverage * 100), a: Math.round((tp.topArea ?? 0) / 100) })]] as [string, string][])
      : []),
    [t('r.material'), `${((tp.printLength * print.layerHeight * print.wallSpacing) / 1e6).toFixed(2)} L`],
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
  $('warnings').replaceChildren(...r.errors.map((w) => li(tm(w), 'blocked')), ...tp.warnings.map((w) => li(tm(w))));
  updateExport();
}

/** Parameters outside their admitted values, found before computing: nothing was computed. */
let settingsErrors: Msg[] = [];

/** Checks the parameters before any computation; on errors they are listed and the export stays blocked. */
function checkSettings(): boolean {
  settingsErrors = validateSettings(print, robot);
  if (settingsErrors.length) {
    $('warnings').replaceChildren(...settingsErrors.map((w) => li(tm(w), 'blocked')));
    updateExport();
  }
  return !settingsErrors.length;
}

/** Why the current result may not be exported (empty = export allowed). */
function exportBlocks(): string[] {
  const r = lastBuild;
  if (!r || !lastSrc) return [];
  const out: string[] = [];
  if (r.errors.length) out.push(t('out.blockedErrors'));
  // A path the robot cannot follow must not reach the controller.
  if (r.reach.unreachable > 0 || r.reach.outOfLimits > 0) out.push(t('out.blocked'));
  if (r.offBed && !offBedOk.checked) out.push(t('out.blockedOffBed'));
  if (tiltNeedsConfirm() && !tiltOk.checked) out.push(t('out.blockedTilt'));
  return out;
}

/** Tilt on, but some points have a slope along X that C cannot follow. */
const tiltNeedsConfirm = () => !!lastBuild && print.surfaceTilt && (lastBuild.meta.tiltX ?? 0) > 0;

function updateExport() {
  const ready = !!lastSrc && !!lastBuild && fieldErrors.size === 0;
  const blocks = exportBlocks();
  $<HTMLButtonElement>('download').disabled = !ready || blocks.length > 0;
  $('offBedRow').hidden = !(ready && lastBuild!.offBed);
  $('tiltRow').hidden = !(ready && tiltNeedsConfirm());
  if (lastBuild) $('tiltLabel').textContent = t('out.tiltConfirm', { n: lastBuild.meta.tiltX ?? 0 });
  const fields = [...fieldErrors].map((k) => li(t('v.field', { field: `f.${k.split('.')[0]}` }), 'blocked'));
  if (settingsErrors.length) fields.push(li(t('out.blockedParams'), 'blocked'));
  $('exportState').replaceChildren(...fields, ...(ready ? blocks.map((b) => li(b, 'blocked')) : mesh && !fields.length ? [li(t('out.stale'))] : []));
}

offBedOk.addEventListener('change', updateExport);
tiltOk.addEventListener('change', updateExport);
$('download').onclick = () => {
  if (!lastSrc || !lastBuild || exportBlocks().length) return;
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

// ---------- language ----------

function applyLanguage() {
  applyStatic();
  $('langToggle').textContent = getLang() === 'it' ? 'EN' : 'IT';
  renderPrintFields();
  renderRobotFields();
  if (orientations.length) renderOrientations();
  if (mesh) showModelInfo(mesh);
  setNotes(pieceNotes, pieceError);
  if (lastBuild) {
    renderStats(lastBuild);
    setSimIndex(simIndex, true);
    updateLayerLabel();
  }
  if (settingsErrors.length) $('warnings').replaceChildren(...settingsErrors.map((w) => li(tm(w), 'blocked')));
  $('playBtn').textContent = t(playing ? 'sim.pause' : 'sim.play');
  updateExport();
  if (pick !== 'none') $('pickHint').textContent = pick === 'place' ? t('pick.place') : t('pick.start');
}
$('langToggle').onclick = () => {
  setLang(getLang() === 'it' ? 'en' : 'it');
  applyLanguage();
};
applyLanguage();
