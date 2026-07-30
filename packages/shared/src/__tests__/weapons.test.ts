/**
 * Weapon balance and maths tests.
 *
 * These assert the *design intent* of the arsenal, not just that the code runs.
 * A balance change that breaks a time-to-kill window or inverts the intended
 * range ordering will fail here, which is the point: the numbers in
 * data/weapons.ts are a design document and this file is its contract.
 */

import { describe, expect, it } from 'vitest';
import {
  BodyPart,
  CLASSES,
  CLASS_ORDER,
  PERKS,
  WEAPONS,
  WEAPON_ORDER,
  applyDamage,
  applyPerks,
  applySpread,
  computeDamage,
  currentSpread,
  damageAtRange,
  dps,
  effectiveHealth,
  explosionDamage,
  getWeapon,
  recoilForShot,
  shotInterval,
  shotsToKill,
  timeToKill,
  totalAmmo,
  weaponFromIndex,
  weaponIndex,
  weaponsInSlot,
} from '../index.js';

const VANGUARD_EHP = effectiveHealth(CLASSES.vanguard); // 125

describe('weapon catalogue', () => {
  it('has exactly the ten shipped weapons', () => {
    expect(WEAPON_ORDER).toHaveLength(10);
    expect(Object.keys(WEAPONS)).toHaveLength(10);
  });

  it('every weapon id round-trips through the protocol index', () => {
    for (const id of WEAPON_ORDER) {
      expect(weaponFromIndex(weaponIndex(id)).id).toBe(id);
    }
  });

  it('covers all three loadout slots', () => {
    expect(weaponsInSlot('primary').length).toBeGreaterThanOrEqual(6);
    expect(weaponsInSlot('secondary').length).toBeGreaterThanOrEqual(2);
    expect(weaponsInSlot('melee').length).toBeGreaterThanOrEqual(1);
  });

  it('every weapon has complete, sane data', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      expect(w.name.length, id).toBeGreaterThan(2);
      expect(w.short.length, id).toBeGreaterThan(1);
      expect(w.description.length, id).toBeGreaterThan(20);
      expect(w.damage, id).toBeGreaterThan(0);
      expect(w.rpm, id).toBeGreaterThan(0);
      expect(w.headshotMultiplier, id).toBeGreaterThanOrEqual(1);
      expect(w.falloffEnd, id).toBeGreaterThan(w.falloffStart);
      expect(w.damageMin, id).toBeLessThanOrEqual(w.damage);
      expect(w.range, id).toBeGreaterThan(0);
      expect(w.icon.length, id).toBeGreaterThan(0);
      expect(w.asset.length, id).toBeGreaterThan(0);
      expect(w.audio.fire.length, id).toBeGreaterThan(0);
      expect(w.perkSlots.length, id).toBeGreaterThan(0);
      expect(w.classes.length, id).toBeGreaterThan(0);
      // Every weapon must be usable by at least one real class.
      for (const cls of w.classes) expect(CLASS_ORDER, `${id} -> ${cls}`).toContain(cls);
      if (w.slot !== 'melee') {
        expect(w.magazine, id).toBeGreaterThan(0);
        expect(w.reserve, id).toBeGreaterThan(0);
        expect(w.reloadTime, id).toBeGreaterThan(0);
        expect(w.reloadTimeTactical, id).toBeLessThanOrEqual(w.reloadTime);
        expect(w.ammoPickup, id).toBeGreaterThan(0);
      }
    }
  });

  it('reports total ammo as magazine plus reserve', () => {
    expect(totalAmmo(WEAPONS.pulse_ar)).toBe(WEAPONS.pulse_ar.magazine + WEAPONS.pulse_ar.reserve);
  });

  it('throws on an unknown weapon rather than silently substituting one', () => {
    expect(() => getWeapon('not_a_weapon')).toThrow();
  });
});

describe('damage falloff', () => {
  it('is flat inside the falloff start', () => {
    const w = WEAPONS.pulse_ar;
    expect(damageAtRange(w, 0)).toBe(w.damage);
    expect(damageAtRange(w, w.falloffStart)).toBe(w.damage);
  });

  it('reaches the minimum at the falloff end and stays there', () => {
    const w = WEAPONS.pulse_ar;
    expect(damageAtRange(w, w.falloffEnd)).toBeCloseTo(w.damageMin, 5);
    expect(damageAtRange(w, w.falloffEnd * 4)).toBeCloseTo(w.damageMin, 5);
  });

  it('interpolates linearly between the two', () => {
    const w = WEAPONS.pulse_ar;
    const mid = (w.falloffStart + w.falloffEnd) / 2;
    expect(damageAtRange(w, mid)).toBeCloseTo((w.damage + w.damageMin) / 2, 5);
  });

  it('never increases with distance for any weapon', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      let previous = Infinity;
      for (let d = 0; d <= 250; d += 5) {
        const dmg = damageAtRange(w, d);
        expect(dmg, `${id} at ${d}m`).toBeLessThanOrEqual(previous + 1e-9);
        previous = dmg;
      }
    }
  });
});

