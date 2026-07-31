/**
 * In-game HUD.
 *
 * Split by update frequency, which is the only way to keep a 60Hz HUD cheap:
 *   - Canvas overlay (every frame): crosshair, hit markers, damage direction,
 *     minimap, objective compass. These change continuously.
 *   - DOM (on change only): health, ammo, timer, scores, kill feed, notices.
 *     Text nodes are cached and written only when the value actually differs,
 *     so a still frame costs zero layout work.
 */

import {
  COSMETICS,
  TEAM_COLORS_CSS,
  TEAM_NAMES,
  clamp,
  getMode,
  type CrosshairPreset,
  type KillFeedEntry,
  type MapDef,
  type MatchStatePayload,
  type PlayerPublicState,
} from '@kang/shared';
import { store } from '../state/store.js';
import type { HudSnapshot } from '../game/session.js';
import { iconMarkup, weaponIcon } from './icons.js';

interface Notice {
  text: string;
  until: number;
  big: boolean;
}

/**
 * Canvas 2D has no access to CSS custom properties, so the handful of palette
 * colours the overlay paints with are mirrored from base.css here rather than
 * scattered as literals through the draw calls.
 */
const PAINT = {
  /** --ion channels, for rgba() strings. */
  ion: '168, 85, 247',
  /** --void channels, the minimap backing. */
  void: '9, 7, 14',
  /** --ink, --ink-dim and the unassigned team grey. */
  ink: '#f1eefb',
  inkDim: '#ded6ef',
  neutral: '#a79cba',
  /** Headshots stay gold and enemies stay red: those read as meaning, not theme. */
  headshot: '#ffd76b',
  hostile: '#ff4d5e',
} as const;

export class Hud {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  // Cached DOM nodes.
  private el: Record<string, HTMLElement> = {};
  private lastText = new Map<string, string>();
  private killFeedEntries: { entry: KillFeedEntry; node: HTMLElement; until: number }[] = [];
  private notices: Notice[] = [];
  private noticeNode: HTMLElement | null = null;
  private matchState: MatchStatePayload | null = null;
  private roster: PlayerPublicState[] = [];
  private mapDef: MapDef | null = null;
  private hud: HudSnapshot | null = null;
  private selfId = 0;
  private minimapCache: HTMLCanvasElement | null = null;
  private minimapCacheKey = '';

  constructor(root: HTMLElement, overlay: HTMLCanvasElement) {
    this.root = root;
    this.canvas = overlay;
    const ctx = overlay.getContext('2d');
    if (!ctx) throw new Error('2D overlay context unavailable');
    this.ctx = ctx;
    this.build();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    store.on('settings', () => {
      this.resize();
      this.applyVisibility();
    });
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.minimapCacheKey = '';
  }

  // ---------------------------------------------------------------------
  // DOM scaffold
  // ---------------------------------------------------------------------

