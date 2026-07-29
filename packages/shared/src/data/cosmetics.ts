/**
 * Cosmetics.
 *
 * Every item is earned by playing. Nothing here changes a hitbox, a damage
 * number, a movement value or a silhouette's readability: skins recolour and
 * re-trim, they never alter proportions.  That is a deliberate competitive
 * constraint, not an oversight.
 */

import type { UnlockRequirement } from './progression.js';

export type CosmeticKind =
  | 'bodyColor'
  | 'armorVariant'
  | 'weaponSkin'
  | 'charm'
  | 'banner'
  | 'icon'
  | 'emote'
  | 'killEffect'
  | 'crosshair';

export type Rarity = 'standard' | 'refined' | 'elite' | 'prototype';

export const RARITY_COLORS: Record<Rarity, string> = {
  standard: '#8fa3bd',
  refined: '#4fd8ff',
  elite: '#c07bff',
  prototype: '#ffb03a',
};

export interface CosmeticDef {
  id: string;
  name: string;
  kind: CosmeticKind;
  rarity: Rarity;
  description: string;
  unlock?: UnlockRequirement;
  /** Primary colour, used by both the 3D material and the UI swatch. */
  color?: number;
  /** Secondary / trim colour. */
  accent?: number;
  /** Emissive colour for energy trims. */
  emissive?: number;
  /** Restricts a weapon skin to one weapon, or one class for armour. */
  appliesTo?: string[];
  /** Procedural pattern key used by the client's material generator. */
  pattern?: 'flat' | 'split' | 'stripe' | 'hex' | 'circuit' | 'camo' | 'gradient' | 'shatter';
  /** For crosshairs: the drawing parameters. */
  crosshair?: CrosshairPreset;
  /** For emotes: animation key. */
  anim?: string;
  /** For kill effects: particle key. */
  effect?: string;
  /** For banners/icons: procedural glyph key. */
  glyph?: string;
}

export interface CrosshairPreset {
  shape: 'cross' | 'dot' | 'circle' | 'chevron' | 'brackets' | 'tshape';
  size: number;
  thickness: number;
  gap: number;
  dot: boolean;
  outline: boolean;
  color: string;
  /** Expand with weapon bloom. */
  dynamic: boolean;
}

// ---------------------------------------------------------------------------

const c = (
  id: string,
  name: string,
  kind: CosmeticKind,
  rarity: Rarity,
  description: string,
  extra: Partial<CosmeticDef> = {},
): CosmeticDef => ({ id, name, kind, rarity, description, ...extra });

export const COSMETICS: Record<string, CosmeticDef> = {};

function reg(...items: CosmeticDef[]): void {
  for (const it of items) COSMETICS[it.id] = it;
}

// -- body colours ------------------------------------------------------------
reg(
  c('body_default', 'Standard Issue', 'bodyColor', 'standard', 'Factory plating.', { color: 0x9aa7bd, accent: 0x2a3140, pattern: 'flat' }),
  c('body_slate', 'Slate', 'bodyColor', 'standard', 'Matte graphite shell.', { color: 0x5a6478, accent: 0x22262f, pattern: 'flat' }),
  c('body_bone', 'Bone', 'bodyColor', 'standard', 'Pale composite.', { color: 0xd9d3c4, accent: 0x4a4638, pattern: 'flat' }),
  c('body_ion', 'Ion Wash', 'bodyColor', 'refined', 'Cyan anodised trim.', {
    color: 0x2f4a5c,
    accent: 0x2ce8ff,
    emissive: 0x2ce8ff,
    pattern: 'stripe',
    unlock: { kind: 'level', value: 4 },
  }),
  c('body_ember', 'Ember Wash', 'bodyColor', 'refined', 'Heat-treated orange.', {
    color: 0x5c3a2f,
    accent: 0xff5a3c,
    emissive: 0xff5a3c,
    pattern: 'stripe',
    unlock: { kind: 'level', value: 6 },
  }),
  c('body_verdant', 'Verdant', 'bodyColor', 'refined', 'Reactor-green field kit.', {
    color: 0x2f4a34,
    accent: 0x8dff4a,
    emissive: 0x8dff4a,
    pattern: 'camo',
    unlock: { kind: 'level', value: 9 },
  }),
  c('body_violet', 'Violet Cascade', 'bodyColor', 'elite', 'Prototype photonic weave.', {
    color: 0x3a2f5c,
    accent: 0xc7a2ff,
    emissive: 0xc7a2ff,
    pattern: 'gradient',
    unlock: { kind: 'level', value: 18 },
  }),
  c('body_hexline', 'Hexline', 'bodyColor', 'elite', 'Tessellated armour lattice.', {
    color: 0x2a3140,
    accent: 0x4fd8ff,
    emissive: 0x4fd8ff,
    pattern: 'hex',
    unlock: { kind: 'stat', target: 'kills', value: 500 },
  }),
  c('body_apex', 'Apex Chrome', 'bodyColor', 'prototype', 'Awarded for sustained dominance.', {
    color: 0xdfe8f4,
    accent: 0xffb03a,
    emissive: 0xffb03a,
    pattern: 'shatter',
    unlock: { kind: 'level', value: 40 },
  }),
);