describe('shots and time to kill', () => {
  it('the assault rifle needs five body shots on a Vanguard', () => {
    // 26 damage vs 125 effective health.
    expect(shotsToKill(WEAPONS.pulse_ar, VANGUARD_EHP)).toBe(5);
  });

  it('headshots always kill in fewer or equal shots', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      const body = shotsToKill(w, VANGUARD_EHP, false);
      const head = shotsToKill(w, VANGUARD_EHP, true);
      expect(head, id).toBeLessThanOrEqual(body);
    }
  });

  it('the rail sniper one-shots a headshot and never one-shots a Titan body', () => {
    const rail = WEAPONS.rail_sniper;
    expect(shotsToKill(rail, VANGUARD_EHP, true)).toBe(1);
    const titanEhp = effectiveHealth(CLASSES.titan); // 190
    expect(shotsToKill(rail, titanEhp, false)).toBeGreaterThan(1);
  });

  it('the shotgun kills in one point-blank shot and cannot at range', () => {
    const sg = WEAPONS.ion_shotgun;
    // 8 pellets x 15 = 120 at point blank, plus the eighth pellet margin.
    expect(shotsToKill(sg, 100, false, 0)).toBe(1);
    expect(shotsToKill(sg, VANGUARD_EHP, false, 30)).toBeGreaterThan(2);
  });

  it('every automatic weapon kills a Vanguard between 250ms and 1100ms', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (w.fireMode !== 'auto') continue;
      const ttk = timeToKill(w, VANGUARD_EHP) * 1000;
      expect(ttk, `${id} body TTK`).toBeGreaterThan(250);
      expect(ttk, `${id} body TTK`).toBeLessThan(1100);
    }
  });

  it('no weapon has an instant body-shot time to kill', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (w.slot === 'melee' || w.category === 'shotgun' || w.category === 'sniper') continue;
      expect(shotsToKill(w, VANGUARD_EHP), id).toBeGreaterThan(1);
    }
  });

  it('returns Infinity rather than dividing by zero for a zero-damage weapon', () => {
    const broken = { ...WEAPONS.pulse_ar, damage: 0, damageMin: 0 };
    expect(shotsToKill(broken, 100)).toBe(Infinity);
    expect(timeToKill(broken, 100)).toBe(Infinity);
  });
});

describe('DPS ordering matches design intent', () => {
  it('the SMG out-DPSes the assault rifle up close', () => {
    expect(dps(WEAPONS.plasma_smg)).toBeGreaterThan(dps(WEAPONS.pulse_ar));
  });

  it('the sniper has the lowest sustained DPS of the primaries', () => {
    const rail = dps(WEAPONS.rail_sniper);
    for (const id of ['pulse_ar', 'plasma_smg', 'particle_lmg', 'burst_carbine']) {
      expect(dps(WEAPONS[id]), id).toBeGreaterThan(rail);
    }
  });

  it('the pistol out-DPSes the revolver but loses per shot', () => {
    expect(dps(WEAPONS.energy_pistol)).toBeGreaterThan(dps(WEAPONS.tactical_revolver));
    expect(WEAPONS.tactical_revolver.damage).toBeGreaterThan(WEAPONS.energy_pistol.damage);
  });

  it('shot interval matches the stated rate of fire', () => {
    expect(shotInterval(WEAPONS.pulse_ar)).toBeCloseTo(60 / 660, 6);
  });
});

describe('range ordering matches design intent', () => {
  it('sniper > LMG > AR > SMG > shotgun on effective range', () => {
    const r = (id: string) => WEAPONS[id].falloffEnd;
    expect(r('rail_sniper')).toBeGreaterThan(r('particle_lmg'));
    expect(r('particle_lmg')).toBeGreaterThan(r('pulse_ar'));
    expect(r('pulse_ar')).toBeGreaterThan(r('plasma_smg'));
    expect(r('plasma_smg')).toBeGreaterThan(r('ion_shotgun'));
  });

  it('mobility is inversely ordered against firepower', () => {
    expect(WEAPONS.plasma_smg.moveScale).toBeGreaterThan(WEAPONS.pulse_ar.moveScale);
    expect(WEAPONS.pulse_ar.moveScale).toBeGreaterThan(WEAPONS.particle_lmg.moveScale);
    expect(WEAPONS.plasma_blade.moveScale).toBeGreaterThan(WEAPONS.plasma_smg.moveScale);
  });
});

