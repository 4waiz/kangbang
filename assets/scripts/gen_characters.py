"""
KANG BANG - character model generator.

Six classes, each with a distinct silhouette so a player can be identified from
across the map before their team colour is even readable:

  vanguard   medium, squared pauldrons, visor band
  phantom    slim, hooded, swept back, calf blades
  titan      wide, tall, domed helm, heavy shins
  warden     medium, crested helm, shoulder crest, back-mounted field emitter
  spectre    tall and thin, single optic pod, long coat panel
  engineer   medium, backpack rig, tool arms, antenna cluster

Team colour lives on a small number of faces using the `ns_team` material; the
client recolours that material at runtime so one mesh serves both teams.

Run: blender --background --factory-startup --python assets/scripts/gen_characters.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_kang as N  # noqa: E402


# Characters are built standing on the ground plane (z = 0) and are 1.8m tall by
# default, matching PLAYER_HEIGHT so the client never needs to scale them.


def torso(parts: list, height: float, width: float, depth: float, chest_z: float, material=N.MAT_BODY) -> None:
    parts.append(N.box("pelvis", (0.0, 0.0, chest_z - height * 0.34), (width * 0.86, depth * 0.9, height * 0.26), material))
    parts.append(N.box("abdomen", (0.0, 0.0, chest_z - height * 0.14), (width * 0.82, depth * 0.86, height * 0.24), material))
    parts.append(N.box("chest", (0.0, 0.0, chest_z + height * 0.10), (width, depth, height * 0.34), material, taper=(0.94, 0.92)))
    parts.append(N.box("chest_plate", (0.0, -depth * 0.42, chest_z + height * 0.10), (width * 0.78, depth * 0.22, height * 0.28), N.MAT_BODY_DARK))
    parts.append(N.box("belt", (0.0, 0.0, chest_z - height * 0.26), (width * 0.92, depth * 0.96, height * 0.06), N.MAT_TRIM))


def legs(parts: list, hip_z: float, leg_len: float, spread: float, thickness: float, material=N.MAT_BODY) -> None:
    for side in (-1, 1):
        x = side * spread
        parts.append(N.capsule("thigh", (x, 0.0, hip_z - leg_len * 0.26), thickness, leg_len * 0.52, material, axis="Z"))
        parts.append(N.capsule("shin", (x, 0.008, hip_z - leg_len * 0.74), thickness * 0.86, leg_len * 0.50, material, axis="Z"))
        parts.append(N.box("knee", (x, -0.012, hip_z - leg_len * 0.50), (thickness * 2.1, thickness * 1.7, thickness * 1.5), N.MAT_TRIM))
        parts.append(N.box("boot", (x, -0.028, hip_z - leg_len * 0.97), (thickness * 2.2, thickness * 4.0, thickness * 1.4), N.MAT_BODY_DARK))
        parts.append(N.box("boot_sole", (x, -0.028, hip_z - leg_len * 1.02), (thickness * 2.3, thickness * 4.1, thickness * 0.5), N.MAT_RUBBER))


def arms(parts: list, shoulder_z: float, arm_len: float, spread: float, thickness: float, material=N.MAT_BODY) -> None:
    for side in (-1, 1):
        x = side * spread
        parts.append(N.capsule("upper_arm", (x, 0.0, shoulder_z - arm_len * 0.24), thickness, arm_len * 0.50, material, axis="Z"))
        parts.append(N.capsule("forearm", (x * 0.94, -0.030, shoulder_z - arm_len * 0.70), thickness * 0.86, arm_len * 0.46, material, axis="Z"))
        parts.append(N.box("elbow", (x, -0.012, shoulder_z - arm_len * 0.48), (thickness * 2.0, thickness * 1.8, thickness * 1.5), N.MAT_TRIM))
        parts.append(N.box("hand", (x * 0.92, -0.048, shoulder_z - arm_len * 0.94), (thickness * 1.7, thickness * 2.2, thickness * 1.9), N.MAT_GRIP))


def head(parts: list, neck_z: float, size: float, material=N.MAT_BODY) -> None:
    parts.append(N.box("neck", (0.0, 0.0, neck_z), (size * 0.42, size * 0.42, size * 0.30), N.MAT_TRIM))
    parts.append(N.box("skull", (0.0, 0.0, neck_z + size * 0.52), (size * 0.92, size * 1.0, size * 0.86), material, taper=(0.9, 0.9)))
    parts.append(N.box("jaw", (0.0, -size * 0.18, neck_z + size * 0.28), (size * 0.72, size * 0.62, size * 0.32), N.MAT_BODY_DARK))


# ---------------------------------------------------------------------------
# Classes
# ---------------------------------------------------------------------------


def build_vanguard() -> list:
    p: list = []
    torso(p, 0.62, 0.42, 0.26, 1.12)
    legs(p, 0.90, 0.90, 0.11, 0.062)
    arms(p, 1.42, 0.66, 0.255, 0.055)
    head(p, 1.46, 0.22)
    # Squared pauldrons - the class's read.
    for side in (-1, 1):
        p.append(N.box("pauldron", (side * 0.275, 0.0, 1.44), (0.16, 0.20, 0.13), N.MAT_BODY_DARK))
        p.append(N.box("pauldron_trim", (side * 0.275, 0.0, 1.50), (0.17, 0.21, 0.024), N.MAT_TEAM))
    p.append(N.box("visor", (0.0, -0.115, 1.66), (0.19, 0.05, 0.062), N.MAT_VISOR))
    p.append(N.box("crest", (0.0, 0.020, 1.78), (0.05, 0.16, 0.05), N.MAT_TEAM))
    p.append(N.box("chest_light", (0.0, -0.145, 1.22), (0.09, 0.03, 0.05), N.MAT_TEAM))
    p.append(N.box("backpack", (0.0, 0.150, 1.22), (0.28, 0.10, 0.30), N.MAT_BODY_DARK))
    return p


def build_phantom() -> list:
    p: list = []
    torso(p, 0.58, 0.34, 0.21, 1.10, N.MAT_BODY_DARK)
    legs(p, 0.88, 0.88, 0.095, 0.050, N.MAT_BODY_DARK)
    arms(p, 1.38, 0.64, 0.215, 0.046, N.MAT_BODY_DARK)
    head(p, 1.42, 0.20, N.MAT_BODY_DARK)
    # Hood + swept back shroud.
    p.append(N.box("hood", (0.0, 0.030, 1.66), (0.26, 0.28, 0.24), N.MAT_BODY, taper=(0.7, 0.6)))
    p.append(N.wedge("hood_tail", (0.0, 0.180, 1.50), (0.22, 0.20, 0.30), N.MAT_BODY, rotation=(-70, 0, 0)))
    p.append(N.box("face_plate", (0.0, -0.110, 1.60), (0.15, 0.06, 0.10), N.MAT_VISOR))
    p.append(N.box("optic_slit", (0.0, -0.135, 1.63), (0.13, 0.02, 0.020), N.MAT_TEAM))
    # Calf blades and a slim back pack.
    for side in (-1, 1):
        p.append(N.wedge("calf_blade", (side * 0.095, 0.070, 0.30), (0.03, 0.16, 0.22), N.MAT_TRIM, rotation=(0, 0, 0)))
        p.append(N.box("arm_fin", (side * 0.235, 0.030, 1.10), (0.02, 0.12, 0.20), N.MAT_TEAM))
    p.append(N.box("harness", (0.0, -0.100, 1.18), (0.24, 0.04, 0.08), N.MAT_TRIM))
    return p


def build_titan() -> list:
    p: list = []
    torso(p, 0.70, 0.56, 0.34, 1.16)
    legs(p, 0.92, 0.90, 0.145, 0.082)
    arms(p, 1.50, 0.68, 0.335, 0.072)
    head(p, 1.52, 0.24)
    # Dome helm + huge pauldrons.
    p.append(N.sphere("dome", (0.0, 0.0, 1.72), 0.155, N.MAT_BODY_DARK, rings=6, segments=10))
    p.append(N.box("dome_band", (0.0, 0.0, 1.66), (0.30, 0.30, 0.036), N.MAT_TEAM))
    p.append(N.box("optic_bar", (0.0, -0.145, 1.70), (0.17, 0.05, 0.045), N.MAT_VISOR))
    for side in (-1, 1):
        p.append(N.box("pauldron", (side * 0.360, 0.0, 1.50), (0.22, 0.28, 0.20), N.MAT_BODY_DARK, taper=(0.8, 0.8)))
        p.append(N.box("pauldron_spike", (side * 0.400, 0.0, 1.62), (0.10, 0.20, 0.10), N.MAT_TRIM))
        p.append(N.box("shin_plate", (side * 0.145, -0.055, 0.28), (0.16, 0.10, 0.34), N.MAT_BODY_DARK))
    p.append(N.box("chest_vent", (0.0, -0.180, 1.24), (0.26, 0.04, 0.10), N.MAT_TRIM))
    for i in range(3):
        p.append(N.box(f"vent_glow{i}", (-0.08 + i * 0.08, -0.196, 1.24), (0.05, 0.02, 0.07), N.MAT_TEAM))
    p.append(N.box("reactor", (0.0, 0.210, 1.24), (0.34, 0.14, 0.36), N.MAT_BODY_DARK))
    p.append(N.cylinder("reactor_core", (0.0, 0.284, 1.24), 0.070, 0.030, 10, N.MAT_TEAM, axis="Y"))
    return p


def build_warden() -> list:
    p: list = []
    torso(p, 0.64, 0.46, 0.28, 1.14)
    legs(p, 0.90, 0.90, 0.115, 0.066)
    arms(p, 1.44, 0.66, 0.275, 0.058)
    head(p, 1.48, 0.22)
    # Crested helm.
    p.append(N.box("helm", (0.0, 0.0, 1.68), (0.24, 0.26, 0.22), N.MAT_BODY_DARK, taper=(0.85, 0.8)))
    p.append(N.wedge("crest", (0.0, 0.0, 1.80), (0.04, 0.24, 0.13), N.MAT_TEAM, rotation=(0, 0, 0)))
    p.append(N.box("visor", (0.0, -0.130, 1.68), (0.18, 0.05, 0.070), N.MAT_VISOR))
    for side in (-1, 1):
        p.append(N.box("shoulder_crest", (side * 0.290, 0.020, 1.52), (0.14, 0.22, 0.16), N.MAT_BODY_DARK))
        p.append(N.wedge("crest_fin", (side * 0.300, 0.020, 1.64), (0.03, 0.20, 0.12), N.MAT_TEAM))
    # Back-mounted field emitter: three prongs and a ring.
    p.append(N.box("emitter_base", (0.0, 0.190, 1.30), (0.26, 0.12, 0.26), N.MAT_BODY_DARK))
    for i, off in enumerate((-0.09, 0.0, 0.09)):
        p.append(N.box(f"prong{i}", (off, 0.240, 1.48), (0.035, 0.035, 0.24), N.MAT_TRIM, rotation=(-14, 0, 0)))
        p.append(N.box(f"prong_tip{i}", (off, 0.278, 1.60), (0.045, 0.045, 0.05), N.MAT_TEAM))
    p.append(N.cylinder("field_ring", (0.0, 0.250, 1.30), 0.085, 0.022, 10, N.MAT_TEAM, axis="Y"))
    p.append(N.box("belt_kit", (0.14, -0.100, 0.96), (0.10, 0.08, 0.12), N.MAT_TRIM))
    return p


def build_spectre() -> list:
    p: list = []
    torso(p, 0.60, 0.36, 0.22, 1.14, N.MAT_BODY_LIGHT)
    legs(p, 0.90, 0.92, 0.100, 0.050, N.MAT_BODY_DARK)
    arms(p, 1.44, 0.68, 0.225, 0.046, N.MAT_BODY_LIGHT)
    head(p, 1.50, 0.20, N.MAT_BODY_LIGHT)
    # Single optic pod on the right side of the head.
    p.append(N.box("helm", (0.0, 0.0, 1.68), (0.21, 0.24, 0.20), N.MAT_BODY_DARK, taper=(0.86, 0.8)))
    p.append(N.cylinder("optic_pod", (0.085, -0.095, 1.70), 0.052, 0.110, 10, N.MAT_BODY_DARK, axis="Z", rotation=(90, 0, 0)))
    p.append(N.cylinder("optic_lens", (0.085, -0.150, 1.70), 0.042, 0.014, 10, N.MAT_TEAM, axis="Z", rotation=(90, 0, 0)))
    p.append(N.box("face_wrap", (0.0, -0.108, 1.62), (0.15, 0.05, 0.09), N.MAT_VISOR))
    # Long coat panel: the class's read at range.
    p.append(N.box("coat_back", (0.0, 0.130, 0.86), (0.34, 0.05, 0.62), N.MAT_BODY_DARK, taper=(0.7, 1.0)))
    for side in (-1, 1):
        p.append(N.box("coat_side", (side * 0.160, 0.070, 0.92), (0.05, 0.16, 0.54), N.MAT_BODY_DARK))
        p.append(N.box("shoulder_pad", (side * 0.245, 0.0, 1.46), (0.11, 0.17, 0.09), N.MAT_BODY_DARK))
    p.append(N.box("coat_trim", (0.0, 0.150, 0.58), (0.34, 0.03, 0.04), N.MAT_TEAM))
    p.append(N.box("scope_case", (-0.130, 0.120, 1.18), (0.08, 0.10, 0.30), N.MAT_TRIM))
    return p


def build_engineer() -> list:
    p: list = []
    torso(p, 0.62, 0.44, 0.28, 1.12)
    legs(p, 0.90, 0.88, 0.110, 0.064)
    arms(p, 1.42, 0.64, 0.265, 0.056)
    head(p, 1.46, 0.22)
    # Utility helm with a raised optic rig.
    p.append(N.box("helm", (0.0, 0.0, 1.66), (0.23, 0.25, 0.20), N.MAT_BODY_DARK))
    p.append(N.box("optic_rig", (0.0, -0.105, 1.72), (0.19, 0.07, 0.06), N.MAT_TRIM))
    p.append(N.box("optic_glow", (0.0, -0.140, 1.72), (0.15, 0.02, 0.035), N.MAT_TEAM))
    # Antenna cluster.
    for i, (ox, h) in enumerate(((-0.07, 0.24), (0.0, 0.32), (0.07, 0.20))):
        p.append(N.box(f"antenna{i}", (ox, 0.080, 1.82 + h * 0.5), (0.014, 0.014, h), N.MAT_TRIM))
        p.append(N.box(f"antenna_tip{i}", (ox, 0.080, 1.82 + h), (0.024, 0.024, 0.024), N.MAT_TEAM))
    # Backpack rig with tool arms.
    p.append(N.box("rig", (0.0, 0.185, 1.20), (0.34, 0.16, 0.40), N.MAT_BODY_DARK))
    p.append(N.box("rig_hatch", (0.0, 0.268, 1.20), (0.22, 0.02, 0.26), N.MAT_TRIM))
    p.append(N.box("rig_glow", (0.0, 0.272, 1.32), (0.18, 0.02, 0.05), N.MAT_TEAM))
    for side in (-1, 1):
        p.append(N.box("tool_arm", (side * 0.200, 0.230, 1.40), (0.05, 0.05, 0.26), N.MAT_TRIM, rotation=(-24, 0, 0)))
        p.append(N.box("tool_claw", (side * 0.200, 0.320, 1.52), (0.07, 0.09, 0.06), N.MAT_BODY_DARK))
        p.append(N.box("pouch", (side * 0.165, -0.090, 0.94), (0.09, 0.07, 0.13), N.MAT_TRIM))
        p.append(N.box("pauldron", (side * 0.255, 0.0, 1.45), (0.13, 0.18, 0.11), N.MAT_BODY_DARK))
    p.append(N.box("chest_screen", (0.0, -0.155, 1.20), (0.14, 0.03, 0.10), N.MAT_VISOR))
    return p


CLASSES = {
    "vanguard": build_vanguard,
    "phantom": build_phantom,
    "titan": build_titan,
    "warden": build_warden,
    "spectre": build_spectre,
    "engineer": build_engineer,
}


def build_class(class_id: str) -> None:
    N.reset_scene()
    parts = CLASSES[class_id]()
    obj = N.join(f"char_{class_id}", parts)
    N.add_uvs(obj)
    # Sockets the client uses to attach the held weapon and name plate.
    N.socket("weapon", (0.24, -0.14, 1.30))
    N.socket("nameplate", (0.0, 0.0, 2.05))
    N.socket("head", (0.0, 0.0, 1.66))
    tris = N.triangle_count(obj)
    if tris > 700:
        N.decimate_copy(obj, f"char_{class_id}_LOD1", 0.45)
    # Characters are Blender-native (Z up) but authored facing -Y; turn them so
    # they face the engine's forward (-Z) after export.
    N.reorient("face")
    N.export_glb(f"char_{class_id}")


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in CLASSES else list(CLASSES.keys())
    for class_id in targets:
        N.log(f"building character {class_id}")
        build_class(class_id)
    N.log(f"characters complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
