"""
NEON STRIKE - weapon model generator.

Builds all ten weapons plus the first-person arms. Each weapon exports twice:

  wpn_<id>.glb        first-person view model, origin at the grip, muzzle
                      forward along -Z, with SOCKET_muzzle / SOCKET_eject /
                      SOCKET_grip empties
  wpn_<id>_world.glb  the pickup/third-person version: same mesh, recentred on
                      its own bounds so it can spin on a pedestal, and with the
                      view-model-only detail removed

Silhouette is the priority. At 96 degrees FOV with a weapon filling a fifth of
the screen, what reads is the outline and the emissive accents - so each weapon
gets a distinct profile (bullpup wedge, drum, bullbarrel, blade) rather than
being the same box with different greebles.

Run:  blender --background --factory-startup --python assets/scripts/gen_weapons.py
      (optionally  -- --only=pulse_ar )
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_neon as N  # noqa: E402


# ---------------------------------------------------------------------------
# Shared sub-assemblies
# ---------------------------------------------------------------------------


def pistol_grip(x=0.0, y=-0.055, z=0.075, scale=1.0, material=N.MAT_GRIP):
    """Angled grip. Every weapon's origin is the top of this."""
    parts = [
        N.box("grip", (x, y, z), (0.036 * scale, 0.105 * scale, 0.048 * scale), material, rotation=(-14, 0, 0)),
        N.box("grip_swell", (x, y - 0.035 * scale, z + 0.006), (0.040 * scale, 0.045 * scale, 0.036 * scale), material, rotation=(-14, 0, 0)),
    ]
    for i in range(3):
        parts.append(
            N.box(
                f"grip_line{i}",
                (x, y - 0.012 - i * 0.024 * scale, z + 0.024 * scale),
                (0.038 * scale, 0.006, 0.004),
                N.MAT_TRIM,
                rotation=(-14, 0, 0),
            )
        )
    return parts


def trigger_guard(z=0.03, scale=1.0):
    return [
        N.box("guard_front", (0.0, -0.028 * scale, z - 0.018), (0.026, 0.010, 0.030), N.MAT_TRIM),
        N.box("guard_bottom", (0.0, -0.046 * scale, z - 0.032), (0.026, 0.040, 0.010), N.MAT_TRIM),
        N.box("trigger", (0.0, -0.026 * scale, z - 0.026), (0.010, 0.026, 0.008), N.MAT_TRIM, rotation=(12, 0, 0)),
    ]


def magazine(z=0.03, depth=0.13, width=0.030, material=N.MAT_BODY_DARK, curve=0.0):
    parts = [
        N.box("mag", (0.0, -0.028 - depth / 2, z + 0.055), (width, depth, 0.052), material, rotation=(curve, 0, 0)),
        N.box("mag_base", (0.0, -0.030 - depth, z + 0.055), (width * 1.12, 0.016, 0.056), N.MAT_TRIM, rotation=(curve, 0, 0)),
    ]
    return parts


def iron_sights(front_z, rear_z, height=0.030, material=N.MAT_TRIM):
    return [
        N.box("sight_rear_l", (-0.013, height, rear_z), (0.006, 0.020, 0.010), material),
        N.box("sight_rear_r", (0.013, height, rear_z), (0.006, 0.020, 0.010), material),
        N.box("sight_front", (0.0, height + 0.004, front_z), (0.006, 0.026, 0.010), material),
        N.box("sight_front_hood", (0.0, height + 0.020, front_z), (0.020, 0.006, 0.012), material),
    ]


def rail(z_center, length, y=0.048, material=N.MAT_TRIM):
    parts = [N.box("rail", (0.0, y, z_center), (0.026, 0.008, length), material)]
    slots = max(3, int(length / 0.022))
    for i in range(slots):
        t = (i + 0.5) / slots
        parts.append(
            N.box(f"rail_slot{i}", (0.0, y + 0.006, z_center - length / 2 + t * length), (0.030, 0.006, 0.008), material)
        )
    return parts


def energy_cell(pos, size, material=N.MAT_CYAN):
    return [
        N.box("cell_glow", pos, size, material),
        N.box("cell_frame", pos, (size[0] * 1.15, size[1] * 0.5, size[2] * 1.1), N.MAT_TRIM),
    ]