  private build(): void {
    this.root.innerHTML = `
      <div class="hud__top">
        <div class="hud__score" id="hud-score"></div>
        <div class="hud__timer">
          <div class="hud__timer-value mono" id="hud-timer">0:00</div>
          <div class="hud__timer-label" id="hud-mode">MATCH</div>
        </div>
        <div class="hud__objectives" id="hud-objectives"></div>
      </div>

      <div class="hud__feed" id="hud-feed"></div>

      <div class="hud__notice" id="hud-notice"></div>

      <div class="hud__minimap-frame" id="hud-minimap-frame">
        <div class="hud__minimap-label mono" id="hud-map-name"></div>
      </div>

      <div class="hud__bottom-left">
        <div class="hud__vitals">
          <div class="hud__vital-row">
            <span class="hud__vital-label">HP</span>
            <div class="hud__vital-bar"><i id="hud-health-fill"></i></div>
            <span class="hud__vital-value mono" id="hud-health">100</span>
          </div>
          <div class="hud__vital-row hud__vital-row--shield" id="hud-shield-row">
            <span class="hud__vital-label">SH</span>
            <div class="hud__vital-bar hud__vital-bar--shield"><i id="hud-shield-fill"></i></div>
            <span class="hud__vital-value mono" id="hud-shield">0</span>
          </div>
        </div>
        <div class="hud__abilities">
          <div class="hud__ability" id="hud-ability">
            <div class="hud__ability-key mono">Q</div>
            <div class="hud__ability-ring"><i id="hud-ability-fill"></i></div>
            <div class="hud__ability-name" id="hud-ability-name">ABILITY</div>
          </div>
          <div class="hud__ability hud__ability--ult" id="hud-ultimate">
            <div class="hud__ability-key mono">F</div>
            <div class="hud__ability-ring"><i id="hud-ultimate-fill"></i></div>
            <div class="hud__ability-name" id="hud-ultimate-name">ULTIMATE</div>
          </div>
        </div>
      </div>

      <div class="hud__bottom-right">
        <div class="hud__weapon">
          <div class="hud__weapon-icon" id="hud-weapon-icon"></div>
          <div class="hud__weapon-text">
            <div class="hud__weapon-name" id="hud-weapon-name">PULSE-AR</div>
            <div class="hud__ammo mono">
              <span id="hud-ammo">30</span><span class="hud__ammo-sep">/</span><span class="hud__reserve" id="hud-reserve">180</span>
            </div>
          </div>
        </div>
        <div class="hud__slots" id="hud-slots"></div>
      </div>

      <div class="hud__streak" id="hud-streak"></div>

      <div class="hud__diag mono" id="hud-diag"></div>

      <div class="hud__respawn" id="hud-respawn">
        <div class="hud__respawn-title">ELIMINATED</div>
        <div class="hud__respawn-by" id="hud-respawn-by"></div>
        <div class="hud__respawn-timer mono" id="hud-respawn-timer"></div>
        <div class="hud__respawn-hint">Respawning automatically</div>
      </div>

      <div class="hud__vignette" id="hud-vignette"></div>
      <div class="hud__scope" id="hud-scope"></div>
      <div class="hud__subtitles" id="hud-subs"></div>
    `;
    for (const node of this.root.querySelectorAll<HTMLElement>('[id^="hud-"]')) {
      this.el[node.id.replace('hud-', '')] = node;
    }
    this.noticeNode = this.el.notice;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const size = store.num('minimapSize');
    this.el['minimap-frame'].style.setProperty('--minimap-size', `${size}px`);
    this.el.diag.hidden = !store.bool('showFps') && !store.bool('showPing') && !store.bool('showNetGraph');
    this.el.subs.hidden = !store.bool('subtitles');
  }

  private setText(key: string, value: string): void {
    if (this.lastText.get(key) === value) return;
    this.lastText.set(key, value);
    const node = this.el[key];
    if (node) node.textContent = value;
  }

  private setStyle(key: string, prop: string, value: string): void {
    const cacheKey = `${key}:${prop}`;
    if (this.lastText.get(cacheKey) === value) return;
    this.lastText.set(cacheKey, value);
    const node = this.el[key];
    if (node) node.style.setProperty(prop, value);
  }

