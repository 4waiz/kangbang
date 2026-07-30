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
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointLight,
  Vector3,
  type Material,
} from 'three';
import { MATERIALS, type BrushDef, type MapDef, type MaterialDef } from '@neon/shared';
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

  // Map lights. Point lights are expensive, so they are budgeted by the effects
  // quality setting and the nearest ones win.
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

function lightBudget(): number {
  switch (store.str('effectsQuality')) {
    case 'low':
      return 6;
    case 'medium':
      return 14;
    default:
      return 28;
  }
}

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

  const mat = new MeshStandardMaterial({
    color: new Color(def.color),
    roughness: def.roughness,
    metalness: def.metalness,
    transparent,
    opacity: def.opacity,
    side: transparent ? DoubleSide : undefined,
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
  const density = 0.35;

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

      let u: number;
      let v: number;
      if (Math.abs(ny) > 0.5) {
        u = (cx + wx) * density;
        v = (cz + wz) * density;
      } else if (Math.abs(nx) > 0.5) {
        u = (cz + wz) * density;
        v = (cy + py) * density;
      } else {
        u = (cx + wx) * density;
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
  const density = 0.35;

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
