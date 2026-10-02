// Three.js viewport, drawn in the robot BASE frame (Z up, mm).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from './core/mesh';

interface CellPart {
  name: string;
  kind: 'static' | 'link' | 'tool';
  color: string;
  link?: number;
  positions: [number, number];
  indices: [number, number];
}

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private model: THREE.Mesh | null = null;
  private path: THREE.LineSegments | null = null;
  private ghost: THREE.LineSegments | null = null;
  private nozzle: THREE.Mesh;
  private bed: THREE.Group | null = null;
  private robotRoot = new THREE.Group();
  private links: THREE.Mesh[] = [];
  private tool: THREE.Mesh | null = null;
  private startMarker: THREE.Mesh;
  private zones = new THREE.Group();
  private hits: THREE.Points | null = null;
  private cutPlane: THREE.Mesh | null = null;
  private pickMode: 'none' | 'place' | 'start' = 'none';
  private bedZ = 0;
  /** Called with BASE coordinates when the user clicks the bed in a pick mode. */
  onPick: ((mode: 'place' | 'start', x: number, y: number) => void) | null = null;
  private layerStart: number[] = [];
  private xyz: Float32Array | null = null;
  private offset: [number, number, number] = [0, 0, 0];

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(900, -900, 800);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, -1.5, 2);
    this.scene.add(sun);
    this.scene.add(new THREE.AxesHelper(150)); // BASE frame: X red, Y green, Z blue

    this.nozzle = new THREE.Mesh(new THREE.ConeGeometry(6, 18, 20), new THREE.MeshStandardMaterial({ color: 0xffb020 }));
    this.nozzle.rotation.x = -Math.PI / 2;
    this.nozzle.visible = false;
    this.scene.add(this.nozzle);

    this.startMarker = new THREE.Mesh(new THREE.SphereGeometry(7, 20, 12), new THREE.MeshBasicMaterial({ color: 0x00e0ff }));
    this.startMarker.visible = false;
    this.scene.add(this.startMarker);

    // A click (not a drag) on the bed plane picks a point in BASE coordinates.
    let down: [number, number] | null = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => {
      if (!down || this.pickMode === 'none' || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.bedZ), hit)) this.onPick?.(this.pickMode, hit.x, hit.y);
    });

    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  applyTheme() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim() || '#12161c';
    this.scene.background = new THREE.Color(bg);
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setModel(mesh: MeshData | null, offset: [number, number, number], opacity = 1) {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.geometry.dispose();
    }
    this.model = null;
    this.offset = offset;
    if (!mesh) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    this.model = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide }),
    );
    this.model.position.set(...offset);
    this.scene.add(this.model);
    this.setModelOpacity(opacity);
  }

  /**
   * Risk zones on the part (part frame, moved by `offset`): overhanging faces in orange,
   * outlines of islands starting in mid-air in red and of too-thin walls in yellow.
   */
  setZones(z: { overhang: Uint32Array; islands: Float32Array; thin: Float32Array } | null, mesh: MeshData | null, offset: [number, number, number]) {
    for (const o of [...this.zones.children]) {
      this.zones.remove(o);
      (o as THREE.Mesh).geometry.dispose();
    }
    this.scene.add(this.zones);
    if (!z || !mesh) return;
    this.zones.position.set(...offset);
    if (z.overhang.length) {
      const idx = new Uint32Array(z.overhang.length * 3);
      z.overhang.forEach((t, k) => idx.set(mesh.indices.subarray(t * 3, t * 3 + 3), k * 3));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      const mat = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      this.zones.add(new THREE.Mesh(g, mat));
    }
    for (const [pts, color] of [
      [z.islands, 0xff2d2d],
      [z.thin, 0xffe03b],
    ] as const) {
      if (!pts.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      this.zones.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false })));
    }
  }

  /** PNG image of the current view (for the printable report). */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Suggested cut: a translucent square of side `size` through `at` (BASE), normal `n`. */
  setCutPlane(at: [number, number, number] | null, n?: [number, number, number], size = 200) {
    if (this.cutPlane) {
      this.scene.remove(this.cutPlane);
      this.cutPlane.geometry.dispose();
      this.cutPlane = null;
    }
    if (!at || !n) return;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    this.cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    this.cutPlane.position.set(...at);
    this.cutPlane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...n).normalize());
    this.cutPlane.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.cutPlane.geometry), new THREE.LineBasicMaterial({ color: 0xffb020 })));
    this.scene.add(this.cutPlane);
  }

  setZonesVisible(v: boolean) {
    this.zones.visible = v;
  }

  /** Path points (BASE) where the arm or the mandrino collides: magenta dots. */
  setCollisions(xyz: Float32Array | null) {
    if (this.hits) {
      this.scene.remove(this.hits);
      this.hits.geometry.dispose();
      this.hits = null;
    }
    if (!xyz?.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    this.hits = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff00d4, size: 9, sizeAttenuation: false, depthTest: false }));
    this.scene.add(this.hits);
  }

  setPickMode(mode: 'none' | 'place' | 'start') {
    this.pickMode = mode;
    this.renderer.domElement.style.cursor = mode === 'none' ? '' : 'crosshair';
  }

  setStartMarker(p: [number, number, number] | null) {
    this.startMarker.visible = !!p;
    if (p) this.startMarker.position.set(...p);
  }

  setModelOpacity(opacity: number) {
    if (!this.model) return;
    const m = this.model.material as THREE.MeshStandardMaterial;
    m.opacity = opacity;
    m.transparent = opacity < 1;
    m.depthWrite = opacity >= 1;
    this.model.visible = opacity > 0;
  }

  setBed(sizeX: number, sizeY: number, center: [number, number, number]) {
    if (this.bed) this.scene.remove(this.bed);
    const grp = new THREE.Group();
    // The real plate comes from the cell; this is only a 50 mm reference grid on it.
    const size = Math.max(sizeX, sizeY);
    const grid = new THREE.GridHelper(size, Math.max(1, Math.round(size / 50)), 0x9aa4ae, 0xb9b3a8);
    grid.scale.set(sizeX / size, 1, sizeY / size);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.2;
    grp.add(grid);
    grp.position.set(center[0], center[1], center[2] + 0.3);
    this.bedZ = center[2];
    this.bed = grp;
    this.scene.add(grp);
  }

  /**
   * Fixed robot cell (public/cell.bin, extracted from BASE ROBOT.3dm): table and plate in the
   * BASE frame, KR16 links in their home pose, mandrino in the flange frame. Always shown.
   */
  async loadCell(url: string): Promise<{ parts: CellPart[]; bin: ArrayBuffer }> {
    const [header, bin] = await Promise.all([
      fetch(url + '.json').then((r) => r.json()),
      fetch(url + '.bin').then((r) => r.arrayBuffer()),
    ]);
    for (const part of header.parts as CellPart[]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, part.positions[0], part.positions[1]), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, part.indices[0], part.indices[1]), 1));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.6, metalness: 0.1 }));
      if (part.kind === 'static') this.scene.add(mesh);
      else {
        mesh.matrixAutoUpdate = false;
        this.robotRoot.add(mesh);
        if (part.kind === 'link') this.links[part.link!] = mesh;
        else this.tool = mesh;
      }
    }
    this.scene.add(this.robotRoot);
    return { parts: header.parts as CellPart[], bin };
  }

  /**
   * Place the robot root (BASE frame) and pose the arm; `links` are row-major 4×4 from
   * linkTransforms. The mandrino is drawn in the KUKA FLANGE frame: `flangeFrame` (row-major 3×3)
   * turns it into the link-6 frame, at the flange centre `flange`.
   */
  setRobotPose(root: [number, number, number], rootRotation: number[], links: number[][], flange: [number, number, number], flangeFrame: number[]) {
    const R = rootRotation;
    this.robotRoot.matrixAutoUpdate = false;
    this.robotRoot.matrix.set(R[0], R[1], R[2], root[0], R[3], R[4], R[5], root[1], R[6], R[7], R[8], root[2], 0, 0, 0, 1);
    links.forEach((m, k) => this.links[k]?.matrix.set(...(m as Parameters<THREE.Matrix4['set']>)));
    if (this.tool) {
      const m = links[6];
      const F = flangeFrame;
      this.tool.matrix
        .set(...(m as Parameters<THREE.Matrix4['set']>))
        .multiply(new THREE.Matrix4().makeTranslation(...flange))
        .multiply(new THREE.Matrix4().set(F[0], F[1], F[2], 0, F[3], F[4], F[5], 0, F[6], F[7], F[8], 0, 0, 0, 0, 1));
    }
  }

  /** `sup`: 1 where the move prints a removable support (drawn grey). */
  setToolpath(xyz: Float32Array | null, ext: Uint8Array | null, layerStart: number[], offset: [number, number, number], sup?: Uint8Array) {
    for (const l of [this.path, this.ghost]) {
      if (!l) continue;
      this.scene.remove(l);
      l.geometry.dispose();
    }
    this.path = null;
    this.ghost = null;
    this.xyz = xyz;
    this.layerStart = layerStart;
    this.offset = offset;
    this.nozzle.visible = false;
    if (!xyz || !ext || xyz.length < 6) return;
    const n = xyz.length / 3;
    const pos = new Float32Array((n - 1) * 6);
    const col = new Float32Array((n - 1) * 6);
    const layers = Math.max(1, layerStart.length);
    const c = new THREE.Color();
    let layer = 0;
    for (let i = 1; i < n; i++) {
      while (layer + 1 < layerStart.length && layerStart[layer + 1] <= i) layer++;
      const s = (i - 1) * 6;
      for (let k = 0; k < 3; k++) {
        pos[s + k] = xyz[(i - 1) * 3 + k] + offset[k];
        pos[s + 3 + k] = xyz[i * 3 + k] + offset[k];
      }
      // Extrusion colored bottom→top blue→red; travels (extruder off) in magenta.
      if (ext[i] && sup?.[i]) c.set(0x9aa0a8);
      else if (ext[i]) c.setHSL(0.62 - 0.62 * (layer / layers), 0.85, 0.55);
      else c.set(0xff3b9d);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.path = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.path);
    // Whole path in light grey, so what is still to print stays readable during the simulation.
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', g.getAttribute('position'));
    this.ghost = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x9aa4ae, transparent: true, opacity: 0.18, depthWrite: false }));
    this.scene.add(this.ghost);
    this.showUpToLayer(layers - 1);
  }

  /** Show layers 0..layer (inclusive) and park the nozzle at the last visible point. */
  showUpToLayer(layer: number) {
    if (!this.xyz) return;
    const n = this.xyz.length / 3;
    const end = layer + 1 < this.layerStart.length ? this.layerStart[layer + 1] : n;
    this.showProgress(Math.max(0, end - 1));
  }

  /** Simulation: path printed up to point i (coloured), nozzle on point i. */
  showProgress(i: number) {
    if (!this.path || !this.xyz) return;
    this.path.geometry.setDrawRange(0, i * 2);
    this.nozzle.position.set(
      this.xyz[i * 3] + this.offset[0],
      this.xyz[i * 3 + 1] + this.offset[1],
      this.xyz[i * 3 + 2] + this.offset[2] + 9,
    );
    this.nozzle.visible = true;
  }

  /** Frame the whole cell (robot, table) together with the part and the path. */
  fit() {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible && o !== this.nozzle && o !== this.startMarker) box.expandByObject(o);
    });
    if (this.path) box.expandByObject(this.path);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    // Aim a little low so the scene sits above the control panel at the bottom of the viewport.
    center.z -= size * 0.12;
    this.controls.target.copy(center);
    // View from the table side, a bit from above, so the robot faces the camera.
    this.camera.position.copy(center).add(new THREE.Vector3(0.75, -0.9, 0.65).normalize().multiplyScalar(size * 0.95));
    this.camera.near = size / 500;
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
  }

}
