"""
KANG BANG - weapon model generator.

Builds all ten weapons plus the first-person arms. Each weapon exports twice:

  wpn_<id>.glb        first-person view model, origin at the grip, muzzle
                      forward along -Z, with SOCKET_muzzle / SOCKET_eject /
                      SOCKET_grip empties
  wpn_<id>_world.glb  the pickup/third-person version: same geometry, recentred
                      on its own bounds so it can spin on a pedestal

These are built as real firearms. The view model occupies a fifth of the screen
for the entire match and is the single most-looked-at object in the game, so it
is where the triangle budget goes: roughly 6-14k per weapon, against a few
hundred for a prop.

What actually makes them read as real, in rough order of value per triangle:

  1. Bevelled edges. Every corner catches a highlight. Nothing else comes close.
  2. Open bores and hollow tubes. A muzzle capped with a flat disc is the first
     thing the eye rejects, and it is 40 triangles to fix.
  3. Correct cross-sections. A receiver is a rounded rectangle, a handguard is
     a rounded octagon, a barrel is round. Building them from `superellipse`
     and `lathe` gets the proportion right by construction.
  4. Real anatomy in the real places: magwell flare, ejection port and brass
     deflector, charging handle, safety selector, castle nut, QD sling sockets,
     picatinny slots at their true 10.2 mm pitch. These are what a player
     recognises without being able to name.
  5. Material separation. Phosphate receiver, polymer grip, bare-steel barrel
     and anodised optic body are near enough the same colour; it is the
     roughness that tells them apart.

Silhouette still matters most at distance, so each weapon keeps a distinct
outline - carbine, bullpup, long precision rifle, drum-fed LMG, blade.

Run:  blender --background --factory-startup --python assets/scripts/gen_weapons.py
      (optionally  -- --only=pulse_ar )
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_kang as N  # noqa: E402


# ---------------------------------------------------------------------------
# Shared sub-assemblies
#
# Convention: +Y up, -Z forward (muzzle at negative Z), origin at the top of
# the pistol grip, which is where the right hand sits.
# ---------------------------------------------------------------------------


def pistol_grip(x=0.0, y=-0.010, z=0.072, scale=1.0, material=N.MAT_GRIP, rake=0.30):
    """
    Ergonomic grip: raked, with a palm swell and moulded finger grooves.

    Lofted downward along Y so the rake is just a per-section shift in Z, which
    is both easier to read and impossible to get backwards. `rake` is how far
    the base sits behind the tang, as a fraction of grip length - about 0.3 on
    a service rifle.

    A grip is the part of the weapon nearest the camera and the one the hand
    wraps, so its cross-section widening into a palm swell and then flaring at
    the base plate is very visible.
    """
    parts = []
    s = scale
    length = 0.104 * s
    # (t down the grip, half-width, half-depth, extra fore/aft shift)
    shape = [
        (0.00, 0.0170, 0.0224, 0.0000),
        (0.18, 0.0182, 0.0238, 0.0016),
        (0.42, 0.0193, 0.0250, 0.0026),   # palm swell
        (0.68, 0.0188, 0.0238, 0.0020),
        (0.88, 0.0176, 0.0214, 0.0004),
        (1.00, 0.0184, 0.0208, 0.0000),   # flares into the base plate
    ]
    sections = []
    for t, hw, hd, bulge in shape:
        cz = z + t * length * rake                       # rake: base sits aft
        sections.append((y - t * length,
                         N.superellipse(hw * s, hd * s + bulge, 3.2, 14, cx=x, cy=cz)))
    parts.append(N.loft("grip", sections, material, smooth=True, axis="Y"))

    base_z = z + length * rake
    parts.append(N.box("grip_cap", (x, y - length - 0.003, base_z),
                       (0.040 * s, 0.007, 0.046 * s), N.MAT_TRIM))

    # Moulded finger grooves across the front strap.
    for i in range(3):
        t = 0.26 + i * 0.24
        groove = N.cylinder(f"grip_groove{i}",
                            (x, y - t * length, z + t * length * rake - 0.0206 * s),
                            0.0062 * s, 0.030 * s, 10, material, axis="X")
        groove.scale = (1.0, 0.55, 1.0)
        parts.append(groove)
    return parts


def trigger_group(z=0.030, scale=1.0, guard_material=N.MAT_BODY, selector=True):
    """Rounded trigger guard, curved trigger blade, and a safety selector."""
    parts = []
    s = scale
    # Guard as a lathed torus segment would be overkill; a lofted loop reads
    # the same and stays cheap.
    r_out, r_in = 0.0300 * s, 0.0232 * s
    ring = []
    steps = 18
    for i in range(steps + 1):
        a = math.radians(-96 + i * (222.0 / steps))
        ring.append((math.sin(a), math.cos(a)))
    verts, faces = [], []
    for sx in (-0.0055 * s, 0.0055 * s):
        for cx, cy in ring:
            verts.append((sx, cy * r_out * 0.86 - 0.0225 * s, cx * r_out + z - 0.0265 * s))
        for cx, cy in ring:
            verts.append((sx, cy * r_in * 0.86 - 0.0225 * s, cx * r_in + z - 0.0265 * s))
    n = len(ring)
    for side in (0, 1):
        b = side * n * 2
        for i in range(n - 1):
            if side == 0:
                faces.append((b + i, b + i + 1, b + n + i + 1, b + n + i))
            else:
                faces.append((b + i, b + n + i, b + n + i + 1, b + i + 1))
    for i in range(n - 1):
        faces.append((i, n * 2 + i, n * 2 + i + 1, i + 1))                    # outer wall
        faces.append((n + i, n + i + 1, n * 3 + i + 1, n * 3 + i))            # inner wall
    faces.append((0, n, n * 3, n * 2))
    faces.append((n - 1, n * 2 + n - 1, n * 3 + n - 1, n + n - 1))
    parts.append(N.mesh_from_data("trigger_guard", verts, faces, guard_material))

    # Curved trigger blade.
    blade = []
    for i in range(5):
        t = i / 4.0
        blade.append((z - 0.030 * s + t * 0.026 * s,
                      N.rect_profile(0.0072, 0.0042 + t * 0.0016,
                                     cy=-0.028 * s + math.sin(t * 2.2) * 0.0075 * s)))
    parts.append(N.loft("trigger", blade, N.MAT_TRIM, smooth=False))

    if selector:
        lever = N.cylinder("selector", (0.0, 0.014, z + 0.030 * s), 0.0062, 0.052, 12, N.MAT_TRIM, axis="X")
        parts.append(lever)
        for sx in (-0.024, 0.024):
            parts.append(N.box("selector_lever", (sx, 0.008, z + 0.036 * s),
                               (0.0060, 0.0210, 0.0088), N.MAT_TRIM, rotation=(28, 0, 0)))
    return parts


def stanag_magazine(z=0.020, depth=0.150, width=0.0164, material=N.MAT_BODY_DARK,
                    curve=7.0, y_top=-0.020, ribs=True):
    """
    Curved box magazine with a floorplate and moulded ribs.

    The curve is the whole point: a straight box magazine is the classic tell
    of a model built from primitives, and rotating the loft sections
    progressively costs nothing.
    """
    parts = []
    sections = []
    steps = 6
    for i in range(steps + 1):
        t = i / steps
        # Sweep aft along a shallow arc as it descends: the curve is the whole
        # point, since a straight box magazine is the classic tell of a model
        # assembled from primitives.
        zz = z + math.sin(math.radians(curve * t)) * depth * t * 1.4
        sections.append((y_top - t * depth,
                         N.superellipse(width, 0.0290, 5.0, 14, cy=zz)))
    parts.append(N.loft("magazine", sections, material, smooth=False, axis="Y"))

    base_y, base_z = sections[-1][0], z + math.sin(math.radians(curve)) * depth * 1.4
    parts.append(N.box("mag_floor", (0.0, base_y - 0.005, base_z),
                       (width * 2.30, 0.011, 0.0640), N.MAT_TRIM))
    if ribs:
        for i in range(3):
            t = 0.30 + i * 0.22
            zz = z + math.sin(math.radians(curve * t)) * depth * t * 1.4
            parts.append(N.box(f"mag_rib{i}", (0.0, y_top - t * depth, zz),
                               (width * 2.18, 0.0090, 0.0600), material))
    return parts


def buffer_tube_stock(z_back=0.075, material=N.MAT_BODY_DARK, length=0.130, y=0.016):
    """Carbine buffer tube with an adjustable stock, castle nut and QD socket."""
    parts = []
    parts.append(N.lathe("castle_nut", [(0.0196, z_back - 0.012), (0.0196, z_back + 0.006),
                                        (0.0172, z_back + 0.008), (0.0172, z_back - 0.012)],
                         N.MAT_TRIM, 12, center=(0.0, y)))
    parts.append(N.tube("buffer_tube", 0.0158, 0.0138, z_back, z_back + length, N.MAT_BODY_LIGHT, 16, (0.0, y)))
    # Position-adjust notches along the underside.
    for i in range(5):
        parts.append(N.box(f"stock_notch{i}", (0.0, y - 0.0158, z_back + 0.030 + i * 0.019),
                           (0.0090, 0.0060, 0.0080), N.MAT_TRIM))
    # Stock body: a lofted shell around the tube.
    body = [
        (z_back + 0.052, N.superellipse(0.0212, 0.0250, 4.0, 14, cy=y - 0.002)),
        (z_back + 0.082, N.superellipse(0.0232, 0.0300, 4.0, 14, cy=y - 0.006)),
        (z_back + 0.116, N.superellipse(0.0238, 0.0330, 3.6, 14, cy=y - 0.010)),
        (z_back + 0.140, N.superellipse(0.0228, 0.0345, 3.4, 14, cy=y - 0.012)),
    ]
    parts.append(N.loft("stock", body, material, smooth=False))
    parts.append(N.box("buttpad", (0.0, y - 0.012, z_back + 0.146),
                       (0.0450, 0.0700, 0.0130), N.MAT_RUBBER))
    for i in range(3):
        parts.append(N.box(f"buttpad_groove{i}", (0.0, y - 0.036 + i * 0.024, z_back + 0.152),
                           (0.0460, 0.0060, 0.0060), N.MAT_TRIM))
    # QD sling socket.
    parts.append(N.lathe("qd_socket", [(0.0068, 0.0), (0.0068, 0.006), (0.0040, 0.006), (0.0040, 0.0)],
                         N.MAT_TRIM, 10, center=(0.0, 0.0)))
    parts[-1].location = (0.0212, y - 0.004, z_back + 0.070)
    parts[-1].rotation_euler = (0.0, math.radians(90), 0.0)
    return parts


def ejection_port(z=0.005, x=0.0192, y=0.030, material=N.MAT_BODY_LIGHT):
    """Port surround, hinged dust cover and brass deflector."""
    return [
        N.box("port_lip", (x, y + 0.008, z), (0.0040, 0.0230, 0.0560), N.MAT_TRIM),
        N.box("dust_cover", (x + 0.0032, y - 0.002, z), (0.0032, 0.0250, 0.0580), material),
        N.box("deflector", (x + 0.0010, y + 0.019, z + 0.036), (0.0090, 0.0180, 0.0230),
              material, taper=(0.4, 0.7)),
        N.cylinder("port_pin", (x + 0.0034, y - 0.016, z), 0.0026, 0.060, 8, N.MAT_TRIM, axis="Z"),
    ]


def charging_handle(z=0.058, y=0.046, material=N.MAT_TRIM):
    """AR-pattern T-handle sticking out the back of the upper."""
    return [
        N.box("ch_body", (0.0, y, z), (0.0330, 0.0110, 0.0460), material),
        N.box("ch_latch", (-0.0230, y, z + 0.014), (0.0180, 0.0130, 0.0180), material, taper=(0.7, 1.0)),
        N.box("ch_wing", (0.0230, y, z + 0.014), (0.0180, 0.0130, 0.0180), material, taper=(0.7, 1.0)),
    ]


def red_dot(z=-0.045, y=0.062, material=N.MAT_BODY_LIGHT, tint=N.MAT_CYAN):
    """Compact tube red dot on a picatinny mount, with a real lens and turrets."""
    parts = []
    parts.append(N.box("rd_mount", (0.0, y - 0.014, z), (0.0260, 0.0180, 0.0480), material))
    parts.append(N.box("rd_clamp", (0.0170, y - 0.020, z), (0.0090, 0.0130, 0.0420), N.MAT_TRIM))
    parts.append(N.tube("rd_tube", 0.0182, 0.0158, z - 0.036, z + 0.036, material, 18, (0.0, y + 0.012)))
    # Lenses sit inboard of the tube mouths so the housing shades them.
    parts.append(N.lathe("rd_lens_f", [(0.0, z - 0.030), (0.0156, z - 0.030)], N.MAT_GLASS, 18, (0.0, y + 0.012)))
    parts.append(N.lathe("rd_lens_r", [(0.0, z + 0.030), (0.0156, z + 0.030)], N.MAT_GLASS, 18, (0.0, y + 0.012)))
    parts.append(N.lathe("rd_dot", [(0.0, z - 0.028), (0.0022, z - 0.028)], tint, 8, (0.0, y + 0.012)))
    # Windage and elevation turrets.
    parts.append(N.lathe("rd_turret_e", [(0.0078, 0.0), (0.0078, 0.0098), (0.0060, 0.0112)],
                         N.MAT_TRIM, 12, (0.0, 0.0)))
    parts[-1].location = (0.0, y + 0.030, z)
    parts.append(N.lathe("rd_turret_w", [(0.0078, 0.0), (0.0078, 0.0098), (0.0060, 0.0112)],
                         N.MAT_TRIM, 12, (0.0, 0.0)))
    parts[-1].location = (0.0180, y + 0.012, z)
    parts[-1].rotation_euler = (0.0, math.radians(90), 0.0)
    return parts


def telescopic_sight(z=-0.060, y=0.078, length=0.230, objective=0.0300, tube_r=0.0198,
                     material=N.MAT_TRIM, tint=N.MAT_CYAN):
    """Variable optic: objective bell, main tube, eyepiece, turrets, rings."""
    parts = []
    zf, zr = z - length / 2.0, z + length / 2.0
    parts.append(N.lathe("scope_body", [
        (0.0, zf - 0.004),
        (objective, zf - 0.004), (objective, zf + 0.020),
        (tube_r, zf + 0.048),                      # bell taper
        (tube_r, zr - 0.062),
        (tube_r + 0.0070, zr - 0.040),             # eyepiece flare
        (tube_r + 0.0070, zr - 0.004),
        (0.0, zr - 0.004),
    ], material, 22, center=(0.0, y)))
    parts.append(N.lathe("scope_lens_f", [(0.0, zf + 0.001), (objective - 0.0028, zf + 0.001)],
                         N.MAT_GLASS, 22, (0.0, y)))
    parts.append(N.lathe("scope_lens_r", [(0.0, zr - 0.008), (tube_r + 0.0040, zr - 0.008)],
                         N.MAT_GLASS, 22, (0.0, y)))
    # Turret housings.
    parts.append(N.lathe("turret_e", [(0.0112, 0.0), (0.0112, 0.0150), (0.0092, 0.0168)],
                         N.MAT_TRIM, 14, (0.0, 0.0)))
    parts[-1].location = (0.0, y + tube_r, z - 0.012)
    parts.append(N.knurl("turret_e_grip", 0.0, 0.0100, 0.0114, N.MAT_TRIM, teeth=14))
    parts[-1].location = (0.0, y + tube_r + 0.010, z - 0.012)
    parts.append(N.lathe("turret_w", [(0.0112, 0.0), (0.0112, 0.0150), (0.0092, 0.0168)],
                         N.MAT_TRIM, 14, (0.0, 0.0)))
    parts[-1].location = (tube_r, y, z - 0.012)
    parts[-1].rotation_euler = (0.0, math.radians(90), 0.0)
    # Magnification ring.
    parts.append(N.knurl("scope_zoom", zr - 0.068, 0.0180, tube_r + 0.0034, material, (0.0, y), teeth=20))
    # Rings clamping the tube to the rail.
    for zz in (z - length * 0.26, z + length * 0.20):
        parts.append(N.tube(f"ring{zz:.3f}", tube_r + 0.0060, tube_r, zz - 0.010, zz + 0.010,
                            N.MAT_BODY_LIGHT, 16, (0.0, y)))
        parts.append(N.box("ring_base", (0.0, y - tube_r - 0.010, zz), (0.0250, 0.0180, 0.0200),
                           N.MAT_BODY_LIGHT))
        parts.append(N.box("ring_bolt", (0.0150, y - tube_r - 0.012, zz), (0.0080, 0.0080, 0.0120), N.MAT_TRIM))
    return parts


def flash_hider(z, y=0.0, r_barrel=0.0092, material=N.MAT_TRIM, prongs=5, length=0.046):
    """A2-pattern birdcage: a slotted cone with the slots actually cut."""
    body = N.lathe("fh_body", [
        (0.0072, z), (0.0126, z + 0.004),
        (0.0126, z + length - 0.012), (0.0108, z + length - 0.008),
        (0.0108, z + length), (0.0072, z + length),
    ], material, 16, center=(0.0, y))
    cutters = []
    for i in range(prongs):
        a = math.radians(180.0 / prongs * 2 * i + 26)
        slot = N.box(f"fh_slot{i}", (0.0, 0.0, z + length * 0.42), (0.0300, 0.0044, length * 0.52), material)
        slot.location = (math.cos(a) * 0.0130, y + math.sin(a) * 0.0130, z + length * 0.42)
        slot.rotation_euler = (0.0, 0.0, a)
        cutters.append(slot)
    return [N.weld(N.boolean(body, N.join("fh_cutter", cutters)))]


def muzzle_brake(z, y=0.0, material=N.MAT_TRIM, length=0.052, r=0.0148, ports=3):
    """Chambered brake with side ports cut through."""
    body = N.lathe("mb_body", [
        (0.0072, z), (r, z + 0.005), (r, z + length - 0.006),
        (r - 0.0026, z + length), (0.0072, z + length),
    ], material, 16, center=(0.0, y))
    cutters = []
    for i in range(ports):
        zz = z + 0.014 + i * (length - 0.026) / max(1, ports - 1)
        cutters.append(N.box(f"mb_port{i}", (0.0, y, zz), (0.0500, 0.0150, 0.0062), material))
    cutters.append(N.box("mb_top", (0.0, y + 0.010, z + length * 0.55), (0.0090, 0.0200, length * 0.5), material))
    return [N.weld(N.boolean(body, N.join("mb_cutter", cutters)))]


def gas_block(z, y=0.0, material=N.MAT_TRIM, r=0.0128):
    """Low-profile gas block with the gas tube running back to the receiver."""
    return [
        N.lathe("gas_block", [(0.0094, z - 0.018), (r, z - 0.014), (r, z + 0.014), (0.0094, z + 0.018)],
                material, 14, center=(0.0, y)),
        N.box("gas_block_flat", (0.0, y + 0.008, z), (0.0210, 0.0130, 0.0330), material),
        N.tube("gas_tube", 0.0030, 0.0018, z, z + 0.160, N.MAT_STEEL, 10, (0.0, y + 0.0128)),
    ]


def folding_sight(z, y, front=True, material=N.MAT_TRIM):
    """Back-up iron sight: a hooded post up front, an aperture at the rear."""
    parts = [N.box("bus_base", (0.0, y - 0.004, z), (0.0200, 0.0090, 0.0180), material)]
    if front:
        parts.append(N.box("bus_wing_l", (-0.0082, y + 0.017, z), (0.0036, 0.0290, 0.0110), material))
        parts.append(N.box("bus_wing_r", (0.0082, y + 0.017, z), (0.0036, 0.0290, 0.0110), material))
        parts.append(N.cylinder("bus_post", (0.0, y + 0.016, z), 0.0016, 0.0250, 8, material, axis="Y"))
    else:
        parts.append(N.box("bus_ear_l", (-0.0092, y + 0.015, z), (0.0038, 0.0250, 0.0100), material))
        parts.append(N.box("bus_ear_r", (0.0092, y + 0.015, z), (0.0038, 0.0250, 0.0100), material))
        ring = N.tube("bus_aperture", 0.0064, 0.0030, -0.0022, 0.0022, material, 12)
        ring.rotation_euler = (math.radians(90), 0.0, 0.0)
        ring.location = (0.0, y + 0.022, z)
        parts.append(ring)
    return parts


def bipod(z, y, material=N.MAT_TRIM, spread=22.0, leg=0.098):
    """
    Deployed bipod. Legs run down (-Y), not forward.

    A lathe is built along its own +Z, and in this authoring space -Z is
    forward while -Y is down, so the legs need rotating +90 degrees about X to
    hang. Rotating 180 - the intuitive "turn it upside down" - points them out
    of the muzzle instead, which is a mistake that renders as a flat bar under
    the barrel rather than as anything obviously wrong.
    """
    parts = [N.box("bipod_mount", (0.0, y + 0.008, z), (0.0230, 0.0200, 0.0300), material)]
    for side in (-1, 1):
        parts.append(N.lathe(f"bipod_leg{side}", [(0.0052, 0.0), (0.0052, leg), (0.0038, leg)],
                             material, 10, (0.0, 0.0)))
        parts[-1].location = (side * 0.0110, y, z)
        parts[-1].rotation_euler = (math.radians(90), 0.0, math.radians(side * spread))
        parts.append(N.box(f"bipod_foot{side}", (side * (0.0110 + leg * math.sin(math.radians(spread))),
                                                 y - leg * math.cos(math.radians(spread)), z),
                           (0.0140, 0.0080, 0.0220), N.MAT_RUBBER))
    return parts


def handguard(z_front, z_back, y=0.0, rx=0.0208, ry=0.0214, material=N.MAT_BODY_DARK,
              mlok=True, top_rail=True, exponent=6.0):
    """Free-float handguard: rounded-octagon tube with M-LOK slots cut in."""
    parts = []
    body = N.extrude_profile("handguard", N.superellipse(rx, ry, exponent, 20), z_front, z_back,
                             material, center=(0.0, y))
    if mlok:
        span = z_back - z_front
        for sx in (-1, 1):
            N.mlok_slots(body, z_front + span * 0.10, z_back - span * 0.14, y,
                         x=sx * rx, count=4, width=0.0092, length=0.0300, depth=0.0140)
        N.mlok_slots(body, z_front + span * 0.10, z_back - span * 0.14, y - ry,
                     x=0.0, count=4, width=0.0092, length=0.0300, depth=0.0140)
    parts.append(body)
    if top_rail:
        parts.append(N.picatinny("hg_rail", (z_front + z_back) / 2.0, abs(z_back - z_front) - 0.006, y + ry - 0.0008))
    return parts


# ---------------------------------------------------------------------------
# Weapons
# ---------------------------------------------------------------------------


def build_pulse_ar() -> list:
    """AR-pattern carbine. The reference silhouette everything else varies from."""
    p = []
    Y = 0.026                                             # bore axis height
    p += pistol_grip(z=0.070)
    p += trigger_group(z=0.030)

    # Lower receiver with a flared magwell.
    p.append(N.loft("lower", [
        (-0.086, N.superellipse(0.0176, 0.0230, 5.0, 16, cy=Y - 0.020)),
        (-0.040, N.superellipse(0.0182, 0.0250, 5.0, 16, cy=Y - 0.022)),
        (0.006,  N.superellipse(0.0178, 0.0228, 5.0, 16, cy=Y - 0.018)),
        (0.056,  N.superellipse(0.0166, 0.0206, 5.0, 16, cy=Y - 0.014)),
    ], N.MAT_BODY_LIGHT, smooth=False))
    p.append(N.loft("magwell", [
        (-0.052, N.superellipse(0.0206, 0.0150, 6.0, 14, cy=Y - 0.048)),
        (-0.030, N.superellipse(0.0230, 0.0168, 6.0, 14, cy=Y - 0.056)),
    ], N.MAT_BODY_LIGHT, smooth=False))
    p.append(N.box("mag_release", (0.0206, Y - 0.030, -0.028), (0.0110, 0.0150, 0.0150), N.MAT_TRIM))
    p.append(N.box("bolt_catch", (-0.0206, Y - 0.028, -0.010), (0.0100, 0.0120, 0.0260), N.MAT_TRIM))

    # Upper receiver.
    p.append(N.extrude_profile("upper", N.superellipse(0.0192, 0.0224, 5.0, 18),
                               -0.118, 0.052, N.MAT_BODY_LIGHT, center=(0.0, Y + 0.022)))
    p.append(N.box("forward_assist", (0.0196, Y + 0.030, 0.030), (0.0120, 0.0150, 0.0170), N.MAT_TRIM))
    p += ejection_port(z=0.004, x=0.0196, y=Y + 0.026)
    p += charging_handle(z=0.062, y=Y + 0.034)

    # Handguard, barrel, gas system, muzzle.
    p += handguard(-0.300, -0.116, Y, 0.0208, 0.0214)
    p.append(N.barrel("barrel", -0.352, -0.120, 0.0092, 0.0039, N.MAT_TRIM, center=(0.0, Y)))
    p += gas_block(-0.286, Y)
    p += flash_hider(-0.398, Y)
    p.append(N.picatinny("upper_rail", -0.034, 0.160, Y + 0.0436))

    p += stanag_magazine(z=-0.030, depth=0.148, y_top=Y - 0.060)
    p += buffer_tube_stock(z_back=0.070, y=Y + 0.016)
    p += red_dot(z=-0.038, y=Y + 0.048)
    p += folding_sight(-0.268, Y + 0.046, front=True)
    p.append(N.box("foregrip", (0.0, Y - 0.048, -0.238), (0.0260, 0.0500, 0.0300),
                   N.MAT_GRIP, rotation=(-10, 0, 0)))
    return p


def build_burst_carbine() -> list:
    """Bullpup: magazine behind the grip, so the outline is unmistakable."""
    p = []
    Y = 0.030
    p += pistol_grip(z=0.062, y=-0.006)
    p += trigger_group(z=0.022)

    # One long shell from muzzle to butt.
    p.append(N.loft("shell", [
        (-0.230, N.superellipse(0.0190, 0.0206, 6.0, 18, cy=Y)),
        (-0.140, N.superellipse(0.0214, 0.0252, 6.0, 18, cy=Y + 0.002)),
        (-0.030, N.superellipse(0.0236, 0.0300, 5.0, 18, cy=Y + 0.004)),
        (0.070,  N.superellipse(0.0242, 0.0320, 5.0, 18, cy=Y + 0.002)),
        (0.150,  N.superellipse(0.0238, 0.0330, 4.6, 18, cy=Y - 0.004)),
        (0.190,  N.superellipse(0.0224, 0.0316, 4.4, 18, cy=Y - 0.008)),
    ], N.MAT_BODY_DARK, smooth=False))
    p.append(N.box("cheek_rest", (0.0, Y + 0.036, 0.108), (0.0330, 0.0140, 0.1000),
                   N.MAT_BODY_DARK, rotation=(3, 0, 0)))
    p.append(N.box("buttpad", (0.0, Y - 0.004, 0.196), (0.0430, 0.0620, 0.0130), N.MAT_RUBBER))

    # Magazine sits behind the grip - the bullpup read.
    p += stanag_magazine(z=0.070, depth=0.126, y_top=Y - 0.030, curve=5.0)
    p += ejection_port(z=0.100, x=0.0242, y=Y + 0.006)

    p += handguard(-0.298, -0.208, Y, 0.0186, 0.0192, mlok=True, top_rail=False)
    p.append(N.barrel("barrel", -0.372, -0.214, 0.0088, 0.0039, N.MAT_TRIM, center=(0.0, Y)))
    p += muzzle_brake(-0.416, Y, length=0.046, r=0.0140)
    p.append(N.picatinny("top_rail", -0.040, 0.330, Y + 0.0330))
    p += red_dot(z=-0.086, y=Y + 0.038, tint=N.MAT_VIOLET)
    p.append(N.box("foregrip", (0.0, Y - 0.046, -0.252), (0.0250, 0.0480, 0.0280),
                   N.MAT_GRIP, rotation=(-12, 0, 0)))
    p.append(N.box("sling_loop", (0.0, Y - 0.030, -0.180), (0.0300, 0.0100, 0.0120), N.MAT_TRIM))
    return p


def build_plasma_smg() -> list:
    """Compact SMG: short, wide, folding stock. Reads as fast."""
    p = []
    Y = 0.022
    p += pistol_grip(z=0.056, y=-0.008, scale=0.94)
    p += trigger_group(z=0.018, scale=0.92)
    p.append(N.loft("body", [
        (-0.180, N.superellipse(0.0198, 0.0212, 5.5, 16, cy=Y)),
        (-0.090, N.superellipse(0.0230, 0.0268, 5.0, 16, cy=Y + 0.002)),
        (-0.010, N.superellipse(0.0238, 0.0286, 5.0, 16, cy=Y + 0.002)),
        (0.058,  N.superellipse(0.0224, 0.0264, 5.0, 16, cy=Y)),
    ], N.MAT_BODY_LIGHT, smooth=False))
    p += ejection_port(z=-0.012, x=0.0238, y=Y + 0.006)
    p.append(N.box("ch_handle", (-0.0250, Y + 0.020, -0.040), (0.0180, 0.0110, 0.0300), N.MAT_TRIM))

    p.append(N.barrel("barrel", -0.256, -0.170, 0.0080, 0.0045, N.MAT_TRIM, center=(0.0, Y)))
    p += handguard(-0.250, -0.176, Y, 0.0176, 0.0180, mlok=True, top_rail=False)
    p += muzzle_brake(-0.290, Y, length=0.036, r=0.0126, ports=2)
    p.append(N.picatinny("top_rail", -0.060, 0.230, Y + 0.0288))
    p += stanag_magazine(z=-0.020, depth=0.126, width=0.0150, y_top=Y - 0.034, curve=9.0)

    # Side-folding stock: two struts and a pad.
    for sx in (-0.0176, 0.0176):
        p.append(N.lathe(f"stock_strut{sx:.3f}", [(0.0056, 0.062), (0.0056, 0.156), (0.0042, 0.156)],
                         N.MAT_TRIM, 10, (sx, Y + 0.004)))
    p.append(N.box("stock_pad", (0.0, Y + 0.002, 0.166), (0.0400, 0.0560, 0.0120), N.MAT_RUBBER))
    p += red_dot(z=-0.070, y=Y + 0.044, tint=N.MAT_LIME)
    p.append(N.box("foregrip", (0.0, Y - 0.042, -0.212), (0.0240, 0.0460, 0.0260),
                   N.MAT_GRIP, rotation=(-14, 0, 0)))
    return p


def build_rail_sniper() -> list:
    """Long precision rifle in a chassis: big optic, bipod, heavy fluted barrel."""
    p = []
    Y = 0.028
    p += pistol_grip(z=0.082, scale=1.04)
    p += trigger_group(z=0.042)
    p.append(N.loft("chassis", [
        (-0.150, N.superellipse(0.0190, 0.0220, 6.0, 16, cy=Y)),
        (-0.060, N.superellipse(0.0212, 0.0272, 6.0, 16, cy=Y + 0.002)),
        (0.040,  N.superellipse(0.0212, 0.0280, 6.0, 16, cy=Y + 0.002)),
        (0.130,  N.superellipse(0.0200, 0.0260, 5.0, 16, cy=Y - 0.004)),
    ], N.MAT_BODY_LIGHT, smooth=False))
    # Solid butt with a thumbhole cut through it, and an adjustable cheek
    # riser on top. This started out as a skeletonised frame of thin bars,
    # which is what a real chassis stock is, but at view-model scale the bars
    # read as loose debris floating behind the receiver - a solid block with a
    # hole cut in it gives the same outline and is fewer triangles.
    butt = N.loft("butt", [
        (0.126, N.superellipse(0.0196, 0.0480, 4.0, 16, cy=Y + 0.004)),
        (0.180, N.superellipse(0.0206, 0.0560, 4.0, 16, cy=Y + 0.006)),
        (0.230, N.superellipse(0.0200, 0.0540, 4.0, 16, cy=Y + 0.002)),
        (0.252, N.superellipse(0.0190, 0.0500, 4.0, 16, cy=Y)),
    ], N.MAT_BODY_LIGHT, smooth=False)
    thumbhole = N.lathe("thumbhole", [(0.0230, -0.040), (0.0230, 0.040)], N.MAT_TRIM, 14, (0.0, 0.0))
    thumbhole.location = (0.0, Y + 0.006, 0.172)
    thumbhole.rotation_euler = (0.0, math.radians(90), 0.0)
    p.append(N.weld(N.boolean(butt, thumbhole)))
    p.append(N.loft("cheek_riser", [
        (0.122, N.superellipse(0.0166, 0.0130, 3.2, 12, cy=Y + 0.050)),
        (0.150, N.superellipse(0.0180, 0.0150, 3.2, 12, cy=Y + 0.052)),
        (0.216, N.superellipse(0.0180, 0.0150, 3.2, 12, cy=Y + 0.052)),
        (0.240, N.superellipse(0.0166, 0.0130, 3.2, 12, cy=Y + 0.050)),
    ], N.MAT_BODY_DARK, smooth=True))
    p.append(N.loft("buttpad", [
        (0.250, N.superellipse(0.0192, 0.0500, 4.0, 14, cy=Y)),
        (0.264, N.superellipse(0.0196, 0.0510, 4.0, 14, cy=Y)),
        (0.268, N.superellipse(0.0170, 0.0470, 4.0, 14, cy=Y)),
    ], N.MAT_RUBBER, smooth=False))

    # Bolt handle - the read for a manual action.
    p.append(N.lathe("bolt_shaft", [(0.0056, 0.0), (0.0056, 0.048), (0.0), ][:2] + [(0.0056, 0.048)],
                     N.MAT_STEEL, 10, (0.0, 0.0)))
    p[-1].location = (0.0212, Y + 0.014, 0.040)
    p[-1].rotation_euler = (0.0, math.radians(74), 0.0)
    p.append(N.sphere("bolt_knob", (0.0660, Y + 0.002, 0.040), 0.0110, N.MAT_STEEL, 8, 12))

    # Fluted heavy barrel: the flutes are lathe steps, effectively free.
    p.append(N.barrel("barrel", -0.560, -0.150, 0.0128, 0.0044, N.MAT_TRIM, center=(0.0, Y), segments=22))
    for i in range(6):
        zz = -0.500 + i * 0.052
        p.append(N.lathe(f"flute{i}", [(0.0132, zz - 0.018), (0.0104, zz - 0.012),
                                       (0.0104, zz + 0.012), (0.0132, zz + 0.018)],
                         N.MAT_TRIM, 16, (0.0, Y)))
    p += muzzle_brake(-0.612, Y, length=0.062, r=0.0186, ports=4)
    p += handguard(-0.330, -0.156, Y, 0.0232, 0.0236, mlok=True, top_rail=True, exponent=7.0)
    p.append(N.picatinny("action_rail", -0.030, 0.260, Y + 0.0286))
    p += telescopic_sight(z=-0.040, y=Y + 0.064, length=0.250, objective=0.0320)
    p += stanag_magazine(z=-0.040, depth=0.098, width=0.0186, y_top=Y - 0.034, curve=3.0)
    p += bipod(-0.316, Y - 0.026, leg=0.110)
    return p


def build_ion_shotgun() -> list:
    """Pump shotgun: tube magazine, ribbed forend, wide bore, heat shield."""
    p = []
    Y = 0.026
    p += pistol_grip(z=0.070)
    p += trigger_group(z=0.032)
    p.append(N.loft("receiver", [
        (-0.110, N.superellipse(0.0222, 0.0250, 6.0, 16, cy=Y)),
        (-0.040, N.superellipse(0.0242, 0.0300, 6.0, 16, cy=Y + 0.002)),
        (0.040,  N.superellipse(0.0238, 0.0290, 6.0, 16, cy=Y)),
    ], N.MAT_BODY, smooth=False))
    p += ejection_port(z=-0.020, x=0.0242, y=Y + 0.002)
    p.append(N.box("shell_lifter", (0.0, Y - 0.026, -0.030), (0.0300, 0.0110, 0.0620), N.MAT_TRIM))

    # 12-gauge bore is genuinely wide; that is most of the read.
    p.append(N.barrel("bore", -0.404, -0.090, 0.0136, 0.0093, N.MAT_TRIM, center=(0.0, Y), segments=20))
    p.append(N.tube("mag_tube", 0.0116, 0.0100, -0.330, -0.086, N.MAT_BODY, 14, (0.0, Y - 0.0250)))
    p.append(N.lathe("tube_cap", [(0.0124, -0.344), (0.0124, -0.330), (0.0090, -0.330)],
                     N.MAT_TRIM, 12, (0.0, Y - 0.0250)))
    # Ventilated rib along the top of the barrel.
    p.append(N.box("vent_rib", (0.0, Y + 0.0170, -0.250), (0.0110, 0.0044, 0.2900), N.MAT_TRIM))
    for i in range(9):
        p.append(N.box(f"rib_post{i}", (0.0, Y + 0.0142, -0.372 + i * 0.0320),
                       (0.0090, 0.0060, 0.0110), N.MAT_TRIM))
    # Pump forend with moulded ribs.
    p.append(N.loft("forend", [
        (-0.288, N.superellipse(0.0248, 0.0230, 4.5, 16, cy=Y - 0.014)),
        (-0.256, N.superellipse(0.0268, 0.0250, 4.5, 16, cy=Y - 0.014)),
        (-0.176, N.superellipse(0.0268, 0.0250, 4.5, 16, cy=Y - 0.014)),
        (-0.148, N.superellipse(0.0248, 0.0230, 4.5, 16, cy=Y - 0.014)),
    ], N.MAT_GRIP, smooth=False))
    for i in range(6):
        p.append(N.box(f"forend_rib{i}", (0.0, Y - 0.014, -0.272 + i * 0.0230),
                       (0.0552, 0.0510, 0.0080), N.MAT_TRIM))
    p.append(N.box("stock", (0.0, Y + 0.006, 0.116), (0.0400, 0.0640, 0.1300),
                   N.MAT_BODY_DARK, rotation=(5, 0, 0), taper=(0.92, 0.86)))
    p.append(N.box("buttpad", (0.0, Y - 0.004, 0.184), (0.0430, 0.0820, 0.0150), N.MAT_RUBBER))
    p.append(N.picatinny("top_rail", -0.030, 0.120, Y + 0.0292))
    p += folding_sight(-0.372, Y + 0.0212, front=True)
    p += folding_sight(-0.010, Y + 0.0322, front=False)
    return p


def build_particle_lmg() -> list:
    """Belt-fed LMG: drum, heavy shrouded barrel, carry handle, bipod."""
    p = []
    Y = 0.032
    p += pistol_grip(z=0.092, scale=1.08)
    p += trigger_group(z=0.052, scale=1.05)
    p.append(N.loft("receiver", [
        (-0.140, N.superellipse(0.0262, 0.0286, 6.0, 16, cy=Y)),
        (-0.040, N.superellipse(0.0300, 0.0350, 6.0, 16, cy=Y + 0.004)),
        (0.060,  N.superellipse(0.0296, 0.0344, 6.0, 16, cy=Y + 0.002)),
        (0.140,  N.superellipse(0.0270, 0.0300, 5.0, 16, cy=Y - 0.002)),
    ], N.MAT_BODY, smooth=False))
    # Hinged feed tray cover with the carry handle on top.
    p.append(N.box("feed_cover", (0.0, Y + 0.038, -0.020), (0.0520, 0.0180, 0.1900), N.MAT_BODY_DARK))
    p.append(N.box("carry_handle", (0.0, Y + 0.070, -0.030), (0.0180, 0.0480, 0.0280), N.MAT_TRIM))
    p.append(N.box("carry_grip", (0.0, Y + 0.092, -0.030), (0.0220, 0.0140, 0.1000), N.MAT_GRIP))

    p.append(N.barrel("barrel", -0.500, -0.150, 0.0122, 0.0044, N.MAT_TRIM, center=(0.0, Y), segments=20))
    # Ventilated barrel shroud with the cooling slots cut through.
    shroud = N.tube("shroud", 0.0244, 0.0212, -0.430, -0.150, N.MAT_BODY_DARK, 18, (0.0, Y))
    cutters = []
    for i in range(6):
        zz = -0.412 + i * 0.0440
        for sx in (-1, 1):
            cutters.append(N.box(f"vent{i}{sx}", (sx * 0.0230, Y, zz), (0.0180, 0.0300, 0.0220), N.MAT_TRIM))
    p.append(N.weld(N.boolean(shroud, N.join("vent_cutter", cutters))))
    p += muzzle_brake(-0.552, Y, length=0.058, r=0.0192, ports=3)
    p += gas_block(-0.398, Y, r=0.0150)

    # Drum magazine on the underside.
    p.append(N.lathe("drum", [
        (0.0, -0.030), (0.0640, -0.030), (0.0720, -0.018),
        (0.0720, 0.018), (0.0640, 0.030), (0.0, 0.030),
    ], N.MAT_BODY_DARK, 20, (0.0, 0.0)))
    p[-1].location = (0.0, Y - 0.098, -0.030)
    p[-1].rotation_euler = (math.radians(90), 0.0, 0.0)
    p.append(N.knurl("drum_rim", 0.0, 0.0560, 0.0648, N.MAT_TRIM, teeth=18))
    p[-1].location = (0.0, Y - 0.098, -0.030)
    p[-1].rotation_euler = (math.radians(90), 0.0, 0.0)
    p.append(N.box("feed_neck", (0.0, Y - 0.050, -0.030), (0.0340, 0.0500, 0.0560), N.MAT_BODY_DARK))
    p.append(N.box("drum_latch", (0.0, Y - 0.070, 0.002), (0.0200, 0.0180, 0.0120), N.MAT_TRIM))

    p.append(N.picatinny("top_rail", -0.030, 0.180, Y + 0.0472))
    p += telescopic_sight(z=-0.040, y=Y + 0.082, length=0.180, objective=0.0250, tube_r=0.0176)
    p += bipod(-0.400, Y - 0.026, leg=0.126, spread=26.0)
    p += buffer_tube_stock(z_back=0.140, y=Y + 0.006, length=0.110)
    return p


def build_energy_pistol() -> list:
    """Striker-fired pistol: slide with serrations, accessory rail, real sights."""
    p = []
    Y = 0.020
    p += pistol_grip(y=-0.004, z=0.016, scale=0.92, rake=0.36)
    p += trigger_group(z=-0.016, scale=0.84, selector=False)
    # Polymer frame.
    p.append(N.loft("frame", [
        (-0.108, N.superellipse(0.0134, 0.0116, 5.0, 14, cy=Y - 0.014)),
        (-0.050, N.superellipse(0.0146, 0.0134, 5.0, 14, cy=Y - 0.016)),
        (0.014,  N.superellipse(0.0150, 0.0150, 5.0, 14, cy=Y - 0.016)),
    ], N.MAT_BODY_DARK, smooth=False))
    p.append(N.picatinny("acc_rail", -0.076, 0.048, Y - 0.0288))
    # Slide.
    p.append(N.extrude_profile("slide", N.superellipse(0.0136, 0.0166, 5.0, 16),
                               -0.142, 0.026, N.MAT_BODY, center=(0.0, Y + 0.018)))
    for i in range(6):
        p.append(N.box(f"serration{i}", (0.0, Y + 0.018, 0.008 - i * 0.0092),
                       (0.0284, 0.0300, 0.0034), N.MAT_TRIM, rotation=(0, 0, 0)))
    for i in range(4):
        p.append(N.box(f"fserration{i}", (0.0, Y + 0.018, -0.104 - i * 0.0092),
                       (0.0284, 0.0300, 0.0034), N.MAT_TRIM))
    p.append(N.barrel("barrel", -0.150, -0.060, 0.0084, 0.0045, N.MAT_STEEL, center=(0.0, Y + 0.012)))
    p.append(N.box("ejection_port", (0.0140, Y + 0.026, -0.036), (0.0060, 0.0170, 0.0440), N.MAT_TRIM))
    # Sights: a square notch at the rear, a single post up front.
    p.append(N.box("rear_sight", (0.0, Y + 0.038, 0.016), (0.0180, 0.0090, 0.0080), N.MAT_TRIM))
    p.append(N.box("rear_notch", (0.0, Y + 0.042, 0.016), (0.0034, 0.0080, 0.0090), N.MAT_BODY_DARK))
    p.append(N.box("front_sight", (0.0, Y + 0.038, -0.132), (0.0044, 0.0090, 0.0060), N.MAT_TRIM))
    p.append(N.lathe("front_dot", [(0.0, -0.135), (0.0016, -0.135)], N.MAT_CYAN, 6, (0.0, Y + 0.040)))
    # On a pistol the magazine lives inside the grip, so only its baseplate and
    # a sliver of the floorplate show. Hanging one forward of the grip the way
    # a rifle does gives the gun two handles.
    p.append(N.box("mag_base", (0.0, -0.098, 0.048), (0.0300, 0.0100, 0.0420), N.MAT_TRIM))
    p.append(N.box("mag_release", (0.0148, -0.010, 0.006), (0.0090, 0.0130, 0.0130), N.MAT_TRIM))
    return p


def build_tactical_revolver() -> list:
    """Heavy magnum: fluted cylinder, vented rib, exposed hammer."""
    p = []
    Y = 0.022
    p += pistol_grip(y=-0.004, z=0.024, scale=0.98, rake=0.38)
    p += trigger_group(z=-0.010, scale=0.90, selector=False)
    p.append(N.loft("frame", [
        (-0.096, N.superellipse(0.0130, 0.0170, 5.0, 14, cy=Y + 0.002)),
        (-0.040, N.superellipse(0.0150, 0.0230, 5.0, 14, cy=Y - 0.002)),
        (0.030,  N.superellipse(0.0148, 0.0210, 5.0, 14, cy=Y)),
    ], N.MAT_BODY, smooth=False))

    # Fluted cylinder: six chambers bored through, six flutes cut between.
    cyl = N.lathe("cylinder", [
        (0.0, -0.030), (0.0290, -0.030), (0.0300, -0.026),
        (0.0300, 0.026), (0.0290, 0.030), (0.0, 0.030),
    ], N.MAT_BODY, 24, (0.0, 0.0))
    cyl.location = (0.0, Y, -0.058)
    cutters = []
    for i in range(6):
        a = i / 6.0 * math.tau
        bore = N.lathe(f"chamber{i}", [(0.0062, -0.040), (0.0062, 0.040)], N.MAT_TRIM, 10, (0.0, 0.0))
        bore.location = (math.cos(a) * 0.0176, Y + math.sin(a) * 0.0176, -0.058)
        cutters.append(bore)
        flute = N.lathe(f"flute{i}", [(0.0074, -0.020), (0.0074, 0.020)], N.MAT_TRIM, 10, (0.0, 0.0))
        flute.location = (math.cos(a + math.tau / 12) * 0.0322, Y + math.sin(a + math.tau / 12) * 0.0322, -0.058)
        cutters.append(flute)
    p.append(N.weld(N.boolean(cyl, N.join("cyl_cutter", cutters))))
    p.append(N.lathe("crane", [(0.0080, -0.034), (0.0080, 0.034)], N.MAT_TRIM, 10, (0.0, 0.0)))
    p[-1].location = (0.0, Y, -0.058)

    p.append(N.barrel("barrel", -0.226, -0.090, 0.0116, 0.0057, N.MAT_TRIM, center=(0.0, Y)))
    # Vented rib along the top of the barrel.
    p.append(N.box("top_rib", (0.0, Y + 0.0164, -0.158), (0.0140, 0.0060, 0.1360), N.MAT_BODY))
    for i in range(5):
        p.append(N.box(f"rib_slot{i}", (0.0, Y + 0.0140, -0.208 + i * 0.0240),
                       (0.0150, 0.0064, 0.0090), N.MAT_TRIM))
    p.append(N.box("underlug", (0.0, Y - 0.0166, -0.150), (0.0170, 0.0140, 0.1200), N.MAT_BODY))
    p.append(N.lathe("ejector_rod", [(0.0044, -0.204), (0.0044, -0.104), (0.0066, -0.100)],
                     N.MAT_STEEL, 10, (0.0, Y - 0.0176)))
    # Hammer and rear sight.
    p.append(N.box("hammer", (0.0, Y + 0.030, 0.030), (0.0090, 0.0280, 0.0140), N.MAT_TRIM, rotation=(-22, 0, 0)))
    p.append(N.knurl("hammer_spur", 0.0, 0.0080, 0.0072, N.MAT_TRIM, teeth=8))
    p[-1].location = (0.0, Y + 0.044, 0.038)
    p[-1].rotation_euler = (math.radians(70), 0.0, 0.0)
    p.append(N.box("rear_sight", (0.0, Y + 0.026, -0.006), (0.0170, 0.0080, 0.0110), N.MAT_TRIM))
    p.append(N.box("front_sight", (0.0, Y + 0.0234, -0.214), (0.0040, 0.0090, 0.0090), N.MAT_TRIM))
    p.append(N.lathe("front_bead", [(0.0, -0.218), (0.0018, -0.218)], N.MAT_AMBER, 6, (0.0, Y + 0.026)))
    return p


def build_arc_launcher() -> list:
    """Grenade launcher: fat rifled tube, revolving drum, ladder sight."""
    p = []
    Y = 0.034
    p += pistol_grip(z=0.082, scale=1.05)
    p += trigger_group(z=0.042, scale=1.02)
    p.append(N.loft("receiver", [
        (-0.130, N.superellipse(0.0250, 0.0270, 6.0, 16, cy=Y)),
        (-0.040, N.superellipse(0.0286, 0.0320, 6.0, 16, cy=Y + 0.002)),
        (0.050,  N.superellipse(0.0274, 0.0300, 6.0, 16, cy=Y)),
    ], N.MAT_BODY, smooth=False))
    # 40 mm launch tube, hollow, with a chamfered mouth.
    p.append(N.lathe("tube", [
        (0.0200, -0.452), (0.0248, -0.446), (0.0430, -0.440), (0.0450, -0.430),
        (0.0450, -0.140), (0.0400, -0.132),
        (0.0400, -0.140), (0.0400, -0.430), (0.0200, -0.440), (0.0200, -0.452),
    ], N.MAT_BODY_DARK, 22, (0.0, Y)))
    for i in range(4):
        zz = -0.400 + i * 0.062
        p.append(N.knurl(f"tube_band{i}", zz, 0.0120, 0.0466, N.MAT_TRIM, (0.0, Y), teeth=20))
    # Revolving charge drum.
    drum = N.lathe("drum", [
        (0.0, -0.032), (0.0520, -0.032), (0.0560, -0.026),
        (0.0560, 0.026), (0.0520, 0.032), (0.0, 0.032),
    ], N.MAT_BODY_DARK, 20, (0.0, 0.0))
    drum.location = (0.0500, Y - 0.010, -0.086)
    drum.rotation_euler = (0.0, math.radians(90), 0.0)
    cutters = []
    for i in range(5):
        a = i / 5.0 * math.tau
        bore = N.lathe(f"charge{i}", [(0.0150, -0.040), (0.0150, 0.040)], N.MAT_TRIM, 12, (0.0, 0.0))
        bore.location = (0.0500, Y - 0.010 + math.sin(a) * 0.0320, -0.086 + math.cos(a) * 0.0320)
        bore.rotation_euler = (0.0, math.radians(90), 0.0)
        cutters.append(bore)
    p.append(N.weld(N.boolean(drum, N.join("drum_cutter", cutters))))

    p.append(N.picatinny("top_rail", -0.060, 0.180, Y + 0.0292))
    # Folding ladder sight - the launcher read.
    p.append(N.box("ladder_base", (0.0, Y + 0.032, 0.010), (0.0220, 0.0100, 0.0200), N.MAT_TRIM))
    p.append(N.box("ladder_arm", (0.0, Y + 0.078, -0.006), (0.0180, 0.0900, 0.0060), N.MAT_TRIM, rotation=(-14, 0, 0)))
    for i in range(4):
        p.append(N.box(f"ladder_rung{i}", (0.0, Y + 0.046 + i * 0.0200, -0.002 - i * 0.0050),
                       (0.0220, 0.0040, 0.0050), N.MAT_TRIM))
    p.append(N.box("foregrip", (0.0, Y - 0.056, -0.210), (0.0300, 0.0580, 0.0340), N.MAT_GRIP, rotation=(-12, 0, 0)))
    p += buffer_tube_stock(z_back=0.056, y=Y + 0.006, length=0.120)
    return p


def build_plasma_blade() -> list:
    """
    Combat knife with a heated edge.

    The one weapon that is not a firearm, so it earns its silhouette from the
    blade profile instead: a clip-point ground from a lofted spine, with a real
    bevel down to a thin edge rather than a flat slab.
    """
    p = []
    # Blade: sections from ricasso to tip, thinning toward the edge.
    blade = []
    # The ricasso starts at +0.012, inside the guard, not at -0.010 in front of
    # it: a blade that begins where the guard ends leaves a visible gap, and
    # tangs run through the guard in any case.
    shape = [
        (0.012, 0.0230, 0.0038, 0.0),
        (-0.070, 0.0248, 0.0036, 0.0),
        (-0.150, 0.0252, 0.0032, 0.0),
        (-0.230, 0.0236, 0.0026, 0.0),
        (-0.290, 0.0186, 0.0020, 0.0034),
        (-0.330, 0.0104, 0.0014, 0.0072),
        (-0.348, 0.0026, 0.0008, 0.0098),
    ]
    for z, hh, ht, off in shape:
        # Asymmetric: flat spine on top, ground edge below.
        blade.append((z, [
            (-ht, hh + off), (ht, hh + off),
            (ht * 0.5, -hh * 0.32 + off), (0.0, -hh + off), (-ht * 0.5, -hh * 0.32 + off),
        ]))
    p.append(N.loft("blade", blade, N.MAT_STEEL, smooth=False))
    # Heated edge inlay, following the same taper just inside the grind.
    edge = []
    for z, hh, ht, off in shape:
        edge.append((z, [
            (-ht * 0.34, -hh * 0.30 + off), (ht * 0.34, -hh * 0.30 + off),
            (ht * 0.18, -hh * 0.86 + off), (-ht * 0.18, -hh * 0.86 + off),
        ]))
    p.append(N.loft("edge_glow", edge, N.MAT_AMBER, smooth=False))
    # Fuller groove down the flat.
    p.append(N.box("fuller", (0.0, 0.004, -0.170), (0.0044, 0.0090, 0.2000), N.MAT_TRIM))

    # Guard and handle.
    p.append(N.box("guard", (0.0, 0.0, 0.008), (0.0560, 0.0300, 0.0140), N.MAT_TRIM))
    p.append(N.loft("handle", [
        (0.012, N.superellipse(0.0130, 0.0176, 3.4, 14)),
        (0.048, N.superellipse(0.0146, 0.0198, 3.4, 14)),
        (0.086, N.superellipse(0.0142, 0.0192, 3.4, 14)),
        (0.118, N.superellipse(0.0126, 0.0168, 3.4, 14)),
    ], N.MAT_GRIP, smooth=False))
    for i in range(5):
        p.append(N.knurl(f"wrap{i}", 0.030 + i * 0.0200, 0.0110, 0.0154, N.MAT_TRIM, teeth=14))
    p.append(N.box("pommel", (0.0, 0.0, 0.132), (0.0300, 0.0340, 0.0180), N.MAT_TRIM))
    p.append(N.lathe("lanyard_hole", [(0.0038, 0.126), (0.0038, 0.140)], N.MAT_BODY_DARK, 8, (0.0, 0.0)))
    return p


WEAPONS = {
    "pulse_ar": (build_pulse_ar, (0.0, 0.026, -0.412), (0.0230, 0.052, 0.004)),
    "plasma_smg": (build_plasma_smg, (0.0, 0.022, -0.300), (0.0270, 0.028, -0.012)),
    "rail_sniper": (build_rail_sniper, (0.0, 0.028, -0.628), (0.0240, 0.042, 0.040)),
    "ion_shotgun": (build_ion_shotgun, (0.0, 0.026, -0.406), (0.0270, 0.028, -0.020)),
    "particle_lmg": (build_particle_lmg, (0.0, 0.032, -0.568), (0.0330, 0.038, -0.020)),
    "burst_carbine": (build_burst_carbine, (0.0, 0.030, -0.436), (0.0270, 0.036, 0.100)),
    "energy_pistol": (build_energy_pistol, (0.0, 0.032, -0.152), (0.0160, 0.046, -0.036)),
    "tactical_revolver": (build_tactical_revolver, (0.0, 0.022, -0.228), (0.0180, 0.038, -0.058)),
    "plasma_blade": (build_plasma_blade, (0.0, 0.0, -0.352), (0.0, 0.0, 0.0)),
    "arc_launcher": (build_arc_launcher, (0.0, 0.034, -0.456), (0.0, 0.0, 0.0)),
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

    Built by lofting rather than stacking capsules, because these are the only
    body parts the player sees close up for the entire match. Real arms taper:
    a forearm is wide and flat at the elbow and narrows to an oval at the
    wrist, and the deltoid is the widest part of the upper arm.
    """
    N.reset_scene()
    parts: list = []

    def arm(side: int, name: str) -> None:
        sx = side * 1.0
        # Sleeve: shoulder -> elbow, tapering as the deltoid falls away.
        parts.append(N.loft(f"{name}_upper", [
            (0.330, N.superellipse(0.0620, 0.0600, 2.6, 14, cx=sx * 0.118, cy=-0.140)),
            (0.250, N.superellipse(0.0570, 0.0560, 2.6, 14, cx=sx * 0.112, cy=-0.142)),
            (0.160, N.superellipse(0.0490, 0.0490, 2.6, 14, cx=sx * 0.104, cy=-0.140)),
            (0.100, N.superellipse(0.0455, 0.0470, 2.8, 14, cx=sx * 0.098, cy=-0.134)),
        ], N.MAT_CLOTH, smooth=True))
        # Forearm: elbow -> wrist, rotating flat-to-oval.
        parts.append(N.loft(f"{name}_fore", [
            (0.104, N.superellipse(0.0470, 0.0480, 2.8, 14, cx=sx * 0.098, cy=-0.132)),
            (0.040, N.superellipse(0.0432, 0.0440, 2.6, 14, cx=sx * 0.092, cy=-0.114)),
            (-0.020, N.superellipse(0.0360, 0.0372, 2.4, 14, cx=sx * 0.084, cy=-0.092)),
            (-0.060, N.superellipse(0.0296, 0.0316, 2.4, 14, cx=sx * 0.078, cy=-0.076)),
        ], N.MAT_CLOTH, smooth=True))
        parts.append(N.box(f"{name}_cuff", (sx * 0.078, -0.074, -0.056), (0.0700, 0.0680, 0.0180),
                           N.MAT_CLOTH_DARK))
        parts.append(N.box(f"{name}_elbow_pad", (sx * 0.100, -0.150, 0.120), (0.0620, 0.0300, 0.0700),
                           N.MAT_ARMOR))

        # Glove: palm block plus four curled fingers and a thumb.
        hand_z = -0.086 if side > 0 else -0.094
        parts.append(N.loft(f"{name}_palm", [
            (hand_z + 0.030, N.superellipse(0.0290, 0.0330, 3.0, 12, cx=sx * 0.072, cy=-0.066)),
            (hand_z - 0.004, N.superellipse(0.0300, 0.0350, 3.0, 12, cx=sx * 0.072, cy=-0.062)),
            (hand_z - 0.036, N.superellipse(0.0272, 0.0330, 3.0, 12, cx=sx * 0.072, cy=-0.058)),
        ], N.MAT_GRIP, smooth=True))
        for i in range(4):
            fz = hand_z - 0.030 + i * 0.0178
            fr = 0.0092 - i * 0.0006
            parts.append(N.lathe(f"{name}_finger{i}", [
                (0.0, 0.0), (fr, 0.004), (fr, 0.030), (fr * 0.86, 0.044), (0.0, 0.048),
            ], N.MAT_GRIP, 10, (0.0, 0.0)))
            parts[-1].location = (sx * 0.072, -0.086, fz)
            parts[-1].rotation_euler = (math.radians(-96), 0.0, 0.0)
            parts.append(N.box(f"{name}_knuckle{i}", (sx * 0.072, -0.046, fz), (0.0180, 0.0160, 0.0150),
                               N.MAT_ARMOR))
        parts.append(N.lathe(f"{name}_thumb", [
            (0.0, 0.0), (0.0104, 0.004), (0.0104, 0.034), (0.0088, 0.046), (0.0, 0.050),
        ], N.MAT_GRIP, 10, (0.0, 0.0)))
        parts[-1].location = (sx * 0.048, -0.062, hand_z - 0.016)
        parts[-1].rotation_euler = (math.radians(-64), 0.0, math.radians(side * 34))

    arm(1, "right")
    arm(-1, "left")
    N.socket("left_hand", (-0.072, -0.066, -0.094))
    N.socket("right_hand", (0.072, -0.066, -0.086))
    N.finish("char_arms_fp", parts, smooth_angle=44.0, lod_threshold=4000, lod_ratio=0.4)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build_weapon(weapon_id: str) -> None:
    builder, muzzle, eject = WEAPONS[weapon_id]

    # --- first person -----------------------------------------------------
    N.reset_scene()
    parts = builder()
    N.socket("muzzle", muzzle)
    N.socket("eject", eject)
    N.socket("grip", (0.0, -0.030, muzzle[2] * 0.55))
    N.finish(f"wpn_{weapon_id}", parts, smooth_angle=36.0, lod_threshold=6000, lod_ratio=0.32)

    # --- world pickup -----------------------------------------------------
    # Same geometry, recentred so it spins about its own middle on a pedestal,
    # and decimated harder: it is seen at a distance and there may be several
    # on screen at once.
    N.reset_scene()
    parts = builder()
    N.finish(f"wpn_{weapon_id}_world", parts, smooth_angle=36.0,
             lod_threshold=2200, lod_ratio=0.30, recenter=True)


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
