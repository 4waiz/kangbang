/**
 * The authoritative match simulation.
 *
 * Everything that affects the outcome of a game happens here, driven by a fixed
 * timestep. Clients only ever send *intent* (an InputCommand); this file decides
 * what actually happened. In particular the server owns:
 *   - movement (re-simulated from the client's inputs with sanity checks)
 *   - all hit traces, damage and deaths
 *   - ammunition, reloads and fire rate
 *   - scoring, objectives, respawns and the match clock
 *
 * Nothing here trusts a client-reported hit, kill, position or damage number.
 */

import {
  ASSIST_WINDOW,
  BodyPart,
  Btn,
  CollisionWorld,
  DamageCause,
  EvType,
  FALL_DAMAGE_LETHAL_SPEED,
  FALL_DAMAGE_MAX,
  FALL_DAMAGE_MIN_SPEED,
  FIRE_RATE_TOLERANCE,
  MATCH_END_SECONDS,
  MAX_INPUTS_PER_TICK,
  MatchPhase,
  POSITION_DESYNC_LIMIT,
  POSITION_TELEPORT_LIMIT,
  RESPAWN_PROTECTION,
  SPEED_CHECK_TOLERANCE,
  Team,
  WARMUP_SECONDS,
  applySpread,
  buildNavGraph,
  clamp,
  computeDamage,
  createTraceOutcome,
  currentSpread,
  eyeHeightFor,
  explosionDamage,
  forwardFromAngles,
  getMap,
  getMode,
  hasBtn,
  hashSeed,
  maxTheoreticalSpeed,
  movementStep,
  shotInterval,
  traceShot,
  weaponIndex,
  worldLineOfSight,
  worldRaycast,
  type CustomMatchConfig,
  type HitTarget,
  type InputCommand,
  type KillFeedEntry,
  type MapDef,
  type MatchPhaseId,
  type MatchStatePayload,
  type ModeDef,
  type NavGraph,
  type ObjectiveState,
  type PickupDef,
  type WireEvent,
} from '@neon/shared';
import { config } from '../config.js';
import { createModeRules, type ModeRules, type ObjectiveRuntime } from './modes.js';
import { SLOT_MELEE, SLOT_PRIMARY, ServerPlayer } from './player.js';

// ---------------------------------------------------------------------------
// Runtime entities
// ---------------------------------------------------------------------------

export interface PickupRuntime {
  def: PickupDef;
  available: boolean;
  respawnTimer: number;
}

export interface Projectile {
  id: number;
  ownerId: number;
  team: number;
  weaponId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  radius: number;
  damage: number;
  directDamage: number;
  life: number;
  selfDamageScale: number;
}

export interface Deployable {
  id: number;
  ownerId: number;
  team: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  radius: number;
  health: number;
  maxHealth: number;
  life: number;
  /** Turret firing cooldown / field heal accumulator. */
  cooldown: number;
  power: number;
}

export interface MatchOptions {
  mode: string;
  map: string;
  custom?: Partial<CustomMatchConfig>;
  friendlyFire?: boolean;
}

const worldCache = new Map<string, { world: CollisionWorld; nav: NavGraph }>();

/** Compiling a map + nav graph takes ~50ms, so share it between rooms. */
export function getCompiledMap(mapId: string): { world: CollisionWorld; nav: NavGraph; def: MapDef } {
  let entry = worldCache.get(mapId);
  if (!entry) {
    const def = getMap(mapId);
    const world = new CollisionWorld(def);
    const nav = buildNavGraph(world, 2.0);
    entry = { world, nav };
    worldCache.set(mapId, entry);
  }
  return { ...entry, def: entry.world.def };
}

// ---------------------------------------------------------------------------

export class Match {
  readonly mode: ModeDef;
  readonly rules: ModeRules;
  readonly mapDef: MapDef;
  readonly world: CollisionWorld;
  readonly nav: NavGraph;

  phase: MatchPhaseId = MatchPhase.Warmup;
  tick = 0;
  timeRemaining = 0;
  teamScores: [number, number] = [0, 0];
  overtime = false;
  roundNumber = 1;
  roundResolved = false;
  roundIntermission = 0;
  winningTeam = -1;
  endTimer = 0;
  startedAtMs = 0;

  objectives: ObjectiveRuntime[] = [];
  pickups: PickupRuntime[] = [];
  projectiles: Projectile[] = [];
  deployables: Deployable[] = [];

  /** Drained by the room each snapshot. */
  events: WireEvent[] = [];
  killFeed: KillFeedEntry[] = [];
  notices: string[] = [];
  /** Set when the match ends so the room can push results exactly once. */
  resultsPending = false;

  private players = new Map<number, ServerPlayer>();
  private nextEntityId = 1;
  private spawnUsage = new Map<number, number>();
  private killFeedSeq = 1;
  private friendlyFire: boolean;
  private scoreLimit: number;
  private timeLimit: number;
  private respawnDelay: number;
  private hitTargets: HitTarget[] = [];
  private trace = createTraceOutcome();
  private spreadDir = { x: 0, y: 0, z: 0 };
  private aimDir = { x: 0, y: 0, z: 0 };

  constructor(opts: MatchOptions) {
    const baseModeId = opts.mode === 'custom' ? (opts.custom?.mode ?? 'tdm') : opts.mode;
    this.mode = getMode(baseModeId);
    this.rules = createModeRules(opts.mode, opts.custom?.mode);
    const compiled = getCompiledMap(opts.map);
    this.mapDef = compiled.def;
    this.world = compiled.world;
    this.nav = compiled.nav;

    this.scoreLimit = clamp(opts.custom?.scoreLimit ?? this.mode.scoreLimit, 1, 100000);
    this.timeLimit = clamp(opts.custom?.timeLimitSec ?? this.mode.timeLimitSec, 0, 3600);
    this.respawnDelay = clamp(opts.custom?.respawnDelay ?? this.mode.respawnDelay, 0, 30);
    this.friendlyFire = opts.friendlyFire ?? opts.custom?.friendlyFire ?? false;

    this.timeRemaining = WARMUP_SECONDS;
    this.resetPickups();
    this.objectives = this.rules.selectObjectives(this);
  }

  // ---------------------------------------------------------------------
  // Player registry
  // ---------------------------------------------------------------------

  allocateEntityId(): number {
    // Entity ids are u8 on the wire, so recycle within 1..250.
    for (let i = 0; i < 250; i++) {
      const id = ((this.nextEntityId + i - 1) % 250) + 1;
      if (!this.players.has(id)) {
        this.nextEntityId = (id % 250) + 1;
        return id;
      }
    }
    return 0;
  }

  addPlayer(p: ServerPlayer): void {
    this.players.set(p.id, p);
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (p) {
      // Drop anything they were carrying / had deployed.
      for (const core of this.objectives) {
        if (core.carrier === id) {
          core.carrier = -1;
          core.droppedFor = 12;
          core.atHome = false;
        }
      }
      this.deployables = this.deployables.filter((d) => d.ownerId !== id);
    }
    this.players.delete(id);
  }

