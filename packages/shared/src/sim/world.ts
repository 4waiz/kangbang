/**
 * Collision world.
 *
 * Maps are authored as a list of convex brushes (yaw-rotated boxes and wedges).
 * The exact same brush list drives:
 *   - client rendering (instanced meshes per material)
 *   - client movement prediction
 *   - server authoritative movement + hit traces
 *   - the Blender generator (assets/scripts/gen_maps.py reads the exported JSON)
 *
 * Keeping one source of truth is what stops "invisible walls" and
 * "shoot-through-geometry" bugs from ever existing.
 */

import { EPSILON, clamp, type Vec3 } from '../math.js';

export type BrushKind = 'box' | 'ramp';
export type RampDir = '+x' | '-x' | '+z' | '-z';

/** Authoring-time brush description (what map files contain). */
export interface BrushDef {
  t: BrushKind;
  /** Centre of the bounding volume. */
  p: [number, number, number];
  /** Half extents. */
  s: [number, number, number];
  /** Yaw in degrees. */
  ry?: number;
  /** Render material key (see MATERIALS). */
  m: string;
  /** Surface key for impact FX / footstep audio. Defaults to the material's. */
  sf?: string;
  /** Rise direction for wedges. */
  d?: RampDir;
  /** Decoration only - never collides, never blocks bullets. */
  ghost?: boolean;
  /** Emissive intensity override. */
  glow?: number;
  /** Bullets pass through (glass panes that are still solid to players). */
  penetrable?: boolean;
  /** Skip in the minimap render (ceilings, high catwalk undersides). */
  noMinimap?: boolean;
}

/** Runtime brush with precomputed rotation + AABB. */
export interface Brush {
  kind: 0 | 1; // 0 box, 1 ramp
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  cos: number;
  sin: number;
  rotated: boolean;
  /** 0 = rises along local X, 1 = rises along local Z. */
  rampAxis: 0 | 1;
  rampSign: 1 | -1;
  surface: string;
  material: string;
  solid: boolean;
  penetrable: boolean;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  index: number;
}

export interface SpawnPointDef {
  p: [number, number, number];
  yaw: number;
  /** 0 = any team. */
  team?: number;
  /** Optional tag so modes can pick contextual spawns ("attack", "defend"). */
  tag?: string;
}

export interface PickupDef {
  id: string;
  kind: 'weapon' | 'ammo' | 'health' | 'shield';
  /** Weapon id when kind === 'weapon'. */
  weapon?: string;
  amount?: number;
  p: [number, number, number];
  respawnSec: number;
}

export interface ObjectiveAnchorDef {
  id: string;
  kind: 'zone' | 'hardpoint' | 'core' | 'flagpoint';
  p: [number, number, number];
  radius: number;
  label: string;
  /** Owning team for core/flag home locations. */
  team?: number;
  /** Ordering for hardpoint rotation. */
  order?: number;
}

export interface PropInstanceDef {
  /** GLB asset key, resolved through the asset manifest. */
  asset: string;
  p: [number, number, number];
  ry?: number;
  scale?: number;
  /** Optional tint applied to the emissive channel. */
  tint?: number;
}

export interface LightDef {
  kind: 'point' | 'spot' | 'strip';
  p: [number, number, number];
  color: number;
  intensity: number;
  range: number;
  /** For strips: half extent along X/Z used to place an emissive quad. */
  s?: [number, number, number];
  ry?: number;
}

export interface NavNodeDef {
  p: [number, number, number];
  /** Indices of connected nodes. Generated automatically if omitted. */
  links?: number[];
  /** Tactical hints for bots. */
  cover?: boolean;
  sniper?: boolean;
  height?: 'low' | 'mid' | 'high';
}

export interface MapAmbience {
  skybox: string;
  fogColor: number;
  fogDensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  sunDir: [number, number, number];
  ambientLoop: string;
  /** Global emissive multiplier for neon accents. */
  neonBoost: number;
}

