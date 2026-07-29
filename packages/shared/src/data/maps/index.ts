import type { MapDef } from '../../sim/world.js';
import { buildMirageDistrict } from './mirageDistrict.js';
import { buildNeonFoundry } from './neonFoundry.js';
import { buildOrbitalNexus } from './orbitalNexus.js';

/** Map definitions are built lazily and cached - each is a few thousand brushes. */
const builders: Record<string, () => MapDef> = {
  neon_foundry: buildNeonFoundry,
  orbital_nexus: buildOrbitalNexus,
  mirage_district: buildMirageDistrict,
};

const cache = new Map<string, MapDef>();

export const MAP_ORDER: readonly string[] = ['neon_foundry', 'orbital_nexus', 'mirage_district'];

export interface MapSummary {
  id: string;
  name: string;
  tagline: string;
  modes: string[];
  /** Approximate playable footprint, for the UI. */
  size: string;
  brushCount: number;
  spawnCount: number;
}

export function getMap(id: string): MapDef {
  let m = cache.get(id);
  if (!m) {
    const build = builders[id];
    if (!build) throw new Error(`Unknown map: ${id}`);
    m = build();
    cache.set(id, m);
  }
  return m;
}

export function isMapId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(builders, id);
}

export function mapSummaries(): MapSummary[] {
  return MAP_ORDER.map((id) => {
    const m = getMap(id);
    const w = Math.round(m.bounds.maxX - m.bounds.minX);
    const d = Math.round(m.bounds.maxZ - m.bounds.minZ);
    return {
      id: m.id,
      name: m.name,
      tagline: m.tagline,
      modes: m.modes,
      size: `${w}x${d}m`,
      brushCount: m.brushes.length,
      spawnCount: m.spawns.length,
    };
  });
}

/** Maps that support a given mode, falling back to all maps. */
export function mapsForMode(modeId: string): string[] {
  const list = MAP_ORDER.filter((id) => getMap(id).modes.includes(modeId));
  return list.length > 0 ? list : [...MAP_ORDER];
}

export { buildNeonFoundry, buildOrbitalNexus, buildMirageDistrict };
