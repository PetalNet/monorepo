"""Gate: do meshes made in an older engine load here, and can they be placed on the generated surface?

Run inside the editor with the generated level as the startup map:

    UnrealEditor-Cmd <project> -ExecutePythonScript="assets_on_surface.py" -RenderOffscreen -unattended

It reads ENVGEN_GATE_ASSETS (object paths separated by ';') and writes ENVGEN_GATE_OUT (a JSON file).
For each asset it records the class, bounds, Nanite state and any dependency that is missing. It
traces the ground at a spot away from the tile centre, spawns the asset high above it, moves it down
so the bottom of its bounds meets the ground, and then re-reads the bounds from the engine to report
the remaining gap. It also reports whether a trace from above now lands on the asset, which shows
whether the asset has collision. Nothing is saved.

The editor's exit code says nothing here: treat a missing output file as a failed gate.
"""

import json
import os

import unreal

SPACING_CM = 2500.0
START_CM = (12000.0, -9000.0)


def ground_z(world, x, y):
    hit = unreal.SystemLibrary.line_trace_single(
        world,
        unreal.Vector(x, y, 200000.0),
        unreal.Vector(x, y, -200000.0),
        unreal.TraceTypeQuery.TRACE_TYPE_QUERY1,
        False,
        [],
        unreal.DrawDebugTrace.NONE,
        True,
    )
    if hit is None:
        return None
    fields = hit.to_tuple()
    blocking, location = fields[0], fields[4]
    return location.z if blocking else None


def missing_dependencies(registry, package_name):
    options = unreal.AssetRegistryDependencyOptions(
        include_hard_package_references=True, include_soft_package_references=False
    )
    dependencies = registry.get_dependencies(package_name, options) or []
    return sorted(
        str(name)
        for name in dependencies
        if str(name).startswith("/Game/") and not unreal.EditorAssetLibrary.does_asset_exist(str(name))
    )


def check(world, registry, index, path):
    result = {"asset": path}
    asset = unreal.EditorAssetLibrary.load_asset(path)
    if asset is None:
        return result | {"loaded": False}
    result |= {"loaded": True, "class": asset.get_class().get_name()}
    result["missing_dependencies"] = missing_dependencies(registry, unreal.Name(path.split(".")[0]))

    x, y = START_CM[0] + index * SPACING_CM, START_CM[1]
    ground = ground_z(world, x, y)
    if ground is None:
        return result | {"ground_found": False}
    result |= {"ground_found": True, "ground_z_cm": round(ground, 1)}

    location = unreal.Vector(x, y, ground + 50000.0)
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    actor = actors.spawn_actor_from_object(asset, location)
    if actor is None:
        return result | {"spawned": False}
    result["spawned"] = True
    if isinstance(asset, unreal.StaticMesh):
        result["nanite"] = asset.get_editor_property("nanite_settings").enabled
        result["lods"] = asset.get_num_lods()

    origin, extent = actor.get_actor_bounds(False)
    result["size_m"] = [round(2 * value / 100, 2) for value in (extent.x, extent.y, extent.z)]
    actor.set_actor_location(unreal.Vector(x, y, location.z + ground - (origin.z - extent.z)), False, False)
    origin, extent = actor.get_actor_bounds(False)
    result["gap_after_snap_cm"] = round(origin.z - extent.z - ground, 2)
    top = ground_z(world, origin.x, origin.y)
    result["blocks_a_trace_from_above"] = top is not None and top > ground + 50.0
    return result


def main():
    paths = [path for path in os.environ.get("ENVGEN_GATE_ASSETS", "").split(";") if path]
    if not paths:
        raise SystemExit("ENVGEN_GATE_ASSETS is empty: nothing to check")
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    report = {"engine": unreal.SystemLibrary.get_engine_version(), "level": world.get_path_name(), "assets": []}
    for index, path in enumerate(paths):
        try:
            report["assets"].append(check(world, registry, index, path))
        except Exception as error:  # noqa: BLE001 - one bad asset must not hide the others
            report["assets"].append({"asset": path, "error": repr(error)})
    with open(os.environ["ENVGEN_GATE_OUT"], "w") as out:
        json.dump(report, out, indent=1)


try:
    main()
finally:
    unreal.SystemLibrary.quit_editor()
