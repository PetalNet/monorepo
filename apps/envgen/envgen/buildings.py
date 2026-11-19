"""Buildings as massing: a footprint from a map, a height from lidar or the map's tags, a roof colour from the photo.

Footprints are the building polygons of OpenStreetMap and Microsoft's machine-learned footprints, as one GeoJSON
(`sources.buildings`). Each building's height is, in order of trust: the median lidar height above ground over its
footprint; the footprint's own `height_m` tag; its `num_floors` tag times a floor height; the median of the heights
the lidar measured on this tile's other buildings. Its roof colour is the median photo colour over its footprint, as
albedo by the paved class's fitted curve. Nothing else is drawn: roofs are flat and walls are one colour, because no
source says otherwise.

The same footprints take roofs out of the ground: the cover stage counts their cells as hidden, so no class, colour
or detail of the ground is read from a roof.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from rasterio import features
from rasterio.transform import from_origin
from scipy import ndimage
from shapely.geometry import Polygon, shape

from . import surface
from .site import Tile

# Priors, with no source: a storey is this tall (a rule of thumb for the `num_floors` tag), and a footprint is
# simplified to this tolerance so a mesh does not carry the digitiser's noise.
FLOOR_M = 3.0
SIMPLIFY_M = 0.3
# A footprint smaller than this is not a building a pixel can show (a footprint the map holds as a point of noise).
MIN_AREA_M2 = 4.0
# The lidar says a roof is there when its median height over the footprint is at least this; below it the survey is
# older than the building or sees nothing, and the tags speak. A prior.
LIDAR_MIN_M = 1.5
# The lidar's cells inside a footprint are read this far from its edge, where a wall or an eave would mix in.
EDGE_M = 1.0
LIDAR_MIN_CELLS = 3
# A canopy crown whose top lies in a footprint is the roof itself unless it stands this far above it. A prior: the
# real tile's crowns in footprints split into a mass within 3.2 m of the roof and a few from 4.1 m up.
ROOF_CLEARANCE_M = 3.5
# Walls have no colour source: one albedo for all of them. A prior.
WALL_ALBEDO = 0.25
ROOF_ROUGHNESS = 0.85
SETTINGS = {
    "floor_m": FLOOR_M,
    "simplify_m": SIMPLIFY_M,
    "min_area_m2": MIN_AREA_M2,
    "lidar_min_m": LIDAR_MIN_M,
    "edge_m": EDGE_M,
    "lidar_min_cells": LIDAR_MIN_CELLS,
    "roof_clearance_m": ROOF_CLEARANCE_M,
    "wall_albedo": WALL_ALBEDO,
    "roof_roughness": ROOF_ROUGHNESS,
}


def load_footprints(path: Path, crs: str, tile: Tile) -> list[dict]:
    """The footprints inside the tile, in the site's CRS, cut at its edge: each `{"polygon", "tags"}`, one per polygon part."""
    collection = json.loads(path.read_text())
    to_site = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    west, south, east, north = tile.bounds()
    window = shapely.box(west, south, east, north)
    found = []
    for feature in collection["features"]:
        geometry = shapely.transform(
            shape(feature["geometry"]), lambda xy: np.column_stack(to_site(xy[:, 0], xy[:, 1]))
        )
        for whole in getattr(geometry, "geoms", [geometry]):
            # A building over the tile's edge stands on ground the tile does not have, so it is cut there.
            inside = shapely.make_valid(whole).intersection(window)
            for part in getattr(inside, "geoms", [inside]):
                part = part.simplify(SIMPLIFY_M)
                if part.geom_type == "Polygon" and part.area >= MIN_AREA_M2:
                    found.append({"polygon": part, "tags": feature.get("properties", {})})
    found.sort(key=lambda item: (item["polygon"].centroid.y, item["polygon"].centroid.x, item["tags"].get("id", "")))
    return found


def mask(footprints: Sequence[dict], tile: Tile, cell_m: float) -> np.ndarray:
    """North-up boolean raster of the cells any footprint touches."""
    cells = round(tile.size_m / cell_m)
    if not footprints:
        return np.zeros((cells, cells), dtype=bool)
    shapes = [(item["polygon"], 1) for item in footprints]
    covered = features.rasterize(
        shapes, out_shape=(cells, cells), transform=from_origin(tile.west, tile.north, cell_m, cell_m), all_touched=True
    )
    return covered.astype(bool)


def _inside(polygon: Polygon, tile: Tile, cell_m: float) -> np.ndarray:
    """The cells whose centres lie inside the footprint pulled in by EDGE_M, or inside the whole footprint if it is thin."""
    cells = round(tile.size_m / cell_m)
    transform = from_origin(tile.west, tile.north, cell_m, cell_m)
    for shrunk in (polygon.buffer(-EDGE_M), polygon):
        if shrunk.is_empty:
            continue
        shape_ = features.rasterize([(shrunk, 1)], out_shape=(cells, cells), transform=transform).astype(bool)
        if shape_.sum() >= LIDAR_MIN_CELLS:
            return shape_
    return features.rasterize([(polygon, 1)], out_shape=(cells, cells), transform=transform, all_touched=True).astype(
        bool
    )


def lidar_roof_heights(
    footprints: Sequence[dict], tile: Tile, cell_m: float, lidar_height: np.ndarray | None
) -> list[float | None]:
    """The lidar's median height above ground over each footprint, or None where it shows no roof."""
    heights: list[float | None] = []
    for item in footprints:
        found = None
        if lidar_height is not None:
            over = lidar_height[_inside(item["polygon"], tile, cell_m)]
            if over.size >= LIDAR_MIN_CELLS and float(np.median(over)) >= LIDAR_MIN_M:
                found = float(np.median(over))
        heights.append(found)
    return heights


