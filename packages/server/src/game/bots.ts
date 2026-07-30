/**
 * Bot AI.
 *
 * Bots are ordinary ServerPlayers: they produce InputCommands and go through
 * exactly the same movement, firing and damage code as a human. That means a
 * bot cannot cheat, and any movement bug a bot hits is a bug a player hits too.
 *
 * Behaviour is a small state machine over the nav graph:
 *   idle -> roam -> engage -> reposition -> retreat
 * plus objective pressure from the mode.  Difficulty scales reaction time, aim
 * error, tracking speed, burst discipline and awareness radius - never health
 * or damage, so a hard bot is beatable by outplaying it.
 */

import {
  Btn,
  NavPathfinder,
  Rng,
  clamp,
  coverNodesNear,
  eyeHeightFor,
  forwardFromAngles,
  lerpAngle,
  nearestNode,
  pitchFromDirection,
  shotInterval,
  wrapAngle,
  worldLineOfSight,
  yawFromDirection,
  type InputCommand,
  type NavGraph,
} from '@kang/shared';
import type { Match } from './match.js';
import { SLOT_MELEE, SLOT_PRIMARY, SLOT_SECONDARY, type ServerPlayer } from './player.js';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

interface DifficultyProfile {
  /** Seconds before the bot reacts to a newly visible enemy. */
  reactionTime: number;
  /** Radians of steady-state aim error at 20m. */
  aimError: number;
  /** Turn rate towards the target, radians/sec. */
  turnRate: number;
  /** How much of the time it fires while on target. */
  triggerDiscipline: number;
  /** Awareness radius in metres for enemies not in the FOV. */
  awareness: number;
  /** Chance per second of strafing while engaging. */
  strafeRate: number;
  /** Chance the bot uses cover when hurt. */
  coverInstinct: number;
  /** Multiplier on how far it leads a moving target. */
  leadFactor: number;
  /** Probability of using an ability when it is available and useful. */
  abilityUse: number;
  /** Extra aim error while the target is moving fast. */
  trackingPenalty: number;
}

const PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: {
    reactionTime: 0.55,
    aimError: 0.055,
    turnRate: 3.2,
    triggerDiscipline: 0.55,
    awareness: 22,
    strafeRate: 0.3,
    coverInstinct: 0.25,
    leadFactor: 0.25,
    abilityUse: 0.2,
    trackingPenalty: 0.05,
  },
  normal: {
    reactionTime: 0.28,
    aimError: 0.026,
    turnRate: 6.5,
    triggerDiscipline: 0.8,
    awareness: 34,
    strafeRate: 0.6,
    coverInstinct: 0.55,
    leadFactor: 0.6,
    abilityUse: 0.5,
    trackingPenalty: 0.028,
  },
  hard: {
    reactionTime: 0.14,
    aimError: 0.011,
    turnRate: 10.5,
    triggerDiscipline: 0.94,
    awareness: 46,
    strafeRate: 0.85,
    coverInstinct: 0.8,
    leadFactor: 0.9,
    abilityUse: 0.85,
    trackingPenalty: 0.014,
  },
};

type BotState = 'roam' | 'engage' | 'reposition' | 'retreat' | 'objective';

export class BotController {
  private rng: Rng;
  private profile: DifficultyProfile;
  private pf: NavPathfinder;
  private path: number[] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  private state: BotState = 'roam';
  private stateTimer = 0;
  private targetId = -1;
  private targetVisibleFor = 0;
  private targetLostFor = 0;
  private lastSeenX = 0;
  private lastSeenY = 0;
  private lastSeenZ = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private fireHold = 0;
  private fireRest = 0;
  private seq = 1;
  private jumpCooldown = 0;
  private stuckTimer = 0;
  private lastX = 0;
  private lastZ = 0;
  private goalNode = -1;
  private coverBuf: number[] = [];
  private wanderTarget = -1;

  constructor(
    readonly player: ServerPlayer,
    private nav: NavGraph,
    difficulty: BotDifficulty,
    seed: number,
  ) {
    this.rng = new Rng(seed || 1);
    this.profile = PROFILES[difficulty] ?? PROFILES.normal;
    this.pf = new NavPathfinder(nav);
    this.aimYaw = player.move.yaw;
  }

