/**
 * ORBITAL NEXUS
 *
 * Space-station map shaped like a cross: a wide central atrium with four arms.
 * The four corners are open to vacuum, ringed by force fields and crossed by
 * narrow bridges - high-risk flank routes that reward movement skill.
 *
 * Levels:
 *   y = 0     atrium deck + arms
 *   y = 3.4   four inner platforms around the spire
 *   y = 7     square ring walkway over the arms
 *   y = 13    four towers + inner bridge ring (sniper level, very exposed)
 *
 * Built for objective modes: the spire sits inside the central capture zone so
 * the point always has hard cover.
 */

import { MapBuilder } from '../mapkit.js';
import type { MapDef } from '../../sim/world.js';

const CORE = 22; // half-size of the central square deck
const ARM_LEN = 38; // outer reach of each arm
const ARM_HALF = 12; // half width of each arm
const RING_Y = 7;
const TOWER_Y = 11.5;
/** Half width of a tower deck. */
const TOWER_HALF = 5;
/** Where the outer rooms sit; kept clear of the ring access ramps. */
const ROOM_OFFSET = 34;

export function buildOrbitalNexus(): MapDef {
  const b = new MapBuilder(
    'orbital_nexus',
    'Orbital Nexus',
    'Deep-orbit transfer station. Mind the gaps.',
    ['tdm', 'domination', 'hardpoint', 'core', 'ffa', 'elimination', 'progression'],
  );

  // -------------------------------------------------------------- deck plan
  b.floor(0, 0, CORE * 2, CORE * 2, 0, 'hull', 1.2);
  for (const s of [-1, 1] as const) {
    // North / south arms run along Z.
    b.floor(0, s * ((ARM_LEN + CORE) / 2), ARM_HALF * 2, ARM_LEN - CORE, 0, 'hull', 1.2);
    // East / west arms run along X.
    b.floor(s * ((ARM_LEN + CORE) / 2), 0, ARM_LEN - CORE, ARM_HALF * 2, 0, 'hull', 1.2);
  }

  // Void-edge trim so the drop always reads as intentional.
  const edge = (x1: number, z1: number, x2: number, z2: number) => {
    b.wall(x1, z1, x2, z2, 0, 0.45, 0.6, 'hazard');
    b.neon(x1, z1, x2, z2, 0.5, 'neonAmber', 0.1);
  };
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      edge(sx * ARM_HALF, sz * CORE, sx * CORE, sz * CORE);
      edge(sx * CORE, sz * ARM_HALF, sx * CORE, sz * CORE);
    }
  }

  // Corner flank bridges over the vacuum.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      b.catwalk(sx * CORE, sz * 16, sx * 16, sz * CORE, 0.05, 2.2, 'grate', true);
      b.prop('prop_strut', sx * 20, -2.2, sz * 20, 45, 1.4);
    }
  }

  // Force-field boundary: visible, penetrable to nothing, kills nobody -
  // it just stops you leaving. Falling into the corner voids is the hazard.
  const bound = ARM_LEN + 1;
  for (const s of [-1, 1] as const) {
    b.wall(-ARM_HALF, s * bound, ARM_HALF, s * bound, 0, 20, 0.4, 'forcefield', { noMinimap: true });
    b.wall(s * bound, -ARM_HALF, s * bound, ARM_HALF, 0, 20, 0.4, 'forcefield', { noMinimap: true });
  }
  // Diagonal fields closing the corner voids.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      b.wall(sx * ARM_HALF, sz * bound, sx * bound, sz * ARM_HALF, -6, 26, 0.4, 'forcefield', { noMinimap: true });
    }
  }

  // ---------------------------------------------------------------- spire
  b.pillar(0, 0, 0, 17, 3.2, 'reactor', { glow: 1.6 });
  b.block(0, 0, 9, 9, 0, 0.7, 'floorLight');
  b.block(0, 0, 8, 8, 16.6, 1, 'trim');
  b.light('point', 0, 8, 0, 0x4fe0ff, 3.2, 30);
  b.prop('prop_spire_collar', 0, 8.5, 0, 0, 1.3);
  b.prop('prop_holo_globe', 0, 17.6, 0, 0, 1.6, 0x4fe0ff);

  // Four inner platforms.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      b.block(sx * 11, sz * 11, 9, 9, 0, 3.4, 'wallLight');
      b.block(sx * 11, sz * 11, 9.3, 9.3, 3.3, 0.16, 'trim', { ghost: true });
      // Ramp facing the spire.
      b.ramp(sx * 11, sz * 17.4, 6, 6, 0, 3.4, sz > 0 ? '-z' : '+z', 'floorPlate');
      b.cover(sx * 11, sz * 8, 4, 1.1, 3.4, 1.1, 'hull');
      b.neon(sx * 15, sz * 15, sx * 7, sz * 15, 3.5, sz < 0 ? 'neonCyan' : 'neonMagenta', 0.12);
    }
  }

  // ----------------------------------------------------------- ring walkway
  const R = 17;
  b.catwalk(-19, -R, 19, -R, RING_Y, 5, 'grate');
  b.catwalk(-19, R, 19, R, RING_Y, 5, 'grate');
  b.catwalk(-R, -19, -R, 19, RING_Y, 5, 'grate');
  b.catwalk(R, -19, R, 19, RING_Y, 5, 'grate');
  // Corner joins.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      b.block(sx * R, sz * R, 5, 5, RING_Y - 0.28, 0.28, 'grate');
      b.railing(sx * (R + 2.5), sz * (R + 2.5), sx * (R - 2.5), sz * (R + 2.5), RING_Y);
      b.block(sx * R, sz * R, 0.6, 0.6, 0, RING_Y, 'trim', { ghost: true });
    }
  }
  // Access ramps in each arm. They run from the deck at |z|=29.5 up to the
  // walkway edge at |z|=19.5 - 10m of run for 7m of rise (35 degrees), and
  // deliberately stop short of the outer rooms so nobody has to duck under a
  // door lintel while climbing.
  b.ramp(0, -24.5, 5, 10, 0, RING_Y, '+z', 'grate');
  b.ramp(0, 24.5, 5, 10, 0, RING_Y, '-z', 'grate');
  b.ramp(-24.5, 0, 10, 5, 0, RING_Y, '+x', 'grate');
  b.ramp(24.5, 0, 10, 5, 0, RING_Y, '-x', 'grate');

  // ------------------------------------------------------------ upper towers
  // Decks at (+-14, +-14), 10x10, reached by a half-width ramp that runs along
  // the outer half of the ring walkway. The inner half of the ring stays flat,
  // so the y=7 circuit is never broken by the climb.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const tx = sx * 14;
      const tz = sz * 14;
      b.block(tx, tz, TOWER_HALF * 2, TOWER_HALF * 2, TOWER_Y - 0.3, 0.3, 'hull');
      b.railing(sx * 19, sz * 19, sx * 9, sz * 19, TOWER_Y);
      b.railing(sx * 19, sz * 19, sx * 19, sz * 9, TOWER_Y);
      b.cover(tx, tz, 2.4, 2.4, TOWER_Y, 1.2, 'hull', 45);
      b.block(tx, tz, 0.7, 0.7, RING_Y, TOWER_Y - RING_Y, 'trim', { ghost: true });
      // Ramp: outer 2.4m of the x=+-17 ring segment, z from 3 to 9.
      b.ramp(sx * 18.3, sz * 6, 2.4, 6, RING_Y, TOWER_Y - RING_Y, sz > 0 ? '+z' : '-z', 'grate');
      b.neon(sx * 19.4, sz * 3, sx * 19.4, sz * 9, RING_Y + 0.3, sz < 0 ? 'neonCyan' : 'neonMagenta', 0.1);
    }
  }
  // Bridge ring connecting the towers (between tower edges, so no overlap).
  b.catwalk(-9, -14, 9, -14, TOWER_Y, 3.2, 'grate');
  b.catwalk(-9, 14, 9, 14, TOWER_Y, 3.2, 'grate');
  b.catwalk(-14, -9, -14, 9, TOWER_Y, 3.2, 'grate');
  b.catwalk(14, -9, 14, 9, TOWER_Y, 3.2, 'grate');

  // Glass dome overhead - pure silhouette, never collides.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.boxAt(Math.cos(a) * 26, 22, Math.sin(a) * 26, 1, 12, 1, 'trim', { ghost: true, ry: (a * 180) / Math.PI, noMinimap: true });
  }
  b.boxAt(0, 27, 0, 54, 0.5, 54, 'glass', { ghost: true, noMinimap: true });

  // ----------------------------------------------------------- spawn wings
  for (const [sz, team] of [
    [-1, 1],
    [1, 2],
  ] as const) {
    const z = sz * ROOM_OFFSET;
    b.room(0, z, 22, 9, 0, 7, 'wallLight', {
      floorMat: 'floorLight',
      ceilingMat: 'wallDark',
      doorNorth: sz < 0 ? 0 : 10,
      doorSouth: sz < 0 ? 10 : 0,
    });
    b.wall(-11, z + sz * 4.2, 11, z + sz * 4.2, 0, 0.5, 0.6, team === 1 ? 'teamIon' : 'teamEmber', { ghost: true });
    b.neon(-10, z + sz * 4, 10, z + sz * 4, 6.2, team === 1 ? 'neonCyan' : 'neonAmber', 0.2);
    b.lightPanel(0, 6.7, z, 14, 4, team === 1 ? 0x9ff0ff : 0xffc39a, 1.5, 20);
    b.prop('prop_spawn_arch', 0, 0, z + sz * 4.1, sz < 0 ? 180 : 0, 1);
    b.prop('prop_terminal', -7, 0, z, 90, 1);
    b.prop('prop_terminal', 7, 0, z, -90, 1);
    b.spawnCluster(0, 0, z, [0, 0], team, 5, 7.5, 2.4, 'base');
    b.spawnCluster(0, 0, z, [0, 0], 0, 3, 5.5, 2);
  }

  // Side wings east/west - neutral, hold the flank weapons.
  for (const sx of [-1, 1] as const) {
    const x = sx * ROOM_OFFSET;
    b.room(x, 0, 9, 22, 0, 7, 'wallLight', {
      floorMat: 'concrete',
      ceilingMat: 'wallDark',
      doorWest: sx > 0 ? 10 : 0,
      doorEast: sx > 0 ? 0 : 10,
    });
    b.cover(x, -7, 1.2, 3.4, 0, 1.2, 'hull');
    b.cover(x, 7, 1.2, 3.4, 0, 1.2, 'hull');
    b.lightPanel(x, 6.7, 0, 4, 12, 0xdff2ff, 1.2, 18);
    b.prop('prop_crate_stack', x + sx * -2.6, 0, 0, 0, 1);
    b.prop('prop_holo_sign', x + sx * 4.1, 4.6, 0, sx > 0 ? -90 : 90, 1, 0x4fe0ff);
    b.spawnLookingAt(x - sx * 1.6, 0, -5.5, 0, 0, 0);
    b.spawnLookingAt(x - sx * 1.6, 0, 5.5, 0, 0, 0);
  }

  // Extra neutral spawns for FFA spread; every one looks at the spire.
  for (const [x, y, z] of [
    [-R, RING_Y, 0],
    [R, RING_Y, 0],
    [0, RING_Y, -R],
    [0, RING_Y, R],
    // Off the tower centres, which hold cover blocks.
    [-16.5, TOWER_Y, -11.5],
    [16.5, TOWER_Y, 11.5],
    [-11, 3.4, 11],
    [11, 3.4, -11],
    // Beside the arm ramps rather than on them.
    [-6, 0, -26],
    [6, 0, 26],
  ] as const) {
    b.spawnLookingAt(x, y, z, 0, 0, 0);
  }

  // ---------------------------------------------------------------- cover
  const cargo: readonly [number, number, number, number][] = [
    [-17, -8, 0, 1.7],
    [-17, -6.1, 0, 1.7],
    [-17, -7, 1.7, 1.7],
    [17, 8, 0, 1.7],
    [17, 6.1, 0, 1.7],
    [17, 7, 1.7, 1.7],
    [-8, -17, 0, 1.6],
    [8, 17, 0, 1.6],
    [0, -19, 0, 1.5],
    [0, 19, 0, 1.5],
    [-19, 0, 0, 1.5],
    [19, 0, 0, 1.5],
  ];
  cargo.forEach(([x, z, y, s], i) => b.crate(x, z, y, s, i % 2 ? 'crateAlt' : 'crate', (i * 23) % 90));

  for (const [x, z, w, d, ry] of [
    [-6, -6, 3.2, 1.1, 0],
    [6, 6, 3.2, 1.1, 0],
    [-6, 6, 1.1, 3.2, 0],
    [6, -6, 1.1, 3.2, 0],
    [0, -30, 5, 1.2, 0],
    [0, 30, 5, 1.2, 0],
  ] as const) {
    b.cover(x, z, w, d, 0, 1.15, 'hull', ry);
  }

  // ------------------------------------------------------------- lighting
  for (const [x, z] of [
    [-16, -16],
    [16, -16],
    [-16, 16],
    [16, 16],
    [0, -30],
    [0, 30],
    [-30, 0],
    [30, 0],
  ] as const) {
    b.lightPanel(x, 19, z, 6, 6, 0xe6f4ff, 1.0, 26);
  }
  b.light('point', 0, 4, -22, 0x2ce8ff, 1.1, 18);
  b.light('point', 0, 4, 22, 0xff5a3c, 1.1, 18);

  // ----------------------------------------------------------- objectives
  b.objective({ id: 'A', kind: 'zone', p: [-28, 0, 0], radius: 6, label: 'A', order: 0 });
  b.objective({ id: 'B', kind: 'zone', p: [0, 0, 0], radius: 7.5, label: 'B', order: 1 });
  b.objective({ id: 'C', kind: 'zone', p: [28, 0, 0], radius: 6, label: 'C', order: 2 });
  b.objective({ id: 'H1', kind: 'hardpoint', p: [0, 0, 0], radius: 7.5, label: 'SPIRE', order: 0 });
  b.objective({ id: 'H2', kind: 'hardpoint', p: [-28, 0, 0], radius: 6, label: 'WEST WING', order: 1 });
  b.objective({ id: 'H3', kind: 'hardpoint', p: [0, RING_Y, -17], radius: 5.5, label: 'NORTH RING', order: 2 });
  b.objective({ id: 'H4', kind: 'hardpoint', p: [28, 0, 0], radius: 6, label: 'EAST WING', order: 3 });
  b.objective({ id: 'H5', kind: 'hardpoint', p: [0, RING_Y, 17], radius: 5.5, label: 'SOUTH RING', order: 4 });
  b.objective({ id: 'CORE_ION', kind: 'core', p: [0, 0, -ROOM_OFFSET + 2], radius: 2.4, label: 'ION CORE', team: 1 });
  b.objective({ id: 'CORE_EMBER', kind: 'core', p: [0, 0, ROOM_OFFSET - 2], radius: 2.4, label: 'EMBER CORE', team: 2 });

  // -------------------------------------------------------------- pickups
  b.weaponPickup('pk_rail', 'rail_sniper', -14, TOWER_Y, -14, 34);
  b.weaponPickup('pk_rail2', 'rail_sniper', 14, TOWER_Y, 14, 34);
  b.weaponPickup('pk_lmg', 'particle_lmg', -ROOM_OFFSET, 0, 0, 28);
  b.weaponPickup('pk_launcher', 'arc_launcher', ROOM_OFFSET, 0, 0, 30);
  b.weaponPickup('pk_shotgun', 'ion_shotgun', 0, 0, 0, 22);
  b.healthPickup('hp_n', 0, RING_Y, -17, 50, 20);
  b.healthPickup('hp_s', 0, RING_Y, 17, 50, 20);
  b.healthPickup('hp_w', -19, 0, 0, 50, 20);
  b.healthPickup('hp_e', 19, 0, 0, 50, 20);
  b.shieldPickup('sh_n', -11, 3.4, -11, 40, 26);
  b.shieldPickup('sh_s', 11, 3.4, 11, 40, 26);
  b.ammoPickup('am_1', -14, 0, 0);
  b.ammoPickup('am_2', 14, 0, 0);
  b.ammoPickup('am_3', 0, 0, -14);
  b.ammoPickup('am_4', 0, 0, 14);
  b.ammoPickup('am_5', -17, RING_Y, 0);
  b.ammoPickup('am_6', 17, RING_Y, 0);

  // ---------------------------------------------------------------- props
  b.prop('prop_pipe_run', -21, 12, -21, 45, 1);
  b.prop('prop_pipe_run', 21, 12, 21, 45, 1);
  b.prop('prop_vent', -21, 5.5, 0, 90, 1);
  b.prop('prop_vent', 21, 5.5, 0, -90, 1);
  b.prop('prop_barrel', -18, 0, -12, 0, 1);
  b.prop('prop_barrel', 18, 0, 12, 0, 1);
  b.prop('prop_terminal', -5, 0, -18, 0, 1);
  b.prop('prop_terminal', 5, 0, 18, 180, 1);
  b.prop('prop_satellite', -34, 14, -34, 30, 2);
  b.prop('prop_satellite', 34, 14, 34, -150, 2);

  return b.finish(
    { minX: -bound, maxX: bound, minZ: -bound, maxZ: bound },
    -8,
    {
      skybox: 'orbital',
      fogColor: 0x0a1020,
      fogDensity: 0.006,
      hemiSky: 0x6f8fc4,
      hemiGround: 0x171d2c,
      hemiIntensity: 0.7,
      sunColor: 0xffffff,
      sunIntensity: 1.5,
      sunDir: [0.55, -0.7, 0.4],
      ambientLoop: 'amb_orbital',
      neonBoost: 1.25,
    },
  );
}
