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
  /**
   * Collide, but never render. The inverse of `ghost`.
   *
   * This is what lets a structure be MODELLED in Blender instead of assembled
   * from boxes. Brushes are the only source of collision, bullet blocking, the
   * navmesh and the server's authority - a `prop()` is a mesh and nothing
   * else - so a barn cannot simply become a GLB. Instead the brush stays as a
   * plain invisible hull and a model is placed over it: the standard
   * collision-hull / art-mesh split.
   *
   * The hull should be SIMPLER than the art and sit slightly inside it. A
   * player stopped by geometry they cannot see is far worse than one who can
   * clip a shoulder into an eave.
   */
  noDraw?: boolean;
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
  // Stylised outdoors: meadow, rock, timber and thatch under a bright sky.
  // Hand-painted rather than photographic - saturated albedo, matte surfaces,
  // and nothing near black.
  //
  // Three rules make the look, and all three are the opposite of what an
  // industrial interior wanted:
  //
  //   ROUGHNESS IS HIGH, near 1.0 on everything natural. This look is almost
  //   pure diffuse. A specular highlight travelling across a surface is the
  //   strongest photographic cue there is, so removing it does more for the
  //   style than any change of hue.
  //
  //   SATURATION IS HIGH AND VALUE IS COMPRESSED. Real grass is a desaturated
  //   olive and real stone is nearly grey; these are neither. Nothing sits
  //   very dark, because deep shadow reads as photographic and also hides
  //   players, which matters more.
  //
  //   PATTERN IS ORGANIC. Most surfaces are `noise`, not `panel` or `grid`.
  //   The regular tiling those two produce is what made the ground read as a
  //   greybox floor, and it is the first thing the eye picks up.
  //
  // Keys are unchanged because every map references them by name, so this
  // table restyles all three maps without touching a single brush. Several
  // names are now historical - `hull` is timber, `asphalt` is a dirt path -
  // and are kept only to avoid a rename across three map files for no gain.
  //
  // `surface` drives footstep and impact audio and is encoded in the wire
  // protocol, so those values are load-bearing. Change a colour freely;
  // changing a surface changes what players hear.

  // Ground. `floorPlate` is the main walkable surface on every map.
  floorPlate: { color: 0x7cb342, emissive: 0, emissiveIntensity: 0, roughness: 0.98, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x4e7a2c, pattern: 'noise' },
  floorLight: { color: 0x9ccc55, emissive: 0, emissiveIntensity: 0, roughness: 0.98, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x649a38, pattern: 'noise' },
  concrete: { color: 0xa79c88, emissive: 0, emissiveIntensity: 0, roughness: 0.97, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x6b6456, pattern: 'noise' },

  // Walls. Warm plaster above a timber base - the cottage two-tone, and it
  // still gives the eye a horizon line the way the industrial one did.
  wallLight: { color: 0xf2e6cd, emissive: 0, emissiveIntensity: 0, roughness: 0.94, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x9c927e, pattern: 'plain' },
  wallDark: { color: 0x6d4630, emissive: 0, emissiveIntensity: 0, roughness: 0.92, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x422b1d, pattern: 'plain' },
  cityWall: { color: 0xb8ac96, emissive: 0, emissiveIntensity: 0, roughness: 0.96, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x726a5c, pattern: 'noise' },

  /**
   * Lanterns and hanging lamps, and still the only strongly emissive material.
   * Anywhere the map encloses a space, this is what puts light on the floor
   * beyond the point-light budget - six lights for a 72 m room on low effects
   * quality.
   */
  lampPanel: { color: 0xfff3d6, emissive: 0xffd89c, emissiveIntensity: 0.9, roughness: 0.5, metalness: 0, opacity: 1, surface: 'panel', minimap: 0, pattern: 'plain' },

  // Structure: timber posts, planking and beams. Metalness is 0 - there is no
  // metal in this world, and a sheen on a plank reads as plastic.
  hull: { color: 0xc08a52, emissive: 0, emissiveIntensity: 0, roughness: 0.9, metalness: 0, opacity: 1, surface: 'metal', minimap: 0x7c5733, pattern: 'plain' },
  trim: { color: 0x5c3a24, emissive: 0, emissiveIntensity: 0, roughness: 0.9, metalness: 0, opacity: 1, surface: 'metal', minimap: 0x382417, pattern: 'plain' },
  grate: { color: 0x8a6039, emissive: 0, emissiveIntensity: 0, roughness: 0.92, metalness: 0, opacity: 1, surface: 'grate', minimap: 0x573c24, pattern: 'grate' },

  // Crates and barrels. `panel` is kept for these two deliberately: on a small
  // box the regular division reads as planking rather than as tiling.
  crate: { color: 0xcb9440, emissive: 0, emissiveIntensity: 0, roughness: 0.9, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x7f5b26, pattern: 'panel' },
  crateAlt: { color: 0x4489ad, emissive: 0, emissiveIntensity: 0, roughness: 0.9, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x27516b, pattern: 'panel' },

  // Painted waymarking, on signposts and stall awnings.
  hazard: { color: 0xf2c53d, emissive: 0, emissiveIntensity: 0, roughness: 0.86, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x9c7f26, pattern: 'hazard' },

  glass: { color: 0xdaeef4, emissive: 0, emissiveIntensity: 0, roughness: 0.08, metalness: 0, opacity: 0.22, surface: 'glass', minimap: 0, pattern: 'glass' },
  cityGlass: { color: 0x92c2cc, emissive: 0, emissiveIntensity: 0, roughness: 0.14, metalness: 0, opacity: 0.5, surface: 'glass', minimap: 0x4e5d66, pattern: 'glass' },

  /**
   * Accent keys, kept under their original names because every map references
   * them. They are painted markings, signage and warning lamps now rather than
   * neon: low emissive, so they read as real objects under real light. The four
   * still read apart at a glance, which is what the maps use them for.
   */
  neonCyan: { color: 0x41b6c4, emissive: 0x2a8894, emissiveIntensity: 0.28, roughness: 0.82, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x2a5f78, pattern: 'plain' },
  neonMagenta: { color: 0xd9557f, emissive: 0xa03a5c, emissiveIntensity: 0.28, roughness: 0.82, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x78262c, pattern: 'plain' },
  neonAmber: { color: 0xef9b32, emissive: 0xc4761c, emissiveIntensity: 0.32, roughness: 0.82, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x8f5a17, pattern: 'plain' },
  neonLime: { color: 0x8ecb3f, emissive: 0x5f9628, emissiveIntensity: 0.32, roughness: 0.82, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x2b6a36, pattern: 'plain' },

  // Team markings: dyed banners and painted posts, blue and red, high contrast
  // against the greens and browns of everything else.
  teamIon: { color: 0x3d7fc4, emissive: 0x27568a, emissiveIntensity: 0.25, roughness: 0.86, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x1f5280, pattern: 'plain' },
  teamEmber: { color: 0xd35a3a, emissive: 0x963823, emissiveIntensity: 0.25, roughness: 0.86, metalness: 0, opacity: 1, surface: 'panel', minimap: 0x7d3020, pattern: 'plain' },

  // Gameplay volumes that have to read as unnatural. A barrier you can shoot
  // through has no real-world referent, so it should look like an overlay
  // rather than a wall.
  forcefield: { color: 0xa8e6f0, emissive: 0xa8e6f0, emissiveIntensity: 0.5, roughness: 0.2, metalness: 0, opacity: 0.14, surface: 'panel', minimap: 0, pattern: 'grid' },
  reactor: { color: 0x8a6b4a, emissive: 0xff9a3c, emissiveIntensity: 0.7, roughness: 0.8, metalness: 0, opacity: 1, surface: 'metal', minimap: 0x4a5054, pattern: 'plain' },
  holo: { color: 0xe8f4ff, emissive: 0xa8d8f0, emissiveIntensity: 0.5, roughness: 0.5, metalness: 0, opacity: 0.4, surface: 'panel', minimap: 0, pattern: 'grid' },

  conveyor: { color: 0x6b4f34, emissive: 0, emissiveIntensity: 0, roughness: 0.99, metalness: 0, opacity: 1, surface: 'rubber', minimap: 0x412f1f, pattern: 'noise' },
  asphalt: { color: 0x8a6a45, emissive: 0, emissiveIntensity: 0, roughness: 0.99, metalness: 0, opacity: 1, surface: 'concrete', minimap: 0x54402a, pattern: 'noise' },
  sand: { color: 0xe8d3a0, emissive: 0, emissiveIntensity: 0, roughness: 0.97, metalness: 0, opacity: 1, surface: 'sand', minimap: 0x9a8763, pattern: 'noise' },
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