def crowns_on_roofs(
    crowns: Sequence[dict], footprints: Sequence[dict], tile: Tile, cell_m: float, lidar_height: np.ndarray | None
) -> list[bool]:
    """Which crowns are a roof the canopy map counted: the top lies in a footprint, no higher than the roof stands.

    A tree over a roof's edge stands well above it and stays. `crowns` have `row`, `column` and `height_m`.
    """
    roofs = lidar_roof_heights(footprints, tile, cell_m, lidar_height)
    cells = round(tile.size_m / cell_m)
    owner = np.full((cells, cells), -1, dtype=np.int32)
    for number, item in enumerate(footprints):
        owner[_inside(item["polygon"], tile, cell_m)] = number
    flags = []
    for crown in crowns:
        number = int(owner[crown["row"], crown["column"]])
        flags.append(number >= 0 and roofs[number] is not None and crown["height_m"] < roofs[number] + ROOF_CLEARANCE_M)
    return flags


def triangulate(polygon: Polygon) -> tuple[list[list[tuple[float, float]]], list[list[int]]]:
    """Rings (outer first, then holes, no repeated closing point) and triangles over their points in order."""
    polygon = shapely.geometry.polygon.orient(polygon, 1.0)
    rings = [list(polygon.exterior.coords)[:-1]] + [list(hole.coords)[:-1] for hole in polygon.interiors]
    index = {point: number for number, point in enumerate(point for ring in rings for point in ring)}
    triangles = []
    for triangle in shapely.constrained_delaunay_triangles(polygon).geoms:
        points = list(triangle.exterior.coords)[:-1]
        if all(point in index for point in points):
            triangles.append([index[point] for point in points])
    return rings, triangles


def roof_albedo(encoded: np.ndarray, curve: dict | None, scale: float) -> list[float]:
    """Linear albedo of a photo colour (3 values, sRGB 0 to 255): by the class's fitted curve, else by the global scale."""
    if curve:
        return [float(value) for value in surface.apply_curve(encoded.reshape(3, 1), curve)[:, 0]]
    return [float(value) for value in surface.to_linear(encoded) * scale]


def measure(
    footprints: Sequence[dict],
    tile: Tile,
    cell_m: float,
    lidar_height: np.ndarray | None,
    photo: np.ndarray,
    curve: dict | None,
    albedo_scale: float,
) -> list[dict]:
    """One record per building: metres east and north of the tile centre, size, colour, and where each came from.

    `lidar_height` is height above ground on the cell grid (None without a lidar source), `photo` the sRGB photo on
    the same grid, (3, rows, columns).
    """
    records = []
    seen = lidar_roof_heights(footprints, tile, cell_m, lidar_height)
    for number, item in enumerate(footprints):
        polygon, tags = item["polygon"], item["tags"]
        cells = _inside(polygon, tile, cell_m)
        lidar_m = seen[number]
        if lidar_m is not None:
            height, from_ = lidar_m, "lidar: median height above ground over the footprint"
        elif tags.get("height_m"):
            height, from_ = float(tags["height_m"]), f"tag: height of {tags.get('dataset') or 'the footprint source'}"
        elif tags.get("num_floors"):
            height, from_ = tags["num_floors"] * FLOOR_M, f"prior: {FLOOR_M:g} m a floor times the num_floors tag"
        else:
            height, from_ = None, None
        colour = np.median(photo[:, cells], axis=1)
        anchor = polygon.representative_point()
        rings, triangles = triangulate(polygon)
        centre_east, centre_north = tile.centre
        records.append(
            {
                "id": tags.get("id") or f"footprint-{number}",
                "dataset": tags.get("dataset"),
                "east_m": float(anchor.x - centre_east),
                "north_m": float(anchor.y - centre_north),
                "height_m": height,
                "height_from": from_,
                "roof_albedo": roof_albedo(colour, curve, albedo_scale),
                "area_m2": float(polygon.area),
                "rings": [[[x - centre_east, y - centre_north] for x, y in ring] for ring in rings],
                "roof_triangles": triangles,
            }
        )
    measured = [
        record["height_m"] for record in records if record["height_from"] and record["height_from"].startswith("lidar")
    ]
    typical = float(np.median(measured)) if measured else None
    for record in records:
        if record["height_m"] is None:
            if typical is None:
                record["height_m"], record["height_from"] = 2 * FLOOR_M, f"prior: two floors of {FLOOR_M:g} m"
            else:
                record["height_m"], record["height_from"] = (
                    typical,
                    "measured: median lidar height of this tile's buildings",
                )
    return records


def sources_of(records: Sequence[dict]) -> dict[str, int]:
    """How many buildings took their height from each kind of source (lidar, tag, prior, measured)."""
    counts: dict[str, int] = {}
    for record in records:
        kind = record["height_from"].split(":")[0]
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def label_under(labels: np.ndarray, covered: np.ndarray) -> np.ndarray:
    """Give the cells under buildings the class of the nearest cell that is not under one, so the roof never paints ground."""
    if not covered.any() or covered.all():
        return labels
    nearest = ndimage.distance_transform_edt(covered, return_distances=False, return_indices=True)
    return labels[tuple(nearest)]
