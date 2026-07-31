"""
KANG BANG - prop, pickup, objective and deployable generator.

These are the models referenced by MapDef.props and by the objective, pickup
and deployable systems. Unlike a weapon, a prop is background: there may be
forty on screen, none of them is instanced, and the player never studies one.
So the budget is roughly 300-1500 triangles each, and every one of those
triangles has to buy silhouette or shading rather than detail.

What actually makes a prop read, in order of value per triangle:

  1. BEVEL. A prop is lit by one sun and an environment probe. With perfectly
     sharp edges every face is a flat wash of colour and the object reads as an
     untextured box. A 5-20 mm chamfer puts a bright line along every corner,
     and that line is what says "steel". It costs 32 triangles on a box.
     `chamfer()` puts it into the cross-section, where it is nearly free;
     `N.bevel` puts it on a finished solid, where it costs more but works on
     any shape.
  2. REAL CROSS-SECTIONS. A crane girder is an I-beam, a drum is a lathed
     shell with rolled hoops, a pipe is a tube with bolted flanges. Describing
     those as a profile and sweeping it gets the proportion right for free and
     costs a fraction of what modelling the same shape from boxes would.
  3. CUT, DO NOT STACK. A vent is a hole with a fan behind it, not a grille
     glued onto a plate. A recess shadows itself from every angle; a plate
     laid on a surface only ever reads from one. Booleans are used for every
     vent slot, lightening hole, window and panel recess here.
  4. MATERIAL SEPARATION. Galvanised steel, painted steel, concrete and safety
     yellow are four different surfaces even when they are all grey-ish,
     because roughness and metalness differ. Two to four per prop - each one
     is a separate draw call.

Conventions:

  * +Y up, -Z forward, metres. `N.finish(..., orient="yup")` lands them on the
    engine's axes.
  * Ground props have their contact at y = 0; the client places them at the
    map's Y directly. Wall and ceiling props (vent, pipe run, sign, crane,
    strut, satellite, collars) are centred on their own middle, because that
    is the anchor the maps were authored against - see `b.prop(...)` calls in
    packages/shared/src/data/maps.
  * `N.MAT_TEAM` is the tint hook, not a glow: the client recolours any
    material with a non-zero emissive, which is how objective markers take
    the owning team's colour and how the maps tint signage. Anything that
    should stay the colour it was authored must not be emissive, which is why
    `N.MAT_HAZARD` is kept off tinted props.

Run: blender --background --factory-startup --python assets/scripts/gen_props.py
     (optionally  -- --only=prop_barrel )
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import mathutils  # noqa: E402

import lib_kang as N  # noqa: E402


# ---------------------------------------------------------------------------
# Vertical construction helpers
#
# The library sweeps along Z because a weapon is a thing that points. A prop is
# a thing that stands, so almost everything here sweeps along Y instead.
# `N.loft(axis=...)` already handles the axis permutation and the winding flip
# that goes with it, so these are thin wrappers rather than new machinery - and
# using them rather than building along Z and rotating afterwards means a part
# is authored in the coordinates it will be read in.
# ---------------------------------------------------------------------------


def vlathe(
    name: str,
    profile: list[tuple[float, float]],
    material: str = N.MAT_STEEL,
    segments: int = 14,
    center: tuple[float, float] = (0.0, 0.0),
    cap_start: bool = True,
    cap_end: bool = True,
    smooth: bool = True,
) -> bpy.types.Object:
    """
    Revolve a (radius, height) profile about the vertical axis.

    Drums, tanks, posts, bolts, lamp housings: if it was turned or rolled, it
    belongs here. A profile whose last point equals its first is a closed
    section - a tube wall, a rolled rim, a hollow ring - and needs no caps;
    wind those counter-clockwise in (radius, height), i.e. up the outside and
    back down the inside, or the solid comes out inverted.
    """
    cx, cz = center
    sections = [
        (y, N.ellipse(max(r, 1e-5), max(r, 1e-5), segments, cx=cx, cy=cz))
        for r, y in profile
    ]
    return N.loft(name, sections, material, cap_start=cap_start, cap_end=cap_end,
                  smooth=smooth, axis="Y")


def vcol(
    name: str,
    profile: list[tuple[float, float]],
    y0: float,
    y1: float,
    material: str = N.MAT_STEEL,
    center: tuple[float, float] = (0.0, 0.0),
    cap_start: bool = True,
    cap_end: bool = True,
    smooth: bool = False,
) -> bpy.types.Object:
    """Extrude a horizontal (x, z) cross-section upward. Columns, posts, kerbs."""
    cx, cz = center
    pts = [(x + cx, z + cz) for x, z in profile]
    return N.loft(name, [(y0, pts), (y1, pts)], material,
                  cap_start=cap_start, cap_end=cap_end, smooth=smooth, axis="Y")


def zlathe(
    name: str,
    profile: list[tuple[float, float]],
    material: str = N.MAT_STEEL,
    segments: int = 14,
    center: tuple[float, float] = (0.0, 0.0),
    cap_start: bool = True,
    cap_end: bool = True,
    smooth: bool = True,
) -> bpy.types.Object:
    """
    Revolve a (radius, z) profile about the forward axis. Pipes, dishes, barrels.

    `N.lathe` does the same job but winds both of its end caps inward, which is
    invisible on a profile that doubles back (the two caps coincide and cancel)
    and inside-out on one that does not. Building on `loft` avoids the question.
    """
    cx, cy = center
    sections = [
        (z, N.ellipse(max(r, 1e-5), max(r, 1e-5), segments, cx=cx, cy=cy))
        for r, z in profile
    ]
    return N.loft(name, sections, material, cap_start=cap_start, cap_end=cap_end,
                  smooth=smooth, axis="Z")


def xlathe(
    name: str,
    profile: list[tuple[float, float]],
    material: str = N.MAT_STEEL,
    segments: int = 12,
    center: tuple[float, float] = (0.0, 0.0),
    cap_start: bool = True,
    cap_end: bool = True,
    smooth: bool = True,
) -> bpy.types.Object:
    """Revolve a (radius, x) profile about the lateral axis. Road wheels, drums."""
    cy, cz = center
    sections = [
        (x, N.ellipse(max(r, 1e-5), max(r, 1e-5), segments, cx=cy, cy=cz))
        for r, x in profile
    ]
    return N.loft(name, sections, material, cap_start=cap_start, cap_end=cap_end,
                  smooth=smooth, axis="X")


# ---------------------------------------------------------------------------
# Profile helpers
# ---------------------------------------------------------------------------


def chamfer(points: list[tuple[float, float]], amount: float) -> list[tuple[float, float]]:
    """
    Cut every corner off a closed 2D profile.

    The cheapest bevel in the file. Doubling a twelve-point section costs
    twelve quads on an extrusion - about 24 triangles - and buys a highlight
    down every longitudinal edge of the part, which on a 22 m crane girder is
    the entire difference between "steel beam" and "grey stripe".

    The cut is clamped to 45% of the shorter adjacent edge so a chamfer can
    never eat past the neighbouring corner and turn the profile inside out.
    """
    out: list[tuple[float, float]] = []
    n = len(points)
    for i in range(n):
        cx, cy = points[i]
        for ox, oy in (points[i - 1], points[(i + 1) % n]):
            dx, dy = ox - cx, oy - cy
            length = math.hypot(dx, dy) or 1.0
            k = min(amount, length * 0.45) / length
            out.append((cx + dx * k, cy + dy * k))
    return out


def ibeam(width: float, height: float, flange: float, web: float) -> list[tuple[float, float]]:
    """
    I-section, centred, wound counter-clockwise.

    Structural steel is not a box: it is two flanges and a web, and the eye
    knows the difference from a long way off. Twelve points, and with
    `chamfer()` on top it is still under 50 triangles for any length.
    """
    hw, hh, tf, tw = width / 2.0, height / 2.0, flange, web / 2.0
    return [
        (-hw, -hh), (hw, -hh), (hw, -hh + tf), (tw, -hh + tf),
        (tw, hh - tf), (hw, hh - tf), (hw, hh), (-hw, hh),
        (-hw, hh - tf), (-tw, hh - tf), (-tw, -hh + tf), (-hw, -hh + tf),
    ]


def channel(width: float, height: float, thickness: float) -> list[tuple[float, float]]:
    """C-section: base rails, ladder stiles, frame members."""
    hw, hh, t = width / 2.0, height / 2.0, thickness
    return [
        (-hw, -hh), (hw, -hh), (hw, hh), (hw - t, hh),
        (hw - t, -hh + t), (-hw + t, -hh + t), (-hw + t, hh), (-hw, hh),
    ]


def ring_profile(outer: float, inner: float, height: float, y: float = 0.0
                 ) -> list[tuple[float, float]]:
    """Closed (radius, height) section for a flat ring - a flange, a rail, a band."""
    return [
        (inner, y), (outer, y), (outer, y + height), (inner, y + height), (inner, y),
    ]


# ---------------------------------------------------------------------------
# Detail assemblies
# ---------------------------------------------------------------------------


def strut(
    name: str,
    p0: tuple[float, float, float],
    p1: tuple[float, float, float],
    radius: float = 0.035,
    material: str = N.MAT_STEEL,
    segments: int = 6,
) -> bpy.types.Object:
    """
    A round bar between two points: the building block of every lattice here.

    A lattice mast is the most recognisable industrial silhouette there is and
    it is almost free - a six-sided bar is 20 triangles, so a twenty-member
    truss costs less than one bevelled box.
    """
    a, b = mathutils.Vector(p0), mathutils.Vector(p1)
    d = b - a
    obj = N.cylinder(name, (0.0, 0.0, 0.0), radius, max(d.length, 1e-4), segments,
                     material, smooth=False)
    obj.location = (a + b) / 2.0
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return obj


def bolt(
    name: str,
    position: tuple[float, float, float],
    radius: float = 0.022,
    height: float = 0.016,
    material: str = N.MAT_STEEL,
    axis: str = "Y",
) -> bpy.types.Object:
    """Hex head proud of a plate. Reads as "this was assembled", for 20 triangles."""
    return N.cylinder(name, position, radius, height, 6, material, axis=axis, smooth=False)


def stripe(
    name: str,
    center: tuple[float, float, float],
    width: float,
    height: float,
    thickness: float = 0.012,
    lean: float = 26.0,
    material: str = N.MAT_HAZARD,
    face: str = "z",
) -> bpy.types.Object:
    """
    One diagonal bar of a hazard marking, as a leaning prism.

    Painted, so it wants no bevel - 12 triangles. Built as a sheared box rather
    than a rotated one so the top and bottom stay flush with the band it sits
    in: a rotated box overhangs, and clipping it back with a boolean would cost
    twenty times as much as the stripe itself.
    """
    cx, cy, cz = center
    off = height * math.tan(math.radians(lean)) / 2.0
    if face == "z":
        base = N.rect_profile(width, thickness)
        low = [(x + cx - off, z + cz) for x, z in base]
        high = [(x + cx + off, z + cz) for x, z in base]
    else:
        base = N.rect_profile(thickness, width)
        low = [(x + cx, z + cz - off) for x, z in base]
        high = [(x + cx, z + cz + off) for x, z in base]
    return N.loft(name, [(cy - height / 2.0, low), (cy + height / 2.0, high)],
                  material, smooth=False, axis="Y")


def hazard_band(
    prefix: str,
    center: tuple[float, float, float],
    width: float,
    height: float,
    count: int = 5,
    thickness: float = 0.012,
    face: str = "z",
    material: str = N.MAT_HAZARD,
) -> list[bpy.types.Object]:
    """A run of diagonal stripes across a face - the universal "mind this" mark."""
    cx, cy, cz = center
    pitch = width / count
    out = []
    for i in range(count):
        t = (i + 0.5) / count - 0.5
        if face == "z":
            pos = (cx + t * width, cy, cz)
        else:
            pos = (cx, cy, cz + t * width)
        out.append(stripe(f"{prefix}{i}", pos, pitch * 0.5, height, thickness,
                          material=material, face=face))
    return out


def fan(
    prefix: str,
    center: tuple[float, float, float],
    radius: float,
    blades: int = 5,
    pitch: float = 32.0,
    axis: str = "Z",
    hub_material: str = N.MAT_TRIM,
    blade_material: str = N.MAT_BODY_LIGHT,
) -> list[bpy.types.Object]:
    """
    Hub and pitched blades, seen through a grille or an opening.

    The point of a fan is that it is *behind* something: the opening is what
    the eye reads, and the fan is what stops the opening being a black hole.
    """
    cx, cy, cz = center
    parts = [N.cylinder(f"{prefix}_hub", center, radius * 0.26, radius * 0.34, 10,
                        hub_material, axis=axis)]
    for i in range(blades):
        a = i / blades * math.tau
        if axis.upper() == "Z":
            pos = (cx + math.cos(a) * radius * 0.56, cy + math.sin(a) * radius * 0.56, cz)
            rot = (pitch, 0.0, math.degrees(a))
        else:  # vertical axis: blades sweep the XZ plane
            pos = (cx + math.cos(a) * radius * 0.56, cy, cz + math.sin(a) * radius * 0.56)
            rot = (0.0, -math.degrees(a), pitch)
        parts.append(N.box(f"{prefix}_blade{i}", pos,
                           (radius * 0.92, radius * 0.30, radius * 0.05),
                           blade_material, rotation=rot))
    return parts


def handrail(
    prefix: str,
    points: list[tuple[float, float]],
    y: float,
    height: float = 1.02,
    material: str = N.MAT_STEEL,
) -> list[bpy.types.Object]:
    """Straight run of railing: stanchions, a top rail and a knee rail."""
    parts: list[bpy.types.Object] = []
    for i, (x, z) in enumerate(points):
        parts.append(N.cylinder(f"{prefix}_post{i}", (x, y + height / 2.0, z),
                                0.026, height, 6, material, axis="Y", smooth=False))
    for level, r in ((height, 0.026), (height * 0.55, 0.020)):
        for i in range(len(points) - 1):
            parts.append(strut(f"{prefix}_rail{level:.2f}_{i}",
                               (points[i][0], y + level, points[i][1]),
                               (points[i + 1][0], y + level, points[i + 1][1]),
                               r, material))
    return parts


def ring_rail(
    prefix: str,
    radius: float,
    y: float,
    height: float = 1.04,
    segments: int = 20,
    posts: int = 8,
    material: str = N.MAT_STEEL,
) -> list[bpy.types.Object]:
    """Circular railing: two revolved rails and a ring of stanchions."""
    parts: list[bpy.types.Object] = []
    for level, thick in ((height, 0.030), (height * 0.55, 0.024)):
        parts.append(vlathe(
            f"{prefix}_rail{level:.2f}",
            ring_profile(radius + thick / 2.0, radius - thick / 2.0, thick, y + level),
            material, segments, cap_start=False, cap_end=False,
        ))
    for i in range(posts):
        a = i / posts * math.tau
        parts.append(N.cylinder(f"{prefix}_post{i}",
                                (math.cos(a) * radius, y + height / 2.0, math.sin(a) * radius),
                                0.026, height, 6, material, axis="Y", smooth=False))
    return parts


def cut(body: bpy.types.Object, cutters: list[bpy.types.Object], name: str = "cutter"
        ) -> bpy.types.Object:
    """
    Subtract cutters from a solid, one at a time, and clean the seam.

    One boolean against all the cutters joined would be faster, and that is
    what the library does for rail slots. It cannot be used here: `join` merges
    meshes without unioning them, so overlapping cutters produce a
    self-intersecting non-manifold solid, and the EXACT solver's answer to that
    is to delete most of the model. A cross-shaped recess is two overlapping
    boxes, which is exactly the case that fails - and it fails silently, as a
    prop that quietly loses its bottom half.
    """
    for i, cutter in enumerate(cutters):
        N.boolean(body, cutter)
        if i % 3 == 2:
            N.weld(body)
    return N.weld(body)


# ---------------------------------------------------------------------------
# Ground clutter
# ---------------------------------------------------------------------------


def prop_barrel() -> list:
    """
    200 litre steel drum: rolled chimes, two rolling hoops, bungs in the lid.

    Almost the whole read is in the lathe profile. The two hoops are what stop
    a drum being a cylinder, the chimes are what stop it being a can, and both
    are radius steps that cost nothing beyond the ring they add.
    """
    p: list = []
    p.append(vlathe("body", [
        (0.262, 0.000),
        (0.292, 0.020), (0.298, 0.046), (0.282, 0.070),   # bottom chime
        (0.282, 0.242), (0.302, 0.258), (0.302, 0.322), (0.282, 0.338),   # hoop 1
        (0.282, 0.566), (0.302, 0.582), (0.302, 0.646), (0.282, 0.662),   # hoop 2
        (0.282, 0.848),
    ], N.MAT_PAINT_RED, 14, cap_end=False))
    # Lid is a separate part so it can be bare galvanised against the paint.
    p.append(vlathe("lid", [
        (0.262, 0.840), (0.298, 0.864), (0.292, 0.888), (0.244, 0.900),
    ], N.MAT_STEEL, 14))
    for x in (-0.120, 0.096):
        p.append(vlathe(f"bung{x:.2f}", [(0.050, 0.896), (0.050, 0.914), (0.038, 0.918)],
                        N.MAT_STEEL, 8, center=(x, 0.0)))
    # Placard, pushed in far enough that the drum's curve does not show through.
    p.append(N.rounded_box("placard", (0.0, 0.470, -0.276), (0.190, 0.230, 0.024),
                           N.MAT_HAZARD, radius=0.010, segments=1))
    return p


def prop_crate_stack() -> list:
    """
    Three stacked shipping cases.

    Each is a chamfered box with its side panels cut *in*, so the frame stands
    proud and the panel shadows. That recess is the difference between a crate
    and a cube, and it is one boolean per case.
    """
    p: list = []
    layout = (
        # (x, y, z, size, yaw, shell material)
        (0.00, 0.500, 0.00, 1.00, 0.0, N.MAT_CRATE),
        (0.58, 0.400, 0.34, 0.80, 19.0, N.MAT_STEEL),
        (-0.30, 1.350, 0.14, 0.70, -13.0, N.MAT_CRATE),
    )
    for i, (x, y, z, s, yaw, mat) in enumerate(layout):
        body = N.rounded_box(f"crate{i}", (x, y, z), (s, s, s), mat,
                             radius=0.016, segments=1, rotation=(0, yaw, 0))
        inset, depth = s * 0.30, s * 0.09
        a = math.radians(yaw)
        ca, sa = math.cos(a), math.sin(a)
        # One cutter per face, reaching only `depth` into the solid. A single
        # box spanning the whole case would meet both faces at once and hollow
        # it out into a picture frame - which is exactly what happened the
        # first time.
        cutters = []
        for j, (nx, nz) in enumerate(((ca, -sa), (-ca, sa), (sa, ca), (-sa, -ca))):
            face = (x + nx * s / 2.0, y, z + nz * s / 2.0)
            size = ((depth * 2.0, s - inset, s - inset) if j < 2
                    else (s - inset, s - inset, depth * 2.0))
            cutters.append(N.box(f"c{i}_{j}", face, size, mat, rotation=(0, yaw, 0)))
        p.append(cut(body, cutters, f"crate{i}_cutter"))
        # Lid: proud of the body, so it casts its own line of shadow.
        p.append(N.rounded_box(f"lid{i}", (x, y + s * 0.53, z),
                               (s * 1.03, s * 0.10, s * 1.03), N.MAT_STEEL,
                               radius=0.014, segments=1, rotation=(0, yaw, 0)))
        # Stencil on the front face, rotated with the case.
        p.append(N.box(f"stencil{i}", (x - sa * s * 0.51, y + s * 0.10, z - ca * s * 0.51),
                       (s * 0.30, s * 0.14, 0.014), N.MAT_HAZARD, rotation=(0, yaw, 0)))
    return p


def prop_terminal() -> list:
    """
    Control console: one raked cabinet, louvred flanks, recessed screen.

    Built as a single lofted mass from the floor to the top of the head rather
    than as a stack of separate slabs. That matters more than it sounds: a
    bezel balanced on a box shows daylight through the join from every angle
    except dead ahead, and no amount of bevelling fixes a gap.

    The louvres are recessed rather than cut through, because a slot you can
    see the far side of reads as a hole in the model, not as a vent.
    """
    p: list = []
    body = N.MAT_CONCRETE
    p.append(N.rounded_box("plinth", (0.0, 0.045, 0.0), (0.78, 0.09, 0.58),
                           N.MAT_STEEL, radius=0.014, segments=1))
    # Cabinet: upright to desk height, then raking back into the screen head.
    sec = chamfer(N.rect_profile(0.66, 0.46), 0.022)

    # The head rakes back as a parallel shear rather than a taper, so the front
    # face is a straight plane of known slope - which is what lets the screen
    # and keypad be placed on it by arithmetic instead of by eye.
    rake = 24.0
    slope = math.tan(math.radians(rake))
    y_rake, front = 1.06, -0.23

    def at(y: float, sx: float = 1.0) -> list[tuple[float, float]]:
        cz = max(0.0, y - y_rake) * slope
        return [(x * sx, z + cz) for x, z in sec]

    def face(y: float) -> float:
        """Front surface of the console at height y."""
        return front + max(0.0, y - y_rake) * slope

    cab = N.loft("cabinet", [
        (0.09, at(0.09)),
        (1.06, at(1.06)),
        (1.50, at(1.50, 0.96)),
    ], body, smooth=False, axis="Y")
    cutters = [
        N.box(f"lv{i}{sx}", (sx * 0.33, 0.56 + i * 0.078, 0.0), (0.07, 0.032, 0.30), body)
        for i in range(4) for sx in (-1, 1)
    ]
    # Screen and keypad lie on the raked face and share its tilt. The face
    # leans *back*, so the rotation is positive - the sign that stands them up
    # in front of the console instead of sinking them into it is the other one.
    sy, ky = 1.30, 1.14
    cutters.append(N.box("screen_well", (0.0, sy, face(sy) + 0.010),
                         (0.52, 0.36, 0.10), body, rotation=(rake, 0, 0)))
    cutters.append(N.box("key_well", (0.0, ky, face(ky) + 0.005),
                         (0.46, 0.11, 0.08), body, rotation=(rake, 0, 0)))
    p.append(cut(cab, cutters, "cab_cutter"))
    p.append(N.box("screen", (0.0, sy, face(sy) + 0.028), (0.50, 0.32, 0.03),
                   N.MAT_TEAM, rotation=(rake, 0, 0)))
    for i in range(3):
        p.append(N.box(f"key{i}", (-0.15 + i * 0.15, ky, face(ky) + 0.020),
                       (0.11, 0.075, 0.03), N.MAT_STEEL, rotation=(rake, 0, 0)))
    # Grab rail across the front, at the height a hand would use it.
    p.append(strut("rail", (-0.30, 0.90, -0.30), (0.30, 0.90, -0.30), 0.022, N.MAT_STEEL))
    for sx in (-1, 1):
        p.append(strut(f"rail_leg{sx}", (sx * 0.30, 0.90, -0.30),
                       (sx * 0.30, 0.90, -0.22), 0.022, N.MAT_STEEL))
    # Conduit into the floor, and a warning strip on the plinth.
    p.append(vlathe("conduit", [(0.045, 0.0), (0.045, 0.30), (0.055, 0.32)],
                    N.MAT_STEEL, 8, center=(0.26, 0.24)))
    p += hazard_band("kick", (0.0, 0.045, -0.292), 0.62, 0.062, count=5, thickness=0.012)
    return p


def prop_vent() -> list:
    """
    Wall extractor: a real hole with a fan behind it and louvres across it.

    Centred on its own middle - the maps hang these on walls at a given height.
    Cutting the aperture through the plate rather than ringing it with strips
    is what lets the duct go dark behind the louvres, and that darkness is the
    whole effect.
    """
    p: list = []
    plate = N.rounded_box("plate", (0.0, 0.0, -0.150), (1.50, 1.50, 0.10),
                          N.MAT_STEEL, radius=0.018, segments=1)
    p.append(cut(plate, [N.cylinder("aperture", (0.0, 0.0, -0.150), 0.58, 0.40, 16,
                                    N.MAT_STEEL, axis="Z")], "plate_cutter"))
    # Duct behind the plate, dark, open at both ends.
    p.append(zlathe("duct", [
        (0.580, -0.160), (0.580, 0.190), (0.552, 0.190), (0.552, -0.160), (0.580, -0.160),
    ], N.MAT_BODY_DARK, 16, cap_start=False, cap_end=False))
    p += fan("fan", (0.0, 0.0, 0.060), 0.52, blades=5, pitch=34.0, axis="Z",
             blade_material=N.MAT_TRIM,
             hub_material=N.MAT_TRIM)
    # Fixed louvres across the mouth.
    for i in range(5):
        p.append(N.box(f"louvre{i}", (0.0, -0.44 + i * 0.22, -0.205),
                       (1.08, 0.16, 0.028), N.MAT_STEEL, rotation=(28, 0, 0)))
    # Drip hood and corner fixings.
    p.append(N.wedge("hood", (0.0, 0.70, -0.230), (1.54, 0.14, 0.16), N.MAT_STEEL,
                     rotation=(90, 0, 0)))
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(bolt(f"bolt{sx}{sy}", (sx * 0.66, sy * 0.66, -0.208),
                          0.030, 0.022, N.MAT_TRIM, axis="Z"))
    return p


def prop_ac_unit() -> list:
    """
    Rooftop package unit: fan well in the deck, louvred condenser face, copper
    lines out of the side.

    The fan opening is cut into the top and the fan recessed inside it, so the
    unit has a hole in it rather than a disc on it. Copper is doing real work
    here - it is the only warm colour on a grey box, and it costs one material.
    """
    p: list = []
    shell = N.MAT_CONCRETE
    cab = N.rounded_box("cabinet", (0.0, 0.53, 0.0), (1.50, 0.86, 1.30), shell,
                        radius=0.020, segments=1)
    cutters = [N.cylinder("fan_well", (0.0, 0.92, -0.10), 0.42, 0.40, 16, shell, axis="Y")]
    for i in range(5):
        cutters.append(N.box(f"grill{i}", (-0.76, 0.50, -0.42 + i * 0.21),
                             (0.14, 0.46, 0.10), shell))
        cutters.append(N.box(f"grill_r{i}", (0.76, 0.50, -0.42 + i * 0.21),
                             (0.14, 0.46, 0.10), shell))
    p.append(cut(cab, cutters, "ac_cutter"))
    # Fan sunk into the well, with a guard ring over it.
    p += fan("fan", (0.0, 0.86, -0.10), 0.38, blades=5, pitch=30.0, axis="Y",
             hub_material=N.MAT_STEEL, blade_material=N.MAT_STEEL)
    p.append(vlathe("fan_ring", ring_profile(0.44, 0.40, 0.05, 0.94), N.MAT_STEEL, 16,
                    center=(0.0, -0.10), cap_start=False, cap_end=False))
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        p.append(strut(f"guard{i}", (math.cos(a) * 0.42, 0.955, -0.10 + math.sin(a) * 0.42),
                       (-math.cos(a) * 0.42, 0.955, -0.10 - math.sin(a) * 0.42),
                       0.014, N.MAT_STEEL))
    # Base rails so it stands off the roof, control box, refrigerant lines.
    for sz in (-0.48, 0.48):
        # Section lives in (y, z) because the rail runs along X.
        sec = [(y + 0.06, z + sz) for y, z in chamfer(channel(0.11, 0.18, 0.03), 0.010)]
        p.append(N.loft(f"rail{sz:.2f}", [(-0.70, sec), (0.70, sec)],
                        N.MAT_STEEL, smooth=False, axis="X"))
    p.append(N.rounded_box("control", (0.0, 0.44, 0.68), (0.42, 0.36, 0.10),
                           N.MAT_STEEL, radius=0.012, segments=1))
    p.append(N.box("control_label", (0.0, 0.52, 0.735), (0.24, 0.10, 0.014), N.MAT_HAZARD))
    for x, r in ((0.30, 0.032), (0.42, 0.022)):
        p.append(vlathe(f"line{x:.2f}", [(r, 0.10), (r, 0.62), (r * 0.9, 0.66)],
                        N.MAT_COPPER, 8, center=(x, 0.66)))
        p.append(strut(f"line_run{x:.2f}", (x, 0.64, 0.66), (x, 0.64, 0.30), r, N.MAT_COPPER))
    return p


# ---------------------------------------------------------------------------
# Plant and structure
# ---------------------------------------------------------------------------


def prop_coolant_tank() -> list:
    """
    Pressure vessel on a skirt: dished ends, bolted manway, top nozzle.

    A tank is a revolution, so it is one lathe. The dished ends are what make
    it a pressure vessel instead of a bin - a flat-topped cylinder reads as a
    bucket at any distance.
    """
    p: list = []
    p.append(vlathe("shell", [
        (0.560, 0.000), (0.560, 0.180), (0.520, 0.220),      # skirt
        (0.520, 0.300),
        (0.520, 1.960), (0.500, 2.060), (0.440, 2.160),      # dished top
        (0.320, 2.250), (0.150, 2.300),
    ], N.MAT_WHITE, 16))
    # Painted hoops. Separate parts so they can be safety yellow against steel.
    for y in (0.62, 1.46):
        p.append(vlathe(f"hoop{y:.2f}", ring_profile(0.545, 0.512, 0.11, y),
                        N.MAT_HAZARD, 16, cap_start=False, cap_end=False))
    # Bolted manway on the front face.
    p.append(vlathe("manway", [(0.230, 0.0), (0.230, 0.045), (0.200, 0.060)],
                    N.MAT_TRIM, 12, center=(0.0, 0.0)))
    p[-1].location = (0.0, 1.02, -0.505)
    p[-1].rotation_euler = (math.radians(90), 0.0, 0.0)
    for i in range(6):
        a = i / 6 * math.tau
        p.append(bolt(f"mbolt{i}", (math.cos(a) * 0.205, 1.02 + math.sin(a) * 0.205, -0.545),
                      0.020, 0.020, N.MAT_TRIM, axis="Z"))
    # Top nozzle with a bolted flange, and a sight gauge down the flank.
    p.append(vlathe("nozzle", [
        (0.100, 2.280), (0.100, 2.420), (0.155, 2.430), (0.155, 2.470), (0.100, 2.480),
    ], N.MAT_TRIM, 10))
    p.append(N.rounded_box("gauge", (0.0, 1.05, 0.520), (0.13, 0.62, 0.09),
                           N.MAT_TRIM, radius=0.012, segments=1))
    p.append(N.box("gauge_glass", (0.0, 1.05, 0.572), (0.06, 0.52, 0.02), N.MAT_GLASS))
    # Access rungs welded up the side.
    for i in range(5):
        p.append(strut(f"rung{i}", (0.50, 0.42 + i * 0.34, -0.18),
                       (0.50, 0.42 + i * 0.34, 0.18), 0.020, N.MAT_TRIM))
    return p


def prop_conveyor_arm() -> list:
    """
    Gantry manipulator over a conveyor lane: box column, I-beam boom, sensor head.

    The lightening holes through the column are the detail that sells it. They
    are four booleans and they turn a plain post into fabricated steelwork.
    """
    p: list = []
    dark = N.MAT_CONCRETE
    p.append(N.rounded_box("base", (0.0, 0.055, 0.0), (0.72, 0.11, 0.72),
                           N.MAT_STEEL, radius=0.014, segments=1))
    for sx in (-1, 1):
        for sz in (-1, 1):
            p.append(bolt(f"base_bolt{sx}{sz}", (sx * 0.28, 0.115, sz * 0.28), 0.030, 0.024))
    column = vcol("column", chamfer(N.rect_profile(0.34, 0.34), 0.022), 0.10, 2.80, dark)
    holes = [N.cylinder(f"hole{i}", (0.0, 0.60 + i * 0.46, 0.0), 0.09, 0.60, 8,
                        dark, axis="Z") for i in range(4)]
    p.append(cut(column, holes, "column_cutter"))
    # Boom: an I-beam raking down toward the lane.
    sec = chamfer(ibeam(0.26, 0.30, 0.055, 0.045), 0.012)
    p.append(N.loft("boom", [
        (-2.10, [(x, y + 2.06) for x, y in sec]),
        (-0.10, [(x, y + 2.62) for x, y in sec]),
    ], N.MAT_STEEL, smooth=False))
    for sx in (-1, 1):
        p.append(N.wedge(f"gusset{sx}", (sx * 0.16, 2.46, -0.30), (0.04, 0.34, 0.44),
                         N.MAT_STEEL, rotation=(0, 0, 0)))
    # Sensor head hanging off the end of the boom.
    head = N.rounded_box("head", (0.0, 2.00, -2.10), (0.48, 0.44, 0.50), dark,
                         radius=0.018, segments=1)
    p.append(cut(head, [N.cylinder("lens_well", (0.0, 1.86, -2.10), 0.15, 0.24, 12,
                                   dark, axis="Y")], "head_cutter"))
    p.append(vlathe("lens", [(0.135, 1.80), (0.135, 1.84), (0.10, 1.86)],
                    N.MAT_AMBER, 12, center=(0.0, -2.10)))
    p.append(N.rounded_box("head_cap", (0.0, 2.26, -2.10), (0.40, 0.10, 0.42),
                           N.MAT_STEEL, radius=0.012, segments=1))
    # Cable festoon along the underside of the boom.
    for i in range(3):
        p.append(N.box(f"festoon{i}", (0.0, 2.30 - i * 0.12, -0.55 - i * 0.52),
                       (0.10, 0.13, 0.10), N.MAT_STEEL))
    p += hazard_band("column_mark", (0.0, 0.34, -0.182), 0.32, 0.30, count=3, thickness=0.014)
    return p


def prop_crane() -> list:
    """
    Overhead gantry girder, 22 m, centred on itself.

    One extruded I-section carries the whole silhouette for about 50
    triangles; the nine lightening holes bored through the web are what make
    it read as a crane rather than a beam. Everything else - carriages,
    trolley, hook block, walkway - hangs off that.
    """
    p: list = []
    dark = N.MAT_PAINT_RED
    sec = chamfer(ibeam(0.46, 0.52, 0.075, 0.075), 0.020)
    girder = N.extrude_profile("girder", sec, -11.0, 11.0, dark)
    holes = [N.cylinder(f"web{i}", (0.0, 0.0, -8.8 + i * 2.2), 0.155, 0.60, 8,
                        dark, axis="X") for i in range(9)]
    p.append(cut(girder, holes, "girder_cutter"))
    # End carriages with rail wheels.
    for sz in (-1, 1):
        z = sz * 10.4
        p.append(N.rounded_box(f"carriage{sz}", (0.0, -0.10, z), (0.92, 0.52, 1.30),
                               N.MAT_STEEL, radius=0.018, segments=1))
        for sw in (-1, 1):
            p.append(xlathe(f"wheel{sz}{sw}", [
                (0.14, -0.05), (0.20, -0.05), (0.20, 0.05), (0.14, 0.05), (0.14, -0.05),
            ], N.MAT_STEEL, 10, center=(-0.42, z + sw * 0.42),
                cap_start=False, cap_end=False))
        p += hazard_band(f"mark{sz}", (0.0, -0.10, z + sz * 0.66), 0.84, 0.40,
                         count=4, thickness=0.014)
    # Trolley, hoist drum and hook block.
    p.append(N.rounded_box("trolley", (0.0, -0.58, 0.0), (1.10, 0.62, 1.40),
                           N.MAT_STEEL, radius=0.018, segments=1))
    p.append(xlathe("drum", [
        (0.0, -0.34), (0.24, -0.34), (0.24, 0.34), (0.0, 0.34),
    ], N.MAT_STEEL, 10, center=(-0.58, 0.0)))
    p.append(N.rounded_box("motor", (0.0, -0.58, 0.86), (0.40, 0.40, 0.34),
                           N.MAT_STEEL, radius=0.014, segments=1))
    for sx in (-1, 1):
        p.append(strut(f"rope{sx}", (sx * 0.20, -0.86, 0.0), (sx * 0.20, -2.30, 0.0),
                       0.020, N.MAT_STEEL))
    p.append(N.rounded_box("hook_block", (0.0, -2.44, 0.0), (0.44, 0.34, 0.30),
                           N.MAT_HAZARD, radius=0.014, segments=1))
    p.append(vlathe("hook_shank", [(0.055, -2.86), (0.055, -2.58)], N.MAT_STEEL, 8))
    p.append(strut("hook_bend", (0.0, -2.86, 0.0), (0.16, -3.00, 0.0), 0.052, N.MAT_STEEL))
    p.append(strut("hook_tip", (0.16, -3.00, 0.0), (0.10, -2.84, 0.0), 0.042, N.MAT_STEEL))
    # Maintenance walkway down one side.
    p.append(N.box("walkway", (0.62, 0.20, 0.0), (0.62, 0.05, 20.4), N.MAT_STEEL))
    p += handrail("wr", [(0.90, -10.0), (0.90, -3.4), (0.90, 3.4), (0.90, 10.0)], 0.22)
    return p


def prop_pipe_run() -> list:
    """
    Three-pipe service run, 24 m, centred on itself.

    Each pipe is one closed lathe profile: up the outside, over the bolted
    flanges, back down the bore. That keeps the ends genuinely open - these
    are seen end-on where they leave a wall - and puts a chamfer at every
    flange for nothing.
    """
    p: list = []
    for i, (y, r, mat) in enumerate((( -0.55, 0.24, N.MAT_BODY_LIGHT),
                                     (0.00, 0.30, N.MAT_BODY_LIGHT),
                                     (0.58, 0.20, N.MAT_TRIM))):
        wall = r * 0.12
        outer: list[tuple[float, float]] = [(r, -12.0)]
        for j in range(3):
            z = -7.0 + j * 7.0
            outer += [(r, z - 0.10), (r * 1.26, z - 0.08),
                      (r * 1.26, z + 0.08), (r, z + 0.10)]
        outer.append((r, 12.0))
        profile = outer + [(r - wall, 12.0), (r - wall, -12.0), (r, -12.0)]
        p.append(zlathe(f"pipe{i}", profile, mat, 10, center=(0.0, y),
                        cap_start=False, cap_end=False))
    # Hangers: a channel yoke under all three, twice along the run.
    for z in (-8.0, 8.0):
        p.append(vcol(f"hanger{z:.0f}", chamfer(N.rect_profile(0.16, 0.26), 0.020),
                      -0.90, 0.90, N.MAT_TRIM, center=(-0.42, z)))
        for y, r in ((-0.55, 0.24), (0.0, 0.30), (0.58, 0.20)):
            p.append(strut(f"saddle{z:.0f}{y:.2f}", (-0.42, y, z), (0.10, y, z),
                           r * 1.12, N.MAT_TRIM, segments=6))
    # An inline gate valve, because a pipe run with no valve is a tube.
    p.append(zlathe("valve", [
        (0.30, -2.30), (0.40, -2.26), (0.40, -1.94), (0.30, -1.90),
    ], N.MAT_PAINT_RED, 12, center=(0.0, 0.0)))
    p.append(vlathe("valve_stem", [(0.05, 0.30), (0.05, 0.66)], N.MAT_TRIM, 8,
                    center=(0.0, -2.10)))
    p.append(vlathe("handwheel", ring_profile(0.26, 0.20, 0.05, 0.66), N.MAT_PAINT_RED,
                    12, center=(0.0, -2.10), cap_start=False, cap_end=False))
    for i in range(3):
        a = i / 3 * math.tau
        p.append(strut(f"spoke{i}", (0.0, 0.685, -2.10),
                       (math.cos(a) * 0.24, 0.685, -2.10 + math.sin(a) * 0.24),
                       0.022, N.MAT_PAINT_RED))
    return p


def prop_reactor_ring() -> list:
    """
    Maintenance catwalk collar around the foundry's central column.

    Centred on itself; the map hangs it at height. Deck, both toe boards and
    the underside come out of a single revolved section, which is a third of
    what the same shape costs as stacked rings and shades far better.
    """
    p: list = []
    p.append(vlathe("deck", [
        (2.52, -0.08), (3.48, -0.08), (3.48, 0.16), (3.40, 0.16),
        (3.40, 0.02), (2.60, 0.02), (2.60, 0.16), (2.52, 0.16), (2.52, -0.08),
    ], N.MAT_STEEL, 20, cap_start=False, cap_end=False))
    p += ring_rail("rail", 3.40, 0.02, 1.02, segments=20, posts=8)
    # Brackets carrying the deck off the column.
    for i in range(8):
        a = i / 8 * math.tau
        p.append(N.wedge(f"bracket{i}", (math.cos(a) * 2.90, -0.22, math.sin(a) * 2.90),
                         (0.90, 0.30, 0.16), N.MAT_STEEL,
                         rotation=(0, -math.degrees(a), 0)))
    # Yellow kick marks on the outer toe board.
    for i in range(6):
        a = i / 6 * math.tau + 0.2
        p.append(N.box(f"mark{i}", (math.cos(a) * 3.50, 0.09, math.sin(a) * 3.50),
                       (0.03, 0.10, 0.50), N.MAT_HAZARD,
                       rotation=(0, -math.degrees(a), 0)))
    return p


# ---------------------------------------------------------------------------
# Street furniture
# ---------------------------------------------------------------------------


def prop_streetlight() -> list:
    """
    Tapered column with a swept boom and a shoebox luminaire.

    The sweep is the read: a lamp on a straight vertical pole looks like a
    flagpole. Lofting the boom along Z while its centre height falls gives a
    genuine curve for four sections.
    """
    p: list = []
    pole = N.MAT_BODY_DARK
    p.append(vlathe("footing", [
        (0.26, 0.0), (0.26, 0.10), (0.22, 0.14), (0.115, 0.20),
    ], N.MAT_BODY_DARK, 12))
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        p.append(bolt(f"anchor{i}", (math.cos(a) * 0.19, 0.115, math.sin(a) * 0.19),
                      0.026, 0.028, N.MAT_BODY_LIGHT))
    p.append(vlathe("column", [(0.098, 0.16), (0.098, 0.34), (0.062, 4.62)], pole, 10))
    # Swept boom: sections along -Z, dropping and thinning as they go out.
    p.append(N.loft("boom", [
        (0.00, N.ellipse(0.062, 0.062, 8, cy=4.60)),
        (-0.34, N.ellipse(0.058, 0.058, 8, cy=4.86)),
        (-0.72, N.ellipse(0.052, 0.052, 8, cy=4.94)),
        (-1.12, N.ellipse(0.048, 0.048, 8, cy=4.90)),
    ], pole, smooth=True))
    # Luminaire: a wedge-sided housing with the lens sunk into its underside.
    head = N.loft("lamp", [
        (-0.74, N.superellipse(0.150, 0.070, 5.0, 12, cy=4.86)),
        (-1.06, N.superellipse(0.210, 0.090, 5.0, 12, cy=4.83)),
        (-1.44, N.superellipse(0.190, 0.082, 5.0, 12, cy=4.80)),
    ], N.MAT_BODY_LIGHT, smooth=False)
    p.append(cut(head, [N.box("lens_well", (0.0, 4.72, -1.16), (0.30, 0.06, 0.52),
                              N.MAT_BODY_LIGHT)], "lamp_cutter"))
    p.append(N.box("lens", (0.0, 4.755, -1.16), (0.29, 0.03, 0.50), N.MAT_WHITE))
    # Junction box and a street sign on the column.
    p.append(N.rounded_box("junction", (0.0, 0.86, -0.10), (0.16, 0.30, 0.12),
                           N.MAT_BODY_LIGHT, radius=0.012, segments=1))
    p.append(N.rounded_box("sign", (0.10, 3.10, 0.0), (0.05, 0.90, 0.34),
                           N.MAT_PAINT_RED, radius=0.014, segments=1))
    p.append(N.box("sign_bar", (0.10, 3.34, 0.0), (0.03, 0.10, 0.26), N.MAT_WHITE))
    return p


def prop_hovercar() -> list:
    """
    Parked utility van.

    Sized to the collision brush the maps put under it (2.3 x 5 x 1.5 with a
    cab box on top) rather than to the old floating car, so the thing the
    player bumps into is the thing they can see. Wheels are lathed about X and
    tucked beside a narrow rocker section, which gives an arch shadow without
    the cost of booleaning four wheel arches.
    """
    p: list = []
    paint = N.MAT_PAINT_RED
    # Narrow chassis rail section between the wheels.
    p.append(N.loft("rocker", [
        (-2.20, N.superellipse(0.84, 0.24, 6.0, 12, cy=0.62)),
        (2.20, N.superellipse(0.84, 0.24, 6.0, 12, cy=0.62)),
    ], N.MAT_STEEL, smooth=False))
    # Body: a box van, rounded at the nose.
    body = N.loft("body", [
        (-2.34, N.superellipse(0.92, 0.60, 4.0, 16, cy=1.22)),
        (-2.05, N.superellipse(1.04, 0.70, 6.0, 16, cy=1.24)),
        (-0.70, N.superellipse(1.06, 0.74, 8.0, 16, cy=1.26)),
        (1.70, N.superellipse(1.06, 0.74, 8.0, 16, cy=1.26)),
        (2.34, N.superellipse(1.02, 0.70, 7.0, 16, cy=1.24)),
    ], paint, smooth=False)
    # Glazing openings, cut through rather than laid on.
    windows = [
        N.box("wind_screen", (0.0, 1.62, -1.92), (1.72, 0.52, 0.34), paint,
              rotation=(-24, 0, 0)),
        N.box("wind_side_l", (-1.02, 1.60, -1.10), (0.30, 0.44, 1.20), paint),
        N.box("wind_side_r", (1.02, 1.60, -1.10), (0.30, 0.44, 1.20), paint),
        # Body swage line down the flanks.
        N.box("swage_l", (-1.05, 0.98, 0.60), (0.10, 0.09, 2.80), paint),
        N.box("swage_r", (1.05, 0.98, 0.60), (0.10, 0.09, 2.80), paint),
        # Rear door seam.
        N.box("door_seam", (0.0, 1.30, 2.36), (0.06, 1.10, 0.14), paint),
    ]
    p.append(cut(body, windows, "body_cutter"))
    p.append(N.box("glass_front", (0.0, 1.60, -1.90), (1.66, 0.48, 0.10),
                   N.MAT_GLASS, rotation=(-24, 0, 0)))
    for sx in (-1, 1):
        p.append(N.box(f"glass_side{sx}", (sx * 1.01, 1.60, -1.10),
                       (0.06, 0.40, 1.16), N.MAT_GLASS))
    # Wheels: tyre and dished rim, four of them.
    for sx in (-1, 1):
        for sz in (-1.42, 1.48):
            p.append(xlathe(f"tyre{sx}{sz:.1f}", [
                (0.24, -0.13), (0.36, -0.11), (0.39, -0.05),
                (0.39, 0.05), (0.36, 0.11), (0.24, 0.13),
            ], N.MAT_RUBBER, 14, center=(0.40, sz), cap_start=False, cap_end=False))
            p[-1].location = (sx * 0.90, 0.0, 0.0)
            p.append(xlathe(f"rim{sx}{sz:.1f}", [
                (0.07, sx * 0.06), (0.24, sx * 0.10), (0.24, sx * 0.13), (0.07, sx * 0.13),
            ], N.MAT_STEEL, 14, center=(0.40, sz)))
            p[-1].location = (sx * 0.90, 0.0, 0.0)
    # Bumpers, lights, mirrors, roof rack.
    for sz, mat in ((-2.40, N.MAT_STEEL), (2.40, N.MAT_STEEL)):
        p.append(N.rounded_box(f"bumper{sz:.0f}", (0.0, 0.66, sz), (2.00, 0.24, 0.20),
                               mat, radius=0.030, segments=1))
    p.append(N.box("headlight_l", (-0.66, 1.02, -2.38), (0.44, 0.20, 0.08), N.MAT_GLASS))
    p.append(N.box("headlight_r", (0.66, 1.02, -2.38), (0.44, 0.20, 0.08), N.MAT_GLASS))
    p.append(N.box("taillight_l", (-0.72, 1.10, 2.38), (0.30, 0.34, 0.08), N.MAT_PAINT_RED))
    p.append(N.box("taillight_r", (0.72, 1.10, 2.38), (0.30, 0.34, 0.08), N.MAT_PAINT_RED))
    p.append(N.box("grille", (0.0, 0.90, -2.36), (1.30, 0.18, 0.08), N.MAT_STEEL))
    for sx in (-1, 1):
        p.append(N.box(f"mirror{sx}", (sx * 1.22, 1.62, -1.72), (0.24, 0.16, 0.08),
                       N.MAT_STEEL))
        p.append(strut(f"rack{sx}", (sx * 0.74, 2.02, -1.30), (sx * 0.74, 2.02, 1.90),
                       0.030, N.MAT_STEEL))
    return p


def prop_antenna() -> list:
    """
    Lattice mast with a shrouded link dish.

    A three-chord lattice is the cheapest recognisable structure in the whole
    file - twenty six-sided bars, 20 triangles each - and it beats a solid
    post by a mile because the sky shows through it.
    """
    p: list = []
    r_mast, top = 0.17, 3.42
    p.append(N.rounded_box("base", (0.0, 0.06, 0.0), (0.62, 0.12, 0.62),
                           N.MAT_STEEL, radius=0.014, segments=1))
    legs = [(math.cos(i / 3 * math.tau + 0.5) * r_mast,
             math.sin(i / 3 * math.tau + 0.5) * r_mast) for i in range(3)]
    for i, (x, z) in enumerate(legs):
        p.append(strut(f"leg{i}", (x, 0.10, z), (x, top, z), 0.032, N.MAT_STEEL))
        p.append(bolt(f"leg_bolt{i}", (x, 0.13, z), 0.030, 0.026))
    # Lacing: a horizontal triangle every 0.8 m, diagonals between them.
    for level in range(5):
        y = 0.34 + level * 0.78
        for i in range(3):
            a, b = legs[i], legs[(i + 1) % 3]
            p.append(strut(f"lace{level}_{i}", (a[0], y, a[1]), (b[0], y, b[1]),
                           0.020, N.MAT_STEEL))
            if level < 4:
                p.append(strut(f"diag{level}_{i}", (a[0], y, a[1]),
                               (b[0], y + 0.78, b[1]), 0.016, N.MAT_STEEL))
    # Link dish on a side arm: drum shroud, concave face, feed horn.
    dx, dy = 0.0, 2.72
    p.append(strut("dish_arm", (0.0, dy, 0.10), (0.0, dy, -0.64), 0.045, N.MAT_STEEL))
    p.append(zlathe("dish", [
        (0.42, -0.86), (0.42, -0.52), (0.40, -0.50), (0.40, -0.84), (0.42, -0.86),
    ], N.MAT_STEEL, 14, center=(dx, dy), cap_start=False, cap_end=False))
    p.append(zlathe("dish_face", [
        (0.05, -0.62), (0.40, -0.84), (0.40, -0.80), (0.05, -0.58), (0.05, -0.62),
    ], N.MAT_WHITE, 14, center=(dx, dy), cap_start=False, cap_end=False))
    p.append(zlathe("feed", [(0.05, -0.98), (0.07, -0.92), (0.07, -0.66)],
                    N.MAT_STEEL, 8, center=(dx, dy)))
    # Whips and a beacon at the top, cable bundle down one leg.
    for i, (x, z) in enumerate(legs[:2]):
        p.append(strut(f"whip{i}", (x, top, z), (x * 1.5, top + 0.52, z * 1.5),
                       0.012, N.MAT_STEEL))
    p.append(vlathe("beacon", [(0.09, top), (0.09, top + 0.14), (0.05, top + 0.19)],
                    N.MAT_PAINT_RED, 8))
    p.append(strut("cable", (legs[2][0] * 0.7, 0.14, legs[2][1] * 0.7),
                   (legs[2][0] * 0.7, 2.60, legs[2][1] * 0.7), 0.026, N.MAT_BODY_DARK))
    return p


def prop_holo_sign() -> list:
    """
    Illuminated wall lightbox, centred on itself.

    The face is `MAT_TEAM` because the maps pass a tint colour for these; the
    frame around it is a real recess, so the panel sits *in* the box and the
    hood above it casts onto it.
    """
    p: list = []
    frame = N.rounded_box("frame", (0.0, 0.0, 0.02), (1.50, 2.20, 0.16),
                          N.MAT_CONCRETE, radius=0.018, segments=1)
    p.append(cut(frame, [N.box("face_well", (0.0, 0.0, -0.06), (1.30, 2.00, 0.10),
                               N.MAT_CONCRETE)], "frame_cutter"))
    p.append(N.box("face", (0.0, 0.0, -0.045), (1.28, 1.98, 0.03), N.MAT_TEAM))
    for i in range(3):
        p.append(N.box(f"glyph{i}", (0.0, 0.56 - i * 0.52, -0.068),
                       (0.92 - i * 0.18, 0.22, 0.02), N.MAT_WHITE))
    # Mounting arm back to the wall, plus a hood and its two floods.
    p.append(N.box("arm", (0.0, 0.0, 0.22), (0.20, 0.34, 0.24), N.MAT_STEEL))
    p.append(N.rounded_box("wall_plate", (0.0, 0.0, 0.34), (0.42, 0.60, 0.05),
                           N.MAT_STEEL, radius=0.012, segments=1))
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(bolt(f"plate_bolt{sx}{sy}", (sx * 0.14, sy * 0.22, 0.375),
                          0.024, 0.020, N.MAT_STEEL, axis="Z"))
    p.append(N.wedge("hood", (0.0, 1.16, -0.02), (1.54, 0.16, 0.26), N.MAT_STEEL,
                     rotation=(90, 0, 0)))
    for sx in (-1, 1):
        p.append(vlathe(f"flood{sx}", [(0.09, 1.20), (0.09, 1.30), (0.07, 1.32)],
                        N.MAT_STEEL, 8, center=(sx * 0.44, -0.14)))
    return p


def prop_holo_billboard() -> list:
    """
    Roof billboard: two posts, a braced frame, a service catwalk and floods.

    The catwalk and the floodlights are what make it a structure someone
    maintains rather than a poster floating on sticks.
    """
    p: list = []
    for sx in (-1, 1):
        x = sx * 1.70
        p.append(vcol(f"post{sx}", chamfer(N.rect_profile(0.20, 0.20), 0.016),
                      0.0, 2.55, N.MAT_STEEL, center=(x, 0.0)))
        p.append(N.rounded_box(f"foot{sx}", (x, 0.045, 0.0), (0.46, 0.09, 0.46),
                               N.MAT_STEEL, radius=0.012, segments=1))
        for sz in (-1, 1):
            p.append(bolt(f"foot_bolt{sx}{sz}", (x + sx * 0.15, 0.10, sz * 0.15),
                          0.026, 0.024))
        # Back braces.
        p.append(strut(f"brace{sx}", (x, 1.30, 0.06), (x + sx * 0.90, 0.10, 0.70),
                       0.036, N.MAT_STEEL))
    board = N.rounded_box("board", (0.0, 2.60, 0.0), (3.80, 2.40, 0.18),
                          N.MAT_CONCRETE, radius=0.020, segments=1)
    p.append(cut(board, [N.box("board_well", (0.0, 2.60, -0.08), (3.54, 2.14, 0.12),
                               N.MAT_CONCRETE)], "board_cutter"))
    p.append(N.box("face", (0.0, 2.60, -0.062), (3.52, 2.12, 0.04), N.MAT_TEAM))
    for i in range(3):
        p.append(N.box(f"glyph{i}", (-1.02 + i * 1.02, 2.60, -0.088),
                       (0.58, 1.10, 0.02), N.MAT_WHITE))
    # Catwalk under the board with a rail, and three floods aimed up at it.
    p.append(N.box("catwalk", (0.0, 1.34, 0.30), (3.60, 0.05, 0.44), N.MAT_STEEL))
    p += handrail("cw", [(-1.74, 0.50), (0.0, 0.50), (1.74, 0.50)], 1.36, 0.86)
    for i in range(3):
        x = -1.20 + i * 1.20
        p.append(N.box(f"flood_arm{i}", (x, 1.44, 0.20), (0.08, 0.16, 0.08), N.MAT_STEEL))
        # Built at the origin, then tipped back so it points up at the face.
        p.append(vlathe(f"flood{i}", [(0.13, 0.0), (0.15, 0.12), (0.12, 0.14)],
                        N.MAT_STEEL, 10))
        p[-1].location = (x, 1.52, 0.16)
        p[-1].rotation_euler = (math.radians(-30), 0.0, 0.0)
    return p


def prop_spawn_arch() -> list:
    """
    Spawn portal: two I-beam legs, a box lintel, hazard-striped bases.

    Big and simple on purpose - it is read at a glance from across the map
    while the player is waiting to respawn, so the silhouette and the team
    colour under the lintel do all the work.
    """
    p: list = []
    leg_sec = chamfer(ibeam(0.42, 0.52, 0.08, 0.08), 0.018)
    for sx in (-1, 1):
        x = sx * 2.60
        p.append(vcol(f"leg{sx}", leg_sec, 0.14, 3.30, N.MAT_CONCRETE, center=(x, 0.0)))
        p.append(N.rounded_box(f"base{sx}", (x, 0.07, 0.0), (0.80, 0.14, 0.86),
                               N.MAT_STEEL, radius=0.016, segments=1))
        for sz in (-1, 1):
            p.append(bolt(f"base_bolt{sx}{sz}", (x + sx * 0.28, 0.155, sz * 0.30),
                          0.034, 0.030, N.MAT_STEEL))
        p += hazard_band(f"leg_mark{sx}", (x, 0.62, -0.28), 0.40, 0.56,
                         count=4, thickness=0.016)
    # Lintel runs across X: extruded along Z, then yawed a quarter turn.
    lintel = N.extrude_profile("lintel", chamfer(N.rect_profile(0.62, 0.56), 0.026),
                               -2.94, 2.94, N.MAT_CONCRETE, center=(0.0, 3.42))
    lintel.rotation_euler = (0.0, math.radians(90), 0.0)
    p.append(lintel)
    p.append(N.box("lintel_light", (0.0, 3.12, 0.0), (5.16, 0.16, 0.34), N.MAT_TEAM))
    p.append(N.rounded_box("sign", (0.0, 3.86, 0.0), (1.60, 0.44, 0.10),
                           N.MAT_STEEL, radius=0.014, segments=1))
    for i in range(5):
        p.append(stripe(f"chev{i}", (-2.0 + i * 1.0, 0.03, 0.10), 0.30, 0.05,
                        0.62, lean=0.0, material=N.MAT_TEAM))
    return p


# ---------------------------------------------------------------------------
# Superstructure
# ---------------------------------------------------------------------------


def prop_strut() -> list:
    """
    Four-chord lattice column, 5 m, centred on itself.

    Carries the terminal's upper deck in the map, so it wants to look like it
    could: bolted end plates, K-bracing on all four faces.
    """
    p: list = []
    h, r = 2.44, 0.30
    corners = [(-r, -r), (r, -r), (r, r), (-r, r)]
    for i, (x, z) in enumerate(corners):
        p.append(strut(f"chord{i}", (x, -h, z), (x, h, z), 0.058, N.MAT_STEEL))
    for level in range(5):
        y = -h + level * (h * 2 / 4.0)
        for i in range(4):
            a, b = corners[i], corners[(i + 1) % 4]
            p.append(strut(f"lace{level}_{i}", (a[0], y, a[1]), (b[0], y, b[1]),
                           0.030, N.MAT_STEEL))
            if level < 4 and i % 2 == 0:
                p.append(strut(f"diag{level}_{i}", (a[0], y, a[1]),
                               (b[0], y + h * 2 / 4.0, b[1]), 0.026, N.MAT_STEEL))
    for sy in (-1, 1):
        p.append(N.rounded_box(f"plate{sy}", (0.0, sy * (h + 0.05), 0.0),
                               (0.86, 0.10, 0.86), N.MAT_CONCRETE,
                               radius=0.016, segments=1))
        for sx in (-1, 1):
            for sz in (-1, 1):
                p.append(bolt(f"pbolt{sy}{sx}{sz}",
                              (sx * 0.32, sy * (h + 0.12), sz * 0.32),
                              0.032, 0.030))
    return p


def prop_satellite() -> list:
    """
    Rooftop radar array, centred on itself.

    The dish is a genuine paraboloid shell - eleven profile points swept about
    Z - and a curved reflector catches light along a moving highlight in a way
    a disc simply cannot. The feed horn on its tripod is what tells you which
    way it is looking.
    """
    p: list = []
    shell = N.MAT_WHITE
    core = N.rounded_box("core", (0.0, 0.0, 0.30), (1.60, 1.60, 2.20), shell,
                         radius=0.040, segments=1)
    p.append(cut(core, [
        N.box("core_panel_l", (-0.82, 0.0, 0.30), (0.10, 1.10, 1.60), shell),
        N.box("core_panel_r", (0.82, 0.0, 0.30), (0.10, 1.10, 1.60), shell),
        N.box("core_seam", (0.0, 0.84, 0.30), (1.20, 0.10, 1.70), shell),
    ], "core_cutter"))
    # Parabolic reflector: front face out, rim, rear face back.
    p.append(zlathe("dish", [
        (0.10, -1.72), (0.48, -1.66), (0.88, -1.50), (1.20, -1.30), (1.50, -1.06),
        (1.56, -1.02), (1.50, -0.98), (1.20, -1.22), (0.88, -1.42), (0.48, -1.58),
        (0.10, -1.64), (0.10, -1.72),
    ], N.MAT_WHITE, 16, cap_start=False, cap_end=False))
    p.append(zlathe("dish_hub", [
        (0.22, -1.70), (0.22, -1.30), (0.16, -1.24),
    ], N.MAT_TRIM, 12))
    for i in range(3):
        a = i / 3 * math.tau + 0.4
        p.append(strut(f"feed_leg{i}", (math.cos(a) * 1.16, math.sin(a) * 1.16, -1.28),
                       (0.0, 0.0, -2.24), 0.030, N.MAT_TRIM))
    p.append(zlathe("feed", [(0.09, -2.34), (0.15, -2.22), (0.15, -2.02)],
                    N.MAT_TRIM, 10))
    # Panel wings on braced arms.
    for sx in (-1, 1):
        p.append(strut(f"arm{sx}", (sx * 0.80, 0.0, 0.20), (sx * 1.90, 0.0, 0.20),
                       0.070, N.MAT_TRIM))
        wing = N.rounded_box(f"wing{sx}", (sx * 3.60, 0.0, 0.20), (3.50, 0.10, 2.00),
                             N.MAT_VISOR, radius=0.020, segments=1)
        p.append(cut(wing, [
            N.box(f"cell{sx}_{i}_{sy}", (sx * (2.10 + i * 1.00), sy * 0.05, 0.20),
                  (0.05, 0.05, 1.94), N.MAT_VISOR)
            for i in range(4) for sy in (-1, 1)
        ], f"wing{sx}_cutter"))
    # Mount and antenna stubs at the back.
    p.append(zlathe("mount", [(0.30, 1.36), (0.30, 1.70), (0.22, 1.76)], N.MAT_TRIM, 12))
    for sx in (-1, 1):
        p.append(strut(f"stub{sx}", (sx * 0.50, 0.86, 1.10), (sx * 0.70, 1.60, 1.30),
                       0.026, N.MAT_TRIM))
    return p


def prop_spire_collar() -> list:
    """
    Bracket collar around the terminal spire, centred on itself.

    Twelve chamfered gussets on a rolled band. Extruding an already-chamfered
    triangle is 20 triangles a gusset, so the whole ring of them costs less
    than one bevelled box would.
    """
    p: list = []
    p.append(vlathe("band", [
        (3.30, -0.42), (3.62, -0.42), (3.62, 0.42), (3.30, 0.42),
        (3.30, 0.30), (3.50, 0.24), (3.50, -0.24), (3.30, -0.30), (3.30, -0.42),
    ], N.MAT_CONCRETE, 20, cap_start=False, cap_end=False))
    gusset = chamfer([(-0.62, -0.44), (0.62, -0.06), (0.62, 0.06), (-0.62, 0.44)], 0.05)
    for i in range(12):
        a = i / 12 * math.tau
        cx, cz = math.cos(a) * 4.00, math.sin(a) * 4.00
        # Profile x is radial and profile y is up, so a yaw is the only rotation
        # needed and the plate stays vertical with its thickness tangential.
        g = N.extrude_profile(f"gusset{i}", gusset, -0.09, 0.09, N.MAT_STEEL)
        g.location = (cx, 0.0, cz)
        g.rotation_euler = (0.0, -a, 0.0)
        p.append(g)
        p.append(N.rounded_box(f"pad{i}", (math.cos(a) * 4.58, 0.0, math.sin(a) * 4.58),
                               (0.14, 0.34, 0.26), N.MAT_HAZARD,
                               radius=0.020, segments=1,
                               rotation=(0, -math.degrees(a), 0)))
    return p


def prop_holo_globe() -> list:
    """
    Navigation beacon at the top of the spire, centred on itself.

    A glazed lantern drum with the lamp inside it, so the tint the map passes
    lights the object from within rather than painting its outside. Mullions
    between the panes keep it from reading as a plain glass cylinder.
    """
    p: list = []
    p.append(vlathe("pedestal", [
        (0.90, -1.30), (0.90, -1.10), (0.74, -1.00), (0.74, -0.82), (0.62, -0.76),
    ], N.MAT_CONCRETE, 12))
    # Lamp: the tinted part, inside the glass.
    p.append(vlathe("lamp", [
        (0.42, -0.66), (0.56, -0.44), (0.56, 0.44), (0.42, 0.66),
    ], N.MAT_TEAM, 10))
    # Glazing: a closed shell so it is solid from both sides.
    p.append(vlathe("glazing", [
        (1.02, -0.76), (1.02, 0.76), (0.96, 0.76), (0.96, -0.76), (1.02, -0.76),
    ], N.MAT_GLASS, 14, cap_start=False, cap_end=False))
    for i in range(8):
        a = i / 8 * math.tau
        p.append(N.box(f"mullion{i}", (math.cos(a) * 1.01, 0.0, math.sin(a) * 1.01),
                       (0.09, 1.56, 0.09), N.MAT_CONCRETE,
                       rotation=(0, -math.degrees(a), 0)))
    p.append(vlathe("sill", [
        (1.10, -0.90), (1.10, -0.74), (0.94, -0.70),
    ], N.MAT_CONCRETE, 14))
    p.append(vlathe("crown", [
        (0.94, 0.72), (1.12, 0.80), (1.12, 0.92), (0.70, 1.14), (0.30, 1.22),
    ], N.MAT_CONCRETE, 14))
    p.append(vlathe("finial", [(0.10, 1.20), (0.10, 1.46), (0.05, 1.52)], N.MAT_TRIM, 8))
    for i in range(4):
        a = i / 4 * math.tau + 0.4
        p.append(strut(f"stay{i}", (math.cos(a) * 0.30, 1.20, math.sin(a) * 0.30),
                       (math.cos(a) * 1.06, 0.86, math.sin(a) * 1.06), 0.030, N.MAT_TRIM))
    return p


# ---------------------------------------------------------------------------
# Pickups
#
# These hover and spin above a pedestal, so they are centred on their own
# middle and have to read from every side - no back face to hide detail on.
# They are also the closest a player gets to any of these models, so they take
# a two-segment bevel where the environment props take one.
# ---------------------------------------------------------------------------


def pickup_health() -> list:
    """Field medical case: recessed cross both sides, latches, folding handle."""
    p: list = []
    case = N.rounded_box("case", (0.0, 0.0, 0.0), (0.52, 0.46, 0.30),
                         N.MAT_WHITE, radius=0.026, segments=2)
    cutters = [N.box(f"lid_seam{j}", (nx * 0.25, 0.13, nz * 0.14),
                     (0.06 if nx else 0.56, 0.020, 0.06 if nz else 0.34), N.MAT_WHITE)
               for j, (nx, nz) in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1)))]
    for sz in (-1, 1):
        cutters.append(N.box(f"cross_v{sz}", (0.0, -0.02, sz * 0.14),
                             (0.10, 0.26, 0.04), N.MAT_WHITE))
        cutters.append(N.box(f"cross_h{sz}", (0.0, -0.02, sz * 0.14),
                             (0.26, 0.10, 0.04), N.MAT_WHITE))
    p.append(cut(case, cutters, "case_cutter"))
    for sz in (-1, 1):
        p.append(N.box(f"mark_v{sz}", (0.0, -0.02, sz * 0.138), (0.09, 0.25, 0.025),
                       N.MAT_PAINT_RED))
        p.append(N.box(f"mark_h{sz}", (0.0, -0.02, sz * 0.138), (0.25, 0.09, 0.025),
                       N.MAT_PAINT_RED))
    for sx in (-1, 1):
        p.append(N.rounded_box(f"latch{sx}", (sx * 0.16, 0.12, -0.15),
                               (0.10, 0.09, 0.04), N.MAT_TRIM, radius=0.010, segments=1))
    p.append(N.box("handle", (0.0, 0.26, 0.0), (0.20, 0.04, 0.05), N.MAT_TRIM))
    for sx in (-1, 1):
        p.append(N.box(f"handle_leg{sx}", (sx * 0.09, 0.22, 0.0), (0.03, 0.10, 0.04),
                       N.MAT_TRIM))
    return p


def pickup_shield() -> list:
    """Ceramic torso plate: genuinely curved, with a strap band across the back."""
    p: list = []
    # Crescent section in (x, z), swept up Y and pinched at both ends. The
    # outer face bulges toward -Z, which is forward: the strap goes on the
    # concave side and the boss on the convex one, and getting that the wrong
    # way round leaves both of them floating a centimetre off the plate.
    def arc(scale: float) -> list[tuple[float, float]]:
        outer, inner = [], []
        for i in range(7):
            a = math.radians(-46 + i * (92 / 6.0))
            outer.append((math.sin(a) * 0.30 * scale, 0.26 - math.cos(a) * 0.30))
            inner.append((math.sin(a) * 0.26 * scale, 0.24 - math.cos(a) * 0.26))
        return outer + list(reversed(inner))

    def face(x: float) -> float:
        """Where the outer surface sits at a given lateral offset."""
        return 0.26 - math.cos(math.asin(min(0.99, abs(x) / 0.30))) * 0.30

    p.append(N.loft("plate", [
        (-0.30, arc(0.72)), (-0.22, arc(0.94)), (0.20, arc(1.00)), (0.30, arc(0.80)),
    ], N.MAT_BODY_DARK, smooth=False, axis="Y"))
    p.append(N.rounded_box("boss", (0.0, 0.02, face(0.0) - 0.012), (0.13, 0.13, 0.05),
                           N.MAT_STEEL, radius=0.014, segments=1))
    # Carry strap across the concave back, in three spans that follow the curve.
    for i, x in enumerate((-0.11, 0.0, 0.11)):
        p.append(N.box(f"strap{i}", (x, 0.02, face(x) + 0.044), (0.12, 0.07, 0.040),
                       N.MAT_CLOTH_DARK, rotation=(0, -math.degrees(x * 1.7), 0)))
    for sx in (-1, 1):
        p.append(N.rounded_box(f"buckle{sx}", (sx * 0.115, 0.02, face(sx * 0.115) + 0.040),
                               (0.05, 0.09, 0.036), N.MAT_STEEL, radius=0.010, segments=1))
    return p


def pickup_ammo() -> list:
    """M2A1-pattern ammunition can: recessed flanks, cam latch, folding bail."""
    p: list = []
    can = N.rounded_box("can", (0.0, -0.03, 0.0), (0.58, 0.28, 0.34),
                        N.MAT_BODY, radius=0.022, segments=2)
    p.append(cut(can, [
        N.box("flank_l", (-0.30, -0.04, 0.0), (0.06, 0.16, 0.22), N.MAT_BODY),
        N.box("flank_r", (0.30, -0.04, 0.0), (0.06, 0.16, 0.22), N.MAT_BODY),
        N.box("front_panel", (0.0, -0.04, -0.18), (0.40, 0.15, 0.06), N.MAT_BODY),
        N.box("back_panel", (0.0, -0.04, 0.18), (0.40, 0.15, 0.06), N.MAT_BODY),
    ], "can_cutter"))
    p.append(N.rounded_box("lid", (0.0, 0.14, 0.0), (0.60, 0.08, 0.36),
                           N.MAT_TRIM, radius=0.018, segments=2))
    p.append(N.rounded_box("latch", (0.0, 0.15, -0.20), (0.16, 0.10, 0.06),
                           N.MAT_TRIM, radius=0.012, segments=1))
    # Folding bail handle.
    p.append(N.box("bail", (0.0, 0.28, 0.0), (0.26, 0.03, 0.04), N.MAT_TRIM))
    for sx in (-1, 1):
        p.append(N.box(f"bail_leg{sx}", (sx * 0.12, 0.23, 0.0), (0.03, 0.12, 0.04),
                       N.MAT_TRIM))
        p.append(N.box(f"hinge{sx}", (sx * 0.22, 0.17, 0.17), (0.06, 0.04, 0.05),
                       N.MAT_TRIM))
    for i in range(2):
        p.append(N.box(f"stencil{i}", (0.0, -0.04 + i * 0.08, -0.186),
                       (0.30, 0.045, 0.014), N.MAT_HAZARD))
    return p


def pickup_pedestal() -> list:
    """
    The plinth every pickup stands on. Ground contact at y = 0.

    Octagonal so the hazard plates on its faces can be flat and still lie on
    the surface; a round base would need each one curved or floating.
    """
    p: list = []
    p.append(vlathe("plinth", [
        (0.50, 0.0), (0.56, 0.04), (0.56, 0.10), (0.50, 0.14),
    ], N.MAT_CONCRETE, 8, smooth=False))
    for i in range(8):
        a = (i + 0.5) / 8 * math.tau
        p.append(N.box(f"mark{i}", (math.cos(a) * 0.525, 0.07, math.sin(a) * 0.525),
                       (0.03, 0.07, 0.24), N.MAT_HAZARD,
                       rotation=(0, -math.degrees(a), 0)))
    p.append(vlathe("cap", [
        (0.46, 0.14), (0.46, 0.19), (0.40, 0.22),
    ], N.MAT_STEEL, 12))
    p.append(vlathe("column", [(0.16, 0.20), (0.16, 0.40), (0.13, 0.43)], N.MAT_TRIM, 10))
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        p.append(N.rounded_box(f"prong{i}", (math.cos(a) * 0.32, 0.28, math.sin(a) * 0.32),
                               (0.09, 0.26, 0.09), N.MAT_STEEL, radius=0.014, segments=1,
                               rotation=(0, -math.degrees(a), 0)))
    return p


# ---------------------------------------------------------------------------
# Objectives and deployables
#
# Everything here has one `MAT_TEAM` part, which is the hook the client
# recolours to the owning team. Hazard yellow is emissive too, so it is kept
# off these models: it would be repainted along with the team mark.
# ---------------------------------------------------------------------------


def obj_zone_marker() -> list:
    """Capture-point post: concrete pad, square mast, backlit team panel."""
    p: list = []
    p.append(vlathe("pad", [
        (1.04, 0.0), (1.10, 0.05), (1.10, 0.14), (1.02, 0.18),
    ], N.MAT_CONCRETE, 8, smooth=False))
    for i in range(8):
        a = (i + 0.5) / 8 * math.tau
        p.append(N.box(f"chev{i}", (math.cos(a) * 1.06, 0.09, math.sin(a) * 1.06),
                       (0.04, 0.09, 0.44), N.MAT_STEEL,
                       rotation=(0, -math.degrees(a), 0)))
    p.append(vcol("mast", chamfer(N.rect_profile(0.26, 0.26), 0.020), 0.16, 2.06,
                  N.MAT_CONCRETE))
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        p.append(N.wedge(f"brace{i}", (math.cos(a) * 0.34, 0.18, math.sin(a) * 0.34),
                         (0.16, 0.46, 0.36), N.MAT_STEEL,
                         rotation=(0, -math.degrees(a) + 180, 0)))
    panel = N.rounded_box("panel", (0.0, 2.00, 0.0), (0.94, 0.94, 0.14),
                          N.MAT_CONCRETE, radius=0.020, segments=1)
    p.append(cut(panel, [
        N.box("panel_well_f", (0.0, 2.00, -0.05), (0.78, 0.78, 0.08), N.MAT_CONCRETE),
        N.box("panel_well_b", (0.0, 2.00, 0.05), (0.78, 0.78, 0.08), N.MAT_CONCRETE),
    ], "panel_cutter"))
    for sz in (-1, 1):
        p.append(N.box(f"face{sz}", (0.0, 2.00, sz * 0.038), (0.76, 0.76, 0.03),
                       N.MAT_TEAM))
    p.append(vlathe("beacon", [
        (0.13, 2.50), (0.15, 2.56), (0.13, 2.64), (0.07, 2.70),
    ], N.MAT_TEAM, 10))
    p.append(vlathe("beacon_cap", [(0.15, 2.44), (0.15, 2.50)], N.MAT_STEEL, 10))
    return p


def obj_core() -> list:
    """
    The stealable item: a pressurised canister in a carry frame.

    Something a player can believe is picked up and run with, rather than a
    floating shape - hence the frame, the handles and the valve.
    """
    p: list = []
    p.append(vlathe("canister", [
        (0.10, 0.16), (0.26, 0.20), (0.29, 0.28),
        (0.29, 0.78), (0.26, 0.86), (0.10, 0.90),
    ], N.MAT_STEEL, 14))
    p.append(vlathe("band", ring_profile(0.31, 0.285, 0.16, 0.45), N.MAT_TEAM, 14,
                    cap_start=False, cap_end=False))
    p.append(vlathe("valve", [
        (0.07, 0.88), (0.07, 0.99), (0.11, 1.00), (0.11, 1.04),
    ], N.MAT_TRIM, 8))
    # Carry frame: four uprights between a base ring and a top ring.
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        x, z = math.cos(a) * 0.36, math.sin(a) * 0.36
        p.append(strut(f"upright{i}", (x, 0.04, z), (x, 1.02, z), 0.030, N.MAT_BODY_DARK))
    for y in (0.06, 1.00):
        p.append(vlathe(f"ring{y:.2f}", ring_profile(0.40, 0.32, 0.06, y),
                        N.MAT_BODY_DARK, 12, cap_start=False, cap_end=False))
    for sx in (-1, 1):
        p.append(strut(f"handle{sx}", (sx * 0.30, 1.02, -0.18), (sx * 0.30, 1.02, 0.18),
                       0.026, N.MAT_BODY_DARK))
    p.append(N.rounded_box("plate", (0.0, 0.74, -0.29), (0.16, 0.20, 0.05),
                           N.MAT_TRIM, radius=0.012, segments=1))
    return p


def dep_turret() -> list:
    """Deployed sentry: tripod, traversing head, twin hollow barrels, ammo box."""
    p: list = []
    dark = N.MAT_CONCRETE
    p.append(vlathe("hub", [
        (0.17, 0.06), (0.21, 0.10), (0.21, 0.20), (0.15, 0.24),
    ], dark, 10))
    for i in range(3):
        a = i / 3 * math.tau + math.pi / 6
        x, z = math.cos(a) * 0.52, math.sin(a) * 0.52
        p.append(strut(f"leg{i}", (x * 0.26, 0.22, z * 0.26), (x, 0.03, z), 0.032,
                       N.MAT_STEEL))
        p.append(N.rounded_box(f"foot{i}", (x, 0.025, z), (0.16, 0.05, 0.16),
                               N.MAT_RUBBER, radius=0.012, segments=1))
    p.append(vlathe("post", [(0.13, 0.22), (0.13, 0.46), (0.16, 0.48)], N.MAT_STEEL, 10))
    head = N.rounded_box("head", (0.0, 0.63, 0.0), (0.44, 0.32, 0.44), dark,
                         radius=0.020, segments=1)
    p.append(cut(head, [
        N.box("optic_well", (0.0, 0.66, -0.20), (0.20, 0.12, 0.08), dark),
        N.box("vent_l", (-0.22, 0.60, 0.06), (0.06, 0.16, 0.20), dark),
        N.box("vent_r", (0.22, 0.60, 0.06), (0.06, 0.16, 0.20), dark),
    ], "head_cutter"))
    p.append(N.box("optic", (0.0, 0.66, -0.180), (0.18, 0.10, 0.03), N.MAT_TEAM))
    for sx in (-1, 1):
        p.append(zlathe(f"barrel{sx}", [
            (0.045, -0.52), (0.052, -0.49), (0.052, -0.06),
            (0.032, -0.06), (0.032, -0.52), (0.045, -0.52),
        ], N.MAT_STEEL, 10, center=(sx * 0.12, 0.60), cap_start=False, cap_end=False))
    p.append(N.rounded_box("mag", (0.0, 0.76, 0.16), (0.28, 0.20, 0.22), N.MAT_STEEL,
                           radius=0.014, segments=1))
    p.append(N.box("mag_latch", (0.0, 0.76, 0.28), (0.10, 0.06, 0.03), N.MAT_STEEL))
    return p


def dep_barrier() -> list:
    """Deployed barricade: braced posts and slatted infill on foot plates."""
    p: list = []
    dark = N.MAT_CONCRETE
    slat = chamfer(N.rect_profile(0.16, 0.06), 0.014)
    for sx in (-1, 1):
        x = sx * 1.42
        p.append(vcol(f"post{sx}", chamfer(N.rect_profile(0.22, 0.30), 0.018),
                      0.10, 2.20, dark, center=(x, 0.0)))
        p.append(N.rounded_box(f"foot{sx}", (x, 0.05, 0.0), (0.52, 0.10, 0.66),
                               N.MAT_STEEL, radius=0.014, segments=1))
        p.append(N.box(f"post_light{sx}", (x, 1.30, -0.16), (0.08, 1.50, 0.04),
                       N.MAT_TEAM))
        p.append(strut(f"brace{sx}", (x, 1.00, 0.0), (x + sx * 0.52, 0.10, 0.30),
                       0.040, N.MAT_STEEL))
    for i in range(6):
        y = 0.36 + i * 0.32
        sec = [(v + y, u) for u, v in slat]
        p.append(N.loft(f"slat{i}", [(-1.42, sec), (1.42, sec)], N.MAT_STEEL,
                        smooth=False, axis="X"))
    return p


def dep_field() -> list:
    """Deployed support emitter: tripod, canister, ring head, cooling vanes."""
    p: list = []
    dark = N.MAT_CONCRETE
    for i in range(3):
        a = i / 3 * math.tau
        x, z = math.cos(a) * 0.44, math.sin(a) * 0.44
        p.append(strut(f"leg{i}", (x * 0.35, 0.34, z * 0.35), (x, 0.03, z), 0.035,
                       N.MAT_STEEL))
        p.append(N.rounded_box(f"foot{i}", (x, 0.03, z), (0.16, 0.06, 0.16),
                               N.MAT_RUBBER, radius=0.012, segments=1))
    body = vlathe("body", [
        (0.20, 0.14), (0.26, 0.22), (0.26, 0.66), (0.22, 0.74),
    ], dark, 12)
    p.append(cut(body, [
        N.box("panel_well", (0.0, 0.44, -0.24), (0.22, 0.24, 0.10), dark),
    ], "body_cutter"))
    p.append(N.box("panel", (0.0, 0.44, -0.235), (0.20, 0.22, 0.03), N.MAT_TEAM))
    p.append(vlathe("neck", [(0.11, 0.72), (0.11, 0.92)], N.MAT_STEEL, 10))
    p.append(vlathe("ring", ring_profile(0.34, 0.24, 0.09, 0.92), N.MAT_TEAM, 14,
                    cap_start=False, cap_end=False))
    p.append(vlathe("cap", [
        (0.20, 0.98), (0.20, 1.06), (0.12, 1.12),
    ], N.MAT_STEEL, 12))
    for i in range(3):
        a = i / 3 * math.tau + math.pi / 3
        p.append(N.rounded_box(f"vane{i}", (math.cos(a) * 0.28, 0.86, math.sin(a) * 0.28),
                               (0.16, 0.34, 0.07), N.MAT_STEEL, radius=0.012, segments=1,
                               rotation=(0, -math.degrees(a), 14)))
    return p


def dep_dome() -> list:
    """
    Deployed cover dome: a glazed shell on a ribbed base ring.

    A real shell rather than a single surface, because materials export with
    backface culling on now: a one-sided dome would disappear the moment the
    player stood inside it.
    """
    p: list = []
    shell: list[tuple[float, float]] = []
    steps = 6
    for i in range(steps + 1):
        a = i / steps * (math.pi / 2)
        shell.append((math.cos(a) * 1.00, math.sin(a) * 1.00))
    inner = [(r * 0.965, y * 0.965) for r, y in reversed(shell)]
    p.append(vlathe("dome", shell + inner + [shell[0]], N.MAT_GLASS, 14,
                    cap_start=False, cap_end=False))
    for y, r in ((0.42, 0.925), (0.76, 0.665)):
        p.append(vlathe(f"hoop{y:.2f}", ring_profile(r + 0.03, r - 0.03, 0.05, y),
                        N.MAT_TEAM, 14, cap_start=False, cap_end=False))
    p.append(vlathe("base", [
        (1.06, 0.0), (1.06, 0.10), (0.98, 0.14), (0.94, 0.10), (0.94, 0.0),
    ], N.MAT_CONCRETE, 14, cap_start=False, cap_end=False))
    for i in range(8):
        a = i / 8 * math.tau
        p.append(N.rounded_box(f"rib{i}", (math.cos(a) * 0.99, 0.16, math.sin(a) * 0.99),
                               (0.08, 0.24, 0.10), N.MAT_STEEL, radius=0.014, segments=1,
                               rotation=(0, -math.degrees(a), 0)))
    return p


def dep_grenade() -> list:
    """Thrown charge: ogive nose forward along -Z, banded body, stabiliser fins."""
    p: list = []
    p.append(zlathe("body", [
        (0.020, -0.130), (0.048, -0.112), (0.066, -0.086), (0.072, -0.050),
        (0.072, 0.070), (0.066, 0.086), (0.048, 0.096),
    ], N.MAT_BODY_DARK, 12))
    p.append(zlathe("band", [
        (0.078, -0.024), (0.078, 0.020), (0.070, 0.020), (0.070, -0.024), (0.078, -0.024),
    ], N.MAT_TEAM, 12, cap_start=False, cap_end=False))
    p.append(zlathe("fuze", [(0.030, 0.094), (0.034, 0.104), (0.026, 0.112)],
                    N.MAT_TRIM, 8))
    for i in range(4):
        a = i / 4 * math.tau
        p.append(N.box(f"fin{i}", (math.cos(a) * 0.052, math.sin(a) * 0.052, 0.082),
                       (0.052, 0.014, 0.052), N.MAT_TRIM,
                       rotation=(0, 0, math.degrees(a))))
    return p


def team_marker() -> list:
    """
    Floating diamond for objective and teammate indicators.

    An octahedron authored as explicit geometry rather than a rotated cube, so
    the point actually points; bevelled once so its edges catch light as it
    spins.
    """
    p: list = []
    r, h = 0.17, 0.24
    verts = [(0.0, h, 0.0), (r, 0.0, 0.0), (0.0, 0.0, r),
             (-r, 0.0, 0.0), (0.0, 0.0, -r), (0.0, -h, 0.0)]
    # Wound so every normal points out of the solid; the mirrored set renders
    # as a hole now that materials cull backfaces.
    faces = [(0, 2, 1), (0, 3, 2), (0, 4, 3), (0, 1, 4),
             (5, 1, 2), (5, 2, 3), (5, 3, 4), (5, 4, 1)]
    shell = N.mesh_from_data("diamond", verts, faces, N.MAT_TEAM)
    p.append(N.bevel(shell, 0.014, 1))
    core = N.mesh_from_data("core", [(x * 0.42, y * 0.42, z * 0.42) for x, y, z in verts],
                            list(faces), N.MAT_WHITE)
    p.append(core)
    return p


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

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
    # 900 is about where a prop starts costing more than its share at the far
    # end of a sightline; below it the LOD would save nothing worth the extra
    # mesh in the GLB.
    N.finish(name, PROPS[name](), smooth_angle=38.0,
             lod_threshold=900, lod_ratio=0.35, orient="yup")


def main() -> None:
    only = N.only_arg("only")
    targets = [only] if only and only in PROPS else list(PROPS.keys())
    for name in targets:
        N.log(f"building prop {name}")
        build_prop(name)
    N.log(f"props complete ({len(targets)} models)")


if __name__ == "__main__":
    main()