def barrel_shroud(z_center, length, radius=0.020, vents=5, material=N.MAT_BODY):
    parts = [N.cylinder("shroud", (0.0, 0.012, z_center), radius, length, 8, material, axis="Z")]
    for i in range(vents):
        t = (i + 0.5) / vents
        zz = z_center - length / 2 + t * length
        parts.append(N.box(f"vent{i}", (0.0, 0.012, zz), (radius * 2.3, 0.006, 0.010), N.MAT_TRIM))
    return parts


# ---------------------------------------------------------------------------
# Weapons
# ---------------------------------------------------------------------------


def build_pulse_ar() -> list:
    """Balanced bullpup rifle: long top rail, angled receiver, cyan cell."""
    p = []
    p += pistol_grip()
    p += trigger_guard()
    # Receiver, tapering forward.
    p.append(N.box("receiver", (0.0, 0.010, -0.070), (0.070, 0.085, 0.260), N.MAT_BODY, taper=(0.86, 0.82)))
    p.append(N.box("receiver_top", (0.0, 0.052, -0.060), (0.052, 0.020, 0.230), N.MAT_BODY_DARK))
    p.append(N.box("cheek", (0.0, 0.048, 0.070), (0.046, 0.030, 0.090), N.MAT_BODY_DARK, rotation=(6, 0, 0)))
    p.append(N.box("buttplate", (0.0, 0.030, 0.120), (0.048, 0.070, 0.020), N.MAT_TRIM))
    # Handguard + barrel.
    p += barrel_shroud(-0.235, 0.130, 0.021, 4)
    p.append(N.cylinder("barrel", (0.0, 0.012, -0.330), 0.010, 0.075, 8, N.MAT_TRIM, axis="Z"))
    p.append(N.cylinder("muzzle_brake", (0.0, 0.012, -0.372), 0.016, 0.030, 8, N.MAT_BODY_DARK, axis="Z"))
    for i in range(3):
        p.append(N.box(f"brake_slot{i}", (0.0, 0.012, -0.364 + i * 0.010), (0.038, 0.008, 0.004), N.MAT_TRIM))
    # Energy cell on the left, magazine below.
    p += energy_cell((-0.036, 0.016, -0.030), (0.012, 0.046, 0.100))
    p += magazine(0.02, 0.125, 0.028)
    p += rail(-0.120, 0.190)
    p += iron_sights(-0.215, 0.030)
    p.append(N.box("foregrip", (0.0, -0.040, -0.215), (0.030, 0.062, 0.036), N.MAT_GRIP, rotation=(-8, 0, 0)))
    p.append(N.box("charge_handle", (0.034, 0.044, 0.010), (0.014, 0.012, 0.052), N.MAT_TRIM))
    return p


def build_plasma_smg() -> list:
    """Compact, wide, lime accents. Short profile reads as fast."""
    p = []
    p += pistol_grip(z=0.055, scale=0.92)
    p += trigger_guard(z=0.02, scale=0.9)
    p.append(N.box("body", (0.0, 0.014, -0.055), (0.062, 0.078, 0.190), N.MAT_BODY_LIGHT, taper=(0.9, 0.88)))
    p.append(N.box("body_top", (0.0, 0.050, -0.050), (0.044, 0.018, 0.170), N.MAT_BODY_DARK))
    p.append(N.box("stock_arm", (0.0, 0.030, 0.075), (0.024, 0.024, 0.070), N.MAT_TRIM))
    p.append(N.box("stock_plate", (0.0, 0.024, 0.112), (0.044, 0.058, 0.014), N.MAT_TRIM))
    p += barrel_shroud(-0.185, 0.100, 0.017, 4, N.MAT_BODY_LIGHT)
    p.append(N.cylinder("emitter", (0.0, 0.014, -0.248), 0.013, 0.040, 8, N.MAT_LIME, axis="Z", radius_top=0.019))
    p += energy_cell((0.0, -0.020, -0.100), (0.030, 0.026, 0.070), N.MAT_LIME)
    p += magazine(0.01, 0.115, 0.026, N.MAT_BODY_DARK, curve=-6)
    p += rail(-0.090, 0.140)
    p += iron_sights(-0.160, 0.020, 0.028)
    p.append(N.box("foregrip", (0.0, -0.036, -0.170), (0.026, 0.052, 0.030), N.MAT_GRIP, rotation=(-10, 0, 0)))
    return p


