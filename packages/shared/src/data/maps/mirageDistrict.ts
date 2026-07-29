/**
 * MIRAGE DISTRICT
 *
 * Neon city block. Two crossing avenues, four quadrant blocks with enterable
 * ground floors, a continuous rooftop circuit and a sunken central plaza.
 *
 * Movement-first design:
 *   - Street level is the safe-but-slow route.
 *   - Alleys between the towers and their annexes cut fast flanks.
 *   - The rooftop grid (y=12) is a complete circuit - hub, four spokes, four
 *     long bridges - reached by four long avenue ramps. Every roof edge that a
 *     bridge meets has a gap in its parapet, so no route dead-ends at a wall.
 *   - The sunken plaza is a commitment: three stair mouths in, one solid side.
 *
 * Geometry rule enforced throughout (and asserted by the map tests): a ramp
 * never passes underneath the walkway it feeds, because that always ends up
 * leaving under a metre of headroom at the top of the climb.
 */

import { MapBuilder } from '../mapkit.js';
import type { MapDef } from '../../sim/world.js';

const HALF = 48;
const ROOF = 12;
const LOW_ROOF = 7;
const PLAZA_Y = -3;

/** Tower centres sit at (+-TOWER_X, +-TOWER_Z). */
const TOWER_X = 24;
const TOWER_Z = 20;
const TOWER_W = 18;
const TOWER_D = 16;
/** Annex centres. */
const ANNEX_X = 38;
const ANNEX_Z = 32;
/** Rooftop bridge lines. */
const BRIDGE_Z = TOWER_Z; // z = +-20, runs along X
const BRIDGE_X = TOWER_X; // x = +-24, runs along Z
const BRIDGE_W = 3.2;
const HUB_HALF = 4.5;