// -- armour variants ---------------------------------------------------------
reg(
  c('armor_standard', 'Standard Rig', 'armorVariant', 'standard', 'Baseline plate layout.'),
  c('armor_light', 'Stripped Rig', 'armorVariant', 'standard', 'Fewer plates, same silhouette.'),
  c('armor_heavy', 'Reinforced Rig', 'armorVariant', 'refined', 'Extra shoulder and shin plating.', {
    unlock: { kind: 'level', value: 7 },
  }),
  c('armor_recon', 'Recon Rig', 'armorVariant', 'refined', 'Antenna cluster and side pouches.', {
    unlock: { kind: 'level', value: 12 },
  }),
  c('armor_prototype', 'Prototype Rig', 'armorVariant', 'elite', 'Exposed energy conduits.', {
    unlock: { kind: 'level', value: 25 },
  }),
  c('armor_veteran', 'Veteran Rig', 'armorVariant', 'prototype', 'Battle-scored plating with kill tallies.', {
    unlock: { kind: 'stat', target: 'matchesPlayed', value: 100 },
  }),
);

// -- weapon skins ------------------------------------------------------------
const skin = (
  id: string,
  name: string,
  rarity: Rarity,
  description: string,
  color: number,
  accent: number,
  emissive: number,
  pattern: CosmeticDef['pattern'],
  unlock?: UnlockRequirement,
): CosmeticDef => c(id, name, 'weaponSkin', rarity, description, { color, accent, emissive, pattern, unlock });

reg(
  skin('skin_default', 'Factory', 'standard', 'As issued.', 0x6a7385, 0x2a3140, 0x000000, 'flat'),
  skin('skin_carbon', 'Carbon', 'standard', 'Weave-wrapped body.', 0x2b2f36, 0x151820, 0x000000, 'hex'),
  skin('skin_arctic', 'Arctic', 'standard', 'High-visibility white shell.', 0xdfe6ef, 0x8b95a5, 0x000000, 'split'),
  skin('skin_ionflow', 'Ion Flow', 'refined', 'Cyan coolant channels.', 0x33414f, 0x2ce8ff, 0x2ce8ff, 'circuit', {
    kind: 'weaponMastery',
    target: 'any',
    value: 3,
  }),
  skin('skin_emberline', 'Ember Line', 'refined', 'Heat-scored barrel shroud.', 0x4a3128, 0xff7a3c, 0xff5a3c, 'stripe', {
    kind: 'weaponMastery',
    target: 'any',
    value: 5,
  }),
  skin('skin_toxin', 'Toxin', 'refined', 'Reactor-green venting.', 0x2c3a2c, 0x8dff4a, 0x8dff4a, 'camo', {
    kind: 'weaponMastery',
    target: 'any',
    value: 7,
  }),
  skin('skin_nebula', 'Nebula', 'elite', 'Iridescent violet finish.', 0x352c4f, 0xc7a2ff, 0xc7a2ff, 'gradient', {
    kind: 'weaponMastery',
    target: 'any',
    value: 12,
  }),
  skin('skin_shatter', 'Shatterplate', 'elite', 'Fractured ablative armour.', 0x1f2530, 0x4fd8ff, 0x4fd8ff, 'shatter', {
    kind: 'weaponMastery',
    target: 'any',
    value: 18,
  }),
  skin('skin_apex', 'Apex', 'prototype', 'Gold-trimmed mastery finish.', 0x27221a, 0xffb03a, 0xffb03a, 'gradient', {
    kind: 'weaponMastery',
    target: 'any',
    value: 25,
  }),
);

