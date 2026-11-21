"""Building footprints, fitted lidar roofs, photo observations, and explicitly labelled fallback geometry.

Footprints are the building polygons of OpenStreetMap and Microsoft's machine-learned footprints, as one GeoJSON
(`sources.buildings`). Each building's height is, in order of trust: the median lidar height above ground over its
footprint; the footprint's own `height_m` tag; its `num_floors` tag times a floor height; the median of the heights
the lidar measured on this tile's other buildings. Its roof colour is the median photo colour over its footprint, as
albedo by the paved class's fitted curve.

roof_survey.py replaces sufficiently supported roofs with measured surfaces. Architectural detail is described
separately by architecture.py and labeled as prior where no survey or reviewed observation exists.
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
from shapely.ops import split

from . import architecture, surface
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
    "wall_albedo": WALL_ALBEDO,
    "roof_roughness": ROOF_ROUGHNESS,
}


def load_footprints(path: Path, crs: str, tile: Tile | None) -> list[dict]:
    """Projected `{"polygon", "tags"}` parts, clipped and simplified for a tile, or full source outlines without one."""
    collection = json.loads(path.read_text())
    to_site = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    window = shapely.box(*tile.bounds()) if tile is not None else None
    found = []
    for feature in collection["features"]:
        geometry = shapely.transform(
            shape(feature["geometry"]), lambda xy: np.column_stack(to_site(xy[:, 0], xy[:, 1]))
        )
        for whole in getattr(geometry, "geoms", [geometry]):
            # A building over the tile's edge stands on ground the tile does not have, so it is cut there.
            inside = shapely.make_valid(whole)
            if window is not None:
                inside = inside.intersection(window)
            for part in getattr(inside, "geoms", [inside]):
                if window is not None:
                    part = part.simplify(SIMPLIFY_M)
                if part.geom_type == "Polygon" and part.area >= MIN_AREA_M2:
                    found.append({"polygon": part, "tags": feature.get("properties", {})})
    found.sort(key=lambda item: (item["polygon"].centroid.y, item["polygon"].centroid.x, str(item["tags"].get("id"))))
    return found


def tree_exclusions(path: Path, crs: str, tile: Tile, primary: Sequence[dict]) -> list[dict]:
    """Keep reviewed/refined primary outlines inside the tile and acquired source material outside it."""
    window = shapely.box(*tile.bounds())
    found = list(primary)
    for item in load_footprints(path, crs, None):
        outside = item["polygon"].difference(window)
        for part in getattr(outside, "geoms", [outside]):
            if part.geom_type == "Polygon" and not part.is_empty:
                found.append({**item, "polygon": part})
    return found


def _positive(tag) -> bool:
    """Whether a tag is a number above zero; a map's tags are strings as often as numbers."""
    try:
        return float(tag) > 0
    except (TypeError, ValueError):
        return False


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


def crowns_in_footprints(crowns: Sequence[dict], footprints: Sequence[dict], tile: Tile, cell_m: float) -> list[bool]:
    """Which crowns have their top in a footprint (edge cells too).

    A tree is placed at its crown's top, so one whose top is in a building would stand in it. In a height map a roof is
    canopy too, and these are mostly roofs; the few that are a real crown over a roof's edge are lost with them.
    `crowns` have `row` and `column`.
    """
    cells = round(tile.size_m / cell_m)
    owned = np.zeros((cells, cells), dtype=bool)
    transform = from_origin(tile.west, tile.north, cell_m, cell_m)
    for item in footprints:
        owned |= features.rasterize([(item["polygon"], 1)], out_shape=(cells, cells), transform=transform).astype(bool)
    return [bool(owned[crown["row"], crown["column"]]) for crown in crowns]


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
        elif _positive(tags.get("height_m")):
            height, from_ = float(tags["height_m"]), f"tag: height of {tags.get('dataset') or 'the footprint source'}"
        elif _positive(tags.get("num_floors")):
            height, from_ = (
                float(tags["num_floors"]) * FLOOR_M,
                f"prior: {FLOOR_M:g} m a floor times the num_floors tag",
            )
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
                "roof_forms": architecture.measure_roof_forms(polygon, cells, photo, tile, cell_m),
                "area_m2": float(polygon.area),
                "outline_observation": item.get("outline_observation", {"status": "source footprint"}),
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
    for record, item in zip(records, footprints, strict=True):
        opposing = None
        if architecture.building_kind(item["tags"]) == "grandstand":
            stands = [
                other
                for other, footprint in zip(records, footprints, strict=True)
                if other is not record
                and architecture.building_kind(footprint["tags"]) == "grandstand"
                and np.hypot(other["east_m"] - record["east_m"], other["north_m"] - record["north_m"]) < 250
            ]
            if stands:
                nearest = min(
                    stands,
                    key=lambda other: np.hypot(
                        other["east_m"] - record["east_m"], other["north_m"] - record["north_m"]
                    ),
                )
                opposing = (nearest["east_m"], nearest["north_m"])
        record["architecture"] = architecture.describe(record, item["tags"], opposing)
    return records


