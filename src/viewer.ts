// Three.js viewport, drawn in the robot BASE frame (Z up, mm).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from './core/mesh';

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private model: THREE.Mesh | null = null;
  private path: THREE.LineSegments | null = null;
  private nozzle: THREE.Mesh;
  private bed: THREE.Group | null = null;
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
    grp.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(sizeX, sizeY),
        new THREE.MeshStandardMaterial({ color: 0x5a6878, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      ),
    );
    const size = Math.max(sizeX, sizeY);
    const grid = new THREE.GridHelper(size, Math.max(1, Math.round(size / 50)), 0x7f8c99, 0x4a5561);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.2;
    grp.add(grid);
    grp.position.set(center[0], center[1], center[2] - 0.5);
    this.bed = grp;
    this.scene.add(grp);
  }

  setToolpath(xyz: Float32Array | null, ext: Uint8Array | null, layerStart: number[], offset: [number, number, number]) {
    if (this.path) {
      this.scene.remove(this.path);
      this.path.geometry.dispose();
    }
    this.path = null;
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
      if (ext[i]) c.setHSL(0.62 - 0.62 * (layer / layers), 0.85, 0.55);
      else c.set(0xff3b9d);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.path = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.path);
    this.showUpToLayer(layers - 1);
  }

  /** Show layers 0..layer (inclusive) and park the nozzle at the last visible point. */
  showUpToLayer(layer: number) {
    if (!this.path || !this.xyz) return;
    const n = this.xyz.length / 3;
    const end = layer + 1 < this.layerStart.length ? this.layerStart[layer + 1] : n;
    this.path.geometry.setDrawRange(0, Math.max(0, end - 1) * 2);
    const i = Math.max(0, end - 1);
    this.nozzle.position.set(
      this.xyz[i * 3] + this.offset[0],
      this.xyz[i * 3 + 1] + this.offset[1],
      this.xyz[i * 3 + 2] + this.offset[2] + 9,
    );
    this.nozzle.visible = true;
  }

  fit() {
    const box = new THREE.Box3();
    if (this.model) box.expandByObject(this.model);
    if (this.path) box.expandByObject(this.path);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.9, -1.1, 0.8).normalize().multiplyScalar(size * 1.3));
    this.camera.near = size / 200;
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
  }
}
