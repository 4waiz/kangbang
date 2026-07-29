/**
 * Game-mode framework.
 *
 * A mode is a small rules object hung off the shared ModeDef data. The match
 * simulation owns all the physics, combat and spawning; a mode only decides:
 *   - which objective anchors are live and how they tick
 *   - how a kill translates into score
 *   - what the win condition is
 *   - whether weapons are loadout-driven or dictated by the mode
 *
 * Adding a mode is a ModeDef entry plus (optionally) a subclass here.
 */

import {
  MatchPhase,
  Team,
  getMode,
  type MatchPhaseId,
  type ModeDef,
  type ObjectiveState,
} from '@neon/shared';
import type { Match } from './match.js';
import type { ServerPlayer } from './player.js';

export interface ObjectiveRuntime extends ObjectiveState {
  /** Capture accumulation per team, 0..1. */
  capture: [number, number];
  /** Live players of each team inside the radius this tick. */
  present: [number, number];
  /** Hardpoint rotation timer. */
  rotationTimer: number;
  /** For cores: home anchor + whether the core is at home. */
  atHome: boolean;
  /** Dropped core position when neither carried nor home. */
  droppedFor: number;
  order: number;
  team: number;
}

export interface KillContext {
  killer: ServerPlayer | null;
  victim: ServerPlayer;
  assisters: ServerPlayer[];
  headshot: boolean;
  weaponId: string;
  distance: number;
  wallbang: boolean;
}

export abstract class ModeRules {
  readonly def: ModeDef;

  constructor(modeId: string) {
    this.def = getMode(modeId);
  }

  /** Anchors this mode wants from the map. */
  abstract selectObjectives(match: Match): ObjectiveRuntime[];

  /** Called once when the match goes live. */
  onStart(match: Match): void {
    void match;
  }

  /** Fixed-step objective/score update. */
  update(match: Match, dt: number): void {
    void match;
    void dt;
  }

  /** Award score for a kill. Returns team points to add. */
  onKill(match: Match, ctx: KillContext): void {
    const p = this.def.points;
    if (ctx.killer && ctx.killer !== ctx.victim) {
      let points = p.kill;
      if (ctx.headshot) points += p.headshot;
      ctx.killer.addScore(points);
      for (const a of ctx.assisters) a.addScore(p.assist);
      if (this.def.teams === 2 && this.def.teamPoints.kill > 0 && ctx.killer.team !== ctx.victim.team) {
        match.addTeamScore(ctx.killer.team, this.def.teamPoints.kill);
      }
    } else {
      // Suicide or environmental death.
      ctx.victim.addScore(-Math.round(p.kill * 0.25));
    }
  }

  /** Weapon the player should be holding, or null to use their loadout. */
  weaponOverride(match: Match, player: ServerPlayer): string | null {
    void match;
    void player;
    return null;
  }

  /** Should this player be allowed to respawn right now? */
  canRespawn(match: Match, player: ServerPlayer): boolean {
    void player;
    return this.def.respawnEnabled && match.phase !== MatchPhase.Ended;
  }

  /** Winning team (1/2), 0 for a draw, or -1 when the match continues. */
  checkWin(match: Match): number {
    if (this.def.teams === 2) {
      if (match.teamScores[0] >= this.def.scoreLimit) return Team.Ion;
      if (match.teamScores[1] >= this.def.scoreLimit) return Team.Ember;
    } else {
      for (const p of match.playerList()) {
        if (p.spectating) continue;
        if (p.kills >= this.def.scoreLimit) return Team.None;
      }
    }
    return -1;
  }

  /** Leading player id for FFA, used for the results screen. */
  leader(match: Match): ServerPlayer | null {
    let best: ServerPlayer | null = null;
    for (const p of match.playerList()) {
      if (p.spectating) continue;
      if (!best || p.score > best.score) best = p;
    }
    return best;
  }

