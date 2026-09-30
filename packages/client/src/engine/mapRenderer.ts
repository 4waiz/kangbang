/**
 * Map geometry.
 *
 * Brushes are merged into ONE geometry per material. A map is ~700 brushes; as
 * individual meshes that is 700 draw calls, which is the single biggest frame
 * cost in a level like this. Merged, the whole level renders in roughly a dozen
 * calls with full frustum culling still working per material chunk.
 *
 * Wedges are built as real 6-vertex prisms rather than scaled boxes so the
 * visible slope matches the collision slope exactly - if these two ever
 * disagree, players slide on air.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PointLight,
  Vector3,
  type Material,
} from 'three';
import { MATERIALS, type BrushDef, type MapDef, type MaterialDef } from '@kang/shared';
import { store } from '../state/store.js';
import { materialTexture, type TextureQuality } from './textures.js';

interface Batch {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  vertexCount: number;
}

function newBatch(): Batch {
  return { positions: [], normals: [], uvs: [], indices: [], vertexCount: 0 };
}

/** Six face definitions: normal + the four corners in local unit space. */
const BOX_FACES: { n: [number, number, number]; c: [number, number, number][] }[] = [
  { n: [0, 1, 0], c: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] }, // +Y top
  { n: [0, -1, 0], c: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] }, // -Y bottom
  { n: [0, 0, 1], c: [[-1, -1, 1], [-1, 1, 1], [1, 1, 1], [1, -1, 1]] }, // +Z
  { n: [0, 0, -1], c: [[1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, -1]] }, // -Z
  { n: [1, 0, 0], c: [[1, -1, 1], [1, 1, 1], [1, 1, -1], [1, -1, -1]] }, // +X
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]] }, // -X
];

export interface MapMeshes {
  root: Group;
  /** Per-material meshes, for debugging and stats. */
  meshes: Mesh[];
  lights: PointLight[];
  triangles: number;
  dispose(): void;
}

export function buildMapMeshes(def: MapDef): MapMeshes {
  const quality = store.str('textureQuality') as TextureQuality;
  const batches = new Map<string, Batch>();
  const neonBoost = def.ambience.neonBoost;

  for (const brush of def.brushes) {
    // Collision-only hull: a Blender model is drawn over it instead. See the
    // note on `noDraw` in world.ts.
    if (brush.noDraw) continue;
    const key = brush.m;
    let batch = batches.get(key);
    if (!batch) {
      batch = newBatch();
      batches.set(key, batch);
    }
    if (brush.t === 'ramp') appendWedge(batch, brush);
    else appendBox(batch, brush);
  }

  const root = new Group();
  root.name = `map:${def.id}`;
  const meshes: Mesh[] = [];
  let triangles = 0;
  const shadowsOn = store.str('shadowQuality') !== 'off';

  for (const [key, batch] of batches) {
    if (batch.vertexCount === 0) continue;
    const matDef = MATERIALS[key] ?? MATERIALS.concrete;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(batch.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(batch.normals), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(batch.uvs), 2));
    geometry.setIndex(batch.indices);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    const material = makeMaterial(key, matDef, quality, neonBoost);
    const mesh = new Mesh(geometry, material);
    mesh.name = `mat:${key}`;
    // Emissive trims and glass never need to cast shadows, and skipping them
    // roughly halves the shadow pass cost.
    const decorative = matDef.emissiveIntensity > 0.8 || matDef.opacity < 1;
    mesh.castShadow = shadowsOn && !decorative;
    mesh.receiveShadow = shadowsOn && matDef.opacity >= 1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    meshes.push(mesh);
    triangles += batch.indices.length / 3;
  }

  /*
   * Map lights, budgeted, brightest first.
   *
   * The brightest win, not the nearest - the comment here used to claim
   * otherwise while the sort said intensity. Intensity is the right key and
   * distance is not available to it: this set is chosen once when the map is
   * built and then never revisited, so "nearest" would mean nearest to wherever
   * the player happened to spawn, and would be wrong from the first second of
   * movement. Re-sorting per frame is not an option either, because changing
   * which lights are visible is precisely what triggers the shader recompiles
   * `lightBudget` exists to avoid.
   */
  const lights: PointLight[] = [];
  const budget = lightBudget();
  const sorted = [...def.lights].sort((a, b) => b.intensity - a.intensity).slice(0, budget);
  for (const l of sorted) {
    const light = new PointLight(l.color, l.intensity, l.range, 2);
    light.position.set(l.p[0], l.p[1], l.p[2]);
    light.castShadow = false;
    root.add(light);
    lights.push(light);
  }

  return {
    root,
    meshes,
    lights,
    triangles,
    dispose() {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        const m = mesh.material as Material | Material[];
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
      root.clear();
    },
  };
}