def build_rail_sniper() -> list:
    """Long, thin, with coil rings and a big scope. Unmistakable at a glance."""
    p = []
    p += pistol_grip(z=0.085, scale=1.02)
    p += trigger_guard(z=0.04)
    p.append(N.box("receiver", (0.0, 0.014, -0.090), (0.058, 0.080, 0.330), N.MAT_BODY_DARK, taper=(0.9, 0.86)))
    p.append(N.box("cheek_riser", (0.0, 0.056, 0.090), (0.044, 0.032, 0.130), N.MAT_BODY))
    p.append(N.box("buttplate", (0.0, 0.026, 0.165), (0.046, 0.090, 0.020), N.MAT_TRIM))
    p.append(N.box("thumbhole", (0.0, 0.016, 0.100), (0.020, 0.040, 0.060), N.MAT_TRIM))
    # Coil accelerator: rings down a long thin barrel.
    p.append(N.cylinder("rail_barrel", (0.0, 0.016, -0.400), 0.009, 0.300, 8, N.MAT_TRIM, axis="Z"))
    for i in range(6):
        zz = -0.290 - i * 0.048
        p.append(N.cylinder(f"coil{i}", (0.0, 0.016, zz), 0.024, 0.014, 8, N.MAT_BODY, axis="Z"))
        p.append(N.cylinder(f"coil_glow{i}", (0.0, 0.016, zz), 0.026, 0.005, 8, N.MAT_WHITE, axis="Z"))
    p.append(N.cylinder("rail_tip", (0.0, 0.016, -0.560), 0.014, 0.036, 8, N.MAT_BODY_DARK, axis="Z", radius_top=0.010))
    # Scope.
    p.append(N.cylinder("scope_tube", (0.0, 0.076, -0.100), 0.021, 0.220, 10, N.MAT_TRIM, axis="Z"))
    p.append(N.cylinder("scope_objective", (0.0, 0.076, -0.222), 0.030, 0.045, 10, N.MAT_BODY_DARK, axis="Z"))
    p.append(N.cylinder("scope_lens", (0.0, 0.076, -0.245), 0.027, 0.006, 10, N.MAT_GLASS, axis="Z"))
    p.append(N.cylinder("scope_eyepiece", (0.0, 0.076, 0.016), 0.026, 0.040, 10, N.MAT_BODY_DARK, axis="Z"))
    p.append(N.box("scope_mount_f", (0.0, 0.060, -0.170), (0.030, 0.024, 0.016), N.MAT_TRIM))
    p.append(N.box("scope_mount_r", (0.0, 0.060, -0.020), (0.030, 0.024, 0.016), N.MAT_TRIM))
    p.append(N.box("turret", (0.020, 0.090, -0.080), (0.014, 0.020, 0.020), N.MAT_TRIM))
    # Bipod + magazine.
    p.append(N.box("bipod_a", (-0.018, -0.040, -0.290), (0.008, 0.070, 0.008), N.MAT_TRIM, rotation=(0, 0, 16)))
    p.append(N.box("bipod_b", (0.018, -0.040, -0.290), (0.008, 0.070, 0.008), N.MAT_TRIM, rotation=(0, 0, -16)))
    p += magazine(0.03, 0.085, 0.026)
    p += energy_cell((-0.034, 0.020, -0.030), (0.010, 0.040, 0.080), N.MAT_WHITE)
    return p