export function buildMirageDistrict(): MapDef {
  const b = new MapBuilder(
    'mirage_district',
    'Mirage District',
    'Rain-slick neon streets. Take the rooftops.',
    ['ffa', 'tdm', 'domination', 'hardpoint', 'progression', 'elimination', 'core'],
  );

  // ------------------------------------------------- street deck + plaza well
  // The street deck is four slabs around a 24x24 opening. The opening holds the
  // sunken plaza, its walkable rim, and the three wedge mouths that descend
  // into it - a single full-map slab would simply roof the plaza over.
  const OPEN = 12; // half-size of the opening
  const PW = 6.5; // plaza wall inner face
  const PWO = 6.75; // plaza wall outer face
  const MOUTH = 5.4;
  const MH = MOUTH / 2;

  b.slab(-HALF, HALF, -HALF, -OPEN, 0, 'asphalt', 1.5);
  b.slab(-HALF, HALF, OPEN, HALF, 0, 'asphalt', 1.5);
  b.slab(-HALF, -OPEN, -OPEN, OPEN, 0, 'asphalt', 1.5);
  b.slab(OPEN, HALF, -OPEN, OPEN, 0, 'asphalt', 1.5);

  // Rim around the well, split where each mouth cuts through it.
  b.slab(-OPEN, OPEN, -OPEN, -PWO, 0, 'concrete', 1.5);
  b.slab(-OPEN, -MH, PWO, OPEN, 0, 'concrete', 1.5);
  b.slab(MH, OPEN, PWO, OPEN, 0, 'concrete', 1.5);
  b.slab(-OPEN, -PWO, -PWO, -MH, 0, 'concrete', 1.5);
  b.slab(-OPEN, -PWO, MH, PWO, 0, 'concrete', 1.5);
  b.slab(PWO, OPEN, -PWO, -MH, 0, 'concrete', 1.5);
  b.slab(PWO, OPEN, MH, PWO, 0, 'concrete', 1.5);

  // Lane markings, drawn only over asphalt.
  for (const s of [-1, 1] as const) {
    b.slab(-HALF, -OPEN, s * 6.4 - 0.12, s * 6.4 + 0.12, 0.04, 'neonCyan', 0.04, { ghost: true, noMinimap: true });
    b.slab(OPEN, HALF, s * 6.4 - 0.12, s * 6.4 + 0.12, 0.04, 'neonCyan', 0.04, { ghost: true, noMinimap: true });
    b.slab(s * 6.4 - 0.12, s * 6.4 + 0.12, -HALF, -OPEN, 0.04, 'neonCyan', 0.04, { ghost: true, noMinimap: true });
    b.slab(s * 6.4 - 0.12, s * 6.4 + 0.12, OPEN, HALF, 0.04, 'neonCyan', 0.04, { ghost: true, noMinimap: true });
  }

  // ----------------------------------------------------------- sunken plaza
  b.slab(-PWO, PWO, -PWO, PWO, PLAZA_Y, 'concrete', 1.2);
  // Retaining walls, omitted where a mouth passes through.
  b.wall(-PW, -PW, PW, -PW, PLAZA_Y, 3, 0.5, 'cityWall');
  b.wall(-PW, PW, -MH, PW, PLAZA_Y, 3, 0.5, 'cityWall');
  b.wall(MH, PW, PW, PW, PLAZA_Y, 3, 0.5, 'cityWall');
  b.wall(-PW, -PW, -PW, -MH, PLAZA_Y, 3, 0.5, 'cityWall');
  b.wall(-PW, MH, -PW, PW, PLAZA_Y, 3, 0.5, 'cityWall');
  b.wall(PW, -PW, PW, -MH, PLAZA_Y, 3, 0.5, 'cityWall');
  b.wall(PW, MH, PW, PW, PLAZA_Y, 3, 0.5, 'cityWall');

  // Wedge mouths: 5.5m of run for a 3m drop (29 degrees), south/east/west.
  // The north side stays sealed, so the plaza is never a free rotation.
  b.ramp(0, (PW + OPEN) / 2, MOUTH, OPEN - PW, PLAZA_Y, 3, '+z', 'concrete');
  b.ramp(-(PW + OPEN) / 2, 0, OPEN - PW, MOUTH, PLAZA_Y, 3, '-x', 'concrete');
  b.ramp((PW + OPEN) / 2, 0, OPEN - PW, MOUTH, PLAZA_Y, 3, '+x', 'concrete');

  b.railing(-PW, -PWO - 0.2, PW, -PWO - 0.2, 0);
  b.neon(-6.2, -6.2, 6.2, -6.2, PLAZA_Y + 2.7, 'neonMagenta', 0.14);
  b.neon(-6.2, 6.2, 6.2, 6.2, PLAZA_Y + 2.7, 'neonMagenta', 0.14);
  b.cover(-3.8, -3.4, 1.2, 3.2, PLAZA_Y, 1.15, 'hull');
  b.cover(3.8, -3.4, 1.2, 3.2, PLAZA_Y, 1.15, 'hull');
  b.prop('prop_holo_sign', 0, PLAZA_Y + 1.4, -6.1, 0, 1.4, 0xff3ec8);
  b.light('point', 0, PLAZA_Y + 2.4, 0, 0xff3ec8, 1.6, 14);

  // ---------------------------------------------------------- quadrant blocks
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      buildQuadrant(b, sx, sz);
    }
  }

  // ---------------------------------------------------------- rooftop circuit
  // Hub over the plaza.
  b.block(0, 0, HUB_HALF * 2, HUB_HALF * 2, ROOF - 0.35, 0.35, 'grate');
  for (const [x1, z1, x2, z2] of [
    [-HUB_HALF, -HUB_HALF, HUB_HALF, -HUB_HALF],
    [-HUB_HALF, HUB_HALF, HUB_HALF, HUB_HALF],
  ] as const) {
    b.railing(x1, z1, x2, z2, ROOF);
  }
  b.cover(0, 0, 2.2, 2.2, ROOF, 1.2, 'hull', 45);
  b.prop('prop_holo_billboard', 0, ROOF + 0.4, 0, 45, 1.6, 0x4fe0ff);

  // Spokes from the hub out to the bridge lines.
  b.catwalk(0, -HUB_HALF, 0, -BRIDGE_Z, ROOF, BRIDGE_W, 'grate', false);
  b.catwalk(0, HUB_HALF, 0, BRIDGE_Z, ROOF, BRIDGE_W, 'grate', false);
  b.catwalk(-HUB_HALF, 0, -BRIDGE_X, 0, ROOF, BRIDGE_W, 'grate', false);
  b.catwalk(HUB_HALF, 0, BRIDGE_X, 0, ROOF, BRIDGE_W, 'grate', false);

  // Long bridges. Each terminates exactly on a tower roof edge.
  const towerEdgeX = TOWER_X - TOWER_W / 2; // 15
  const towerEdgeZ = TOWER_Z - TOWER_D / 2; // 12
  for (const s of [-1, 1] as const) {
    b.catwalk(-towerEdgeX, s * BRIDGE_Z, towerEdgeX, s * BRIDGE_Z, ROOF, BRIDGE_W, 'grate');
    b.catwalk(s * BRIDGE_X, -towerEdgeZ, s * BRIDGE_X, towerEdgeZ, ROOF, BRIDGE_W, 'grate');
  }

  // ------------------------------------------------------- roof access ramps
  // Four 16m avenue ramps, each ending flush against a bridge's outer edge.
  const halfW = BRIDGE_W / 2;
  // North / south alleys at x = +-11.
  b.ramp(11, -(BRIDGE_Z + halfW + 8), 4.4, 16, 0, ROOF, '+z', 'grate');
  b.ramp(-11, BRIDGE_Z + halfW + 8, 4.4, 16, 0, ROOF, '-z', 'grate');
  // East / west avenue at z = 0, outside the x = +-24 bridges.
  b.ramp(-(BRIDGE_X + halfW + 8), 0, 16, 4.4, 0, ROOF, '+x', 'grate');
  b.ramp(BRIDGE_X + halfW + 8, 0, 16, 4.4, 0, ROOF, '-x', 'grate');
  // Support columns so the ramps read as built structures.
  for (const [rx, rz] of [
    [11, -26],
    [-11, 26],
    [-30, 0],
    [30, 0],
  ] as const) {
    b.block(rx, rz, 0.6, 0.6, 0, 6, 'trim', { ghost: true });
  }

  // ------------------------------------------------------------- skyline
  for (let i = -5; i <= 5; i++) {
    const off = i * 8.6;
    for (const s of [-1, 1] as const) {
      const h = 22 + ((i * 7 + (s > 0 ? 3 : 0)) % 5) * 4;
      b.block(off, s * (HALF + 6), 8, 12, 0, h, 'cityWall', { noMinimap: true });
      b.block(s * (HALF + 6), off, 12, 8, 0, h - 3, 'cityWall', { noMinimap: true });
      if (i % 2 === 0) {
        b.boxAt(off, h * 0.55, s * (HALF + 0.2), 6, 5, 0.2, 'cityGlass', { ghost: true, noMinimap: true });
        b.boxAt(s * (HALF + 0.2), (h - 3) * 0.55, off, 0.2, 5, 6, 'cityGlass', { ghost: true, noMinimap: true });
      }
    }
  }
  for (const s of [-1, 1] as const) {
    b.wall(-HALF, s * HALF, HALF, s * HALF, 0, 26, 1, 'cityWall');
    b.wall(s * HALF, -HALF, s * HALF, HALF, 0, 26, 1, 'cityWall');
    b.neon(-HALF + 1, s * (HALF - 0.6), HALF - 1, s * (HALF - 0.6), 4, 'neonMagenta', 0.16);
    b.neon(s * (HALF - 0.6), -HALF + 1, s * (HALF - 0.6), HALF - 1, 4, 'neonCyan', 0.16);
  }

  // ---------------------------------------------------------- team spawns
  for (const [sz, team] of [
    [-1, 1],
    [1, 2],
  ] as const) {
    const z = sz * 42;
    b.block(0, z, 26, 8, 0, 0.35, 'floorLight');
    b.wall(-13, z + sz * 4, 13, z + sz * 4, 0, 8, 0.6, team === 1 ? 'teamIon' : 'teamEmber');
    b.wall(-13, z - sz * 4, -6, z - sz * 4, 0, 8, 0.6, 'cityWall');
    b.wall(6, z - sz * 4, 13, z - sz * 4, 0, 8, 0.6, 'cityWall');
    b.wall(-13.3, z - 4, -13.3, z + 4, 0, 8, 0.6, 'cityWall');
    b.wall(13.3, z - 4, 13.3, z + 4, 0, 8, 0.6, 'cityWall');
    b.ceiling(0, z, 26, 8, 8, 'cityWall');
    b.neon(-12, z + sz * 3.6, 12, z + sz * 3.6, 7.2, team === 1 ? 'neonCyan' : 'neonAmber', 0.2);
    b.lightPanel(0, 7.7, z, 16, 4, team === 1 ? 0x9ff0ff : 0xffc39a, 1.5, 22);
    b.prop('prop_spawn_arch', 0, 0.35, z + sz * 3.9, sz < 0 ? 180 : 0, 1);
    b.spawnCluster(0, 0.35, z, [0, 0], team, 5, 9, 2.2, 'base');
    b.spawnCluster(0, 0.35, z, [0, 0], 0, 3, 6, 1.8);
  }

  // Neutral spawns for FFA / progression, all facing the plaza.
  for (const [x, y, z] of [
    [-18, 0, 0],
    [18, 0, 0],
    [0, 0, -24],
    [0, 0, 24],
    [-11, 0, -34],
    [11, 0, 34],
    // Quadrant tower roofs.
    [-TOWER_X, ROOF, -TOWER_Z],
    [TOWER_X, ROOF, TOWER_Z],
    [-TOWER_X, ROOF, TOWER_Z],
    [TOWER_X, ROOF, -TOWER_Z],
    // Annex roofs.
    [-ANNEX_X, LOW_ROOF + 0.4, -ANNEX_Z],
    [ANNEX_X, LOW_ROOF + 0.4, ANNEX_Z],
  ] as const) {
    b.spawnLookingAt(x, y, z, 0, 0, 0);
  }

  // ---------------------------------------------------------- street cover
  const streetCover: readonly [number, number, number, number, number][] = [
    [-16, -4, 3.4, 1.2, 0],
    [16, 4, 3.4, 1.2, 0],
    [-4, -16, 1.2, 3.4, 0],
    [4, 16, 1.2, 3.4, 0],
    [-26, 4.6, 1.2, 3.4, 0],
    [26, -4.6, 1.2, 3.4, 0],
    [4.6, -26, 3.4, 1.2, 0],
    [-4.6, 26, 3.4, 1.2, 0],
    [-36, -5, 3, 1.2, 25],
    [36, 5, 3, 1.2, -25],
  ];
  streetCover.forEach(([x, z, w, d, ry]) => b.cover(x, z, w, d, 0, 1.15, 'hull', ry));

  const vehicles: readonly [number, number, number][] = [
    [-16, -18, 20],
    [16, 18, -160],
    [-18, 16, 105],
    [18, -16, -75],
    [-34, -14, 8],
    [34, 14, 188],
  ];
  vehicles.forEach(([x, z, ry], i) => {
    b.block(x, z, 2.3, 5, 0, 1.5, i % 2 ? 'crateAlt' : 'hull', { ry });
    b.block(x, z, 2, 2.6, 1.5, 0.8, 'cityGlass', { ry });
    b.prop('prop_hovercar', x, 0, z, ry, 1);
  });

  // ------------------------------------------------------------- lighting
  for (let i = -4; i <= 4; i++) {
    const off = i * 10;
    if (Math.abs(off) < 9) continue;
    b.light('point', off, 6, 0, 0xbfe0ff, 0.8, 16);
    b.light('point', 0, 6, off, 0xbfe0ff, 0.8, 16);
    b.prop('prop_streetlight', off, 0, 7.4, 0, 1);
    b.prop('prop_streetlight', off, 0, -7.4, 180, 1);
  }
  b.light('point', 0, ROOF + 3, 0, 0x4fe0ff, 1.8, 26);

  // ----------------------------------------------------------- objectives
  b.objective({ id: 'A', kind: 'zone', p: [-TOWER_X, 0.05, 0], radius: 6, label: 'A', order: 0 });
  b.objective({ id: 'B', kind: 'zone', p: [0, PLAZA_Y, 0], radius: 7, label: 'B', order: 1 });
  b.objective({ id: 'C', kind: 'zone', p: [TOWER_X, 0.05, 0], radius: 6, label: 'C', order: 2 });
  b.objective({ id: 'H1', kind: 'hardpoint', p: [0, PLAZA_Y, 0], radius: 7, label: 'PLAZA', order: 0 });
  b.objective({ id: 'H2', kind: 'hardpoint', p: [-TOWER_X, 0.05, -TOWER_Z], radius: 6, label: 'NW MARKET', order: 1 });
  b.objective({ id: 'H3', kind: 'hardpoint', p: [TOWER_X, 0.05, -TOWER_Z], radius: 6, label: 'NE YARD', order: 2 });
  b.objective({ id: 'H4', kind: 'hardpoint', p: [TOWER_X, 0.05, TOWER_Z], radius: 6, label: 'SE DOCK', order: 3 });
  b.objective({ id: 'H5', kind: 'hardpoint', p: [-TOWER_X, 0.05, TOWER_Z], radius: 6, label: 'SW LOT', order: 4 });
  b.objective({ id: 'CORE_ION', kind: 'core', p: [0, 0.35, -41], radius: 2.4, label: 'ION CORE', team: 1 });
  b.objective({ id: 'CORE_EMBER', kind: 'core', p: [0, 0.35, 41], radius: 2.4, label: 'EMBER CORE', team: 2 });

  // -------------------------------------------------------------- pickups
  b.weaponPickup('pk_rail', 'rail_sniper', 0, ROOF, 0, 36);
  b.weaponPickup('pk_rail2', 'rail_sniper', -TOWER_X, ROOF, -TOWER_Z, 34);
  b.weaponPickup('pk_shotgun', 'ion_shotgun', 0, PLAZA_Y, 0, 22);
  b.weaponPickup('pk_smg', 'plasma_smg', -TOWER_X, 0.05, -TOWER_Z, 20);
  b.weaponPickup('pk_lmg', 'particle_lmg', TOWER_X, 0.05, TOWER_Z, 28);
  b.weaponPickup('pk_launcher', 'arc_launcher', TOWER_X, 0.05, -TOWER_Z, 30);
  b.weaponPickup('pk_carbine', 'burst_carbine', -TOWER_X, 0.05, TOWER_Z, 22);
  b.healthPickup('hp_w', -18, 0, 4, 50, 20);
  b.healthPickup('hp_e', 18, 0, -4, 50, 20);
  b.healthPickup('hp_n', 4, 0, -18, 50, 20);
  b.healthPickup('hp_s', -4, 0, 18, 50, 20);
  b.shieldPickup('sh_roof', -BRIDGE_X, ROOF, 0, 40, 26);
  b.shieldPickup('sh_roof2', BRIDGE_X, ROOF, 0, 40, 26);
  b.ammoPickup('am_1', -12, 0, -4);
  b.ammoPickup('am_2', 12, 0, 4);
  b.ammoPickup('am_3', -4, 0, 12);
  b.ammoPickup('am_4', 4, 0, -12);
  b.ammoPickup('am_5', 0, ROOF, -BRIDGE_Z);
  b.ammoPickup('am_6', 0, ROOF, BRIDGE_Z);

  return b.finish(
    { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    -20,
    {
      skybox: 'mirage',
      fogColor: 0x160f24,
      fogDensity: 0.014,
      hemiSky: 0x5f6ec4,
      hemiGround: 0x241a2e,
      hemiIntensity: 0.75,
      sunColor: 0xffd0e8,
      sunIntensity: 0.75,
      sunDir: [0.35, -0.85, 0.4],
      ambientLoop: 'amb_mirage',
      neonBoost: 1.45,
    },
  );
}

