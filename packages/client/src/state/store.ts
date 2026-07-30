/**
 * Client state store.
 *
 * A tiny observable holding settings, key bindings, the player profile and the
 * server metadata catalogue. Settings persist to localStorage immediately (so a
 * crash never loses them) and sync to the server profile on a debounce.
 *
 * Deliberately not a reactive framework: screens subscribe to the slices they
 * care about, which keeps DOM churn to what actually changed.
 */

import {
  ACTIONS,
  DEFAULT_COSMETICS,
  GRAPHICS_PRESETS,
  MAX_NAME_LENGTH,
  SETTINGS_BY_KEY,
  applyPreset,
  coerceBindings,
  coerceSetting,
  coerceSettings,
  defaultBindings,
  defaultSettings,
  sanitiseName,
  type KeyBindings,
  type LoadoutSelection,
  type Settings,
  type SettingsValue,
} from '@kang/shared';

const LS_SETTINGS = 'kang.settings.v1';
const LS_BINDINGS = 'kang.bindings.v1';
const LS_TOKEN = 'kang.token.v1';
const LS_GUEST_ID = 'kang.guestId.v1';
const LS_NAME = 'kang.name.v1';
const LS_LOADOUTS = 'kang.loadouts.v1';
const LS_COSMETICS = 'kang.cosmetics.v1';
const LS_LAST = 'kang.last.v1';

export interface ProfileView {
  id: string;
  name: string;
  guest: boolean;
  xp: number;
  level: number;
  levelProgress: number;
  xpIntoLevel: number;
  xpForNext: number;
  totals: Record<string, number>;
  derived: Record<string, number>;
  weaponStats: Record<string, Record<string, number>>;
  classStats: Record<string, Record<string, number>>;
  weaponMastery: Record<string, { level: number; into: number; need: number; progress: number }>;
  classMastery: Record<string, { level: number; into: number; need: number; progress: number }>;
  cosmetics: { unlocked: string[]; equipped: Record<string, string> };
  achievements: string[];
  banner: string;
  icon: string;
}

export interface MetaCatalogue {
  protocol: number;
  modes: Record<string, unknown>[];
  maps: Record<string, unknown>[];
  classes: Record<string, unknown>[];
  weapons: Record<string, unknown>[];
  perks: Record<string, unknown>[];
  cosmetics: Record<string, unknown>[];
  achievements: Record<string, unknown>[];
}

export interface LastSession {
  mode: string;
  map: string;
  classId: string;
}

type Listener = () => void;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked - the game still works, settings just will not
       survive a reload, which is better than crashing. */
  }
}

class Store {
  settings: Settings = defaultSettings();
  bindings: KeyBindings = defaultBindings();
  token = '';
  guestId = '';
  name = '';
  profile: ProfileView | null = null;
  meta: MetaCatalogue | null = null;
  loadouts: Record<string, LoadoutSelection> = {};
  equippedCosmetics: Record<string, string> = { ...DEFAULT_COSMETICS };
  last: LastSession = { mode: 'tdm', map: 'neon_foundry', classId: 'vanguard' };
  /** Set when the server rejects our protocol so the UI can tell the player. */
  protocolError = '';

  private listeners = new Map<string, Set<Listener>>();
  private syncTimer: number | null = null;

  load(): void {
    this.settings = coerceSettings(readJson<Record<string, unknown>>(LS_SETTINGS, {}));
    this.bindings = coerceBindings(readJson<Record<string, unknown>>(LS_BINDINGS, {}));
    this.token = localStorage.getItem(LS_TOKEN) ?? '';
    this.guestId = localStorage.getItem(LS_GUEST_ID) ?? '';
    this.name = sanitiseName(localStorage.getItem(LS_NAME) ?? '', MAX_NAME_LENGTH);
    this.loadouts = readJson<Record<string, LoadoutSelection>>(LS_LOADOUTS, {});
    this.equippedCosmetics = { ...DEFAULT_COSMETICS, ...readJson<Record<string, string>>(LS_COSMETICS, {}) };
    this.last = { ...this.last, ...readJson<Partial<LastSession>>(LS_LAST, {}) };
    this.applyDocumentSettings();
  }

  // -- subscriptions ------------------------------------------------------

  on(slice: string, fn: Listener): () => void {
    let set = this.listeners.get(slice);
    if (!set) {
      set = new Set();
      this.listeners.set(slice, set);
    }
    set.add(fn);
    return () => set?.delete(fn);
  }

  emit(slice: string): void {
    const set = this.listeners.get(slice);
    if (!set) return;
    for (const fn of set) fn();
  }

  // -- settings -----------------------------------------------------------

  get<T extends SettingsValue>(key: string): T {
    const v = this.settings[key];
    return (v ?? SETTINGS_BY_KEY[key]?.default) as T;
  }

  num(key: string): number {
    const v = this.settings[key];
    return typeof v === 'number' ? v : Number(SETTINGS_BY_KEY[key]?.default ?? 0);
  }

  bool(key: string): boolean {
    const v = this.settings[key];
    return typeof v === 'boolean' ? v : Boolean(SETTINGS_BY_KEY[key]?.default);
  }

  str(key: string): string {
    const v = this.settings[key];
    return typeof v === 'string' ? v : String(SETTINGS_BY_KEY[key]?.default ?? '');
  }