def build_ion_shotgun() -> list:
    """Twin wide bores, pump under the barrel, heavy amber accents."""
    p = []
    p += pistol_grip(z=0.075)
    p += trigger_guard(z=0.035)
    p.append(N.box("receiver", (0.0, 0.014, -0.070), (0.078, 0.090, 0.230), N.MAT_BODY, taper=(0.92, 0.9)))
    p.append(N.box("stock", (0.0, 0.032, 0.100), (0.050, 0.070, 0.110), N.MAT_BODY_DARK, rotation=(5, 0, 0)))
    p.append(N.box("buttplate", (0.0, 0.026, 0.158), (0.052, 0.086, 0.018), N.MAT_RUBBER))
    # Twin bores.
    for sx in (-0.021, 0.021):
        p.append(N.cylinder("bore", (sx, 0.020, -0.270), 0.019, 0.230, 8, N.MAT_TRIM, axis="Z"))
        p.append(N.cylinder("choke", (sx, 0.020, -0.392), 0.023, 0.028, 8, N.MAT_BODY_DARK, axis="Z"))
        p.append(N.cylinder("bore_glow", (sx, 0.020, -0.404), 0.016, 0.006, 8, N.MAT_AMBER, axis="Z"))
    p.append(N.box("bore_bridge", (0.0, 0.020, -0.270), (0.052, 0.014, 0.220), N.MAT_BODY))
    # Pump.
    p.append(N.cylinder("pump", (0.0, -0.024, -0.235), 0.026, 0.090, 8, N.MAT_GRIP, axis="Z"))
    p.append(N.box("pump_rail", (0.0, -0.024, -0.170), (0.020, 0.018, 0.090), N.MAT_TRIM))
    for i in range(4):
        p.append(N.cylinder(f"pump_ridge{i}", (0.0, -0.024, -0.268 + i * 0.022), 0.029, 0.006, 8, N.MAT_TRIM, axis="Z"))
    # Shell tube + ejector.
    p.append(N.cylinder("tube", (0.0, -0.006, -0.190), 0.017, 0.180, 8, N.MAT_BODY_DARK, axis="Z"))
    p.append(N.box("ejector", (0.040, 0.020, -0.040), (0.014, 0.036, 0.070), N.MAT_TRIM))
    p += iron_sights(-0.340, 0.020, 0.040)
    p += energy_cell((0.0, 0.058, -0.050), (0.036, 0.020, 0.080), N.MAT_AMBER)
    return p