  // ---------------------------------------------------------------------
  // External updates
  // ---------------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.canvas.style.opacity = visible ? '1' : '0';
  }

  setSelf(id: number): void {
    this.selfId = id;
  }

  setMap(def: MapDef): void {
    this.mapDef = def;
    this.minimapCacheKey = '';
    this.setText('map-name', def.name.toUpperCase());
  }

  setMatchState(state: MatchStatePayload): void {
    this.matchState = state;
    const mode = getMode(state.mode);
    const minutes = Math.floor(state.timeRemaining / 60);
    const seconds = Math.floor(state.timeRemaining % 60);
    this.setText('timer', `${minutes}:${String(seconds).padStart(2, '0')}`);
    const label =
      state.phase === 'warmup'
        ? 'WARMUP'
        : state.phase === 'countdown'
          ? 'STARTING'
          : state.phase === 'overtime'
            ? 'OVERTIME'
            : state.phase === 'ended'
              ? 'MATCH OVER'
              : mode.short;
    this.setText('mode', label);
    this.el.timer.classList.toggle('is-urgent', state.timeRemaining <= 30 && state.phase === 'live');

    // Team scores or personal score, depending on the mode.
    if (mode.teams === 2) {
      const limit = state.scoreLimit;
      this.el.score.innerHTML = `
        <div class="hud__team hud__team--ion">
          <span class="hud__team-name">${TEAM_NAMES[1]}</span>
          <span class="hud__team-score mono">${state.teamScores[0]}</span>
        </div>
        <div class="hud__score-limit mono">${limit}</div>
        <div class="hud__team hud__team--ember">
          <span class="hud__team-score mono">${state.teamScores[1]}</span>
          <span class="hud__team-name">${TEAM_NAMES[2]}</span>
        </div>`;
    } else {
      const me = this.roster.find((p) => p.id === this.selfId);
      const leader = [...this.roster].sort((a, b) => b.kills - a.kills)[0];
      this.el.score.innerHTML = `
        <div class="hud__team"><span class="hud__team-name">YOU</span><span class="hud__team-score mono">${me?.kills ?? 0}</span></div>
        <div class="hud__score-limit mono">${state.scoreLimit}</div>
        <div class="hud__team"><span class="hud__team-score mono">${leader?.kills ?? 0}</span><span class="hud__team-name">LEAD</span></div>`;
    }

    // Objective pips.
    if (state.objectives.length > 0 && mode.objectiveKind !== 'none') {
      this.el.objectives.innerHTML = state.objectives
        .filter((o) => o.active)
        .map((o) => {
          const color = o.owner !== 0 ? TEAM_COLORS_CSS[o.owner] : 'var(--ink-faint)';
          const contested = o.contestedBy === 3 ? ' is-contested' : '';
          return `<div class="hud__obj${contested}" style="--obj-color:${color}">
            <span class="hud__obj-label">${o.label}</span>
            <span class="hud__obj-bar"><i style="width:${Math.round(o.progress * 100)}%"></i></span>
          </div>`;
        })
        .join('');
    } else {
      this.el.objectives.innerHTML = '';
    }
  }

  setRoster(players: PlayerPublicState[]): void {
    this.roster = players;
    if (this.matchState) this.setMatchState(this.matchState);
  }

  pushKillFeed(entries: KillFeedEntry[]): void {
    const limit = store.num('killFeedLength');
    for (const entry of entries) {
      const node = document.createElement('div');
      node.className = 'hud__feed-row anim-in';
      const attackerColor = entry.attackerTeam ? TEAM_COLORS_CSS[entry.attackerTeam] : 'var(--ink)';
      const victimColor = entry.victimTeam ? TEAM_COLORS_CSS[entry.victimTeam] : 'var(--ink)';
      const isMe = entry.attacker === store.name || entry.victim === store.name;
      if (isMe) node.classList.add('is-self');
      const icon = iconMarkup(weaponIcon(entry.weapon, 22, entry.headshot ? PAINT.headshot : PAINT.inkDim));
      const tags = [
        entry.headshot ? '<span class="hud__feed-tag">HS</span>' : '',
        entry.wallbang ? '<span class="hud__feed-tag">WALL</span>' : '',
      ].join('');
      node.innerHTML = `
        <span class="hud__feed-name" style="color:${attackerColor}">${escapeHtml(entry.attacker || 'WORLD')}</span>
        <span class="hud__feed-icon">${icon}</span>
        ${tags}
        <span class="hud__feed-name" style="color:${victimColor}">${escapeHtml(entry.victim)}</span>`;
      this.el.feed.prepend(node);
      this.killFeedEntries.unshift({ entry, node, until: performance.now() + 7000 });
    }
    while (this.killFeedEntries.length > limit) {
      const removed = this.killFeedEntries.pop();
      removed?.node.remove();
    }
  }

  pushNotice(text: string, big = false): void {
    if (!text) return;
    this.notices.push({ text, until: performance.now() + (big ? 3200 : 2400), big });
    if (this.notices.length > 4) this.notices.shift();
    this.renderNotices();
    if (store.bool('subtitles')) {
      this.el.subs.textContent = text;
      window.setTimeout(() => {
        if (this.el.subs.textContent === text) this.el.subs.textContent = '';
      }, 2600);
    }
  }

  private renderNotices(): void {
    if (!this.noticeNode) return;
    this.noticeNode.innerHTML = this.notices
      .map((n) => `<div class="hud__notice-row${n.big ? ' is-big' : ''} anim-in">${escapeHtml(n.text)}</div>`)
      .join('');
  }

  // ---------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------

  update(hud: HudSnapshot, fxStats: { tracers: number; particles: number; decals: number }, drawCalls: number): void {
    this.hud = hud;

    // -- DOM (only when changed) ----------------------------------------
    this.setText('health', String(Math.ceil(hud.health)));
    this.setStyle('health-fill', 'width', `${clamp((hud.health / Math.max(1, hud.maxHealth)) * 100, 0, 100).toFixed(1)}%`);
    const lowHp = hud.health <= hud.maxHealth * 0.3;
    this.el.health.classList.toggle('is-low', lowHp);
    this.setStyle('vignette', 'opacity', hud.alive ? String(lowHp ? clamp(1 - hud.health / (hud.maxHealth * 0.3), 0, 1) * 0.55 : 0) : '0');

    this.el['shield-row'].hidden = hud.maxShield <= 0;
    this.setText('shield', String(Math.ceil(hud.shield)));
    this.setStyle('shield-fill', 'width', `${clamp((hud.shield / Math.max(1, hud.maxShield)) * 100, 0, 100).toFixed(1)}%`);

    if (hud.weapon) {
      this.setText('weapon-name', hud.weapon.short);
      this.setText('ammo', String(hud.ammo));
      this.setText('reserve', String(hud.reserve));
      this.el.ammo.classList.toggle('is-low', hud.ammo <= Math.max(1, Math.floor(hud.weapon.magazine * 0.25)));
      const iconKey = `icon:${hud.weapon.id}`;
      if (this.lastText.get(iconKey) !== '1') {
        this.lastText.delete('icon:prev');
        this.lastText.set(iconKey, '1');
        this.el['weapon-icon'].replaceChildren(weaponIcon(hud.weapon.id, 40, PAINT.inkDim));
      }
      const slots = `${hud.slot}`;
      if (this.lastText.get('slots') !== slots) {
        this.lastText.set('slots', slots);
        this.el.slots.innerHTML = [0, 1, 2]
          .map((i) => `<span class="hud__slot${i === hud.slot ? ' is-active' : ''} mono">${i + 1}</span>`)
          .join('');
      }
    }

    this.setText('ability-name', hud.abilityName.toUpperCase());
    this.setText('ultimate-name', hud.ultimateName.toUpperCase());
    this.setStyle('ability-fill', 'width', `${Math.round(hud.abilityCharge * 100)}%`);
    this.setStyle('ultimate-fill', 'width', `${Math.round(hud.ultimateCharge * 100)}%`);
    this.el.ability.classList.toggle('is-ready', hud.abilityCharge >= 1);
    this.el.ultimate.classList.toggle('is-ready', hud.ultimateCharge >= 1);

    this.el.respawn.hidden = hud.alive;
    if (!hud.alive) {
      this.setText('respawn-by', hud.killedBy ? `Eliminated by ${hud.killedBy}` : 'Eliminated');
      this.setText('respawn-timer', hud.respawnIn > 0 ? hud.respawnIn.toFixed(1) : 'RESPAWNING');
    }

    this.el.streak.hidden = hud.streak < 2;
    if (hud.streak >= 2) this.setText('streak', `${hud.streak} STREAK`);

    // Scope overlay for scoped weapons at full ADS.
    const scoped = !!hud.weapon?.scoped && hud.spreadPixels < 2;
    this.el.scope.hidden = !scoped;

    if (!this.el.diag.hidden) {
      const parts: string[] = [];
      if (store.bool('showFps')) parts.push(`${Math.round(hud.fps)} FPS`);
      if (store.bool('showPing')) parts.push(`${hud.ping} ms`);
      if (store.bool('showNetGraph')) {
        parts.push(`${drawCalls} calls`);
        parts.push(`${fxStats.particles}p`);
        parts.push(`${hud.speed.toFixed(1)} m/s`);
      }
      this.setText('diag', parts.join('  |  '));
    }

    // Expire notices and kill-feed rows.
    const now = performance.now();
    if (this.notices.length > 0 && this.notices.some((n) => n.until < now)) {
      this.notices = this.notices.filter((n) => n.until >= now);
      this.renderNotices();
    }
    for (let i = this.killFeedEntries.length - 1; i >= 0; i--) {
      if (this.killFeedEntries[i].until < now) {
        this.killFeedEntries[i].node.remove();
        this.killFeedEntries.splice(i, 1);
      }
    }

    // -- canvas ---------------------------------------------------------
    this.drawOverlay(hud);
  }

  private drawOverlay(hud: HudSnapshot): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    const cw = w / this.dpr;
    const ch = h / this.dpr;
    const cx = cw / 2;
    const cy = ch / 2;

    if (hud.alive) {
      this.drawCrosshair(ctx, cx, cy, hud);
      if (hud.hitMarker > 0) this.drawHitMarker(ctx, cx, cy, hud.hitMarker, hud.hitMarkerHeadshot);
      this.drawDamageIndicators(ctx, cx, cy, hud.damageDirections);
    }
    this.drawMinimap(ctx, cw);
    ctx.restore();
  }

  private drawCrosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number, hud: HudSnapshot): void {
    const preset = this.crosshairPreset();
    if (hud.weapon?.scoped && hud.spreadPixels < 2) {
      // Scoped: a fine cross with a centre dot, drawn over the scope mask.
      ctx.strokeStyle = preset.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 90, cy);
      ctx.lineTo(cx - 8, cy);
      ctx.moveTo(cx + 8, cy);
      ctx.lineTo(cx + 90, cy);
      ctx.moveTo(cx, cy - 90);
      ctx.lineTo(cx, cy - 8);
      ctx.moveTo(cx, cy + 8);
      ctx.lineTo(cx, cy + 90);
      ctx.stroke();
      ctx.fillStyle = preset.color;
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
      return;
    }

    const dynamic = preset.dynamic;
    const gap = preset.gap + (dynamic ? clamp(hud.spreadPixels, 0, 90) : 0);
    const len = preset.size;
    const t = preset.thickness;
    ctx.lineCap = 'butt';

    const stroke = (fn: () => void) => {
      if (preset.outline) {
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = t + 2;
        fn();
      }
      ctx.strokeStyle = preset.color;
      ctx.lineWidth = t;
      fn();
    };

    switch (preset.shape) {
      case 'dot':
        if (preset.outline) {
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.beginPath();
          ctx.arc(cx, cy, t / 2 + 1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = preset.color;
        ctx.beginPath();
        ctx.arc(cx, cy, t / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'circle':
        stroke(() => {
          ctx.beginPath();
          ctx.arc(cx, cy, gap + len * 0.5, 0, Math.PI * 2);
          ctx.stroke();
        });
        break;
      case 'chevron':
        stroke(() => {
          ctx.beginPath();
          ctx.moveTo(cx - gap - len, cy - len * 0.6);
          ctx.lineTo(cx - gap, cy);
          ctx.lineTo(cx - gap - len, cy + len * 0.6);
          ctx.moveTo(cx + gap + len, cy - len * 0.6);
          ctx.lineTo(cx + gap, cy);
          ctx.lineTo(cx + gap + len, cy + len * 0.6);
          ctx.stroke();
        });
        break;
      case 'brackets':
        stroke(() => {
          const s = gap + len;
          ctx.beginPath();
          for (const [sx, sy] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ] as const) {
            ctx.moveTo(cx + sx * s, cy + sy * s - sy * len * 0.6);
            ctx.lineTo(cx + sx * s, cy + sy * s);
            ctx.lineTo(cx + sx * s - sx * len * 0.6, cy + sy * s);
          }
          ctx.stroke();
        });
        break;
      case 'tshape':
        stroke(() => {
          ctx.beginPath();
          ctx.moveTo(cx - gap - len, cy);
          ctx.lineTo(cx - gap, cy);
          ctx.moveTo(cx + gap, cy);
          ctx.lineTo(cx + gap + len, cy);
          ctx.moveTo(cx, cy + gap);
          ctx.lineTo(cx, cy + gap + len);
          ctx.stroke();
        });
        break;
      default:
        stroke(() => {
          ctx.beginPath();
          ctx.moveTo(cx - gap - len, cy);
          ctx.lineTo(cx - gap, cy);
          ctx.moveTo(cx + gap, cy);
          ctx.lineTo(cx + gap + len, cy);
          ctx.moveTo(cx, cy - gap - len);
          ctx.lineTo(cx, cy - gap);
          ctx.moveTo(cx, cy + gap);
          ctx.lineTo(cx, cy + gap + len);
          ctx.stroke();
        });
        break;
    }

    if (preset.dot && preset.shape !== 'dot') {
      ctx.fillStyle = preset.color;
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
    }
  }

  private crosshairPreset(): CrosshairPreset {
    const id = store.str('crosshairId');
    const base = (COSMETICS[id]?.crosshair ?? COSMETICS.xh_cross.crosshair) as CrosshairPreset;
    return {
      ...base,
      size: store.num('crosshairSize'),
      thickness: store.num('crosshairThickness'),
      gap: store.num('crosshairGap'),
      dot: store.bool('crosshairDot'),
      dynamic: store.bool('crosshairDynamic'),
      color: store.str('crosshairColor'),
    };
  }

  private drawHitMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, strength: number, headshot: boolean): void {
    const style = store.str('hitMarkerStyle');
    const a = clamp(strength, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = headshot ? PAINT.headshot : '#ffffff';
    ctx.lineWidth = headshot ? 3 : 2;
    const r = 10 + (1 - a) * 8;
    if (style === 'dot') {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(cx, cy, 3 + (1 - a) * 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (style === 'brackets') {
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * r, cy + sy * r - sy * 5);
        ctx.lineTo(cx + sx * r, cy + sy * r);
        ctx.lineTo(cx + sx * r - sx * 5, cy + sy * r);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        ctx.moveTo(cx + sx * (r * 0.45), cy + sy * (r * 0.45));
        ctx.lineTo(cx + sx * r, cy + sy * r);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDamageIndicators(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    dirs: { angle: number; strength: number }[],
  ): void {
    if (dirs.length === 0) return;
    const radius = Math.min(cx, cy) * 0.42;
    ctx.save();
    for (const d of dirs) {
      const a = clamp(d.strength, 0, 1);
      ctx.globalAlpha = a * 0.85;
      ctx.translate(cx, cy);
      ctx.rotate(-d.angle);
      const grad = ctx.createLinearGradient(0, -radius - 34, 0, -radius);
      grad.addColorStop(0, 'rgba(255,77,94,0)');
      grad.addColorStop(1, 'rgba(255,77,94,0.95)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(-34, -radius);
      ctx.lineTo(0, -radius - 30);
      ctx.lineTo(34, -radius);
      ctx.closePath();
      ctx.fill();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Minimap
  // ---------------------------------------------------------------------

  private buildMinimapCache(size: number): HTMLCanvasElement {
    const def = this.mapDef;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx || !def) return canvas;

    const bounds = def.bounds;
    const spanX = bounds.maxX - bounds.minX;
    const spanZ = bounds.maxZ - bounds.minZ;
    const span = Math.max(spanX, spanZ);
    const scale = size / span;
    const ox = (size - spanX * scale) / 2;
    const oz = (size - spanZ * scale) / 2;

    ctx.fillStyle = `rgba(${PAINT.void}, 0.72)`;
    ctx.fillRect(0, 0, size, size);

    // Draw brushes as filled rectangles, lowest first so upper floors sit on
    // top. Only solid, minimap-eligible brushes are drawn.
    const brushes = def.brushes
      .filter((b) => !b.ghost && !b.noMinimap && b.s[1] > 0.2)
      .sort((a, b) => a.p[1] - b.p[1]);
    for (const b of brushes) {
      const mat = b.m;
      const color = MINIMAP_COLORS[mat];
      if (!color) continue;
      const x = ox + (b.p[0] - b.s[0] - bounds.minX) * scale;
      const z = oz + (b.p[2] - b.s[2] - bounds.minZ) * scale;
      const bw = b.s[0] * 2 * scale;
      const bh = b.s[2] * 2 * scale;
      ctx.save();
      if (b.ry) {
        ctx.translate(ox + (b.p[0] - bounds.minX) * scale, oz + (b.p[2] - bounds.minZ) * scale);
        ctx.rotate((-(b.ry ?? 0) * Math.PI) / 180);
        ctx.fillStyle = color;
        ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(x, z, bw, bh);
      }
      ctx.restore();
    }
    return canvas;
  }

  private drawMinimap(ctx: CanvasRenderingContext2D, cw: number): void {
    const def = this.mapDef;
    if (!def) return;
    const size = store.num('minimapSize');
    const pad = 18;
    const x0 = cw - size - pad;
    const y0 = pad + 46;

    const key = `${def.id}:${size}`;
    if (this.minimapCacheKey !== key) {
      this.minimapCache = this.buildMinimapCache(size);
      this.minimapCacheKey = key;
    }

    ctx.save();
    // Clip to the frame so rotation cannot bleed outside.
    ctx.beginPath();
    ctx.rect(x0, y0, size, size);
    ctx.clip();

    const rotate = store.bool('minimapRotate');
    const bounds = def.bounds;
    const spanX = bounds.maxX - bounds.minX;
    const spanZ = bounds.maxZ - bounds.minZ;
    const span = Math.max(spanX, spanZ);
    const scale = size / span;
    const toX = (wx: number) => x0 + (size - spanX * scale) / 2 + (wx - bounds.minX) * scale;
    const toY = (wz: number) => y0 + (size - spanZ * scale) / 2 + (wz - bounds.minZ) * scale;

    const centreX = x0 + size / 2;
    const centreY = y0 + size / 2;
    const selfInfo = this.roster.find((p) => p.id === this.selfId);
    const selfX = this.selfWorld.x;
    const selfZ = this.selfWorld.z;

    if (rotate) {
      ctx.translate(centreX, centreY);
      ctx.rotate(this.selfYaw);
      ctx.translate(-toX(selfX), -toY(selfZ));
    }

    if (this.minimapCache) ctx.drawImage(this.minimapCache, x0, y0);

    // Objectives.
    if (this.matchState) {
      for (const o of this.matchState.objectives) {
        if (!o.active) continue;
        const color = o.owner !== 0 ? TEAM_COLORS_CSS[o.owner] : PAINT.neutral;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.arc(toX(o.x), toY(o.z), o.radius * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = PAINT.ink;
        ctx.font = '600 10px "Cascadia Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(o.label.slice(0, 4), toX(o.x), toY(o.z) + 3);
      }
    }

    // Teammates and scanned enemies.
    for (const [id, pos] of this.actorPositions) {
      const info = this.roster.find((p) => p.id === id);
      if (!info) continue;
      const isTeam = selfInfo && info.team === selfInfo.team && info.team !== 0;
      if (!isTeam && !this.scannedIds.has(id)) continue;
      ctx.fillStyle = isTeam ? TEAM_COLORS_CSS[info.team] : PAINT.hostile;
      ctx.beginPath();
      ctx.arc(toX(pos.x), toY(pos.z), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Self: a triangle pointing where we look.
    ctx.save();
    ctx.translate(toX(selfX), toY(selfZ));
    ctx.rotate(-this.selfYaw);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // Frame.
    ctx.strokeStyle = `rgba(${PAINT.ion}, 0.35)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
    // Corner ticks, echoing the clipped corners of the plate surfaces.
    ctx.strokeStyle = `rgba(${PAINT.ion}, 0.8)`;
    ctx.lineWidth = 2;
    const tick = 12;
    for (const [sx, sy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const px = x0 + sx * size;
      const py = y0 + sy * size;
      ctx.beginPath();
      ctx.moveTo(px + (sx ? -tick : tick), py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + (sy ? -tick : tick));
      ctx.stroke();
    }
  }

  // Fed by the session each frame.
  private selfWorld = { x: 0, y: 0, z: 0 };
  private selfYaw = 0;
  private actorPositions = new Map<number, { x: number; y: number; z: number }>();
  private scannedIds = new Set<number>();

  setMinimapData(
    self: { x: number; y: number; z: number },
    yaw: number,
    actors: Map<number, { x: number; y: number; z: number }>,
    scanned: Set<number>,
  ): void {
    this.selfWorld = self;
    this.selfYaw = yaw;
    this.actorPositions = actors;
    this.scannedIds = scanned;
  }

  clear(): void {
    this.killFeedEntries.forEach((k) => k.node.remove());
    this.killFeedEntries.length = 0;
    this.notices.length = 0;
    this.renderNotices();
    this.lastText.clear();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

/**
 * Top-down fill per material. These are a readability table, not a copy of the
 * 3D palette: structure is a violet-grey ramp so the map reads as one surface,
 * and only the landmarks (crates, hazards, neon, team rooms) carry a hue. Every
 * entry has to stay separable from its neighbours at ~170px square.
 */
const MINIMAP_COLORS: Record<string, string> = {
  floorPlate: '#211c30',
  floorLight: '#2c2650',
  concrete: '#3e3a4e',
  wallLight: '#635d75',
  wallDark: '#191624',
  hull: '#312c44',
  trim: '#141220',
  grate: '#2d2a3d',
  crate: '#4b3418',
  crateAlt: '#1f3936',
  hazard: '#6b5a1d',
  neonCyan: '#1e5f6d',
  neonMagenta: '#6d1e58',
  neonAmber: '#6d4c1e',
  neonLime: '#3f6d1e',
  teamIon: '#50218a',
  teamEmber: '#7d3521',
  reactor: '#2a4d8c',
  conveyor: '#161520',
  asphalt: '#181622',
  cityWall: '#232030',
  sand: '#6a5c40',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
