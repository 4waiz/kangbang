/**
 * REST client.
 *
 * Server URL resolution order:
 *   1. VITE_SERVER_URL (explicit override, used in Docker/production)
 *   2. same origin when the page is served by the game server
 *   3. localhost:2567 during `vite dev`
 */

import { store, type MetaCatalogue, type ProfileView } from '../state/store.js';

function resolveBase(): string {
  const explicit = import.meta.env.VITE_SERVER_URL;
  if (explicit) return String(explicit).replace(/\/$/, '');
  const { protocol, hostname, port } = window.location;
  // The dev client runs on 5173; the server on 2567.
  if (port === '5173' || port === '4173') return `${protocol}//${hostname}:2567`;
  return `${protocol}//${window.location.host}`;
}

export const SERVER_BASE = resolveBase();
export const WS_URL = `${SERVER_BASE.replace(/^http/, 'ws')}/ws`;

export interface RoomListing {
  id: string;
  code: string;
  name: string;
  mode: string;
  modeName: string;
  map: string;
  mapName: string;
  players: number;
  humans: number;
  bots: number;
  maxPlayers: number;
  phase: string;
  privateRoom: boolean;
  timeRemaining: number;
  scores: [number, number];
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  protocol: number;
  uptimeSec: number;
  rooms: number;
  players: number;
  tickRate: number;
  snapshotRate: number;
  avgTickMs: number;
  db: string;
  env: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (store.token) headers.Authorization = `Bearer ${store.token}`;
    const res = await fetch(`${SERVER_BASE}${path}`, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(detail, res.status);
    }
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  health(): Promise<HealthInfo> {
    return request<HealthInfo>('/api/health', {}, 5000);
  },

  meta(): Promise<MetaCatalogue> {
    return request<MetaCatalogue>('/api/meta', {}, 12000);
  },

  rooms(): Promise<{ rooms: RoomListing[] }> {
    return request<{ rooms: RoomListing[] }>('/api/rooms', {}, 5000);
  },

  /**
   * Guest sign-in. Presents any previously stored guest id so progression
   * survives a reload without an account.
   */
  guest(name: string): Promise<{ token: string; profile: ProfileView }> {
    return request<{ token: string; profile: ProfileView }>('/api/guest', {
      method: 'POST',
      body: JSON.stringify({ name, id: store.guestId || undefined }),
    });
  },

  profile(): Promise<{ profile: ProfileView }> {
    return request<{ profile: ProfileView }>('/api/profile');
  },

  patchProfile(patch: { name?: string; banner?: string; icon?: string }): Promise<{ profile: ProfileView }> {
    return request<{ profile: ProfileView }>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) });
  },

  putSettings(settings: unknown, bindings: unknown): Promise<unknown> {
    return request('/api/profile/settings', { method: 'PUT', body: JSON.stringify({ settings, bindings }) });
  },

  putLoadouts(loadouts: unknown): Promise<unknown> {
    return request('/api/profile/loadouts', { method: 'PUT', body: JSON.stringify({ loadouts }) });
  },

  putCosmetics(equipped: Record<string, string>): Promise<unknown> {
    return request('/api/profile/cosmetics', { method: 'PUT', body: JSON.stringify({ equipped }) });
  },

  matches(limit = 20): Promise<{ matches: Record<string, unknown>[] }> {
    return request<{ matches: Record<string, unknown>[] }>(`/api/profile/matches?limit=${limit}`);
  },

  challenges(): Promise<{
    challenges: {
      key: string;
      name: string;
      description: string;
      period: string;
      target: number;
      xpReward: number;
      progress: number;
      claimed: boolean;
    }[];
  }> {
    return request('/api/profile/challenges');
  },

  achievements(): Promise<{
    achievements: { id: string; current: number; target: number; complete: boolean; progress: number }[];
  }> {
    return request('/api/profile/achievements');
  },

  leaderboard(
    metric: string,
    limit = 50,
  ): Promise<{
    metric: string;
    entries: { playerId: string; name: string; value: number; rank: number; level: number; icon: string; banner: string }[];
    myRank: number;
    totalPlayers: number;
  }> {
    return request(`/api/leaderboard?metric=${encodeURIComponent(metric)}&limit=${limit}`);
  },
};

/** Wire the debounced store sync to the API. */
export function installProfileSync(): void {
  store.on('sync', () => {
    if (!store.token) return;
    void api.putSettings(store.settings, store.bindings).catch(() => undefined);
    void api.putLoadouts(store.loadouts).catch(() => undefined);
    void api.putCosmetics(store.equippedCosmetics).catch(() => undefined);
  });
  // Best-effort flush when the tab goes away.
  window.addEventListener('pagehide', () => {
    if (!store.token) return;
    try {
      const payload = JSON.stringify({ settings: store.settings, bindings: store.bindings });
      navigator.sendBeacon?.(`${SERVER_BASE}/api/profile/settings?token=${encodeURIComponent(store.token)}`, payload);
    } catch {
      /* best effort */
    }
  });
}
