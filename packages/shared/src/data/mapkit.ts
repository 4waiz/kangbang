/**
 * Map authoring kit.
 *
 * Maps are written as code against this builder rather than as opaque data so
 * that geometry stays readable, symmetric layouts can be generated with loops,
 * and the Blender generator can consume the exact same description.
 *
 * Coordinate system: +X right, +Y up, +Z towards the viewer (Three.js default).
 * All footprint helpers take a CENTRE and a WIDTH/DEPTH, and a BOTTOM Y with a
 * HEIGHT, because that is how level designers actually think.
 */

import type {
  BrushDef,
  LightDef,
  MapAmbience,
  MapDef,
  NavNodeDef,
  ObjectiveAnchorDef,
  PickupDef,
  PropInstanceDef,
  RampDir,
  SpawnPointDef,
} from '../sim/world.js';

export class MapBuilder {
  readonly brushes: BrushDef[] = [];
  readonly spawns: SpawnPointDef[] = [];
  readonly objectives: ObjectiveAnchorDef[] = [];
  readonly pickups: PickupDef[] = [];
  readonly props: PropInstanceDef[] = [];
  readonly lights: LightDef[] = [];
  readonly nav: NavNodeDef[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    readonly tagline: string,
    readonly modes: string[],
  ) {}

  // -- primitives ----------------------------------------------------------

  /** Centre-based box. */
  boxAt(
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    m: string,
    opts: Partial<BrushDef> = {},
  ): BrushDef {
    const b: BrushDef = { t: 'box', p: [cx, cy, cz], s: [w / 2, h / 2, d / 2], m, ...opts };
    this.brushes.push(b);
    return b;
  }

  /** Footprint-based block: centre X/Z, width/depth, bottom Y and height. */
  block(
    cx: number,
    cz: number,
    w: number,
    d: number,
    bottom: number,
    height: number,
    m: string,
    opts: Partial<BrushDef> = {},
  ): BrushDef {
    return this.boxAt(cx, bottom + height / 2, cz, w, height, d, m, opts);
  }

  /** Floor slab whose TOP surface sits at `y`. */
  floor(cx: number, cz: number, w: number, d: number, y: number, m: string, thickness = 0.6, opts: Partial<BrushDef> = {}): BrushDef {
    return this.boxAt(cx, y - thickness / 2, cz, w, thickness, d, m, opts);
  }

  /** Ceiling slab whose BOTTOM surface sits at `y`. */
  ceiling(cx: number, cz: number, w: number, d: number, y: number, m: string, thickness = 0.6, opts: Partial<BrushDef> = {}): BrushDef {
    return this.boxAt(cx, y + thickness / 2, cz, w, thickness, d, m, { noMinimap: true, ...opts });
  }

  /** Wall running from (x1,z1) to (x2,z2). */
  wall(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    bottom: number,
    height: number,
    thickness: number,
    m: string,
    opts: Partial<BrushDef> = {},
  ): BrushDef {
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    // A wall's local +X runs along its length.
    const ry = (Math.atan2(-dz, dx) * 180) / Math.PI;
    return this.boxAt(cx, bottom + height / 2, cz, len, height, thickness, m, { ry, ...opts });
  }

  /** Wedge ramp. `dir` is the local rise direction before rotation. */
  ramp(
    cx: number,
    cz: number,
    w: number,
    d: number,
    bottom: number,
    height: number,
    dir: RampDir,
    m: string,
    opts: Partial<BrushDef> = {},
  ): BrushDef {
    const b: BrushDef = {
      t: 'ramp',
      p: [cx, bottom + height / 2, cz],
      s: [w / 2, height / 2, d / 2],
      d: dir,
      m,
      ...opts,
    };
    this.brushes.push(b);
    return b;
  }

