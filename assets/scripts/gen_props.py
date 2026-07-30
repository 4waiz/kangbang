"""
NEON STRIKE - prop, pickup, objective and deployable generator.

These are the models referenced by MapDef.props and by the objective/pickup
systems. Each is small (30-250 triangles) and instanced heavily by the client,
so they are built to read at a distance rather than up close.

Run: blender --background --factory-startup --python assets/scripts/gen_props.py
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_neon as N  # noqa: E402


# ---------------------------------------------------------------------------
# Environment props
# ---------------------------------------------------------------------------


def prop_reactor_ring() -> list:
    """Rotating collar around the Neon Foundry reactor column."""
    p: list = []
    segments = 10
    for i in range(segments):
        a = (i / segments) * math.tau
        x = math.cos(a) * 3.1
        z = math.sin(a) * 3.1
        p.append(N.box(f"seg{i}", (x, 0.0, z), (0.7, 0.34, 0.5), N.MAT_BODY_DARK, rotation=(0, -math.degrees(a), 0)))
        p.append(N.box(f"glow{i}", (x * 1.04, 0.0, z * 1.04), (0.5, 0.10, 0.14), N.MAT_CYAN, rotation=(0, -math.degrees(a), 0)))
    p.append(N.cylinder("hub", (0.0, 0.0, 0.0), 2.7, 0.16, 12, N.MAT_TRIM, axis="Y"))
    return p


def prop_coolant_tank() -> list:
    p: list = []
    p.append(N.cylinder("tank", (0.0, 1.05, 0.0), 0.52, 2.1, 10, N.MAT_BODY_LIGHT, axis="Y"))
    p.append(N.cylinder("cap", (0.0, 2.16, 0.0), 0.46, 0.16, 10, N.MAT_TRIM, axis="Y"))
    p.append(N.cylinder("base", (0.0, 0.10, 0.0), 0.58, 0.20, 10, N.MAT_TRIM, axis="Y"))
    for i in range(3):
        p.append(N.cylinder(f"band{i}", (0.0, 0.5 + i * 0.55, 0.0), 0.545, 0.09, 10, N.MAT_HAZARD, axis="Y"))
    p.append(N.box("gauge", (0.0, 1.5, -0.53), (0.24, 0.30, 0.06), N.MAT_TRIM))
    p.append(N.box("gauge_face", (0.0, 1.5, -0.57), (0.17, 0.22, 0.02), N.MAT_CYAN))
    p.append(N.cylinder("pipe", (0.30, 2.30, 0.0), 0.10, 0.5, 8, N.MAT_TRIM, axis="Y"))
    return p


def prop_conveyor_arm() -> list:
    p: list = []
    p.append(N.box("column", (0.0, 1.4, 0.0), (0.34, 2.8, 0.34), N.MAT_BODY_DARK))
    p.append(N.box("arm", (0.0, 2.6, -1.0), (0.26, 0.26, 2.0), N.MAT_BODY_DARK, rotation=(14, 0, 0)))
    p.append(N.box("head", (0.0, 2.1, -2.0), (0.5, 0.5, 0.5), N.MAT_BODY))
    p.append(N.cylinder("lens", (0.0, 1.85, -2.0), 0.16, 0.10, 8, N.MAT_AMBER, axis="Y"))
    p.append(N.box("base", (0.0, 0.10, 0.0), (0.7, 0.20, 0.7), N.MAT_TRIM))
    for i in range(4):
        p.append(N.box(f"rung{i}", (0.0, 0.5 + i * 0.6, 0.20), (0.44, 0.06, 0.06), N.MAT_TRIM))
    return p


def prop_crane() -> list:
    p: list = []
    p.append(N.box("beam", (0.0, 0.0, 0.0), (0.5, 0.5, 22.0), N.MAT_BODY_DARK))
    for i in range(9):
        z = -10 + i * 2.5
        p.append(N.box(f"truss{i}", (0.0, 0.35, z), (0.7, 0.16, 0.16), N.MAT_TRIM))
        p.append(N.box(f"diag{i}", (0.0, 0.0, z), (0.10, 0.9, 0.10), N.MAT_TRIM, rotation=(0, 0, 28)))
    p.append(N.box("trolley", (0.0, -0.55, 0.0), (1.1, 0.6, 1.4), N.MAT_BODY))
    p.append(N.cylinder("hook_line", (0.0, -1.6, 0.0), 0.05, 1.6, 6, N.MAT_TRIM, axis="Y"))
    p.append(N.box("hook", (0.0, -2.5, 0.0), (0.34, 0.5, 0.34), N.MAT_HAZARD))
    p.append(N.box("light", (0.0, -0.9, 0.7), (0.24, 0.16, 0.16), N.MAT_AMBER))
    return p


def prop_pipe_run() -> list:
    p: list = []
    for i, (off, r) in enumerate(((-0.55, 0.24), (0.0, 0.30), (0.58, 0.20))):
        p.append(N.cylinder(f"pipe{i}", (0.0, off, 0.0), r, 24.0, 8, N.MAT_BODY_LIGHT, axis="Z"))
        for j in range(7):
            p.append(N.cylinder(f"flange{i}_{j}", (0.0, off, -10.5 + j * 3.5), r * 1.22, 0.20, 8, N.MAT_TRIM, axis="Z"))
    p.append(N.box("bracket_a", (0.0, 0.0, -8.0), (0.24, 1.6, 0.30), N.MAT_TRIM))
    p.append(N.box("bracket_b", (0.0, 0.0, 8.0), (0.24, 1.6, 0.30), N.MAT_TRIM))
    return p


def prop_vent() -> list:
    p: list = []
    p.append(N.box("housing", (0.0, 0.0, 0.0), (1.5, 1.5, 0.4), N.MAT_BODY_DARK))
    p.append(N.box("frame", (0.0, 0.0, -0.20), (1.6, 1.6, 0.12), N.MAT_TRIM))
    for i in range(5):
        p.append(N.box(f"louvre{i}", (0.0, -0.55 + i * 0.28, -0.24), (1.34, 0.18, 0.06), N.MAT_TRIM, rotation=(24, 0, 0)))
    p.append(N.cylinder("fan_hub", (0.0, 0.0, 0.10), 0.20, 0.16, 8, N.MAT_TRIM, axis="Z"))
    for i in range(4):
        a = (i / 4) * 360
        p.append(N.box(f"blade{i}", (0.0, 0.0, 0.10), (1.0, 0.22, 0.04), N.MAT_BODY, rotation=(0, 0, a)))
    return p


def prop_terminal() -> list:
    p: list = []
    p.append(N.box("pedestal", (0.0, 0.55, 0.0), (0.62, 1.1, 0.42), N.MAT_BODY_DARK))
    p.append(N.box("base", (0.0, 0.06, 0.0), (0.78, 0.12, 0.58), N.MAT_TRIM))
    p.append(N.box("screen_frame", (0.0, 1.24, -0.06), (0.70, 0.52, 0.10), N.MAT_BODY, rotation=(-18, 0, 0)))
    p.append(N.box("screen", (0.0, 1.26, -0.13), (0.60, 0.42, 0.02), N.MAT_CYAN, rotation=(-18, 0, 0)))
    for i in range(3):
        p.append(N.box(f"key{i}", (-0.20 + i * 0.20, 0.92, -0.20), (0.13, 0.05, 0.09), N.MAT_TRIM, rotation=(-30, 0, 0)))
    p.append(N.box("strip", (0.0, 0.30, -0.22), (0.42, 0.05, 0.03), N.MAT_CYAN))
    return p


def prop_crate_stack() -> list:
    p: list = []
    boxes = ((0.0, 0.5, 0.0, 1.0), (0.55, 0.4, 0.35, 0.8), (-0.3, 1.35, 0.15, 0.7))
    for i, (x, y, z, s) in enumerate(boxes):
        mat = N.MAT_CRATE if i % 2 == 0 else N.MAT_BODY
        p.append(N.box(f"crate{i}", (x, y, z), (s, s, s), mat, rotation=(0, i * 17, 0)))
        p.append(N.box(f"band{i}", (x, y, z), (s * 1.03, s * 0.12, s * 1.03), N.MAT_TRIM, rotation=(0, i * 17, 0)))
        p.append(N.box(f"label{i}", (x, y, z - s * 0.51), (s * 0.4, s * 0.28, 0.02), N.MAT_HAZARD, rotation=(0, i * 17, 0)))
    return p


def prop_barrel() -> list:
    p: list = []
    p.append(N.cylinder("body", (0.0, 0.46, 0.0), 0.30, 0.92, 10, N.MAT_HAZARD, axis="Y"))
    p.append(N.cylinder("rim_top", (0.0, 0.90, 0.0), 0.32, 0.06, 10, N.MAT_TRIM, axis="Y"))
    p.append(N.cylinder("rim_bottom", (0.0, 0.03, 0.0), 0.32, 0.06, 10, N.MAT_TRIM, axis="Y"))
    p.append(N.cylinder("band", (0.0, 0.46, 0.0), 0.315, 0.10, 10, N.MAT_TRIM, axis="Y"))
    p.append(N.box("label", (0.0, 0.60, -0.30), (0.24, 0.22, 0.02), N.MAT_BODY_DARK))
    return p


def prop_streetlight() -> list:
    p: list = []
    p.append(N.cylinder("post", (0.0, 2.4, 0.0), 0.09, 4.8, 8, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("foot", (0.0, 0.08, 0.0), 0.22, 0.16, 8, N.MAT_TRIM, axis="Y"))
    p.append(N.box("arm", (0.0, 4.75, -0.55), (0.12, 0.12, 1.1), N.MAT_BODY_DARK, rotation=(10, 0, 0)))
    p.append(N.box("lamp", (0.0, 4.6, -1.05), (0.42, 0.16, 0.7), N.MAT_TRIM))
    p.append(N.box("lamp_glow", (0.0, 4.5, -1.05), (0.34, 0.05, 0.6), N.MAT_WHITE))
    p.append(N.box("sign", (0.12, 3.2, 0.0), (0.04, 1.1, 0.34), N.MAT_VIOLET))
    return p


def prop_hovercar() -> list:
    p: list = []
    p.append(N.box("hull", (0.0, 0.62, 0.0), (2.0, 0.5, 4.4), N.MAT_BODY, taper=(0.8, 0.7)))
    p.append(N.box("cabin", (0.0, 1.02, -0.15), (1.7, 0.44, 2.2), N.MAT_GLASS, taper=(0.8, 0.7)))
    p.append(N.box("nose", (0.0, 0.58, -2.35), (1.5, 0.34, 0.6), N.MAT_BODY_DARK, taper=(0.7, 0.6)))
    p.append(N.box("tail", (0.0, 0.62, 2.30), (1.6, 0.40, 0.5), N.MAT_BODY_DARK))
    p.append(N.box("tail_light", (0.0, 0.62, 2.55), (1.2, 0.12, 0.06), N.MAT_AMBER))
    p.append(N.box("head_light", (0.0, 0.58, -2.62), (1.0, 0.12, 0.06), N.MAT_WHITE))
    for sx in (-1, 1):
        for sz in (-1, 1):
            p.append(N.cylinder("thruster", (sx * 0.9, 0.34, sz * 1.5), 0.30, 0.34, 8, N.MAT_TRIM, axis="Y"))
            p.append(N.cylinder("thruster_glow", (sx * 0.9, 0.19, sz * 1.5), 0.22, 0.06, 8, N.MAT_CYAN, axis="Y"))
    return p


def prop_ac_unit() -> list:
    p: list = []
    p.append(N.box("box", (0.0, 0.45, 0.0), (1.5, 0.9, 1.2), N.MAT_BODY_LIGHT))
    p.append(N.box("lid", (0.0, 0.94, 0.0), (1.6, 0.10, 1.3), N.MAT_TRIM))
    p.append(N.cylinder("fan_ring", (0.0, 0.98, 0.0), 0.44, 0.10, 10, N.MAT_TRIM, axis="Y"))
    for i in range(4):
        p.append(N.box(f"blade{i}", (0.0, 1.0, 0.0), (0.72, 0.03, 0.16), N.MAT_BODY_DARK, rotation=(0, i * 45, 0)))
    for i in range(4):
        p.append(N.box(f"grill{i}", (-0.76, 0.45, -0.4 + i * 0.27), (0.04, 0.62, 0.16), N.MAT_TRIM))
    p.append(N.box("conduit", (0.6, 0.30, 0.66), (0.16, 0.5, 0.16), N.MAT_TRIM))
    return p


def prop_antenna() -> list:
    p: list = []
    p.append(N.box("mast", (0.0, 1.9, 0.0), (0.13, 3.8, 0.13), N.MAT_TRIM))
    p.append(N.box("base", (0.0, 0.08, 0.0), (0.6, 0.16, 0.6), N.MAT_BODY_DARK))
    for i in range(3):
        y = 1.1 + i * 1.0
        p.append(N.box(f"cross{i}", (0.0, y, 0.0), (1.0, 0.07, 0.07), N.MAT_TRIM))
        p.append(N.box(f"cross_b{i}", (0.0, y, 0.0), (0.07, 0.07, 1.0), N.MAT_TRIM))
    p.append(N.cylinder("dish", (0.0, 3.5, 0.28), 0.42, 0.10, 10, N.MAT_BODY_LIGHT, axis="Z", radius_top=0.16))
    p.append(N.box("beacon", (0.0, 3.9, 0.0), (0.16, 0.16, 0.16), N.MAT_AMBER))
    return p


def prop_holo_sign() -> list:
    p: list = []
    p.append(N.box("frame", (0.0, 0.0, 0.0), (0.16, 2.2, 0.16), N.MAT_TRIM))
    p.append(N.box("panel", (0.0, 0.0, 0.06), (1.5, 2.0, 0.04), N.MAT_CYAN))
    for i in range(4):
        p.append(N.box(f"line{i}", (0.0, 0.7 - i * 0.45, 0.09), (1.1 - i * 0.14, 0.14, 0.02), N.MAT_WHITE))
    p.append(N.box("bracket", (0.0, -1.15, 0.0), (0.5, 0.12, 0.3), N.MAT_TRIM))
    return p


def prop_holo_billboard() -> list:
    p: list = []
    p.append(N.box("post_l", (-1.7, 1.2, 0.0), (0.16, 2.4, 0.16), N.MAT_TRIM))
    p.append(N.box("post_r", (1.7, 1.2, 0.0), (0.16, 2.4, 0.16), N.MAT_TRIM))
    p.append(N.box("panel", (0.0, 2.6, 0.0), (3.6, 2.2, 0.10), N.MAT_VIOLET))
    p.append(N.box("panel_frame", (0.0, 2.6, 0.0), (3.8, 2.4, 0.06), N.MAT_TRIM))
    for i in range(3):
        p.append(N.box(f"glyph{i}", (-1.0 + i * 1.0, 2.6, 0.08), (0.6, 1.2, 0.03), N.MAT_WHITE))
    p.append(N.box("under_glow", (0.0, 1.35, 0.0), (3.4, 0.08, 0.2), N.MAT_VIOLET))
    return p


def prop_spawn_arch() -> list:
    p: list = []
    p.append(N.box("leg_l", (-2.6, 1.6, 0.0), (0.34, 3.2, 0.5), N.MAT_BODY_DARK))
    p.append(N.box("leg_r", (2.6, 1.6, 0.0), (0.34, 3.2, 0.5), N.MAT_BODY_DARK))
    p.append(N.box("lintel", (0.0, 3.35, 0.0), (5.6, 0.5, 0.6), N.MAT_BODY_DARK))
    p.append(N.box("lintel_glow", (0.0, 3.05, 0.0), (5.2, 0.12, 0.24), N.MAT_TEAM))
    p.append(N.box("field", (0.0, 1.6, 0.0), (5.0, 3.2, 0.06), N.MAT_GLASS))
    for i in range(5):
        p.append(N.box(f"chevron{i}", (-2.0 + i * 1.0, 0.3, 0.08), (0.6, 0.10, 0.2), N.MAT_TEAM))
    return p


def prop_strut() -> list:
    p: list = []
    p.append(N.box("spine", (0.0, 0.0, 0.0), (0.4, 5.0, 0.4), N.MAT_BODY_DARK))
    for i in range(5):
        y = -2.0 + i * 1.0
        p.append(N.box(f"rib{i}", (0.0, y, 0.0), (1.4, 0.14, 0.14), N.MAT_TRIM))
        p.append(N.box(f"diag{i}", (0.0, y + 0.5, 0.0), (0.12, 1.2, 0.12), N.MAT_TRIM, rotation=(0, 0, 32)))
    return p


def prop_satellite() -> list:
    p: list = []
    p.append(N.box("core", (0.0, 0.0, 0.0), (1.6, 1.6, 2.4), N.MAT_BODY_LIGHT))
    p.append(N.cylinder("dish", (0.0, 0.0, -1.7), 1.5, 0.24, 12, N.MAT_BODY_DARK, axis="Z", radius_top=0.5))
    p.append(N.cylinder("dish_face", (0.0, 0.0, -1.86), 1.2, 0.06, 12, N.MAT_CYAN, axis="Z"))
    for sx in (-1, 1):
        p.append(N.box("panel_arm", (sx * 1.6, 0.0, 0.0), (1.6, 0.12, 0.12), N.MAT_TRIM))
        p.append(N.box("panel", (sx * 3.6, 0.0, 0.0), (3.6, 0.10, 2.0), N.MAT_VISOR))
        for i in range(3):
            p.append(N.box(f"cell{sx}{i}", (sx * (2.2 + i * 1.0), 0.06, 0.0), (0.06, 0.02, 1.9), N.MAT_TRIM))
    p.append(N.box("thruster", (0.0, 0.0, 1.4), (0.7, 0.7, 0.5), N.MAT_TRIM))
    p.append(N.box("thruster_glow", (0.0, 0.0, 1.7), (0.5, 0.5, 0.08), N.MAT_AMBER))
    return p


def prop_spire_collar() -> list:
    p: list = []
    for i in range(12):
        a = (i / 12) * math.tau
        p.append(
            N.box(
                f"fin{i}",
                (math.cos(a) * 4.0, 0.0, math.sin(a) * 4.0),
                (1.3, 0.9, 0.35),
                N.MAT_BODY_DARK,
                rotation=(0, -math.degrees(a), 0),
            )
        )
        p.append(
            N.box(
                f"fin_glow{i}",
                (math.cos(a) * 4.35, 0.0, math.sin(a) * 4.35),
                (1.0, 0.22, 0.16),
                N.MAT_CYAN,
                rotation=(0, -math.degrees(a), 0),
            )
        )
    p.append(N.cylinder("ring", (0.0, 0.0, 0.0), 3.5, 0.5, 12, N.MAT_TRIM, axis="Y"))
    return p


def prop_holo_globe() -> list:
    p: list = []
    p.append(N.sphere("globe", (0.0, 0.0, 0.0), 1.3, N.MAT_GLASS, rings=8, segments=12))
    p.append(N.sphere("core", (0.0, 0.0, 0.0), 0.5, N.MAT_CYAN, rings=6, segments=10))
    for i in range(3):
        p.append(N.cylinder(f"ring{i}", (0.0, 0.0, 0.0), 1.5, 0.06, 16, N.MAT_CYAN, axis="Y", rotation=(i * 40, 0, i * 30)))
    return p


# ---------------------------------------------------------------------------
# Pickups
# ---------------------------------------------------------------------------


def pickup_health() -> list:
    p: list = []
    p.append(N.box("case", (0.0, 0.0, 0.0), (0.5, 0.5, 0.28), N.MAT_BODY_LIGHT))
    p.append(N.box("cross_v", (0.0, 0.0, -0.16), (0.14, 0.38, 0.05), N.MAT_LIME))
    p.append(N.box("cross_h", (0.0, 0.0, -0.16), (0.38, 0.14, 0.05), N.MAT_LIME))
    p.append(N.box("trim", (0.0, 0.0, 0.0), (0.54, 0.54, 0.10), N.MAT_TRIM))
    return p


def pickup_shield() -> list:
    p: list = []
    p.append(N.box("plate", (0.0, 0.0, 0.0), (0.46, 0.56, 0.16), N.MAT_BODY_DARK, taper=(0.4, 0.6)))
    p.append(N.box("glow", (0.0, 0.0, -0.10), (0.34, 0.42, 0.05), N.MAT_CYAN, taper=(0.4, 0.6)))
    p.append(N.box("boss", (0.0, 0.0, -0.14), (0.14, 0.14, 0.06), N.MAT_WHITE))
    return p


def pickup_ammo() -> list:
    p: list = []
    p.append(N.box("case", (0.0, 0.0, 0.0), (0.58, 0.32, 0.36), N.MAT_BODY_DARK))
    p.append(N.box("lid", (0.0, 0.19, 0.0), (0.62, 0.08, 0.40), N.MAT_TRIM))
    p.append(N.box("handle", (0.0, 0.27, 0.0), (0.22, 0.08, 0.06), N.MAT_TRIM))
    for i in range(3):
        p.append(N.box(f"cell{i}", (-0.16 + i * 0.16, -0.02, -0.19), (0.10, 0.20, 0.03), N.MAT_AMBER))
    return p


def pickup_pedestal() -> list:
    """Shared plinth under every weapon pickup so they read as intentional."""
    p: list = []
    p.append(N.cylinder("base", (0.0, 0.06, 0.0), 0.55, 0.12, 10, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("ring", (0.0, 0.14, 0.0), 0.48, 0.05, 10, N.MAT_CYAN, axis="Y"))
    p.append(N.cylinder("column", (0.0, 0.28, 0.0), 0.16, 0.32, 8, N.MAT_TRIM, axis="Y"))
    for i in range(4):
        a = (i / 4) * math.tau
        p.append(N.box(f"prong{i}", (math.cos(a) * 0.34, 0.20, math.sin(a) * 0.34), (0.08, 0.24, 0.08), N.MAT_TRIM))
    return p


# ---------------------------------------------------------------------------
# Objectives + deployables
# ---------------------------------------------------------------------------


def obj_zone_marker() -> list:
    p: list = []
    p.append(N.cylinder("base", (0.0, 0.08, 0.0), 1.1, 0.16, 12, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("ring", (0.0, 0.18, 0.0), 1.0, 0.06, 12, N.MAT_TEAM, axis="Y"))
    p.append(N.cylinder("pillar", (0.0, 1.1, 0.0), 0.24, 2.0, 8, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.box("panel", (0.0, 2.0, 0.0), (0.9, 0.9, 0.08), N.MAT_TEAM))
    p.append(N.box("panel_frame", (0.0, 2.0, 0.0), (1.0, 1.0, 0.04), N.MAT_TRIM))
    for i in range(4):
        a = (i / 4) * math.tau
        p.append(N.box(f"fin{i}", (math.cos(a) * 0.5, 0.6, math.sin(a) * 0.5), (0.12, 0.7, 0.12), N.MAT_TRIM))
    return p


def obj_core() -> list:
    """The stealable power core: a caged octahedral cell."""
    p: list = []
    p.append(N.sphere("cell", (0.0, 0.55, 0.0), 0.34, N.MAT_WHITE, rings=4, segments=6))
    p.append(N.sphere("shell", (0.0, 0.55, 0.0), 0.46, N.MAT_GLASS, rings=6, segments=8))
    for i in range(4):
        a = (i / 4) * math.tau
        p.append(
            N.box(
                f"cage{i}",
                (math.cos(a) * 0.44, 0.55, math.sin(a) * 0.44),
                (0.08, 0.94, 0.08),
                N.MAT_TRIM,
                rotation=(0, -math.degrees(a), 0),
            )
        )
    p.append(N.cylinder("collar_top", (0.0, 1.02, 0.0), 0.30, 0.10, 8, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("collar_bottom", (0.0, 0.08, 0.0), 0.36, 0.16, 8, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("collar_glow", (0.0, 0.17, 0.0), 0.32, 0.04, 8, N.MAT_CYAN, axis="Y"))
    return p


def dep_turret() -> list:
    p: list = []
    p.append(N.cylinder("base", (0.0, 0.10, 0.0), 0.42, 0.20, 8, N.MAT_BODY_DARK, axis="Y"))
    for i in range(3):
        a = (i / 3) * math.tau
        p.append(N.box(f"leg{i}", (math.cos(a) * 0.42, 0.10, math.sin(a) * 0.42), (0.16, 0.16, 0.34), N.MAT_TRIM, rotation=(0, -math.degrees(a), 0)))
    p.append(N.cylinder("post", (0.0, 0.36, 0.0), 0.14, 0.34, 8, N.MAT_TRIM, axis="Y"))
    p.append(N.box("head", (0.0, 0.62, 0.0), (0.44, 0.30, 0.42), N.MAT_BODY))
    p.append(N.box("optic", (0.0, 0.66, -0.24), (0.16, 0.10, 0.06), N.MAT_LIME))
    for sx in (-1, 1):
        p.append(N.cylinder("barrel", (sx * 0.12, 0.58, -0.36), 0.05, 0.34, 6, N.MAT_TRIM, axis="Z"))
    p.append(N.box("mag", (0.0, 0.78, 0.10), (0.26, 0.18, 0.20), N.MAT_BODY_DARK))
    return p


def dep_barrier() -> list:
    p: list = []
    p.append(N.box("base", (0.0, 0.12, 0.0), (3.0, 0.24, 0.5), N.MAT_BODY_DARK))
    for sx in (-1, 1):
        p.append(N.box("post", (sx * 1.4, 1.1, 0.0), (0.24, 2.2, 0.34), N.MAT_BODY_DARK))
        p.append(N.box("post_glow", (sx * 1.4, 1.1, 0.18), (0.10, 2.0, 0.06), N.MAT_CYAN))
    p.append(N.box("field", (0.0, 1.15, 0.0), (2.8, 2.1, 0.06), N.MAT_GLASS))
    for i in range(5):
        p.append(N.box(f"scan{i}", (0.0, 0.3 + i * 0.45, 0.05), (2.7, 0.05, 0.03), N.MAT_CYAN))
    return p


def dep_field() -> list:
    p: list = []
    p.append(N.cylinder("base", (0.0, 0.12, 0.0), 0.5, 0.24, 10, N.MAT_BODY_DARK, axis="Y"))
    p.append(N.cylinder("ring", (0.0, 0.26, 0.0), 0.44, 0.06, 10, N.MAT_LIME, axis="Y"))
    p.append(N.cylinder("column", (0.0, 0.55, 0.0), 0.18, 0.6, 8, N.MAT_TRIM, axis="Y"))
    p.append(N.sphere("emitter", (0.0, 0.95, 0.0), 0.24, N.MAT_LIME, rings=5, segments=8))
    for i in range(3):
        a = (i / 3) * math.tau
        p.append(N.box(f"vane{i}", (math.cos(a) * 0.26, 0.80, math.sin(a) * 0.26), (0.08, 0.36, 0.08), N.MAT_TRIM, rotation=(0, -math.degrees(a), 18)))
    return p


def dep_dome() -> list:
    p: list = []
    p.append(N.sphere("dome", (0.0, 0.0, 0.0), 1.0, N.MAT_GLASS, rings=8, segments=14))
    for i in range(8):
        a = (i / 8) * math.tau
        p.append(N.box(f"rib{i}", (math.cos(a) * 0.99, 0.4, math.sin(a) * 0.99), (0.05, 1.2, 0.05), N.MAT_CYAN, rotation=(0, -math.degrees(a), 0)))
    p.append(N.cylinder("base_ring", (0.0, 0.02, 0.0), 1.02, 0.06, 14, N.MAT_CYAN, axis="Y"))
    return p


def dep_grenade() -> list:
    p: list = []
    p.append(N.cylinder("body", (0.0, 0.0, 0.0), 0.075, 0.20, 8, N.MAT_BODY_DARK, axis="Z"))
    p.append(N.cylinder("nose", (0.0, 0.0, -0.12), 0.065, 0.06, 8, N.MAT_TRIM, axis="Z", radius_top=0.03))
    p.append(N.cylinder("band", (0.0, 0.0, 0.0), 0.080, 0.04, 8, N.MAT_CYAN, axis="Z"))
    for i in range(4):
        a = (i / 4) * 360
        p.append(N.box(f"fin{i}", (0.0, 0.0, 0.10), (0.02, 0.10, 0.06), N.MAT_TRIM, rotation=(0, 0, a)))
    return p


def team_marker() -> list:
    """Floating diamond used for objective and teammate indicators."""
    p: list = []
    p.append(N.box("diamond", (0.0, 0.0, 0.0), (0.34, 0.34, 0.34), N.MAT_TEAM, rotation=(45, 0, 45)))
    p.append(N.box("core", (0.0, 0.0, 0.0), (0.16, 0.16, 0.16), N.MAT_WHITE, rotation=(45, 0, 45)))
    return p


PROPS = {
    "prop_reactor_ring": prop_reactor_ring,
    "prop_coolant_tank": prop_coolant_tank,
    "prop_conveyor_arm": prop_conveyor_arm,
    "prop_crane": prop_crane,
    "prop_pipe_run": prop_pipe_run,
    "prop_vent": prop_vent,
    "prop_terminal": prop_terminal,
    "prop_crate_stack": prop_crate_stack,
    "prop_barrel": prop_barrel,
    "prop_streetlight": prop_streetlight,
    "prop_hovercar": prop_hovercar,
    "prop_ac_unit": prop_ac_unit,
    "prop_antenna": prop_antenna,
    "prop_holo_sign": prop_holo_sign,
    "prop_holo_billboard": prop_holo_billboard,
    "prop_spawn_arch": prop_spawn_arch,
    "prop_strut": prop_strut,
    "prop_satellite": prop_satellite,
    "prop_spire_collar": prop_spire_collar,
    "prop_holo_globe": prop_holo_globe,
    "pickup_health": pickup_health,
    "pickup_shield": pickup_shield,
    "pickup_ammo": pickup_ammo,
    "pickup_pedestal": pickup_pedestal,
    "obj_zone_marker": obj_zone_marker,
    "obj_core": obj_core,
    "dep_turret": dep_turret,
    "dep_barrier": dep_barrier,
    "dep_field": dep_field,
    "dep_dome": dep_dome,
    "dep_grenade": dep_grenade,
    "team_marker": team_marker,
}


def build_prop(name: str) -> None:
    N.reset_scene()
    parts = PROPS[name]()
    obj = N.join(name, parts)
    N.add_uvs(obj)
    tris = N.triangle_count(obj)
    if tris > 500:
        N.decimate_copy(obj, f"{name}_LOD1", 0.4)
    N.export_glb(name)


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in PROPS else list(PROPS.keys())
    for name in targets:
        N.log(f"building prop {name}")
        build_prop(name)
    N.log(f"props complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