/**
 * How many of a map's point lights are actually placed.
 *
 * These numbers are small on purpose, and the reason is not fill rate.
 *
 * three.js's forward renderer does no light culling: every visible light is
 * evaluated by every fragment of every lit material, whether or not it is
 * within range. Worse, the *count* of visible lights is baked into the shader
 * program cache key, so the level's ~20 materials and the models' ~200 are
 * compiled per distinct light count. At 28 map lights plus one light per
 * effects-pool slot, over a hundred lights could be visible at once and the
 * count changed with every muzzle flash - which recompiled several hundred
 * programs mid-firefight. That is the stutter, and it arrives exactly when a
 * fight starts.
 *
 * 4/6/8 keeps the fragment cost bounded and, with the effects lights now fixed
 * in number (see `FxSystem`), keeps the visible-light count constant for the
 * whole life of a map: programs are compiled once, at load, and never again.
 * The maps are lit mostly by the sun and hemisphere anyway; these are accents.
 */
function lightBudget(): number {
  switch (store.str('effectsQuality')) {
    case 'low':
      return 4;
    case 'medium':
      return 6;
    default:
      return 8;
  }
}

/**
 * Materials that are decoration on top of another surface rather than structure.
 * Listed explicitly because the geometry cannot tell us: a 4cm-thick brush might
 * be a painted stripe or a genuine kerb, and only the material says which.
 */
const OVERLAY_MATERIALS = new Set([
  'neonCyan',
  'neonMagenta',
  'neonAmber',
  'neonLime',
  'hazard',
  'teamIon',
  'teamEmber',
  'holo',
  'trim',
]);

function makeMaterial(key: string, def: MaterialDef, quality: TextureQuality, neonBoost: number): Material {
  const transparent = def.opacity < 1;
  const emissiveStrength = def.emissiveIntensity * neonBoost;

  // Pure emissive trims are drawn unlit and additively: they are light sources,
  // not surfaces, and a standard material makes them read as dull plastic.
  if (def.emissiveIntensity >= 2 && def.opacity >= 1) {
    return new MeshBasicMaterial({
      color: new Color(def.emissive),
      toneMapped: false,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: true,
      fog: true,
    });
  }

  /**
   * Lambert rather than Standard, deliberately.
   *
   * The grounded palette is non-metallic, so the metalness/roughness half of the
   * PBR model has nothing to describe: a painted wall is diffuse. Lambert drops
   * the whole specular and IBL path, which means fewer shader permutations to
   * compile (93 programs before) and a measurably cheaper fragment shader on
   * integrated GPUs. The renderer's environment map is procedural and free, but
   * a Lambert material never samples it, so the level pays nothing for it.
   *
   * What is lost is the specular highlight on the few semi-metallic surfaces -
   * girders and grating. At the brightness this art direction runs at, that
   * highlight was not carrying any readability.
   */
  const mat = new MeshLambertMaterial({
    color: new Color(def.color),
    transparent,
    opacity: def.opacity,
    // Explicit FrontSide rather than `undefined`: three.js reports every
    // undefined constructor parameter as a warning, and a brush is a closed
    // solid, so front-facing is what it would have defaulted to anyway.
    side: transparent ? DoubleSide : FrontSide,
    depthWrite: !transparent,
    flatShading: false,
  });
  if (def.emissive !== 0) {
    mat.emissive = new Color(def.emissive);
    mat.emissiveIntensity = emissiveStrength;
  }
  if (quality !== 'low' || def.pattern !== 'plain') {
    const tex = materialTexture(key, quality);
    mat.map = tex;
    if (def.emissive !== 0 && def.emissiveIntensity < 2) mat.emissiveMap = tex;
  }

  /*
   * Overlay materials get a depth bias toward the viewer.
   *
   * The maps place decoration a few millimetres proud of the surface behind it,
   * which the depth buffer cannot reliably separate at range - over a thousand
   * overlapping coplanar face pairs per map, appearing as shimmer and dotted
   * seams. A polygon offset makes the overlay win deterministically instead of by
   * luck of rounding, which beats nudging hundreds of brushes by hand.
   */
  if (OVERLAY_MATERIALS.has(key)) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
  }
  return mat;
}