describe('damage application', () => {
  it('shields absorb before health and overflow correctly', () => {
    const r = applyDamage(100, 25, 40);
    expect(r.shield).toBe(0);
    expect(r.absorbed).toBe(25);
    expect(r.health).toBe(85);
    expect(r.killed).toBe(false);
  });

  it('does not overkill health below zero', () => {
    const r = applyDamage(20, 0, 500);
    expect(r.health).toBe(0);
    expect(r.killed).toBe(true);
  });

  it('leaves health untouched while the shield holds', () => {
    const r = applyDamage(100, 50, 30);
    expect(r.health).toBe(100);
    expect(r.shield).toBe(20);
  });

  it('applies the headshot multiplier', () => {
    const w = WEAPONS.pulse_ar;
    const body = computeDamage(w, 0, BodyPart.Torso, { resistance: 1, protected: false, backstab: false });
    const head = computeDamage(w, 0, BodyPart.Head, { resistance: 1, protected: false, backstab: false });
    expect(head.headshot).toBe(true);
    expect(head.amount).toBeCloseTo(body.amount * w.headshotMultiplier, 4);
  });

  it('reduces limb damage below torso damage', () => {
    const w = WEAPONS.pulse_ar;
    const torso = computeDamage(w, 0, BodyPart.Torso, { resistance: 1, protected: false, backstab: false }).amount;
    const leg = computeDamage(w, 0, BodyPart.Leg, { resistance: 1, protected: false, backstab: false }).amount;
    expect(leg).toBeLessThan(torso);
  });

  it('spawn protection nullifies incoming damage', () => {
    const d = computeDamage(WEAPONS.rail_sniper, 0, BodyPart.Head, {
      resistance: 1,
      protected: true,
      backstab: false,
    });
    expect(d.amount).toBe(0);
  });

  it('applies the melee backstab multiplier', () => {
    const blade = WEAPONS.plasma_blade;
    const front = computeDamage(blade, 1, BodyPart.Torso, { resistance: 1, protected: false, backstab: false }).amount;
    const back = computeDamage(blade, 1, BodyPart.Torso, { resistance: 1, protected: false, backstab: true }).amount;
    expect(back).toBeCloseTo(front * blade.backstabMultiplier, 3);
    // A backstab must be lethal against a base-health target.
    expect(back).toBeGreaterThanOrEqual(100);
  });

  it('never returns less than one damage for a real hit', () => {
    const d = computeDamage(WEAPONS.ion_shotgun, 1000, BodyPart.Leg, {
      resistance: 0.1,
      protected: false,
      backstab: false,
    });
    expect(d.amount).toBeGreaterThanOrEqual(1);
  });
});

describe('explosions', () => {
  it('deal no damage outside the radius', () => {
    expect(explosionDamage(4, 80, 4)).toBe(0);
    expect(explosionDamage(4, 80, 10)).toBe(0);
  });

  it('deal full damage at the centre and less further out', () => {
    expect(explosionDamage(4, 80, 0)).toBeCloseTo(80, 5);
    expect(explosionDamage(4, 80, 2)).toBeLessThan(80);
    expect(explosionDamage(4, 80, 3)).toBeLessThan(explosionDamage(4, 80, 2));
  });

  it('keep a meaningful minimum at the rim so a near miss still matters', () => {
    expect(explosionDamage(4, 80, 3.9)).toBeGreaterThan(80 * 0.3);
  });
});

