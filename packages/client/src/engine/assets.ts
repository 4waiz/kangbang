/**
 * Asset loading.
 *
 * Loads the Blender-generated GLBs listed in public/assets/manifest.json.
 * Anything missing from the manifest falls back to a procedural placeholder
 * built from the same primitives, so a partial asset build degrades the look
 * rather than producing an untextured void or a console full of 404s.
 *
 * Sockets: the generators export empties named `SOCKET_muzzle`, `SOCKET_eject`,
 * `SOCKET_grip`, `SOCKET_weapon` and `SOCKET_nameplate`. We hoist those into a
 * plain map at load time and strip them from the scene graph, so gameplay code
 * reads `asset.sockets.muzzle` instead of hunting the hierarchy every frame.
 *
 * LODs: anything above ~500 triangles is exported with a decimated `*_LOD1`
 * sibling mesh sharing the same origin. Both are in the GLB, so they must be
 * pulled apart into a `THREE.LOD` at load time - leaving them as plain siblings
 * draws the model twice, overlapping, at double the triangle cost.
 */

import {
  BoxGeometry,
  Color,
  Group,
  LOD,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { CLASSES, WEAPON_ORDER, WEAPONS } from '@kang/shared';

export interface LoadedAsset {
  /** Template scene; clone with `instantiate()` rather than reusing. */
  scene: Group;
  sockets: Record<string, Vector3>;
  /** Triangles at full detail - what one close-up instance costs. */
  triangles: number;
  procedural: boolean;
  /** How many meshes in this asset got a reduced-detail level. */
  lodLevels: number;
}

export interface AssetManifest {
  count: number;
  totalBytes: number;
  models: Record<string, { file: string; bytes: number }>;
}

export interface LoadProgress {
  loaded: number;
  total: number;
  label: string;
}

const BASE = 'assets/';

/**
 * Distance at which a mesh switches to its reduced-detail copy.
 *
 * Derived from the mesh's own bounding sphere rather than a fixed number: a 2 m
 * character and a 0.4 m pickup should not swap at the same distance. The
 * multiplier is the point at which the decimation stops being visible at 1080p.
 */
function lodSwitchDistance(mesh: Mesh): number {
  mesh.geometry.computeBoundingSphere();
  const radius = mesh.geometry.boundingSphere?.radius ?? 1;
  return Math.max(12, radius * 14);
}

/**
 * Replace each mesh that has a `*_LOD1` sibling with a `THREE.LOD` holding both.
 *
 * The generators export the decimated copy into the same GLB at the same origin,
 * so without this the renderer draws full detail and reduced detail on top of
 * each other: double the triangles, plus depth and shadow artefacts where the
 * two surfaces disagree by a millimetre.
 *
 * Returns how many meshes got a level, for the diagnostics readout.
 */
function attachLods(scene: Group, lodMeshes: Map<string, Mesh>): number {
  if (lodMeshes.size === 0) return 0;
  let attached = 0;

  for (const [baseName, low] of lodMeshes) {
    const high = scene.getObjectByName(baseName) as Mesh | undefined;
    // An orphaned LOD mesh (renamed base, or a generator bug) must not be left
    // in the scene: it would render as a duplicate with no matching original.
    if (!high?.isMesh) {
      low.parent?.remove(low);
      continue;
    }
    const parent = high.parent;
    if (!parent) continue;

    const lod = new LOD();
    lod.name = `${baseName}_lod`;
    lod.position.copy(high.position);
    lod.quaternion.copy(high.quaternion);
    lod.scale.copy(high.scale);

    // Levels sit at the LOD's own origin; the transform now lives on the LOD.
    parent.remove(high);
    low.parent?.remove(low);
    for (const level of [high, low]) {
      level.position.set(0, 0, 0);
      level.quaternion.identity();
      level.scale.set(1, 1, 1);
      level.castShadow = true;
      level.receiveShadow = false;
      level.frustumCulled = true;
    }

    lod.addLevel(high, 0);
    lod.addLevel(low, lodSwitchDistance(high));
    parent.add(lod);
    attached++;
  }

  return attached;
}

export class AssetLibrary {
  private loader = new GLTFLoader();
  private assets = new Map<string, LoadedAsset>();
  private manifest: AssetManifest | null = null;
  private materialCache = new Map<string, MeshStandardMaterial>();
  /** Names we already reported as missing, so the console stays readable. */
  private warned = new Set<string>();

  constructor() {
    // Draco is optional: the generator only uses it when Blender was built with
    // the encoder. Wiring the decoder unconditionally is harmless.
    try {
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
      draco.setDecoderConfig({ type: 'js' });
      this.loader.setDRACOLoader(draco);
    } catch {
      /* Draco unavailable; uncompressed GLBs still load. */
    }
  }

  /** Load the manifest and every model it lists. */
  async loadAll(onProgress?: (p: LoadProgress) => void): Promise<void> {
    try {
      const res = await fetch(`${BASE}manifest.json`, { cache: 'no-cache' });
      if (res.ok) this.manifest = (await res.json()) as AssetManifest;
    } catch {
      this.manifest = null;
    }

    const names = this.manifest ? Object.keys(this.manifest.models) : [];
    if (names.length === 0) {
      onProgress?.({ loaded: 1, total: 1, label: 'procedural fallback' });
      return;
    }

    // Load the models needed on the first frame first, so the boot screen can
    // hand over before the long tail of props finishes.
    const priority = new Set<string>([
      'char_arms_fp',
      ...WEAPON_ORDER.map((w) => `wpn_${w}`),
      ...Object.keys(CLASSES).map((c) => `char_${c}`),
    ]);
    const ordered = [...names].sort((a, b) => Number(priority.has(b)) - Number(priority.has(a)));

    let loaded = 0;
    const total = ordered.length;
    // Six at a time: enough to saturate the connection without starving the
    // main thread of parse time during the boot animation.
    const concurrency = 6;
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(
        (async () => {
          while (cursor < ordered.length) {
            const index = cursor++;
            const name = ordered[index];
            await this.loadOne(name);
            loaded++;
            onProgress?.({ loaded, total, label: name });
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  private async loadOne(name: string): Promise<void> {
    const entry = this.manifest?.models[name];
    if (!entry) return;
    try {
      const gltf = await this.loader.loadAsync(`${BASE}${entry.file}`);
      const scene = gltf.scene as Group;
      const sockets: Record<string, Vector3> = {};
      const doomed: Object3D[] = [];
      /** `*_LOD1` meshes, keyed by the base name they belong to. */
      const lodMeshes = new Map<string, Mesh>();
      let triangles = 0;

      scene.updateMatrixWorld(true);
      scene.traverse((child) => {
        if (child.name.startsWith('SOCKET_')) {
          const key = child.name.slice(7);
          sockets[key] = child.getWorldPosition(new Vector3());
          doomed.push(child);
          return;
        }
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const lodMatch = /^(.*)_LOD(\d+)$/.exec(mesh.name);
        if (lodMatch) {
          // Held back and paired with its full-detail sibling below. Not counted
          // in `triangles`, which reports what a close-up instance costs.
          lodMeshes.set(lodMatch[1], mesh);
          return;
        }
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        const geo = mesh.geometry;
        if (geo.index) triangles += geo.index.count / 3;
        else if (geo.attributes.position) triangles += geo.attributes.position.count / 3;
        // Emissive materials from Blender come through with a strength we want
        // to keep, but they must not be tone-mapped or they read as grey.
        const mat = mesh.material as MeshStandardMaterial | MeshStandardMaterial[];
        const fix = (m: MeshStandardMaterial) => {
          if (m.emissiveIntensity > 1.5) m.toneMapped = false;
          if (m.transparent) m.depthWrite = false;
        };
        if (Array.isArray(mat)) mat.forEach(fix);
        else if (mat) fix(mat);
      });
      for (const d of doomed) d.parent?.remove(d);
      const lodLevels = attachLods(scene, lodMeshes);

      this.assets.set(name, {
        scene,
        sockets,
        triangles: Math.round(triangles),
        procedural: false,
        lodLevels,
      });
    } catch (err) {
      if (!this.warned.has(name)) {
        this.warned.add(name);
        // eslint-disable-next-line no-console
        console.warn(`[assets] could not load ${name}, using placeholder`, err);
      }
    }
  }

  has(name: string): boolean {
    return this.assets.has(name);
  }

  get(name: string): LoadedAsset | null {
    return this.assets.get(name) ?? null;
  }

  /**
   * Fresh instance of an asset, ready to add to a scene.
   * Materials are shared (cloning them would multiply draw calls); geometry is
   * shared too, so an instance is just a new node hierarchy.
   */
  instantiate(name: string): Group {
    const asset = this.assets.get(name);
    if (asset) {
      const clone = asset.scene.clone(true);
      clone.name = name;
      return clone;
    }
    if (!this.warned.has(name)) {
      this.warned.add(name);
      // eslint-disable-next-line no-console
      console.warn(`[assets] ${name} missing - procedural placeholder in use`);
    }
    return this.placeholder(name);
  }

  socketOf(name: string, socket: string, fallback: Vector3): Vector3 {
    const asset = this.assets.get(name);
    const v = asset?.sockets[socket];
    return v ? v.clone() : fallback.clone();
  }

  stats(): { models: number; triangles: number; procedural: number; lods: number } {
    let triangles = 0;
    let procedural = 0;
    let lods = 0;
    for (const a of this.assets.values()) {
      triangles += a.triangles;
      lods += a.lodLevels;
      if (a.procedural) procedural++;
    }
    return { models: this.assets.size, triangles, procedural, lods };
  }

  // ---------------------------------------------------------------------
  // Procedural fallbacks
  // ---------------------------------------------------------------------

  private material(key: string, color: number, emissive = 0, metalness = 0.6, roughness = 0.4): MeshStandardMaterial {
    const hit = this.materialCache.get(key);
    if (hit) return hit;
    const mat = new MeshStandardMaterial({
      color: new Color(color),
      metalness,
      roughness,
    });
    if (emissive) {
      mat.emissive = new Color(emissive);
      mat.emissiveIntensity = 2;
      mat.toneMapped = false;
    }
    this.materialCache.set(key, mat);
    return mat;
  }

  private box(
    group: Group,
    key: string,
    color: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    emissive = 0,
  ): void {
    const mesh = new Mesh(new BoxGeometry(w, h, d), this.material(key, color, emissive));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  }

  /**
   * Blocked-out stand-in with the right proportions.
   *
   * This is intentionally recognisable rather than a magenta error box: if an
   * asset fails to load in production the game stays playable and the shape
   * still communicates what it is.
   */
  private placeholder(name: string): Group {
    const g = new Group();
    g.name = `${name}:placeholder`;

    if (name.startsWith('wpn_')) {
      const id = name.replace(/^wpn_/, '').replace(/_world$/, '');
      const def = WEAPONS[id];
      const long = def ? Math.min(0.9, 0.25 + def.range / 400) : 0.5;
      this.box(g, 'ph_body', 0x3a4352, 0, 0, -long * 0.4, 0.07, 0.09, long * 0.8);
      this.box(g, 'ph_trim', 0x14181f, 0, -0.05, 0.06, 0.04, 0.11, 0.05);
      this.box(g, 'ph_barrel', 0x14181f, 0, 0.01, -long * 0.85, 0.025, 0.025, long * 0.35);
      this.box(g, 'ph_glow', 0x0f2a33, 0, 0.02, -long, 0.03, 0.03, 0.02, def?.fx.tracerColor ?? 0x2ce8ff);
      return g;
    }

    if (name.startsWith('char_')) {
      const id = name.replace(/^char_/, '');
      const cls = CLASSES[id];
      const heavy = cls?.visual.build === 'heavy';
      const light = cls?.visual.build === 'light';
      const w = heavy ? 0.56 : light ? 0.36 : 0.44;
      const accent = cls?.visual.accent ?? 0x2ce8ff;
      this.box(g, 'ph_torso', 0x3a4352, 0, 1.15, 0, w, 0.62, 0.26);
      this.box(g, 'ph_head', 0x2a323f, 0, 1.62, 0, 0.22, 0.24, 0.22);
      this.box(g, 'ph_visor', 0x0a1014, 0, 1.64, -0.12, 0.18, 0.06, 0.03, accent);
      for (const side of [-1, 1]) {
        this.box(g, 'ph_arm', 0x2a323f, side * (w / 2 + 0.06), 1.2, 0, 0.1, 0.5, 0.1);
        this.box(g, 'ph_leg', 0x2a323f, side * 0.12, 0.45, 0, 0.13, 0.9, 0.15);
      }
      this.box(g, 'ph_team', 0x123a44, 0, 1.35, -0.14, 0.16, 0.06, 0.02, accent);
      return g;
    }

    if (name.startsWith('pickup_')) {
      const color = name.includes('health') ? 0x8dff4a : name.includes('shield') ? 0x2ce8ff : 0xffb03a;
      this.box(g, 'ph_pickup', 0x2a323f, 0, 0, 0, 0.45, 0.45, 0.28);
      this.box(g, 'ph_pickup_glow', 0x101820, 0, 0, -0.16, 0.3, 0.3, 0.03, color);
      return g;
    }

    if (name.startsWith('dep_')) {
      this.box(g, 'ph_dep', 0x2a323f, 0, 0.3, 0, 0.5, 0.6, 0.5);
      this.box(g, 'ph_dep_glow', 0x101820, 0, 0.62, 0, 0.3, 0.08, 0.3, 0x2ce8ff);
      return g;
    }

    if (name.startsWith('obj_')) {
      this.box(g, 'ph_obj', 0x2a323f, 0, 0.5, 0, 0.6, 1.0, 0.6);
      this.box(g, 'ph_obj_glow', 0x101820, 0, 1.05, 0, 0.5, 0.1, 0.5, 0x2ce8ff);
      return g;
    }

    // Generic prop: a simple crate so the level does not look empty.
    this.box(g, 'ph_prop', 0x4a5364, 0, 0.5, 0, 1, 1, 1);
    this.box(g, 'ph_prop_trim', 0x14181f, 0, 0.5, 0, 1.03, 0.12, 1.03);
    return g;
  }

  dispose(): void {
    for (const asset of this.assets.values()) {
      asset.scene.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const m = mesh.material as Material | Material[];
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      });
    }
    this.assets.clear();
    for (const mat of this.materialCache.values()) mat.dispose();
    this.materialCache.clear();
  }
}

export const assets = new AssetLibrary();