  /** Discrete staircase - reads better than a wedge for interior architecture. */
  stairs(
    cx: number,
    cz: number,
    w: number,
    d: number,
    bottom: number,
    height: number,
    dir: '+x' | '-x' | '+z' | '-z',
    m: string,
    steps = 6,
    opts: Partial<BrushDef> = {},
  ): void {
    const along = dir === '+x' || dir === '-x' ? d : w;
    const stepDepth = along / steps;
    const stepHeight = height / steps;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const off = (t - 0.5) * along;
      const signed = dir === '+x' || dir === '+z' ? off : -off;
      const h = stepHeight * (i + 1);
      if (dir === '+x' || dir === '-x') {
        this.block(cx, cz + signed, w, stepDepth + 0.02, bottom, h, m, opts);
      } else {
        this.block(cx + signed, cz, stepDepth + 0.02, d, bottom, h, m, opts);
      }
    }
  }

  /** Vertical column approximated with an octagonal prism. */
  pillar(cx: number, cz: number, bottom: number, height: number, radius: number, m: string, opts: Partial<BrushDef> = {}): void {
    this.block(cx, cz, radius * 2, radius * 2, bottom, height, m, opts);
    this.block(cx, cz, radius * 2.55, radius * 2.55, bottom, height, m, { ry: 45, ...opts });
  }

  /** Cover crate with a trim band. */
  crate(cx: number, cz: number, y: number, size: number, m = 'crate', ry = 0): void {
    this.block(cx, cz, size, size, y, size, m, { ry });
    this.block(cx, cz, size * 1.03, size * 1.03, y + size * 0.44, size * 0.1, 'trim', { ry, ghost: true });
  }

  /** Waist-high cover slab. */
  cover(cx: number, cz: number, w: number, d: number, y: number, height = 1.15, m = 'hull', ry = 0): void {
    this.block(cx, cz, w, d, y, height, m, { ry });
    this.block(cx, cz, w * 1.02, d * 1.02, y + height - 0.08, 0.08, 'trim', { ry, ghost: true });
  }

  /** Non-colliding railing so catwalk edges read visually without snagging. */
  railing(x1: number, z1: number, x2: number, z2: number, y: number, m = 'trim', height = 1.05): void {
    this.wall(x1, z1, x2, z2, y + height - 0.07, 0.07, 0.07, m, { ghost: true });
    this.wall(x1, z1, x2, z2, y + height * 0.55, 0.05, 0.05, m, { ghost: true });
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const n = Math.max(2, Math.round(len / 2.2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.block(x1 + dx * t, z1 + dz * t, 0.08, 0.08, y, height, m, { ghost: true });
    }
  }

  /** Emissive accent strip; purely decorative. */
  neon(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    y: number,
    m = 'neonCyan',
    thickness = 0.14,
  ): void {
    this.wall(x1, z1, x2, z2, y, thickness, thickness, m, { ghost: true });
  }

  /** Window opening: builds the frame plus a penetrable glass pane. */
  window(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    bottom: number,
    height: number,
    thickness = 0.16,
    frameMat = 'trim',
  ): void {
    this.wall(x1, z1, x2, z2, bottom, height, thickness, 'glass', { penetrable: true, noMinimap: true });
    this.wall(x1, z1, x2, z2, bottom - 0.1, 0.12, thickness * 1.3, frameMat, { ghost: true });
    this.wall(x1, z1, x2, z2, bottom + height, 0.12, thickness * 1.3, frameMat, { ghost: true });
  }

  /** Doorway: a wall with a gap in the middle. */
  doorway(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    bottom: number,
    height: number,
    thickness: number,
    m: string,
    gapWidth = 3,
    gapHeight = 3.1,
  ): void {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len <= gapWidth) return;
    const ux = dx / len;
    const uz = dz / len;
    const side = (len - gapWidth) / 2;
    // Two side segments
    this.wall(x1, z1, x1 + ux * side, z1 + uz * side, bottom, height, thickness, m);
    this.wall(x2 - ux * side, z2 - uz * side, x2, z2, bottom, height, thickness, m);
    // Lintel above the gap
    if (height > gapHeight) {
      this.wall(
        x1 + ux * side,
        z1 + uz * side,
        x2 - ux * side,
        z2 - uz * side,
        bottom + gapHeight,
        height - gapHeight,
        thickness,
        m,
      );
    }
    // Frame accent
    this.block(x1 + ux * side, z1 + uz * side, 0.2, 0.2, bottom, gapHeight, 'trim', { ghost: true });
    this.block(x2 - ux * side, z2 - uz * side, 0.2, 0.2, bottom, gapHeight, 'trim', { ghost: true });
  }

  /** Rectangular room shell with configurable open sides. */
  room(
    cx: number,
    cz: number,
    w: number,
    d: number,
    bottom: number,
    height: number,
    m: string,
    opts: {
      thickness?: number;
      floorMat?: string;
      ceilingMat?: string | null;
      openNorth?: boolean;
      openSouth?: boolean;
      openEast?: boolean;
      openWest?: boolean;
      doorNorth?: number;
      doorSouth?: number;
      doorEast?: number;
      doorWest?: number;
    } = {},
  ): void {
    const th = opts.thickness ?? 0.5;
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    if (opts.floorMat) this.floor(cx, cz, w, d, bottom, opts.floorMat);
    if (opts.ceilingMat) this.ceiling(cx, cz, w, d, bottom + height, opts.ceilingMat);

    const side = (open: boolean | undefined, door: number | undefined, ax: number, az: number, bx: number, bz: number) => {
      if (open) return;
      if (door && door > 0) this.doorway(ax, az, bx, bz, bottom, height, th, m, door);
      else this.wall(ax, az, bx, bz, bottom, height, th, m);
    };
    // north = -Z
    side(opts.openNorth, opts.doorNorth, x0, z0, x1, z0);
    side(opts.openSouth, opts.doorSouth, x0, z1, x1, z1);
    side(opts.openWest, opts.doorWest, x0, z0, x0, z1);
    side(opts.openEast, opts.doorEast, x1, z0, x1, z1);
  }

  /** Catwalk with railings on both long edges. */
  catwalk(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    y: number,
    width: number,
    m = 'grate',
    rails = true,
  ): void {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const ry = (Math.atan2(-dz, dx) * 180) / Math.PI;
    this.boxAt(cx, y - 0.14, cz, len, 0.28, width, m, { ry });
    if (rails) {
      const nx = -dz / (len || 1);
      const nz = dx / (len || 1);
      const off = width / 2;
      this.railing(x1 + nx * off, z1 + nz * off, x2 + nx * off, z2 + nz * off, y);
      this.railing(x1 - nx * off, z1 - nz * off, x2 - nx * off, z2 - nz * off, y);
    }
  }

  // -- gameplay markers ----------------------------------------------------

  spawn(x: number, y: number, z: number, yawDeg: number, team = 0, tag?: string): void {
    this.spawns.push({ p: [x, y, z], yaw: (yawDeg * Math.PI) / 180, team, tag });
  }

  /** Ring of spawns around a point - keeps teams from stacking on one tile. */
  spawnCluster(cx: number, y: number, cz: number, yawDeg: number, team: number, count: number, spread = 3.2, tag?: string): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.spawn(cx + Math.cos(a) * spread, y, cz + Math.sin(a) * spread, yawDeg, team, tag);
    }
  }

  objective(o: ObjectiveAnchorDef): void {
    this.objectives.push(o);
  }

  pickup(p: PickupDef): void {
    this.pickups.push(p);
  }

  weaponPickup(id: string, weapon: string, x: number, y: number, z: number, respawnSec = 25): void {
    this.pickups.push({ id, kind: 'weapon', weapon, p: [x, y, z], respawnSec });
  }

  ammoPickup(id: string, x: number, y: number, z: number, respawnSec = 15): void {
    this.pickups.push({ id, kind: 'ammo', p: [x, y, z], respawnSec, amount: 1 });
  }

  healthPickup(id: string, x: number, y: number, z: number, amount = 50, respawnSec = 22): void {
    this.pickups.push({ id, kind: 'health', p: [x, y, z], respawnSec, amount });
  }

  shieldPickup(id: string, x: number, y: number, z: number, amount = 40, respawnSec = 26): void {
    this.pickups.push({ id, kind: 'shield', p: [x, y, z], respawnSec, amount });
  }

  prop(asset: string, x: number, y: number, z: number, ryDeg = 0, scale = 1, tint?: number): void {
    this.props.push({ asset, p: [x, y, z], ry: (ryDeg * Math.PI) / 180, scale, tint });
  }

  light(kind: LightDef['kind'], x: number, y: number, z: number, color: number, intensity: number, range: number, s?: [number, number, number], ryDeg = 0): void {
    this.lights.push({ kind, p: [x, y, z], color, intensity, range, s, ry: (ryDeg * Math.PI) / 180 });
  }

  /** Ceiling light panel: emissive quad + a matching point light. */
  lightPanel(x: number, y: number, z: number, w: number, d: number, color = 0xdff2ff, intensity = 1.4, range = 16): void {
    this.boxAt(x, y, z, w, 0.16, d, 'wallLight', { ghost: true, glow: 1.6, noMinimap: true });
    this.light('point', x, y - 0.4, z, color, intensity, range);
  }

  navNode(x: number, y: number, z: number, opts: Partial<NavNodeDef> = {}): void {
    this.nav.push({ p: [x, y, z], ...opts });
  }

  // -- output --------------------------------------------------------------

  finish(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, killY: number, ambience: MapAmbience): MapDef {
    return {
      id: this.id,
      name: this.name,
      tagline: this.tagline,
      modes: this.modes,
      bounds,
      killY,
      brushes: this.brushes,
      spawns: this.spawns,
      objectives: this.objectives,
      pickups: this.pickups,
      props: this.props,
      lights: this.lights,
      nav: this.nav,
      ambience,
    };
  }
}

/** Mirror a set of coordinates through the origin, for symmetric layouts. */
export function mirrored<T>(items: readonly T[], fn: (item: T, sign: 1 | -1) => void): void {
  for (const it of items) {
    fn(it, 1);
    fn(it, -1);
  }
}