  /** Called when the timer expires. Returns the phase to move to. */
  onTimeExpired(match: Match): MatchPhaseId {
    if (this.def.overtimeSec > 0 && !match.overtime && this.isTied(match)) {
      match.overtime = true;
      match.timeRemaining = this.def.overtimeSec;
      return MatchPhase.Overtime;
    }
    return MatchPhase.Ended;
  }

  isTied(match: Match): boolean {
    if (this.def.teams === 2) return match.teamScores[0] === match.teamScores[1];
    const list = match.playerList().filter((p) => !p.spectating);
    if (list.length < 2) return false;
    const sorted = [...list].sort((a, b) => b.score - a.score);
    return sorted[0].score === sorted[1].score;
  }
}

// ---------------------------------------------------------------------------
// Deathmatch family
// ---------------------------------------------------------------------------

class DeathmatchRules extends ModeRules {
  override selectObjectives(): ObjectiveRuntime[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Zone control (Domination)
// ---------------------------------------------------------------------------

const CAPTURE_TIME = 6.5;

class ZoneRules extends ModeRules {
  private tickAccumulator = 0;

  override selectObjectives(match: Match): ObjectiveRuntime[] {
    return match.mapDef.objectives
      .filter((o) => o.kind === 'zone')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .slice(0, this.def.activeObjectives)
      .map((o) => makeRuntime(o, true));
  }

  override update(match: Match, dt: number): void {
    for (const z of match.objectives) {
      countPresence(match, z);
      const ion = z.present[0];
      const ember = z.present[1];
      const contesting = ion > 0 && ember > 0;
      z.contestedBy = contesting ? 3 : ion > 0 ? Team.Ion : ember > 0 ? Team.Ember : 0;

      if (!contesting && (ion > 0 || ember > 0)) {
        const team = ion > 0 ? Team.Ion : Team.Ember;
        const idx = team - 1;
        const rate = (1 / CAPTURE_TIME) * (1 + Math.min(2, z.present[idx] - 1) * 0.4);
        if (z.owner === team) {
          z.capture[idx] = 1;
          z.progress = 1;
        } else {
          // First neutralise the enemy's hold, then build your own.
          const other = 1 - idx;
          if (z.capture[other] > 0) {
            z.capture[other] = Math.max(0, z.capture[other] - rate * dt);
            z.progress = z.capture[other];
            if (z.capture[other] === 0) z.owner = Team.None;
          } else {
            z.capture[idx] = Math.min(1, z.capture[idx] + rate * dt);
            z.progress = z.capture[idx];
            if (z.capture[idx] >= 1) {
              z.owner = team;
              for (const p of match.playersInZone(z, team)) {
                p.addScore(this.def.points.objectiveCapture, true);
                p.bump('objectiveCaptures');
              }
              match.pushNotice(`${team === Team.Ion ? 'ION' : 'EMBER'} captured ${z.label}`);
            }
          }
        }
      }
    }

    // Score ticks once per second based on held zones.
    this.tickAccumulator += dt;
    while (this.tickAccumulator >= 1) {
      this.tickAccumulator -= 1;
      let ionHeld = 0;
      let emberHeld = 0;
      for (const z of match.objectives) {
        if (z.owner === Team.Ion) ionHeld++;
        else if (z.owner === Team.Ember) emberHeld++;
      }
      if (ionHeld > 0) match.addTeamScore(Team.Ion, ionHeld);
      if (emberHeld > 0) match.addTeamScore(Team.Ember, emberHeld);
      for (const p of match.playerList()) {
        if (!p.alive) continue;
        const inHeld = match.objectives.some((z) => z.owner === p.team && inRadius(p, z));
        if (inHeld) {
          p.addScore(this.def.points.objectiveTick, true);
          p.bump('objectiveTicks');
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hardpoint
// ---------------------------------------------------------------------------

class HardpointRules extends ModeRules {
  private tickAccumulator = 0;
  private rotationIndex = 0;
  private all: ObjectiveRuntime[] = [];

  override selectObjectives(match: Match): ObjectiveRuntime[] {
    this.all = match.mapDef.objectives
      .filter((o) => o.kind === 'hardpoint')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((o) => makeRuntime(o, false));
    this.rotationIndex = 0;
    if (this.all.length > 0) {
      this.all[0].active = true;
      this.all[0].rotationTimer = this.def.rotationSec;
    }
    return this.all;
  }

  override update(match: Match, dt: number): void {
    const active = this.all.find((o) => o.active);
    if (!active) return;

    countPresence(match, active);
    const ion = active.present[0];
    const ember = active.present[1];
    const contesting = ion > 0 && ember > 0;
    active.contestedBy = contesting ? 3 : ion > 0 ? Team.Ion : ember > 0 ? Team.Ember : 0;
    if (!contesting) {
      if (ion > 0) active.owner = Team.Ion;
      else if (ember > 0) active.owner = Team.Ember;
    }
    active.progress = contesting ? 0.5 : active.owner !== 0 ? 1 : 0;

    this.tickAccumulator += dt;
    while (this.tickAccumulator >= 1) {
      this.tickAccumulator -= 1;
      if (!contesting && active.owner !== Team.None) {
        match.addTeamScore(active.owner, this.def.teamPoints.tick);
        for (const p of match.playersInZone(active, active.owner)) {
          p.addScore(this.def.points.objectiveTick, true);
          p.bump('objectiveTicks');
        }
      }
    }

    active.rotationTimer -= dt;
    if (active.rotationTimer <= 0) {
      active.active = false;
      active.owner = Team.None;
      active.progress = 0;
      this.rotationIndex = (this.rotationIndex + 1) % this.all.length;
      const next = this.all[this.rotationIndex];
      next.active = true;
      next.owner = Team.None;
      next.progress = 0;
      next.rotationTimer = this.def.rotationSec;
      match.pushNotice(`HARDPOINT MOVED - ${next.label}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Capture the Core
// ---------------------------------------------------------------------------

const CORE_RETURN_SECONDS = 12;

class CoreRules extends ModeRules {
  override selectObjectives(match: Match): ObjectiveRuntime[] {
    return match.mapDef.objectives
      .filter((o) => o.kind === 'core')
      .map((o) => {
        const r = makeRuntime(o, true);
        r.atHome = true;
        r.homeX = o.p[0];
        r.homeZ = o.p[2];
        r.team = o.team ?? 0;
        return r;
      });
  }

  override update(match: Match, dt: number): void {
    for (const core of match.objectives) {
      const ownerTeam = core.team;
      const thiefTeam = ownerTeam === Team.Ion ? Team.Ember : Team.Ion;

      if (core.carrier >= 0) {
        const carrier = match.getPlayer(core.carrier);
        if (!carrier || !carrier.alive || carrier.team !== thiefTeam) {
          // Dropped.
          if (carrier) carrier.carryingCore = false;
          core.carrier = -1;
          core.droppedFor = CORE_RETURN_SECONDS;
          if (carrier) {
            core.x = carrier.move.pos.x;
            core.y = carrier.move.pos.y + 0.6;
            core.z = carrier.move.pos.z;
          }
          match.pushNotice(`${ownerTeam === Team.Ion ? 'ION' : 'EMBER'} CORE DROPPED`);
        } else {
          core.x = carrier.move.pos.x;
          core.y = carrier.move.pos.y + 1.1;
          core.z = carrier.move.pos.z;
          core.atHome = false;
          // Score when the carrier reaches their own reactor.
          const home = match.objectives.find((o) => o.team === thiefTeam);
          if (home && home.atHome && dist2(carrier.move.pos.x, carrier.move.pos.z, home.homeX ?? 0, home.homeZ ?? 0) < 3.2) {
            carrier.carryingCore = false;
            carrier.addScore(this.def.points.coreScore, true);
            carrier.bump('coreScores');
            match.addTeamScore(thiefTeam, this.def.teamPoints.coreScore);
            match.pushNotice(`${thiefTeam === Team.Ion ? 'ION' : 'EMBER'} SCORED A CORE`);
            resetCore(core);
          } else {
            carrier.addScore(this.def.points.coreCarry * dt, true);
          }
        }
      } else if (!core.atHome) {
        core.droppedFor -= dt;
        if (core.droppedFor <= 0) {
          resetCore(core);
          match.pushNotice(`${ownerTeam === Team.Ion ? 'ION' : 'EMBER'} CORE RETURNED`);
        } else {
          // Owner touching a dropped core returns it instantly.
          for (const p of match.playerList()) {
            if (!p.alive) continue;
            if (dist3(p, core) > 2.2) continue;
            if (p.team === ownerTeam) {
              resetCore(core);
              p.addScore(this.def.points.objectiveDefend, true);
              match.pushNotice(`${p.name} returned the core`);
              break;
            }
            if (p.team === thiefTeam) {
              core.carrier = p.id;
              p.carryingCore = true;
              break;
            }
          }
        }
      } else {
        // At home - can be stolen.
        for (const p of match.playerList()) {
          if (!p.alive || p.team !== thiefTeam) continue;
          if (dist3(p, core) > 2.4) continue;
          core.carrier = p.id;
          core.atHome = false;
          p.carryingCore = true;
          match.pushNotice(`${p.name} took the ${ownerTeam === Team.Ion ? 'ION' : 'EMBER'} core`);
          break;
        }
      }
      core.progress = core.carrier >= 0 ? 1 : core.atHome ? 0 : 1 - core.droppedFor / CORE_RETURN_SECONDS;
    }
  }

  override onKill(match: Match, ctx: KillContext): void {
    super.onKill(match, ctx);
    if (ctx.victim.carryingCore && ctx.killer) {
      ctx.killer.addScore(this.def.points.objectiveDefend, true);
    }
  }
}

function resetCore(core: ObjectiveRuntime): void {
  core.carrier = -1;
  core.atHome = true;
  core.droppedFor = 0;
  core.x = core.homeX ?? core.x;
  core.z = core.homeZ ?? core.z;
}

// ---------------------------------------------------------------------------
// Gun Progression
// ---------------------------------------------------------------------------

class ProgressionRules extends ModeRules {
  override selectObjectives(): ObjectiveRuntime[] {
    return [];
  }

  override onStart(match: Match): void {
    for (const p of match.playerList()) p.modeValue = 0;
  }

  override weaponOverride(match: Match, player: ServerPlayer): string | null {
    const ladder = this.def.ladder ?? [];
    if (ladder.length === 0) return null;
    const tier = Math.min(player.modeValue, ladder.length - 1);
    return ladder[tier];
  }

  override onKill(match: Match, ctx: KillContext): void {
    super.onKill(match, ctx);
    if (!ctx.killer || ctx.killer === ctx.victim) return;
    const ladder = this.def.ladder ?? [];
    // Only promote on a kill with the current tier's weapon (or melee).
    ctx.killer.modeValue = Math.min(ladder.length, ctx.killer.modeValue + 1);
    match.promoteProgression(ctx.killer);
    if (ctx.killer.modeValue >= ladder.length) {
      match.pushNotice(`${ctx.killer.name} reached the final tier`);
    }
  }

  override checkWin(match: Match): number {
    const ladder = this.def.ladder ?? [];
    for (const p of match.playerList()) {
      if (p.modeValue >= ladder.length) return Team.None;
    }
    return -1;
  }

  override leader(match: Match): ServerPlayer | null {
    let best: ServerPlayer | null = null;
    for (const p of match.playerList()) {
      if (p.spectating) continue;
      if (!best || p.modeValue > best.modeValue || (p.modeValue === best.modeValue && p.score > best.score)) best = p;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Elimination (round based, one life)
// ---------------------------------------------------------------------------

class EliminationRules extends ModeRules {
  override selectObjectives(): ObjectiveRuntime[] {
    return [];
  }

  override canRespawn(): boolean {
    return false;
  }

  override update(match: Match, dt: number): void {
    void dt;
    if (match.phase !== MatchPhase.Live && match.phase !== MatchPhase.Overtime) return;
    if (match.roundResolved) return;

    const ionAlive = match.playerList().filter((p) => p.team === Team.Ion && !p.spectating && p.alive).length;
    const emberAlive = match.playerList().filter((p) => p.team === Team.Ember && !p.spectating && p.alive).length;
    const ionTotal = match.playerList().filter((p) => p.team === Team.Ion && !p.spectating).length;
    const emberTotal = match.playerList().filter((p) => p.team === Team.Ember && !p.spectating).length;
    if (ionTotal === 0 || emberTotal === 0) return;

    if (ionAlive === 0 && emberAlive === 0) match.resolveRound(Team.None);
    else if (ionAlive === 0) match.resolveRound(Team.Ember);
    else if (emberAlive === 0) match.resolveRound(Team.Ion);
    else if (match.timeRemaining <= 0) {
      // Time out: more survivors wins the round.
      if (ionAlive > emberAlive) match.resolveRound(Team.Ion);
      else if (emberAlive > ionAlive) match.resolveRound(Team.Ember);
      else match.resolveRound(Team.None);
    }
  }

  override checkWin(match: Match): number {
    if (match.teamScores[0] >= this.def.roundsToWin) return Team.Ion;
    if (match.teamScores[1] >= this.def.roundsToWin) return Team.Ember;
    return -1;
  }

  override onTimeExpired(): MatchPhaseId {
    // Handled inside update() by resolveRound.
    return MatchPhase.Live;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createModeRules(modeId: string, customBase?: string): ModeRules {
  const id = modeId === 'custom' ? (customBase ?? 'tdm') : modeId;
  switch (getMode(id).scoring) {
    case 'zones':
      return new ZoneRules(id);
    case 'hardpoint':
      return new HardpointRules(id);
    case 'captures':
      return new CoreRules(id);
    case 'progression':
      return new ProgressionRules(id);
    case 'rounds':
      return new EliminationRules(id);
    case 'kills':
    case 'team-kills':
    default:
      return new DeathmatchRules(id);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeRuntime(
  o: { id: string; kind: ObjectiveState['kind']; p: [number, number, number]; radius: number; label: string; order?: number; team?: number },
  active: boolean,
): ObjectiveRuntime {
  return {
    id: o.id,
    kind: o.kind,
    x: o.p[0],
    y: o.p[1],
    z: o.p[2],
    radius: o.radius,
    owner: Team.None,
    progress: 0,
    contestedBy: 0,
    active,
    label: o.label,
    carrier: -1,
    capture: [0, 0],
    present: [0, 0],
    rotationTimer: 0,
    atHome: true,
    droppedFor: 0,
    order: o.order ?? 0,
    team: o.team ?? 0,
    homeX: o.p[0],
    homeZ: o.p[2],
  };
}

function inRadius(p: ServerPlayer, z: ObjectiveRuntime): boolean {
  const dx = p.move.pos.x - z.x;
  const dz = p.move.pos.z - z.z;
  const dy = p.move.pos.y - z.y;
  // Generous vertical band so multi-level zones still work.
  return dx * dx + dz * dz <= z.radius * z.radius && dy > -4 && dy < 8;
}

function countPresence(match: Match, z: ObjectiveRuntime): void {
  z.present[0] = 0;
  z.present[1] = 0;
  for (const p of match.playerList()) {
    if (!p.alive || p.spectating) continue;
    if (!inRadius(p, z)) continue;
    if (p.team === Team.Ion) z.present[0]++;
    else if (p.team === Team.Ember) z.present[1]++;
  }
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function dist3(p: ServerPlayer, o: ObjectiveRuntime): number {
  return Math.hypot(p.move.pos.x - o.x, p.move.pos.y - o.y, p.move.pos.z - o.z);
}

export { inRadius };