  set(key: string, value: unknown): void {
    const coerced = coerceSetting(key, value);
    if (coerced === undefined) return;
    if (this.settings[key] === coerced) return;
    this.settings[key] = coerced;
    // Changing any graphics knob individually moves the preset to Custom.
    const spec = SETTINGS_BY_KEY[key];
    if (spec && spec.group === 'graphics' && spec.perfWeight && key !== 'preset') {
      this.settings.preset = 'custom';
    }
    writeJson(LS_SETTINGS, this.settings);
    this.applyDocumentSettings();
    this.emit('settings');
    this.emit(`settings:${key}`);
    this.queueSync();
  }

  applyGraphicsPreset(preset: string): void {
    if (!GRAPHICS_PRESETS[preset]) return;
    this.settings = applyPreset(this.settings, preset);
    writeJson(LS_SETTINGS, this.settings);
    this.applyDocumentSettings();
    this.emit('settings');
    this.queueSync();
  }

  resetSettings(): void {
    this.settings = defaultSettings();
    this.bindings = defaultBindings();
    writeJson(LS_SETTINGS, this.settings);
    writeJson(LS_BINDINGS, this.bindings);
    this.applyDocumentSettings();
    this.emit('settings');
    this.emit('bindings');
    this.queueSync();
  }

  setBinding(action: string, code: string): void {
    if (!ACTIONS.some((a) => a.id === action)) return;
    this.bindings[action] = code;
    writeJson(LS_BINDINGS, this.bindings);
    this.emit('bindings');
    this.queueSync();
  }

  resetBindings(): void {
    this.bindings = defaultBindings();
    writeJson(LS_BINDINGS, this.bindings);
    this.emit('bindings');
    this.queueSync();
  }

  /** Push UI-affecting settings onto the document so CSS can react. */
  applyDocumentSettings(): void {
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(this.num('uiScale')));
    const cb = this.str('colorblindMode');
    if (cb && cb !== 'off') root.dataset.cb = cb;
    else delete root.dataset.cb;
    root.dataset.reducedMotion = this.bool('reducedMotion') ? '1' : '0';
  }

  // -- identity -----------------------------------------------------------

  setToken(token: string): void {
    this.token = token;
    try {
      localStorage.setItem(LS_TOKEN, token);
    } catch {
      /* ignore */
    }
  }

  setGuestId(id: string): void {
    this.guestId = id;
    try {
      localStorage.setItem(LS_GUEST_ID, id);
    } catch {
      /* ignore */
    }
  }

  setName(name: string): void {
    const clean = sanitiseName(name, MAX_NAME_LENGTH);
    if (!clean) return;
    this.name = clean;
    try {
      localStorage.setItem(LS_NAME, clean);
    } catch {
      /* ignore */
    }
    this.emit('profile');
  }

  setProfile(profile: ProfileView | null): void {
    this.profile = profile;
    if (profile) {
      this.name = profile.name;
      try {
        localStorage.setItem(LS_NAME, profile.name);
      } catch {
        /* ignore */
      }
      if (profile.cosmetics?.equipped) {
        this.equippedCosmetics = { ...DEFAULT_COSMETICS, ...profile.cosmetics.equipped };
        writeJson(LS_COSMETICS, this.equippedCosmetics);
      }
    }
    this.emit('profile');
  }

  setMeta(meta: MetaCatalogue): void {
    this.meta = meta;
    this.emit('meta');
  }

  // -- loadouts / cosmetics ----------------------------------------------

  loadoutFor(classId: string): LoadoutSelection {
    const existing = this.loadouts[classId];
    if (existing) return existing;
    const cls = this.meta?.classes.find((c) => c.id === classId) as
      | { defaultLoadout?: { primary: string; secondary: string; melee: string } }
      | undefined;
    const fallback: LoadoutSelection = {
      classId,
      primary: cls?.defaultLoadout?.primary ?? 'pulse_ar',
      secondary: cls?.defaultLoadout?.secondary ?? 'energy_pistol',
      melee: cls?.defaultLoadout?.melee ?? 'plasma_blade',
      perks: [],
      skins: {},
    };
    this.loadouts[classId] = fallback;
    return fallback;
  }

  setLoadout(classId: string, loadout: LoadoutSelection): void {
    this.loadouts[classId] = loadout;
    writeJson(LS_LOADOUTS, this.loadouts);
    this.emit('loadouts');
    this.queueSync();
  }

  equipCosmetic(kind: string, id: string): void {
    this.equippedCosmetics[kind] = id;
    writeJson(LS_COSMETICS, this.equippedCosmetics);
    this.emit('cosmetics');
    this.queueSync();
  }

  isUnlocked(cosmeticId: string): boolean {
    const def = this.meta?.cosmetics.find((c) => c.id === cosmeticId) as { unlock?: unknown } | undefined;
    if (!def) return false;
    if (!def.unlock) return true;
    return this.profile?.cosmetics.unlocked.includes(cosmeticId) ?? false;
  }

  setLast(patch: Partial<LastSession>): void {
    this.last = { ...this.last, ...patch };
    writeJson(LS_LAST, this.last);
  }

  /** Debounced server sync so dragging a slider does not spam the API. */
  private queueSync(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.emit('sync');
    }, 900);
  }

  flushSync(): void {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.emit('sync');
  }
}

export const store = new Store();
