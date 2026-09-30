"""
KANG BANG - map structure generator.

Buildings that used to be assembled from `b.block()` calls in the map files.

Why they moved here: a brush is an axis-aligned box, so a barn built from
brushes can only ever be boxes - no bevel, no pitch, no plank, no post that is
not a rectangle. That is why the barns read as flat tan planes no matter how
much detail got stacked on them. In a generator the same building gets lofted
posts, a real pitched roof, bevelled edges and previewable geometry.

Collision does NOT come from these. Brushes are still the only source of
collision, bullet blocking and navmesh, so each of these pairs with a `noDraw`
hull placed by `MapBuilder.structure()`. The rule there is that the hull is
simpler than the art and sits slightly INSIDE it - a player stopped by
something invisible is much worse than one who clips a shoulder into an eave.

So every model here is authored to a known hull size, listed against each
builder, and must not extend past it anywhere a player can walk into.

Authored +Y up, -Z forward, metres, origin at ground centre - the prop
convention, so the client places them at the map's Y directly.

Run: blender --background --factory-startup --python assets/scripts/gen_structures.py
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_kang as N  # noqa: E402


def plank_wall(parts: list, x0: float, x1: float, y0: float, y1: float, z: float,
               material=N.MAT_BARK_LIGHT, courses: int = 6, thickness: float = 0.09) -> None:
    """
    A wall built from individual boards with a gap between each.

    The gap is the whole point. A single flat quad is what made these read as
    painted cardboard; separate courses catch a different amount of light on
    each board edge and the wall gains depth for a handful of triangles.
    """
    span = y1 - y0
    gap = 0.028
    board = (span - gap * (courses - 1)) / courses
    for i in range(courses):
        cy = y0 + board / 2 + i * (board + gap)
        # Alternate the depth very slightly so the courses do not read as one
        # extruded shape with lines drawn on it.
        depth = thickness * (1.0 + (0.14 if i % 2 else -0.10))
        b = N.box(f"board{i}", ((x0 + x1) / 2, cy, z), (x1 - x0, board, depth), material)
        N.bevel(b, 0.008, 2)
        parts.append(b)


def post(parts: list, x: float, z: float, height: float, radius: float = 0.15,
         material=N.MAT_BARK_LIGHT) -> None:
    """Squared timber post, tapered and chamfered - never a plain cylinder."""
    p = N.loft(f"post{x:.1f}_{z:.1f}", [
        (0.0, N.superellipse(radius * 1.16, radius * 1.16, 5.0, 10, cx=x, cy=z)),
        (0.12, N.superellipse(radius, radius, 5.0, 10, cx=x, cy=z)),
        (height - 0.14, N.superellipse(radius * 0.94, radius * 0.94, 5.0, 10, cx=x, cy=z)),
        (height, N.superellipse(radius * 1.10, radius * 1.10, 5.0, 10, cx=x, cy=z)),
    ], material, smooth=False, axis="Y")
    parts.append(p)


def brace(parts: list, x: float, z: float, y: float, dx: float, dz: float,
          material=N.MAT_BARK) -> None:
    """Diagonal corner brace. The single detail that most says 'timber frame'."""
    length = math.hypot(dx, dz)
    br = N.box("brace", (x + dx / 2, y, z + dz / 2), (length, 0.11, 0.11), material,
               rotation=(0, 0, math.degrees(math.atan2(dz, dx))))
    N.bevel(br, 0.012, 2)
    parts.append(br)


# ---------------------------------------------------------------------------
# Structures
# ---------------------------------------------------------------------------


def barn() -> list:
    """
    Open-sided timber barn. Hull: 12 x 4.2 x 10, origin at ground centre.

    The deck at 4.2 is walkable and holds a pickup, so the roof CANNOT be
    pitched over it. The pitch goes on a separate loft above head height at the
    back instead, which gives the building a roofline without taking the
    firing position away.
    """
    p: list = []
    W, D, H = 12.0, 10.0, 4.2

    for px in (-5.0, 5.0):
        for pz in (-4.0, 4.0):
            post(p, px, pz, H, 0.21)
            brace(p, px, pz, H - 0.85, -math.copysign(1.5, px), 0.0)
            brace(p, px, pz, H - 0.85, 0.0, -math.copysign(1.5, pz))

    # Deck: boards running across, with a beam under each end.
    boards = 16
    for i in range(boards):
        cz = -D / 2 + 0.22 + i * ((D - 0.44) / (boards - 1))
        b = N.box(f"deck{i}", (0.0, H - 0.11, cz), (W - 0.2, 0.22, (D - 0.44) / boards * 0.86),
                  N.MAT_BARK_LIGHT)
        N.bevel(b, 0.01, 2)
        p.append(b)
    for cz in (-D / 2 + 0.4, 0.0, D / 2 - 0.4):
        beam = N.box("beam", (0.0, H - 0.34, cz), (W, 0.24, 0.28), N.MAT_BARK)
        N.bevel(beam, 0.014, 2)
        p.append(beam)
    # Fascia round the deck edge.
    for (cx, cz, sw, sd) in ((0, -D / 2, W, 0.16), (0, D / 2, W, 0.16),
                             (-W / 2, 0, 0.16, D), (W / 2, 0, 0.16, D)):
        f = N.box("fascia", (cx, H - 0.22, cz), (sw, 0.34, sd), N.MAT_BARK)
        N.bevel(f, 0.014, 2)
        p.append(f)

    # Back wall, planked.
    plank_wall(p, -W / 2 + 0.1, W / 2 - 0.1, 0.15, H - 0.36, D / 2 - 0.12, courses=7)

    # Roofline above the deck: a low pitch at the back only, so the walkable
    # surface stays clear.
    ridge = H + 1.5
    for s in (-1, 1):
        slope = N.loft("roof", [
            (D / 2 - 0.1, [(-W / 2 - 0.35, H + 0.42), (W / 2 + 0.35, H + 0.42),
                           (W / 2 + 0.35, H + 0.62), (-W / 2 - 0.35, H + 0.62)]),
            (D / 2 - 2.4, [(-W / 2 - 0.2, ridge), (W / 2 + 0.2, ridge),
                           (W / 2 + 0.2, ridge + 0.2), (-W / 2 - 0.2, ridge + 0.2)]),
        ], N.MAT_ROOF_TILE, smooth=False, axis="Z")
        p.append(slope)
        if s < 0:
            break
    # Rafters under the pitch.
    for i in range(7):
        rx = -W / 2 + 0.9 + i * ((W - 1.8) / 6)
        r = N.box(f"rafter{i}", (rx, H + 0.9, D / 2 - 1.2), (0.13, 0.13, 2.6), N.MAT_BARK)
        p.append(r)

    return p


def watchtower() -> list:
    """
    Timber watchtower. Hull: 10.8 x 6.0 x 10.8, origin at ground centre.

    Deck at 6.0 is walkable. Four legs, cross-braced, with a railed platform.
    """
    p: list = []
    H = 6.0
    half = 4.5

    for px in (-half, half):
        for pz in (-half, half):
            post(p, px, pz, H, 0.24)
    # Cross bracing on all four faces, at two heights.
    for y in (1.9, 4.0):
        for (ax, az, bx, bz) in ((-half, -half, half, -half), (-half, half, half, half),
                                 (-half, -half, -half, half), (half, -half, half, half)):
            brace(p, ax, az, y, bx - ax, bz - az)
    # Deck.
    boards = 14
    for i in range(boards):
        cz = -5.2 + 0.3 + i * (10.4 - 0.6) / (boards - 1)
        b = N.box(f"deck{i}", (0.0, H - 0.12, cz), (10.4, 0.24, (10.4 - 0.6) / boards * 0.86),
                  N.MAT_BARK_LIGHT)
        N.bevel(b, 0.01, 2)
        p.append(b)
    for (cx, cz, sw, sd) in ((0, -5.4, 11.0, 0.2), (0, 5.4, 11.0, 0.2),
                             (-5.4, 0, 0.2, 11.0), (5.4, 0, 0.2, 11.0)):
        f = N.box("fascia", (cx, H - 0.26, cz), (sw, 0.36, sd), N.MAT_BARK)
        N.bevel(f, 0.014, 2)
        p.append(f)
    return p


STRUCTURES = {
    "struct_barn": barn,
    "struct_watchtower": watchtower,
}


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in STRUCTURES else list(STRUCTURES.keys())
    for name in targets:
        N.log(f"building structure {name}")
        N.reset_scene()
        N.finish(name, STRUCTURES[name](), smooth_angle=40.0,
                 lod_threshold=2500, lod_ratio=0.35)
    N.log(f"structures complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
