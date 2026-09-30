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

  /**
   * Floor slab given as X/Z RANGES rather than centre+size.  Essential when
   * building a deck with a hole in it (sunken plazas, stairwells) - authoring
   * those by centre arithmetic is how you end up with a plaza buried under its
   * own street.
   */
  slab(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    y: number,
    m: string,
    thickness = 0.6,
    opts: Partial<BrushDef> = {},
  ): BrushDef {
    return this.floor((x0 + x1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(z1 - z0), y, m, thickness, opts);
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

  /**
   * Discrete staircase - reads better than a wedge for interior architecture.
   * `dir` matches ramp(): '+x' means the steps CLIMB towards +X.
   */
  stairs(
    cx: number,
    cz: number,
    w: number,
    d: number,
    bottom: number,
    height: number,
    dir: RampDir,
    m: string,
    steps = 6,
    opts: Partial<BrushDef> = {},
  ): void {
    const alongX = dir === '+x' || dir === '-x';
    const along = alongX ? w : d;
    const stepSize = along / steps;
    const stepHeight = height / steps;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const off = (t - 0.5) * along;
      const signed = dir === '+x' || dir === '+z' ? off : -off;
      const h = stepHeight * (i + 1);
      if (alongX) {
        this.block(cx + signed, cz, stepSize + 0.02, d, bottom, h, m, opts);
      } else {
        this.block(cx, cz + signed, w, stepSize + 0.02, bottom, h, m, opts);
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

  /**
   * A structure whose COLLISION is a simple box and whose APPEARANCE is a
   * Blender model.
   *
   * This is how a building stops being assembled from brushes. Brushes remain
   * the only source of collision, bullet blocking and navmesh, so the box has
   * to stay - but marked `noDraw` it is never rendered, and the model supplies
   * everything the player sees. Detail then lives in a generator script where
   * it can be bevelled, lofted and previewed, instead of in a pile of
   * `b.block()` calls that can only ever look like boxes.
   *
   * Two rules:
   *   The hull is SIMPLER than the art, and sits slightly inside it. Being
   *   stopped by geometry you cannot see is much worse than clipping a
   *   shoulder into an eave.
   *   The hull is what the navmesh and the bots see, so it must still describe
   *   the shape that matters for movement - a walkable roof needs a hull at
   *   roof height, not just at the walls.
   */
  structure(
    asset: string,
    cx: number,
    cz: number,
    bottom: number,
    w: number,
    h: number,
    d: number,
    opts: { ry?: number; scale?: number; m?: string; sf?: string } = {},
  ): void {
    const ry = opts.ry ?? 0;
    this.block(cx, cz, w, d, bottom, h, opts.m ?? 'hull', {
      ry,
      noDraw: true,
      ...(opts.sf ? { sf: opts.sf } : {}),
    });
    this.prop(asset, cx, bottom, cz, ry, opts.scale ?? 1);
  }

  /**
   * Height of the highest solid surface at (x, z), or 0 if there is none.
   *
   * `prop()` takes an absolute Y and does nothing clever with it, so a prop
   * authored at y = 0 over a raised deck sinks into it, and one over a sunken
   * plaza hangs in the air. Hand-checking every scatter position against every
   * deck is exactly the kind of bookkeeping that rots the moment the geometry
   * moves - so ask the geometry instead.
   *
   * Deliberate simplifications, all safe in the direction that matters:
   *   - Ghost brushes are ignored. They are decoration; standing a rock on a
   *     railing would be wrong.
   *   - Rotated brushes are skipped. Testing a point against a yawed box needs
   *     the inverse rotation, and the only yawed brushes underfoot are the
   *     45-degree octagon halves of `pillar()`, which always have an
   *     axis-aligned twin at the same height that will match anyway.
   *   - Ramps use their full top height rather than interpolating the slope,
   *     so a prop on a ramp sits slightly proud rather than sunk. Do not scatter
   *     onto ramps.
   *   - `ceiling` caps how high a surface may be and still count as ground,
   *     so a prop under a barn roof snaps to the floor rather than the roof.
   */
  groundAt(x: number, z: number, ceiling = 12): number {
    let best = 0;
    for (const br of this.brushes) {
      if (br.ghost || br.ry) continue;
      const [cx, cy, cz] = br.p;
      const [hw, hh, hd] = br.s;
      if (x < cx - hw || x > cx + hw) continue;
      if (z < cz - hd || z > cz + hd) continue;
      const top = cy + hh;
      if (top <= ceiling && top > best) best = top;
    }
    return best;
  }

  /**
   * Place a prop standing on whatever surface is under it.
   *
   * Prefer this over `prop()` for anything that should look like it is resting
   * on the ground. Use `prop()` directly only when the Y is deliberate - a
   * hanging sign, a rooftop object, or scenery outside the play area.
   */
  propOnGround(asset: string, x: number, z: number, ryDeg = 0, scale = 1, tint?: number): void {
    this.prop(asset, x, this.groundAt(x, z), z, ryDeg, scale, tint);
  }

  /*
   * --- Natural cover ------------------------------------------------------
   *
   * `prop()` emits a GLB and nothing else: props never collide and never stop
   * bullets. So a boulder placed with `prop()` alone is scenery that looks
   * exactly like cover, and a player who ducks behind it and gets shot through
   * has been lied to by the level.
   *
   * These three pair the visual with a real brush. Two rules they all follow:
   *
   *   COLLISION SITS INSIDE THE SILHOUETTE, at roughly 75-80% of the visual
   *   radius. Erring the other way - collision wider than the mesh - stops
   *   players on geometry they cannot see, which is far worse than being able
   *   to clip a shoulder into some leaves.
   *
   *   THE COLLIDER IS ONLY THE SOLID PART. A tree's collider is its trunk; the
   *   canopy is overhead and must not block a bullet that visibly passes under
   *   it.
   *
   * `sf` overrides the footstep/impact surface, because the material key's own
   * surface would otherwise be wrong - `hull` is timber now but still reports
   * 'metal', and that value is wire-encoded so it cannot simply be renamed.
   */

  /** Chest-high boulder. Crouch cover you can peek over. */
  rockCover(cx: number, cz: number, y: number, scale = 1, ry = 0): void {
    this.pillar(cx, cz, y, 1.45 * scale, 0.95 * scale, 'concrete');
    this.prop('prop_rock_large', cx, y, cz, ry, scale);
  }

  /** Tree with a solid trunk. Cover you strafe around rather than hide behind. */
  treeCover(cx: number, cz: number, y: number, scale = 1, ry = 0): void {
    // Trunk only, and only up to where the canopy starts.
    this.pillar(cx, cz, y, 2.6 * scale, 0.26 * scale, 'hull', { sf: 'panel' });
    this.prop('prop_tree_round', cx, y, cz, ry, scale);
  }

  /** Fallen log. Low cover: breaks a sightline when prone or sliding. */
  logCover(cx: number, cz: number, y: number, scale = 1, ry = 0): void {
    const len = 3.0 * scale;
    const rad = 0.235 * scale;
    this.block(cx, cz, len * 0.92, rad * 1.7, y, rad * 1.9, 'hull', { ry, sf: 'panel' });
    this.prop('prop_log', cx, y, cz, ry, scale);
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

  /**
   * Spawn that looks at a target point.  Preferred over raw yaw: it is
   * impossible to accidentally face a player into the back wall of their own
   * spawn, which is exactly the bug this replaced.
   */
  spawnLookingAt(x: number, y: number, z: number, tx: number, tz: number, team = 0, tag?: string): void {
    this.spawn(x, y, z, yawTowardsDeg(x, z, tx, tz), team, tag);
  }

  /**
   * Ring of spawns around a point, all facing a shared target.  Keeps teams
   * from stacking on one tile while guaranteeing a sensible initial view.
   *
   * `spreadZ` defaults to a third of `spreadX` because spawn bays are almost
   * always wide and shallow - using one radius pushes members into the back
   * wall, which reads in game as spawning inside the geometry.
   */
  spawnCluster(
    cx: number,
    y: number,
    cz: number,
    target: [number, number],
    team: number,
    count: number,
    spreadX = 3.2,
    spreadZ = spreadX / 3,
    tag?: string,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + 0.35;
      const x = cx + Math.cos(a) * spreadX;
      const z = cz + Math.sin(a) * spreadZ;
      this.spawnLookingAt(x, y, z, target[0], target[1], team, tag);
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

  /** Ceiling light panel: an emissive fixture plus a matching point light. */
  lightPanel(x: number, y: number, z: number, w: number, d: number, color = 0xdff2ff, intensity = 1.4, range = 16): void {
    this.boxAt(x, y, z, w, 0.16, d, 'lampPanel', { ghost: true, noMinimap: true });
    // A slim housing so the fixture reads as built into the ceiling.
    this.boxAt(x, y + 0.12, z, w * 1.1, 0.12, d * 1.1, 'trim', { ghost: true, noMinimap: true });
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

/**
 * Yaw (degrees) that makes a player at (fromX, fromZ) look at (toX, toZ).
 * Matches the engine convention forward = (-sin yaw, 0, -cos yaw).
 */
export function yawTowardsDeg(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return (Math.atan2(-(toX - fromX), -(toZ - fromZ)) * 180) / Math.PI;
}

/** Mirror a set of coordinates through the origin, for symmetric layouts. */
export function mirrored<T>(items: readonly T[], fn: (item: T, sign: 1 | -1) => void): void {
  for (const it of items) {
    fn(it, 1);
    fn(it, -1);
  }
}
