/**
 * Procedural SVG icons.
 *
 * Drawn as inline SVG paths rather than an icon font or sprite sheet: they are
 * original by construction, scale cleanly at any UI scale, recolour with CSS,
 * and add nothing to the download.
 *
 * Weapon icons are deliberately silhouette-first so a kill-feed entry reads at
 * 22px, which is the size that actually matters.
 */

function svg(size: number, color: string, body: string, viewBox = '0 0 48 24'): string {
  return `<svg width="${size}" height="${(size * 24) / 48}" viewBox="${viewBox}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
}

function square(size: number, color: string, body: string): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
}

const WEAPON_PATHS: Record<string, string> = {
  // Bullpup rifle: long body, top rail, angled magazine.
  ar: '<path d="M4 11h30l6-2v4l-6 1H4z" fill="currentColor" fill-opacity=".18"/><path d="M8 12v5l3 3"/><path d="M17 13v6h5l-1-6"/><path d="M12 9h18"/><path d="M40 10.5h5"/>',
  // Compact SMG: short body, forward magazine.
  smg: '<path d="M8 11h22l5-1.5v3.5l-5 1H8z" fill="currentColor" fill-opacity=".18"/><path d="M11 12v5l3 3"/><path d="M19 13v5h4l-1-5"/><path d="M14 9h13"/><path d="M35 11h5"/>',
  // Sniper: very long, big scope.
  sniper: '<path d="M3 12h34l8-1v2l-8 1H3z" fill="currentColor" fill-opacity=".18"/><path d="M7 13v5l3 3"/><path d="M14 8h14v3H14z"/><path d="M16 13v5h4"/><path d="M37 11.5h8"/>',
  // Shotgun: twin bores, pump.
  shotgun: '<path d="M6 10h26l8 1v2l-8 1H6z" fill="currentColor" fill-opacity=".18"/><path d="M9 13v5l3 3"/><path d="M18 15h9v3h-9z"/><path d="M32 10.5h10M32 13.5h10"/>',
  // LMG: drum + heat shroud.
  lmg: '<path d="M6 10h24l10 1v3l-10 1H6z" fill="currentColor" fill-opacity=".18"/><path d="M9 14v4l3 3"/><circle cx="20" cy="19" r="4"/><path d="M12 8h14"/><path d="M31 10h9M31 14h9"/>',
  // Carbine: mid-length with a boxy optic.
  carbine: '<path d="M6 11h26l7-1v4l-7 1H6z" fill="currentColor" fill-opacity=".18"/><path d="M10 12v5l3 3"/><path d="M18 13v5h4l-1-5"/><path d="M15 7h8v4h-8z"/><path d="M39 11h5"/>',
  // Pistol: L-shape.
  pistol: '<path d="M14 10h18l4 1v3l-4 1H14z" fill="currentColor" fill-opacity=".18"/><path d="M17 14v6l4 3"/><path d="M22 15h6"/><path d="M36 12h4"/>',
  // Revolver: cylinder bulge.
  revolver: '<path d="M14 10h16l6 1v3l-6 1H14z" fill="currentColor" fill-opacity=".18"/><circle cx="20" cy="12.5" r="3.4"/><path d="M17 15v5l4 3"/><path d="M36 12h5"/>',
  // Blade: hilt plus a long tapered edge.
  blade: '<path d="M8 16l4-4 26-6-4 8-22 6z" fill="currentColor" fill-opacity=".18"/><path d="M8 16l4-4 26-6-4 8-22 6z"/><path d="M6 18l4-4"/><path d="M12 12l24-6"/>',
  // Launcher: fat tube.
  launcher: '<path d="M6 9h30l8 2v3l-8 2H6z" fill="currentColor" fill-opacity=".18"/><path d="M10 15v4l3 3"/><path d="M20 16h8"/><circle cx="17" cy="12.5" r="2"/><path d="M36 11h8M36 15h8"/>',
};

const WEAPON_TO_ICON: Record<string, string> = {
  pulse_ar: 'ar',
  plasma_smg: 'smg',
  rail_sniper: 'sniper',
  ion_shotgun: 'shotgun',
  particle_lmg: 'lmg',
  burst_carbine: 'carbine',
  energy_pistol: 'pistol',
  tactical_revolver: 'revolver',
  plasma_blade: 'blade',
  arc_launcher: 'launcher',
  sentry_turret: 'lmg',
};

export function weaponIcon(weaponId: string, size = 32, color = 'currentColor'): string {
  const key = WEAPON_TO_ICON[weaponId] ?? weaponId;
  const body = WEAPON_PATHS[key];
  if (!body) return square(size, color, '<circle cx="12" cy="12" r="8"/>');
  return `<span style="color:${color};display:inline-flex">${svg(size, 'currentColor', body)}</span>`;
}

const CLASS_PATHS: Record<string, string> = {
  // Squared pauldrons.
  vanguard: '<path d="M12 3l6 3v5l-6 3-6-3V6z" fill="currentColor" fill-opacity=".2"/><path d="M12 3l6 3v5l-6 3-6-3V6z"/><path d="M4 21v-4l4-2M20 21v-4l-4-2"/>',
  // Hood.
  phantom: '<path d="M12 3c4 0 6 3 6 7l-6 4-6-4c0-4 2-7 6-7z" fill="currentColor" fill-opacity=".2"/><path d="M12 3c4 0 6 3 6 7l-6 4-6-4c0-4 2-7 6-7z"/><path d="M6 21l3-6M18 21l-3-6"/>',
  // Dome + wide shoulders.
  titan: '<path d="M12 3a6 6 0 016 6v3H6V9a6 6 0 016-6z" fill="currentColor" fill-opacity=".2"/><path d="M12 3a6 6 0 016 6v3H6V9a6 6 0 016-6z"/><path d="M3 21v-6l4-3M21 21v-6l-4-3"/><path d="M8 12h8"/>',
  // Crest.
  warden: '<path d="M12 2l2 5h5l-4 4 2 6-5-3-5 3 2-6-4-4h5z" fill="currentColor" fill-opacity=".2"/><path d="M12 2l2 5h5l-4 4 2 6-5-3-5 3 2-6-4-4h5z"/><path d="M12 17v5"/>',
  // Optic pod.
  spectre: '<circle cx="12" cy="9" r="5" fill="currentColor" fill-opacity=".2"/><circle cx="12" cy="9" r="5"/><circle cx="12" cy="9" r="1.6"/><path d="M12 14v8M7 22l5-4 5 4"/>',
  // Antenna rig.
  engineer: '<rect x="6" y="7" width="12" height="8" rx="1" fill="currentColor" fill-opacity=".2"/><rect x="6" y="7" width="12" height="8" rx="1"/><path d="M9 7V3M15 7V3M12 7V4"/><path d="M6 15l-2 6M18 15l2 6"/>',
};

export function classIcon(classId: string, size = 28, color = 'currentColor'): string {
  const body = CLASS_PATHS[classId] ?? CLASS_PATHS.vanguard;
  return `<span style="color:${color};display:inline-flex">${square(size, 'currentColor', body)}</span>`;
}

const MODE_PATHS: Record<string, string> = {
  ffa: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  tdm: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M3 20c0-3 2-5 5-5s5 2 5 5M11 20c0-3 2-5 5-5s5 2 5 5"/>',
  dom: '<rect x="3" y="8" width="5" height="8"/><rect x="10" y="5" width="5" height="14"/><rect x="17" y="8" width="5" height="8"/>',
  hp: '<circle cx="12" cy="12" r="8" stroke-dasharray="4 3"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  ctc: '<path d="M6 3v18"/><path d="M6 4h11l-3 4 3 4H6" fill="currentColor" fill-opacity=".2"/><path d="M6 4h11l-3 4 3 4H6"/>',
  guns: '<path d="M3 9h14l4 2v2l-4 1H3z"/><path d="M7 12v4l3 3"/><path d="M16 5v3M20 4v4"/>',
  elim: '<path d="M12 3l8 5v8l-8 5-8-5V8z"/><path d="M9 10l6 6M15 10l-6 6"/>',
  custom: '<path d="M12 3l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z"/><path d="M12 17v4"/>',
};

export function modeIcon(iconKey: string, size = 24, color = 'currentColor'): string {
  const body = MODE_PATHS[iconKey] ?? MODE_PATHS.tdm;
  return `<span style="color:${color};display:inline-flex">${square(size, 'currentColor', body)}</span>`;
}

/** The NEON STRIKE mark: a hex plate with a bolt cut through it. */
export function logoMark(size = 64, color = '#2ce8ff'): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M32 4 56 17v30L32 60 8 47V17z" stroke="${color}" stroke-width="2.6" fill="rgba(44,232,255,0.06)"/>
    <path d="M32 10 50 20v24L32 54 14 44V20z" stroke="${color}" stroke-opacity=".35" stroke-width="1.2"/>
    <path d="M36.5 16 22 34h9l-2.5 14L44 30h-9.5z" fill="${color}"/>
  </svg>`;
}