  getPlayer(id: number): ServerPlayer | undefined {
    return this.players.get(id);
  }

  playerList(): ServerPlayer[] {
    return [...this.players.values()];
  }

  playerCount(): number {
    return this.players.size;
  }

  activePlayerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.spectating) n++;
    return n;
  }

  playersInZone(z: ObjectiveState, team: number): ServerPlayer[] {
    const out: ServerPlayer[] = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.team !== team) continue;
      const dx = p.move.pos.x - z.x;
      const dz = p.move.pos.z - z.z;
      const dy = p.move.pos.y - z.y;
      if (dx * dx + dz * dz <= z.radius * z.radius && dy > -4 && dy < 8) out.push(p);
    }
    return out;
  }

  addTeamScore(team: number, points: number): void {
    if (team === Team.Ion) this.teamScores[0] += points;
    else if (team === Team.Ember) this.teamScores[1] += points;
  }

  pushNotice(text: string): void {
    this.notices.push(text);
    if (this.notices.length > 8) this.notices.shift();
  }

  get effectiveScoreLimit(): number {
    return this.scoreLimit;
  }

  // ---------------------------------------------------------------------
  // Match flow
  // ---------------------------------------------------------------------

  begin(nowMs: number): void {
    this.phase = MatchPhase.Live;
    this.timeRemaining = this.mode.scoring === 'rounds' ? this.mode.roundTimeSec : this.timeLimit;
    this.teamScores = [0, 0];
    this.overtime = false;
    this.roundNumber = 1;
    this.roundResolved = false;
    this.winningTeam = -1;
    this.startedAtMs = nowMs;
    this.objectives = this.rules.selectObjectives(this);
    this.resetPickups();
    this.rules.onStart(this);
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.assists = 0;
      p.score = 0;
      p.objectiveScore = 0;
      p.streak = 0;
      p.longestStreak = 0;
      p.damageDealt = 0;
      p.headshots = 0;
      p.modeValue = 0;
      p.counters = {};
      p.distanceTravelled = 0;
      p.timeAliveSec = 0;
      for (const w of p.weapons) {
        w.shotsFired = 0;
        w.shotsHit = 0;
        w.headshots = 0;
        w.kills = 0;
        w.damage = 0;
        w.timeUsedSec = 0;
      }
      this.applyModeWeapon(p);
      if (!p.spectating) this.spawnPlayer(p, nowMs);
    }
    this.pushNotice('MATCH START');
  }

  /** Called by Elimination when one side is wiped. */
  resolveRound(winner: number): void {
    if (this.roundResolved) return;
    this.roundResolved = true;
    this.roundIntermission = 5;
    if (winner === Team.Ion || winner === Team.Ember) {
      this.addTeamScore(winner, this.mode.teamPoints.roundWin);
      for (const p of this.players.values()) {
        if (p.team === winner && !p.spectating) {
          p.addScore(this.mode.points.roundWin);
          p.bump('roundWins');
        }
      }
      this.pushNotice(`${winner === Team.Ion ? 'ION' : 'EMBER'} WINS ROUND ${this.roundNumber}`);
    } else {
      this.pushNotice(`ROUND ${this.roundNumber} DRAWN`);
    }
  }

  private startNextRound(nowMs: number): void {
    this.roundNumber++;
    this.roundResolved = false;
    this.timeRemaining = this.mode.roundTimeSec;
    this.resetPickups();
    this.projectiles.length = 0;
    this.deployables.length = 0;
    for (const p of this.players.values()) {
      if (p.spectating) continue;
      this.spawnPlayer(p, nowMs);
    }
    this.pushNotice(`ROUND ${this.roundNumber}`);
  }

  endMatch(): void {
    if (this.phase === MatchPhase.Ended) return;
    this.phase = MatchPhase.Ended;
    this.endTimer = MATCH_END_SECONDS;
    this.resultsPending = true;
    if (this.winningTeam < 0) {
      if (this.mode.teams === 2) {
        this.winningTeam =
          this.teamScores[0] > this.teamScores[1] ? Team.Ion : this.teamScores[1] > this.teamScores[0] ? Team.Ember : Team.None;
      } else {
        this.winningTeam = Team.None;
      }
    }
    this.pushNotice('MATCH OVER');
  }

  // ---------------------------------------------------------------------
  // Fixed step
  // ---------------------------------------------------------------------

  step(dt: number, nowMs: number): void {
    this.tick++;

    if (this.phase === MatchPhase.Warmup || this.phase === MatchPhase.Countdown) {
      this.timeRemaining = Math.max(0, this.timeRemaining - dt);
      // Warmup is fully playable: move, shoot, die and respawn. Nothing scores.
      // Respawns must run here or anyone who dies in warmup is stuck watching a
      // death screen until the match begins.
      this.simulatePlayers(dt, nowMs, false);
      this.stepProjectiles(dt, nowMs);
      this.stepPickups(dt, nowMs);
      this.stepRespawns(dt, nowMs);
      return;
    }

    if (this.phase === MatchPhase.Ended) {
      this.endTimer = Math.max(0, this.endTimer - dt);
      this.simulatePlayers(dt, nowMs, false);
      return;
    }

    // Round intermission for Elimination.
    if (this.roundResolved) {
      this.roundIntermission -= dt;
      this.simulatePlayers(dt, nowMs, false);
      if (this.roundIntermission <= 0) {
        const winner = this.rules.checkWin(this);
        if (winner >= 0) {
          this.winningTeam = winner;
          this.endMatch();
        } else {
          this.startNextRound(nowMs);
        }
      }
      return;
    }

    this.timeRemaining = Math.max(0, this.timeRemaining - dt);
    this.simulatePlayers(dt, nowMs, true);
    this.stepProjectiles(dt, nowMs);
    this.stepDeployables(dt, nowMs);
    this.stepPickups(dt, nowMs);
    this.rules.update(this, dt);
    this.stepRespawns(dt, nowMs);

    const winner = this.rules.checkWin(this);
    if (winner >= 0) {
      this.winningTeam = winner;
      this.endMatch();
      return;
    }

    if (this.timeLimit > 0 && this.timeRemaining <= 0 && this.mode.scoring !== 'rounds') {
      const next = this.rules.onTimeExpired(this);
      if (next === MatchPhase.Ended) this.endMatch();
      else this.phase = next;
    }
  }

  // ---------------------------------------------------------------------
  // Player simulation
  // ---------------------------------------------------------------------

  private simulatePlayers(dt: number, nowMs: number, scoring: boolean): void {
    this.refreshHitTargets();
    for (const p of this.players.values()) {
      p.tickTimers(dt, nowMs);
      if (p.spectating) continue;

      const inputs = p.pendingInputs;
      let processed = 0;
      while (inputs.length > 0 && processed < MAX_INPUTS_PER_TICK) {
        const cmd = inputs.shift() as InputCommand;
        this.applyInput(p, cmd, nowMs, scoring);
        p.lastProcessedSeq = cmd.seq;
        processed++;
      }
      if (processed === 0 && p.alive) {
        // No input arrived this tick: extrapolate with the last known intent so
        // the world keeps moving instead of freezing the player mid-air.
        this.applyInput(p, this.holdCommand(p), nowMs, scoring);
      }
      // Drop a backlog rather than letting a client bank inputs for a speed
      // advantage after a lag spike.
      if (inputs.length > MAX_INPUTS_PER_TICK * 4) {
        inputs.splice(0, inputs.length - MAX_INPUTS_PER_TICK * 2);
        p.flagSuspicion('input-flood', 2);
      }
      p.recordHistory(this.tick);
    }
  }

  private holdCommand(p: ServerPlayer): InputCommand {
    return {
      seq: p.lastProcessedSeq,
      dt: 1 / config.tickRate,
      moveX: 0,
      moveZ: 0,
      yaw: p.move.yaw,
      pitch: p.move.pitch,
      buttons: 0,
      slot: p.slot,
      shotSeed: 0,
    };
  }

  private applyInput(p: ServerPlayer, cmd: InputCommand, nowMs: number, scoring: boolean): void {
    if (!p.alive) return;

    // --- validate the command envelope ---------------------------------
    const dt = clamp(cmd.dt, 1 / 240, 1 / 20);
    if (!Number.isFinite(cmd.yaw) || !Number.isFinite(cmd.pitch)) {
      p.flagSuspicion('nan-angles', 10);
      return;
    }
    const beforeX = p.move.pos.x;
    const beforeY = p.move.pos.y;
    const beforeZ = p.move.pos.z;

    p.aiming = hasBtn(cmd.buttons, Btn.Aim) && p.weapon.def.slot !== 'melee';
    if (p.aiming) p.move.sliding = p.move.sliding && false;

    // Weapon slot switch.
    const wantSlot = clamp(cmd.slot | 0, 0, 2);
    if (wantSlot !== p.slot && p.pendingSlot !== wantSlot && this.mode.weaponRule === 'loadout') {
      p.requestSlot(wantSlot);
    }

    // --- movement -------------------------------------------------------
    const params = p.ctx.params;
    params.weaponSpeedScale = p.weapon.def.moveScale;
    params.adsSpeedScale = p.weapon.def.adsMoveScale;
    if (p.ultimate.activeFor > 0 && p.classDef.id === 'titan') params.speedScale = p.classDef.move.speedScale * 0.6;
    else if (p.ultimate.activeFor > 0 && p.classDef.id === 'vanguard') params.adsSpeedScale = 1;
    else params.speedScale = p.classDef.move.speedScale;

    const out = movementStep(this.world, p.move, cmd, p.ctx, dt);
    p.distanceTravelled += Math.hypot(p.move.pos.x - beforeX, p.move.pos.z - beforeZ);

    // Movement sanity: the cap is the class's theoretical maximum plus any
    // decaying allowance from an ability impulse, times a single tolerance for
    // float drift. Compounding two independent tolerances (as an earlier
    // version did) produced a 1.8x ceiling that a speed hack could hide inside.
    const speed = Math.hypot(p.move.vel.x, p.move.vel.z);
    const cap = (maxTheoreticalSpeed(params) + p.speedGrant) * SPEED_CHECK_TOLERANCE * config.antiCheat.moveTolerance;
    if (speed > cap) {
      const scale = cap / speed;
      p.move.vel.x *= scale;
      p.move.vel.z *= scale;
      p.flagSuspicion('speed', 3);
    }
    const stepDist = Math.hypot(p.move.pos.x - beforeX, p.move.pos.y - beforeY, p.move.pos.z - beforeZ);
    if (stepDist > POSITION_TELEPORT_LIMIT) {
      p.move.pos.x = beforeX;
      p.move.pos.y = beforeY;
      p.move.pos.z = beforeZ;
      p.move.vel.x = 0;
      p.move.vel.z = 0;
      p.flagSuspicion('teleport', 25);
    }

    // Landing / fall damage.
    if (out.landingSpeed > FALL_DAMAGE_MIN_SPEED && p.classDef.id !== 'phantom') {
      const t = clamp(
        (out.landingSpeed - FALL_DAMAGE_MIN_SPEED) / (FALL_DAMAGE_LETHAL_SPEED - FALL_DAMAGE_MIN_SPEED),
        0,
        1,
      );
      const dmg = Math.round(t * FALL_DAMAGE_MAX);
      if (dmg > 0) this.damagePlayer(p, null, dmg, DamageCause.Fall, null, p.weapon.def.id, nowMs, scoring, false);
    }
    if (out.landingSpeed > 3) {
      this.emit(EvType.Footstep, p.id, -1, p.move.pos.x, p.move.pos.y, p.move.pos.z, 0, 0, 1, surfaceIndex(out.groundSurface));
    }
    if (out.outOfBounds) {
      this.damagePlayer(p, null, 9999, DamageCause.OutOfBounds, null, p.weapon.def.id, nowMs, scoring, false);
      return;
    }

    // --- actions --------------------------------------------------------
    if (hasBtn(cmd.buttons, Btn.Reload)) p.startReload();
    if (hasBtn(cmd.buttons, Btn.Ability)) this.useAbility(p, nowMs, false);
    if (hasBtn(cmd.buttons, Btn.Ultimate)) this.useAbility(p, nowMs, true);
    if (hasBtn(cmd.buttons, Btn.Melee) && p.slot !== SLOT_MELEE) this.quickMelee(p, nowMs, scoring);
    if (hasBtn(cmd.buttons, Btn.Interact)) this.tryInteract(p, nowMs);

    const wantFire = hasBtn(cmd.buttons, Btn.Fire);
    const w = p.weapon;
    const semi = w.def.fireMode === 'single' || w.def.fireMode === 'bolt' || w.def.fireMode === 'pump';
    // Burst continuation fires without the trigger held.
    if (w.burstRemaining > 0 && w.burstTimer <= 0) {
      this.fireWeapon(p, cmd, nowMs, scoring);
    } else if (wantFire) {
      if (semi && p.lastFireHeld) {
        // Semi-auto requires a fresh trigger pull.
      } else {
        this.fireWeapon(p, cmd, nowMs, scoring);
      }
    } else if (w.ammo <= 0 && w.def.slot !== 'melee' && w.reserve > 0 && w.reloadTimer <= 0) {
      p.startReload();
    }
    p.lastFireHeld = wantFire;

    // Auto-reload when the magazine empties mid-trigger.
    if (w.ammo <= 0 && w.reserve > 0 && w.reloadTimer <= 0 && w.def.slot !== 'melee') p.startReload();
  }

  // ---------------------------------------------------------------------
  // Firing
  // ---------------------------------------------------------------------

  private fireWeapon(p: ServerPlayer, cmd: InputCommand, nowMs: number, scoring: boolean): void {
    const w = p.weapon;
    if (!p.canFire(nowMs)) {
      if (w.ammo <= 0 && w.def.slot !== 'melee' && w.cooldown <= 0 && w.reloadTimer <= 0) {
        this.emit(EvType.Reload, p.id, -1, p.move.pos.x, p.move.pos.y, p.move.pos.z, 0, 0, 0, 0);
      }
      return;
    }

    // Fire-rate validation: reject shots that arrive faster than the weapon can
    // cycle, allowing a small tolerance for jitter.
    const minInterval = shotInterval(w.def) * FIRE_RATE_TOLERANCE * 1000;
    const sinceLast = nowMs - w.lastShotMs;
    if (w.lastShotMs > 0 && sinceLast < minInterval && w.burstRemaining <= 0) {
      p.flagSuspicion('fire-rate', 4);
      return;
    }

    p.cancelReload();
    const shotIndex = p.consumeShot(nowMs);

    if (w.def.slot === 'melee' || w.def.projectile === 'none') {
      this.meleeAttack(p, w.def.meleeRange, w.def.damage, nowMs, scoring);
      return;
    }

    // Eye position and aim direction.
    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    forwardFromAngles(this.aimDir, cmd.yaw, cmd.pitch);

    const cone = currentSpread(w.def, {
      aiming: p.aiming && p.adsProgress > 0.6,
      crouching: p.move.crouching,
      onGround: p.move.onGround,
      speedRatio: Math.hypot(p.move.vel.x, p.move.vel.z) / 9.3,
      bloom: w.bloom,
    });
    const seed = (cmd.shotSeed ?? hashSeed(p.id, this.tick)) >>> 0;

    if (w.def.projectile === 'hitscan') {
      const pellets = Math.max(1, w.def.pellets);
      let anyHit = false;
      for (let i = 0; i < pellets; i++) {
        applySpread(this.aimDir.x, this.aimDir.y, this.aimDir.z, cone, seed, i, this.spreadDir);
        const t = traceShot(
          this.world,
          this.hitTargets,
          p.id,
          this.friendlyFire ? 0 : p.team,
          p.move.pos.x,
          eyeY,
          p.move.pos.z,
          this.spreadDir.x,
          this.spreadDir.y,
          this.spreadDir.z,
          w.def.range,
          this.trace,
        );
        this.emit(
          EvType.Shot,
          p.id,
          -1,
          t.endX,
          t.endY,
          t.endZ,
          cmd.yaw,
          cmd.pitch,
          weaponIndex(w.def.id) + 1,
          i,
        );
        if (t.targetId >= 0) {
          const target = this.players.get(t.targetId);
          if (target) {
            anyHit = true;
            const dmg = computeDamage(w.def, t.distance, t.part, {
              resistance: this.resistanceFor(target, DamageCause.Weapon),
              protected: target.protectionTimer > 0,
              backstab: false,
            });
            this.registerHit(p, target, dmg.amount, dmg.headshot, w.def.id, t.distance, t.wallbang, nowMs, scoring);
          }
        } else {
          this.emit(
            EvType.Impact,
            p.id,
            -1,
            t.endX,
            t.endY,
            t.endZ,
            Math.atan2(-t.nx, -t.nz),
            Math.asin(clamp(t.ny, -1, 1)),
            surfaceIndex(t.surface),
            weaponIndex(w.def.id) + 1,
          );
        }
        // Damage deployables in the path.
        this.damageDeployablesAlongRay(p, eyeY, w.def.damage * 0.6);
      }
      if (!anyHit) w.bloom = Math.min(w.def.spread.max, w.bloom);
    } else {
      applySpread(this.aimDir.x, this.aimDir.y, this.aimDir.z, cone, seed, 0, this.spreadDir);
      this.spawnProjectile(p, w.def.id, eyeY, this.spreadDir.x, this.spreadDir.y, this.spreadDir.z);
      this.emit(
        EvType.Shot,
        p.id,
        -1,
        p.move.pos.x,
        eyeY,
        p.move.pos.z,
        cmd.yaw,
        cmd.pitch,
        weaponIndex(w.def.id) + 1,
        0,
      );
    }
    void shotIndex;
  }

  private meleeAttack(p: ServerPlayer, range: number, baseDamage: number, nowMs: number, scoring: boolean): void {
    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    forwardFromAngles(this.aimDir, p.move.yaw, p.move.pitch);
    const t = traceShot(
      this.world,
      this.hitTargets,
      p.id,
      this.friendlyFire ? 0 : p.team,
      p.move.pos.x,
      eyeY,
      p.move.pos.z,
      this.aimDir.x,
      this.aimDir.y,
      this.aimDir.z,
      range,
      this.trace,
    );
    this.emit(EvType.Melee, p.id, t.targetId, t.endX, t.endY, t.endZ, p.move.yaw, p.move.pitch, 0, 0);
    if (t.targetId >= 0) {
      const target = this.players.get(t.targetId);
      if (target) {
        // Backstab: attacker is behind the target's facing.
        const dx = p.move.pos.x - target.move.pos.x;
        const dz = p.move.pos.z - target.move.pos.z;
        const fx = -Math.sin(target.move.yaw);
        const fz = -Math.cos(target.move.yaw);
        const behind = dx * fx + dz * fz < -0.35 * Math.hypot(dx, dz);
        const meleeDef = p.weapons[SLOT_MELEE].def;
        const dmg = computeDamage({ ...meleeDef, damage: baseDamage }, t.distance, t.part, {
          resistance: this.resistanceFor(target, DamageCause.Melee),
          protected: target.protectionTimer > 0,
          backstab: behind,
        });
        this.registerHit(p, target, dmg.amount, dmg.headshot, meleeDef.id, t.distance, false, nowMs, scoring, DamageCause.Melee);
      }
    }
  }

  /** V-key melee that does not require switching to the blade. */
  private quickMelee(p: ServerPlayer, nowMs: number, scoring: boolean): void {
    const melee = p.weapons[SLOT_MELEE];
    if (melee.cooldown > 0) return;
    melee.cooldown = melee.def.meleeSwingTime + 0.18;
    this.meleeAttack(p, melee.def.meleeRange * 0.85, melee.def.damage * 0.7, nowMs, scoring);
  }

  private registerHit(
    attacker: ServerPlayer,
    target: ServerPlayer,
    amount: number,
    headshot: boolean,
    weaponId: string,
    distance: number,
    wallbang: boolean,
    nowMs: number,
    scoring: boolean,
    cause: number = DamageCause.Weapon,
  ): void {
    const w = attacker.weapons.find((x) => x.def.id === weaponId) ?? attacker.weapon;
    w.shotsHit++;
    if (headshot) {
      w.headshots++;
      attacker.headshots++;
      attacker.bump('headshots');
    }
    this.damagePlayer(target, attacker, amount, cause, headshot ? BodyPart.Head : BodyPart.Torso, weaponId, nowMs, scoring, wallbang, distance);
  }

  // ---------------------------------------------------------------------
  // Damage
  // ---------------------------------------------------------------------

  damagePlayer(
    target: ServerPlayer,
    attacker: ServerPlayer | null,
    amount: number,
    cause: number,
    part: string | null,
    weaponId: string,
    nowMs: number,
    scoring: boolean,
    wallbang = false,
    distance = 0,
  ): void {
    if (!target.alive) return;
    if (target.protectionTimer > 0 && attacker) return;
    if (attacker && attacker !== target && !this.friendlyFire && attacker.team !== 0 && attacker.team === target.team) return;

    const dealt = Math.max(0, amount);
    if (dealt <= 0) return;

    // Overshield absorbs first, then shield, then health.
    let remaining = dealt;
    if (target.overshield > 0) {
      const used = Math.min(target.overshield, remaining);
      target.overshield -= used;
      remaining -= used;
    }
    if (remaining > 0 && target.shield > 0) {
      const used = Math.min(target.shield, remaining);
      target.shield -= used;
      remaining -= used;
    }
    if (remaining > 0) target.health -= remaining;

    target.lastDamagedAtMs = nowMs;
    if (target.cloaked) {
      target.cloaked = false;
      target.ability.activeFor = 0;
    }

    if (attacker && attacker !== target) {
      attacker.damageDealt += dealt;
      const w = attacker.weapons.find((x) => x.def.id === weaponId);
      if (w) w.damage += dealt;
      // Assist bookkeeping.
      const existing = target.recentDamage.find((d) => d.attackerId === attacker.id);
      if (existing) {
        existing.amount += dealt;
        existing.atMs = nowMs;
      } else {
        target.recentDamage.push({ attackerId: attacker.id, amount: dealt, atMs: nowMs });
      }
      this.emit(
        EvType.DamageDealt,
        attacker.id,
        target.id,
        target.move.pos.x,
        target.move.pos.y + 1.2,
        target.move.pos.z,
        0,
        0,
        Math.round(dealt),
        part === BodyPart.Head ? 1 : 0,
      );
    }
    this.emit(
      EvType.DamageTaken,
      attacker ? attacker.id : 0,
      target.id,
      attacker ? attacker.move.pos.x : target.move.pos.x,
      attacker ? attacker.move.pos.y + 1.2 : target.move.pos.y,
      attacker ? attacker.move.pos.z : target.move.pos.z,
      0,
      0,
      Math.round(dealt),
      cause,
    );

    if (target.health <= 0) {
      this.killPlayer(target, attacker, weaponId, cause, part === BodyPart.Head, wallbang, distance, nowMs, scoring);
    }
  }

  private killPlayer(
    victim: ServerPlayer,
    killer: ServerPlayer | null,
    weaponId: string,
    cause: number,
    headshot: boolean,
    wallbang: boolean,
    distance: number,
    nowMs: number,
    scoring: boolean,
  ): void {
    victim.health = 0;
    victim.die();
    victim.respawnTimer = this.respawnDelay;

    const assisters: ServerPlayer[] = [];
    const cutoff = nowMs - ASSIST_WINDOW * 1000;
    for (const d of victim.recentDamage) {
      if (d.atMs < cutoff) continue;
      if (killer && d.attackerId === killer.id) continue;
      const a = this.players.get(d.attackerId);
      if (a && a.team !== victim.team) assisters.push(a);
    }

    if (killer && killer !== victim) {
      killer.kills++;
      killer.streak++;
      killer.longestStreak = Math.max(killer.longestStreak, killer.streak);
      killer.bump('kills');
      if (headshot) killer.bump('headshots');
      const w = killer.weapons.find((x) => x.def.id === weaponId);
      if (w) w.kills++;

      // Contextual achievement counters.
      if (cause === DamageCause.Melee) killer.bump('meleeKills');
      if (distance > 60) killer.bump('longshotKills');
      if (wallbang) killer.bump('wallbangKills');
      if (killer.move.sliding) killer.bump('slideKills');
      if (!killer.move.onGround) killer.bump('airKills');
      if (weaponId === 'rail_sniper' && !killer.aiming) killer.bump('noscopeKills');
      if (cause === DamageCause.Ability || cause === DamageCause.Deployable) killer.bump('abilityKills');
      if (cause === DamageCause.Deployable) killer.bump('turretKills');
      if (killer.streak === 5) killer.bump('streak5');
      if (killer.streak === 10) killer.bump('streak10');
      killer.multiKillCount++;
      killer.multiKillWindowMs = 4000;
      if (killer.multiKillCount >= 2) killer.bump('multiKills');

      // Vanguard passive: eliminations refund ability charge.
      if (killer.classDef.passive.id === 'combat_momentum') {
        killer.ability.charge = Math.min(1, killer.ability.charge + 0.35);
        killer.lastDamagedAtMs = 0;
      }
      killer.ultimate.charge = Math.min(1, killer.ultimate.charge + 0.08);
    }
    for (const a of assisters) {
      a.assists++;
      a.bump('assists');
    }
    victim.bump('deaths');

    if (scoring) {
      this.rules.onKill(this, {
        killer,
        victim,
        assisters,
        headshot,
        weaponId,
        distance,
        wallbang,
      });
    }

    this.killFeed.push({
      id: this.killFeedSeq++,
      attacker: killer ? killer.name : '',
      attackerTeam: killer ? killer.team : 0,
      victim: victim.name,
      victimTeam: victim.team,
      weapon: weaponId,
      headshot,
      wallbang,
      cause: cause as KillFeedEntry['cause'],
      timeMs: nowMs,
    });
    if (this.killFeed.length > 32) this.killFeed.shift();

    this.emit(
      EvType.Kill,
      killer ? killer.id : 0,
      victim.id,
      victim.move.pos.x,
      victim.move.pos.y,
      victim.move.pos.z,
      victim.move.yaw,
      0,
      weaponIndex(weaponId) + 1,
      headshot ? 1 : 0,
    );
    this.emit(EvType.Death, victim.id, killer ? killer.id : 0, victim.move.pos.x, victim.move.pos.y, victim.move.pos.z, victim.move.yaw, 0, cause, 0);

    // Drop any carried core.
    for (const core of this.objectives) {
      if (core.carrier === victim.id) {
        core.carrier = -1;
        core.atHome = false;
        core.droppedFor = 12;
        core.x = victim.move.pos.x;
        core.y = victim.move.pos.y + 0.6;
        core.z = victim.move.pos.z;
      }
    }
  }

  private resistanceFor(target: ServerPlayer, cause: number): number {
    let r = 1;
    if (target.classDef.passive.id === 'braced' && (cause === DamageCause.Explosion || cause === DamageCause.Deployable)) {
      r *= 0.85;
    }
    return r;
  }

  // ---------------------------------------------------------------------
  // Abilities
  // ---------------------------------------------------------------------

  private useAbility(p: ServerPlayer, nowMs: number, ultimate: boolean): void {
    const a = ultimate ? p.ultimate : p.ability;
    if (!p.alive) return;
    if (a.charges <= 0 || a.useCooldown > 0) return;
    a.charges--;
    a.charge = 0;
    a.useCooldown = 0.4;
    a.activeFor = a.def.duration;

    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    forwardFromAngles(this.aimDir, p.move.yaw, p.move.pitch);

    switch (a.def.kind) {
      case 'dash': {
        const speed = a.def.power;
        const hasInput = Math.hypot(p.move.vel.x, p.move.vel.z) > 0.5;
        const dx = hasInput ? p.move.vel.x : this.aimDir.x;
        const dz = hasInput ? p.move.vel.z : this.aimDir.z;
        const len = Math.hypot(dx, dz) || 1;
        p.ctx.externalVelX = (dx / len) * speed;
        p.ctx.externalVelZ = (dz / len) * speed;
        p.ctx.externalVelY = 2.2;
        // Tell the speed check this burst is legitimate.
        p.speedGrant = Math.max(p.speedGrant, speed);
        break;
      }
      case 'cloak':
        p.cloaked = true;
        break;
      case 'overshield':
        p.overshield = a.def.power;
        break;
      case 'blink': {
        // Teleport along the view, stopping at the first wall.
        const hit = worldRaycast(
          this.world,
          p.move.pos.x,
          eyeY,
          p.move.pos.z,
          this.aimDir.x,
          this.aimDir.y,
          this.aimDir.z,
          a.def.power,
        );
        const d = Math.max(0, (hit.hit ? hit.t : a.def.power) - 0.6);
        p.move.pos.x += this.aimDir.x * d;
        p.move.pos.z += this.aimDir.z * d;
        p.move.pos.y += clamp(this.aimDir.y * d, -3, 3);
        break;
      }
      case 'scan': {
        for (const other of this.players.values()) {
          if (other.team === p.team && p.team !== 0) continue;
          if (other.id === p.id || !other.alive) continue;
          const dist = Math.hypot(other.move.pos.x - p.move.pos.x, other.move.pos.z - p.move.pos.z);
          if (dist <= a.def.radius) other.scannedUntilMs = nowMs + a.def.duration * 1000;
        }
        break;
      }
      case 'emp': {
        for (const other of this.players.values()) {
          if (other.team === p.team && p.team !== 0) continue;
          const dist = Math.hypot(other.move.pos.x - p.move.pos.x, other.move.pos.z - p.move.pos.z);
          if (dist <= a.def.radius) {
            other.empUntilMs = nowMs + a.def.duration * 1000;
            other.ability.charge = 0;
            other.ability.charges = 0;
          }
        }
        this.deployables = this.deployables.filter((d) => d.team === p.team || Math.hypot(d.x - p.move.pos.x, d.z - p.move.pos.z) > a.def.radius);
        break;
      }
      case 'barrier':
      case 'heal_field':
      case 'turret': {
        // Place in front of the player, dropped to the floor.
        const px = p.move.pos.x + this.aimDir.x * 2.2;
        const pz = p.move.pos.z + this.aimDir.z * 2.2;
        this.deployables.push({
          id: this.nextEntityId++ + 1000,
          ownerId: p.id,
          team: p.team,
          kind: a.def.kind,
          x: px,
          y: p.move.pos.y,
          z: pz,
          yaw: p.move.yaw,
          radius: a.def.radius,
          health: a.def.deployableHealth ?? 200,
          maxHealth: a.def.deployableHealth ?? 200,
          life: a.def.duration,
          cooldown: 0,
          power: a.def.power,
        });
        break;
      }
      default:
        break;
    }

    this.emit(
      EvType.AbilityUsed,
      p.id,
      -1,
      p.move.pos.x,
      p.move.pos.y,
      p.move.pos.z,
      p.move.yaw,
      p.move.pitch,
      ultimate ? 2 : 1,
      abilityIndex(a.def.kind),
    );
  }

  // ---------------------------------------------------------------------
  // Projectiles
  // ---------------------------------------------------------------------

  private spawnProjectile(p: ServerPlayer, weaponId: string, eyeY: number, dx: number, dy: number, dz: number): void {
    const w = p.weapons.find((x) => x.def.id === weaponId)?.def ?? p.weapon.def;
    this.projectiles.push({
      id: this.nextEntityId++ + 5000,
      ownerId: p.id,
      team: p.team,
      weaponId,
      x: p.move.pos.x + dx * 0.6,
      y: eyeY + dy * 0.6,
      z: p.move.pos.z + dz * 0.6,
      vx: dx * w.projectileSpeed,
      vy: dy * w.projectileSpeed,
      vz: dz * w.projectileSpeed,
      gravity: w.projectileGravity,
      radius: w.explosionRadius,
      damage: w.explosionDamage,
      directDamage: w.damage,
      life: 6,
      selfDamageScale: w.selfDamageScale,
    });
  }

  private stepProjectiles(dt: number, nowMs: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      pr.vy -= 26.5 * pr.gravity * dt;
      const nx = pr.x + pr.vx * dt;
      const ny = pr.y + pr.vy * dt;
      const nz = pr.z + pr.vz * dt;

      const dx = nx - pr.x;
      const dy = ny - pr.y;
      const dz = nz - pr.z;
      const len = Math.hypot(dx, dy, dz) || 1e-6;

      // World collision.
      const hit = worldRaycast(this.world, pr.x, pr.y, pr.z, dx / len, dy / len, dz / len, len);
      let detonateX = nx;
      let detonateY = ny;
      let detonateZ = nz;
      let detonate = false;

      if (hit.hit) {
        detonate = true;
        detonateX = pr.x + (dx / len) * hit.t;
        detonateY = pr.y + (dy / len) * hit.t;
        detonateZ = pr.z + (dz / len) * hit.t;
      } else {
        // Direct player hit.
        for (const target of this.players.values()) {
          if (!target.alive) continue;
          if (target.id === pr.ownerId) continue;
          if (!this.friendlyFire && target.team !== 0 && target.team === pr.team) continue;
          const d = pointSegmentDistance(target.move.pos.x, target.move.pos.y + target.move.height * 0.5, target.move.pos.z, pr.x, pr.y, pr.z, nx, ny, nz);
          if (d < target.radius + 0.35) {
            detonate = true;
            detonateX = target.move.pos.x;
            detonateY = target.move.pos.y + target.move.height * 0.5;
            detonateZ = target.move.pos.z;
            break;
          }
        }
      }

      pr.x = nx;
      pr.y = ny;
      pr.z = nz;

      if (pr.life <= 0 && !detonate) {
        detonate = true;
        detonateX = pr.x;
        detonateY = pr.y;
        detonateZ = pr.z;
      }

      if (detonate) {
        this.detonate(pr, detonateX, detonateY, detonateZ, nowMs);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private detonate(pr: Projectile, x: number, y: number, z: number, nowMs: number): void {
    this.emit(EvType.Explosion, pr.ownerId, -1, x, y, z, 0, 0, Math.round(pr.radius * 10), weaponIndex(pr.weaponId) + 1);
    const owner = this.players.get(pr.ownerId) ?? null;
    for (const target of this.players.values()) {
      if (!target.alive) continue;
      const cx = target.move.pos.x;
      const cy = target.move.pos.y + target.move.height * 0.5;
      const cz = target.move.pos.z;
      const dist = Math.hypot(cx - x, cy - y, cz - z);
      if (dist > pr.radius) continue;
      // Explosions do not travel through walls.
      if (!worldLineOfSight(this.world, { x, y, z }, { x: cx, y: cy, z: cz })) continue;
      let dmg = explosionDamage(pr.radius, pr.damage, dist);
      if (target.id === pr.ownerId) dmg *= pr.selfDamageScale;
      else if (!this.friendlyFire && target.team !== 0 && target.team === pr.team) continue;
      dmg *= this.resistanceFor(target, DamageCause.Explosion);
      if (dmg <= 0) continue;
      this.damagePlayer(target, owner, dmg, DamageCause.Explosion, null, pr.weaponId, nowMs, true, false, dist);
    }
    for (const d of this.deployables) {
      if (d.team === pr.team) continue;
      const dist = Math.hypot(d.x - x, d.y - y, d.z - z);
      if (dist <= pr.radius) d.health -= explosionDamage(pr.radius, pr.damage, dist);
    }
    this.deployables = this.deployables.filter((d) => d.health > 0);
  }

  // ---------------------------------------------------------------------
  // Deployables
  // ---------------------------------------------------------------------

  private stepDeployables(dt: number, nowMs: number): void {
    for (let i = this.deployables.length - 1; i >= 0; i--) {
      const d = this.deployables[i];
      d.life -= dt;
      d.cooldown = Math.max(0, d.cooldown - dt);
      const owner = this.players.get(d.ownerId);
      if (owner && owner.classDef.passive.id === 'field_repair' && d.health < d.maxHealth) {
        d.health = Math.min(d.maxHealth, d.health + 12 * dt);
      }
      if (d.life <= 0 || d.health <= 0) {
        this.deployables.splice(i, 1);
        continue;
      }

      if (d.kind === 'turret' && d.cooldown <= 0) {
        const target = this.findTurretTarget(d);
        if (target) {
          d.cooldown = 0.28;
          d.yaw = Math.atan2(-(target.move.pos.x - d.x), -(target.move.pos.z - d.z));
          this.emit(EvType.Shot, d.ownerId, target.id, target.move.pos.x, target.move.pos.y + 1.1, target.move.pos.z, d.yaw, 0, 0, 0);
          this.damagePlayer(target, owner ?? null, d.power, DamageCause.Deployable, null, 'sentry_turret', nowMs, true);
        }
      } else if (d.kind === 'heal_field') {
        for (const p of this.players.values()) {
          if (!p.alive || (p.team !== d.team && d.team !== 0)) continue;
          if (Math.hypot(p.move.pos.x - d.x, p.move.pos.z - d.z) > d.radius) continue;
          if (Math.abs(p.move.pos.y - d.y) > 4) continue;
          const healed = p.heal(d.power * dt);
          if (healed > 0 && owner && owner !== p) {
            owner.addScore(this.mode.points.heal * healed, true);
            owner.bump('healingDone', healed);
          }
        }
      }
    }
  }

  private findTurretTarget(d: Deployable): ServerPlayer | null {
    let best: ServerPlayer | null = null;
    let bestDist = d.radius;
    for (const p of this.players.values()) {
      if (!p.alive || p.cloaked) continue;
      if (p.team === d.team && d.team !== 0) continue;
      if (p.id === d.ownerId) continue;
      const dist = Math.hypot(p.move.pos.x - d.x, p.move.pos.z - d.z);
      if (dist >= bestDist) continue;
      if (!worldLineOfSight(this.world, { x: d.x, y: d.y + 0.8, z: d.z }, { x: p.move.pos.x, y: p.move.pos.y + 1.2, z: p.move.pos.z })) continue;
      best = p;
      bestDist = dist;
    }
    return best;
  }

  private damageDeployablesAlongRay(p: ServerPlayer, eyeY: number, damage: number): void {
    for (const d of this.deployables) {
      if (d.team === p.team && d.team !== 0) continue;
      const dist = Math.hypot(d.x - p.move.pos.x, d.z - p.move.pos.z);
      if (dist > 40) continue;
      const dirX = d.x - p.move.pos.x;
      const dirY = d.y + 0.8 - eyeY;
      const dirZ = d.z - p.move.pos.z;
      const len = Math.hypot(dirX, dirY, dirZ) || 1;
      const dot = (this.aimDir.x * dirX + this.aimDir.y * dirY + this.aimDir.z * dirZ) / len;
      if (dot < 0.985) continue;
      d.health -= damage;
    }
    this.deployables = this.deployables.filter((d) => d.health > 0);
  }

  /** Blocking test used by movement: barriers stop enemy bullets, not players. */
  barrierBlocks(team: number, x: number, y: number, z: number): boolean {
    for (const d of this.deployables) {
      if (d.kind !== 'barrier') continue;
      if (d.team === team) continue;
      if (Math.hypot(d.x - x, d.z - z) < d.radius && Math.abs(d.y + 1.5 - y) < 2.2) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Pickups
  // ---------------------------------------------------------------------

  private resetPickups(): void {
    this.pickups = this.mapDef.pickups.map((def) => ({ def, available: true, respawnTimer: 0 }));
  }

  private stepPickups(dt: number, nowMs: number): void {
    for (const pk of this.pickups) {
      if (!pk.available) {
        pk.respawnTimer -= dt;
        if (pk.respawnTimer <= 0) pk.available = true;
        continue;
      }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.move.pos.x - pk.def.p[0];
        const dy = p.move.pos.y + 0.9 - pk.def.p[1];
        const dz = p.move.pos.z - pk.def.p[2];
        if (dx * dx + dy * dy + dz * dz > 2.6 * 2.6) continue;
        if (this.collectPickup(p, pk, nowMs)) break;
      }
    }
  }

  private collectPickup(p: ServerPlayer, pk: PickupRuntime, nowMs: number): boolean {
    let taken = false;
    switch (pk.def.kind) {
      case 'health':
        if (p.health < p.maxHealth) {
          p.heal(pk.def.amount ?? 50);
          taken = true;
        }
        break;
      case 'shield':
        if (p.shield < p.maxShield) {
          p.addShield(pk.def.amount ?? 40);
          taken = true;
        }
        break;
      case 'ammo':
        taken = p.addAmmo(pk.def.amount ?? 1);
        break;
      case 'weapon': {
        if (this.mode.weaponRule !== 'loadout') break;
        const id = pk.def.weapon;
        if (!id) break;
        if (p.weapons[SLOT_PRIMARY].def.id === id) {
          taken = p.addAmmo(1);
        } else {
          p.setWeapon(SLOT_PRIMARY, id);
          p.requestSlot(SLOT_PRIMARY);
          taken = true;
        }
        break;
      }
      default:
        break;
    }
    if (taken) {
      pk.available = false;
      pk.respawnTimer = pk.def.respawnSec;
      p.bump('pickupsCollected');
      this.emit(EvType.Pickup, p.id, -1, pk.def.p[0], pk.def.p[1], pk.def.p[2], 0, 0, pickupKindIndex(pk.def.kind), 0);
      void nowMs;
    }
    return taken;
  }

  private tryInteract(p: ServerPlayer, nowMs: number): void {
    for (const pk of this.pickups) {
      if (!pk.available) continue;
      const dx = p.move.pos.x - pk.def.p[0];
      const dy = p.move.pos.y + 0.9 - pk.def.p[1];
      const dz = p.move.pos.z - pk.def.p[2];
      if (dx * dx + dy * dy + dz * dz > 3.2 * 3.2) continue;
      if (this.collectPickup(p, pk, nowMs)) return;
    }
  }

  // ---------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------

  private stepRespawns(dt: number, nowMs: number): void {
    for (const p of this.players.values()) {
      if (p.alive || p.spectating) continue;
      p.respawnTimer = Math.max(0, p.respawnTimer - dt);
      if (p.respawnTimer > 0) continue;
      if (!this.rules.canRespawn(this, p)) continue;
      this.spawnPlayer(p, nowMs);
    }
  }

  /** Public so the room can spawn a late joiner immediately. */
  spawnPlayer(p: ServerPlayer, nowMs: number): void {
    const spot = this.pickSpawn(p);
    this.applyModeWeapon(p);
    p.spawn(spot.x, spot.y, spot.z, spot.yaw, nowMs);
    p.protectionTimer = RESPAWN_PROTECTION;
    this.emit(EvType.Spawn, p.id, -1, spot.x, spot.y, spot.z, spot.yaw, 0, p.team, 0);
  }

  /**
   * Spawn selection: prefer points that are far from living enemies, not
   * recently used, and out of enemy line of sight.  This is what stops spawn
   * trapping without hard-coding per-map safe zones.
   */
  private pickSpawn(p: ServerPlayer): { x: number; y: number; z: number; yaw: number } {
    const teamMode = this.mode.teams === 2;
    const candidates = this.mapDef.spawns.filter((s) => (teamMode ? s.team === p.team : s.team === 0));
    const pool = candidates.length > 0 ? candidates : this.mapDef.spawns;

    const enemies = this.playerList().filter((o) => o.alive && o.id !== p.id && (!teamMode || o.team !== p.team));
    let best = pool[0];
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      const idx = this.mapDef.spawns.indexOf(s);
      let score = 0;
      let nearest = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.move.pos.x - s.p[0], e.move.pos.y - s.p[1], e.move.pos.z - s.p[2]);
        if (d < nearest) nearest = d;
        if (d < 12) score -= (12 - d) * 14;
        if (d < 28 && worldLineOfSight(this.world, { x: e.move.pos.x, y: e.move.pos.y + 1.4, z: e.move.pos.z }, { x: s.p[0], y: s.p[1] + 1.4, z: s.p[2] })) {
          score -= 90;
        }
      }
      score += Math.min(nearest, 45) * 2;
      const lastUsed = this.spawnUsage.get(idx) ?? -1e9;
      score -= Math.max(0, 240 - (this.tick - lastUsed)) * 0.35;
      // Small deterministic jitter so identical scores rotate.
      score += ((hashSeed(idx, this.tick) % 1000) / 1000) * 8;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const chosenIdx = this.mapDef.spawns.indexOf(best);
    this.spawnUsage.set(chosenIdx, this.tick);
    return { x: best.p[0], y: best.p[1], z: best.p[2], yaw: best.yaw };
  }

  /** Apply the mode's weapon rule (gun progression ladder). */
  applyModeWeapon(p: ServerPlayer): void {
    const override = this.rules.weaponOverride(this, p);
    if (!override) return;
    if (p.weapons[SLOT_PRIMARY].def.id !== override) {
      p.setWeapon(SLOT_PRIMARY, override);
    }
    p.slot = SLOT_PRIMARY;
    p.pendingSlot = -1;
  }

  promoteProgression(p: ServerPlayer): void {
    const override = this.rules.weaponOverride(this, p);
    if (!override) return;
    p.setWeapon(SLOT_PRIMARY, override);
    p.slot = SLOT_PRIMARY;
    p.pendingSlot = -1;
    p.equipTimer = p.weapons[SLOT_PRIMARY].def.equipTime;
  }

  // ---------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------

  private refreshHitTargets(): void {
    this.hitTargets.length = 0;
    for (const p of this.players.values()) {
      if (p.spectating) continue;
      this.hitTargets.push({
        id: p.id,
        x: p.move.pos.x,
        y: p.move.pos.y,
        z: p.move.pos.z,
        height: p.move.height,
        yaw: p.move.yaw,
        team: p.team,
        alive: p.alive,
        radius: p.radius,
      });
    }
  }

  matchState(nowMs: number): MatchStatePayload {
    return {
      phase: this.phase,
      mode: this.mode.id,
      map: this.mapDef.id,
      timeRemaining: Math.max(0, Math.round(this.timeRemaining * 10) / 10),
      scoreLimit: this.scoreLimit,
      teamScores: [Math.round(this.teamScores[0]), Math.round(this.teamScores[1])],
      objectives: this.objectives.map((o) => ({
        id: o.id,
        kind: o.kind,
        x: o.x,
        y: o.y,
        z: o.z,
        radius: o.radius,
        owner: o.owner,
        progress: Math.round(o.progress * 100) / 100,
        contestedBy: o.contestedBy,
        active: o.active,
        label: o.label,
        carrier: o.carrier,
        homeX: o.homeX,
        homeZ: o.homeZ,
      })),
      roundNumber: this.roundNumber,
      overtime: this.overtime,
      serverTimeMs: nowMs,
    };
  }

  emit(t: number, a: number, b: number, x: number, y: number, z: number, u: number, v: number, i: number, j: number): void {
    if (this.events.length >= 64) return;
    this.events.push({ t, a, b, x, y, z, u, v, i, j });
  }

  drainEvents(): WireEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const SURFACES = ['metal', 'concrete', 'glass', 'grate', 'energy', 'holo', 'panel', 'rubber', 'sand', 'flesh', 'air'];

export function surfaceIndex(surface: string): number {
  const i = SURFACES.indexOf(surface);
  return i < 0 ? 0 : i;
}

export function surfaceFromIndex(i: number): string {
  return SURFACES[i] ?? 'metal';
}

const ABILITIES = ['dash', 'cloak', 'overshield', 'barrier', 'scan', 'turret', 'heal_field', 'grapple', 'emp', 'blink'];

export function abilityIndex(kind: string): number {
  const i = ABILITIES.indexOf(kind);
  return i < 0 ? 0 : i;
}

export function abilityFromIndex(i: number): string {
  return ABILITIES[i] ?? 'dash';
}

const PICKUP_KINDS = ['weapon', 'ammo', 'health', 'shield'];

export function pickupKindIndex(kind: string): number {
  const i = PICKUP_KINDS.indexOf(kind);
  return i < 0 ? 0 : i;
}

/** Shortest distance from a point to a line segment, used for projectile hits. */
function pointSegmentDistance(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  const t = abLenSq > 0 ? clamp((apx * abx + apy * aby + apz * abz) / abLenSq, 0, 1) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

export { POSITION_DESYNC_LIMIT };
