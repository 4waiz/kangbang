/**
 * Application shell: screen router, all menu screens, and the wiring between
 * the UI, the network connection and the gameplay session.
 *
 * Screens are built imperatively on navigation and torn down on exit. There is
 * no persistent virtual tree, so an open menu costs nothing per frame - which
 * matters because the 3D scene keeps rendering behind every overlay.
 */

import {
  ACTIONS,
  CLASSES,
  CLASS_ORDER,
  COSMETICS,
  MAX_CHAT_LENGTH,
  MODES,
  MODE_ORDER,
  PERKS,
  TEAM_COLORS_CSS,
  TEAM_NAMES,
  WEAPONS,
  WEAPON_ORDER,
  clamp,
  cosmeticsOfKind,
  dps,
  findBindingConflicts,
  getMap,
  getMode,
  keyLabel,
  levelFromXp,
  mapSummaries,
  mapsForMode,
  settingsInGroup,
  shotsToKill,
  timeToKill,
  type ClassDef,
  type KillFeedEntry,
  type LoadoutSelection,
  type MatchResultsPayload,
  type MatchStatePayload,
  type PlayerPublicState,
  type SettingSpec,
  type WeaponDef,
} from '@neon/shared';
import { audio } from '../engine/audio.js';
import { assets } from '../engine/assets.js';
import type { InputManager } from '../engine/input.js';
import type { Renderer } from '../engine/renderer.js';
import { api, installProfileSync, type RoomListing } from '../net/api.js';
import { Connection, type ChatEntry, type ConnectionState } from '../net/connection.js';
import { GameSession, type HudSnapshot } from '../game/session.js';
import { store } from '../state/store.js';
import { Hud } from './hud.js';
import {
  append,
  bar,
  button,
  chip,
  clear,
  el,
  eyebrow,
  fmtDate,
  fmtNumber,
  fmtTime,
  segmented,
  select,
  slider,
  statBlock,
  toast,
  toggle,
} from './dom.js';
import { classIcon, glyphIcon, logoWordmark, modeIcon, uiIcon, weaponIcon } from './icons.js';

type ScreenId =
  | 'boot'
  | 'menu'
  | 'quickplay'
  | 'browser'
  | 'custom'
  | 'lobby'
  | 'class'
  | 'loadout'
  | 'profile'
  | 'progression'
  | 'leaderboard'
  | 'challenges'
  | 'settings'
  | 'credits'
  | 'pause'
  | 'scoreboard'
  | 'results'
  | 'none';

const BOOT_TIPS = [
  'Slide into a jump to keep your momentum - the fastest route through any map is a chain of slide-hops.',
  'Damage falls off with distance. Check a weapon\'s effective range in the loadout screen before you pick a fight.',
  'Hold your ability until it changes an engagement. A Thruster Dash used on approach is a Dash you did not have in the duel.',
  'The scoreboard (Tab) shows every player\'s streak. A player on 5+ is worth hunting.',
  'Glass panes are penetrable. You can shoot through them; the enemy can shoot back.',
  'Reloading is cancellable on most weapons - switch to your sidearm instead of waiting.',
  'Objective time scores more than eliminations in Domination and Hardpoint.',
  'Phantom footsteps are silent. If you cannot hear them, assume they are already behind you.',
];

export class App {
  private uiRoot: HTMLElement;
  private hud: Hud;
  private connection: Connection;
  private session: GameSession;
  private screen: ScreenId = 'boot';
  private screenNode: HTMLElement | null = null;
  private overlayNode: HTMLElement | null = null;
  private inMatch = false;
  private scoreboardOpen = false;
  private chatOpen = false;
  private chatTeamOnly = false;
  private chatNode: HTMLElement | null = null;
  private chatLog: ChatEntry[] = [];
  private roster: PlayerPublicState[] = [];
  private matchState: MatchStatePayload | null = null;
  private results: MatchResultsPayload | null = null;
  private rooms: RoomListing[] = [];
  private lastHud: HudSnapshot | null = null;
  private selectedClass = 'vanguard';
  private pendingJoin: { mode?: string; map?: string; code?: string; roomId?: string; create?: boolean; config?: Record<string, unknown> } | null =
    null;
  private roomSummary: Record<string, unknown> | null = null;
  private bootTipTimer = 0;
  private capturingBinding: string | null = null;

  constructor(
    private renderer: Renderer,
    private input: InputManager,
    hudRoot: HTMLElement,
    overlayCanvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
  ) {
    this.uiRoot = uiRoot;
    this.hud = new Hud(hudRoot, overlayCanvas);
    this.connection = new Connection({
      onState: (s, d) => this.onConnectionState(s, d),
      onWelcome: (w) => this.onWelcome(w),
      onSnapshot: (s) => this.session.onSnapshot(s),
      onMatchState: (s) => this.onMatchState(s),
      onPlayerList: (p) => this.onPlayerList(p),
      onKillFeed: (e) => this.onKillFeed(e),
      onChat: (c) => this.onChat(c),
      onNotice: (t) => this.onNotice(t),
      onResults: (r) => this.onResults(r),
      onRoomState: (room, mapChanged) => this.onRoomState(room, mapChanged),
    });
    this.session = new GameSession(renderer, input, this.connection);
    this.session.onHud = (h) => this.onHudUpdate(h);
    this.session.onDeath = () => audio.death();
    this.session.onSpawn = () => audio.stinger('start');

    this.input.onEscape = () => this.onEscape();
    this.input.onLockChange = (locked) => {
      if (!locked && this.inMatch && this.screen === 'none') this.showPause();
    };

    window.addEventListener('keydown', (ev) => this.onGlobalKey(ev));
    installProfileSync();
    this.selectedClass = store.last.classId;
  }

  // =====================================================================
  // Boot
  // =====================================================================