export function logoWordmark(): string {
  return `<span class="logo">
    <span class="logo__mark">${logoMark(46)}</span>
    <span class="logo__text"><b>NEON</b><i>STRIKE</i></span>
  </span>`;
}

/** Simple utility glyphs used across the menus. */
const UI_PATHS: Record<string, string> = {
  play: '<path d="M8 5l12 7-12 7z" fill="currentColor"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 01-10 0z"/><path d="M7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3"/><path d="M12 14v4M8 21h8"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/>',
  bolt: '<path d="M13 2L5 14h6l-1 8 8-12h-6z" fill="currentColor"/>',
  chat: '<path d="M4 5h16v10H9l-5 4z"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M16 6a3 3 0 010 6M18 20c0-2-1-3.5-2.5-4.5"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="1"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  flame: '<path d="M12 3c4 5 6 7 6 11a6 6 0 01-12 0c0-3 2-5 3-7 1 2 2 2 3 1z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
};

export function uiIcon(key: string, size = 20, color = 'currentColor'): string {
  const body = UI_PATHS[key] ?? UI_PATHS.bolt;
  return `<span style="color:${color};display:inline-flex;vertical-align:middle">${square(size, 'currentColor', body)}</span>`;
}

/** Banner/profile-icon glyphs, drawn as abstract emblems. */
export function glyphIcon(glyph: string, size = 32, color = '#4fd8ff'): string {
  const bodies: Record<string, string> = {
    grid: '<path d="M3 3h18v18H3z"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
    pulse: '<path d="M2 12h4l3-7 4 14 3-7h6"/>',
    flame: UI_PATHS.flame,
    orbit: '<circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10" ry="4"/>',
    shatter: '<path d="M12 2l4 8-4 3 5 9-9-7 3-4-4-6z"/>',
    apex: '<path d="M12 2l5 8h-10z"/><path d="M4 14h16l-8 8z"/>',
    chevron1: '<path d="M4 16l8-8 8 8"/>',
    chevron2: '<path d="M4 13l8-8 8 8M4 19l8-8 8 8"/>',
    crest: CLASS_PATHS.vanguard,
    phantom: CLASS_PATHS.phantom,
    titan: CLASS_PATHS.titan,
    reticle: UI_PATHS.crosshair,
    star: '<path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/>',
    bolt: UI_PATHS.bolt,
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    skull: '<path d="M12 3a7 7 0 017 7v4l-2 2v3H7v-3l-2-2v-4a7 7 0 017-7z"/><circle cx="9.5" cy="11" r="1.4" fill="currentColor"/><circle cx="14.5" cy="11" r="1.4" fill="currentColor"/>',
    reactor: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  };
  const body = bodies[glyph] ?? bodies.grid;
  return `<span style="color:${color};display:inline-flex">${square(size, 'currentColor', body)}</span>`;
}