def sources_of(records: Sequence[dict]) -> dict[str, int]:
    """How many buildings took their height from each kind of source (lidar, tag, prior, measured)."""
    counts: dict[str, int] = {}
    for record in records:
        kind = record["height_from"].split(":")[0]
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def _stand_style(record: dict) -> dict:
    old = record["architecture"]
    along = np.asarray(old["along"])
    across = np.array([-along[1], along[0]])
    if np.dot(record.get("stand_gradient", across), across) < 0:
        along = -along
    opposite = np.asarray(old["centre_m"]) - np.array([-along[1], along[0]]) * 100
    result = architecture.describe(record, {"building": "grandstand"}, tuple(opposite))
    if "stand_gradient" in record:
        result["orientation_from"] = "lidar: sign of the fitted seating gradient"
        result["roof_shape_from"] = "lidar: seating slope; individual treads remain reconstructed"
    return result


def apply_surveys(records: list[dict], surveys: list[dict], tile: Tile) -> None:
    centre = np.array(tile.centre)
    for record, survey in zip(records, surveys, strict=True):
        record["roof_survey"] = {
            key: value
            for key, value in survey.items()
            if key not in {"roof_vertices", "roof_triangles", "wall_segments"}
        }
        style = record["architecture"]
        record["facade_reference"] = {"status": "prior", "reason": "no resolved street-photo observations"}
        if survey["status"] != "measured":
            continue
        if style["role"] == "grandstand":
            if len(survey["planes"]) == 1:
                plane = survey["planes"][0]
                along = np.asarray(style["along"])
                across = np.array([-along[1], along[0]])
                gradient = np.array([plane["a"], plane["b"]])
                if abs(np.dot(gradient, along)) > 0.05 or abs(np.dot(gradient, across)) < 0.03:
                    record["stand_survey"] = {
                        "status": "unresolved",
                        "reason": "seating slope conflicts with footprint axes",
                    }
                    continue
                record["height_m"] = survey["height_m"]
                record["height_from"] = "lidar: seating plane relative to nearby ground"
                record["stand_rise_m"] = abs(np.dot([plane["a"], plane["b"]], across)) * style["width_m"]
                record["stand_gradient"] = gradient.tolist()
                record["stand_survey"] = {
                    "status": "measured",
                    "rise_m": record["stand_rise_m"],
                    "from": "lidar: fitted seating slope",
                }
                record["architecture"] = _stand_style(record)
            continue
        record["prior_height_m"] = record["height_m"]
        record["height_m"] = survey["height_m"]
        record["height_from"] = "lidar: fitted roof relative to nearby ground in the same point cloud"
        style["roof_shape"] = survey["roof_shape"]
        style["roof_shape_from"] = "lidar: supported roof-plane slopes and levels; semantic roof type inferred"
        style["rise_m"] = 0.0
        style["parapet_m"] = survey.get("parapet_m", 0.0)
        style["measured_roof"] = True
        style["roof_vertices"] = [[*(np.asarray(v[:2]) - centre), v[2]] for v in survey["roof_vertices"]]
        style["roof_triangles"] = survey["roof_triangles"]
        style["wall_segments"] = [
            [[*(np.asarray(v[:2]) - centre), v[2]] for v in segment] for segment in survey["wall_segments"]
        ]
        record["roof_forms"] = []