export interface MapDef {
  id: string;
  name: string;
  tagline: string;
  /** Recommended modes. */
  modes: string[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Below this Y the player is killed (pits) - always visually telegraphed. */
  killY: number;
  brushes: BrushDef[];
  spawns: SpawnPointDef[];
  objectives: ObjectiveAnchorDef[];
  pickups: PickupDef[];
  props: PropInstanceDef[];
  lights: LightDef[];
  nav: NavNodeDef[];
  ambience: MapAmbience;
}

// ---------------------------------------------------------------------------
// Materials - single source of truth for renderer + audio + minimap
// ---------------------------------------------------------------------------

export interface MaterialDef {
  color: number;
  /** Emissive colour, 0 for none. */
  emissive: number;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
  opacity: number;
  surface: string;
  /** Minimap tint; 0 to omit from the minimap. */
  minimap: number;
  /** Procedural detail pattern applied by the client's texture generator. */
  pattern: 'plain' | 'panel' | 'grid' | 'grate' | 'hazard' | 'circuit' | 'glass' | 'noise';
}

export const MATERIALS: Record<string, MaterialDef> = {
  // --- Art direction -------------------------------------------------------
  //
  // Grounded and industrial rather than science fiction: warehouses, service
  // corridors, offices, street level. Bright and high-key, because picking a
  // silhouette out of a doorway instantly matters more competitively than any
  // amount of surface detail.
  //
  // Two deliberate constraints, both of which also keep memory down:
  //
  //   `metalness` is 0 almost everywhere. Metallic PBR needs an environment map
  //   to reflect or it renders black, and that environment map was the single
  //   largest object in the process at 12 MB. Painted, coated and cast surfaces
  //   are genuinely non-metallic, so dropping it is accurate as well as cheap.
  //
  //   Emissive is reserved for things that actually emit: ceiling fixtures,
  //   signage, screens. Everything else reads by albedo under real lighting.
  //   Glowing trim on every surface is what made the old look sci-fi.
  //
  // `surface` drives footstep and impact audio and is encoded in the wire
  // protocol, so those values are load-bearing. Change a colour freely; changing
  // a surface changes what players hear.

  // Floors.
  floorPlate: { color: 0xb9bcc0, emissive: 0, emissiveIntensity: 0, roughness: 0.82, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x6e7377, pattern: 'panel' },
  floorLight: { color: 0xcfd3d7, emissive: 0, emissiveIntensity: 0, roughness: 0.78, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x80868b, pattern: 'grid' },
  concrete: { color: 0xa8aaa6, emissive: 0, emissiveIntensity: 0, roughness: 0.94, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x646660, pattern: 'noise' },

  // Walls. Off-white above, painted band below: the standard industrial two-tone,
  // and it gives the eye a horizon line indoors.
  wallLight: { color: 0xe6e7e4, emissive: 0, emissiveIntensity: 0, roughness: 0.88, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x8f918d, pattern: 'panel' },
  wallDark: { color: 0x4a5560, emissive: 0, emissiveIntensity: 0, roughness: 0.85, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x2f363d, pattern: 'panel' },
  cityWall: { color: 0x9a958c, emissive: 0, emissiveIntensity: 0, roughness: 0.9, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x5e5a54, pattern: 'panel' },

  /**
   * Ceiling fixtures, and the only strongly emissive material left. The
   * interiors are enclosed, so without emitting fixtures the only light reaching
   * the floor is the point-light budget, which is six lights for a 72 m room on
   * low effects quality.
   */
  lampPanel: { color: 0xffffff, emissive: 0xfff6e2, emissiveIntensity: 0.85, roughness: 0.4, metalness: 0, opacity: 1, surface: 'panel', minimap: 0, pattern: 'plain' },

  // Structure: galvanised steel and painted girders. A little metalness for the
  // sheen, not enough to need anything to reflect.
  hull: { color: 0x8d9298, emissive: 0, emissiveIntensity: 0, roughness: 0.62, metalness: 0.12, opacity: 1, surface: 'metal', minimap: 0x565b60, pattern: 'panel' },
  trim: { color: 0x3a3f45, emissive: 0, emissiveIntensity: 0, roughness: 0.6, metalness: 0.1, opacity: 1, surface: 'metal', minimap: 0x24282c, pattern: 'plain' },
  grate: { color: 0x6e7378, emissive: 0, emissiveIntensity: 0, roughness: 0.72, metalness: 0.15, opacity: 1, surface: 'grate', minimap: 0x44484c, pattern: 'grate' },

  // Cargo: shipping containers and crates, in the colours they actually come in.
  crate: { color: 0xb5771f, emissive: 0, emissiveIntensity: 0, roughness: 0.8, metalness: 0.06, opacity: 1, surface: 'panel', minimap: 0x7a5015, pattern: 'panel' },
  crateAlt: { color: 0x2f5d8c, emissive: 0, emissiveIntensity: 0, roughness: 0.8, metalness: 0.06, opacity: 1, surface: 'panel', minimap: 0x1f3e5e, pattern: 'panel' },

  // Safety-yellow floor marking and hazard tape.
  hazard: { color: 0xe8c22a, emissive: 0, emissiveIntensity: 0, roughness: 0.7, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x9c831c, pattern: 'hazard' },

  glass: { color: 0xcfe0e6, emissive: 0, emissiveIntensity: 0, roughness: 0.1, metalness: 0, opacity: 0.2, surface: 'glass', minimap: 0, pattern: 'glass' },
  cityGlass: { color: 0x7f97a4, emissive: 0, emissiveIntensity: 0, roughness: 0.16, metalness: 0.1, opacity: 0.5, surface: 'glass', minimap: 0x4e5d66, pattern: 'glass' },

  /**
   * Accent keys, kept under their original names because every map references
   * them. They are painted markings, signage and warning lamps now rather than
   * neon: low emissive, so they read as real objects under real light. The four
   * still read apart at a glance, which is what the maps use them for.
   */
  neonCyan: { color: 0x2f7fa8, emissive: 0x2f7fa8, emissiveIntensity: 0.35, roughness: 0.6, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x2a5f78, pattern: 'plain' },
  neonMagenta: { color: 0xb2373f, emissive: 0xb2373f, emissiveIntensity: 0.35, roughness: 0.6, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x78262c, pattern: 'plain' },
  neonAmber: { color: 0xd98722, emissive: 0xd98722, emissiveIntensity: 0.4, roughness: 0.6, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x8f5a17, pattern: 'plain' },
  neonLime: { color: 0x3f9e4f, emissive: 0x3f9e4f, emissiveIntensity: 0.45, roughness: 0.6, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x2b6a36, pattern: 'plain' },

  // Team markings: painted stencils, blue and red, high contrast against grey.
  teamIon: { color: 0x2b6ea8, emissive: 0x1b4a72, emissiveIntensity: 0.25, roughness: 0.72, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x1f5280, pattern: 'panel' },
  teamEmber: { color: 0xb04430, emissive: 0x73281a, emissiveIntensity: 0.25, roughness: 0.72, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x7d3020, pattern: 'panel' },

  // Gameplay volumes that have to read as artificial. This is the one place a
  // slight glow is right: a barrier you can shoot through has no real-world
  // referent, so it should look like an overlay rather than a wall.
  forcefield: { color: 0x9fd0e8, emissive: 0x9fd0e8, emissiveIntensity: 0.5, roughness: 0.2, metalness: 0, opacity: 0.12, surface: 'panel', minimap: 0, pattern: 'grid' },
  reactor: { color: 0x6f757a, emissive: 0xd9a13c, emissiveIntensity: 0.6, roughness: 0.55, metalness: 0.1, opacity: 1, surface: 'metal', minimap: 0x4a5054, pattern: 'panel' },
  holo: { color: 0xdfe6ea, emissive: 0xa8c4d4, emissiveIntensity: 0.55, roughness: 0.5, metalness: 0, opacity: 0.4, surface: 'panel', minimap: 0, pattern: 'grid' },

  conveyor: { color: 0x2b2e31, emissive: 0, emissiveIntensity: 0, roughness: 0.96, metalness: 0, opacity: 1, surface: 'rubber', minimap: 0x1e2123, pattern: 'grate' },
  asphalt: { color: 0x44474a, emissive: 0, emissiveIntensity: 0, roughness: 0.96, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x2c2e30, pattern: 'noise' },
  sand: { color: 0xc4ae84, emissive: 0, emissiveIntensity: 0, roughness: 0.96, metalness: 0, opacity: 1, surface: 'sand', minimap: 0x8f7f60, pattern: 'noise' },
};

export function materialOf(key: string): MaterialDef {
  return MATERIALS[key] ?? MATERIALS.concrete;
}

// ---------------------------------------------------------------------------
// Compiled world
// ---------------------------------------------------------------------------

const CELL_SIZE = 8;

export class CollisionWorld {
  readonly brushes: Brush[] = [];
  readonly def: MapDef;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly killY: number;

