"""
KANG BANG - asset preview renderer.

Renders generated assets to PNG so they can be judged as images rather than as
triangle counts. The generators are pure functions that return part lists, so
this imports them directly and never touches the exported GLBs - what you see
is what the next `npm run assets` will produce.

Two things it is worth knowing about the framing:

  * Weapons and props are authored +Y up / -Z forward, and are shown after the
    same `reorient("yup")` the exporter applies, so the preview and the game
    agree about which way round the model is. A weapon is rendered in
    orthographic side elevation, because that is the view that shows whether
    proportions are right.
  * Characters are authored Z up facing -Y and are shown from a three-quarter
    front view at eye height, which is roughly how another player sees them.

Run:
  blender --background --factory-startup --python assets/scripts/preview.py \
      -- --out=<dir> [--set=weapons|characters|props] [--only=<id>]
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import mathutils  # noqa: E402

import lib_kang as N  # noqa: E402


def _clear_lights_and_camera() -> None:
    for obj in list(bpy.data.objects):
        if obj.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(obj, do_unlink=True)


def _studio(center: mathutils.Vector, radius: float, key: float = 1.0) -> None:
    """Three-point rig scaled to the subject, plus a dim world fill."""
    scene = bpy.context.scene
    world = bpy.data.worlds.get("preview_world") or bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.048, 0.050, 0.060, 1.0)
    bg.inputs[1].default_value = 1.4
    scene.world = world

    # Area lights obey the inverse square law, so energy has to scale with the
    # subject: the same lamp that exposes a 0.5 m rifle blows out a 1.8 m body.
    scale = max(radius, 0.05)
    for name, offset, power, size in (
        ("key", (1.5, -1.6, 1.7), 90.0, 1.5),
        ("fill", (-1.8, -1.2, 0.4), 26.0, 2.4),
        ("rim", (-0.9, 1.8, 1.3), 64.0, 1.4),
    ):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = power * scale * scale * key
        data.size = size * scale
        lamp = bpy.data.objects.new(name, data)
        scene.collection.objects.link(lamp)
        lamp.location = center + mathutils.Vector(offset) * scale
        lamp.rotation_euler = (center - lamp.location).to_track_quat("-Z", "Y").to_euler()


def _bounds(obj: bpy.types.Object) -> tuple[mathutils.Vector, mathutils.Vector]:
    verts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = mathutils.Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    hi = mathutils.Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    return lo, hi


def _render(path: str, width: int, height: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = path
    try:
        scene.eevee.taa_render_samples = 64
    except AttributeError:
        pass
    # A display transform with a shoulder, so highlights roll off instead of
    # clipping. Without one these read as white silhouettes and the surface
    # detail the models are built around is invisible. The client uses ACES
    # filmic for the same reason.
    available = {
        item.identifier
        for item in bpy.types.ColorManagedViewSettings.bl_rna.properties["view_transform"].enum_items
    }
    for candidate in ("AgX", "Filmic", "Standard"):
        if candidate in available:
            scene.view_settings.view_transform = candidate
            break
    bpy.ops.render.render(write_still=True)
    N.log(f"preview -> {path}")


def preview_weapon(build, name: str, out_dir: str) -> None:
    N.reset_scene()
    obj = N.join("preview", build())
    N.weld(obj)
    N.smooth_by_angle(obj, 36.0)
    N.reorient("yup")
    _clear_lights_and_camera()

    lo, hi = _bounds(obj)
    center, size = (lo + hi) / 2.0, hi - lo
    _studio(center, max(size) / 2.0)

    width, height = 1600, 700
    data = bpy.data.cameras.new("cam")
    data.type = "ORTHO"
    # After reorient the muzzle points +Y and up is +Z, so a side elevation
    # looks along X.
    #
    # `ortho_scale` covers the LONGER image axis, so on a 1600x700 frame it is
    # the width and the visible height is only 700/1600 of it. Fitting the
    # model's height needs that ratio applied explicitly, or a compact weapon -
    # a pistol is nearly as tall as it is long - gets its top and bottom cropped.
    data.ortho_scale = max(size.y, size.z * width / height) * 1.16
    cam = bpy.data.objects.new("cam", data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    cam.location = center + mathutils.Vector((max(size) * 2.0 + 0.5, 0.0, 0.0))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()

    _render(os.path.join(out_dir, f"{name}.png"), width, height)


def preview_character(build, name: str, out_dir: str) -> None:
    N.reset_scene()
    obj = N.join("preview", build())
    N.weld(obj)
    N.smooth_by_angle(obj, 48.0)
    _clear_lights_and_camera()

    lo, hi = _bounds(obj)
    center = mathutils.Vector((0.0, 0.0, (lo.z + hi.z) / 2.0))
    height = hi.z - lo.z
    _studio(center, height / 2.0, key=0.9)

    data = bpy.data.cameras.new("cam")
    data.lens = 58
    cam = bpy.data.objects.new("cam", data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    # Three-quarter front, from roughly another player's eye height. Characters
    # are authored facing -Y, so the camera sits on the -Y side.
    cam.location = center + mathutils.Vector((1.15, -2.55, 0.22))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()

    _render(os.path.join(out_dir, f"{name}.png"), 760, 1120)


def main() -> None:
    out_dir = N.only_arg("out") or os.path.join(N.REPO_ROOT, "screenshots", "assets")
    os.makedirs(out_dir, exist_ok=True)
    which = N.only_arg("set") or "all"
    only = N.only_arg("only")

    if which in ("all", "weapons"):
        import gen_weapons

        for wid, (build, _muzzle, _eject) in gen_weapons.WEAPONS.items():
            if only and only != wid:
                continue
            preview_weapon(build, f"wpn_{wid}", out_dir)

    if which in ("all", "characters"):
        import gen_characters

        for cid, build in gen_characters.CLASSES.items():
            if only and only != cid:
                continue
            preview_character(build, f"char_{cid}", out_dir)

    if which in ("all", "props"):
        import gen_props

        for pid, build in getattr(gen_props, "PROPS", {}).items():
            if only and only != pid:
                continue
            preview_weapon(build, f"prop_{pid}", out_dir)


if __name__ == "__main__":
    main()