describe('spread', () => {
  it('is tighter while aiming than hip firing', () => {
    const w = WEAPONS.pulse_ar;
    const base = { crouching: false, onGround: true, speedRatio: 0, bloom: 0 };
    expect(currentSpread(w, { ...base, aiming: true })).toBeLessThan(currentSpread(w, { ...base, aiming: false }));
  });

  it('grows while moving and while airborne', () => {
    const w = WEAPONS.pulse_ar;
    const still = currentSpread(w, { aiming: false, crouching: false, onGround: true, speedRatio: 0, bloom: 0 });
    const moving = currentSpread(w, { aiming: false, crouching: false, onGround: true, speedRatio: 1, bloom: 0 });
    const air = currentSpread(w, { aiming: false, crouching: false, onGround: false, speedRatio: 1, bloom: 0 });
    expect(moving).toBeGreaterThan(still);
    expect(air).toBeGreaterThan(moving);
  });

  it('is tighter while crouching', () => {
    const w = WEAPONS.pulse_ar;
    const base = { aiming: false, onGround: true, speedRatio: 0, bloom: 0 };
    expect(currentSpread(w, { ...base, crouching: true })).toBeLessThan(currentSpread(w, { ...base, crouching: false }));
  });

  it('is deterministic for the same seed and pellet, so the server can verify it', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    applySpread(0, 0, -1, 0.05, 12345, 3, a);
    applySpread(0, 0, -1, 0.05, 12345, 3, b);
    expect(a).toEqual(b);
  });

  it('produces different directions for different pellets', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    applySpread(0, 0, -1, 0.05, 999, 0, a);
    applySpread(0, 0, -1, 0.05, 999, 1, b);
    expect(a).not.toEqual(b);
  });

  it('returns a unit vector and respects the cone angle', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let seed = 0; seed < 200; seed++) {
      applySpread(0, 0, -1, 0.05, seed, 0, out);
      const len = Math.hypot(out.x, out.y, out.z);
      expect(len).toBeCloseTo(1, 5);
      // Angle from the original direction must be within the cone.
      const dot = -out.z;
      expect(Math.acos(Math.min(1, dot))).toBeLessThanOrEqual(0.0501);
    }
  });

  it('passes the direction through unchanged at zero cone', () => {
    const out = { x: 0, y: 0, z: 0 };
    applySpread(0, 0, -1, 0, 1, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe('recoil', () => {
  it('kicks up on every shot', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (w.slot === 'melee') continue;
      expect(recoilForShot(w, 0, false).pitch, id).toBeGreaterThan(0);
    }
  });

  it('is reduced while aiming down sights', () => {
    const w = WEAPONS.pulse_ar;
    expect(recoilForShot(w, 0, true).pitch).toBeLessThan(recoilForShot(w, 0, false).pitch);
  });

  it('follows a repeatable horizontal pattern so sprays are learnable', () => {
    const w = WEAPONS.pulse_ar;
    const first = Array.from({ length: 10 }, (_, i) => recoilForShot(w, i, false).yaw);
    const second = Array.from({ length: 10 }, (_, i) => recoilForShot(w, i, false).yaw);
    expect(first).toEqual(second);
    // The pattern must actually move sideways, not just up.
    expect(first.some((v) => v !== 0)).toBe(true);
  });

  it('eases the vertical kick deeper into the spray', () => {
    const w = WEAPONS.pulse_ar;
    expect(recoilForShot(w, 20, false).pitch).toBeLessThan(recoilForShot(w, 0, false).pitch);
  });
});

describe('attachments are side-grades, never upgrades', () => {
  it('every perk has at least one downside', () => {
    for (const [id, perk] of Object.entries(PERKS)) {
      const mods = Object.entries(perk.mods);
      expect(mods.length, id).toBeGreaterThan(1);
      // A "downside" is any modifier that moves a stat the unhelpful way.
      const worse = mods.some(([key, value]) => {
        const v = value as number;
        const higherIsBetter = [
          'damage',
          'rpm',
          'magazine',
          'reserve',
          'moveScale',
          'adsMoveScale',
          'falloffStart',
          'falloffEnd',
          'range',
          'projectileSpeed',
          'explosionRadius',
        ];
        return higherIsBetter.includes(key) ? v < 1 : v > 1;
      });
      expect(worse, `${id} has no downside`).toBe(true);
    }
  });

  it('applies perks multiplicatively and caches the result', () => {
    const base = WEAPONS.pulse_ar;
    const modded = applyPerks(base, ['mag_extended']);
    expect(modded.magazine).toBe(Math.round(base.magazine * 1.4));
    expect(modded.reloadTime).toBeCloseTo(base.reloadTime * 1.14, 5);
    // Same inputs must return the identical cached object.
    expect(applyPerks(base, ['mag_extended'])).toBe(modded);
    // And the base must be untouched.
    expect(base.magazine).toBe(30);
  });

  it('ignores perks that do not fit the weapon', () => {
    const base = WEAPONS.energy_pistol;
    // The pistol has no bipod slot.
    expect(applyPerks(base, ['bipod_stabiliser'])).toBe(base);
  });

  it('only allows one perk per slot', () => {
    const base = WEAPONS.pulse_ar;
    const both = applyPerks(base, ['mag_extended', 'mag_fast']);
    // Whichever wins, the magazine cannot have had both applied.
    const bothApplied = Math.round(base.magazine * 1.4);
    expect(both.magazine === bothApplied || both.magazine === base.magazine).toBe(true);
    expect(both.magazine).not.toBe(Math.round(bothApplied * 1.4));
  });

  it('keeps falloffEnd above falloffStart after any perk combination', () => {
    for (const id of WEAPON_ORDER) {
      const base = WEAPONS[id];
      for (const perk of Object.keys(PERKS)) {
        const w = applyPerks(base, [perk]);
        expect(w.falloffEnd, `${id}+${perk}`).toBeGreaterThan(w.falloffStart);
        // Melee carries no magazine, so the floor only applies to the rest.
        if (w.slot !== 'melee') expect(w.magazine, `${id}+${perk}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
