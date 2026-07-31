"""
KANG BANG - character model generator.

Six classes, each with a distinct silhouette so a player can be identified from
across the map before their team colour is even readable:

  vanguard   assault - plate carrier, ballistic helmet, knee pads
  phantom    recon - hooded, balaclava, light chest rig
  titan      heavy - bulky plate, full-face helmet, thigh armour
  warden     support - helmet with headset, radio pack and antenna
  spectre    marksman - lean, long coat, cap and scarf
  engineer   builder - hard hat, tool harness, backpack rig

These are people in kit, not robots. The previous set was built from stacked
boxes - a tapered box for the skull, another for the jaw - and no amount of
gear on top of that reads as a person.

What makes a body read as human, in order of how much it matters at the range
players actually see each other:

  1. PROPORTION. Roughly seven and a half heads tall, shoulders about two
     heads wide, legs a little over half the total height, elbow at the navel
     and wrist at the crotch. Get these wrong and nothing else rescues it;
     get them right and even a rough mesh reads as a person.
  2. TAPER. Nothing on a body has a constant cross-section. A thigh is thick
     at the hip and narrow at the knee, a forearm is wide and flat at the
     elbow and oval at the wrist, a waist is narrower than both the ribcage
     above it and the hips below. This is what `loft` is for.
  3. THE HEAD. Not a box: a cranium that bulges at the back, a brow, a nose
     that projects, a jaw that runs back to the ear, and a chin. It is a small
     part of the screen but it is the part the eye checks.
  4. GEAR THAT HANGS. Webbing, pouches and plates sit on top of the body and
     follow it, rather than being the body.

Team colour lives on a small number of faces using the `ns_team` material,
which the client recolours at runtime, so one mesh serves both teams. That
material must keep a non-zero emission: the client only tints materials whose
emissive is non-zero, so the emission is the hook, not a glow.

Characters are built standing on the ground plane (z = 0), Z up, facing -Y,
and are 1.82 m tall to match PLAYER_HEIGHT so the client never scales them.

Run: blender --background --factory-startup --python assets/scripts/gen_characters.py
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_kang as N  # noqa: E402


HEIGHT = 1.82

# Landmark heights, as fractions of total height. These are the standard
# artist's proportions; keeping them in one table is what stops a class
# variant from quietly drifting into a different species.
CHIN = 0.871
SHOULDER = 0.823
CHEST = 0.740
WAIST = 0.620
HIP = 0.512
KNEE = 0.285
ANKLE = 0.048


def h(fraction: float) -> float:
    return HEIGHT * fraction


def oval(hw: float, front: float, back: float, segments: int = 14,
         cx: float = 0.0, cy: float = 0.0) -> list[tuple[float, float]]:
    """
    Asymmetric ellipse: `front` and `back` differ.

    Characters face -Y, so `front` is the -Y extent. Almost nothing on a body
    is symmetric front-to-back - a skull bulges behind, a ribcage is deeper at
    the spine, a calf sits behind the shin - and one radius per side is enough
    to capture all of it.

    The reversal at the end is load-bearing. Negating y to put `front` on -Y
    also mirrors the loop, so sweeping the angle forward traces the profile
    clockwise - the opposite of `superellipse` and `ellipse`, which `loft`
    assumes. Without the reversal every part built from this - which is the
    whole body, head, helmet and all the gear - lofts inside-out, and with
    backface culling on that renders as a hole straight through the character.
    """
    points = []
    for i in range(segments):
        a = i / segments * math.tau
        c, s = math.cos(a), math.sin(a)
        y = -front * s if s > 0 else -back * s
        points.append((cx + hw * c, cy + y))
    points.reverse()
    return points


def wrap(name: str, cx: float, z_lo: float, z_hi: float, hw: float, front: float,
         back: float, material: str, cy: float = 0.0, taper: float = 0.90) -> bpy.types.Object:
    """
    A band of gear that follows a limb rather than sitting beside it.

    Pads, brassards and plates were boxes, and a box on a round arm leaves its
    four corners hanging in the air - which is exactly what made the kit read
    as floating slabs. A short loft at slightly larger radius than the limb
    underneath wraps it instead, and costs about the same.
    """
    return N.loft(name, [
        (z_lo, oval(hw * taper, front * taper, back * taper, 12, cx=cx, cy=cy)),
        (z_lo + (z_hi - z_lo) * 0.30, oval(hw, front, back, 12, cx=cx, cy=cy)),
        (z_lo + (z_hi - z_lo) * 0.70, oval(hw, front, back, 12, cx=cx, cy=cy)),
        (z_hi, oval(hw * taper, front * taper, back * taper, 12, cx=cx, cy=cy)),
    ], material, smooth=True, cap_start=False, cap_end=False)


# ---------------------------------------------------------------------------
# Body
# ---------------------------------------------------------------------------


def torso(parts: list, build: float = 1.0, cloth=N.MAT_CLOTH) -> None:
    """
    Ribcage into waist into pelvis, as one continuous lofted shell.

    `build` scales girth without touching height, which is how the heavy and
    lean classes differ from the baseline: a titan is the same 1.82 m as a
    phantom, just thicker through the chest.
    """
    b = build
    sections = [
        (h(HIP) - 0.030, oval(0.150 * b, 0.098 * b, 0.098 * b, 16)),
        (h(HIP) + 0.020, oval(0.166 * b, 0.104 * b, 0.108 * b, 16)),   # iliac crest
        (h(WAIST),       oval(0.148 * b, 0.094 * b, 0.100 * b, 16)),   # narrowest
        (h(CHEST) - 0.040, oval(0.166 * b, 0.108 * b, 0.112 * b, 16)),
        (h(CHEST) + 0.040, oval(0.178 * b, 0.116 * b, 0.114 * b, 16)),  # ribcage
        (h(SHOULDER) - 0.045, oval(0.182 * b, 0.108 * b, 0.116 * b, 16)),
        (h(SHOULDER) - 0.005, oval(0.174 * b, 0.100 * b, 0.110 * b, 16)),  # acromion
        # The trapezius is what makes a neck look attached. Without these two
        # sections the torso steps straight from a 36 cm shoulder to an 11 cm
        # neck, and the head reads as sitting on a stalk.
        (h(SHOULDER) + 0.030, oval(0.126 * b, 0.084 * b, 0.098 * b, 16)),
        (h(SHOULDER) + 0.062, oval(0.082 * b, 0.068 * b, 0.080 * b, 16)),
    ]
    parts.append(N.loft("torso", sections, cloth, smooth=True))


def neck_and_head(parts: list, skin=N.MAT_SKIN, face: bool = True,
                  build: float = 1.0) -> None:
    """Neck, skull, nose, ears, eyes. Roughly a seventh of total height."""
    z_chin = h(CHIN)
    # Starts inside the trapezius and only shows for the last 4 cm. A neck is
    # short: chin to collarbone is about half a head, not a whole one.
    parts.append(N.loft("neck", [
        (h(SHOULDER) + 0.020, oval(0.074 * build, 0.066, 0.074, 12)),
        (z_chin - 0.026,      oval(0.062 * build, 0.056, 0.066, 12)),
        (z_chin + 0.014,      oval(0.058 * build, 0.052, 0.064, 12)),
    ], skin, smooth=True))

    # Skull. Sections run chin -> crown; `front` grows through the brow and
    # falls away above it, `back` bulges at the occiput.
    #
    # Sized so the figure is about 7.4 heads tall. Textbook heroic proportion
    # is 8, but at 8 the head reads as a pinhead on a body this broad through
    # the shoulders - the ratio the eye actually judges is head width against
    # shoulder width, and that wants to sit near 1:2.6.
    head_h = 0.248
    z0 = z_chin
    sections = [
        (z0 + 0.000, oval(0.041, 0.066, 0.051, 16)),   # chin
        (z0 + 0.026, oval(0.062, 0.083, 0.075, 16)),   # jaw
        (z0 + 0.052, oval(0.075, 0.090, 0.094, 16)),   # mouth
        (z0 + 0.079, oval(0.081, 0.094, 0.105, 16)),   # cheekbone
        (z0 + 0.107, oval(0.084, 0.092, 0.111, 16)),   # eye line
        (z0 + 0.133, oval(0.084, 0.090, 0.113, 16)),   # brow
        (z0 + 0.167, oval(0.081, 0.081, 0.111, 16)),   # forehead
        (z0 + 0.203, oval(0.073, 0.068, 0.098, 16)),   # upper cranium
        (z0 + 0.233, oval(0.051, 0.047, 0.066, 16)),
        (z0 + head_h, oval(0.019, 0.017, 0.024, 16)),  # crown
    ]
    parts.append(N.loft("skull", sections, skin, smooth=True))

    if not face:
        return

    # Nose: a small wedge projecting from the brow down to the base.
    parts.append(N.loft("nose", [
        (z0 + 0.137, oval(0.011, 0.098, 0.0, 8)),
        (z0 + 0.115, oval(0.014, 0.109, 0.0, 8)),
        (z0 + 0.092, oval(0.018, 0.115, 0.0, 8)),
        (z0 + 0.079, oval(0.020, 0.107, 0.0, 8)),
    ], skin, smooth=True, cap_start=False))

    # Brow ridge and lips, as shallow bands.
    parts.append(N.box("brow", (0.0, -0.088, z0 + 0.135), (0.115, 0.021, 0.015), skin))
    parts.append(N.box("lip", (0.0, -0.083, z0 + 0.053), (0.049, 0.015, 0.013), skin))

    # Eyes, set well back into the sockets.
    #
    # The skull narrows fast off centre: at x = 30 mm its front face has already
    # pulled back to about y = -79 mm, so an eyeball centred at -70 mm with a
    # 12 mm radius pushes through the cheekbone and reads as a googly eye. Sit
    # them behind the surface and let the brow do the work - at the range
    # players actually see each other, a suggestion of an eye beats a sphere.
    for side in (-1, 1):
        parts.append(N.sphere("eye", (side * 0.031, -0.062, z0 + 0.113), 0.0120,
                              N.MAT_EYE, rings=6, segments=8))
        parts.append(N.sphere("iris", (side * 0.031, -0.070, z0 + 0.113), 0.0056,
                              N.MAT_IRIS, rings=5, segments=8))
        # Ears sit level with the eye line and the nose base.
        parts.append(N.loft("ear", [
            (z0 + 0.077, oval(0.009, 0.015, 0.017, 8, cx=side * 0.083, cy=0.015)),
            (z0 + 0.098, oval(0.012, 0.021, 0.024, 8, cx=side * 0.088, cy=0.013)),
            (z0 + 0.120, oval(0.010, 0.018, 0.020, 8, cx=side * 0.086, cy=0.011)),
        ], skin, smooth=True))


def arms(parts: list, build: float = 1.0, cloth=N.MAT_CLOTH, skin=N.MAT_SKIN,
         gloves: bool = True) -> None:
    """Upper arm with a bicep swell, forearm tapering to the wrist, hand."""
    b = build
    for side in (-1, 1):
        x = side * 0.176 * b
        # The deltoid is the top of this loft, not a separate ball on the
        # joint: a sphere parked at the shoulder reads as a pauldron even when
        # it is meant to be muscle. Starting inboard and above the joint lets
        # the cap sink into the torso instead of hovering beside it.
        parts.append(N.loft("upper_arm", [
            (h(SHOULDER) + 0.026, oval(0.048 * b, 0.050 * b, 0.050 * b, 12, cx=x * 0.80)),
            (h(SHOULDER) - 0.014, oval(0.062 * b, 0.062 * b, 0.062 * b, 12, cx=x * 0.94)),  # deltoid
            (h(SHOULDER) - 0.070, oval(0.058 * b, 0.058 * b, 0.058 * b, 12, cx=x)),
            (h(SHOULDER) - 0.130, oval(0.055 * b, 0.056 * b, 0.055 * b, 12, cx=x)),  # bicep
            (h(SHOULDER) - 0.220, oval(0.046 * b, 0.048 * b, 0.048 * b, 12, cx=x)),
            (h(SHOULDER) - 0.290, oval(0.042 * b, 0.046 * b, 0.046 * b, 12, cx=x)),  # elbow
        ], cloth, smooth=True))
        parts.append(N.loft("forearm", [
            (h(SHOULDER) - 0.292, oval(0.044 * b, 0.048 * b, 0.048 * b, 12, cx=x * 0.99)),
            (h(SHOULDER) - 0.360, oval(0.040 * b, 0.042 * b, 0.042 * b, 12, cx=x * 0.98)),
            (h(SHOULDER) - 0.450, oval(0.031 * b, 0.033 * b, 0.033 * b, 12, cx=x * 0.97)),
            (h(SHOULDER) - 0.510, oval(0.026 * b, 0.030 * b, 0.030 * b, 12, cx=x * 0.96)),  # wrist
        ], cloth if gloves else skin, smooth=True))
        # Hand: a flattened block with a thumb, not a cube.
        hand_mat = N.MAT_GRIP if gloves else skin
        parts.append(N.loft("hand", [
            (h(SHOULDER) - 0.512, oval(0.028, 0.020, 0.020, 10, cx=x * 0.96)),
            (h(SHOULDER) - 0.560, oval(0.033, 0.023, 0.023, 10, cx=x * 0.95)),
            (h(SHOULDER) - 0.625, oval(0.030, 0.020, 0.020, 10, cx=x * 0.94)),
            (h(SHOULDER) - 0.660, oval(0.022, 0.016, 0.016, 10, cx=x * 0.93)),
        ], hand_mat, smooth=True))
        parts.append(N.loft("thumb", [
            (h(SHOULDER) - 0.545, oval(0.011, 0.012, 0.012, 8, cx=x * 0.78, cy=-0.010)),
            (h(SHOULDER) - 0.590, oval(0.010, 0.011, 0.011, 8, cx=x * 0.80, cy=-0.014)),
        ], hand_mat, smooth=True))


def legs(parts: list, build: float = 1.0, cloth=N.MAT_CLOTH, boot=N.MAT_LEATHER) -> None:
    """Thigh, knee, calf with its bulge high and behind, ankle, boot."""
    b = build
    for side in (-1, 1):
        x = side * 0.092 * b
        parts.append(N.loft("thigh", [
            (h(HIP) + 0.010, oval(0.094 * b, 0.090 * b, 0.092 * b, 12, cx=x)),
            (h(HIP) - 0.090, oval(0.086 * b, 0.084 * b, 0.088 * b, 12, cx=x)),
            (h(KNEE) + 0.090, oval(0.070 * b, 0.070 * b, 0.072 * b, 12, cx=x)),
            (h(KNEE) + 0.010, oval(0.062 * b, 0.062 * b, 0.062 * b, 12, cx=x)),   # knee
        ], cloth, smooth=True))
        parts.append(N.loft("calf", [
            (h(KNEE) + 0.008, oval(0.062 * b, 0.062 * b, 0.062 * b, 12, cx=x)),
            (h(KNEE) - 0.060, oval(0.062 * b, 0.058 * b, 0.074 * b, 12, cx=x)),   # calf, set back
            (h(KNEE) - 0.140, oval(0.052 * b, 0.048 * b, 0.058 * b, 12, cx=x)),
            (h(ANKLE) + 0.020, oval(0.038 * b, 0.038 * b, 0.042 * b, 12, cx=x)),  # ankle
        ], cloth, smooth=True))
        # Boot: heel behind the ankle, toe forward, sole flat on the ground.
        parts.append(N.loft("boot", [
            (h(ANKLE) + 0.040, oval(0.046, 0.046, 0.052, 12, cx=x, cy=0.004)),
            (h(ANKLE) - 0.010, oval(0.050, 0.062, 0.062, 12, cx=x, cy=-0.006)),
            (0.030,            oval(0.052, 0.090, 0.068, 12, cx=x, cy=-0.020)),
            (0.012,            oval(0.050, 0.100, 0.066, 12, cx=x, cy=-0.026)),
        ], boot, smooth=True))
        parts.append(N.loft("sole", [
            (0.014, oval(0.052, 0.102, 0.068, 12, cx=x, cy=-0.026)),
            (0.000, oval(0.050, 0.098, 0.064, 12, cx=x, cy=-0.026)),
        ], N.MAT_RUBBER, smooth=False))


def plate_carrier(parts: list, build: float = 1.0, armor=N.MAT_ARMOR,
                  pouches: int = 3, team_patch: bool = True) -> None:
    """Front and back plates joined at the shoulders, with pouches and webbing."""
    b = build
    front_y = -0.106 * b
    parts.append(N.loft("plate_front", [
        (h(WAIST) + 0.010, oval(0.140 * b, front_y - 0.018, -front_y * 0.55, 12)),
        (h(CHEST),         oval(0.152 * b, front_y - 0.026, -front_y * 0.55, 12)),
        (h(SHOULDER) - 0.055, oval(0.140 * b, front_y - 0.020, -front_y * 0.55, 12)),
    ], armor, smooth=False))
    for i in range(pouches):
        px = (i - (pouches - 1) / 2.0) * 0.090 * b
        parts.append(N.rounded_box(f"pouch{i}", (px, front_y - 0.036, h(WAIST) + 0.055),
                                   (0.078 * b, 0.052, 0.098), N.MAT_CLOTH_DARK, radius=0.008))
    parts.append(N.box("cummerbund", (0.0, 0.0, h(WAIST) - 0.020),
                       (0.320 * b, 0.230 * b, 0.060), N.MAT_CLOTH_DARK))
    for side in (-1, 1):
        parts.append(N.box("shoulder_strap", (side * 0.096 * b, -0.010, h(SHOULDER) - 0.030),
                           (0.062, 0.210 * b, 0.034), N.MAT_CLOTH_DARK))
    if team_patch:
        # Chest patch and both shoulder brassards carry the team colour. The
        # brassards are bands round the arm, not plates beside it.
        parts.append(N.box("team_chest", (0.082 * b, front_y - 0.030, h(CHEST) + 0.030),
                           (0.062, 0.014, 0.044), N.MAT_TEAM))
        for side in (-1, 1):
            parts.append(wrap("team_brassard", side * 0.176 * b,
                              h(SHOULDER) - 0.112, h(SHOULDER) - 0.070,
                              0.059 * b, 0.060 * b, 0.059 * b, N.MAT_TEAM))


def helmet(parts: list, style: str = "ballistic", shell=N.MAT_ARMOR,
           team_band: bool = True) -> None:
    """Helmet shell over the skull, with a brim, rails and a nape pad."""
    z0 = h(CHIN)
    # A dome that reaches down past the ears and the nape, then has the face
    # opening cut out of it. A loft alone cannot do this: the shell has to sit
    # low at the back and sides but stop at the brow in front, and every
    # section of a loft is a single flat ring at one height. Cutting the
    # opening afterwards also gives a real brow edge with thickness, which is
    # most of what makes a helmet look like it is worn rather than balanced.
    dome = N.loft("helmet", [
        (z0 + 0.062, oval(0.106, 0.102, 0.132, 18)),   # nape
        (z0 + 0.103, oval(0.114, 0.111, 0.141, 18)),
        (z0 + 0.150, oval(0.115, 0.111, 0.141, 18)),
        (z0 + 0.193, oval(0.106, 0.102, 0.128, 18)),
        (z0 + 0.231, oval(0.083, 0.079, 0.098, 18)),
        (z0 + 0.265, oval(0.034, 0.032, 0.041, 18)),
    ], shell, smooth=True)
    # Face opening: everything forward of the ears and below the brow.
    opening = N.box("face_cut", (0.0, -0.155, z0 + 0.056), (0.200, 0.190, 0.170), shell)
    parts.append(N.weld(N.boolean(dome, opening)))

    # Side accessory rails and an NVG shroud - the modern-helmet read.
    for side in (-1, 1):
        parts.append(N.box("helmet_rail", (side * 0.105, -0.010, z0 + 0.150),
                           (0.014, 0.155, 0.030), N.MAT_TRIM))
    parts.append(N.box("nvg_shroud", (0.0, -0.108, z0 + 0.160), (0.046, 0.034, 0.028), N.MAT_TRIM))
    if team_band:
        parts.append(N.box("team_band", (0.0, 0.112, z0 + 0.156), (0.110, 0.036, 0.052), N.MAT_TEAM))
    if style == "visor":
        # Flipped-up visor resting on the brow.
        parts.append(N.loft("visor", [
            (z0 + 0.160, oval(0.108, 0.124, 0.040, 14)),
            (z0 + 0.199, oval(0.108, 0.122, 0.040, 14)),
        ], N.MAT_VISOR, smooth=True, cap_start=False, cap_end=False))
    elif style == "fullface":
        # Mandible guard across the jaw, leaving an eye band open.
        parts.append(N.loft("mandible", [
            (z0 + 0.015, oval(0.062, 0.086, 0.030, 14)),
            (z0 + 0.053, oval(0.084, 0.103, 0.030, 14)),
            (z0 + 0.088, oval(0.096, 0.107, 0.030, 14)),
        ], shell, smooth=True, cap_start=False, cap_end=False))
        parts.append(N.loft("eye_band", [
            (z0 + 0.092, oval(0.098, 0.109, 0.030, 14)),
            (z0 + 0.131, oval(0.103, 0.111, 0.030, 14)),
        ], N.MAT_VISOR, smooth=True, cap_start=False, cap_end=False))


# ---------------------------------------------------------------------------
# Classes
# ---------------------------------------------------------------------------


def build_vanguard() -> list:
    """Assault. The baseline build - everything else is read against this."""
    p: list = []
    torso(p)
    legs(p)
    arms(p)
    neck_and_head(p)
    plate_carrier(p)
    helmet(p, style="visor")
    for side in (-1, 1):
        p.append(wrap("knee_pad", side * 0.092, h(KNEE) - 0.044, h(KNEE) + 0.068,
                      0.070, 0.076, 0.066, N.MAT_ARMOR))
        p.append(wrap("elbow_pad", side * 0.176, h(SHOULDER) - 0.328, h(SHOULDER) - 0.250,
                      0.050, 0.056, 0.052, N.MAT_ARMOR))
    p.append(N.rounded_box("dump_pouch", (0.128, 0.052, h(HIP) + 0.050),
                           (0.086, 0.078, 0.130), N.MAT_CLOTH_DARK, radius=0.010))
    return p


def build_phantom() -> list:
    """Recon. Slim, hooded, no helmet - the lightest outline in the set."""
    p: list = []
    torso(p, build=0.92, cloth=N.MAT_CLOTH_DARK)
    legs(p, build=0.92, cloth=N.MAT_CLOTH_DARK)
    arms(p, build=0.92, cloth=N.MAT_CLOTH_DARK)
    neck_and_head(p, face=False, build=0.92)
    # Balaclava over the whole head, with the eye slit cut as a band.
    z0 = h(CHIN)
    p.append(N.loft("balaclava", [
        (z0 - 0.010, oval(0.056, 0.066, 0.060, 14)),
        (z0 + 0.026, oval(0.062, 0.082, 0.074, 14)),
        (z0 + 0.074, oval(0.080, 0.090, 0.100, 14)),
        (z0 + 0.124, oval(0.082, 0.088, 0.110, 14)),
        (z0 + 0.180, oval(0.078, 0.078, 0.106, 14)),
        (z0 + 0.226, oval(0.044, 0.042, 0.058, 14)),
    ], N.MAT_CLOTH_DARK, smooth=True))
    p.append(N.box("eye_slit", (0.0, -0.084, z0 + 0.106), (0.126, 0.020, 0.030), N.MAT_VISOR))
    # Hood, pushed back off the head.
    p.append(N.loft("hood", [
        (h(SHOULDER) - 0.020, oval(0.126, 0.040, 0.150, 14, cy=0.046)),
        (z0 + 0.060, oval(0.116, 0.030, 0.144, 14, cy=0.050)),
        (z0 + 0.150, oval(0.104, 0.020, 0.130, 14, cy=0.046)),
        (z0 + 0.212, oval(0.062, 0.010, 0.078, 14, cy=0.038)),
    ], N.MAT_CLOTH_DARK, smooth=True))
    # Light chest rig instead of a plate carrier.
    p.append(N.box("chest_rig", (0.0, -0.104, h(CHEST) - 0.010), (0.230, 0.048, 0.180), N.MAT_CLOTH_DARK))
    for i in range(3):
        p.append(N.rounded_box(f"mag_pouch{i}", ((i - 1) * 0.078, -0.128, h(CHEST) - 0.020),
                               (0.068, 0.044, 0.104), N.MAT_CLOTH, radius=0.008))
    for side in (-1, 1):
        p.append(wrap("team_brassard", side * 0.162, h(SHOULDER) - 0.110, h(SHOULDER) - 0.068,
                      0.054, 0.055, 0.054, N.MAT_TEAM))
    for side in (-1, 1):
        p.append(N.rounded_box("thigh_holster", (side * 0.106, -0.038, h(HIP) - 0.130),
                               (0.070, 0.060, 0.150), N.MAT_CLOTH_DARK, radius=0.010))
    return p


def build_titan() -> list:
    """Heavy. Same height, much more mass - the widest outline."""
    p: list = []
    torso(p, build=1.22)
    legs(p, build=1.18)
    arms(p, build=1.20)
    neck_and_head(p, face=False, build=1.10)
    plate_carrier(p, build=1.24, pouches=4)
    helmet(p, style="fullface")
    # Heavy shoulder plates and thigh armour.
    for side in (-1, 1):
        p.append(N.loft("pauldron", [
            (h(SHOULDER) + 0.020, oval(0.104, 0.098, 0.098, 12, cx=side * 0.200)),
            (h(SHOULDER) - 0.060, oval(0.116, 0.108, 0.108, 12, cx=side * 0.212)),
            (h(SHOULDER) - 0.140, oval(0.098, 0.092, 0.092, 12, cx=side * 0.216)),
        ], N.MAT_ARMOR, smooth=True))
        p.append(wrap("thigh_plate", side * 0.109, h(HIP) - 0.215, h(HIP) - 0.005,
                      0.104, 0.104, 0.098, N.MAT_ARMOR))
        p.append(wrap("shin_plate", side * 0.104, h(KNEE) - 0.190, h(KNEE) - 0.020,
                      0.072, 0.072, 0.074, N.MAT_ARMOR))
        p.append(wrap("knee_pad", side * 0.104, h(KNEE) - 0.048, h(KNEE) + 0.074,
                      0.080, 0.086, 0.076, N.MAT_ARMOR))
    # Back plate carrier with a hydration bladder.
    p.append(N.rounded_box("back_pack", (0.0, 0.148, h(CHEST) + 0.010),
                           (0.300, 0.110, 0.360), N.MAT_CLOTH_DARK, radius=0.020))
    p.append(N.box("team_stripe", (0.0, 0.204, h(CHEST) + 0.090), (0.200, 0.020, 0.048), N.MAT_TEAM))
    return p


def build_warden() -> list:
    """Support. Radio pack, antenna and a headset - the tallest read."""
    p: list = []
    torso(p, build=1.04)
    legs(p, build=1.02)
    arms(p, build=1.02)
    neck_and_head(p)
    plate_carrier(p, build=1.06)
    helmet(p, style="ballistic")
    # Headset over the helmet.
    z0 = h(CHIN)
    for side in (-1, 1):
        p.append(N.lathe("ear_cup", [(0.0, 0.0), (0.042, 0.0), (0.042, 0.026), (0.032, 0.032)],
                         N.MAT_CLOTH_DARK, 12, (0.0, 0.0)))
        p[-1].location = (side * 0.096, -0.008, z0 + 0.116)
        p[-1].rotation_euler = (0.0, math.radians(side * 90), 0.0)
    p.append(N.box("boom_mic", (-0.086, -0.062, z0 + 0.098), (0.016, 0.090, 0.014),
                   N.MAT_TRIM, rotation=(0, 0, -22)))
    # Radio pack with a whip antenna.
    p.append(N.rounded_box("radio_pack", (0.0, 0.150, h(CHEST)),
                           (0.260, 0.108, 0.320), N.MAT_CLOTH_DARK, radius=0.016))
    p.append(N.lathe("antenna", [(0.0060, 0.0), (0.0060, 0.340), (0.0030, 0.400)],
                     N.MAT_TRIM, 8, (0.0, 0.0)))
    p[-1].location = (0.092, 0.190, h(CHEST) + 0.150)
    p[-1].rotation_euler = (math.radians(-8), 0.0, 0.0)
    p.append(N.box("team_backplate", (0.0, 0.206, h(CHEST) + 0.070), (0.180, 0.020, 0.056), N.MAT_TEAM))
    for side in (-1, 1):
        p.append(wrap("knee_pad", side * 0.094, h(KNEE) - 0.044, h(KNEE) + 0.068,
                      0.071, 0.077, 0.067, N.MAT_ARMOR))
    return p


def build_spectre() -> list:
    """Marksman. Lean, long coat, cap and scarf - unmistakable at range."""
    p: list = []
    torso(p, build=0.94, cloth=N.MAT_CLOTH)
    legs(p, build=0.94, cloth=N.MAT_CLOTH_DARK)
    arms(p, build=0.94)
    neck_and_head(p, build=0.96)
    # Long coat: skirts from the waist to below the knee, flaring as it falls.
    p.append(N.loft("coat", [
        (h(SHOULDER) - 0.010, oval(0.184, 0.116, 0.124, 16)),
        (h(CHEST),            oval(0.192, 0.124, 0.130, 16)),
        (h(WAIST),            oval(0.180, 0.118, 0.126, 16)),
        (h(HIP),              oval(0.196, 0.130, 0.140, 16)),
        (h(KNEE) + 0.140,     oval(0.208, 0.140, 0.152, 16)),
        (h(KNEE) - 0.020,     oval(0.214, 0.146, 0.158, 16)),
    ], N.MAT_CLOTH_DARK, smooth=True, cap_start=False, cap_end=False))
    # Standing collar: a flared band round the neck, following the coat's own
    # cross-section rather than a box parked on the shoulders.
    p.append(N.loft("coat_collar", [
        (h(SHOULDER) - 0.014, oval(0.116, 0.084, 0.100, 14)),
        (h(SHOULDER) + 0.030, oval(0.098, 0.076, 0.092, 14)),
        (h(SHOULDER) + 0.078, oval(0.094, 0.076, 0.090, 14)),
    ], N.MAT_CLOTH_DARK, smooth=True, cap_start=False, cap_end=False))
    # Scarf and a peaked cap instead of a helmet.
    z0 = h(CHIN)
    p.append(N.loft("scarf", [
        (z0 - 0.030, oval(0.074, 0.070, 0.078, 12)),
        (z0 + 0.014, oval(0.068, 0.078, 0.072, 12)),
    ], N.MAT_CLOTH, smooth=True))
    p.append(N.loft("cap", [
        (z0 + 0.148, oval(0.086, 0.084, 0.104, 14)),
        (z0 + 0.196, oval(0.080, 0.078, 0.096, 14)),
        (z0 + 0.228, oval(0.042, 0.040, 0.050, 14)),
    ], N.MAT_CLOTH, smooth=True))
    p.append(N.box("cap_brim", (0.0, -0.116, z0 + 0.150), (0.150, 0.086, 0.014),
                   N.MAT_CLOTH, rotation=(-8, 0, 0)))
    p.append(N.box("team_cap_patch", (0.0, -0.078, z0 + 0.176), (0.052, 0.024, 0.030), N.MAT_TEAM))
    # Chest bandolier and a rifle case slung on the back.
    p.append(N.box("bandolier", (0.0, -0.100, h(CHEST)), (0.230, 0.044, 0.056),
                   N.MAT_LEATHER, rotation=(0, 0, 24)))
    p.append(N.rounded_box("rifle_case", (-0.110, 0.152, h(CHEST) - 0.020),
                           (0.098, 0.098, 0.560), N.MAT_CLOTH_DARK, radius=0.016,
                           rotation=(0, 0, 14)))
    p.append(wrap("team_brassard", 0.166, h(SHOULDER) - 0.110, h(SHOULDER) - 0.068,
                  0.055, 0.056, 0.055, N.MAT_TEAM))
    return p


def build_engineer() -> list:
    """Builder. Hard hat, tool harness, backpack rig."""
    p: list = []
    torso(p, build=1.06)
    legs(p, build=1.04)
    arms(p, build=1.04)
    neck_and_head(p)
    # Hard hat with a brim all round and a crown rib.
    z0 = h(CHIN)
    p.append(N.loft("hard_hat", [
        (z0 + 0.132, oval(0.098, 0.098, 0.116, 16)),
        (z0 + 0.176, oval(0.094, 0.092, 0.110, 16)),
        (z0 + 0.216, oval(0.070, 0.068, 0.082, 16)),
        (z0 + 0.242, oval(0.030, 0.028, 0.034, 16)),
    ], N.MAT_HAZARD, smooth=True))
    p.append(N.loft("hat_brim", [
        (z0 + 0.128, oval(0.118, 0.132, 0.128, 16, cy=-0.008)),
        (z0 + 0.140, oval(0.114, 0.126, 0.124, 16, cy=-0.008)),
    ], N.MAT_HAZARD, smooth=False))
    p.append(N.box("hat_rib", (0.0, 0.0, z0 + 0.212), (0.026, 0.200, 0.030), N.MAT_HAZARD))
    p.append(N.box("head_lamp", (0.0, -0.116, z0 + 0.146), (0.048, 0.030, 0.034), N.MAT_TRIM))
    # High-vis vest over the uniform.
    #
    # These radii have to clear the torso underneath, which is built at
    # build=1.06 - so the widest torso section is 0.193, not the 0.182 in the
    # base table. Sizing the vest off the base numbers buried it inside the
    # body, where it rendered as nothing at all rather than as anything
    # obviously wrong.
    p.append(N.loft("hi_vis", [
        (h(WAIST) - 0.020, oval(0.170, 0.112, 0.118, 14)),
        (h(CHEST),         oval(0.198, 0.130, 0.130, 14)),
        (h(SHOULDER) - 0.050, oval(0.205, 0.126, 0.132, 14)),
    ], N.MAT_HAZARD, smooth=True, cap_start=False, cap_end=False))
    for zz, r in ((h(CHEST) + 0.050, 0.204), (h(WAIST) + 0.030, 0.182)):
        p.append(N.loft("vis_stripe", [
            (zz - 0.018, oval(r, r * 0.66, r * 0.67, 14)),
            (zz + 0.018, oval(r, r * 0.66, r * 0.67, 14)),
        ], N.MAT_WHITE, smooth=True, cap_start=False, cap_end=False))
    # Tool belt with hanging tools.
    p.append(wrap("tool_belt", 0.0, h(HIP) + 0.012, h(HIP) + 0.068,
                  0.186, 0.122, 0.126, N.MAT_LEATHER, taper=0.96))
    for i, (ox, oy, hgt) in enumerate(((0.150, -0.040, 0.140), (0.150, 0.060, 0.110), (-0.150, 0.020, 0.130))):
        p.append(N.rounded_box(f"tool{i}", (ox, oy, h(HIP) - hgt * 0.4),
                               (0.052, 0.052, hgt), N.MAT_TRIM, radius=0.008))
    # Backpack rig with a spool.
    p.append(N.rounded_box("rig", (0.0, 0.158, h(CHEST) + 0.010),
                           (0.290, 0.126, 0.380), N.MAT_CLOTH_DARK, radius=0.018))
    p.append(N.lathe("spool", [(0.0, -0.030), (0.062, -0.030), (0.062, 0.030), (0.0, 0.030)],
                     N.MAT_TRIM, 14, (0.0, 0.0)))
    p[-1].location = (0.0, 0.234, h(CHEST) + 0.070)
    p[-1].rotation_euler = (math.radians(90), 0.0, 0.0)
    p.append(N.box("team_backplate", (0.0, 0.222, h(CHEST) - 0.110), (0.190, 0.020, 0.056), N.MAT_TEAM))
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
    # Sockets the client uses to attach the held weapon and name plate.
    N.socket("weapon", (0.24, -0.14, 1.30))
    N.socket("nameplate", (0.0, 0.0, 2.05))
    N.socket("head", (0.0, 0.0, h(CHIN) + 0.116))
    # Characters are Blender-native (Z up) but authored facing -Y; `finish`
    # turns them so they face the engine's forward (-Z) after export.
    N.finish(f"char_{class_id}", parts, smooth_angle=48.0,
             lod_threshold=3000, lod_ratio=0.35, orient="face")


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in CLASSES else list(CLASSES.keys())
    for class_id in targets:
        N.log(f"building character {class_id}")
        build_class(class_id)
    N.log(f"characters complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
