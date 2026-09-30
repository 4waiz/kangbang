"""
KANG BANG - stylised nature generator.

Trees, rocks, foliage and rustic timber, in the hand-painted style: saturated
colour, matte surfaces, chunky rounded silhouettes. These are what turn a
greybox arena into somewhere that looks like a place.

What actually makes foliage read as hand-painted rather than as low-poly
programmer art, roughly in order of value:

  1. CLUSTERED MASSES, NOT ONE BLOB. A canopy is three or four overlapping
     ellipsoids at different sizes and heights. One sphere reads as a
     lollipop; four read as a tree, and the cost is the same.
  2. TWO GREENS. The lower and inner masses take the darker green. That fakes
     self-shadowing at no cost, and without it a canopy is a flat plastic
     shape no matter how good its silhouette is.
  3. FLAT SHADING ON ROCK, SMOOTH ON FOLIAGE. Faceted stone catches a
     different value on every plane, which is exactly the look; foliage wants
     the opposite so its masses merge into one soft form.
  4. NOTHING PERFECTLY VERTICAL OR SYMMETRIC. Trunks lean a few degrees and
     canopies sit off-centre. Perfect symmetry is the tell of a generated
     asset.

Every asset is authored +Y up, -Z forward, in metres, with ground contact at
y = 0, matching the props convention - the client places them at the map's Y
directly.

Run: blender --background --factory-startup --python assets/scripts/gen_nature.py
     (optionally  -- --only=tree_round )
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_kang as N  # noqa: E402


# Deterministic pseudo-random. The generators must produce byte-identical
# output on every run or the committed GLBs churn on every build, so this is
# seeded arithmetic rather than `random`.
def rnd(seed: int, index: int) -> float:
    """Stable value in [0, 1) from a seed and an index."""
    x = math.sin(seed * 127.1 + index * 311.7) * 43758.5453
    return x - math.floor(x)


def jitter(seed: int, index: int, amount: float) -> float:
    """Stable value in [-amount, +amount]."""
    return (rnd(seed, index) * 2.0 - 1.0) * amount


# ---------------------------------------------------------------------------
# Shared pieces
# ---------------------------------------------------------------------------


def blob(name: str, cx: float, cy: float, cz: float, rx: float, ry: float, rz: float,
         material: str, seed: int = 0, rough: float = 0.10) -> bpy.types.Object:
    """
    An irregular ellipsoid. The unit of foliage and of rock.

    The per-vertex displacement is what stops these reading as spheres. It is
    applied to the mesh data rather than as a modifier so the result is exact
    and reproducible.
    """
    obj = N.sphere(name, (cx, cy, cz), 1.0, material, rings=8, segments=12,
                   scale=(rx, ry, rz))
    for i, vert in enumerate(obj.data.vertices):
        vert.co.x *= 1.0 + jitter(seed, i * 3 + 0, rough)
        vert.co.y *= 1.0 + jitter(seed, i * 3 + 1, rough)
        vert.co.z *= 1.0 + jitter(seed, i * 3 + 2, rough)
    obj.data.update()
    return obj


def trunk(name: str, height: float, base_r: float, top_r: float, material=N.MAT_BARK,
          lean: float = 0.0, seed: int = 0, segments: int = 8) -> bpy.types.Object:
    """
    Tapered trunk with a flared root and a slight lean.

    The flare at the base matters more than it sounds: a cylinder meeting the
    ground at a hard right angle is the clearest sign of a generated tree, and
    widening the bottom two sections fixes it for four extra rings.
    """
    steps = 6
    sections = []
    for i in range(steps + 1):
        t = i / steps
        # Flare hard over the bottom fifth, then taper steadily.
        flare = 1.0 + max(0.0, (0.20 - t) / 0.20) ** 2 * 0.85
        r = (base_r + (top_r - base_r) * t) * flare
        drift = lean * t * t + jitter(seed, i, 0.012)
        sections.append((t * height, N.ellipse(r, r, segments, cx=drift, cy=drift * 0.4)))
    return N.loft(name, sections, material, smooth=True, axis="Y")


def canopy(parts: list, cx: float, cy: float, cz: float, size: float, seed: int,
           masses: int = 4, light: bool = False) -> None:
    """
    A cluster of overlapping ellipsoids, darker underneath.

    The vertical split is the whole trick: masses in the lower half of the
    cluster take the dark green, so the canopy has a shaded underside without
    any lighting having to produce one.
    """
    layout = [
        (0.00, 0.00, 0.00, 1.00),
        (-0.62, -0.22, 0.30, 0.68),
        (0.58, -0.16, -0.26, 0.72),
        (0.10, 0.34, 0.52, 0.62),
        (-0.30, 0.30, -0.54, 0.58),
        (0.44, -0.34, 0.48, 0.52),
    ]
    for i in range(min(masses, len(layout))):
        ox, oy, oz, scale = layout[i]
        r = size * scale
        x = cx + ox * size + jitter(seed, i * 4, size * 0.10)
        y = cy + oy * size + jitter(seed, i * 4 + 1, size * 0.08)
        z = cz + oz * size + jitter(seed, i * 4 + 2, size * 0.10)
        # Lower masses read as shaded, upper as lit.
        if oy < -0.05:
            mat = N.MAT_FOLIAGE_DARK
        elif light and oy > 0.2:
            mat = N.MAT_FOLIAGE_LIGHT
        else:
            mat = N.MAT_FOLIAGE
        parts.append(blob(f"canopy{i}", x, y, z, r, r * 0.86, r, mat, seed + i, 0.13))


# ---------------------------------------------------------------------------
# Trees
# ---------------------------------------------------------------------------


def tree_round() -> list:
    """Broadleaf. The default tree - rounded, full, slightly leaning."""
    p = []
    h = 3.4
    p.append(trunk("trunk", h, 0.19, 0.10, N.MAT_BARK, lean=0.16, seed=11))
    # Two limbs, so the trunk does not vanish straight into the canopy.
    for i, (ax, az, ay) in enumerate(((0.6, 0.3, 2.1), (-0.5, -0.4, 2.5))):
        limb = N.loft(f"limb{i}", [
            (0.0, N.ellipse(0.070, 0.070, 6)),
            (0.55, N.ellipse(0.045, 0.045, 6, cx=ax * 0.5, cy=az * 0.5)),
            (0.95, N.ellipse(0.030, 0.030, 6, cx=ax, cy=az)),
        ], N.MAT_BARK, smooth=True, axis="Y")
        for vert in limb.data.vertices:
            vert.co.y += ay
        limb.data.update()
        p.append(limb)
    canopy(p, 0.16, h + 0.62, 0.0, 1.28, seed=11, masses=5, light=True)
    return p


def tree_pine() -> list:
    """Conifer. Stacked cones, tall and narrow - the contrast silhouette."""
    p = []
    h = 4.6
    p.append(trunk("trunk", h * 0.42, 0.17, 0.10, N.MAT_BARK, lean=0.05, seed=23))
    tiers = 4
    for i in range(tiers):
        t = i / (tiers - 1)
        y = h * 0.30 + t * h * 0.62
        r = 1.22 * (1.0 - t * 0.66)
        mat = N.MAT_FOLIAGE_DARK if i % 2 == 0 else N.MAT_FOLIAGE
        cone = N.lathe(f"tier{i}", [
            (0.0, y + r * 1.05),
            (r * 0.55, y + r * 0.42),
            (r, y),
            (r * 0.72, y - r * 0.16),
            (0.0, y - r * 0.16),
        ], mat, 12, center=(0.0, 0.0))
        # Lathe builds about Z; these are authored +Y up.
        cone.rotation_euler = (math.radians(-90), 0.0, 0.0)
        for vert in cone.data.vertices:
            vert.co.x += jitter(23, i * 7 + 1, 0.05)
        cone.data.update()
        p.append(cone)
    return p


def tree_palm() -> list:
    """Palm. Curved trunk and a radial crown - reads instantly as coast."""
    p = []
    h = 5.2
    steps = 8
    sections = []
    for i in range(steps + 1):
        t = i / steps
        r = 0.155 - t * 0.055
        # Trunks bow, they do not lean linearly.
        bend = math.sin(t * math.pi * 0.5) * 0.85
        sections.append((t * h, N.ellipse(r, r, 8, cx=bend)))
    p.append(N.loft("trunk", sections, N.MAT_BARK_LIGHT, smooth=True, axis="Y"))
    # Ring scars up the trunk.
    for i in range(7):
        t = 0.14 + i * 0.11
        ring = N.lathe(f"scar{i}", [(0.152 - t * 0.05, -0.028), (0.168 - t * 0.05, 0.0),
                                    (0.152 - t * 0.05, 0.028)], N.MAT_BARK, 8)
        ring.rotation_euler = (math.radians(-90), 0.0, 0.0)
        ring.location = (math.sin(t * math.pi * 0.5) * 0.85, t * h, 0.0)
        p.append(ring)

    top_x, top_y = 0.85, h
    for i in range(7):
        a = i / 7 * math.tau
        droop = 0.62 + rnd(37, i) * 0.28
        frond = N.loft(f"frond{i}", [
            (0.00, N.ellipse(0.030, 0.016, 6)),
            (0.34, N.ellipse(0.150, 0.022, 6, cy=-0.10 * droop)),
            (0.70, N.ellipse(0.185, 0.020, 6, cy=-0.42 * droop)),
            (1.00, N.ellipse(0.045, 0.012, 6, cy=-0.95 * droop)),
        ], N.MAT_FOLIAGE if i % 2 else N.MAT_FOLIAGE_DARK, smooth=True, axis="X")
        for vert in frond.data.vertices:
            vert.co.x *= 1.65
        frond.data.update()
        frond.rotation_euler = (0.0, a, 0.0)
        frond.location = (top_x, top_y, 0.0)
        p.append(frond)
    # Coconut cluster.
    for i in range(3):
        a = i / 3 * math.tau
        p.append(N.sphere(f"nut{i}", (top_x + math.cos(a) * 0.16, top_y - 0.16,
                                      math.sin(a) * 0.16), 0.085, N.MAT_BARK, 6, 8))
    return p


def tree_stump() -> list:
    """Cut stump. Low cover and a height marker."""
    p = []
    p.append(trunk("stump", 0.72, 0.30, 0.26, N.MAT_BARK, seed=41, segments=10))
    p.append(N.lathe("rings", [(0.0, 0.72), (0.255, 0.725)], N.MAT_BARK_LIGHT, 12))
    p[-1].rotation_euler = (math.radians(-90), 0.0, 0.0)
    for i in range(3):
        a = i / 3 * math.tau + 0.6
        root = blob(f"root{i}", math.cos(a) * 0.30, 0.07, math.sin(a) * 0.30,
                    0.17, 0.075, 0.17, N.MAT_BARK, 41 + i, 0.16)
        p.append(root)
    return p


def log_fallen() -> list:
    """Fallen log lying along Z. Cover that also reads as a path edge."""
    p = []
    length = 3.0
    sections = []
    for i in range(7):
        t = i / 6
        r = 0.235 - abs(t - 0.5) * 0.10
        sections.append((-length / 2 + t * length,
                         N.ellipse(r, r, 8, cy=0.24 + jitter(53, i, 0.02))))
    p.append(N.loft("log", sections, N.MAT_BARK, smooth=True))
    for end in (-length / 2, length / 2):
        cap = N.lathe("cut", [(0.0, end), (0.215, end)], N.MAT_BARK_LIGHT, 10, center=(0.0, 0.24))
        p.append(cap)
    p.append(blob("moss", 0.10, 0.44, 0.30, 0.30, 0.075, 0.72, N.MAT_FOLIAGE_DARK, 53, 0.20))
    return p


# ---------------------------------------------------------------------------
# Rock
# ---------------------------------------------------------------------------


def _faceted(parts: list) -> list:
    """
    Marked here for documentation; the shading is actually decided by
    `FACETED` below.

    Calling `shade_flat` on the parts does nothing on its own: `finish()`
    joins them and then runs `smooth_by_angle`, which sets every polygon
    smooth again. Faceting has to come from the angle threshold used after the
    join, not from a flag set before it.
    """
    return parts


def rock_large() -> list:
    """Boulder. Waist-to-shoulder height, so it is real cover."""
    p = []
    p.append(blob("mass", 0.0, 0.82, 0.0, 1.30, 0.86, 1.10, N.MAT_ROCK, 71, 0.20))
    p.append(blob("shoulder", 0.62, 0.52, -0.38, 0.70, 0.50, 0.60, N.MAT_ROCK, 72, 0.22))
    p.append(blob("skirt", -0.45, 0.26, 0.40, 0.82, 0.30, 0.70, N.MAT_ROCK_DARK, 73, 0.24))
    return _faceted(p)


def rock_cluster() -> list:
    """Three small stones. Scatter dressing, not cover."""
    p = []
    layout = ((0.0, 0.0, 0.46, 0.34), (0.72, 0.36, 0.30, 0.22), (-0.54, -0.44, 0.24, 0.18))
    for i, (x, z, r, h) in enumerate(layout):
        p.append(blob(f"stone{i}", x, h * 0.86, z, r, h, r * 0.88,
                      N.MAT_ROCK if i != 1 else N.MAT_ROCK_DARK, 81 + i, 0.26))
    return _faceted(p)


def rock_spire() -> list:
    """Tall standing stone. A landmark that reads from across the map."""
    p = []
    h = 4.2
    sections = []
    for i in range(6):
        t = i / 5
        r = 0.95 * (1.0 - t * 0.62)
        sections.append((t * h, N.superellipse(r, r * 0.86, 3.0, 9,
                                               cx=jitter(91, i, 0.16), cy=jitter(91, i + 20, 0.14))))
    p.append(N.loft("spire", sections, N.MAT_ROCK, smooth=False, axis="Y"))
    p.append(blob("base", 0.24, 0.34, -0.20, 1.15, 0.36, 1.00, N.MAT_ROCK_DARK, 92, 0.22))
    return _faceted(p)


# ---------------------------------------------------------------------------
# Ground cover
# ---------------------------------------------------------------------------


def bush() -> list:
    """Rounded shrub. Sight blocker at crouch height."""
    p = []
    canopy(p, 0.0, 0.56, 0.0, 0.72, seed=101, masses=4)
    p.append(blob("skirt", 0.0, 0.20, 0.0, 0.74, 0.22, 0.68, N.MAT_FOLIAGE_DARK, 102, 0.18))
    return p


def grass_tuft() -> list:
    """
    A few blades. Deliberately tiny.

    Scattered in numbers this is what sells a meadow, so it has to be cheap -
    six blades of four triangles each. Crossed quads would be cheaper still but
    would need an alpha-tested texture, and no model in this project ships one.
    """
    p = []
    for i in range(6):
        a = i / 6 * math.tau + rnd(111, i) * 0.9
        lean = 0.16 + rnd(111, i + 10) * 0.22
        h = 0.30 + rnd(111, i + 20) * 0.22
        blade = N.loft(f"blade{i}", [
            (0.00, N.ellipse(0.030, 0.010, 4)),
            (0.55, N.ellipse(0.020, 0.007, 4, cx=lean * 0.4, cy=lean * 0.2)),
            (1.00, N.ellipse(0.002, 0.002, 4, cx=lean, cy=lean * 0.5)),
        ], N.MAT_GRASS if i % 3 else N.MAT_FOLIAGE_LIGHT, smooth=True, axis="Y")
        for vert in blade.data.vertices:
            vert.co.y *= h
        blade.data.update()
        blade.rotation_euler = (0.0, a, 0.0)
        blade.location = (math.cos(a) * 0.07, 0.0, math.sin(a) * 0.07)
        p.append(blade)
    return p


def flower_patch() -> list:
    """Grass with colour in it. Three hues so a scatter never looks uniform."""
    p = grass_tuft()
    colours = (N.MAT_FLOWER_RED, N.MAT_FLOWER_YELLOW, N.MAT_FLOWER_VIOLET)
    for i in range(5):
        a = i / 5 * math.tau + 0.4
        r = 0.13 + rnd(121, i) * 0.10
        h = 0.30 + rnd(121, i + 5) * 0.14
        x, z = math.cos(a) * r, math.sin(a) * r
        stem = N.loft(f"stem{i}", [
            (0.0, N.ellipse(0.010, 0.010, 4)),
            (h, N.ellipse(0.007, 0.007, 4)),
        ], N.MAT_GRASS, smooth=True, axis="Y")
        stem.location = (x, 0.0, z)
        p.append(stem)
        p.append(N.sphere(f"head{i}", (x, h + 0.045, z), 0.055,
                          colours[i % 3], 5, 6, scale=(1.0, 0.62, 1.0)))
    return p


# ---------------------------------------------------------------------------
# Rustic timber
# ---------------------------------------------------------------------------


def fence_wood() -> list:
    """Two-rail fence, 4 m along X. Boundary dressing and low cover."""
    p = []
    span = 4.0
    for sx in (-1, 1):
        x = sx * span / 2
        post = N.loft("post", [
            (0.0, N.superellipse(0.075, 0.075, 4.0, 8, cx=x)),
            (1.05, N.superellipse(0.065, 0.065, 4.0, 8, cx=x)),
            (1.16, N.superellipse(0.030, 0.030, 4.0, 8, cx=x)),
        ], N.MAT_BARK_LIGHT, smooth=False, axis="Y")
        p.append(post)
    for y in (0.42, 0.86):
        rail = N.box("rail", (0.0, y, 0.0), (span, 0.085, 0.045), N.MAT_BARK_LIGHT,
                     rotation=(0, 0, jitter(131, int(y * 100), 1.2)))
        N.bevel(rail, 0.008, 2)
        p.append(rail)
    return p


def signpost() -> list:
    """Waymarker. Two arms at different heights, so it reads at a glance."""
    p = []
    p.append(trunk("post", 2.30, 0.085, 0.070, N.MAT_BARK_LIGHT, seed=141, segments=8))
    for i, (y, sx, mat) in enumerate(((1.72, 1, N.MAT_THATCH), (1.34, -1, N.MAT_THATCH))):
        arm = N.box(f"arm{i}", (sx * 0.42, y, 0.0), (0.86, 0.20, 0.045), mat,
                    rotation=(0, 0, jitter(141, i, 3.0)))
        N.bevel(arm, 0.010, 2)
        p.append(arm)
        tip = N.wedge(f"tip{i}", (sx * 0.90, y, 0.0), (0.16, 0.20, 0.045), mat,
                      rotation=(0, 0, 90 if sx > 0 else -90))
        p.append(tip)
    p.append(N.sphere("cap", (0.0, 2.34, 0.0), 0.105, N.MAT_BARK, 6, 8))
    return p


def barrel_wood() -> list:
    """Coopered barrel. Bulges at the middle, hooped at the quarters."""
    p = []
    h = 1.05
    sections = []
    for i in range(7):
        t = i / 6
        r = 0.36 * (1.0 - 0.22 * (2 * t - 1) ** 2)
        sections.append((t * h, N.ellipse(r, r, 14)))
    p.append(N.loft("staves", sections, N.MAT_BARK_LIGHT, smooth=False, axis="Y"))
    for t in (0.14, 0.50, 0.86):
        r = 0.36 * (1.0 - 0.22 * (2 * t - 1) ** 2) + 0.018
        hoop = N.lathe(f"hoop{t}", [(r, -0.045), (r, 0.045)], N.MAT_BARK, 14)
        hoop.rotation_euler = (math.radians(-90), 0.0, 0.0)
        hoop.location = (0.0, t * h, 0.0)
        p.append(hoop)
    p.append(N.lathe("lid", [(0.0, h + 0.004), (0.285, h + 0.004)], N.MAT_BARK, 14))
    p[-1].rotation_euler = (math.radians(-90), 0.0, 0.0)
    return p


NATURE = {
    "prop_tree_round": tree_round,
    "prop_tree_pine": tree_pine,
    "prop_tree_palm": tree_palm,
    "prop_tree_stump": tree_stump,
    "prop_log": log_fallen,
    "prop_rock_large": rock_large,
    "prop_rock_cluster": rock_cluster,
    "prop_rock_spire": rock_spire,
    "prop_bush": bush,
    "prop_grass_tuft": grass_tuft,
    "prop_flower_patch": flower_patch,
    "prop_fence_wood": fence_wood,
    "prop_signpost": signpost,
    "prop_barrel_wood": barrel_wood,
}

# Scatter dressing is placed in large numbers, so it gets a tighter budget and
# no LOD - the draw call costs more than the geometry at this size.
SMALL = {"prop_grass_tuft", "prop_flower_patch", "prop_rock_cluster"}

# Stone is shaded flat, everything else smooth. A blob's adjacent faces meet at
# roughly 20-30 degrees, so the threshold has to sit below that to keep them
# faceted - at the 52 degrees foliage wants, every facet smooths away and the
# boulder turns back into a sphere.
FACETED = {"prop_rock_large", "prop_rock_cluster", "prop_rock_spire"}


def smooth_angle_for(name: str) -> float:
    return 12.0 if name in FACETED else 52.0


def build_nature(name: str) -> None:
    N.reset_scene()
    parts = NATURE[name]()
    threshold = 100000 if name in SMALL else 900
    N.finish(name, parts, smooth_angle=smooth_angle_for(name),
             lod_threshold=threshold, lod_ratio=0.35)


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in NATURE else list(NATURE.keys())
    for name in targets:
        N.log(f"building nature {name}")
        build_nature(name)
    N.log(f"nature complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
