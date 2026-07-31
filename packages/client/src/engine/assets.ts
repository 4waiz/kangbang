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
 * Materials: models keep the metallic/roughness PBR the exporter wrote, because
 * the renderer now carries a procedural environment map for them to reflect.
 * Only on low effects quality are they flattened to Lambert. See
 * `modelMaterial()`.
 *
 * LODs: anything above ~500 triangles is exported with a decimated `*_LOD1`
 * sibling sharing the same origin. Both are in the GLB, so they must be pulled
 * apart into a `THREE.LOD` at load time - leaving them as plain siblings draws
 * the model twice, overlapping, at double the triangle cost.
 */

import {
  Box3,
  BoxGeometry,
  Color,
  FrontSide,
  Group,
  LOD,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  Sphere,
  Vector3,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { CLASSES, WEAPON_ORDER, WEAPONS } from '@kang/shared';
import { store } from '../state/store.js';

export interface LoadedAsset {
  /** Template scene; clone with `instantiate()` rather than reusing. */
  scene: Group;
  sockets: Record<string, Vector3>;
  /** Triangles at full detail - what one close-up instance costs. */
  triangles: number;
  procedural: boolean;
  /** How many nodes in this asset got a reduced-detail level. */
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
 * The full-detail node a `*_LOD<n>` object belongs to, or null.
 *
 * Two shapes have to be recognised, because glTF names the node and the mesh
 * data separately and the loader uses whichever it has:
 *
 *   - a single-material LOD arrives as one Mesh named after the *node*:
 *     `prop_x_LOD1`
 *   - a multi-material LOD arrives as a Group named after the node whose
 *     children are named after the *mesh data*: `char_titan_LOD1_mesh`,
 *     `char_titan_LOD1_mesh_1`, ...
 *
 * Matching `_LOD<n>` against mesh names alone therefore never matched a
 * multi-material model - which is all six characters and prop_pipe_run, every
 * asset that actually has an LOD. Their reduced copies were never paired and
 * rendered coincident with the original at double the triangle cost.
 */
export function lodBaseName(name: string): string | null {
  const m = /^(.+)_LOD\d+(?:_mesh(?:_\d+)?)?$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Locate the reduced-detail nodes in a loaded scene.
 *
 * Returns them keyed by the node they reduce, plus the set of every object
 * inside one, so the caller can tell a reduced copy from an original while it
 * walks the same graph for sockets, triangles and materials.
 *
 * `traverse` is parent-first, so once a `*_LOD<n>` node is found its whole
 * subtree can be claimed at once and its children skipped - they carry the same
 * name plus a `_mesh` suffix and would otherwise be picked up a second time.
 */
export function findLodNodes(scene: Group): {
  nodes: Map<string, Object3D>;
  reduced: Set<Object3D>;
} {
  const nodes = new Map<string, Object3D>();
  const reduced = new Set<Object3D>();
  scene.traverse((child) => {
    if (reduced.has(child)) return;
    const base = lodBaseName(child.name);
    if (!base) return;
    nodes.set(base, child);
    child.traverse((n) => reduced.add(n));
  });
  return { nodes, reduced };
}

const boundsScratch = new Box3();
const sphereScratch = new Sphere();

/**
 * Distance at which a node switches to its reduced-detail copy.
 *
 * Derived from the node's own bounds rather than a fixed number: a 2 m
 * character and a 0.4 m pickup should not swap at the same distance. The
 * multiplier is the point at which the decimation stops being visible at 1080p.
 *
 * Measured over the whole node, not one mesh: a multi-material model is a Group
 * of one primitive per material, and any single primitive - a visor, a grip -
 * is much smaller than the thing the player is looking at.
 */
function lodSwitchDistance(node: Object3D): number {
  boundsScratch.setFromObject(node);
  const radius = boundsScratch.isEmpty()
    ? 1
    : boundsScratch.getBoundingSphere(sphereScratch).radius;
  return Math.max(12, radius * 14);
}

/**
 * Replace each node that has a `*_LOD<n>` sibling with a `THREE.LOD` holding both.
 *
 * The generators export the decimated copy into the same GLB at the same origin,
 * so without this the renderer draws full detail and reduced detail on top of
 * each other: double the triangles, plus depth and shadow artefacts where the
 * two surfaces disagree by a millimetre.
 *
 * Levels are whole nodes rather than single meshes, because a multi-material
 * model is a Group of one primitive per material and all of them must swap
 * together.
 *
 * Returns how many nodes got a level, for the diagnostics readout.
 */
export function attachLods(scene: Group, lodNodes: Map<string, Object3D>): number {
  if (lodNodes.size === 0) return 0;
  let attached = 0;

  for (const [baseName, low] of lodNodes) {
    const high = scene.getObjectByName(baseName);
    // An orphaned LOD node (renamed base, or a generator bug) must not be left
    // in the scene: it would render as a duplicate with no matching original.
    if (!high) {
      low.parent?.remove(low);
      continue;
    }
    const parent = high.parent;
    if (!parent) continue;

    // Measured while the node is still in place, so the switch distance
    // describes the size it is actually drawn at - the scale moves to the LOD
    // below, which leaves the drawn size unchanged.
    const distance = lodSwitchDistance(high);

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
      level.traverse((n) => {
        const mesh = n as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
      });
    }

    lod.addLevel(high, 0);
    lod.addLevel(low, distance);
    parent.add(lod);
    attached++;
  }

  return attached;
}

/**
 * Draw only the front faces of a model material.
 *
 * Every material the generators export carries `doubleSided: true` - the
 * Blender default rather than a decision - so all model geometry was rasterised
 * twice: once for the surface the player can see and once for the inside of the
 * same closed solid. The back half is never visible, so culling it is free.
 *
 * Transparent materials keep whatever side they were given. A single-sided pane
 * of glass, decal or billboard vanishes when viewed from behind, and nothing
 * here can tell which of those a transparent surface is meant to be.
 */
function frontFaceOnly(mat: Material): void {
  if (mat.transparent) return;
  mat.side = FrontSide;
}

export class AssetLibrary {
  private loader = new GLTFLoader();
  private assets = new Map<string, LoadedAsset>();
  private manifest: AssetManifest | null = null;
  private materialCache = new Map<string, Material>();
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
      let triangles = 0;

      scene.updateMatrixWorld(true);
      // Found up front so the walk below can tell a reduced-detail copy from the
      // original it duplicates; the pairing itself happens after the walk.
      const lods = findLodNodes(scene);
      scene.traverse((child) => {
        if (child.name.startsWith('SOCKET_')) {
          const key = child.name.slice(7);
          sockets[key] = child.getWorldPosition(new Vector3());
          doomed.push(child);
          return;
        }
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        // Reduced copies are not counted in `triangles`, which reports what a
        // close-up instance costs - and a close-up instance draws full detail.
        if (!lods.reduced.has(mesh)) {
          const geo = mesh.geometry;
          if (geo.index) triangles += geo.index.count / 3;
          else if (geo.attributes.position) triangles += geo.attributes.position.count / 3;
        }
        const mat = mesh.material as MeshStandardMaterial | MeshStandardMaterial[];
        if (Array.isArray(mat)) mesh.material = mat.map((m) => this.modelMaterial(m));
        else if (mat) mesh.material = this.modelMaterial(mat);
      });
      for (const d of doomed) d.parent?.remove(d);
      const lodLevels = attachLods(scene, lods.nodes);

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
  // Materials
  // ---------------------------------------------------------------------

  /**
   * Prepare a material that arrived inside a GLB.
   *
   * Blender's glTF exporter always writes metallic/roughness PBR, so every model
   * arrives as a MeshStandardMaterial. Those are now kept as PBR: the renderer
   * carries a procedural environment map (see `Renderer.installEnvironment`), so
   * metalness and roughness finally have something to reflect and a barrel reads
   * as metal instead of as painted plastic. Normal and AO maps ride along for
   * free, which is what makes a detailed weapon model worth authoring at all.
   *
   * Low effects quality still takes the Lambert path. A full specular BRDF plus
   * an image-based lighting lookup per fragment is exactly what a weak GPU
   * cannot afford, and flattening also collapses the shader permutations the
   * level and the models would otherwise compile separately.
   *
   * The setting is read per material as the model loads. Models are loaded once
   * at boot, so a change mid-session takes effect on the next reload; the
   * alternative is holding every source material alive for the whole session to
   * re-derive from.
   */
  private modelMaterial(src: MeshStandardMaterial): Material {
    return store.str('effectsQuality') === 'low' ? this.toLambert(src) : this.toStandard(src);
  }

  /**
   * Keep the PBR material, with the two things a GLB cannot say for itself.
   *
   * Adjusted in place rather than copied: a copy would have to enumerate every
   * map the exporter might have written - base colour, normal, AO, metalness,
   * roughness, alpha - and would silently drop whichever one gets added next.
   *
   * Cached by the source material's uuid, because a joined mesh reuses one
   * material across many objects (and across its own LOD levels), so this must
   * run once per material rather than once per object.
   */
  private toStandard(src: MeshStandardMaterial): MeshStandardMaterial {
    const cacheKey = `standard:${src.uuid}`;
    const hit = this.materialCache.get(cacheKey);
    if (hit) return hit as MeshStandardMaterial;

    frontFaceOnly(src);
    // A transparent surface writing depth occludes what is behind it.
    if (src.transparent) src.depthWrite = false;
    this.materialCache.set(cacheKey, src);
    return src;
  }

  /**
   * Flatten a PBR material from a GLB into the cheap lit equivalent.
   *
   * Colour, emissive and the base colour map carry over; metalness, roughness
   * and the normal and AO maps are dropped, which is the point of this path -
   * it exists to get the specular and IBL work out of the fragment shader.
   *
   * Cached by the source material's uuid, for the same reason as `toStandard`.
   */
  private toLambert(src: MeshStandardMaterial): MeshLambertMaterial {
    const cacheKey = `lambert:${src.uuid}`;
    const hit = this.materialCache.get(cacheKey);
    if (hit) return hit as MeshLambertMaterial;

    const mat = new MeshLambertMaterial({
      color: src.color?.clone() ?? new Color(0xffffff),
      map: src.map ?? null,
      transparent: src.transparent,
      opacity: src.opacity,
      side: src.side,
      // A transparent surface writing depth occludes what is behind it.
      depthWrite: src.transparent ? false : src.depthWrite,
      vertexColors: src.vertexColors,
    });
    frontFaceOnly(mat);
    if (src.emissive && (src.emissive.r || src.emissive.g || src.emissive.b)) {
      mat.emissive = src.emissive.clone();
      mat.emissiveMap = src.emissiveMap ?? null;
      /*
       * Authored strength, passed through.
       *
       * This used to be clamped to just under 1.0. With no tone curve in the
       * renderer, anything brighter clipped flat to pure white, so every weapon
       * and character wore white slabs where its glowing trim should be. The
       * ACES filmic curve is back (see Renderer), and it rolls values above 1.0
       * into a shaped highlight - so the clamp now destroys detail instead of
       * saving it, and the generators' strengths are used as authored.
       */
      mat.emissiveIntensity = src.emissiveIntensity;
    }
    mat.name = src.name;
    this.materialCache.set(cacheKey, mat);
    // The Standard material and its PBR-only maps are now unreferenced; the maps
    // themselves may be shared, so only the material is disposed here.
    src.dispose();
    return mat;
  }

  // ---------------------------------------------------------------------
  // Procedural fallbacks
  // ---------------------------------------------------------------------

  private material(key: string, color: number, emissive = 0): MeshLambertMaterial {
    const hit = this.materialCache.get(key) as MeshLambertMaterial | undefined;
    if (hit) return hit;
    const mat = new MeshLambertMaterial({ color: new Color(color) });
    if (emissive) {
      mat.emissive = new Color(emissive);
      mat.emissiveIntensity = 1.4;
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