// -- charms ------------------------------------------------------------------
reg(
  c('charm_none', 'None', 'charm', 'standard', 'No charm.'),
  c('charm_bolt', 'Arc Bolt', 'charm', 'standard', 'A tiny sparking bolt.', { color: 0x2ce8ff, glyph: 'bolt' }),
  c('charm_cube', 'Data Cube', 'charm', 'refined', 'Spinning holographic cube.', {
    color: 0x8dff4a,
    glyph: 'cube',
    unlock: { kind: 'level', value: 5 },
  }),
  c('charm_skullchip', 'Skullchip', 'charm', 'refined', 'A grinning circuit die.', {
    color: 0xff5a3c,
    glyph: 'skull',
    unlock: { kind: 'stat', target: 'kills', value: 250 },
  }),
  c('charm_reactor', 'Micro Reactor', 'charm', 'elite', 'Contained plasma bead.', {
    color: 0xc7a2ff,
    glyph: 'reactor',
    unlock: { kind: 'level', value: 22 },
  }),
  c('charm_apex', 'Apex Sigil', 'charm', 'prototype', 'For those who finished the climb.', {
    color: 0xffb03a,
    glyph: 'apex',
    unlock: { kind: 'level', value: 50 },
  }),
);

// -- banners -----------------------------------------------------------------
reg(
  c('banner_grid', 'Grid', 'banner', 'standard', 'Default lattice banner.', { color: 0x2a3140, accent: 0x4fd8ff, glyph: 'grid' }),
  c('banner_pulse', 'Pulse', 'banner', 'standard', 'Waveform banner.', { color: 0x1d2b3a, accent: 0x2ce8ff, glyph: 'pulse' }),
  c('banner_ember', 'Ember Rise', 'banner', 'refined', 'Rising heat plume.', {
    color: 0x3a1d16,
    accent: 0xff5a3c,
    glyph: 'flame',
    unlock: { kind: 'level', value: 8 },
  }),
  c('banner_orbit', 'Orbital', 'banner', 'refined', 'Station silhouette.', {
    color: 0x141c2e,
    accent: 0x8fb4ff,
    glyph: 'orbit',
    unlock: { kind: 'level', value: 14 },
  }),
  c('banner_shatter', 'Shatter', 'banner', 'elite', 'Cracked plate motif.', {
    color: 0x241f2e,
    accent: 0xc7a2ff,
    glyph: 'shatter',
    unlock: { kind: 'level', value: 28 },
  }),
  c('banner_apex', 'Apex', 'banner', 'prototype', 'Gold laurel lattice.', {
    color: 0x241d10,
    accent: 0xffb03a,
    glyph: 'apex',
    unlock: { kind: 'level', value: 60 },
  }),
);

// -- profile icons -----------------------------------------------------------
reg(
  c('icon_recruit', 'Recruit', 'icon', 'standard', 'Starting insignia.', { color: 0x8fa3bd, glyph: 'chevron1' }),
  c('icon_operative', 'Operative', 'icon', 'standard', 'Second tier insignia.', { color: 0x4fd8ff, glyph: 'chevron2' }),
  c('icon_vanguard', 'Vanguard Crest', 'icon', 'refined', 'Assault division mark.', {
    color: 0x2ce8ff,
    glyph: 'crest',
    unlock: { kind: 'classMastery', target: 'vanguard', value: 5 },
  }),
  c('icon_phantom', 'Phantom Mark', 'icon', 'refined', 'Scout division mark.', {
    color: 0x8dff4a,
    glyph: 'phantom',
    unlock: { kind: 'classMastery', target: 'phantom', value: 5 },
  }),
  c('icon_titan', 'Titan Seal', 'icon', 'refined', 'Heavy division mark.', {
    color: 0xffa62c,
    glyph: 'titan',
    unlock: { kind: 'classMastery', target: 'titan', value: 5 },
  }),
  c('icon_marksman', 'Marksman Reticle', 'icon', 'elite', 'Awarded for headshot mastery.', {
    color: 0xc7a2ff,
    glyph: 'reticle',
    unlock: { kind: 'stat', target: 'headshots', value: 500 },
  }),
  c('icon_apex', 'Apex Star', 'icon', 'prototype', 'The last icon.', {
    color: 0xffb03a,
    glyph: 'star',
    unlock: { kind: 'level', value: 75 },
  }),
);

// -- emotes ------------------------------------------------------------------
reg(
  c('emote_salute', 'Salute', 'emote', 'standard', 'Respect.', { anim: 'salute' }),
  c('emote_taunt', 'Beckon', 'emote', 'standard', 'Come on then.', { anim: 'beckon' }),
  c('emote_reload_flair', 'Spin Check', 'emote', 'refined', 'Weapon flourish.', {
    anim: 'spin',
    unlock: { kind: 'level', value: 10 },
  }),
  c('emote_scan', 'Field Scan', 'emote', 'refined', 'Sweep a holo scanner.', {
    anim: 'scan',
    unlock: { kind: 'level', value: 16 },
  }),
  c('emote_victory', 'Overcharge', 'emote', 'elite', 'Vent your reactor.', {
    anim: 'overcharge',
    unlock: { kind: 'level', value: 32 },
  }),
);

