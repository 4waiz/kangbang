"""
KANG BANG - authoring library self-test.

Checks the invariants that broke silently before, and that nothing in the
normal build would have caught.

The important one is face winding. Every primitive here is a closed solid, so
its signed volume - the sum over triangles of v0 . (v1 x v2) / 6 - must be
positive. A negative volume means the faces are wound inward and the solid
renders inside-out.

That went unnoticed for a long time because the glTF exporter marked every
material double-sided and the client honoured it, so inward-facing geometry
looked identical to outward-facing geometry. Now that materials export with
backface culling on, an inverted mesh renders as a hole. Three primitives were
wrong (`box`, `wedge`, `capsule`), and `loft`/`extrude_profile` additionally
flip whenever the caller stacks sections in descending order, which is the
natural way to write anything that hangs downward.

Run:  blender --background --factory-startup --python assets/scripts/test_lib_kang.py
Exits non-zero on failure so it can gate a build.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import lib_kang as N  # noqa: E402


failures: list[str] = []


def signed_volume(obj: bpy.types.Object) -> float:
    mesh = obj.data
    total = 0.0
    for poly in mesh.polygons:
        co = [mesh.vertices[i].co for i in poly.vertices]
        for i in range(1, len(co) - 1):
            total += co[0].dot(co[i].cross(co[i + 1])) / 6.0
    return total


def expect_outward(label: str, obj: bpy.types.Object) -> None:
    volume = signed_volume(obj)
    if volume <= 0.0:
        failures.append(f"{label}: normals inverted (signed volume {volume:+.8f})")


def expect(label: str, condition: bool, detail: str = "") -> None:
    if not condition:
        failures.append(f"{label}: {detail or 'failed'}")


def test_primitive_winding() -> None:
    N.reset_scene()
    se = lambda: N.superellipse(0.02, 0.03, 4.0, 12)  # noqa: E731

    expect_outward("box", N.box("a", (0, 0, 0), (0.1, 0.1, 0.1)))
    expect_outward("wedge", N.wedge("b", (0, 0, 0), (0.1, 0.1, 0.1)))
    expect_outward("cylinder", N.cylinder("c", (0, 0, 0), 0.05, 0.1))
    expect_outward("sphere", N.sphere("d", (0, 0, 0), 0.05))
    expect_outward("capsule", N.capsule("e", (0, 0, 0), 0.03, 0.12))
    expect_outward("lathe", N.lathe("f", [(0.0, 0.0), (0.05, 0.0), (0.05, 0.1), (0.0, 0.1)]))
    expect_outward("tube", N.tube("g", 0.05, 0.03, 0.0, 0.1))
    expect_outward("knurl", N.knurl("h", 0.0, 0.02, 0.03))
    expect_outward("barrel", N.barrel("i", -0.30, -0.10))
    expect_outward("rounded_box", N.rounded_box("j", (0, 0, 0), (0.1, 0.1, 0.1)))

    # Both extrusion directions, because callers write either.
    expect_outward("extrude_profile ascending", N.extrude_profile("k", se(), 0.0, 0.1))
    expect_outward("extrude_profile descending", N.extrude_profile("l", se(), 0.1, 0.0))

    # Every loft axis, in both section orders. This is the combination that
    # was wrong: the axis permutation and the section order each flip winding,
    # and they cancel when both apply.
    for axis in ("X", "Y", "Z"):
        expect_outward(f"loft {axis} ascending",
                       N.loft(f"m{axis}", [(0.0, se()), (0.1, se())], axis=axis))
        expect_outward(f"loft {axis} descending",
                       N.loft(f"n{axis}", [(0.1, se()), (0.0, se())], axis=axis))


def test_profile_generators_wind_ccw() -> None:
    """
    Every 2D profile fed to `loft` or `extrude_profile` must wind
    counter-clockwise, because that is what those helpers assume when they
    build side faces.

    `gen_characters.oval` is included deliberately. It negates y so that
    `front` lands on -Y - characters face -Y - and that negation mirrors the
    loop, silently reversing the winding. Everything on a character body is
    built from it, so getting this wrong turns all six classes inside-out
    while still producing a plausible mesh and triangle count.
    """
    import gen_characters

    def signed_area(points: list[tuple[float, float]]) -> float:
        total = 0.0
        for i in range(len(points)):
            x0, y0 = points[i]
            x1, y1 = points[(i + 1) % len(points)]
            total += x0 * y1 - x1 * y0
        return total / 2.0

    for label, points in (
        ("superellipse", N.superellipse(0.02, 0.03, 4.0, 12)),
        ("ellipse", N.ellipse(0.02, 0.03, 12)),
        ("rect_profile", N.rect_profile(0.04, 0.06)),
        ("RAIL_PROFILE", N.RAIL_PROFILE),
        ("gen_characters.oval", gen_characters.oval(0.02, 0.03, 0.03, 12)),
    ):
        area = signed_area(points)
        expect(f"{label} winds counter-clockwise", area > 0.0,
               f"signed area {area:+.6f} - profile is clockwise and will loft inside-out")


def test_join_preserves_transforms() -> None:
    """
    `join` bakes each part's world matrix, and `matrix_world` is derived: it is
    not recomputed until the dependency graph re-evaluates. Without an explicit
    update, every part bakes at identity and the whole assembly collapses onto
    the origin - silently, with no error and a plausible-looking triangle count.
    """
    N.reset_scene()
    parts = [N.box(f"b{i}", (i * 0.1, 0.0, 0.0), (0.02, 0.02, 0.02)) for i in range(5)]
    merged = N.join("spread", parts)
    span = max(v.co.x for v in merged.data.vertices) - min(v.co.x for v in merged.data.vertices)
    expect("join preserves part transforms", span > 0.39,
           f"parts collapsed to the origin (x span {span:.4f}, expected ~0.42)")


def test_boolean_cuts_every_cutter() -> None:
    """A rail's slots are one boolean against many joined cutters; the same
    stale-matrix bug made all but one cutter land in the same place."""
    N.reset_scene()
    rail = N.picatinny("rail", 0.0, 0.30, 0.0)
    tris = N.triangle_count(rail)
    expect("picatinny cuts all slots", tris > 400,
           f"only {tris} triangles - slots were not all cut")


def test_materials_cull_backfaces() -> None:
    N.reset_scene()
    for name in (N.MAT_BODY, N.MAT_SKIN, N.MAT_GLASS):
        mat = N.get_material(name)
        expect(f"{name} culls backfaces", mat.use_backface_culling,
               "would export doubleSided and double the fragment cost")


def test_team_material_is_tintable() -> None:
    """The client only tints materials whose emissive is non-zero, so a team
    material with no emission can never be recoloured."""
    N.reset_scene()
    spec = N.MATERIAL_LIBRARY[N.MAT_TEAM]
    expect("team material has emission", spec[3] is not None and spec[4] > 0.0,
           "ns_team must keep a non-zero emission to stay tintable")


def main() -> None:
    test_primitive_winding()
    test_profile_generators_wind_ccw()
    test_join_preserves_transforms()
    test_boolean_cuts_every_cutter()
    test_materials_cull_backfaces()
    test_team_material_is_tintable()

    if failures:
        N.log(f"FAILED ({len(failures)})")
        for line in failures:
            N.log(f"  - {line}")
        sys.exit(1)
    N.log("lib_kang self-test passed")


if __name__ == "__main__":
    main()