def apply_reference(records: list[dict], path: Path) -> None:
    """Apply reviewed observations by stable building ID; source images remain reference-only."""
    data = json.loads(path.read_text())
    observations = data.get("buildings", {})
    if not isinstance(observations, dict):
        raise TypeError("building_reference.buildings must map building IDs to observations")
    for record in records:
        observation = observations.get(str(record["id"]))
        if observation is None:
            continue
        if not isinstance(observation, dict) or not observation.get("source"):
            raise ValueError(f"building_reference {record['id']}: source is required")
        record["reference"] = observation
        if "stand_rows" in observation:
            rows = observation["stand_rows"]
            if not isinstance(rows, int) or not 3 <= rows <= 80 or record["architecture"]["role"] != "grandstand":
                raise ValueError("building_reference stand_rows requires a grandstand and 3 to 80 rows")
            record["architecture"] = _stand_style(record)
            record["architecture"]["stand_reference"] = True
            record["architecture"]["press_box_prior"] = False
            aisles = np.asarray(observation.get("stand_aisles", [0]), dtype=float)
            if aisles.ndim != 1 or not np.isfinite(aisles).all() or np.any(abs(aisles) >= 0.48):
                raise ValueError("building_reference stand_aisles must be finite length fractions within +/- 0.48")
            record["architecture"]["stand_aisles"] = sorted(aisles.tolist())
        if "facade" in observation:
            facade = observation["facade"]
            if facade.get("material") not in {"brick", "siding", "concrete"}:
                raise ValueError("building_reference facade.material must be brick, siding or concrete")
            colour = np.asarray(facade.get("albedo"), dtype=float)
            if colour.shape != (3,) or not np.isfinite(colour).all() or np.any((colour < 0) | (colour > 1)):
                raise ValueError("building_reference facade.albedo must contain three finite reflectances")
            record["architecture"].update(facade=facade["material"], facade_albedo=colour.tolist())
            record["facade_reference"] = {"status": "photo-referenced", **facade, "source": observation["source"]}
        if "roof_forms" in observation:
            forms = observation["roof_forms"]
            if not isinstance(forms, list):
                raise TypeError("building_reference roof_forms must be a list")
            for form in forms:
                if not isinstance(form, dict):
                    raise TypeError("building_reference roof form must be an object")
                numbers = np.asarray(
                    [form.get(k, np.nan) for k in ["east_m", "north_m", "width_m", "depth_m", "height_m"]], dtype=float
                )
                if not np.isfinite(numbers).all() or np.any(numbers[2:4] < 0.3) or not 0.15 <= numbers[4] <= 20:
                    raise ValueError(
                        "building_reference roof form requires finite position, positive plan and 0.15 to 20 m height"
                    )
                if not form.get("from") or not form.get("height_from"):
                    raise ValueError("building_reference roof forms require plan and height provenance")
            record["roof_forms"] = forms
        if "roof_material" in observation:
            material = observation["roof_material"]
            if material not in {"membrane", "shingle", "metal"}:
                raise ValueError("building_reference roof_material must be membrane, shingle or metal")
            record["architecture"]["roof_material"] = material


def reference_outlines(footprints: list[dict], path: Path, tile: Tile) -> list[dict]:
    data = json.loads(path.read_text()).get("buildings", {})
    result = []
    for number, item in enumerate(footprints):
        key = str(item["tags"].get("id") or f"footprint-{number}")
        observation = data.get(key, {})
        if "roof_breaklines_m" in observation:
            lines = np.asarray(observation["roof_breaklines_m"], dtype=float)
            uncertainty = observation.get("roof_boundary_uncertainty_m")
            if (
                not observation.get("source")
                or lines.ndim != 3
                or lines.shape[1:] != (2, 2)
                or not 1 <= len(lines) <= 8
                or not np.isfinite(lines).all()
                or (uncertainty is not None and (not np.isfinite(uncertainty) or uncertainty < 0))
            ):
                raise ValueError(f"building_reference {key}: invalid or unsourced roof breaklines")
            lines = [shapely.LineString(line + tile.centre) for line in lines]
            if any(line.length < 1 or not item["polygon"].buffer(15).covers(line) for line in lines):
                raise ValueError(
                    f"building_reference {key}: roof breaklines must be near the footprint and at least 1 m long"
                )
            item = {
                **item,
                "roof_breaklines": lines,
                "roof_boundary_observation": {
                    "status": "photo-referenced",
                    "from": observation["source"],
                    "uncertainty_m": uncertainty,
                    "breakline_count": len(lines),
                    "note": "segments extend across the footprint; heights remain lidar-derived",
                },
            }
        if "outline_m" not in observation:
            result.append(item)
            continue
        if not observation.get("source"):
            raise ValueError(f"building_reference {key}: source is required")
        polygon = Polygon(np.asarray(observation["outline_m"], dtype=float) + tile.centre)
        if not polygon.is_valid or not shapely.box(*tile.bounds()).covers(polygon) or polygon.area < MIN_AREA_M2:
            raise ValueError(f"building_reference {key}: invalid or out-of-tile outline")
        if item["polygon"].hausdorff_distance(polygon) > 15:
            raise ValueError(f"building_reference {key}: outline moves more than 15 m")
        result.append(
            {
                **item,
                "polygon": polygon,
                "outline_observation": {
                    "status": "photo-referenced",
                    "from": observation["source"],
                    "uncertainty_m": observation.get("outline_uncertainty_m"),
                },
            }
        )
    for item in result:
        polygon = item["polygon"]
        reach = np.linalg.norm(np.ptp(np.asarray(polygon.exterior.coords), axis=0)) * 4
        for boundary in item.get("roof_breaklines", []):
            xy = np.asarray(boundary.coords)
            direction = (xy[1] - xy[0]) / boundary.length
            middle = xy.mean(axis=0)
            extended = shapely.LineString([middle - direction * reach, middle + direction * reach])
            regions = [part for part in split(polygon, extended).geoms if part.area > 0.01]
            if len(regions) < 2:
                raise ValueError("building_reference: roof breakline must partition the final footprint")
    return result


def label_under(labels: np.ndarray, covered: np.ndarray) -> np.ndarray:
    """Give the cells under buildings the class of the nearest cell that is not under one, so the roof never paints ground."""
    if not covered.any() or covered.all():
        return labels
    nearest = ndimage.distance_transform_edt(covered, return_distances=False, return_indices=True)
    return labels[tuple(nearest)]
