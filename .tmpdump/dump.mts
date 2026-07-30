import { WEAPONS, WEAPON_ORDER, CLASSES, CLASS_ORDER, MODES, MODE_ORDER, MAP_ORDER, getMap } from '../packages/shared/src/index.js';
console.log('=== WEAPONS ===');
for (const id of WEAPON_ORDER) { const w = WEAPONS[id] as any;
  console.log(JSON.stringify({ id, name: w.name, slot: w.slot, damage: w.damage, hs: w.headshotMultiplier, rpm: w.rpm, mag: w.magazine, reserve: w.reserve, reload: w.reloadTime, fs: w.falloffStart, fe: w.falloffEnd, minDmg: w.minDamage, pellets: w.pellets, fire: w.fireMode, ads: w.adsZoom, unlock: w.unlockLevel })); }
console.log('=== CLASSES ===');
for (const id of CLASS_ORDER) { const c = CLASSES[id] as any;
  console.log(JSON.stringify({ id, name: c.name, role: c.role, hp: c.health, shield: c.shield, speed: c.move.speedScale, unlock: c.unlockLevel, passive: c.passive.name, ability: c.ability.name, abilityCd: c.ability.cooldown, ult: c.ultimate.name, ultCd: c.ultimate.cooldown, loadout: c.defaultLoadout })); }
console.log('=== MODES ===');
for (const id of MODE_ORDER) { const m = MODES[id] as any;
  console.log(JSON.stringify({ id, name: m.name, teams: m.teams, score: m.scoreLimit, time: m.timeLimitSec, respawn: m.respawnDelay, rounds: m.roundsToWin, rotation: m.rotationSec, overtime: m.overtimeSec, desc: m.description })); }
console.log('=== MAPS ===');
for (const id of MAP_ORDER) { const m = getMap(id) as any;
  console.log(JSON.stringify({ id, name: m.name, tagline: m.tagline, brushes: m.brushes.length, spawns: m.spawns.length, pickups: m.pickups.length, modes: m.modes, bounds: m.bounds, killY: m.killY, sky: m.sky })); }