// -- kill effects ------------------------------------------------------------
reg(
  c('kill_default', 'Standard Dissipation', 'killEffect', 'standard', 'A clean shutdown.', { effect: 'default', color: 0x9aa7bd }),
  c('kill_shards', 'Shard Burst', 'killEffect', 'refined', 'Body fragments into shards.', {
    effect: 'shards',
    color: 0x4fd8ff,
    unlock: { kind: 'stat', target: 'kills', value: 100 },
  }),
  c('kill_ember', 'Ember Scatter', 'killEffect', 'refined', 'Scatters glowing embers.', {
    effect: 'ember',
    color: 0xff5a3c,
    unlock: { kind: 'stat', target: 'kills', value: 300 },
  }),
  c('kill_collapse', 'Field Collapse', 'killEffect', 'elite', 'Implodes into a point of light.', {
    effect: 'collapse',
    color: 0xc7a2ff,
    unlock: { kind: 'stat', target: 'kills', value: 750 },
  }),
  c('kill_apex', 'Apex Vent', 'killEffect', 'prototype', 'Gold plasma vent.', {
    effect: 'apex',
    color: 0xffb03a,
    unlock: { kind: 'level', value: 45 },
  }),
);

// -- crosshairs --------------------------------------------------------------
const xh = (
  id: string,
  name: string,
  rarity: Rarity,
  description: string,
  crosshair: CrosshairPreset,
  unlock?: UnlockRequirement,
): CosmeticDef => c(id, name, 'crosshair', rarity, description, { crosshair, unlock });

reg(
  xh('xh_cross', 'Classic Cross', 'standard', 'Four lines and a gap.', {
    shape: 'cross',
    size: 10,
    thickness: 2,
    gap: 4,
    dot: false,
    outline: true,
    color: '#7dffd0',
    dynamic: true,
  }),
  xh('xh_dot', 'Micro Dot', 'standard', 'A single pixel of truth.', {
    shape: 'dot',
    size: 3,
    thickness: 3,
    gap: 0,
    dot: true,
    outline: true,
    color: '#ffffff',
    dynamic: false,
  }),
  xh('xh_tshape', 'T-Shape', 'standard', 'No top line - cleaner target read.', {
    shape: 'tshape',
    size: 10,
    thickness: 2,
    gap: 4,
    dot: true,
    outline: true,
    color: '#7dffd0',
    dynamic: true,
  }),
  xh('xh_circle', 'Ring', 'refined', 'Open circle with a centre dot.', {
    shape: 'circle',
    size: 9,
    thickness: 2,
    gap: 0,
    dot: true,
    outline: true,
    color: '#4fd8ff',
    dynamic: true,
  }, { kind: 'level', value: 3 }),
  xh('xh_chevron', 'Chevron', 'refined', 'Angled brackets.', {
    shape: 'chevron',
    size: 11,
    thickness: 2,
    gap: 5,
    dot: false,
    outline: true,
    color: '#8dff4a',
    dynamic: true,
  }, { kind: 'level', value: 11 }),
  xh('xh_brackets', 'Brackets', 'elite', 'Corner brackets, dynamic.', {
    shape: 'brackets',
    size: 12,
    thickness: 2,
    gap: 6,
    dot: true,
    outline: true,
    color: '#c7a2ff',
    dynamic: true,
  }, { kind: 'level', value: 20 }),
);

export const COSMETIC_IDS = Object.keys(COSMETICS);

export function cosmeticsOfKind(kind: CosmeticKind): CosmeticDef[] {
  return COSMETIC_IDS.map((id) => COSMETICS[id]).filter((x) => x.kind === kind);
}

export function getCosmetic(id: string): CosmeticDef | undefined {
  return COSMETICS[id];
}

/** Items available with no unlock requirement - the guest starter set. */
export const DEFAULT_COSMETICS: Record<CosmeticKind, string> = {
  bodyColor: 'body_default',
  armorVariant: 'armor_standard',
  weaponSkin: 'skin_default',
  charm: 'charm_none',
  banner: 'banner_grid',
  icon: 'icon_recruit',
  emote: 'emote_salute',
  killEffect: 'kill_default',
  crosshair: 'xh_cross',
};

export function defaultUnlockedCosmetics(): string[] {
  return COSMETIC_IDS.filter((id) => !COSMETICS[id].unlock);
}
