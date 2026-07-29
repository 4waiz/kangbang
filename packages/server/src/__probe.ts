import { MatchPhase } from '@neon/shared';
import { BotController, botClassFor, botName } from './game/bots.js';
import { Match } from './game/match.js';
import { ServerPlayer, defaultLoadoutFor } from './game/player.js';

const match = new Match({ mode: 'tdm', map: 'neon_foundry' });
const bots: BotController[] = [];
for (let i = 0; i < 8; i++) {
  const id = match.allocateEntityId();
  const p = new ServerPlayer(id, `bot:${id}`, botName(i), defaultLoadoutFor(botClassFor(i)));
  p.bot = true;
  p.team = i % 2 === 0 ? 1 : 2;
  match.addPlayer(p);
  bots.push(new BotController(p, match.nav, 'hard', id * 7919 + i));
}

let now = Date.now();
const dt = 1 / 60;
match.begin(now);
console.log(`phase=${match.phase} players=${match.playerCount()} nav=${match.nav.nodes.length}`);

let shots = 0;
let hits = 0;
let deaths = 0;
const startPos = match.playerList().map((p) => ({ x: p.move.pos.x, z: p.move.pos.z }));

for (let tick = 0; tick < 60 * 25; tick++) {
  now += dt * 1000;
  for (const bot of bots) {
    const p = bot.player;
    p.pendingInputs.push(bot.think(match, dt, now));
  }
  match.step(dt, now);
  for (const ev of match.drainEvents()) {
    if (ev.t === 0) shots++;
    if (ev.t === 2) hits++;
    if (ev.t === 13) deaths++;
  }
  if (tick % 300 === 0) {
    const p0 = match.playerList()[0];
    console.log(
      `t=${(tick / 60).toFixed(1)}s shots=${shots} dmgEvents=${hits} deaths=${deaths} scores=${match.teamScores} ` +
        `p0 hp=${p0.health.toFixed(0)} ammo=${p0.weapon.ammo} reload=${p0.weapon.reloadTimer.toFixed(2)} ` +
        `pos=(${p0.move.pos.x.toFixed(1)},${p0.move.pos.y.toFixed(1)},${p0.move.pos.z.toFixed(1)}) alive=${p0.alive}`,
    );
  }
}

console.log('--- final ---');
for (const p of match.playerList()) {
  const i = match.playerList().indexOf(p);
  const moved = Math.hypot(p.move.pos.x - startPos[i].x, p.move.pos.z - startPos[i].z);
  console.log(
    `${p.name.padEnd(12)} team=${p.team} K=${p.kills} D=${p.deaths} score=${Math.round(p.score)} ` +
      `dmg=${Math.round(p.damageDealt)} shots=${p.weapons.reduce((s, w) => s + w.shotsFired, 0)} ` +
      `hits=${p.weapons.reduce((s, w) => s + w.shotsHit, 0)} ammo=${p.weapon.ammo}/${p.weapon.reserve} ` +
      `netMove=${moved.toFixed(1)}m dist=${p.distanceTravelled.toFixed(0)}m alive=${p.alive}`,
  );
}
console.log(`teamScores=${match.teamScores} phase=${match.phase} killFeed=${match.killFeed.length}`);
void MatchPhase;