  private cols = 0;
  private rows = 0;
  private grid: Int32Array[] = [];
  /** Scratch set used to de-duplicate broadphase results without allocating. */
  private mark: Int32Array;
  private markStamp = 1;
  private queryBuf: number[] = [];

  constructor(def: MapDef) {
    this.def = def;
    this.killY = def.killY;
    let minX = def.bounds.minX;
    let maxX = def.bounds.maxX;
    let minZ = def.bounds.minZ;
    let maxZ = def.bounds.maxZ;

    for (const bd of def.brushes) {
      const b = compileBrush(bd, this.brushes.length);
      this.brushes.push(b);
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minZ < minZ) minZ = b.minZ;
      if (b.maxZ > maxZ) maxZ = b.maxZ;
    }

    this.minX = minX - 2;
    this.maxX = maxX + 2;
    this.minZ = minZ - 2;
    this.maxZ = maxZ + 2;
    this.mark = new Int32Array(this.brushes.length);
    this.buildGrid();
  }

  private buildGrid(): void {
    this.cols = Math.max(1, Math.ceil((this.maxX - this.minX) / CELL_SIZE));
    this.rows = Math.max(1, Math.ceil((this.maxZ - this.minZ) / CELL_SIZE));
    const lists: number[][] = [];
    for (let i = 0; i < this.cols * this.rows; i++) lists.push([]);

    for (const b of this.brushes) {
      const c0 = this.colOf(b.minX);
      const c1 = this.colOf(b.maxX);
      const r0 = this.rowOf(b.minZ);
      const r1 = this.rowOf(b.maxZ);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          lists[r * this.cols + c].push(b.index);
        }
      }
    }
    this.grid = lists.map((l) => Int32Array.from(l));
  }

  private colOf(x: number): number {
    return clamp(Math.floor((x - this.minX) / CELL_SIZE), 0, this.cols - 1);
  }

  private rowOf(z: number): number {
    return clamp(Math.floor((z - this.minZ) / CELL_SIZE), 0, this.rows - 1);
  }

  /** Brush indices whose AABB may overlap the given XZ box. Reused buffer. */
  query(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    const out = this.queryBuf;
    out.length = 0;
    const stamp = ++this.markStamp;
    const c0 = this.colOf(minX);
    const c1 = this.colOf(maxX);
    const r0 = this.rowOf(minZ);
    const r1 = this.rowOf(maxZ);
    for (let r = r0; r <= r1; r++) {
      const base = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const cell = this.grid[base + c];
        for (let i = 0; i < cell.length; i++) {
          const idx = cell[i];
          if (this.mark[idx] === stamp) continue;
          this.mark[idx] = stamp;
          out.push(idx);
        }
      }
    }
    return out;
  }
}