// ---------------------------------------------------------------------------
// Geometry emitters
// ---------------------------------------------------------------------------

const tmp = new Vector3();

function appendBox(batch: Batch, brush: BrushDef): void {
  const [cx, cy, cz] = brush.p;
  const [hx, hy, hz] = brush.s;
  const yaw = ((brush.ry ?? 0) * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // World-space texel density so a 1m wall and a 20m floor share a scale.
  // 0.5 puts one tile every 2m, which lands on the grid the maps are built to;
  // the previous 0.35 tiled every 2.857m and so never aligned with a wall edge.
  const density = 0.5;

  for (const face of BOX_FACES) {
    const base = batch.vertexCount;
    // Choose UV axes from the dominant normal component.
    const [nx, ny, nz] = face.n;
    for (let i = 0; i < 4; i++) {
      const [lx, ly, lz] = face.c[i];
      const px = lx * hx;
      const py = ly * hy;
      const pz = lz * hz;
      // local -> world (yaw rotation about Y)
      const wx = px * cos + pz * sin;
      const wz = -px * sin + pz * cos;
      batch.positions.push(cx + wx, cy + py, cz + wz);

      const wnx = nx * cos + nz * sin;
      const wnz = -nx * sin + nz * cos;
      batch.normals.push(wnx, ny, wnz);

      /*
       * Project onto the face's own tangent frame, not onto world axes.
       *
       * Using world position against world axes is only correct when the brush is
       * axis-aligned. On a yaw-rotated brush the in-plane distance along the face
       * does not match the world axis it is measured against, so the pattern
       * compresses by 1/cos(yaw) - 1.41x at 45 degrees - and visibly fails to
       * line up with the surface. Projecting onto the rotated tangent cancels the
       * rotation and leaves true surface distance plus a constant world offset,
       * so neighbouring unrotated brushes still share a continuous tile.
       */
      const alongLocalX = cx * cos - cz * sin + px;
      const alongLocalZ = cx * sin + cz * cos + pz;
      let u: number;
      let v: number;
      if (Math.abs(ny) > 0.5) {
        u = alongLocalX * density;
        v = alongLocalZ * density;
      } else if (Math.abs(nx) > 0.5) {
        u = alongLocalZ * density;
        v = (cy + py) * density;
      } else {
        u = alongLocalX * density;
        v = (cy + py) * density;
      }
      batch.uvs.push(u, v);
    }
    batch.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    batch.vertexCount += 4;
  }
}

/**
 * Triangular prism matching the collision wedge exactly.
 * The sloped face runs from the low edge to the high edge along the rise axis.
 */
function appendWedge(batch: Batch, brush: BrushDef): void {
  const [cx, cy, cz] = brush.p;
  const [hx, hy, hz] = brush.s;
  const yaw = ((brush.ry ?? 0) * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dir = brush.d ?? '+x';
  const alongX = dir === '+x' || dir === '-x';
  const sign = dir === '+x' || dir === '+z' ? 1 : -1;
  const density = 0.5;

  // Local corners: bottom rectangle at -hy, top edge at +hy on the high side.
  // Rise axis coordinate `a`, cross axis `b`.
  const halfA = alongX ? hx : hz;
  const halfB = alongX ? hz : hx;

  const local = (a: number, y: number, b: number): [number, number, number] =>
    alongX ? [a, y, b] : [b, y, a];

  const lowA = -sign * halfA;
  const highA = sign * halfA;

  // 6 vertices: 4 on the bottom, 2 on the top edge above the high side.
  const verts: [number, number, number][] = [
    local(lowA, -hy, -halfB), // 0 bottom low  -b
    local(lowA, -hy, halfB), // 1 bottom low  +b
    local(highA, -hy, halfB), // 2 bottom high +b
    local(highA, -hy, -halfB), // 3 bottom high -b
    local(highA, hy, -halfB), // 4 top high -b
    local(highA, hy, halfB), // 5 top high +b
  ];

  const faces: { idx: number[]; n: [number, number, number] }[] = [];
  // Bottom (normal -Y), wound so it faces down.
  faces.push({ idx: [0, 3, 2, 0, 2, 1], n: [0, -1, 0] });
  // Vertical back face at the high end.
  faces.push({
    idx: [3, 4, 5, 3, 5, 2],
    n: alongX ? [sign, 0, 0] : [0, 0, sign],
  });
  // Sloped face from the low edge up to the top edge.
  const slopeN = wedgeNormal(alongX, sign, halfA, hy);
  faces.push({ idx: [0, 1, 5, 0, 5, 4], n: slopeN });
  // Two triangular sides.
  faces.push({ idx: [0, 4, 3], n: alongX ? [0, 0, -1] : [-1, 0, 0] });
  faces.push({ idx: [1, 2, 5], n: alongX ? [0, 0, 1] : [1, 0, 0] });

  /*
   * Flip the winding when the ramp rises toward -x or -z.
   *
   * `lowA`/`highA` swap with `sign`, which mirrors the whole vertex set - and
   * mirroring reverses winding. The index lists above are only correct for
   * sign = +1; at sign = -1 every face came out wound backwards, so with
   * backface culling on, every '-x' and '-z' ramp rendered with its sides,
   * bottom and back missing. In game that looks like a ramp you can see
   * straight through, or a slope floating with no body under it.
   *
   * The declared normals are unaffected: they describe the true outward
   * direction and are already right for both signs. Only the triangle order
   * has to be reversed.
   */
  if (sign < 0) {
    for (const face of faces) {
      for (let i = 0; i + 2 < face.idx.length; i += 3) {
        const swap = face.idx[i + 1];
        face.idx[i + 1] = face.idx[i + 2];
        face.idx[i + 2] = swap;
      }
    }
  }

  for (const face of faces) {
    // Each face gets its own vertices so normals stay flat.
    const start = batch.vertexCount;
    const used: number[] = [];
    const map = new Map<number, number>();
    for (const vi of face.idx) {
      if (!map.has(vi)) {
        map.set(vi, start + used.length);
        used.push(vi);
      }
    }
    for (const vi of used) {
      const [lx, ly, lz] = verts[vi];
      const wx = lx * cos + lz * sin;
      const wz = -lx * sin + lz * cos;
      batch.positions.push(cx + wx, cy + ly, cz + wz);
      const wnx = face.n[0] * cos + face.n[2] * sin;
      const wnz = -face.n[0] * sin + face.n[2] * cos;
      tmp.set(wnx, face.n[1], wnz).normalize();
      batch.normals.push(tmp.x, tmp.y, tmp.z);
      if (Math.abs(face.n[1]) > 0.4) {
        batch.uvs.push((cx + wx) * density, (cz + wz) * density);
      } else if (Math.abs(face.n[0]) > 0.4) {
        batch.uvs.push((cz + wz) * density, (cy + ly) * density);
      } else {
        batch.uvs.push((cx + wx) * density, (cy + ly) * density);
      }
    }
    for (const vi of face.idx) {
      batch.indices.push(map.get(vi) as number);
    }
    batch.vertexCount += used.length;
  }
}

function wedgeNormal(alongX: boolean, sign: number, halfA: number, hy: number): [number, number, number] {
  // Surface rises `2*hy` over `2*halfA`; the outward normal tilts away from the
  // rise direction.
  const slope = hy / halfA;
  const inv = 1 / Math.sqrt(1 + slope * slope);
  const a = -sign * slope * inv;
  return alongX ? [a, inv, 0] : [0, inv, a];
}