  setDifficulty(d: BotDifficulty): void {
    this.profile = PROFILES[d] ?? PROFILES.normal;
  }

  /** Produce one input command for this tick. */
  think(match: Match, dt: number, nowMs: number): InputCommand {
    const p = this.player;
    this.repathTimer -= dt;
    this.stateTimer -= dt;
    this.strafeTimer -= dt;
    this.jumpCooldown -= dt;
    this.fireHold -= dt;
    this.fireRest -= dt;

    if (!p.alive) {
      this.state = 'roam';
      this.targetId = -1;
      this.path.length = 0;
      return this.command(0, 0, 0);
    }

    // --- perception ------------------------------------------------------
    const target = this.acquireTarget(match, dt);
    let buttons = 0;

    if (target) {
      this.targetLostFor = 0;
      this.lastSeenX = target.move.pos.x;
      this.lastSeenY = target.move.pos.y;
      this.lastSeenZ = target.move.pos.z;
      if (this.state !== 'engage' && this.state !== 'retreat') {
        this.state = 'engage';
        this.stateTimer = 2.5;
      }
    } else {
      this.targetLostFor += dt;
      this.targetVisibleFor = 0;
      if (this.state === 'engage' && this.targetLostFor > 1.6) {
        this.state = this.rng.bool(0.5) ? 'reposition' : 'roam';
        this.stateTimer = 3;
      }
    }

    // Retreat when badly hurt and cover is nearby.
    const healthFrac = (p.health + p.shield) / (p.maxHealth + p.maxShield);
    if (healthFrac < 0.32 && this.state !== 'retreat' && this.rng.bool(this.profile.coverInstinct * dt * 4)) {
      this.state = 'retreat';
      this.stateTimer = 3.5;
      this.pickCoverGoal(match);
    }
    if (this.state === 'retreat' && (healthFrac > 0.75 || this.stateTimer <= 0)) {
      this.state = target ? 'engage' : 'roam';
    }

    // --- weapon management ------------------------------------------------
    const w = p.weapon;
    const wantsReload = w.def.slot !== 'melee' && w.ammo === 0 && w.reserve > 0;
    if (wantsReload) buttons |= Btn.Reload;
    // Swap to the sidearm rather than reloading mid-fight.
    if (w.def.slot !== 'melee' && w.ammo === 0 && target && p.slot === SLOT_PRIMARY) {
      const sec = p.weapons[SLOT_SECONDARY];
      if (sec.ammo > 0) this.desiredSlot = SLOT_SECONDARY;
    } else if (p.weapons[SLOT_PRIMARY].ammo > 0 && p.slot !== SLOT_PRIMARY && !this.meleeRush(match, target)) {
      this.desiredSlot = SLOT_PRIMARY;
    }
    if (this.meleeRush(match, target)) this.desiredSlot = SLOT_MELEE;

    // --- aiming ----------------------------------------------------------
    if (target && this.targetVisibleFor >= this.profile.reactionTime) {
      this.aimAt(match, target, dt);
      const onTarget = this.isOnTarget(match, target);
      if (onTarget) {
        buttons |= this.triggerLogic(dt, target);
        if (this.shouldAim(target)) buttons |= Btn.Aim;
      }
      if (this.rng.bool(this.profile.abilityUse * dt * 0.6)) buttons |= Btn.Ability;
      if (this.rng.bool(this.profile.abilityUse * dt * 0.15)) buttons |= Btn.Ultimate;
    } else if (this.targetLostFor < 2.5 && (this.lastSeenX !== 0 || this.lastSeenZ !== 0)) {
      this.lookToward(this.lastSeenX, this.lastSeenY + 1.2, this.lastSeenZ, dt);
    } else {
      this.lookAlongPath(dt);
    }

    // --- movement --------------------------------------------------------
    const { moveX, moveZ, jump, sprint, crouch } = this.navigate(match, dt, target);
    if (jump && this.jumpCooldown <= 0) {
      buttons |= Btn.Jump;
      this.jumpCooldown = 0.35;
    }
    if (sprint) buttons |= Btn.Sprint;
    if (crouch) buttons |= Btn.Crouch;

    // Stuck detection: if we barely moved while trying to, jump and repath.
    const moved = Math.hypot(p.move.pos.x - this.lastX, p.move.pos.z - this.lastZ);
    this.lastX = p.move.pos.x;
    this.lastZ = p.move.pos.z;
    if ((moveX !== 0 || moveZ !== 0) && moved < 0.02) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.45) {
        buttons |= Btn.Jump;
        this.repathTimer = 0;
        this.goalNode = -1;
        this.stuckTimer = 0;
        this.strafeDir = -this.strafeDir;
      }
    } else {
      this.stuckTimer = 0;
    }

    void nowMs;
    return this.command(moveX, moveZ, buttons);
  }

  private desiredSlot = SLOT_PRIMARY;

  private command(moveX: number, moveZ: number, buttons: number): InputCommand {
    return {
      seq: this.seq++,
      dt: 1 / 60,
      moveX,
      moveZ,
      yaw: this.aimYaw,
      pitch: this.aimPitch,
      buttons,
      slot: this.desiredSlot,
      shotSeed: this.rng.int(0, 0x7fffffff),
    };
  }

  // ---------------------------------------------------------------------
  // Perception
  // ---------------------------------------------------------------------

  private acquireTarget(match: Match, dt: number): ServerPlayer | null {
    const p = this.player;
    const current = this.targetId >= 0 ? match.getPlayer(this.targetId) : undefined;
    if (current && this.canSee(match, current)) {
      this.targetVisibleFor += dt;
      return current;
    }

    let best: ServerPlayer | null = null;
    let bestScore = -Infinity;
    for (const other of match.playerList()) {
      if (other.id === p.id || !other.alive || other.spectating) continue;
      if (match.mode.teams === 2 && other.team === p.team) continue;
      if (other.protectionTimer > 0) continue;
      if (!this.canSee(match, other)) continue;
      const dist = Math.hypot(other.move.pos.x - p.move.pos.x, other.move.pos.z - p.move.pos.z);
      let score = 100 - dist;
      // Prefer wounded and closer enemies.
      score += (1 - (other.health + other.shield) / (other.maxHealth + other.maxShield)) * 30;
      if (other.id === this.targetId) score += 12;
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
    if (best) {
      if (best.id !== this.targetId) {
        this.targetId = best.id;
        this.targetVisibleFor = 0;
      } else {
        this.targetVisibleFor += dt;
      }
      return best;
    }
    this.targetId = -1;
    return null;
  }

  private canSee(match: Match, other: ServerPlayer): boolean {
    const p = this.player;
    if (!other.alive) return false;
    const dx = other.move.pos.x - p.move.pos.x;
    const dz = other.move.pos.z - p.move.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > this.profile.awareness) return false;
    // Cloaked enemies are only spotted very close.
    if (other.cloaked && dist > 6) return false;
    // Field of view: 200 degrees, generous so bots do not feel oblivious.
    const toYaw = yawFromDirection(dx, dz);
    const delta = Math.abs(wrapAngle(toYaw - p.move.yaw));
    if (delta > 1.75 && dist > 8) return false;
    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    return worldLineOfSight(
      match.world,
      { x: p.move.pos.x, y: eyeY, z: p.move.pos.z },
      { x: other.move.pos.x, y: other.move.pos.y + other.move.height * 0.75, z: other.move.pos.z },
    );
  }

  // ---------------------------------------------------------------------
  // Aiming
  // ---------------------------------------------------------------------

  private aimAt(match: Match, target: ServerPlayer, dt: number): void {
    const p = this.player;
    const w = p.weapon.def;
    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    const dist = Math.hypot(target.move.pos.x - p.move.pos.x, target.move.pos.z - p.move.pos.z);

    // Lead the target based on projectile speed (hitscan needs none).
    let lead = 0;
    if (w.projectileSpeed > 0) lead = (dist / w.projectileSpeed) * this.profile.leadFactor;
    else lead = Math.min(0.12, dist / 400) * this.profile.leadFactor;

    const tx = target.move.pos.x + target.move.vel.x * lead;
    const tz = target.move.pos.z + target.move.vel.z * lead;
    // Aim for the upper chest; harder bots creep towards the head.
    const headBias = this.profile.aimError < 0.02 ? 0.88 : 0.7;
    const ty = target.move.pos.y + target.move.height * headBias + target.move.vel.y * lead * 0.5;

    const dx = tx - p.move.pos.x;
    const dy = ty - eyeY;
    const dz = tz - p.move.pos.z;
    const wantYaw = yawFromDirection(dx, dz);
    const wantPitch = pitchFromDirection(dx, dy, dz);

    // Error scales with distance and target speed.
    const targetSpeed = Math.hypot(target.move.vel.x, target.move.vel.z);
    const err =
      this.profile.aimError * (0.5 + dist / 40) + this.profile.trackingPenalty * clamp(targetSpeed / 9, 0, 1.4);
    const jitterYaw = this.rng.bell() * err;
    const jitterPitch = this.rng.bell() * err * 0.6;

    const rate = this.profile.turnRate * dt;
    this.aimYaw = lerpAngle(this.aimYaw, wantYaw + jitterYaw, clamp(rate, 0, 1));
    this.aimPitch = clamp(
      this.aimPitch + clamp(wantPitch + jitterPitch - this.aimPitch, -rate, rate),
      -1.5,
      1.5,
    );
    void match;
  }

  private lookToward(x: number, y: number, z: number, dt: number): void {
    const p = this.player;
    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    const dx = x - p.move.pos.x;
    const dy = y - eyeY;
    const dz = z - p.move.pos.z;
    const rate = clamp(this.profile.turnRate * 0.6 * dt, 0, 1);
    this.aimYaw = lerpAngle(this.aimYaw, yawFromDirection(dx, dz), rate);
    this.aimPitch += clamp(pitchFromDirection(dx, dy, dz) - this.aimPitch, -rate, rate);
  }

  private lookAlongPath(dt: number): void {
    const node = this.currentWaypoint();
    if (node) {
      this.lookToward(node.x, node.y + 1.4, node.z, dt);
    } else {
      this.aimPitch += clamp(-this.aimPitch, -dt, dt);
    }
  }

  private isOnTarget(match: Match, target: ServerPlayer): boolean {
    const p = this.player;
    const eyeY = p.move.pos.y + eyeHeightFor(p.move.height);
    const dir = { x: 0, y: 0, z: 0 };
    forwardFromAngles(dir, this.aimYaw, this.aimPitch);
    const dx = target.move.pos.x - p.move.pos.x;
    const dy = target.move.pos.y + target.move.height * 0.6 - eyeY;
    const dz = target.move.pos.z - p.move.pos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dot = (dir.x * dx + dir.y * dy + dir.z * dz) / len;
    // Wider tolerance up close so shotguns and SMGs actually fire.
    const tolerance = len < 8 ? 0.93 : len < 25 ? 0.985 : 0.997;
    void match;
    return dot > tolerance;
  }

  private shouldAim(target: ServerPlayer): boolean {
    const w = this.player.weapon.def;
    if (w.slot === 'melee') return false;
    const dist = Math.hypot(target.move.pos.x - this.player.move.pos.x, target.move.pos.z - this.player.move.pos.z);
    if (w.scoped) return dist > 18;
    return dist > 14 && w.category !== 'shotgun';
  }

  /** Burst-fire discipline so bots do not hold the trigger forever. */
  private triggerLogic(dt: number, target: ServerPlayer): number {
    void dt;
    const w = this.player.weapon.def;
    if (this.fireRest > 0) return 0;
    if (this.fireHold <= 0) {
      if (!this.rng.bool(this.profile.triggerDiscipline)) {
        this.fireRest = 0.12;
        return 0;
      }
      // Longer bursts up close, tighter taps at range.
      const dist = Math.hypot(target.move.pos.x - this.player.move.pos.x, target.move.pos.z - this.player.move.pos.z);
      const shots = dist < 12 ? this.rng.int(5, 10) : dist < 28 ? this.rng.int(3, 6) : this.rng.int(1, 3);
      this.fireHold = shots * shotInterval(w);
      this.fireRest = this.fireHold + this.rng.range(0.12, 0.4);
    }
    return Btn.Fire;
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------

  private currentWaypoint(): { x: number; y: number; z: number } | null {
    if (this.pathIndex >= this.path.length) return null;
    const n = this.nav.nodes[this.path[this.pathIndex]];
    return n ? { x: n.x, y: n.y, z: n.z } : null;
  }

  private navigate(
    match: Match,
    dt: number,
    target: ServerPlayer | null,
  ): { moveX: number; moveZ: number; jump: boolean; sprint: boolean; crouch: boolean } {
    const p = this.player;
    let jump = false;
    let sprint = false;
    let crouch = false;

    // Decide where we want to be.
    if (this.repathTimer <= 0 || this.goalNode < 0) {
      this.repathTimer = 0.6 + this.rng.range(0, 0.4);
      this.chooseGoal(match, target);
    }

    // Engage behaviour: strafe and hold range instead of walking into the enemy.
    if (this.state === 'engage' && target) {
      const dx = target.move.pos.x - p.move.pos.x;
      const dz = target.move.pos.z - p.move.pos.z;
      const dist = Math.hypot(dx, dz);
      const w = p.weapon.def;
      const ideal = w.slot === 'melee' ? 1.4 : w.category === 'shotgun' ? 6 : w.scoped ? 30 : 15;
      const forward = clamp((dist - ideal) / 6, -1, 1);

      if (this.strafeTimer <= 0) {
        this.strafeTimer = this.rng.range(0.5, 1.4);
        if (this.rng.bool(this.profile.strafeRate)) this.strafeDir = this.rng.bool() ? 1 : -1;
        else this.strafeDir = 0;
      }
      // Convert world-space intent into the local move axes.
      const yaw = this.aimYaw;
      const moveZ = forward;
      const moveX = this.strafeDir * (this.profile.strafeRate > 0.5 ? 1 : 0.6);
      sprint = forward > 0.6 && dist > 20;
      if (dist < 4 && w.category === 'shotgun') crouch = false;
      if (this.rng.bool(0.4 * dt) && p.move.onGround && dist < 18) jump = true;
      void yaw;
      return { moveX, moveZ, jump, sprint, crouch };
    }

    // Path following.
    const wp = this.currentWaypoint();
    if (!wp) {
      this.goalNode = -1;
      return { moveX: 0, moveZ: 0, jump, sprint, crouch };
    }
    const dx = wp.x - p.move.pos.x;
    const dz = wp.z - p.move.pos.z;
    const distXZ = Math.hypot(dx, dz);
    const dy = wp.y - p.move.pos.y;

    if (distXZ < 1.1 && Math.abs(dy) < 1.6) {
      this.pathIndex++;
      const next = this.currentWaypoint();
      if (!next) this.goalNode = -1;
    }

    // Jump when the next waypoint is meaningfully above us.
    if (dy > 0.5 && distXZ < 2.4 && p.move.onGround) jump = true;

    // Steer in the direction of travel; the bot looks where it aims, which may
    // differ from where it walks, so convert to local axes.
    const yaw = this.aimYaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // Inverse of: dirX = ix*cos - iz*sin ; dirZ = -ix*sin - iz*cos
    const nx = distXZ > 1e-4 ? dx / distXZ : 0;
    const nz = distXZ > 1e-4 ? dz / distXZ : 0;
    const moveX = clamp(nx * cos - nz * sin, -1, 1);
    const moveZ = clamp(-nx * sin - nz * cos, -1, 1);
    sprint = this.state !== 'retreat' && distXZ > 4;
    return { moveX, moveZ, jump, sprint, crouch };
  }

  private chooseGoal(match: Match, target: ServerPlayer | null): void {
    const p = this.player;
    const from = nearestNode(this.nav, p.move.pos.x, p.move.pos.y, p.move.pos.z);
    if (from < 0) return;

    let goal = -1;
    if (this.state === 'retreat') {
      goal = this.goalNode >= 0 ? this.goalNode : this.pickCoverGoal(match);
    } else if (target) {
      goal = nearestNode(this.nav, target.move.pos.x, target.move.pos.y, target.move.pos.z);
    } else {
      goal = this.pickObjectiveOrWanderGoal(match);
    }
    if (goal < 0 || goal === from) {
      this.path.length = 0;
      this.pathIndex = 0;
      this.goalNode = -1;
      return;
    }
    this.goalNode = goal;
    if (this.pf.find(from, goal, this.path) === 0) {
      this.goalNode = -1;
      this.path.length = 0;
    }
    this.pathIndex = Math.min(1, this.path.length - 1);
    if (this.pathIndex < 0) this.pathIndex = 0;
  }

  private pickCoverGoal(match: Match): number {
    const p = this.player;
    coverNodesNear(this.nav, p.move.pos.x, p.move.pos.y, p.move.pos.z, 18, this.coverBuf, 8);
    if (this.coverBuf.length === 0) return -1;
    // Prefer cover away from the current threat.
    const threat = this.targetId >= 0 ? match.getPlayer(this.targetId) : undefined;
    let best = this.coverBuf[0];
    let bestScore = -Infinity;
    for (const id of this.coverBuf) {
      const n = this.nav.nodes[id];
      let score = n.coverScore * 20;
      if (threat) score += Math.hypot(n.x - threat.move.pos.x, n.z - threat.move.pos.z) * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    this.goalNode = best;
    return best;
  }

  private pickObjectiveOrWanderGoal(match: Match): number {
    const p = this.player;
    // Objective pressure: head for the nearest objective we do not own.
    const live = match.objectives.filter((o) => o.active);
    if (live.length > 0 && this.rng.bool(0.75)) {
      let best = live[0];
      let bestD = Infinity;
      for (const o of live) {
        if (match.mode.objectiveKind === 'zone' && o.owner === p.team) continue;
        if (match.mode.objectiveKind === 'core') {
          // Attack the enemy core, defend our own.
          const wantEnemy = o.team !== p.team;
          if (!wantEnemy && o.atHome) continue;
        }
        const d = Math.hypot(o.x - p.move.pos.x, o.z - p.move.pos.z);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      const node = nearestNode(this.nav, best.x, best.y, best.z);
      if (node >= 0) return node;
    }

    // Otherwise pick a distant nav node and go there, refreshing occasionally.
    if (this.wanderTarget >= 0 && this.rng.bool(0.7)) {
      const n = this.nav.nodes[this.wanderTarget];
      if (n && Math.hypot(n.x - p.move.pos.x, n.z - p.move.pos.z) > 5) return this.wanderTarget;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = this.rng.int(0, this.nav.nodes.length - 1);
      const n = this.nav.nodes[id];
      if (!n) continue;
      if (Math.hypot(n.x - p.move.pos.x, n.z - p.move.pos.z) < 12) continue;
      this.wanderTarget = id;
      return id;
    }
    return this.rng.int(0, this.nav.nodes.length - 1);
  }

  private meleeRush(match: Match, target: ServerPlayer | null): boolean {
    if (!target) return false;
    const p = this.player;
    if (p.weapons[SLOT_MELEE].def.slot !== 'melee') return false;
    const dist = Math.hypot(target.move.pos.x - p.move.pos.x, target.move.pos.z - p.move.pos.z);
    const primaryDry = p.weapons[SLOT_PRIMARY].ammo === 0 && p.weapons[SLOT_SECONDARY].ammo === 0;
    void match;
    return dist < 2.6 && (primaryDry || this.profile.aimError < 0.02);
  }
}

// ---------------------------------------------------------------------------
// Bot naming - original callsigns, no real-person or third-party names.
// ---------------------------------------------------------------------------

const BOT_PREFIX = [
  'NX',
  'VEX',
  'ORB',
  'ION',
  'ARC',
  'HEX',
  'RIG',
  'DAT',
  'SYN',
  'KRY',
  'PYX',
  'ZEN',
  'QUA',
  'LUM',
  'TAC',
  'VOL',
];
const BOT_SUFFIX = [
  'Drift',
  'Spike',
  'Cinder',
  'Static',
  'Vector',
  'Pulse',
  'Shard',
  'Relay',
  'Cascade',
  'Lattice',
  'Ember',
  'Quartz',
  'Halo',
  'Verge',
  'Flux',
  'Onyx',
];

export function botName(index: number, seed = 0): string {
  const a = BOT_PREFIX[(index + seed) % BOT_PREFIX.length];
  const b = BOT_SUFFIX[(index * 7 + seed * 3) % BOT_SUFFIX.length];
  return `${a}-${b}`;
}

export function botClassFor(index: number): string {
  const roster = ['vanguard', 'phantom', 'titan', 'warden', 'spectre', 'engineer'];
  return roster[index % roster.length];
}