/**
 * One city quadrant: an enterable tower with a mid floor, an accessible roof,
 * a low annex, and the alley between them.
 */
function buildQuadrant(b: MapBuilder, sx: 1 | -1, sz: 1 | -1): void {
  const bx = sx * TOWER_X;
  const bz = sz * TOWER_Z;
  const w = TOWER_W;
  const d = TOWER_D;
  const x0 = bx - w / 2;
  const x1 = bx + w / 2;
  const z0 = bz - d / 2;
  const z1 = bz + d / 2;

  b.floor(bx, bz, w, d, 0.05, 'concrete', 0.2);

  // --- ground floor shell: a doorway on each side except the map-edge ones --
  b.doorway(x0, z0, x1, z0, 0, ROOF, 0.6, 'cityWall', sz < 0 ? 0 : 4.4);
  b.doorway(x0, z1, x1, z1, 0, ROOF, 0.6, 'cityWall', sz > 0 ? 0 : 4.4);
  b.doorway(x0, z0, x0, z1, 0, ROOF, 0.6, 'cityWall', sx < 0 ? 0 : 4.4);
  b.doorway(x1, z0, x1, z1, 0, ROOF, 0.6, 'cityWall', sx > 0 ? 0 : 4.4);

  // Upper-storey windows: shootable through, sniper angles into the avenues.
  b.window(x0 + 2.4, sz < 0 ? z1 : z0, x1 - 2.4, sz < 0 ? z1 : z0, 7.6, 2.4, 0.18);
  b.window(sx < 0 ? x1 : x0, z0 + 2.4, sx < 0 ? x1 : x0, z1 - 2.4, 7.6, 2.4, 0.18);

  // --- mid floor at y=6 over the outer half, reached by an interior ramp ----
  const midCx = bx + sx * 4.75;
  b.floor(midCx, bz, 8.5, d - 1, 6, 'concrete', 0.4);
  b.railing(bx + sx * 0.5, z0 + 0.5, bx + sx * 0.5, z1 - 0.5, 6);
  // Ramp occupies the inner half so nothing is ever above it but the roof.
  b.ramp(bx - sx * 4.25, bz - sz * 5, 9.5, 5, 0.05, 5.95, sx > 0 ? '+x' : '-x', 'concrete');
  b.cover(midCx, bz + sz * 5.5, 3, 1.2, 6, 1.15, 'hull');

  // --- roof at y=12 with a stairwell opening over the mid floor ------------
  // Three slabs leave a 5 x 7 hole. Seven metres of run for the last six metres
  // of climb keeps the wedge at 41 degrees - a 5m hole would need 50, which is
  // past the walkable slope limit and would strand anyone using it.
  const holeX0 = bx + sx * 4;
  const holeZNear = bz + sz * 0.5;
  b.floor(bx - sx * 2.5, bz, 13, d, ROOF, 'concrete', 0.5);
  b.floor(bx + sx * 6.5, bz - sz * 3.75, 5, 8.5, ROOF, 'concrete', 0.5);
  b.floor(bx + sx * 6.5, bz + sz * 7.75, 5, 0.5, ROOF, 'concrete', 0.5);
  // Wedge from the mid floor up through the opening.
  b.ramp(bx + sx * 6.5, bz + sz * 4, 5, 7, 6, ROOF - 6, sz > 0 ? '+z' : '-z', 'concrete');
  b.railing(holeX0, holeZNear, holeX0, bz + sz * 7.5, ROOF);

  // Parapet with openings where routes actually arrive:
  //   - the inward X wall takes the z = +-20 bridge
  //   - the inward Z wall takes the x = +-24 bridge
  //   - the outward Z wall takes the wedge up from the annex
  // Everything else stays solid, which is what keeps the roof readable.
  const innerZWall = sz > 0 ? z0 : z1;
  const outerZWall = sz > 0 ? z1 : z0;
  const innerXWall = sx > 0 ? x0 : x1;
  const parapet = (wx1: number, wz1: number, wx2: number, wz2: number, gap: number) => {
    if (gap > 0) b.doorway(wx1, wz1, wx2, wz2, ROOF, 1.05, 0.35, 'cityWall', gap, 1.05);
    else b.wall(wx1, wz1, wx2, wz2, ROOF, 1.05, 0.35, 'cityWall');
  };
  parapet(x0, innerZWall, x1, innerZWall, 4.4);
  parapet(x0, outerZWall, x1, outerZWall, 6);
  parapet(innerXWall, z0, innerXWall, z1, 4.4);
  parapet(sx > 0 ? x1 : x0, z0, sx > 0 ? x1 : x0, z1, 0);

  // Roof furniture.
  b.cover(bx - sx * 5, bz - sz * 4, 3.2, 2.4, ROOF, 1.4, 'hull');
  b.crate(bx - sx * 1, bz + sz * 5.5, ROOF, 1.7, 'crateAlt', 20);
  b.prop('prop_ac_unit', bx + sx * 1.5, ROOF, bz - sz * 6, 15, 1.1);
  b.prop('prop_antenna', bx - sx * 7, ROOF, bz + sz * 6, 0, 1.3);

  // Interior lighting + cover.
  b.lightPanel(bx - sx * 3, 5.6, bz - sz * 4, 6, 4, 0xd8ecff, 0.9, 14);
  b.lightPanel(midCx, ROOF - 0.6, bz, 5, 8, 0xd8ecff, 0.8, 14);
  b.cover(bx - sx * 6.5, bz + sz * 5.5, 2.6, 1.2, 0.05, 1.2, 'hull');
  b.prop('prop_terminal', bx + sx * 7.4, 0.05, bz - sz * 6, sx > 0 ? -90 : 90, 1);
  b.prop('prop_crate_stack', bx - sx * 1.5, 0.05, bz + sz * 5.5, 0, 1);

  // --- low annex (roof at LOW_ROOF + 0.4) ---------------------------------
  const ax = sx * ANNEX_X;
  const az = sz * ANNEX_Z;
  b.block(ax, az, 12, 10, 0, LOW_ROOF, 'cityWall');
  b.block(ax, az, 12.4, 10.4, LOW_ROOF, 0.4, 'concrete');
  // Parapet: open on the inward X side (where the catwalk leaves) and on the
  // outward X side (where the street ramp arrives).
  const annexInX = sx > 0 ? ax - 6.2 : ax + 6.2;
  const annexOutX = sx > 0 ? ax + 6.2 : ax - 6.2;
  const annexParapet = (wx1: number, wz1: number, wx2: number, wz2: number, gap: number) => {
    if (gap > 0) b.doorway(wx1, wz1, wx2, wz2, LOW_ROOF + 0.4, 0.9, 0.3, 'cityWall', gap, 0.9);
    else b.wall(wx1, wz1, wx2, wz2, LOW_ROOF + 0.4, 0.9, 0.3, 'cityWall');
  };
  const annexOutZ = sz > 0 ? az + 5.2 : az - 5.2;
  const annexInZ = sz > 0 ? az - 5.2 : az + 5.2;
  annexParapet(ax - 6.2, annexInZ, ax + 6.2, annexInZ, 0);
  annexParapet(ax - 6.2, annexOutZ, ax + 6.2, annexOutZ, 5.6);
  annexParapet(annexInX, az - 5.2, annexInX, az + 5.2, 4.4);
  annexParapet(annexOutX, az - 5.2, annexOutX, az + 5.2, 0);
  b.boxAt(ax - sx * 6.1, LOW_ROOF * 0.55, az, 0.2, 3.4, 6, 'cityGlass', { ghost: true, noMinimap: true });
  b.prop('prop_holo_billboard', ax, LOW_ROOF + 1.4, az - sz * 5, sz > 0 ? 0 : 180, 1.5, sx > 0 ? 0xff3ec8 : 0x4fe0ff);
  b.prop('prop_ac_unit', ax + sx * 3, LOW_ROOF + 0.4, az + sz * 3, 40, 1);

  // Street ramp onto the annex roof. It runs along Z on the map-edge side:
  // there are only ~3m between the annex and the boundary wall in X, nowhere
  // near enough for a 9m climb.
  b.ramp(ax, annexOutZ + sz * 4.5, 5.6, 9, 0, LOW_ROOF + 0.4, sz > 0 ? '-z' : '+z', 'concrete');
  // Annex roof -> tower roof: a catwalk out of the inward gap, then a wedge
  // that lands flush on the tower's outward parapet opening.
  const wedgeZ = bz + sz * (d / 2 + 2.5);
  b.catwalk(annexInX, az, bx, bz + sz * (d / 2 + 5), LOW_ROOF + 0.4, 2.6, 'grate', false);
  b.ramp(bx, wedgeZ, 5, 5, LOW_ROOF + 0.4, ROOF - LOW_ROOF - 0.4, sz > 0 ? '-z' : '+z', 'grate');

  // --- alley ------------------------------------------------------------
  b.crate(bx + sx * 11.5, bz + sz * 2, 0, 1.6, 'crate', 12);
  b.crate(bx + sx * 11.5, bz - sz * 2, 0, 1.4, 'crateAlt', -18);
  b.prop('prop_barrel', bx + sx * 12.5, 0, bz, 0, 1);
  b.prop('prop_vent', bx + sx * 9.4, 4, bz + sz * 3, sx > 0 ? -90 : 90, 1);
  b.light('point', bx + sx * 11.5, 3, bz, sx * sz > 0 ? 0xff3ec8 : 0x8dff4a, 0.9, 12);
  b.neon(bx + sx * 9.4, bz - sz * 6, bx + sx * 9.4, bz + sz * 6, 5.2, sx * sz > 0 ? 'neonMagenta' : 'neonLime', 0.12);
}
