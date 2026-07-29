/**
 * @neon/shared - the single source of truth for everything both the client and
 * the authoritative server need to agree on.
 *
 * Import from here (`@neon/shared`) rather than reaching into subpaths so the
 * public surface stays reviewable.
 */

export * from './constants.js';
export * from './math.js';
export * from './types.js';
export * from './protocol.js';

export * from './sim/world.js';
export * from './sim/movement.js';
export * from './sim/ballistics.js';
export * from './sim/navmesh.js';

export * from './data/weapons.js';
export * from './data/classes.js';
export * from './data/modes.js';
export * from './data/mapkit.js';
export * from './data/maps/index.js';
export * from './data/progression.js';
export * from './data/cosmetics.js';
export * from './data/achievements.js';
export * from './data/settings.js';

export const BUILD_INFO = {
  name: 'NEON STRIKE',
  version: '1.0.0',
  codename: 'Ion Cascade',
} as const;