def build_particle_lmg() -> list:
    """Biggest silhouette: drum, heat shroud, carry handle, bipod."""
    p = []
    p += pistol_grip(z=0.095, scale=1.08)
    p += trigger_guard(z=0.05)
    p.append(N.box("receiver", (0.0, 0.018, -0.080), (0.092, 0.110, 0.300), N.MAT_BODY, taper=(0.88, 0.86)))
    p.append(N.box("stock", (0.0, 0.036, 0.120), (0.056, 0.084, 0.130), N.MAT_BODY_DARK))
    p.append(N.box("buttplate", (0.0, 0.030, 0.190), (0.058, 0.100, 0.020), N.MAT_RUBBER))
    p.append(N.box("carry_handle", (0.0, 0.086, -0.040), (0.024, 0.030, 0.150), N.MAT_TRIM))
    p.append(N.box("handle_top", (0.0, 0.104, -0.040), (0.036, 0.014, 0.160), N.MAT_TRIM))
    # Heat shroud with big vents.
    p.append(N.cylinder("shroud", (0.0, 0.020, -0.310), 0.032, 0.200, 10, N.MAT_BODY_DARK, axis="Z"))
    for i in range(6):
        zz = -0.400 + i * 0.034
        p.append(N.box(f"vent{i}", (0.0, 0.020, zz), (0.072, 0.010, 0.018), N.MAT_TRIM))
        p.append(N.box(f"vent_glow{i}", (0.0, 0.020, zz), (0.074, 0.005, 0.010), N.MAT_AMBER))
    p.append(N.cylinder("barrel", (0.0, 0.020, -0.440), 0.014, 0.090, 8, N.MAT_TRIM, axis="Z"))
    p.append(N.cylinder("brake", (0.0, 0.020, -0.494), 0.024, 0.040, 8, N.MAT_BODY_DARK, axis="Z", radius_top=0.028))
    # Drum magazine.
    p.append(N.cylinder("drum", (0.0, -0.086, -0.030), 0.072, 0.052, 12, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("drum_face", (0.0, -0.114, -0.030), 0.056, 0.008, 12, N.MAT_TRIM, axis="Y"))
    p.append(N.cylinder("drum_core", (0.0, -0.116, -0.030), 0.024, 0.008, 10, N.MAT_AMBER, axis="Y"))
    p.append(N.box("feed_neck", (0.0, -0.040, -0.030), (0.040, 0.050, 0.062), N.MAT_BODY))
    # Bipod.
    for sx, rot in ((-0.026, 20), (0.026, -20)):
        p.append(N.box("bipod_leg", (sx, -0.058, -0.330), (0.010, 0.100, 0.010), N.MAT_TRIM, rotation=(0, 0, rot)))
        p.append(N.box("bipod_foot", (sx * 1.9, -0.106, -0.330), (0.024, 0.008, 0.014), N.MAT_TRIM))
    p += rail(-0.150, 0.140, 0.070)
    return p


def build_burst_carbine() -> list:
    """Tidy, angular, violet accents. Straight lines, prominent optic."""
    p = []
    p += pistol_grip(z=0.070)
    p += trigger_guard(z=0.032)
    p.append(N.box("receiver", (0.0, 0.014, -0.080), (0.064, 0.082, 0.250), N.MAT_BODY_LIGHT))
    p.append(N.box("upper", (0.0, 0.052, -0.075), (0.048, 0.026, 0.240), N.MAT_BODY_DARK))
    p.append(N.box("stock_tube", (0.0, 0.030, 0.080), (0.026, 0.026, 0.080), N.MAT_TRIM))
    p.append(N.box("stock", (0.0, 0.026, 0.125), (0.046, 0.062, 0.036), N.MAT_BODY_DARK, rotation=(4, 0, 0)))
    p.append(N.box("handguard", (0.0, 0.016, -0.245), (0.052, 0.056, 0.140), N.MAT_BODY_LIGHT, taper=(0.9, 0.9)))
    for i in range(4):
        p.append(N.box(f"hg_slot{i}", (0.0, -0.014, -0.300 + i * 0.030), (0.056, 0.010, 0.014), N.MAT_TRIM))
    p.append(N.cylinder("barrel", (0.0, 0.016, -0.350), 0.011, 0.090, 8, N.MAT_TRIM, axis="Z"))
    p.append(N.cylinder("brake", (0.0, 0.016, -0.404), 0.017, 0.032, 8, N.MAT_BODY_DARK, axis="Z"))
    # Holographic optic.
    p.append(N.box("optic_base", (0.0, 0.070, -0.060), (0.032, 0.014, 0.070), N.MAT_TRIM))
    p.append(N.box("optic_hood", (0.0, 0.094, -0.060), (0.038, 0.038, 0.070), N.MAT_BODY_DARK))
    p.append(N.box("optic_glass", (0.0, 0.094, -0.092), (0.030, 0.030, 0.005), N.MAT_GLASS))
    p.append(N.box("optic_dot", (0.0, 0.094, -0.090), (0.005, 0.005, 0.004), N.MAT_VIOLET))
    p += magazine(0.022, 0.120, 0.026, N.MAT_BODY_DARK, curve=-4)
    p += energy_cell((0.034, 0.020, -0.020), (0.010, 0.038, 0.090), N.MAT_VIOLET)
    p.append(N.box("foregrip", (0.0, -0.036, -0.250), (0.026, 0.052, 0.028), N.MAT_GRIP, rotation=(-10, 0, 0)))
    return p


def build_energy_pistol() -> list:
    """Slide, exposed emitter coil, teal accents. Small and clean."""
    p = []
    p += pistol_grip(y=-0.048, z=0.020, scale=0.9)
    p += trigger_guard(z=-0.012, scale=0.85)
    p.append(N.box("frame", (0.0, 0.012, -0.055), (0.038, 0.058, 0.150), N.MAT_BODY_LIGHT))
    p.append(N.box("slide", (0.0, 0.046, -0.060), (0.034, 0.034, 0.170), N.MAT_BODY_DARK))
    for i in range(5):
        p.append(N.box(f"serration{i}", (0.0, 0.046, 0.008 - i * 0.010), (0.038, 0.030, 0.003), N.MAT_TRIM))
    p.append(N.cylinder("emitter", (0.0, 0.038, -0.152), 0.011, 0.036, 8, N.MAT_TRIM, axis="Z"))
    p.append(N.cylinder("emitter_glow", (0.0, 0.038, -0.174), 0.009, 0.008, 8, N.MAT_CYAN, axis="Z"))
    p.append(N.box("coil", (0.0, 0.020, -0.110), (0.026, 0.018, 0.050), N.MAT_CYAN))
    p.append(N.box("coil_cage", (0.0, 0.020, -0.110), (0.030, 0.024, 0.054), N.MAT_TRIM))
    p += iron_sights(-0.130, 0.020, 0.066)
    p += magazine(-0.020, 0.090, 0.024)
    return p


def build_tactical_revolver() -> list:
    """Fluted cylinder, heavy top rib, amber accent. Reads as a big sidearm."""
    p = []
    p += pistol_grip(y=-0.052, z=0.028, scale=0.98)
    p += trigger_guard(z=-0.008, scale=0.9)
    p.append(N.box("frame", (0.0, 0.014, -0.040), (0.034, 0.066, 0.130), N.MAT_BODY_DARK))
    p.append(N.cylinder("cylinder", (0.0, 0.018, -0.062), 0.030, 0.056, 6, N.MAT_BODY, axis="Z"))
    for i in range(6):
        a = (i / 6) * math.tau
        p.append(
            N.cylinder(
                f"chamber{i}",
                (math.cos(a) * 0.019, 0.018 + math.sin(a) * 0.019, -0.092),
                0.006,
                0.008,
                6,
                N.MAT_TRIM,
                axis="Z",
            )
        )
    p.append(N.box("top_rib", (0.0, 0.050, -0.140), (0.020, 0.016, 0.170), N.MAT_BODY_DARK))
    p.append(N.cylinder("barrel", (0.0, 0.018, -0.150), 0.013, 0.140, 8, N.MAT_TRIM, axis="Z"))
    p.append(N.cylinder("comp", (0.0, 0.018, -0.232), 0.019, 0.030, 8, N.MAT_BODY_DARK, axis="Z"))
    for i in range(3):
        p.append(N.box(f"comp_port{i}", (0.0, 0.032, -0.226 + i * 0.010), (0.030, 0.008, 0.004), N.MAT_TRIM))
    p.append(N.box("ejector_rod", (0.0, -0.008, -0.150), (0.012, 0.012, 0.120), N.MAT_TRIM))
    p.append(N.box("hammer", (0.0, 0.052, 0.026), (0.012, 0.028, 0.018), N.MAT_TRIM, rotation=(-18, 0, 0)))
    p += energy_cell((0.0, 0.062, -0.060), (0.014, 0.010, 0.048), N.MAT_AMBER)
    p += iron_sights(-0.215, 0.014, 0.062)
    return p


def build_plasma_blade() -> list:
    """Hilt plus a contained plasma edge; the blade is the whole silhouette."""
    p = []
    p.append(N.box("hilt", (0.0, 0.0, 0.060), (0.032, 0.036, 0.130), N.MAT_GRIP))
    for i in range(5):
        p.append(N.box(f"hilt_wrap{i}", (0.0, 0.0, 0.010 + i * 0.024), (0.036, 0.040, 0.008), N.MAT_TRIM))
    p.append(N.box("pommel", (0.0, 0.0, 0.132), (0.040, 0.040, 0.020), N.MAT_BODY_DARK))
    p.append(N.box("guard", (0.0, 0.0, -0.014), (0.086, 0.030, 0.026), N.MAT_BODY))
    p.append(N.box("guard_wing_l", (-0.052, 0.0, -0.020), (0.026, 0.016, 0.040), N.MAT_BODY_DARK, rotation=(0, 0, 18)))
    p.append(N.box("guard_wing_r", (0.052, 0.0, -0.020), (0.026, 0.016, 0.040), N.MAT_BODY_DARK, rotation=(0, 0, -18)))
    p.append(N.box("emitter", (0.0, 0.0, -0.036), (0.036, 0.024, 0.028), N.MAT_TRIM))
    # Blade: a long tapered wedge with a bright core.
    p.append(N.box("blade", (0.0, 0.0, -0.230), (0.046, 0.012, 0.360), N.MAT_CYAN, taper=(0.18, 0.35)))
    p.append(N.box("blade_core", (0.0, 0.0, -0.225), (0.016, 0.020, 0.350), N.MAT_WHITE, taper=(0.2, 0.2)))
    p.append(N.box("blade_spine", (0.0, 0.0, -0.150), (0.010, 0.026, 0.190), N.MAT_TRIM))
    return p


def build_arc_launcher() -> list:
    """Wide tube, drum of charges, folding grip. Chunky and slow-looking."""
    p = []
    p += pistol_grip(z=0.085, scale=1.05)
    p += trigger_guard(z=0.045)
    p.append(N.box("receiver", (0.0, 0.020, -0.060), (0.086, 0.100, 0.200), N.MAT_BODY))
    p.append(N.box("stock", (0.0, 0.034, 0.090), (0.052, 0.076, 0.110), N.MAT_BODY_DARK))
    p.append(N.box("buttplate", (0.0, 0.028, 0.150), (0.054, 0.090, 0.018), N.MAT_RUBBER))
    # Launch tube.
    p.append(N.cylinder("tube", (0.0, 0.034, -0.290), 0.045, 0.300, 12, N.MAT_BODY_DARK, axis="Z"))
    p.append(N.cylinder("tube_mouth", (0.0, 0.034, -0.452), 0.052, 0.030, 12, N.MAT_TRIM, axis="Z", radius_top=0.056))
    p.append(N.cylinder("tube_core", (0.0, 0.034, -0.452), 0.038, 0.008, 12, N.MAT_CYAN, axis="Z"))
    for i in range(4):
        zz = -0.400 + i * 0.058
        p.append(N.cylinder(f"tube_band{i}", (0.0, 0.034, zz), 0.049, 0.012, 12, N.MAT_BODY, axis="Z"))
    # Charge drum on the right.
    p.append(N.cylinder("drum", (0.052, 0.010, -0.080), 0.052, 0.046, 8, N.MAT_BODY_DARK, axis="X"))
    for i in range(4):
        a = (i / 4) * math.tau
        p.append(
            N.cylinder(
                f"charge{i}",
                (0.078, 0.010 + math.sin(a) * 0.030, -0.080 + math.cos(a) * 0.030),
                0.012,
                0.010,
                6,
                N.MAT_CYAN,
                axis="X",
            )
        )
    p.append(N.box("foregrip", (0.0, -0.034, -0.200), (0.030, 0.058, 0.034), N.MAT_GRIP, rotation=(-12, 0, 0)))
    p.append(N.box("optic", (0.0, 0.086, -0.100), (0.030, 0.032, 0.090), N.MAT_TRIM))
    p.append(N.box("optic_glass", (0.0, 0.086, -0.146), (0.024, 0.024, 0.005), N.MAT_GLASS))
    p += energy_cell((-0.048, 0.020, -0.040), (0.012, 0.044, 0.090), N.MAT_CYAN)
    return p


WEAPONS = {
    "pulse_ar": (build_pulse_ar, (0.0, 0.045, -0.395), (0.045, 0.010, -0.030)),
    "plasma_smg": (build_plasma_smg, (0.0, 0.014, -0.272), (0.038, 0.005, -0.020)),
    "rail_sniper": (build_rail_sniper, (0.0, 0.016, -0.582), (0.040, 0.020, -0.030)),
    "ion_shotgun": (build_ion_shotgun, (0.0, 0.020, -0.412), (0.048, 0.000, -0.020)),
    "particle_lmg": (build_particle_lmg, (0.0, 0.020, -0.518), (0.060, -0.020, -0.020)),
    "burst_carbine": (build_burst_carbine, (0.0, 0.016, -0.422), (0.040, 0.010, -0.020)),
    "energy_pistol": (build_energy_pistol, (0.0, 0.038, -0.182), (0.030, 0.030, -0.010)),
    "tactical_revolver": (build_tactical_revolver, (0.0, 0.018, -0.250), (0.032, 0.020, -0.010)),
    "plasma_blade": (build_plasma_blade, (0.0, 0.0, -0.410), (0.0, 0.0, 0.0)),
    "arc_launcher": (build_arc_launcher, (0.0, 0.034, -0.470), (0.0, 0.0, 0.0)),
}


# ---------------------------------------------------------------------------
# First-person arms
# ---------------------------------------------------------------------------


def build_arms() -> None:
    """
    Two gloved arms posed for a two-handed hold.

    The right hand sits at the origin (where every weapon's grip is) and the
    left forearm reaches forward; the client positions the left hand onto the
    weapon's SOCKET_grip, so one pair of arms works for all ten weapons.
    """
    N.reset_scene()
    parts: list = []

    def arm(side: int, name: str) -> None:
        sx = side * 1.0
        # Upper arm angles in from the shoulder, forearm comes forward.
        parts.append(N.capsule(f"{name}_upper", (sx * 0.115, -0.155, 0.230), 0.052, 0.230, N.MAT_BODY_DARK, axis="Z"))
        parts.append(
            N.capsule(f"{name}_fore", (sx * 0.085, -0.100, 0.055), 0.046, 0.230, N.MAT_BODY, axis="Z")
        )
        # Armour plates for silhouette.
        parts.append(N.box(f"{name}_shoulder", (sx * 0.130, -0.120, 0.300), (0.075, 0.070, 0.090), N.MAT_BODY_DARK))
        parts.append(N.box(f"{name}_elbow", (sx * 0.100, -0.135, 0.150), (0.058, 0.050, 0.058), N.MAT_TRIM))
        parts.append(N.box(f"{name}_forearm_plate", (sx * 0.082, -0.072, 0.060), (0.056, 0.030, 0.140), N.MAT_BODY_LIGHT))
        parts.append(N.box(f"{name}_trim", (sx * 0.082, -0.058, 0.030), (0.030, 0.010, 0.070), N.MAT_CYAN))
        # Glove + fingers.
        hand_z = -0.048 if side > 0 else -0.055
        parts.append(N.box(f"{name}_hand", (sx * 0.070, -0.058, hand_z), (0.058, 0.052, 0.076), N.MAT_GRIP))
        for i in range(4):
            parts.append(
                N.box(
                    f"{name}_finger{i}",
                    (sx * 0.070 - side * 0.004, -0.084 + i * 0.0, hand_z - 0.040 + i * 0.019),
                    (0.052, 0.018, 0.016),
                    N.MAT_GRIP,
                    rotation=(0, 0, 0),
                )
            )
        parts.append(
            N.box(f"{name}_thumb", (sx * 0.040, -0.048, hand_z - 0.020), (0.020, 0.030, 0.046), N.MAT_GRIP, rotation=(0, 0, side * -18))
        )
        parts.append(N.box(f"{name}_knuckles", (sx * 0.070, -0.030, hand_z - 0.030), (0.056, 0.016, 0.040), N.MAT_TRIM))

    arm(1, "right")
    arm(-1, "left")
    obj = N.join("arms_fp", parts)
    N.add_uvs(obj)
    N.socket("left_hand", (-0.070, -0.058, -0.055))
    N.socket("right_hand", (0.070, -0.058, -0.048))
    N.reorient("yup")
    N.export_glb("char_arms_fp")


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build_weapon(weapon_id: str) -> None:
    builder, muzzle, eject = WEAPONS[weapon_id]

    # --- first person -----------------------------------------------------
    N.reset_scene()
    parts = builder()
    obj = N.join(f"wpn_{weapon_id}", parts)
    N.add_uvs(obj)
    N.socket("muzzle", muzzle)
    N.socket("eject", eject)
    N.socket("grip", (0.0, -0.030, muzzle[2] * 0.55))
    tris = N.triangle_count(obj)
    if tris > 900:
        N.decimate_copy(obj, f"wpn_{weapon_id}_LOD1", 0.5)
    N.reorient("yup")
    N.export_glb(f"wpn_{weapon_id}")

    # --- world pickup -----------------------------------------------------
    # Same geometry, recentred so it spins about its own middle on a pedestal.
    N.reset_scene()
    parts = builder()
    obj = N.join(f"wpn_{weapon_id}_world", parts)
    N.add_uvs(obj)
    bbox_center = [0.0, 0.0, 0.0]
    for corner in obj.bound_box:
        for i in range(3):
            bbox_center[i] += corner[i] / 8.0
    for v in obj.data.vertices:
        v.co.x -= bbox_center[0]
        v.co.y -= bbox_center[1]
        v.co.z -= bbox_center[2]
    obj.data.update()
    N.reorient("yup")
    N.export_glb(f"wpn_{weapon_id}_world")


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in WEAPONS else list(WEAPONS.keys())
    for weapon_id in targets:
        N.log(f"building weapon {weapon_id}")
        build_weapon(weapon_id)
    if not only or only == "arms":
        N.log("building first-person arms")
        build_arms()
    N.log(f"weapons complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
