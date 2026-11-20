"""Measured tile-centred inventory as meshes with ground-relative heights.

The consumer samples terrain at each vertex unless a mesh supplies anchor_m. An
anchor changes the terrain sample, never the east/north coordinates of vertices.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from itertools import pairwise
from pathlib import Path

import numpy as np
import shapely
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely.geometry import LineString, Polygon, box

from .site import SiteError, Tile

SURFACES = {"asphalt": 0.04, "concrete": 0.04, "track": 0.05, "gravel": 0.04, "clay": 0.04, "turf": 0.025}
LINES = {"paint_white": 0.07, "paint_yellow": 0.07, "concrete": 0.06}
DEFAULTS = {
    "line": {"width_m": 0.1},
    "curb": {"width_m": 0.15, "height_m": 0.15},
    "fence": {"height_m": 2.4},
    "light_pole": {"heading_deg": 0, "arms": 2, "floodlight": False},
    "bench": {"length_m": 1.8},
    "bleacher": {"rows": 5, "step_m": 0.8, "rise_m": 0.35},
    "goalpost": {"height_m": 5.6, "width_m": 5.64},
    "soccer_goal": {"width_m": 7.32, "height_m": 2.44, "depth_m": 2.0},
}
GEOMETRY = {
    "surface": {"ring", "material"},
    "line": {"points", "material", "width_m"},
    "curb": {"points", "width_m", "height_m"},
    "fence": {"points", "height_m", "ground_anchor"},
    "light_pole": {"point", "height_m", "heading_deg", "arms", "floodlight"},
    "bench": {"point", "heading_deg", "length_m"},
    "bleacher": {"points", "rows", "step_m", "rise_m"},
    "goalpost": {"point", "heading_deg", "height_m", "width_m"},
    "soccer_goal": {"point", "heading_deg", "width_m", "height_m", "depth_m"},
}
BIN_M = 126.0
MAX_EDGE_M = 2.0
MAX_MESH_TRIANGLES = 20000
GRASS_MASK_PIXELS = 2048
FOOTING_SINK_M = 0.3
BLEACHER_SINK_M = 0.6
SETTINGS = {
    "surfaces": SURFACES,
    "lines": LINES,
    "defaults": DEFAULTS,
    "bin_m": BIN_M,
    "max_edge_m": MAX_EDGE_M,
    "terrain_topology": "landscape_00_11_triangles",
    "rod_sides": {"large": 24, "small": 8},
    "max_mesh_triangles": MAX_MESH_TRIANGLES,
    "grass_mask_pixels": GRASS_MASK_PIXELS,
    "footing_sink_m": FOOTING_SINK_M,
    "bleacher_sink_m": BLEACHER_SINK_M,
}


def _number(value, label: str, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SiteError(f"{label}: expected a finite number")
    if positive and value <= 0:
        raise SiteError(f"{label}: must be positive")
    return float(value)


def _point(value, label: str, tile: Tile) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise SiteError(f"{label}: expected [east, north]")
    point = tuple(_number(v, label) for v in value)
    if any(abs(v) > tile.size_m / 2 for v in point):
        raise SiteError(f"{label}: coordinates outside tile")
    return point


def _feature(raw, tile: Tile) -> tuple[dict, list[str]]:
    if not isinstance(raw, dict):
        raise SiteError("feature <unknown>: expected an object")
    ident = raw.get("id", "<unknown>")
    label = f"feature {ident}"
    if not isinstance(ident, str) or not ident.strip() or "id" not in raw:
        raise SiteError(f"{label}: id must be a nonempty string")
    kind = raw.get("type")
    if not isinstance(kind, str) or kind not in GEOMETRY:
        raise SiteError(f"{label}: unsupported type {kind!r}")
    unknown = set(raw) - GEOMETRY[kind] - {"id", "type", "evidence", "confidence"}
    if unknown:
        raise SiteError(f"{label}: unknown fields {sorted(unknown)}")
    if not isinstance(raw.get("evidence"), str) or not raw["evidence"].strip():
        raise SiteError(f"{label}: evidence must identify an image/crop")
    confidence = _number(raw.get("confidence"), f"{label}.confidence")
    if not 0 <= confidence <= 1:
        raise SiteError(f"{label}: confidence must be in [0,1]")
    f = {**DEFAULTS.get(kind, {}), **raw}
    priors = [
        f"{ident}: {key}={value} (dimensional/shape prior)"
        for key, value in DEFAULTS.get(kind, {}).items()
        if key not in raw
    ]
    if "point" in GEOMETRY[kind]:
        f["point"] = _point(f.get("point"), label, tile)
    else:
        key = "ring" if kind == "surface" else "points"
        values = f.get(key)
        if not isinstance(values, list):
            raise SiteError(f"{label}: {key} must be an array")
        points = [_point(v, label, tile) for v in values]
        if key == "ring" and len(points) > 1 and points[-1] == points[0]:
            points.pop()
        if len(points) < (3 if key == "ring" else 2):
            raise SiteError(f"{label}: too few {key}")
        if any(a == b for a, b in pairwise(points)):
            raise SiteError(f"{label}: degenerate segment")
        if kind == "bleacher" and len(points) != 2:
            raise SiteError(f"{label}: bleacher needs exactly two endpoints")
        if key == "ring":
            polygon = Polygon(points)
            if not polygon.is_valid or polygon.area <= 0:
                raise SiteError(f"{label}: ring must be simple with nonzero area")
        f[key] = points
    for key in GEOMETRY[kind]:
        if key.endswith("_m"):
            f[key] = _number(f.get(key), f"{label}.{key}", positive=True)
    if kind == "bleacher" and f["rise_m"] <= 0.03:
        raise SiteError(f"{label}: rise_m must exceed the 0.03 m seat underside")
    if kind == "fence" and f["height_m"] <= 0.08:
        raise SiteError(f"{label}: height_m must exceed the 0.08 m fabric clearance")
    if kind in ("surface", "line"):
        allowed = SURFACES if kind == "surface" else LINES
        if not isinstance(f.get("material"), str) or f["material"] not in allowed:
            raise SiteError(f"{label}: unsupported material {f.get('material')!r}")
        if kind == "line" and f["material"] == "concrete" and "width_m" not in raw:
            raise SiteError(f"{label}: concrete sidewalk requires width_m")
    if "heading_deg" in GEOMETRY[kind]:
        f["heading_deg"] = _number(f.get("heading_deg"), f"{label}.heading_deg")
    for key in ("rows", "arms"):
        if key in f and (type(f[key]) is not int or f[key] <= 0 or (key == "arms" and f[key] not in (2, 4))):
            raise SiteError(f"{label}: {key} must be a positive integer" + (" (2 or 4)" if key == "arms" else ""))
    if "floodlight" in f and type(f["floodlight"]) is not bool:
        raise SiteError(f"{label}: floodlight must be boolean")
    # Optional per-segment anchors are explicit measured EN locations, one for each input segment.
    if "ground_anchor" in f:
        anchors = f["ground_anchor"]
        if not isinstance(anchors, list) or len(anchors) != len(f["points"]) - 1:
            raise SiteError(f"{label}: ground_anchor needs one [east,north] per segment")
        f["ground_anchor"] = [_point(a, label, tile) for a in anchors]
    return f, priors


class _Mesh:
    def __init__(self, material: str, anchor=None, collision: bool = True):
        self.data = {"material": material, "vertices": [], "triangles": [], "collision": collision}
        if anchor is not None:
            self.data["anchor_m"] = list(anchor)

    def add(self, vertices, triangles):
        offset = len(self.data["vertices"])
        self.data["vertices"].extend([list(v) for v in vertices])
        self.data["triangles"].extend([[offset + i for i in t] for t in triangles])

    def box(self, centre, size, transform):
        x, y, z = centre
        a, b, c = (s / 2 for s in size)
        vertices = [
            transform(x + dx, y + dy, z + dz)
            for dx, dy, dz in (
                (-a, -b, -c),
                (a, -b, -c),
                (a, b, -c),
                (-a, b, -c),
                (-a, -b, c),
                (a, -b, c),
                (a, b, c),
                (-a, b, c),
            )
        ]
        self.add(
            vertices,
            (
                (0, 2, 1),
                (0, 3, 2),
                (4, 5, 6),
                (4, 6, 7),
                (0, 1, 5),
                (0, 5, 4),
                (1, 2, 6),
                (1, 6, 5),
                (2, 3, 7),
                (2, 7, 6),
                (3, 0, 4),
                (3, 4, 7),
            ),
        )

    def rod(self, start, end, radius, top_radius=None):
        delta = tuple(b - a for a, b in zip(start, end))
        length = math.sqrt(sum(v * v for v in delta))
        axis = tuple(v / length for v in delta)
        ref = (0, 0, 1) if abs(axis[2]) < 0.9 else (0, 1, 0)
        u = (
            axis[1] * ref[2] - axis[2] * ref[1],
            axis[2] * ref[0] - axis[0] * ref[2],
            axis[0] * ref[1] - axis[1] * ref[0],
        )
        norm = math.sqrt(sum(v * v for v in u))
        u = tuple(v / norm for v in u)
        v = (axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0])
        sides = SETTINGS["rod_sides"]["large" if radius >= 0.04 else "small"]
        vertices = []
        for centre, r in ((start, radius), (end, radius if top_radius is None else top_radius)):
            for i in range(sides):
                angle = i * math.tau / sides
                vertices.append([centre[j] + r * (u[j] * math.cos(angle) + v[j] * math.sin(angle)) for j in range(3)])
        triangles = []
        for i in range(sides):
            k = (i + 1) % sides
            triangles.extend(((i, k, k + sides), (i, k + sides, i + sides)))
        triangles.extend((0, i + 1, i) for i in range(1, sides - 1))
        triangles.extend((sides, i + sides, i + sides + 1) for i in range(1, sides - 1))
        self.add(vertices, triangles)


def _transform(point, heading):
    angle = math.radians(heading)
    c, s = math.cos(angle), math.sin(angle)
    return lambda x, y, z: (point[0] + c * x - s * y, point[1] + s * x + c * y, z)


def _polygons(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for child in geometry.geoms:
            yield from _polygons(child)


def _planar(polygon, material, z, meshes, tile):
    # Clip before triangulation: bounded meshes and edges, including concave polygons and holes from buffers.
    west, south, east, north = polygon.bounds
    half = tile.size_m / 2
    polygon = polygon.intersection(box(-half, -half, half, half))
    for east_bin in range(math.floor(west / BIN_M), math.floor(east / BIN_M) + 1):
        for north_bin in range(math.floor(south / BIN_M), math.floor(north / BIN_M) + 1):
            clipped = polygon.intersection(
                box(east_bin * BIN_M, north_bin * BIN_M, (east_bin + 1) * BIN_M, (north_bin + 1) * BIN_M)
            )
            mesh = _Mesh(material, collision=False)
            # Integer subdivisions preserve Landscape's 00--11 diagonal and tile-centred grid origin.
            cell = tile.quad_m / math.ceil(tile.quad_m * math.sqrt(2) / MAX_EDGE_M)
            if clipped.is_empty:
                continue
            x0, y0, x1, y1 = clipped.bounds
            for gx in range(math.floor((x0 + half) / cell), math.ceil((x1 + half) / cell)):
                for gy in range(math.floor((y0 + half) / cell), math.ceil((y1 + half) / cell)):
                    patch_west, patch_south = gx * cell - half, gy * cell - half
                    corners = [
                        (patch_west, patch_south),
                        (patch_west + cell, patch_south),
                        (patch_west + cell, patch_south + cell),
                        (patch_west, patch_south + cell),
                    ]
                    for indices in [(0, 1, 2), (0, 2, 3)]:
                        patch = clipped.intersection(Polygon([corners[i] for i in indices]))
                        for part in _polygons(patch):
                            for triangle in shapely.constrained_delaunay_triangles(part).geoms:
                                points = list(triangle.exterior.coords)[:3]
                                a, b, c = points
                                if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0:
                                    points.reverse()
                                mesh.add([(x, y, z) for x, y in points], [(0, 1, 2)])
            if mesh.data["triangles"]:
                meshes.append(mesh.data)


def _curb(f, meshes):
    width, height = f["width_m"], f["height_m"]
    for start, end in zip(f["points"], f["points"][1:]):
        length = math.dist(start, end)
        transform = _transform(start, math.degrees(math.atan2(end[1] - start[1], end[0] - start[0])))
        sections = math.ceil(length / MAX_EDGE_M)
        for first in range(0, sections, 60):
            mesh = _Mesh("concrete")
            for i in range(first, min(sections, first + 60)):
                mesh.box(
                    ((i + 0.5) * length / sections, 0, (height - 0.05) / 2),
                    (length / sections, width, height + 0.05),
                    transform,
                )
            meshes.append(mesh.data)


def _fence(f, meshes, priors):
    height = f["height_m"]
    priors.append(
        f"{f['id']}: steel posts r=.035 m at <=3 m; rails r=.025 m; masked chainlink .1 m pitch, .002 m wires"
    )
    for index, (start, end) in enumerate(zip(f["points"], f["points"][1:])):
        length = math.dist(start, end)
        panels = math.ceil(length / 3)
        transform = _transform(start, math.degrees(math.atan2(end[1] - start[1], end[0] - start[0])))
        anchor = f.get("ground_anchor", [None] * (len(f["points"]) - 1))[index]
        for first in range(0, panels, 40):
            last = min(panels, first + 40)
            mesh = _Mesh("steel", anchor)
            fabric = _Mesh("chainlink", anchor)
            for i in range(first, last + 1):
                x = i * length / panels
                mesh.rod(transform(x, 0, -0.05), transform(x, 0, height), 0.035)
            for i in range(first, last):
                lo, hi = i * length / panels, (i + 1) * length / panels
                for z in (0.15 * height, 0.95 * height):
                    mesh.rod(transform(lo, 0, z), transform(hi, 0, z), 0.025)
                fabric.add(
                    [
                        transform(lo, 0, 0.08),
                        transform(hi, 0, 0.08),
                        transform(hi, 0, height),
                        transform(lo, 0, height),
                    ],
                    [(0, 1, 2), (0, 2, 3)],
                )
            meshes.append(mesh.data)
            meshes.append(fabric.data)


def _prop(f, meshes, priors):
    kind = f["type"]
    if kind == "bleacher":
        a, b = f["points"]
        length = math.dist(a, b)
        anchor = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        heading = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    else:
        anchor, heading = f["point"], f["heading_deg"]
    t = _transform(anchor, heading)
    made = {}

    def mesh(material, collision=True):
        if material not in made:
            made[material] = _Mesh(material, anchor, collision)
        return made[material]

    def rod(material, a, b, r, top=None):
        mesh(material).rod(t(*a), t(*b), r, top)

    def block(material, centre, size, transform=None):
        mesh(material).box(centre, size, t if transform is None else transform)

    if kind == "light_pole":
        h = f["height_m"]
        rod("steel", (0, 0, -FOOTING_SINK_M), (0, 0, h), 0.11, 0.06)
        for i in range(f["arms"]):
            angle = math.tau * i / f["arms"]
            dx, dy = math.cos(angle), math.sin(angle)
            rod("steel", (0, 0, 0.92 * h), (dx * 1.2, dy * 1.2, 0.92 * h), 0.04)
            # Heads rotate with their arm and pitch 30 degrees for measured floodlight assemblies.
            pitch = math.pi / 6 if f["floodlight"] else 0

            def head(x, y, z, dx=dx, dy=dy, pitch=pitch):
                xx = x * math.cos(pitch) - z * math.sin(pitch)
                zz = x * math.sin(pitch) + z * math.cos(pitch)
                return t(dx * (1.2 + xx) - dy * y, dy * (1.2 + xx) + dx * y, 0.92 * h + zz)

            block("lamp_dark", (0, 0, 0), (0.65, 0.3, 0.2), head)
        priors.append(f"{f['id']}: mast radii .11/.06 m; 1.2 m arms at .92 height; heads .65x.3x.2 m")
    elif kind == "bench":
        length = f["length_m"]
        for y in (-0.16, 0, 0.16):
            block("wood", (0, y, 0.48), (length, 0.13, 0.045))
        for z in (0.72, 0.9):
            block("wood", (0, 0.23, z), (length, 0.045, 0.14))
        for x in (-length * 0.35, length * 0.35):
            for y in (-0.17, 0.17):
                rod("steel", (x, y, -FOOTING_SINK_M), (x, y, 0.46), 0.025)
            rod("steel", (x, 0.22, 0.44), (x, 0.22, 0.98), 0.025)
            rod("steel", (x, -0.22, 0.44), (x, 0.24, 0.44), 0.025)
        priors.append(f"{f['id']}: bench seat .48 m high, three .13 m slats; two back slats and steel legs")
    elif kind == "bleacher":
        step, rise = f["step_m"], f["rise_m"]
        supports = max(1, math.ceil(length / 3))
        for row in range(f["rows"]):
            y, z = row * step, (row + 1) * rise
            block("aluminum", (0, y, z), (length, step * 0.55, 0.06))
            for i in range(supports + 1):
                x = -length / 2 + i * length / supports
                rod("steel", (x, y, -BLEACHER_SINK_M), (x, y, z - 0.03), min(0.035, rise / 8))
                if row:
                    rod("steel", (x, y - step, -BLEACHER_SINK_M), (x, y, z - 0.03), min(0.025, rise / 10))
        priors.append(f"{f['id']}: bleacher seats .55 step deep and .06 m thick; supports <=3 m apart")
    elif kind == "goalpost":
        h, w = f["height_m"], f["width_m"]
        crossbar = h * 0.54
        rod("steel_yellow", (0, -0.7, -FOOTING_SINK_M), (0, -0.7, crossbar), 0.09)
        rod("steel_yellow", (0, -0.7, crossbar), (0, 0, crossbar), 0.09)
        rod("steel_yellow", (-w / 2, 0, crossbar), (w / 2, 0, crossbar), 0.06)
        for x in (-w / 2, w / 2):
            rod("steel_yellow", (x, 0, crossbar), (x, 0, h), 0.05)
        priors.append(f"{f['id']}: single support .7 m behind crossbar at .54 height; radii .09/.06/.05 m")
    elif kind == "soccer_goal":
        h, w, d = f["height_m"], f["width_m"], f["depth_m"]
        for x in (-w / 2, w / 2):
            rod("paint_white", (x, 0, -FOOTING_SINK_M), (x, 0, h), 0.04)
            rod("paint_white", (x, 0, h), (x, d, h), 0.03)
            rod("paint_white", (x, d, -FOOTING_SINK_M), (x, d, h), 0.03)
            rod("paint_white", (x, 0, 0.03), (x, d, 0.03), 0.03)
        rod("paint_white", (-w / 2, 0, h), (w / 2, 0, h), 0.04)
        rod("paint_white", (-w / 2, d, h), (w / 2, d, h), 0.03)
        net = mesh("net", False)

        def wire(a, b):
            net.rod(t(*a), t(*b), 0.003)

        for i in range(math.ceil(w / 0.3) + 1):
            x = -w / 2 + w * i / math.ceil(w / 0.3)
            wire((x, d, 0), (x, d, h))
            wire((x, 0, h), (x, d, h))
        for i in range(math.ceil(h / 0.3) + 1):
            z = h * i / math.ceil(h / 0.3)
            wire((-w / 2, d, z), (w / 2, d, z))
            for x in (-w / 2, w / 2):
                wire((x, 0, z), (x, d, z))
        for i in range(1, math.ceil(d / 0.3)):
            y = d * i / math.ceil(d / 0.3)
            wire((-w / 2, y, h), (w / 2, y, h))
            for x in (-w / 2, w / 2):
                wire((x, y, 0), (x, y, h))
        priors.append(f"{f['id']}: white frame r=.04/.03 m; box net r=.003 m spaced <=.3 m")
    meshes.extend(m.data for m in made.values())


def _bounded(meshes):
    """Keep upload batches bounded without changing anchors or duplicating triangles."""
    # Paint and paving share a draw per material and spatial cell, rather than one per stripe.
    grouped = {}
    combined = []
    for mesh in meshes:
        if not mesh["collision"] and "anchor_m" not in mesh:
            x = (min(v[0] for v in mesh["vertices"]) + max(v[0] for v in mesh["vertices"])) / 2
            y = (min(v[1] for v in mesh["vertices"]) + max(v[1] for v in mesh["vertices"])) / 2
            key = (mesh["material"], math.floor(x / BIN_M), math.floor(y / BIN_M))
            if key not in grouped:
                grouped[key] = _Mesh(mesh["material"], collision=False)
                combined.append(grouped[key].data)
            grouped[key].add(mesh["vertices"], mesh["triangles"])
        else:
            combined.append(mesh)
    result = []
    for mesh in combined:
        for offset in range(0, len(mesh["triangles"]), MAX_MESH_TRIANGLES):
            triangles = mesh["triangles"][offset : offset + MAX_MESH_TRIANGLES]
            indices = sorted({i for t in triangles for i in t})
            remap = {old: new for new, old in enumerate(indices)}
            result.append(
                {
                    **mesh,
                    "vertices": [mesh["vertices"][i] for i in indices],
                    "triangles": [[remap[i] for i in t] for t in triangles],
                }
            )
    return result


def build_inventory(path: Path, tile: Tile, out: Path) -> dict:
    """Validate measured inventory, write streetscape.json, and return its stage description."""
    try:
        raw = json.loads(path.read_text())
    except (ValueError, OSError) as error:
        raise SiteError(f"streetscape: cannot read inventory: {error}") from error
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int or raw["schema_version"] != 1:
        raise SiteError("streetscape: schema_version must be 1")
    if raw.get("coordinate_frame") != "tile_centred_east_north_m":
        raise SiteError("streetscape: coordinate_frame must be tile_centred_east_north_m")
    source = raw.get("source")
    if not isinstance(source, dict) or any(
        not isinstance(source.get(k), str) or not source[k].strip() for k in ("name", "license", "date")
    ):
        raise SiteError("streetscape: source needs name, license, date")
    if not isinstance(raw.get("features"), list):
        raise SiteError("streetscape: features must be an array")
    features, priors, seen = [], [], set()
    for value in raw["features"]:
        feature, defaults = _feature(value, tile)
        if feature["id"] in seen:
            raise SiteError(f"feature {feature['id']}: duplicate id")
        seen.add(feature["id"])
        features.append(feature)
        priors.extend(defaults)
    meshes = []
    exclusions = []
    if features:
        priors.append("24-sided large tubes and 8-sided small rods; no point lights or ball geometry")
        priors.append(
            f"Rigid prop footings extend {FOOTING_SINK_M} m below their anchor; bleacher supports {BLEACHER_SINK_M} m"
        )
    for f in features:
        first_mesh = len(meshes)
        kind = f["type"]
        if kind == "surface":
            if f["material"] != "turf":
                exclusions.append(Polygon(f["ring"]))
            priors.append(f"{f['id']}: {f['material']} terrain offset {SURFACES[f['material']]} m")
            _planar(Polygon(f["ring"]), f["material"], SURFACES[f["material"]], meshes, tile)
        elif kind == "line":
            if f["material"] == "concrete":
                exclusions.append(
                    LineString(f["points"]).buffer(f["width_m"] / 2, cap_style="flat", join_style="mitre")
                )
            priors.append(f"{f['id']}: {f['material']} terrain offset {LINES[f['material']]} m; flat caps, mitre joins")
            _planar(
                LineString(f["points"]).buffer(f["width_m"] / 2, cap_style="flat", join_style="mitre"),
                f["material"],
                LINES[f["material"]],
                meshes,
                tile,
            )
        elif kind == "curb":
            priors.append(f"{f['id']}: curb sunk .05 m below terrain; square sections")
            _curb(f, meshes)
        elif kind == "fence":
            _fence(f, meshes, priors)
        else:
            _prop(f, meshes, priors)
        half = tile.size_m / 2
        if any(
            abs(v[0]) > half + 1e-9 or abs(v[1]) > half + 1e-9 for mesh in meshes[first_mesh:] for v in mesh["vertices"]
        ):
            raise SiteError(f"feature {f['id']}: generated geometry outside tile")
    meshes = _bounded(meshes)
    counts = dict(sorted(Counter(f["type"] for f in features).items()))
    payload = {
        "schema_version": 1,
        "feature_count": len(features),
        "counts": counts,
        "meshes": meshes,
        "evidence": [{"id": f["id"], "evidence": f["evidence"], "confidence": f["confidence"]} for f in features],
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "streetscape.json").write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")
    # Landscape images run [east, north], both increasing; rasterize writes [north descending, east].
    pixels = GRASS_MASK_PIXELS
    half = tile.size_m / 2
    blocked = (
        rasterize(
            [(polygon, 1) for polygon in exclusions],
            out_shape=(pixels, pixels),
            transform=from_origin(-half, half, tile.size_m / pixels, tile.size_m / pixels),
            all_touched=True,
            dtype="uint8",
        )
        if exclusions
        else np.zeros((pixels, pixels), dtype=np.uint8)
    )
    Image.fromarray((255 * (1 - blocked[::-1].T)).astype(np.uint8)).save(out / "streetscape_grass.png")
    return {
        "file": "streetscape.json",
        "grass_mask": "streetscape_grass.png",
        "files": ["streetscape.json", "streetscape_grass.png"],
        "feature_count": len(features),
        "triangle_count": sum(len(m["triangles"]) for m in meshes),
        "counts": counts,
        "source": source,
        "settings": SETTINGS,
        "priors": priors,
    }