export function compileBrush(d: BrushDef, index: number): Brush {
  const yaw = ((d.ry ?? 0) * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const [cx, cy, cz] = d.p;
  const [hx, hy, hz] = d.s;
  // World AABB of the yaw-rotated box.
  const ex = Math.abs(hx * cos) + Math.abs(hz * sin);
  const ez = Math.abs(hx * sin) + Math.abs(hz * cos);
  const mat = materialOf(d.m);
  let rampAxis: 0 | 1 = 0;
  let rampSign: 1 | -1 = 1;
  if (d.t === 'ramp') {
    const dir = d.d ?? '+x';
    rampAxis = dir === '+x' || dir === '-x' ? 0 : 1;
    rampSign = dir === '+x' || dir === '+z' ? 1 : -1;
  }
  return {
    kind: d.t === 'ramp' ? 1 : 0,
    cx,
    cy,
    cz,
    hx,
    hy,
    hz,
    yaw,
    cos,
    sin,
    rotated: Math.abs(yaw) > 1e-4,
    rampAxis,
    rampSign,
    surface: d.sf ?? mat.surface,
    material: d.m,
    solid: !d.ghost,
    penetrable: !!d.penetrable,
    minX: cx - ex,
    maxX: cx + ex,
    minY: cy - hy,
    maxY: cy + hy,
    minZ: cz - ez,
    maxZ: cz + ez,
    index,
  };
}

// ---------------------------------------------------------------------------
// Local-space helpers
// ---------------------------------------------------------------------------

/** World -> brush local (rotate by -yaw). */
function toLocalX(b: Brush, dx: number, dz: number): number {
  return b.rotated ? dx * b.cos - dz * b.sin : dx;
}
function toLocalZ(b: Brush, dx: number, dz: number): number {
  return b.rotated ? dx * b.sin + dz * b.cos : dz;
}
/** Brush local -> world (rotate by +yaw). */
function toWorldX(b: Brush, lx: number, lz: number): number {
  return b.rotated ? lx * b.cos + lz * b.sin : lx;
}
function toWorldZ(b: Brush, lx: number, lz: number): number {
  return b.rotated ? -lx * b.sin + lz * b.cos : lz;
}

/** Height of a wedge's sloped surface, in local Y, at a local X/Z position. */
function rampLocalSurface(b: Brush, lx: number, lz: number): number {
  const along = b.rampAxis === 0 ? lx : lz;
  const half = b.rampAxis === 0 ? b.hx : b.hz;
  let t = (along + half) / (2 * half);
  if (b.rampSign < 0) t = 1 - t;
  t = clamp(t, 0, 1);
  return -b.hy + t * 2 * b.hy;
}

/** Upward normal of a wedge surface in world space (y component is what we use). */
export function rampNormalY(b: Brush): number {
  const half = b.rampAxis === 0 ? b.hx : b.hz;
  const slope = (2 * b.hy) / (2 * half);
  return 1 / Math.sqrt(1 + slope * slope);
}

// ---------------------------------------------------------------------------
// Cylinder overlap
// ---------------------------------------------------------------------------

export interface OverlapInfo {
  hit: boolean;
  /** Horizontal push direction (world space, normalised). */
  nx: number;
  nz: number;
  depth: number;
  brush: Brush | null;
}

const overlapScratch: OverlapInfo = { hit: false, nx: 0, nz: 0, depth: 0, brush: null };

/**
 * Test a vertical cylinder (centre x/z, feet at y0, head at y1) against one
 * brush and report the minimal horizontal separation.
 *
 * `stepTolerance` lets the caller ignore geometry that the player can simply
 * step onto, which is what makes stairs and wedges walkable.
 */
export function overlapBrush(
  b: Brush,
  x: number,
  y0: number,
  y1: number,
  z: number,
  radius: number,
  stepTolerance: number,
  out: OverlapInfo = overlapScratch,
): OverlapInfo {
  out.hit = false;
  out.brush = null;
  if (!b.solid) return out;
  if (y1 <= b.minY || y0 >= b.maxY) return out;
  if (x + radius <= b.minX || x - radius >= b.maxX) return out;
  if (z + radius <= b.minZ || z - radius >= b.maxZ) return out;

  const dx = x - b.cx;
  const dz = z - b.cz;
  const lx = toLocalX(b, dx, dz);
  const lz = toLocalZ(b, dx, dz);

  const cxp = clamp(lx, -b.hx, b.hx);
  const czp = clamp(lz, -b.hz, b.hz);
  const ox = lx - cxp;
  const oz = lz - czp;
  const distSq = ox * ox + oz * oz;
  if (distSq >= radius * radius) return out;

  if (b.kind === 1) {
    // Wedge: only solid where the player's feet are below the slope.
    const surfaceY = b.cy + rampLocalSurface(b, cxp, czp);
    if (y0 + stepTolerance >= surfaceY - 1e-4) return out;
  } else {
    // Box: walkable top face within step reach is not a wall.
    if (y0 + stepTolerance >= b.maxY - 1e-4) return out;
  }

  let pnx: number;
  let pnz: number;
  let depth: number;

  if (distSq > 1e-8) {
    // Outside the footprint: push straight out along the closest-point normal.
    const d = Math.sqrt(distSq);
    depth = radius - d;
    pnx = ox / d;
    pnz = oz / d;
  } else {
    // Centre is inside the footprint: choose the cheapest face to exit through.
    const dxPos = b.hx - lx + radius;
    const dxNeg = lx + b.hx + radius;
    const dzPos = b.hz - lz + radius;
    const dzNeg = lz + b.hz + radius;
    depth = dxPos;
    pnx = 1;
    pnz = 0;
    if (dxNeg < depth) {
      depth = dxNeg;
      pnx = -1;
      pnz = 0;
    }
    if (dzPos < depth) {
      depth = dzPos;
      pnx = 0;
      pnz = 1;
    }
    if (dzNeg < depth) {
      depth = dzNeg;
      pnx = 0;
      pnz = -1;
    }
  }

  out.hit = true;
  out.depth = depth;
  out.nx = toWorldX(b, pnx, pnz);
  out.nz = toWorldZ(b, pnx, pnz);
  out.brush = b;
  return out;
}

/** Any-hit solidity test. */
export function worldSolid(
  world: CollisionWorld,
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  stepTolerance: number,
): boolean {
  const y0 = y + 0.02;
  const y1 = y + height - 0.02;
  const list = world.query(x - radius, z - radius, x + radius, z + radius);
  for (let i = 0; i < list.length; i++) {
    const b = world.brushes[list[i]];
    if (overlapBrush(b, x, y0, y1, z, radius, stepTolerance).hit) return true;
  }
  return false;
}

export interface GroundInfo {
  y: number;
  normalY: number;
  surface: string;
  found: boolean;
  brushIndex: number;
}

const groundScratch: GroundInfo = { y: -Infinity, normalY: 1, surface: 'metal', found: false, brushIndex: -1 };
const SAMPLE_OFFSETS: readonly [number, number][] = [
  [0, 0],
  [0.72, 0],
  [-0.72, 0],
  [0, 0.72],
  [0, -0.72],
  [0.51, 0.51],
  [-0.51, 0.51],
  [0.51, -0.51],
  [-0.51, -0.51],
];

/**
 * Highest walkable surface under the player's footprint that is at or below
 * `maxY`.  Sampled at nine points around the cylinder so ledges and wedge
 * seams behave predictably.
 */
export function worldGround(
  world: CollisionWorld,
  x: number,
  z: number,
  maxY: number,
  radius: number,
  out: GroundInfo = groundScratch,
): GroundInfo {
  out.y = -Infinity;
  out.normalY = 1;
  out.surface = 'metal';
  out.found = false;
  out.brushIndex = -1;

  const list = world.query(x - radius, z - radius, x + radius, z + radius);
  for (let i = 0; i < list.length; i++) {
    const b = world.brushes[list[i]];
    if (!b.solid) continue;
    if (b.minY > maxY + 1e-3) continue;
    if (b.maxY < out.y - 1e-4) continue;
    if (x + radius <= b.minX || x - radius >= b.maxX) continue;
    if (z + radius <= b.minZ || z - radius >= b.maxZ) continue;

    for (let s = 0; s < SAMPLE_OFFSETS.length; s++) {
      const sx = x + SAMPLE_OFFSETS[s][0] * radius;
      const sz = z + SAMPLE_OFFSETS[s][1] * radius;
      const dx = sx - b.cx;
      const dz = sz - b.cz;
      const lx = toLocalX(b, dx, dz);
      const lz = toLocalZ(b, dx, dz);
      if (lx < -b.hx || lx > b.hx || lz < -b.hz || lz > b.hz) continue;

      let surfaceY: number;
      let ny: number;
      if (b.kind === 1) {
        surfaceY = b.cy + rampLocalSurface(b, lx, lz);
        ny = rampNormalY(b);
      } else {
        surfaceY = b.maxY;
        ny = 1;
      }
      if (surfaceY > maxY + 1e-3) continue;
      if (surfaceY > out.y) {
        out.y = surfaceY;
        out.normalY = ny;
        out.surface = b.surface;
        out.found = true;
        out.brushIndex = b.index;
      }
    }
  }
  return out;
}

/** Lowest ceiling above `fromY` across the footprint, or +Infinity. */
export function worldCeiling(
  world: CollisionWorld,
  x: number,
  z: number,
  fromY: number,
  radius: number,
): number {
  let best = Infinity;
  const list = world.query(x - radius, z - radius, x + radius, z + radius);
  for (let i = 0; i < list.length; i++) {
    const b = world.brushes[list[i]];
    if (!b.solid) continue;
    if (b.minY < fromY - 1e-3) continue;
    if (b.minY >= best) continue;
    if (x + radius <= b.minX || x - radius >= b.maxX) continue;
    if (z + radius <= b.minZ || z - radius >= b.maxZ) continue;
    const dx = x - b.cx;
    const dz = z - b.cz;
    const lx = clamp(toLocalX(b, dx, dz), -b.hx, b.hx);
    const lz = clamp(toLocalZ(b, dx, dz), -b.hz, b.hz);
    const wx = b.cx + toWorldX(b, lx, lz);
    const wz = b.cz + toWorldZ(b, lx, lz);
    const ddx = x - wx;
    const ddz = z - wz;
    if (ddx * ddx + ddz * ddz >= radius * radius) continue;
    if (b.minY < best) best = b.minY;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ray casting (convex halfspace clipping - handles boxes and wedges)
// ---------------------------------------------------------------------------

export interface RayHit {
  hit: boolean;
  t: number;
  nx: number;
  ny: number;
  nz: number;
  surface: string;
  brushIndex: number;
  penetrable: boolean;
}

const rayScratch: RayHit = { hit: false, t: 0, nx: 0, ny: 1, nz: 0, surface: 'metal', brushIndex: -1, penetrable: false };

/**
 * Ray vs single brush. Returns the entry distance along the ray.
 * `ignorePenetrable` skips glass etc. so bullets pass through it.
 */
export function rayBrush(
  b: Brush,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: RayHit,
): boolean {
  out.hit = false;
  if (!b.solid) return false;

  // Transform ray into brush local space.
  const rx = ox - b.cx;
  const rz = oz - b.cz;
  const lox = toLocalX(b, rx, rz);
  const loz = toLocalZ(b, rx, rz);
  const loy = oy - b.cy;
  const ldx = toLocalX(b, dx, dz);
  const ldz = toLocalZ(b, dx, dz);
  const ldy = dy;

  let tmin = 0;
  let tmax = maxT;
  // Entry plane tracking: axis 0=x,1=y,2=z,3=slope ; sign
  let axis = -1;
  let sgn = 1;

  // Slab tests
  // X
  if (Math.abs(ldx) < EPSILON) {
    if (lox < -b.hx || lox > b.hx) return false;
  } else {
    const inv = 1 / ldx;
    let t1 = (-b.hx - lox) * inv;
    let t2 = (b.hx - lox) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = 0;
      sgn = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  // Y
  if (Math.abs(ldy) < EPSILON) {
    if (loy < -b.hy || loy > b.hy) return false;
  } else {
    const inv = 1 / ldy;
    let t1 = (-b.hy - loy) * inv;
    let t2 = (b.hy - loy) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = 1;
      sgn = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  // Z
  if (Math.abs(ldz) < EPSILON) {
    if (loz < -b.hz || loz > b.hz) return false;
  } else {
    const inv = 1 / ldz;
    let t1 = (-b.hz - loz) * inv;
    let t2 = (b.hz - loz) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = 2;
      sgn = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  // Extra sloped halfspace for wedges: localY - k*along - c <= 0
  let slopeK = 0;
  if (b.kind === 1) {
    const half = b.rampAxis === 0 ? b.hx : b.hz;
    slopeK = (b.rampSign * b.hy) / half;
    // plane value f(p) = loy - slopeK * along
    const alongO = b.rampAxis === 0 ? lox : loz;
    const alongD = b.rampAxis === 0 ? ldx : ldz;
    const fo = loy - slopeK * alongO;
    const fd = ldy - slopeK * alongD;
    if (Math.abs(fd) < EPSILON) {
      if (fo > 0) return false;
    } else {
      const tPlane = -fo / fd;
      if (fd > 0) {
        // leaving the halfspace
        if (tPlane < tmax) tmax = tPlane;
      } else {
        if (tPlane > tmin) {
          tmin = tPlane;
          axis = 3;
          sgn = 1;
        }
      }
      if (tmin > tmax) return false;
    }
  }

  if (tmax < 0 || tmin > maxT) return false;
  const t = tmin < 0 ? 0 : tmin;

  // Reconstruct the local normal from the entry plane.
  let lnx = 0;
  let lny = 0;
  let lnz = 0;
  if (axis === 0) lnx = sgn;
  else if (axis === 1) lny = sgn;
  else if (axis === 2) lnz = sgn;
  else if (axis === 3) {
    // normalise (-slopeK, 1, 0) or (0, 1, -slopeK)
    const inv = 1 / Math.sqrt(1 + slopeK * slopeK);
    if (b.rampAxis === 0) {
      lnx = -slopeK * inv;
      lny = inv;
    } else {
      lnz = -slopeK * inv;
      lny = inv;
    }
  } else {
    lny = 1; // ray started inside
  }

  out.hit = true;
  out.t = t;
  out.nx = toWorldX(b, lnx, lnz);
  out.ny = lny;
  out.nz = toWorldZ(b, lnx, lnz);
  out.surface = b.surface;
  out.brushIndex = b.index;
  out.penetrable = b.penetrable;
  return true;
}

/**
 * DDA-free world raycast. Uses the broadphase grid over the ray's XZ AABB;
 * ranges are short enough (<= 320m) that this is far cheaper than the cost of
 * maintaining a BVH, and it never misses geometry.
 */
export function worldRaycast(
  world: CollisionWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: RayHit = rayScratch,
  skipPenetrable = false,
): RayHit {
  out.hit = false;
  out.t = maxT;
  out.brushIndex = -1;

  const ex = ox + dx * maxT;
  const ez = oz + dz * maxT;
  const list = world.query(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez));
  const tmp = tmpRayHit;
  let best = maxT;
  let found = false;
  for (let i = 0; i < list.length; i++) {
    const b = world.brushes[list[i]];
    if (skipPenetrable && b.penetrable) continue;
    if (rayBrush(b, ox, oy, oz, dx, dy, dz, best, tmp)) {
      if (tmp.t <= best) {
        best = tmp.t;
        out.hit = true;
        out.t = tmp.t;
        out.nx = tmp.nx;
        out.ny = tmp.ny;
        out.nz = tmp.nz;
        out.surface = tmp.surface;
        out.brushIndex = tmp.brushIndex;
        out.penetrable = tmp.penetrable;
        found = true;
      }
    }
  }
  if (!found) out.t = maxT;
  return out;
}

const tmpRayHit: RayHit = { hit: false, t: 0, nx: 0, ny: 1, nz: 0, surface: 'metal', brushIndex: -1, penetrable: false };

/** Convenience: is there a clear line between two points? */
export function worldLineOfSight(world: CollisionWorld, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < EPSILON) return true;
  const hit = worldRaycast(world, a.x, a.y, a.z, dx / len, dy / len, dz / len, len - 0.05, losScratch, true);
  return !hit.hit;
}

const losScratch: RayHit = { hit: false, t: 0, nx: 0, ny: 1, nz: 0, surface: 'metal', brushIndex: -1, penetrable: false };

/** Drop a point onto the nearest surface below - used to validate spawn/nav data. */
export function snapToGround(world: CollisionWorld, x: number, y: number, z: number, radius = 0.3): number {
  const g = worldGround(world, x, z, y + 0.5, radius, { y: 0, normalY: 1, surface: 'metal', found: false, brushIndex: -1 });
  return g.found ? g.y : y;
}