  async boot(): Promise<void> {
    store.load();
    this.showBoot();
    const status = (text: string) => {
      const node = this.screenNode?.querySelector('.boot__status');
      if (node) node.textContent = text;
    };
    const progress = (frac: number) => {
      const node = this.screenNode?.querySelector<HTMLElement>('.boot__bar i');
      if (node) node.style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`;
    };

    try {
      status('CONTACTING SERVER');
      progress(0.05);
      const health = await api.health();
      status(`SERVER ONLINE - ${health.rooms} ROOM(S), ${health.players} PLAYER(S)`);
      progress(0.15);

      status('LOADING GAME DATA');
      const meta = await api.meta();
      store.setMeta(meta);
      progress(0.25);

      status('SIGNING IN');
      const guest = await api.guest(store.name || '');
      store.setToken(guest.token);
      store.setGuestId(guest.profile.id);
      store.setProfile(guest.profile);
      // Server-side settings win on a fresh device; local wins if newer is
      // impossible to know, so we merge server values in only when we have none.
      if (guest.profile && Object.keys(store.settings).length === 0) {
        store.applyDocumentSettings();
      }
      progress(0.35);

      status('BUILDING TEXTURES AND MODELS');
      await assets.loadAll((p) => {
        progress(0.35 + (p.loaded / Math.max(1, p.total)) * 0.6);
        if (p.loaded % 6 === 0 || p.loaded === p.total) status(`LOADING ASSETS ${p.loaded}/${p.total}`);
      });
      progress(0.98);
      status('READY');

      const stats = assets.stats();
      // eslint-disable-next-line no-console
      console.info(`[neon] ${stats.models} models, ${fmtNumber(stats.triangles)} triangles loaded`);
      progress(1);
      window.setTimeout(() => this.showMenu(), 320);
    } catch (err) {
      status('');
      const message = err instanceof Error ? err.message : String(err);
      const body = this.screenNode?.querySelector('.boot');
      if (body) {
        append(
          body,
          el(
            'div',
            { class: 'plate plate--ember', style: { maxWidth: '520px', textAlign: 'left' } },
            el('h3', {}, 'Cannot reach the game server'),
            el('p', {}, message),
            el(
              'p',
              { class: 'faint' },
              'Start it with: npm run dev:server  (or npm run dev to start both). ',
              'If the server is on another host, set VITE_SERVER_URL.',
            ),
            button('Retry', () => void this.boot(), { class: 'btn--primary' }),
          ),
        );
      }
    }
  }

  private showBoot(): void {
    this.setScreen(
      'boot',
      el(
        'div',
        { class: 'screen' },
        el(
          'div',
          { class: 'boot' },
          el('div', { class: 'logo logo--lg', html: logoWordmark() }),
          el('div', { class: 'eyebrow', style: { justifyContent: 'center' } }, 'ORBITAL COMBAT NETWORK'),
          el('div', { class: 'boot__bar' }, el('i')),
          el('div', { class: 'boot__status' }, 'INITIALISING'),
          el('div', { class: 'boot__tips' }, BOOT_TIPS[Math.floor(Math.random() * BOOT_TIPS.length)]),
        ),
      ),
    );
    window.clearInterval(this.bootTipTimer);
    this.bootTipTimer = window.setInterval(() => {
      const node = this.screenNode?.querySelector('.boot__tips');
      if (node) node.textContent = BOOT_TIPS[Math.floor(Math.random() * BOOT_TIPS.length)];
    }, 5200);
  }

  // =====================================================================
  // Screen plumbing
  // =====================================================================

  private setScreen(id: ScreenId, node: HTMLElement | null): void {
    if (id !== 'boot') window.clearInterval(this.bootTipTimer);
    this.screen = id;
    clear(this.uiRoot);
    this.screenNode = node;
    if (node) this.uiRoot.appendChild(node);
    const menuLike = id !== 'none';
    this.input.setEnabled(!menuLike);
    if (menuLike) this.input.releaseLock();
    this.hud.setVisible(this.inMatch && id === 'none');
    if (menuLike && !this.inMatch) audio.startMenuMusic();
    else audio.stopMenuMusic();
  }

  private closeScreen(): void {
    this.setScreen('none', null);
    if (this.inMatch) this.input.requestLock();
  }

  private onEscape(): void {
    if (this.chatOpen) {
      this.closeChat();
      return;
    }
    if (this.screen === 'none' && this.inMatch) {
      this.showPause();
      return;
    }
    if (this.screen === 'pause') {
      this.closeScreen();
      return;
    }
    if (this.screen === 'results') return;
    if (this.screen === 'lobby' || this.screen === 'menu' || this.screen === 'boot') return;
    audio.uiBack();
    if (this.inMatch) this.showPause();
    else this.showMenu();
  }

  private onGlobalKey(ev: KeyboardEvent): void {
    if (this.capturingBinding) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    const code = ev.code;
    if (this.inMatch && this.screen === 'none') {
      if (code === store.bindings.scoreboard) {
        ev.preventDefault();
        if (!this.scoreboardOpen) this.showScoreboard();
      }
      if (code === store.bindings.chat) {
        ev.preventDefault();
        this.openChat(false);
      }
      if (code === store.bindings.teamChat) {
        ev.preventDefault();
        this.openChat(true);
      }
      if (code === store.bindings.emote) {
        ev.preventDefault();
        this.connection.emote('emote_salute');
        this.hud.pushNotice('EMOTE SENT');
      }
    }
    if (code === 'Escape' && this.chatOpen) this.closeChat();
  }

  private onGlobalKeyUp(ev: KeyboardEvent): void {
    if (ev.code === store.bindings.scoreboard && this.scoreboardOpen) this.hideScoreboard();
  }

  // =====================================================================
  // Main menu
  // =====================================================================

  showMenu(): void {
    const profile = store.profile;
    const level = profile ? levelFromXp(profile.xp) : { level: 1, progress: 0, xpIntoLevel: 0, xpForNext: 900 };

    const nav = el(
      'div',
      { class: 'menu__nav' },
      button([uiIcon('play', 20), ' QUICK PLAY'], () => this.showQuickPlay(), { class: 'btn--primary btn--lg btn--block' }),
      button([uiIcon('server', 18), ' SERVER BROWSER'], () => void this.showBrowser(), { class: 'btn--block' }),
      button([uiIcon('settings', 18), ' CUSTOM MATCH'], () => this.showCustom(), { class: 'btn--block' }),
      el('hr', { class: 'rule' }),
      button([classIcon(this.selectedClass, 18), ' CLASSES'], () => this.showClassSelect(false), { class: 'btn--block' }),
      button([uiIcon('target', 18), ' LOADOUT'], () => this.showLoadout(false), { class: 'btn--block' }),
      button([uiIcon('profile', 18), ' PROFILE'], () => void this.showProfile(), { class: 'btn--block' }),
      button([uiIcon('bolt', 18), ' PROGRESSION'], () => this.showProgression(), { class: 'btn--block' }),
      button([uiIcon('trophy', 18), ' LEADERBOARDS'], () => void this.showLeaderboard(), { class: 'btn--block' }),
      button([uiIcon('check', 18), ' CHALLENGES'], () => void this.showChallenges(), { class: 'btn--block' }),
      el('hr', { class: 'rule' }),
      button([uiIcon('settings', 18), ' SETTINGS'], () => this.showSettings(), { class: 'btn--block' }),
      button('CREDITS', () => this.showCredits(), { class: 'btn--ghost btn--block btn--sm' }),
    );

    const totals = profile?.totals ?? {};
    const derived = profile?.derived ?? {};

    const hero = el(
      'div',
      { class: 'plate menu__hero' },
      eyebrow('CAREER'),
      el(
        'div',
        { class: 'row row--between', style: { alignItems: 'flex-end', marginTop: '10px' } },
        el(
          'div',
          {},
          el('h2', {}, store.name || 'RECRUIT'),
          el('div', { class: 'dim', style: { fontSize: '12px' } }, `ACCOUNT LEVEL ${level.level}`),
        ),
        el('div', { class: 'mono dim', style: { fontSize: '12px' } }, `${fmtNumber(level.xpIntoLevel)} / ${fmtNumber(level.xpForNext)} XP`),
      ),
      el('div', { style: { marginTop: '8px' } }, bar(level.progress)),
      el('hr', { class: 'rule' }),
      el(
        'div',
        { class: 'menu__stats' },
        statBlock(fmtNumber(Number(totals.kills ?? 0)), 'Eliminations'),
        statBlock(String(derived.kd ?? '0'), 'K/D'),
        statBlock(`${derived.accuracy ?? 0}%`, 'Accuracy'),
        statBlock(`${derived.headshotRate ?? 0}%`, 'Headshot %'),
        statBlock(String(totals.wins ?? 0), 'Wins'),
        statBlock(fmtTime(Number(totals.timePlayedSec ?? 0)), 'Time played'),
      ),
    );

    const maps = mapSummaries();
    const mapCards = el(
      'div',
      { class: 'plate scroll', style: { minHeight: '0', overflowY: 'auto' } },
      eyebrow('MAPS'),
      el(
        'div',
        { class: 'cards stagger', style: { marginTop: '12px' } },
        ...maps.map((m, i) =>
          el(
            'div',
            { class: 'card', style: { '--i': String(i) } as never },
            el('div', { class: 'card__head' }, uiIcon('map', 22), el('div', { class: 'card__title' }, m.name)),
            el('div', { class: 'card__sub' }, m.size),
            el('div', { class: 'card__body' }, m.tagline),
            el('div', { class: 'card__meta' }, ...m.modes.slice(0, 4).map((mode) => chip(getMode(mode).short))),
          ),
        ),
      ),
    );

    this.setScreen(
      'menu',
      el(
        'div',
        { class: 'screen' },
        el(
          'div',
          { class: 'screen__bar' },
          el('div', { html: logoWordmark() }),
          el('div', { class: 'grow' }),
          chip(`v1.0.0`),
          chip(store.profile?.guest ? 'GUEST' : 'ACCOUNT', 'chip--ion'),
        ),
        el('div', { class: 'menu' }, el('div', { class: 'menu__left' }, nav), el('div', { class: 'menu__right' }, hero, mapCards)),
      ),
    );
  }

  // =====================================================================
  // Quick play / browser / custom
  // =====================================================================

  private showQuickPlay(): void {
    const modes = MODE_ORDER.map((id) => MODES[id]).filter((m) => m.quickPlay);
    let chosenMap = '';

    const cards = el(
      'div',
      { class: 'cards stagger' },
      ...modes.map((m, i) =>
        el(
          'button',
          {
            class: 'card',
            type: 'button',
            style: { '--i': String(i) } as never,
            onmouseenter: () => audio.uiHover(),
            onclick: () => {
              store.setLast({ mode: m.id });
              this.joinMatch({ mode: m.id, map: chosenMap || undefined });
            },
          },
          el('div', { class: 'card__head' }, modeIcon(m.icon, 24), el('div', { class: 'card__title' }, m.name)),
          el('div', { class: 'card__sub' }, `${m.teams === 2 ? 'TEAM' : 'SOLO'} · ${m.short}`),
          el('div', { class: 'card__body' }, m.description),
          el(
            'div',
            { class: 'card__meta' },
            chip(`${m.scoreLimit} to win`),
            chip(m.timeLimitSec > 0 ? `${Math.round(m.timeLimitSec / 60)} min` : 'rounds'),
            chip(`${m.defaultBots} bots`),
          ),
        ),
      ),
    );

    const mapPicker = el(
      'div',
      { class: 'row row--wrap', style: { marginTop: '10px' } },
      segmented({
        value: '',
        options: [{ value: '', label: 'Any map' }, ...mapSummaries().map((m) => ({ value: m.id, label: m.name }))],
        onChange: (v) => {
          chosenMap = v;
        },
      }),
    );

    this.setScreen(
      'quickplay',
      this.wrapScreen(
        'QUICK PLAY',
        el('div', {}, eyebrow('SELECT A MODE'), el('div', { style: { marginTop: '12px' } }, cards), eyebrow('MAP'), mapPicker),
        [button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' })],
      ),
    );
  }

  private async showBrowser(): Promise<void> {
    const body = el('div', { class: 'empty' }, 'Loading rooms...');
    const codeInput = el('input', { type: 'text', placeholder: 'ROOM CODE', maxlength: '5', style: { maxWidth: '160px', textTransform: 'uppercase' } });

    const render = () => {
      clear(body);
      if (this.rooms.length === 0) {
        append(
          body,
          el('div', { class: 'empty' }, 'No public rooms are running. Start one with Quick Play or Custom Match.'),
        );
        return;
      }
      const table = el(
        'table',
        { class: 'table table--rows-clickable' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Room'),
            el('th', {}, 'Mode'),
            el('th', {}, 'Map'),
            el('th', { class: 'num' }, 'Players'),
            el('th', {}, 'State'),
            el('th', { class: 'num' }, 'Time'),
            el('th', {}, ''),
          ),
        ),
        el(
          'tbody',
          {},
          ...this.rooms.map((r) =>
            el(
              'tr',
              { onclick: () => this.joinMatch({ roomId: r.id }) },
              el('td', {}, el('span', { class: 'mono' }, r.code), ' ', r.name),
              el('td', {}, r.modeName),
              el('td', {}, r.mapName),
              el('td', { class: 'num' }, `${r.humans}+${r.bots}/${r.maxPlayers}`),
              el('td', {}, chip(r.phase.toUpperCase(), r.phase === 'live' ? 'chip--good' : '')),
              el('td', { class: 'num' }, `${Math.floor(r.timeRemaining / 60)}:${String(r.timeRemaining % 60).padStart(2, '0')}`),
              el('td', {}, button('JOIN', () => this.joinMatch({ roomId: r.id }), { class: 'btn--sm btn--primary' })),
            ),
          ),
        ),
      );
      append(body, table);
    };

    const refresh = async () => {
      try {
        const res = await api.rooms();
        this.rooms = res.rooms;
      } catch {
        this.rooms = [];
      }
      render();
    };

    this.setScreen(
      'browser',
      this.wrapScreen('SERVER BROWSER', el('div', {}, body), [
        button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' }),
        el('div', { class: 'grow' }),
        codeInput,
        button('JOIN BY CODE', () => {
          const code = codeInput.value.trim().toUpperCase();
          if (code.length < 3) {
            toast('Enter a room code', true);
            return;
          }
          this.joinMatch({ code });
        }),
        button('REFRESH', () => void refresh()),
      ]),
    );
    await refresh();
  }

  private showCustom(): void {
    const cfg = {
      mode: store.last.mode === 'custom' ? 'tdm' : store.last.mode,
      map: store.last.map,
      botCount: 7,
      botDifficulty: 'normal',
      friendlyFire: false,
      privateRoom: false,
      scoreLimit: 0,
      timeLimitSec: 0,
      name: '',
    };
    const modeDef = () => getMode(cfg.mode);

    const mapSelectHolder = el('div', {});
    const renderMapSelect = () => {
      clear(mapSelectHolder);
      const allowed = mapsForMode(cfg.mode);
      if (!allowed.includes(cfg.map)) cfg.map = allowed[0];
      append(
        mapSelectHolder,
        select({
          label: 'Map',
          value: cfg.map,
          options: allowed.map((id) => ({ value: id, label: getMap(id).name })),
          onChange: (v) => {
            cfg.map = v;
          },
        }),
      );
    };
    renderMapSelect();

    const form = el(
      'div',
      { class: 'settings-grid' },
      el(
        'div',
        { class: 'plate' },
        eyebrow('MATCH'),
        select({
          label: 'Mode',
          value: cfg.mode,
          options: MODE_ORDER.filter((m) => m !== 'custom').map((id) => ({ value: id, label: MODES[id].name })),
          onChange: (v) => {
            cfg.mode = v;
            cfg.scoreLimit = 0;
            cfg.timeLimitSec = 0;
            renderMapSelect();
          },
        }),
        mapSelectHolder,
        slider({
          label: 'Score limit',
          value: modeDef().scoreLimit,
          min: 5,
          max: 300,
          step: 5,
          onInput: (v) => {
            cfg.scoreLimit = v;
          },
        }),
        slider({
          label: 'Time limit',
          value: Math.max(1, Math.round(modeDef().timeLimitSec / 60)),
          min: 1,
          max: 20,
          step: 1,
          format: (v) => `${v} min`,
          onInput: (v) => {
            cfg.timeLimitSec = v * 60;
          },
        }),
      ),
      el(
        'div',
        { class: 'plate' },
        eyebrow('BOTS & RULES'),
        slider({
          label: 'Bots',
          value: cfg.botCount,
          min: 0,
          max: 15,
          step: 1,
          onInput: (v) => {
            cfg.botCount = v;
          },
        }),
        select({
          label: 'Bot difficulty',
          value: cfg.botDifficulty,
          options: [
            { value: 'easy', label: 'Easy' },
            { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' },
          ],
          onChange: (v) => {
            cfg.botDifficulty = v;
          },
        }),
        toggle({
          label: 'Friendly fire',
          value: cfg.friendlyFire,
          onChange: (v) => {
            cfg.friendlyFire = v;
          },
        }),
        toggle({
          label: 'Private room (invite by code only)',
          value: cfg.privateRoom,
          help: 'Private rooms never appear in the server browser.',
          onChange: (v) => {
            cfg.privateRoom = v;
          },
        }),
        el(
          'label',
          { class: 'field' },
          el('span', { class: 'field__label' }, 'Room name'),
          el('input', {
            type: 'text',
            placeholder: 'Auto-generated',
            maxlength: '28',
            oninput: (ev: Event) => {
              cfg.name = (ev.target as HTMLInputElement).value;
            },
          }),
        ),
      ),
    );

    this.setScreen(
      'custom',
      this.wrapScreen('CUSTOM MATCH', form, [
        button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' }),
        el('div', { class: 'grow' }),
        button('CREATE ROOM', () => {
          store.setLast({ mode: cfg.mode, map: cfg.map });
          this.joinMatch({
            mode: cfg.mode,
            map: cfg.map,
            create: true,
            config: {
              mode: cfg.mode,
              botCount: cfg.botCount,
              botDifficulty: cfg.botDifficulty,
              friendlyFire: cfg.friendlyFire,
              privateRoom: cfg.privateRoom,
              scoreLimit: cfg.scoreLimit || undefined,
              timeLimitSec: cfg.timeLimitSec || undefined,
              name: cfg.name || undefined,
            },
          });
        }, { class: 'btn--primary btn--lg' }),
      ]),
    );
  }

  // =====================================================================
  // Class + loadout
  // =====================================================================

  private showClassSelect(inLobby: boolean): void {
    const profile = store.profile;
    const level = profile ? levelFromXp(profile.xp).level : 1;

    const detail = el('div', { class: 'plate', style: { minWidth: '0' } });
    const renderDetail = (cls: ClassDef) => {
      clear(detail);
      const mastery = profile?.classMastery?.[cls.id];
      append(
        detail,
        eyebrow(`${cls.role.toUpperCase()} · ${cls.name.toUpperCase()}`),
        el('h2', { style: { marginTop: '8px' } }, cls.tagline),
        el('p', {}, cls.description),
        el('hr', { class: 'rule' }),
        el(
          'div',
          { class: 'statbars' },
          this.statBar('Health', cls.health, 160),
          this.statBar('Shield', cls.shield, 60),
          this.statBar('Speed', Math.round(cls.move.speedScale * 100), 130),
          this.statBar('Jump', Math.round(cls.move.jumpScale * 100), 120),
          this.statBar('Air control', Math.round(cls.move.airControlScale * 100), 130),
        ),
        el('hr', { class: 'rule' }),
        el(
          'div',
          { class: 'col' },
          el(
            'div',
            {},
            el('div', { class: 'card__sub' }, 'PASSIVE · ' + cls.passive.name),
            el('div', { class: 'card__body' }, cls.passive.description),
          ),
          el(
            'div',
            {},
            el('div', { class: 'card__sub' }, `ABILITY (Q) · ${cls.ability.name} · ${cls.ability.cooldown}s`),
            el('div', { class: 'card__body' }, cls.ability.description),
          ),
          el(
            'div',
            {},
            el('div', { class: 'card__sub' }, `ULTIMATE (F) · ${cls.ultimate.name} · ${cls.ultimate.cooldown}s`),
            el('div', { class: 'card__body' }, cls.ultimate.description),
          ),
        ),
        mastery
          ? el(
              'div',
              { style: { marginTop: '12px' } },
              el('div', { class: 'card__sub' }, `MASTERY LEVEL ${mastery.level}`),
              bar(mastery.progress),
            )
          : null,
      );
    };

    const list = el('div', { class: 'loadout__col' });
    for (const id of CLASS_ORDER) {
      const cls = CLASSES[id];
      const locked = cls.unlockLevel > level;
      const btn = el(
        'button',
        {
          class: `pick${id === this.selectedClass ? ' is-active' : ''}`,
          type: 'button',
          disabled: locked,
          title: locked ? `Unlocks at level ${cls.unlockLevel}` : cls.tagline,
          onmouseenter: () => audio.uiHover(),
          onclick: () => {
            audio.uiClick();
            this.selectedClass = id;
            store.setLast({ classId: id });
            for (const child of Array.from(list.children)) child.classList.remove('is-active');
            btn.classList.add('is-active');
            renderDetail(cls);
            this.applyLoadoutToServer();
          },
        },
        el('span', { html: classIcon(id, 26, locked ? '#66768f' : '#4fd8ff') }),
        el(
          'span',
          { class: 'grow' },
          el('span', { class: 'pick__name' }, cls.name),
          el('br'),
          el('span', { class: 'pick__meta' }, locked ? `LOCKED · LV ${cls.unlockLevel}` : cls.role.toUpperCase()),
        ),
        locked ? el('span', { html: uiIcon('lock', 16, '#66768f') }) : null,
      );
      list.appendChild(btn);
    }
    renderDetail(CLASSES[this.selectedClass] ?? CLASSES.vanguard);

    this.setScreen(
      'class',
      this.wrapScreen(
        'CLASS SELECT',
        el('div', { class: 'loadout' }, list, detail, this.loadoutSummaryPanel()),
        [
          button('BACK', () => (inLobby ? this.showLobby() : this.showMenu()), { class: 'btn--ghost', hint: 'ESC' }),
          el('div', { class: 'grow' }),
          button('EDIT LOADOUT', () => this.showLoadout(inLobby)),
          button('CONFIRM', () => (inLobby ? this.showLobby() : this.showMenu()), { class: 'btn--primary' }),
        ],
      ),
    );
  }

  private statBar(label: string, value: number, max: number): HTMLElement {
    return el(
      'div',
      { class: 'statbar' },
      el('span', { class: 'statbar__label' }, label),
      el('span', { class: 'statbar__track' }, el('i', { style: { width: `${clamp((value / max) * 100, 0, 100)}%` } })),
      el('span', { class: 'statbar__value' }, String(value)),
    );
  }

  private loadoutSummaryPanel(): HTMLElement {
    const loadout = store.loadoutFor(this.selectedClass);
    const cls = CLASSES[this.selectedClass] ?? CLASSES.vanguard;
    const ehp = cls.health + cls.shield;
    const primary = WEAPONS[loadout.primary];
    return el(
      'div',
      { class: 'plate plate--quiet loadout__col' },
      eyebrow('CURRENT LOADOUT'),
      ...(['primary', 'secondary', 'melee'] as const).map((slot) => {
        const w = WEAPONS[loadout[slot]];
        return el(
          'div',
          { class: 'row', style: { marginTop: '8px' } },
          el('span', { html: weaponIcon(w.id, 34) }),
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'pick__name' }, w.short),
            el('div', { class: 'pick__meta' }, `${slot.toUpperCase()} · ${w.category.toUpperCase()}`),
          ),
        );
      }),
      el('hr', { class: 'rule' }),
      eyebrow('TIME TO KILL'),
      el(
        'div',
        { class: 'statbars', style: { marginTop: '8px' } },
        this.statBar('Body TTK (ms)', Math.round(timeToKill(primary, ehp) * 1000), 1400),
        this.statBar('Head TTK (ms)', Math.round(timeToKill(primary, ehp, true) * 1000), 1400),
        this.statBar('Shots to kill', shotsToKill(primary, ehp), 12),
        this.statBar('DPS', Math.round(dps(primary)), 400),
      ),
      el('div', { class: 'field__help', style: { marginTop: '8px' } }, `Against ${cls.name} effective health (${ehp}).`),
      loadout.perks.length > 0
        ? el('div', { class: 'card__meta', style: { marginTop: '10px' } }, ...loadout.perks.map((p) => chip(PERKS[p]?.name ?? p)))
        : null,
    );
  }

  private showLoadout(inLobby: boolean): void {
    const loadout: LoadoutSelection = { ...store.loadoutFor(this.selectedClass) };
    const profile = store.profile;
    const level = profile ? levelFromXp(profile.xp).level : 1;
    let activeSlot: 'primary' | 'secondary' | 'melee' = 'primary';

    const weaponList = el('div', { class: 'loadout__col' });
    const detail = el('div', { class: 'plate', style: { minWidth: '0', overflowY: 'auto' } });

    const renderWeaponDetail = (w: WeaponDef) => {
      clear(detail);
      const cls = CLASSES[this.selectedClass];
      const ehp = cls.health + cls.shield;
      const slots = w.perkSlots;
      append(
        detail,
        eyebrow(`${w.category.toUpperCase()} · ${w.fireMode.toUpperCase()}`),
        el('h2', { style: { marginTop: '6px' } }, w.name),
        el('p', {}, w.description),
        el(
          'div',
          { class: 'statbars' },
          this.statBar('Damage', w.damage, 100),
          this.statBar('Fire rate', w.rpm, 1000),
          this.statBar('Magazine', w.magazine, 100),
          this.statBar('Range (m)', Math.round(w.falloffEnd), 220),
          this.statBar('Reload (ms)', Math.round(w.reloadTime * 1000), 4500),
          this.statBar('Mobility', Math.round(w.moveScale * 100), 120),
          this.statBar('Body TTK (ms)', Math.round(timeToKill(w, ehp) * 1000), 1600),
        ),
        el('hr', { class: 'rule' }),
        eyebrow('ATTACHMENTS'),
        ...slots.map((slot) => {
          const options = Object.values(PERKS).filter((p) => p.slot === slot);
          const current = loadout.perks.find((id) => PERKS[id]?.slot === slot) ?? '';
          return el(
            'div',
            { style: { marginTop: '8px' } },
            select({
              label: slot.toUpperCase(),
              value: current,
              options: [
                { value: '', label: 'None' },
                ...options.map((p) => ({
                  value: p.id,
                  label: p.unlockLevel > level ? `${p.name} (LV ${p.unlockLevel})` : p.name,
                })),
              ],
              onChange: (v) => {
                loadout.perks = loadout.perks.filter((id) => PERKS[id]?.slot !== slot);
                if (v) {
                  const perk = PERKS[v];
                  if (perk.unlockLevel > level) {
                    toast(`${perk.name} unlocks at level ${perk.unlockLevel}`, true);
                    return;
                  }
                  loadout.perks.push(v);
                }
                store.setLoadout(this.selectedClass, loadout);
                this.applyLoadoutToServer();
              },
            }),
            el('div', { class: 'field__help' }, options.map((p) => `${p.name}: ${p.description}`).join('  ·  ')),
          );
        }),
        el('hr', { class: 'rule' }),
        eyebrow('WEAPON SKIN'),
        el(
          'div',
          { class: 'swatches', style: { marginTop: '8px' } },
          ...cosmeticsOfKind('weaponSkin').map((skin) => {
            const unlocked = store.isUnlocked(skin.id);
            const active = loadout.skins[w.id] === skin.id;
            return el(
              'button',
              {
                class: `swatch${active ? ' is-active' : ''}`,
                type: 'button',
                disabled: !unlocked,
                title: unlocked ? skin.description : (skin.unlock ? `Locked: ${skin.name}` : skin.name),
                onclick: () => {
                  audio.uiClick();
                  loadout.skins[w.id] = skin.id;
                  store.setLoadout(this.selectedClass, loadout);
                  this.applyLoadoutToServer();
                  renderWeaponDetail(w);
                },
              },
              el('span', {
                class: 'swatch__chip',
                style: { background: `#${(skin.accent ?? skin.color ?? 0x666666).toString(16).padStart(6, '0')}` },
              }),
              el('span', { class: 'swatch__name' }, skin.name),
              !unlocked ? el('span', { class: 'swatch__lock', html: uiIcon('lock', 12, '#66768f') }) : null,
            );
          }),
        ),
      );
    };

    const renderWeaponList = () => {
      clear(weaponList);
      const slotWeapons = WEAPON_ORDER.map((id) => WEAPONS[id]).filter((w) => w.slot === activeSlot);
      for (const w of slotWeapons) {
        const locked = w.unlockLevel > level;
        const active = loadout[activeSlot] === w.id;
        const btn = el(
          'button',
          {
            class: `pick${active ? ' is-active' : ''}`,
            type: 'button',
            disabled: locked,
            title: locked ? `Unlocks at level ${w.unlockLevel}` : w.description,
            onmouseenter: () => audio.uiHover(),
            onclick: () => {
              audio.uiClick();
              loadout[activeSlot] = w.id;
              store.setLoadout(this.selectedClass, loadout);
              this.applyLoadoutToServer();
              renderWeaponList();
              renderWeaponDetail(w);
            },
          },
          el('span', { html: weaponIcon(w.id, 36, locked ? '#66768f' : '#cfe0f5') }),
          el(
            'span',
            { class: 'grow' },
            el('span', { class: 'pick__name' }, w.short),
            el('br'),
            el('span', { class: 'pick__meta' }, locked ? `LV ${w.unlockLevel}` : `${w.damage} DMG · ${w.rpm} RPM`),
          ),
          locked ? el('span', { html: uiIcon('lock', 16, '#66768f') }) : null,
        );
        weaponList.appendChild(btn);
      }
    };

    const slotTabs = el(
      'div',
      { class: 'tabs' },
      ...(['primary', 'secondary', 'melee'] as const).map((slot) =>
        el(
          'button',
          {
            class: 'tab',
            type: 'button',
            'aria-selected': String(slot === activeSlot),
            onclick: (ev: Event) => {
              audio.uiClick();
              activeSlot = slot;
              for (const t of Array.from(slotTabs.children)) t.setAttribute('aria-selected', 'false');
              (ev.currentTarget as HTMLElement).setAttribute('aria-selected', 'true');
              renderWeaponList();
              renderWeaponDetail(WEAPONS[loadout[slot]]);
            },
          },
          slot.toUpperCase(),
        ),
      ),
    );

    renderWeaponList();
    renderWeaponDetail(WEAPONS[loadout.primary]);

    this.setScreen(
      'loadout',
      this.wrapScreen(
        `LOADOUT · ${CLASSES[this.selectedClass].name.toUpperCase()}`,
        el('div', {}, slotTabs, el('div', { class: 'loadout' }, weaponList, detail, this.cosmeticsPanel())),
        [
          button('BACK', () => (inLobby ? this.showLobby() : this.showMenu()), { class: 'btn--ghost', hint: 'ESC' }),
          el('div', { class: 'grow' }),
          button('CLASSES', () => this.showClassSelect(inLobby)),
          button('SAVE', () => {
            store.setLoadout(this.selectedClass, loadout);
            store.flushSync();
            this.applyLoadoutToServer();
            toast('Loadout saved');
            if (inLobby) this.showLobby();
            else this.showMenu();
          }, { class: 'btn--primary' }),
        ],
      ),
    );
  }

  private cosmeticsPanel(): HTMLElement {
    const kinds: { kind: Parameters<typeof cosmeticsOfKind>[0]; label: string }[] = [
      { kind: 'bodyColor', label: 'ARMOUR COLOUR' },
      { kind: 'armorVariant', label: 'ARMOUR VARIANT' },
      { kind: 'charm', label: 'WEAPON CHARM' },
      { kind: 'killEffect', label: 'KILL EFFECT' },
      { kind: 'banner', label: 'BANNER' },
      { kind: 'icon', label: 'PROFILE ICON' },
      { kind: 'emote', label: 'EMOTE' },
      { kind: 'crosshair', label: 'CROSSHAIR' },
    ];
    const panel = el('div', { class: 'plate plate--quiet loadout__col' }, eyebrow('CUSTOMISATION'));
    for (const { kind, label } of kinds) {
      const items = cosmeticsOfKind(kind);
      if (items.length === 0) continue;
      append(
        panel,
        el('div', { class: 'card__sub', style: { marginTop: '12px' } }, label),
        el(
          'div',
          { class: 'swatches' },
          ...items.map((c) => {
            const unlocked = store.isUnlocked(c.id);
            const active = store.equippedCosmetics[kind] === c.id;
            const swatchColor = `#${(c.accent ?? c.color ?? 0x555f6f).toString(16).padStart(6, '0')}`;
            return el(
              'button',
              {
                class: `swatch${active ? ' is-active' : ''}`,
                type: 'button',
                disabled: !unlocked,
                title: unlocked ? c.description : `Locked · ${c.description}`,
                onclick: () => {
                  audio.uiClick();
                  store.equipCosmetic(kind, c.id);
                  if (kind === 'crosshair') store.set('crosshairId', c.id);
                  this.showLoadout(this.inMatch);
                },
              },
              c.glyph
                ? el('span', { html: glyphIcon(c.glyph, 26, swatchColor) })
                : el('span', { class: 'swatch__chip', style: { background: swatchColor } }),
              el('span', { class: 'swatch__name' }, c.name),
              !unlocked ? el('span', { class: 'swatch__lock', html: uiIcon('lock', 12, '#66768f') }) : null,
            );
          }),
        ),
      );
    }
    return panel;
  }

  // =====================================================================
  // Profile / progression / leaderboard / challenges
  // =====================================================================

  private async showProfile(): Promise<void> {
    const body = el('div', { class: 'empty' }, 'Loading profile...');
    this.setScreen(
      'profile',
      this.wrapScreen('PROFILE', body, [button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' })]),
    );
    try {
      const [{ profile }, { matches }] = await Promise.all([api.profile(), api.matches(12)]);
      store.setProfile(profile);
      const level = levelFromXp(profile.xp);
      const t = profile.totals as Record<string, number>;
      const d = profile.derived as Record<string, number>;

      const nameInput = el('input', { type: 'text', value: profile.name, maxlength: '16', style: { maxWidth: '220px' } });

      clear(body);
      append(
        body,
        el(
          'div',
          { class: 'settings-grid' },
          el(
            'div',
            { class: 'plate' },
            eyebrow('IDENTITY'),
            el('div', { class: 'row', style: { marginTop: '10px' } }, nameInput, button('RENAME', async () => {
              try {
                const res = await api.patchProfile({ name: nameInput.value });
                store.setProfile(res.profile);
                store.setName(res.profile.name);
                toast('Name updated');
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Rename failed', true);
              }
            })),
            el('hr', { class: 'rule' }),
            el('div', { class: 'row row--between' }, el('h2', {}, `LEVEL ${level.level}`), el('span', { class: 'mono dim' }, `${fmtNumber(profile.xp)} XP`)),
            bar(level.progress),
            el('div', { class: 'field__help' }, `${fmtNumber(level.xpIntoLevel)} / ${fmtNumber(level.xpForNext)} to level ${level.level + 1}`),
            el('hr', { class: 'rule' }),
            eyebrow('CAREER'),
            el(
              'div',
              { class: 'menu__stats', style: { marginTop: '10px' } },
              statBlock(fmtNumber(t.kills ?? 0), 'Eliminations'),
              statBlock(fmtNumber(t.deaths ?? 0), 'Deaths'),
              statBlock(fmtNumber(t.assists ?? 0), 'Assists'),
              statBlock(String(d.kd ?? 0), 'K/D'),
              statBlock(`${d.accuracy ?? 0}%`, 'Accuracy'),
              statBlock(`${d.headshotRate ?? 0}%`, 'Headshot %'),
              statBlock(`${d.winRate ?? 0}%`, 'Win rate'),
              statBlock(String(d.scorePerMinute ?? 0), 'Score / min'),
              statBlock(fmtNumber(t.damageDealt ?? 0), 'Damage'),
              statBlock(String(t.longestStreak ?? 0), 'Best streak'),
              statBlock(String(t.matchesPlayed ?? 0), 'Matches'),
              statBlock(fmtTime(t.timePlayedSec ?? 0), 'Time played'),
            ),
          ),
          el(
            'div',
            { class: 'plate' },
            eyebrow('RECENT MATCHES'),
            matches.length === 0
              ? el('div', { class: 'empty' }, 'No matches recorded yet. Play one and it will appear here.')
              : el(
                  'table',
                  { class: 'table', style: { marginTop: '10px' } },
                  el(
                    'thead',
                    {},
                    el(
                      'tr',
                      {},
                      el('th', {}, 'When'),
                      el('th', {}, 'Mode'),
                      el('th', {}, 'Map'),
                      el('th', { class: 'num' }, 'K/D/A'),
                      el('th', { class: 'num' }, 'Score'),
                      el('th', { class: 'num' }, 'XP'),
                      el('th', {}, ''),
                    ),
                  ),
                  el(
                    'tbody',
                    {},
                    ...matches.map((m) => {
                      const rec = m as Record<string, number | string | boolean>;
                      return el(
                        'tr',
                        {},
                        el('td', {}, fmtDate(Number(rec.playedAt))),
                        el('td', {}, getMode(String(rec.mode)).short),
                        el('td', {}, getMap(String(rec.map)).name),
                        el('td', { class: 'num' }, `${rec.kills}/${rec.deaths}/${rec.assists}`),
                        el('td', { class: 'num' }, fmtNumber(Number(rec.score))),
                        el('td', { class: 'num' }, `+${fmtNumber(Number(rec.xpEarned))}`),
                        el('td', {}, rec.won ? chip('WIN', 'chip--good') : rec.drew ? chip('DRAW') : chip('LOSS')),
                      );
                    }),
                  ),
                ),
          ),
        ),
      );
    } catch (err) {
      clear(body);
      append(body, el('div', { class: 'empty' }, `Could not load profile: ${err instanceof Error ? err.message : err}`));
    }
  }

  private showProgression(): void {
    const profile = store.profile;
    const wm = profile?.weaponMastery ?? {};
    const cm = profile?.classMastery ?? {};
    const ws = (profile?.weaponStats ?? {}) as Record<string, Record<string, number>>;
    const cs = (profile?.classStats ?? {}) as Record<string, Record<string, number>>;

    const body = el(
      'div',
      { class: 'settings-grid' },
      el(
        'div',
        { class: 'plate' },
        eyebrow('WEAPON MASTERY'),
        el(
          'table',
          { class: 'table', style: { marginTop: '10px' } },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Weapon'),
              el('th', { class: 'num' }, 'Kills'),
              el('th', { class: 'num' }, 'HS'),
              el('th', { class: 'num' }, 'Acc'),
              el('th', {}, 'Mastery'),
            ),
          ),
          el(
            'tbody',
            {},
            ...WEAPON_ORDER.map((id) => {
              const w = WEAPONS[id];
              const m = wm[id] ?? { level: 0, progress: 0 };
              const s = ws[id] ?? {};
              const acc = (s.shotsFired ?? 0) > 0 ? Math.round(((s.shotsHit ?? 0) / (s.shotsFired ?? 1)) * 100) : 0;
              return el(
                'tr',
                {},
                el('td', {}, el('span', { html: weaponIcon(id, 22) }), ' ', w.short),
                el('td', { class: 'num' }, String(s.kills ?? 0)),
                el('td', { class: 'num' }, String(s.headshots ?? 0)),
                el('td', { class: 'num' }, `${acc}%`),
                el('td', {}, el('div', { class: 'row', style: { gap: '8px' } }, chip(`LV ${m.level}`), bar(m.progress ?? 0, { class: 'bar--slim' }))),
              );
            }),
          ),
        ),
      ),
      el(
        'div',
        { class: 'plate' },
        eyebrow('CLASS MASTERY'),
        el(
          'div',
          { class: 'col', style: { marginTop: '10px' } },
          ...CLASS_ORDER.map((id) => {
            const cls = CLASSES[id];
            const m = cm[id] ?? { level: 0, progress: 0 };
            const s = cs[id] ?? {};
            return el(
              'div',
              { class: 'plate plate--flat plate--quiet', style: { padding: '12px' } },
              el(
                'div',
                { class: 'row row--between' },
                el('div', { class: 'row' }, el('span', { html: classIcon(id, 24) }), el('span', { class: 'pick__name' }, cls.name)),
                chip(`MASTERY ${m.level}`, 'chip--ion'),
              ),
              el('div', { style: { marginTop: '8px' } }, bar(m.progress ?? 0, { class: 'bar--slim' })),
              el(
                'div',
                { class: 'row', style: { marginTop: '8px', gap: '14px', fontSize: '11px' } },
                el('span', { class: 'faint' }, `${s.matches ?? 0} matches`),
                el('span', { class: 'faint' }, `${s.wins ?? 0} wins`),
                el('span', { class: 'faint' }, `${s.kills ?? 0} kills`),
              ),
            );
          }),
        ),
      ),
    );

    this.setScreen(
      'progression',
      this.wrapScreen('PROGRESSION', body, [
        button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' }),
        el('div', { class: 'grow' }),
        button('REFRESH', async () => {
          try {
            const res = await api.profile();
            store.setProfile(res.profile);
            this.showProgression();
          } catch {
            toast('Could not refresh', true);
          }
        }),
      ]),
    );
  }

  private async showLeaderboard(): Promise<void> {
    let metric = 'xp';
    const body = el('div', { class: 'empty' }, 'Loading...');

    const load = async () => {
      clear(body);
      append(body, el('div', { class: 'empty' }, 'Loading...'));
      try {
        const res = await api.leaderboard(metric, 50);
        clear(body);
        append(
          body,
          el(
            'div',
            { class: 'row row--between', style: { marginBottom: '12px' } },
            el('span', { class: 'dim' }, `${res.totalPlayers} registered players`),
            res.myRank > 0 ? chip(`YOUR RANK #${res.myRank}`, 'chip--ion') : chip('UNRANKED'),
          ),
          res.entries.length === 0
            ? el('div', { class: 'empty' }, 'No ranked players yet for this metric.')
            : el(
                'table',
                { class: 'table' },
                el('thead', {}, el('tr', {}, el('th', { class: 'num' }, '#'), el('th', {}, 'Player'), el('th', { class: 'num' }, 'Level'), el('th', { class: 'num' }, 'Value'))),
                el(
                  'tbody',
                  {},
                  ...res.entries.map((e) =>
                    el(
                      'tr',
                      { class: e.playerId === store.profile?.id ? 'is-self' : '' },
                      el('td', { class: 'num' }, String(e.rank)),
                      el('td', {}, el('span', { html: glyphIcon(COSMETICS[e.icon]?.glyph ?? 'chevron1', 18) }), ' ', e.name),
                      el('td', { class: 'num' }, String(e.level)),
                      el('td', { class: 'num' }, metric === 'kd' || metric === 'accuracy' || metric === 'headshotRate' ? e.value.toFixed(2) : fmtNumber(e.value)),
                    ),
                  ),
                ),
              ),
        );
      } catch (err) {
        clear(body);
        append(body, el('div', { class: 'empty' }, `Could not load leaderboard: ${err instanceof Error ? err.message : err}`));
      }
    };

    const tabs = el(
      'div',
      { class: 'tabs' },
      ...[
        ['xp', 'XP'],
        ['kills', 'ELIMINATIONS'],
        ['score', 'SCORE'],
        ['wins', 'WINS'],
        ['kd', 'K/D'],
        ['headshotRate', 'HEADSHOT %'],
        ['accuracy', 'ACCURACY'],
      ].map(([value, label]) =>
        el(
          'button',
          {
            class: 'tab',
            type: 'button',
            'aria-selected': String(value === metric),
            onclick: (ev: Event) => {
              audio.uiClick();
              metric = value;
              for (const t of Array.from(tabs.children)) t.setAttribute('aria-selected', 'false');
              (ev.currentTarget as HTMLElement).setAttribute('aria-selected', 'true');
              void load();
            },
          },
          label,
        ),
      ),
    );

    this.setScreen(
      'leaderboard',
      this.wrapScreen('LEADERBOARDS', el('div', {}, tabs, body), [
        button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' }),
      ]),
    );
    await load();
  }

  private async showChallenges(): Promise<void> {
    const body = el('div', { class: 'empty' }, 'Loading challenges...');
    this.setScreen(
      'challenges',
      this.wrapScreen('CHALLENGES', body, [button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' })]),
    );
    try {
      const [{ challenges }, { achievements }] = await Promise.all([api.challenges(), api.achievements()]);
      const meta = store.meta?.achievements ?? [];
      const byId = new Map(meta.map((a) => [String((a as { id: string }).id), a as Record<string, unknown>]));
      clear(body);
      append(
        body,
        el(
          'div',
          { class: 'settings-grid' },
          el(
            'div',
            { class: 'plate' },
            eyebrow('DAILY & WEEKLY'),
            el(
              'div',
              { class: 'col', style: { marginTop: '12px' } },
              ...challenges.map((c) =>
                el(
                  'div',
                  { class: 'plate plate--flat plate--quiet', style: { padding: '12px' } },
                  el(
                    'div',
                    { class: 'row row--between' },
                    el('div', {}, el('div', { class: 'pick__name' }, c.name), el('div', { class: 'pick__meta' }, c.description)),
                    c.claimed ? chip('COMPLETE', 'chip--good') : chip(c.period.toUpperCase()),
                  ),
                  el('div', { style: { marginTop: '8px' } }, bar(c.progress / Math.max(1, c.target), { class: 'bar--slim' })),
                  el('div', { class: 'row row--between', style: { marginTop: '6px', fontSize: '11px' } }, el('span', { class: 'faint mono' }, `${c.progress} / ${c.target}`), el('span', { class: 'ion mono' }, `+${fmtNumber(c.xpReward)} XP`)),
                ),
              ),
            ),
          ),
          el(
            'div',
            { class: 'plate' },
            eyebrow('ACHIEVEMENTS'),
            el(
              'div',
              { class: 'col', style: { marginTop: '12px' } },
              ...achievements
                .sort((a, b) => Number(b.complete) - Number(a.complete) || b.progress - a.progress)
                .map((a) => {
                  const def = byId.get(a.id);
                  return el(
                    'div',
                    { class: 'plate plate--flat plate--quiet', style: { padding: '10px' } },
                    el(
                      'div',
                      { class: 'row row--between' },
                      el(
                        'div',
                        {},
                        el('div', { class: 'pick__name' }, String(def?.name ?? a.id)),
                        el('div', { class: 'pick__meta' }, String(def?.description ?? '')),
                      ),
                      a.complete ? chip('DONE', 'chip--good') : chip(String(def?.tier ?? '').toUpperCase()),
                    ),
                    el('div', { style: { marginTop: '6px' } }, bar(a.progress, { class: 'bar--slim' })),
                    el('div', { class: 'faint mono', style: { fontSize: '10px', marginTop: '4px' } }, `${fmtNumber(a.current)} / ${fmtNumber(a.target)}`),
                  );
                }),
            ),
          ),
        ),
      );
    } catch (err) {
      clear(body);
      append(body, el('div', { class: 'empty' }, `Could not load challenges: ${err instanceof Error ? err.message : err}`));
    }
  }

  // =====================================================================
  // Settings
  // =====================================================================

  private showSettings(): void {
    let group: 'controls' | 'graphics' | 'audio' | 'accessibility' | 'gameplay' = 'controls';
    const body = el('div', {});

    const renderGroup = () => {
      clear(body);
      if (group === 'controls') {
        append(body, this.bindingsPanel(), this.settingsPanel('controls'));
      } else {
        append(body, this.settingsPanel(group));
      }
    };

    const tabs = el(
      'div',
      { class: 'tabs' },
      ...(
        [
          ['controls', 'CONTROLS'],
          ['graphics', 'GRAPHICS'],
          ['audio', 'AUDIO'],
          ['accessibility', 'ACCESSIBILITY'],
          ['gameplay', 'GAMEPLAY & HUD'],
        ] as const
      ).map(([value, label]) =>
        el(
          'button',
          {
            class: 'tab',
            type: 'button',
            'aria-selected': String(value === group),
            onclick: (ev: Event) => {
              audio.uiClick();
              group = value;
              for (const t of Array.from(tabs.children)) t.setAttribute('aria-selected', 'false');
              (ev.currentTarget as HTMLElement).setAttribute('aria-selected', 'true');
              renderGroup();
            },
          },
          label,
        ),
      ),
    );
    renderGroup();

    this.setScreen(
      'settings',
      this.wrapScreen('SETTINGS', el('div', {}, tabs, body), [
        button('BACK', () => (this.inMatch ? this.showPause() : this.showMenu()), { class: 'btn--ghost', hint: 'ESC' }),
        el('div', { class: 'grow' }),
        chip(this.renderer.webgpuAvailable ? 'WEBGPU AVAILABLE' : 'WEBGL2'),
        button('RESET ALL', () => {
          store.resetSettings();
          toast('Settings reset to defaults');
          this.showSettings();
        }, { class: 'btn--danger' }),
      ]),
    );
  }

  private settingsPanel(group: 'controls' | 'graphics' | 'audio' | 'accessibility' | 'gameplay'): HTMLElement {
    const specs = settingsInGroup(group);
    const panel = el('div', { class: 'settings-grid' });
    const chunkSize = Math.ceil(specs.length / 2);
    for (let c = 0; c < specs.length; c += chunkSize) {
      const column = el('div', { class: 'plate' }, eyebrow(group.toUpperCase()));
      for (const spec of specs.slice(c, c + chunkSize)) {
        const control = this.settingControl(spec);
        if (control) column.appendChild(control);
      }
      panel.appendChild(column);
    }
    return panel;
  }

  private settingControl(spec: SettingSpec): HTMLElement | null {
    if (spec.requires) {
      const current = store.settings[spec.requires.key];
      if (current !== spec.requires.equals) return null;
    }
    const value = store.settings[spec.key];
    switch (spec.control) {
      case 'toggle':
        return toggle({
          label: spec.label,
          value: Boolean(value),
          help: spec.help,
          onChange: (v) => store.set(spec.key, v),
        });
      case 'slider':
        return slider({
          label: spec.label,
          value: Number(value),
          min: spec.min ?? 0,
          max: spec.max ?? 1,
          step: spec.step ?? 0.01,
          help: spec.help,
          format: (v) => (spec.max !== undefined && spec.max <= 1.5 && (spec.step ?? 1) < 0.5 ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100)),
          onInput: (v) => store.set(spec.key, v),
        });
      case 'preset':
        return select({
          label: spec.label,
          value: String(value),
          options: spec.options ?? [],
          help: 'Applies a full set of graphics values. Changing any single option switches this to Custom.',
          onChange: (v) => {
            if (v === 'custom') store.set(spec.key, v);
            else {
              store.applyGraphicsPreset(v);
              this.showSettings();
            }
          },
        });
      case 'select': {
        let options = spec.options ?? [];
        if (spec.key === 'crosshairId') {
          options = cosmeticsOfKind('crosshair')
            .filter((c) => store.isUnlocked(c.id))
            .map((c) => ({ value: c.id, label: c.name }));
        }
        return select({
          label: spec.label,
          value: String(value),
          options,
          help: spec.help,
          onChange: (v) => store.set(spec.key, v),
        });
      }
      case 'color':
        return el(
          'label',
          { class: 'field' },
          el('span', { class: 'field__label' }, spec.label),
          el('input', {
            type: 'color',
            value: String(value),
            oninput: (ev: Event) => store.set(spec.key, (ev.target as HTMLInputElement).value),
          }),
        );
      default:
        return null;
    }
  }

  private bindingsPanel(): HTMLElement {
    const conflicts = findBindingConflicts(store.bindings);
    const conflictCodes = new Set(conflicts.map((c) => c.code));
    const panel = el('div', { class: 'settings-grid' });
    const categories: Record<string, HTMLElement> = {};
    for (const action of ACTIONS) {
      if (!categories[action.category]) {
        categories[action.category] = el('div', { class: 'plate' }, eyebrow(action.category.toUpperCase()));
        panel.appendChild(categories[action.category]);
      }
      const code = store.bindings[action.id] ?? action.default;
      const keyBtn = el(
        'button',
        {
          class: `binding__key${conflictCodes.has(code) ? '' : ''}`,
          type: 'button',
          onclick: async () => {
            audio.uiClick();
            keyBtn.classList.add('is-listening');
            keyBtn.textContent = 'PRESS A KEY';
            this.capturingBinding = action.id;
            const captured = await this.input.captureNext();
            this.capturingBinding = null;
            store.setBinding(action.id, captured);
            this.showSettings();
          },
        },
        keyLabel(code),
      );
      categories[action.category].appendChild(
        el(
          'div',
          { class: `binding${conflictCodes.has(code) ? ' is-conflict' : ''}` },
          el('span', {}, action.label),
          keyBtn,
        ),
      );
    }
    if (conflicts.length > 0) {
      panel.prepend(
        el(
          'div',
          { class: 'plate plate--ember', style: { gridColumn: '1 / -1' } },
          el('h4', {}, 'BINDING CONFLICTS'),
          el(
            'p',
            {},
            conflicts.map((c) => `${keyLabel(c.code)} is bound to ${c.actions.join(', ')}`).join('  ·  '),
          ),
        ),
      );
    }
    panel.appendChild(
      el(
        'div',
        { class: 'plate plate--quiet', style: { gridColumn: '1 / -1' } },
        button('RESET BINDINGS', () => {
          store.resetBindings();
          this.showSettings();
        }, { class: 'btn--danger btn--sm' }),
      ),
    );
    return panel;
  }

  private showCredits(): void {
    this.setScreen(
      'credits',
      this.wrapScreen(
        'CREDITS',
        el(
          'div',
          { class: 'settings-grid' },
          el(
            'div',
            { class: 'plate' },
            eyebrow('NEON STRIKE'),
            el('h2', { style: { marginTop: '8px' } }, 'An original browser FPS'),
            el(
              'p',
              {},
              'Every asset in this game is generated from source in this repository: the 3D models by Blender ',
              'Python scripts in assets/scripts, the textures and skybox procedurally in the browser, and every ',
              'sound synthesised at runtime with the Web Audio API. Nothing was downloaded or sampled.',
            ),
            el('hr', { class: 'rule' }),
            eyebrow('TECHNOLOGY'),
            el(
              'div',
              { class: 'card__meta', style: { marginTop: '10px' } },
              chip('TypeScript'),
              chip('Three.js'),
              chip('Vite'),
              chip('Node.js'),
              chip('WebSocket'),
              chip('Web Audio'),
              chip('SQLite / PostgreSQL'),
              chip('Blender'),
            ),
          ),
          el(
            'div',
            { class: 'plate' },
            eyebrow('DESIGN NOTES'),
            el('p', {}, 'Movement is Quake-lineage: ground friction, air acceleration with a speed cap, and slide-hopping for momentum.'),
            el('p', {}, 'The server is fully authoritative. The client predicts using the identical simulation module, so corrections are rare and invisible.'),
            el('p', {}, 'No cosmetic affects a hitbox, a damage number or a movement value. Attachments are strict side-grades with a real downside.'),
            el('hr', { class: 'rule' }),
            eyebrow('NOT AFFILIATED'),
            el('p', { class: 'faint' }, 'NEON STRIKE is an independent, original work. It is not associated with or derived from any other game, and contains no third-party assets, names or branding.'),
          ),
        ),
        [button('BACK', () => this.showMenu(), { class: 'btn--ghost', hint: 'ESC' })],
      ),
    );
  }

  // =====================================================================
  // Match flow
  // =====================================================================

  private joinMatch(opts: { mode?: string; map?: string; code?: string; roomId?: string; create?: boolean; config?: Record<string, unknown> }): void {
    this.pendingJoin = opts;
    void audio.unlock();
    const loadout = { ...store.loadoutFor(this.selectedClass), ...this.cosmeticOverlay() };
    this.setScreen(
      'boot',
      el(
        'div',
        { class: 'screen' },
        el(
          'div',
          { class: 'boot' },
          el('div', { class: 'logo logo--lg', html: logoWordmark() }),
          el('div', { class: 'boot__bar' }, el('i', { style: { width: '40%' } })),
          el('div', { class: 'boot__status' }, 'CONNECTING TO MATCH'),
          el('div', { class: 'boot__tips' }, BOOT_TIPS[Math.floor(Math.random() * BOOT_TIPS.length)]),
          button('CANCEL', () => {
            this.connection.close();
            this.showMenu();
          }, { class: 'btn--ghost' }),
        ),
      ),
    );
    this.connection.connect({ ...opts, loadout });
  }

  private cosmeticOverlay(): Partial<LoadoutSelection> {
    const c = store.equippedCosmetics;
    return {
      charm: c.charm,
      killEffect: c.killEffect,
      banner: c.banner,
      icon: c.icon,
      bodyColor: c.bodyColor,
      armorVariant: c.armorVariant,
      crosshair: c.crosshair,
    };
  }

  private applyLoadoutToServer(): void {
    if (this.connection.state !== 'live') return;
    const loadout = { ...store.loadoutFor(this.selectedClass), ...this.cosmeticOverlay() };
    this.connection.setLoadout(loadout);
    this.session.setLoadout(loadout as LoadoutSelection);
  }

  private onConnectionState(state: ConnectionState, detail?: string): void {
    if (state === 'error') {
      this.inMatch = false;
      this.session.stop();
      toast(detail ?? 'Connection failed', true);
      this.showMenu();
    }
    if (state === 'closed' && this.inMatch) {
      this.hud.pushNotice('CONNECTION LOST - RECONNECTING', true);
    }
  }

  private onWelcome(w: { entityId: number; mapId: string; mode: string; room: Record<string, unknown> }): void {
    this.roomSummary = w.room;
    this.session.setSelf(w.entityId);
    this.session.setMode(w.mode);
    this.hud.setSelf(w.entityId);
    this.session.loadMap(w.mapId);
    const def = getMap(w.mapId);
    this.hud.setMap(def);
    const loadout = { ...store.loadoutFor(this.selectedClass), ...this.cosmeticOverlay() } as LoadoutSelection;
    this.session.setLoadout(loadout);
    this.connection.setLoadout(loadout);
    this.inMatch = true;
    this.results = null;
    this.session.start();
    this.closeScreen();
    audio.stopMenuMusic();
    this.hud.pushNotice(`${getMode(w.mode).name.toUpperCase()} · ${def.name.toUpperCase()}`, true);
    store.setLast({ mode: w.mode, map: w.mapId });
  }

  private onRoomState(room: Record<string, unknown>, mapChanged: boolean): void {
    this.roomSummary = room;
    if (mapChanged && typeof room.map === 'string') {
      this.session.loadMap(room.map);
      this.hud.setMap(getMap(room.map));
      this.hud.pushNotice(`MAP: ${getMap(room.map).name.toUpperCase()}`, true);
    }
  }

  private onMatchState(state: MatchStatePayload): void {
    const previousPhase = this.matchState?.phase;
    this.matchState = state;
    this.session.setMatchState(state);
    this.hud.setMatchState(state);
    if (previousPhase !== state.phase) {
      if (state.phase === 'countdown') audio.stinger('start');
      if (state.phase === 'live' && previousPhase === 'countdown') this.hud.pushNotice('FIGHT', true);
      if (state.phase === 'overtime') this.hud.pushNotice('OVERTIME', true);
    }
    if (state.phase === 'countdown' && Math.ceil(state.timeRemaining) !== this.lastCountdown) {
      this.lastCountdown = Math.ceil(state.timeRemaining);
      if (this.lastCountdown > 0) audio.countdownTick(this.lastCountdown <= 1);
    }
  }

  private lastCountdown = -1;

  private onPlayerList(players: PlayerPublicState[]): void {
    this.roster = players;
    this.session.setRoster(players);
    this.hud.setRoster(players);
    if (this.scoreboardOpen) this.showScoreboard();
    if (this.screen === 'lobby') this.showLobby();
  }

  private onKillFeed(entries: KillFeedEntry[]): void {
    this.hud.pushKillFeed(entries);
  }

  private onChat(entry: ChatEntry): void {
    this.chatLog.unshift(entry);
    if (this.chatLog.length > 40) this.chatLog.pop();
    this.renderChatLog();
  }

  private onNotice(text: string): void {
    if (!text) return;
    this.hud.pushNotice(text);
  }

  private onResults(results: MatchResultsPayload): void {
    this.results = results;
    const me = results.players.find((p) => p.name === store.name);
    if (me?.won) audio.stinger('victory');
    else audio.stinger('defeat');
    void api
      .profile()
      .then((res) => store.setProfile(res.profile))
      .catch(() => undefined);
    this.showResults();
  }

  private onHudUpdate(hud: HudSnapshot): void {
    this.lastHud = hud;
    if (!this.inMatch) return;
    const fxStats = this.session.fx.stats();
    const rendererStats = this.renderer.stats();
    // Feed the minimap the data it needs; the HUD owns the drawing.
    const actorPositions = new Map<number, { x: number; y: number; z: number }>();
    const scanned = new Set<number>();
    for (const actor of this.session.actors.values()) {
      actorPositions.set(actor.id, { x: actor.position.x, y: actor.position.y, z: actor.position.z });
    }
    this.hud.setMinimapData(
      { x: this.session.position.x, y: this.session.position.y, z: this.session.position.z },
      this.session.yaw,
      actorPositions,
      scanned,
    );
    this.hud.update(hud, fxStats, rendererStats.drawCalls);
  }

  // =====================================================================
  // Lobby / pause / scoreboard / results
  // =====================================================================

  private showLobby(): void {
    const teams = this.matchState ? getMode(this.matchState.mode).teams : 2;
    const ion = this.roster.filter((p) => p.team === 1);
    const ember = this.roster.filter((p) => p.team === 2);
    const neutral = this.roster.filter((p) => p.team === 0);

    const rosterCol = (label: string, players: PlayerPublicState[], team: number) =>
      el(
        'div',
        { class: 'roster__col' },
        el(
          'div',
          { class: 'roster__head', style: { color: team ? TEAM_COLORS_CSS[team] : 'var(--ink-dim)' } },
          el('span', {}, label),
          el('span', { class: 'mono' }, String(players.length)),
        ),
        el(
          'div',
          { class: 'scroll', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          ...players.map((p) =>
            el(
              'div',
              { class: `roster__row${p.name === store.name ? ' is-self' : ''}` },
              el('span', { html: classIcon(p.classId, 18, team ? TEAM_COLORS_CSS[team] : '#9aa7bd') }),
              el('span', {}, p.name, p.bot ? el('span', { class: 'faint' }, ' · BOT') : null),
              el('span', { class: 'roster__level' }, `LV ${p.accountLevel}`),
              p.ready ? chip('READY', 'chip--good') : chip('...'),
            ),
          ),
          players.length === 0 ? el('div', { class: 'empty' }, 'Empty') : null,
        ),
      );

    const summary = this.roomSummary ?? {};
    const side = el(
      'div',
      { class: 'plate loadout__col' },
      eyebrow('ROOM'),
      el('h3', { style: { marginTop: '8px' } }, String(summary.name ?? 'MATCH')),
      el(
        'div',
        { class: 'card__meta', style: { marginTop: '8px' } },
        chip(`CODE ${String(summary.code ?? '-----')}`, 'chip--ion'),
        chip(String(summary.modeName ?? '')),
        chip(String(summary.mapName ?? '')),
        summary.privateRoom ? chip('PRIVATE') : chip('PUBLIC'),
      ),
      el('hr', { class: 'rule' }),
      eyebrow('YOUR SETUP'),
      el(
        'div',
        { class: 'row', style: { marginTop: '10px' } },
        el('span', { html: classIcon(this.selectedClass, 30) }),
        el('div', { class: 'grow' }, el('div', { class: 'pick__name' }, CLASSES[this.selectedClass].name), el('div', { class: 'pick__meta' }, CLASSES[this.selectedClass].role.toUpperCase())),
      ),
      button('CHANGE CLASS', () => this.showClassSelect(true), { class: 'btn--block' }),
      button('EDIT LOADOUT', () => this.showLoadout(true), { class: 'btn--block' }),
      el('hr', { class: 'rule' }),
      teams === 2
        ? el(
            'div',
            { class: 'col' },
            eyebrow('TEAM'),
            el(
              'div',
              { class: 'row' },
              button('JOIN ION', () => this.connection.selectTeam(1), { class: 'btn--sm' }),
              button('JOIN EMBER', () => this.connection.selectTeam(2), { class: 'btn--sm' }),
            ),
          )
        : null,
    );

    this.setScreen(
      'lobby',
      this.wrapScreen(
        'LOBBY',
        el(
          'div',
          { class: 'lobby' },
          el(
            'div',
            { class: 'roster' },
            teams === 2 ? rosterCol(TEAM_NAMES[1], ion, 1) : rosterCol('PLAYERS', [...neutral, ...ion, ...ember], 0),
            teams === 2 ? rosterCol(TEAM_NAMES[2], ember, 2) : el('div', {}),
          ),
          side,
        ),
        [
          button('LEAVE MATCH', () => this.leaveMatch(), { class: 'btn--danger' }),
          el('div', { class: 'grow' }),
          button('SPECTATE', () => {
            this.connection.spectate();
            this.closeScreen();
          }),
          button('ENTER MATCH', () => this.closeScreen(), { class: 'btn--primary btn--lg', hint: 'ESC' }),
        ],
      ),
    );
  }

  private showPause(): void {
    this.setScreen(
      'pause',
      el(
        'div',
        { class: 'screen screen--transparent' },
        el(
          'div',
          { class: 'center', style: { height: '100%' } },
          el(
            'div',
            { class: 'plate', style: { minWidth: '340px' } },
            eyebrow('PAUSED'),
            el('h1', { style: { margin: '10px 0 18px' } }, 'NEON STRIKE'),
            el(
              'div',
              { class: 'col' },
              button('RESUME', () => this.closeScreen(), { class: 'btn--primary btn--lg btn--block', hint: 'ESC' }),
              button('SCOREBOARD', () => this.showScoreboard(), { class: 'btn--block' }),
              button('CLASS & LOADOUT', () => this.showClassSelect(true), { class: 'btn--block' }),
              button('SETTINGS', () => this.showSettings(), { class: 'btn--block' }),
              button('LOBBY', () => this.showLobby(), { class: 'btn--block' }),
              button('LEAVE MATCH', () => this.leaveMatch(), { class: 'btn--danger btn--block' }),
            ),
            el('hr', { class: 'rule' }),
            el(
              'div',
              { class: 'row row--wrap', style: { gap: '6px' } },
              chip(`${Math.round(this.connection.pingMs)} ms`),
              chip(`${Math.round(this.lastHud?.fps ?? 0)} FPS`),
              chip(`${this.session.netStats.soft} corrections`),
            ),
          ),
        ),
      ),
    );
  }

  private showScoreboard(): void {
    this.scoreboardOpen = true;
    const teams = this.matchState ? getMode(this.matchState.mode).teams : 1;
    const sorted = [...this.roster].sort((a, b) => b.score - a.score || b.kills - a.kills);

    const table = (players: PlayerPublicState[], label: string, team: number) =>
      el(
        'div',
        {},
        el(
          'div',
          { class: 'roster__head', style: { color: team ? TEAM_COLORS_CSS[team] : 'var(--ink-dim)' } },
          el('span', {}, label),
          el('span', { class: 'mono' }, teams === 2 ? String(this.matchState?.teamScores[team - 1] ?? 0) : ''),
        ),
        el(
          'table',
          { class: 'table' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, 'Player'),
              el('th', {}, 'Class'),
              el('th', { class: 'num' }, 'K'),
              el('th', { class: 'num' }, 'D'),
              el('th', { class: 'num' }, 'A'),
              el('th', { class: 'num' }, 'Score'),
              el('th', { class: 'num' }, 'Streak'),
              el('th', { class: 'num' }, 'Ping'),
              el('th', {}, ''),
            ),
          ),
          el(
            'tbody',
            {},
            ...players.map((p) =>
              el(
                'tr',
                { class: p.name === store.name ? 'is-self' : '' },
                el('td', {}, p.name, p.bot ? el('span', { class: 'faint' }, ' BOT') : null, !p.alive ? el('span', { class: 'faint' }, ' ·') : null),
                el('td', {}, el('span', { html: classIcon(p.classId, 18) })),
                el('td', { class: 'num' }, String(p.kills)),
                el('td', { class: 'num' }, String(p.deaths)),
                el('td', { class: 'num' }, String(p.assists)),
                el('td', { class: 'num' }, fmtNumber(p.score)),
                el('td', { class: 'num' }, String(p.streak)),
                el('td', { class: 'num' }, p.bot ? '-' : String(p.ping)),
                el(
                  'td',
                  {},
                  p.bot || p.name === store.name
                    ? null
                    : el(
                        'div',
                        { class: 'row', style: { gap: '4px' } },
                        button('MUTE', () => {
                          this.connection.mute(p.id, true);
                          toast(`${p.name} muted`);
                        }, { class: 'btn--sm btn--ghost' }),
                        button('REPORT', () => {
                          this.connection.report(p.id, 'cheating', '');
                          toast('Report submitted');
                        }, { class: 'btn--sm btn--ghost' }),
                      ),
                ),
              ),
            ),
          ),
        ),
      );

    this.setScreen(
      'scoreboard',
      el(
        'div',
        { class: 'screen screen--overlay' },
        el(
          'div',
          { class: 'screen__bar' },
          el('div', { class: 'screen__title' }, 'SCOREBOARD'),
          el('div', { class: 'grow' }),
          this.matchState ? chip(getMode(this.matchState.mode).name) : null,
          this.matchState ? chip(getMap(this.matchState.map).name) : null,
        ),
        el(
          'div',
          { class: 'screen__body scoreboard' },
          el(
            'div',
            { class: 'scoreboard__teams' },
            teams === 2
              ? table(sorted.filter((p) => p.team === 1), TEAM_NAMES[1], 1)
              : table(sorted, 'ALL PLAYERS', 0),
            teams === 2 ? table(sorted.filter((p) => p.team === 2), TEAM_NAMES[2], 2) : null,
          ),
        ),
        el(
          'div',
          { class: 'screen__footer' },
          button('CLOSE', () => this.hideScoreboard(), { class: 'btn--ghost', hint: 'TAB' }),
        ),
      ),
    );
  }

  private hideScoreboard(): void {
    this.scoreboardOpen = false;
    if (this.inMatch) this.closeScreen();
    else this.showMenu();
  }

  private showResults(): void {
    const r = this.results;
    if (!r) return;
    const me = r.players.find((p) => p.name === store.name);
    const teams = getMode(r.mode).teams;
    const verdict = me?.won ? 'VICTORY' : r.winningTeam === 0 && teams === 2 ? 'DRAW' : 'DEFEAT';
    const verdictClass = me?.won ? 'is-win' : verdict === 'DRAW' ? 'is-draw' : 'is-loss';

    const xpPanel = me
      ? el(
          'div',
          { class: 'plate' },
          eyebrow('EXPERIENCE'),
          el(
            'div',
            { class: 'xp', style: { marginTop: '10px' } },
            ...me.xpBreakdown.map((line) =>
              el('div', { class: 'xp__row' }, el('span', {}, line.label), el('span', { class: 'mono' }, `+${fmtNumber(line.amount)}`)),
            ),
            el('div', { class: 'xp__total' }, el('span', {}, 'TOTAL'), el('span', { class: 'mono' }, `+${fmtNumber(me.xpEarned)}`)),
          ),
          me.accountLevelAfter > me.accountLevel
            ? el(
                'div',
                { class: 'plate plate--hot', style: { marginTop: '14px', padding: '12px' } },
                el('h3', {}, `LEVEL UP · ${me.accountLevel} → ${me.accountLevelAfter}`),
                el('p', { class: 'faint' }, 'New weapons, attachments and cosmetics may now be available.'),
              )
            : null,
        )
      : el('div', { class: 'plate' }, el('div', { class: 'empty' }, 'Spectator - no XP earned.'));

    this.setScreen(
      'results',
      el(
        'div',
        { class: 'screen' },
        el(
          'div',
          { class: 'screen__bar' },
          el('div', { class: 'screen__title' }, 'MATCH RESULTS'),
          el('div', { class: 'grow' }),
          chip(getMode(r.mode).name),
          chip(getMap(r.map).name),
          chip(fmtTime(r.durationSec)),
        ),
        el(
          'div',
          { class: 'screen__body' },
          el(
            'div',
            { class: 'results__banner' },
            el('div', { class: `results__verdict ${verdictClass}` }, verdict),
            teams === 2
              ? el(
                  'div',
                  { class: 'row', style: { justifyContent: 'center', gap: '20px', marginTop: '10px' } },
                  el('span', { style: { color: TEAM_COLORS_CSS[1], fontSize: '28px' }, class: 'mono' }, String(r.teamScores[0])),
                  el('span', { class: 'faint' }, 'vs'),
                  el('span', { style: { color: TEAM_COLORS_CSS[2], fontSize: '28px' }, class: 'mono' }, String(r.teamScores[1])),
                )
              : null,
          ),
          el(
            'div',
            { class: 'settings-grid' },
            el(
              'div',
              { class: 'plate' },
              eyebrow('SCOREBOARD'),
              el(
                'table',
                { class: 'table', style: { marginTop: '10px' } },
                el(
                  'thead',
                  {},
                  el(
                    'tr',
                    {},
                    el('th', {}, 'Player'),
                    el('th', { class: 'num' }, 'K'),
                    el('th', { class: 'num' }, 'D'),
                    el('th', { class: 'num' }, 'A'),
                    el('th', { class: 'num' }, 'DMG'),
                    el('th', { class: 'num' }, 'HS'),
                    el('th', { class: 'num' }, 'Score'),
                    el('th', { class: 'num' }, 'XP'),
                  ),
                ),
                el(
                  'tbody',
                  {},
                  ...r.players.map((p) =>
                    el(
                      'tr',
                      { class: p.name === store.name ? 'is-self' : '' },
                      el(
                        'td',
                        {},
                        p.id === r.mvpId ? chip('MVP', 'chip--ion') : null,
                        ' ',
                        p.name,
                        p.bot ? el('span', { class: 'faint' }, ' BOT') : null,
                      ),
                      el('td', { class: 'num' }, String(p.kills)),
                      el('td', { class: 'num' }, String(p.deaths)),
                      el('td', { class: 'num' }, String(p.assists)),
                      el('td', { class: 'num' }, fmtNumber(p.damage)),
                      el('td', { class: 'num' }, String(p.headshots)),
                      el('td', { class: 'num' }, fmtNumber(p.score)),
                      el('td', { class: 'num' }, p.bot ? '-' : `+${fmtNumber(p.xpEarned)}`),
                    ),
                  ),
                ),
              ),
            ),
            xpPanel,
          ),
        ),
        el(
          'div',
          { class: 'screen__footer' },
          button('LEAVE', () => this.leaveMatch(), { class: 'btn--danger' }),
          el('div', { class: 'grow' }),
          button('REMATCH', () => {
            this.connection.rematch(true);
            toast('Rematch requested');
            this.closeScreen();
          }),
          button('RETURN TO LOBBY', () => {
            this.connection.rematch(false);
            this.showLobby();
          }, { class: 'btn--primary btn--lg' }),
        ),
      ),
    );
  }

  private leaveMatch(): void {
    this.connection.leave();
    this.session.stop();
    this.inMatch = false;
    this.results = null;
    this.roster = [];
    this.matchState = null;
    this.chatLog = [];
    this.hud.clear();
    this.hud.setVisible(false);
    this.showMenu();
  }

  // =====================================================================
  // Chat
  // =====================================================================

  private openChat(teamOnly: boolean): void {
    if (this.chatOpen) return;
    this.chatOpen = true;
    this.chatTeamOnly = teamOnly;
    this.input.setEnabled(false);
    this.input.releaseLock();
    const input = el('input', {
      type: 'text',
      maxlength: String(MAX_CHAT_LENGTH),
      placeholder: 'Say something...',
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          const text = input.value.trim();
          if (text) this.connection.chat(text, this.chatTeamOnly);
          this.closeChat();
        }
        if (ev.key === 'Escape') this.closeChat();
        ev.stopPropagation();
      },
    });
    const node = el(
      'div',
      { class: 'chat__input' },
      el('span', { class: 'chat__scope' }, teamOnly ? '[TEAM]' : '[ALL]'),
      input,
    );
    this.ensureChatContainer().appendChild(node);
    input.focus();
    this.chatNode = node;
  }

  private closeChat(): void {
    this.chatOpen = false;
    this.chatNode?.remove();
    this.chatNode = null;
    if (this.inMatch && this.screen === 'none') {
      this.input.setEnabled(true);
      this.input.requestLock();
    }
  }

  private ensureChatContainer(): HTMLElement {
    let container = document.querySelector<HTMLElement>('.chat');
    if (!container) {
      container = el('div', { class: 'chat' }, el('div', { class: 'chat__log' }));
      document.body.appendChild(container);
    }
    return container;
  }

  private renderChatLog(): void {
    const container = this.ensureChatContainer();
    const log = container.querySelector('.chat__log');
    if (!log) return;
    clear(log);
    for (const entry of this.chatLog.slice(0, 8)) {
      append(
        log,
        el(
          'div',
          { class: 'chat__row' },
          el(
            'span',
            { class: 'chat__from', style: { color: entry.team ? TEAM_COLORS_CSS[entry.team] : 'var(--ink)' } },
            entry.teamOnly ? '[TEAM] ' : '',
            entry.from,
            ': ',
          ),
          el('span', {}, entry.text),
        ),
      );
    }
  }

  // =====================================================================

  private wrapScreen(title: string, body: HTMLElement, footer: (HTMLElement | null)[]): HTMLElement {
    return el(
      'div',
      { class: 'screen' },
      el(
        'div',
        { class: 'screen__bar' },
        el('div', { html: logoWordmark() }),
        el('div', { class: 'screen__title', style: { marginLeft: '18px' } }, title),
        el('div', { class: 'grow' }),
        chip(store.name || 'RECRUIT', 'chip--ion'),
      ),
      el('div', { class: 'screen__body' }, body),
      el('div', { class: 'screen__footer' }, ...footer.filter(Boolean)),
    );
  }

  installKeyUp(): void {
    window.addEventListener('keyup', (ev) => this.onGlobalKeyUp(ev));
  }
}
