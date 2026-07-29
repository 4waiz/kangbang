/**
 * Settings schema.
 *
 * A single declarative table drives:
 *   - defaults
 *   - the settings UI (label, control type, range, group)
 *   - localStorage serialisation + migration
 *   - server-side validation when settings sync to a profile
 *
 * Adding a setting means adding one row here; the UI builds itself.
 */

export type SettingGroup = 'controls' | 'graphics' | 'audio' | 'accessibility' | 'gameplay';
export type SettingControl = 'slider' | 'toggle' | 'select' | 'key' | 'color' | 'preset';

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  label: string;
  control: SettingControl;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string }[];
  default: number | boolean | string;
  /** Higher = riskier for performance; used by the auto-preset. */
  perfWeight?: number;
  /** Only shown when this predicate passes. */
  requires?: { key: string; equals: number | boolean | string };
}

const PRESET_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'custom', label: 'Custom' },
];

const QUALITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const SETTINGS_SPEC: SettingSpec[] = [
  // ---- controls ----------------------------------------------------------
  { key: 'sensitivity', group: 'controls', label: 'Mouse sensitivity', control: 'slider', min: 0.05, max: 8, step: 0.01, default: 1.4, help: 'Degrees of yaw per unit of mouse movement.' },
  { key: 'adsSensitivityMultiplier', group: 'controls', label: 'ADS sensitivity multiplier', control: 'slider', min: 0.1, max: 1.5, step: 0.01, default: 0.72 },
  { key: 'scopedSensitivityMultiplier', group: 'controls', label: 'Scoped sensitivity multiplier', control: 'slider', min: 0.1, max: 1.5, step: 0.01, default: 0.5 },
  { key: 'invertY', group: 'controls', label: 'Invert Y axis', control: 'toggle', default: false },
  { key: 'rawInput', group: 'controls', label: 'Raw mouse input', control: 'toggle', default: true, help: 'Uses unaccelerated pointer deltas where the browser exposes them.' },
  { key: 'holdToAim', group: 'controls', label: 'Aim mode', control: 'select', default: 'hold', options: [{ value: 'hold', label: 'Hold' }, { value: 'toggle', label: 'Toggle' }] },
  { key: 'holdToCrouch', group: 'controls', label: 'Crouch mode', control: 'select', default: 'hold', options: [{ value: 'hold', label: 'Hold' }, { value: 'toggle', label: 'Toggle' }] },
  { key: 'autoSprint', group: 'controls', label: 'Auto sprint', control: 'toggle', default: false },
  { key: 'slideOnCrouch', group: 'controls', label: 'Slide on crouch while sprinting', control: 'toggle', default: true },

  // ---- graphics ---------------------------------------------------------
  { key: 'preset', group: 'graphics', label: 'Performance preset', control: 'preset', default: 'high', options: PRESET_OPTIONS },
  { key: 'resolutionScale', group: 'graphics', label: 'Resolution scale', control: 'slider', min: 0.5, max: 1.5, step: 0.05, default: 1, perfWeight: 5 },
  { key: 'textureQuality', group: 'graphics', label: 'Texture quality', control: 'select', default: 'high', options: QUALITY_OPTIONS, perfWeight: 2 },
  { key: 'shadowQuality', group: 'graphics', label: 'Shadow quality', control: 'select', default: 'medium', options: [{ value: 'off', label: 'Off' }, ...QUALITY_OPTIONS], perfWeight: 4 },
  { key: 'effectsQuality', group: 'graphics', label: 'Effects quality', control: 'select', default: 'high', options: QUALITY_OPTIONS, perfWeight: 3 },
  { key: 'antialiasing', group: 'graphics', label: 'Anti-aliasing', control: 'select', default: 'fxaa', options: [{ value: 'off', label: 'Off' }, { value: 'fxaa', label: 'FXAA' }, { value: 'msaa', label: 'MSAA 4x' }], perfWeight: 3 },
  { key: 'bloom', group: 'graphics', label: 'Bloom', control: 'toggle', default: true, perfWeight: 2 },
  { key: 'vsync', group: 'graphics', label: 'V-Sync', control: 'toggle', default: true },
  { key: 'fpsLimit', group: 'graphics', label: 'FPS limit', control: 'slider', min: 30, max: 300, step: 5, default: 300, requires: { key: 'vsync', equals: false } },
  { key: 'fov', group: 'graphics', label: 'Field of view', control: 'slider', min: 70, max: 120, step: 1, default: 96 },
  { key: 'viewModelFov', group: 'graphics', label: 'View-model FOV', control: 'slider', min: 45, max: 90, step: 1, default: 68 },
  { key: 'motionBlur', group: 'graphics', label: 'Motion blur', control: 'toggle', default: false, perfWeight: 2 },
  { key: 'screenShake', group: 'graphics', label: 'Screen shake intensity', control: 'slider', min: 0, max: 1.5, step: 0.05, default: 0.85 },
  { key: 'showFps', group: 'graphics', label: 'Show FPS counter', control: 'toggle', default: false },
  { key: 'showPing', group: 'graphics', label: 'Show ping', control: 'toggle', default: true },
  { key: 'showNetGraph', group: 'graphics', label: 'Show network graph', control: 'toggle', default: false },
  { key: 'drawDistance', group: 'graphics', label: 'Draw distance', control: 'slider', min: 80, max: 400, step: 10, default: 260, perfWeight: 3 },
  { key: 'decalLimit', group: 'graphics', label: 'Bullet decal limit', control: 'slider', min: 0, max: 400, step: 10, default: 220, perfWeight: 1 },

  // ---- audio ------------------------------------------------------------
  { key: 'masterVolume', group: 'audio', label: 'Master volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.75 },
  { key: 'musicVolume', group: 'audio', label: 'Music volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.35 },
  { key: 'sfxVolume', group: 'audio', label: 'Effects volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.9 },
  { key: 'voiceVolume', group: 'audio', label: 'Voice volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.8 },
  { key: 'uiVolume', group: 'audio', label: 'UI volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: 'ambienceVolume', group: 'audio', label: 'Ambience volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.45 },
  { key: 'hitSoundVolume', group: 'audio', label: 'Hit confirmation volume', control: 'slider', min: 0, max: 1, step: 0.01, default: 0.7 },
  { key: 'muteWhenUnfocused', group: 'audio', label: 'Mute when tab loses focus', control: 'toggle', default: true },

  // ---- accessibility ----------------------------------------------------
  { key: 'colorblindMode', group: 'accessibility', label: 'Colourblind preset', control: 'select', default: 'off', options: [
    { value: 'off', label: 'Off' },
    { value: 'protanopia', label: 'Protanopia' },
    { value: 'deuteranopia', label: 'Deuteranopia' },
    { value: 'tritanopia', label: 'Tritanopia' },
    { value: 'highcontrast', label: 'High contrast' },
  ] },
  { key: 'enemyOutlines', group: 'accessibility', label: 'High-contrast enemy outlines', control: 'toggle', default: false },
  { key: 'reducedMotion', group: 'accessibility', label: 'Reduced motion', control: 'toggle', default: false, help: 'Disables camera shake, UI parallax and most transitions.' },
  { key: 'flashReduction', group: 'accessibility', label: 'Flash reduction', control: 'toggle', default: false, help: 'Caps muzzle flash and explosion brightness.' },
  { key: 'headBob', group: 'accessibility', label: 'Head bob', control: 'toggle', default: true },
  { key: 'subtitles', group: 'accessibility', label: 'Subtitles', control: 'toggle', default: false, help: 'Captions callouts and important audio cues.' },
  { key: 'uiScale', group: 'accessibility', label: 'Interface scale', control: 'slider', min: 0.75, max: 1.5, step: 0.05, default: 1 },
  { key: 'damageNumbers', group: 'accessibility', label: 'Damage numbers', control: 'toggle', default: true },
  { key: 'hitMarkerStyle', group: 'accessibility', label: 'Hit marker style', control: 'select', default: 'cross', options: [
    { value: 'cross', label: 'Cross' },
    { value: 'dot', label: 'Dot' },
    { value: 'brackets', label: 'Brackets' },
  ] },

  // ---- gameplay / HUD ---------------------------------------------------
  { key: 'crosshairId', group: 'gameplay', label: 'Crosshair', control: 'select', default: 'xh_cross', options: [] },
  { key: 'crosshairColor', group: 'gameplay', label: 'Crosshair colour', control: 'color', default: '#7dffd0' },
  { key: 'crosshairSize', group: 'gameplay', label: 'Crosshair size', control: 'slider', min: 2, max: 24, step: 1, default: 10 },
  { key: 'crosshairThickness', group: 'gameplay', label: 'Crosshair thickness', control: 'slider', min: 1, max: 6, step: 1, default: 2 },
  { key: 'crosshairGap', group: 'gameplay', label: 'Crosshair gap', control: 'slider', min: 0, max: 16, step: 1, default: 4 },
  { key: 'crosshairDot', group: 'gameplay', label: 'Centre dot', control: 'toggle', default: false },
  { key: 'crosshairDynamic', group: 'gameplay', label: 'Dynamic crosshair', control: 'toggle', default: true },
  { key: 'minimapSize', group: 'gameplay', label: 'Minimap size', control: 'slider', min: 100, max: 260, step: 10, default: 170 },
  { key: 'minimapRotate', group: 'gameplay', label: 'Rotate minimap', control: 'toggle', default: true },
  { key: 'killFeedLength', group: 'gameplay', label: 'Kill feed entries', control: 'slider', min: 3, max: 10, step: 1, default: 6 },
  { key: 'autoReload', group: 'gameplay', label: 'Auto reload when empty', control: 'toggle', default: true },
  { key: 'sprintFovBoost', group: 'gameplay', label: 'Sprint FOV boost', control: 'slider', min: 0, max: 12, step: 1, default: 6 },
  { key: 'preferredTeam', group: 'gameplay', label: 'Preferred team', control: 'select', default: 'auto', options: [
    { value: 'auto', label: 'Auto balance' },
    { value: 'ion', label: 'Ion' },
    { value: 'ember', label: 'Ember' },
  ] },
];

export type SettingsValue = number | boolean | string;
export type Settings = Record<string, SettingsValue>;

export const SETTINGS_BY_KEY: Record<string, SettingSpec> = {};
for (const s of SETTINGS_SPEC) SETTINGS_BY_KEY[s.key] = s;

export function defaultSettings(): Settings {
  const out: Settings = {};
  for (const s of SETTINGS_SPEC) out[s.key] = s.default;
  return out;
}

/** Clamp/coerce a single value against its spec. Unknown keys are dropped. */
export function coerceSetting(key: string, value: unknown): SettingsValue | undefined {
  const spec = SETTINGS_BY_KEY[key];
  if (!spec) return undefined;
  if (spec.control === 'toggle') {
    return typeof value === 'boolean' ? value : spec.default;
  }
  if (spec.control === 'slider') {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(spec.default);
    const lo = spec.min ?? -Infinity;
    const hi = spec.max ?? Infinity;
    return Math.min(hi, Math.max(lo, n));
  }
  if (spec.control === 'color') {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : String(spec.default);
  }
  if (spec.control === 'select' || spec.control === 'preset') {
    if (spec.options && spec.options.length > 0) {
      const ok = spec.options.some((o) => o.value === value);
      return ok ? (value as SettingsValue) : (spec.default as SettingsValue);
    }
    return typeof value === 'string' ? value : (spec.default as SettingsValue);
  }
  if (spec.control === 'key') {
    return typeof value === 'string' ? value : String(spec.default);
  }
  return spec.default;
}

/** Validate a whole settings blob, filling in defaults for anything missing. */
export function coerceSettings(raw: unknown): Settings {
  const out = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = coerceSetting(k, v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export function settingsInGroup(group: SettingGroup): SettingSpec[] {
  return SETTINGS_SPEC.filter((s) => s.group === group);
}

// ---------------------------------------------------------------------------
// Graphics presets
// ---------------------------------------------------------------------------

export const GRAPHICS_PRESETS: Record<string, Settings> = {
  low: {
    resolutionScale: 0.7,
    textureQuality: 'low',
    shadowQuality: 'off',
    effectsQuality: 'low',
    antialiasing: 'off',
    bloom: false,
    motionBlur: false,
    drawDistance: 120,
    decalLimit: 40,
  },
  medium: {
    resolutionScale: 0.9,
    textureQuality: 'medium',
    shadowQuality: 'low',
    effectsQuality: 'medium',
    antialiasing: 'fxaa',
    bloom: true,
    motionBlur: false,
    drawDistance: 190,
    decalLimit: 120,
  },
  high: {
    resolutionScale: 1,
    textureQuality: 'high',
    shadowQuality: 'medium',
    effectsQuality: 'high',
    antialiasing: 'fxaa',
    bloom: true,
    motionBlur: false,
    drawDistance: 260,
    decalLimit: 220,
  },
  ultra: {
    resolutionScale: 1.25,
    textureQuality: 'high',
    shadowQuality: 'high',
    effectsQuality: 'high',
    antialiasing: 'msaa',
    bloom: true,
    motionBlur: true,
    drawDistance: 400,
    decalLimit: 400,
  },
};

export function applyPreset(settings: Settings, preset: string): Settings {
  const p = GRAPHICS_PRESETS[preset];
  if (!p) return settings;
  const out = { ...settings, ...p, preset };
  return out;
}

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------

export interface ActionSpec {
  id: string;
  label: string;
  /** KeyboardEvent.code, or "Mouse0".."Mouse4", or "WheelUp"/"WheelDown". */
  default: string;
  category: 'movement' | 'combat' | 'utility' | 'social';
}

export const ACTIONS: ActionSpec[] = [
  { id: 'forward', label: 'Move forward', default: 'KeyW', category: 'movement' },
  { id: 'back', label: 'Move backward', default: 'KeyS', category: 'movement' },
  { id: 'left', label: 'Strafe left', default: 'KeyA', category: 'movement' },
  { id: 'right', label: 'Strafe right', default: 'KeyD', category: 'movement' },
  { id: 'jump', label: 'Jump', default: 'Space', category: 'movement' },
  { id: 'crouch', label: 'Crouch / slide', default: 'ControlLeft', category: 'movement' },
  { id: 'sprint', label: 'Sprint', default: 'ShiftLeft', category: 'movement' },
  { id: 'fire', label: 'Fire', default: 'Mouse0', category: 'combat' },
  { id: 'aim', label: 'Aim down sights', default: 'Mouse2', category: 'combat' },
  { id: 'reload', label: 'Reload', default: 'KeyR', category: 'combat' },
  { id: 'melee', label: 'Melee', default: 'KeyV', category: 'combat' },
  { id: 'ability', label: 'Class ability', default: 'KeyQ', category: 'combat' },
  { id: 'ultimate', label: 'Ultimate', default: 'KeyF', category: 'combat' },
  { id: 'slot1', label: 'Primary weapon', default: 'Digit1', category: 'combat' },
  { id: 'slot2', label: 'Secondary weapon', default: 'Digit2', category: 'combat' },
  { id: 'slot3', label: 'Melee weapon', default: 'Digit3', category: 'combat' },
  { id: 'lastWeapon', label: 'Last weapon', default: 'KeyX', category: 'combat' },
  { id: 'nextWeapon', label: 'Next weapon', default: 'WheelUp', category: 'combat' },
  { id: 'prevWeapon', label: 'Previous weapon', default: 'WheelDown', category: 'combat' },
  { id: 'interact', label: 'Interact / pick up', default: 'KeyE', category: 'utility' },
  { id: 'scoreboard', label: 'Scoreboard', default: 'Tab', category: 'utility' },
  { id: 'map', label: 'Full map', default: 'KeyM', category: 'utility' },
  { id: 'chat', label: 'Match chat', default: 'KeyT', category: 'social' },
  { id: 'teamChat', label: 'Team chat', default: 'KeyY', category: 'social' },
  { id: 'emote', label: 'Emote wheel', default: 'KeyB', category: 'social' },
  { id: 'ping', label: 'Ping location', default: 'KeyG', category: 'social' },
];

export type KeyBindings = Record<string, string>;

export function defaultBindings(): KeyBindings {
  const out: KeyBindings = {};
  for (const a of ACTIONS) out[a.id] = a.default;
  return out;
}

export function coerceBindings(raw: unknown): KeyBindings {
  const out = defaultBindings();
  if (typeof raw !== 'object' || raw === null) return out;
  const known = new Set(ACTIONS.map((a) => a.id));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > 24) continue;
    out[k] = v;
  }
  return out;
}

/** Human readable key label. */
export function keyLabel(code: string): string {
  if (code.startsWith('Mouse')) {
    const n = Number(code.slice(5));
    return ['Left Click', 'Middle Click', 'Right Click', 'Mouse 4', 'Mouse 5'][n] ?? code;
  }
  if (code === 'WheelUp') return 'Wheel Up';
  if (code === 'WheelDown') return 'Wheel Down';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const named: Record<string, string> = {
    Space: 'Space',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
    Tab: 'Tab',
    Escape: 'Esc',
    Enter: 'Enter',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
  };
  return named[code] ?? code;
}

/** Conflicting bindings, so the UI can warn instead of silently breaking. */
export function findBindingConflicts(bindings: KeyBindings): { code: string; actions: string[] }[] {
  const byCode = new Map<string, string[]>();
  for (const [action, code] of Object.entries(bindings)) {
    const list = byCode.get(code) ?? [];
    list.push(action);
    byCode.set(code, list);
  }
  const out: { code: string; actions: string[] }[] = [];
  for (const [code, actions] of byCode) {
    if (actions.length > 1) out.push({ code, actions });
  }
  return out;
}
