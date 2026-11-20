"""Architectural priors over measured footprints; dimensions and roof colours remain sourced.

Facade materials, openings, roof pitches and service equipment cannot be measured from a nadir photo.
The inventory labels those choices as priors rather than implying a surveyed reconstruction.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import pairwise

import numpy as np
import shapely
from scipy import ndimage
from shapely.affinity import translate
from shapely.geometry import LineString, Polygon
from shapely.ops import split

from .site import Tile

VERSION = 7
HOUSE_MAX_M2 = 320.0
INSTITUTION_MIN_M2 = 900.0
RECTANGULAR_SHARE = 0.96
ROOF_PITCH = 0.38
MAX_ROOF_RISE_M = 2.4
GRANDSTAND_CLAIM_SHARE = 0.25
PRIORS = [
    "prior: facade materials, window bays, entrances, trim and rooftop equipment are modular building-type approximations",
    "prior: untagged buildings use footprint size and roof reflectance to choose a plausible type and roof shape",
    "prior: rectangular residential roofs have a 0.38 rise/run pitch, capped at 2.4 m rise; lidar median remains the roof's mid-height",
    "prior: grandstand seating, railings and press boxes use the tagged footprint and measured height; individual rows are not surveyed",
]


def _roof_rectangles(component: np.ndarray) -> list[tuple[slice, slice]]:
    """Cover a sparse cluster with solid rectangles, leaving one-cell pipes and shadows unfilled."""
    remaining = component.copy()
    rows, columns = remaining.shape
    rectangles = []
    while remaining.any():
        best, best_area = None, 0
        for top in range(rows):
            solid = np.ones(columns, dtype=bool)
            for bottom in range(top, rows):
                solid &= remaining[bottom]
                height = bottom - top + 1
                if height < 2:
                    continue
                edges = np.flatnonzero(np.diff(np.r_[False, solid, False]))
                for left, right in edges.reshape(-1, 2):
                    left, right = int(left), int(right)
                    width = right - left
                    if width < 2 or max(width, height) > 4 * min(width, height):
                        continue
                    if width * height > best_area:
                        best, best_area = (slice(top, bottom + 1), slice(left, right)), width * height
        if best is None:
            break
        rectangles.append(best)
        remaining[best] = False
    return rectangles


def measure_roof_forms(polygon: Polygon, cells: np.ndarray, photo: np.ndarray, tile: Tile, cell_m: float) -> list[dict]:
    """Infer compact dark roof regions; their bounds may include shadows and their type is unknown."""
    if polygon.area < INSTITUTION_MIN_M2 or not cells.any():
        return []
    rows, columns = np.where(cells)
    r0, r1 = rows.min(), rows.max() + 1
    c0, c1 = columns.min(), columns.max() + 1
    inside = cells[r0:r1, c0:c1]
    rgb = photo[:, r0:r1, c0:c1].astype(float)
    luma = np.tensordot([0.2126, 0.7152, 0.0722], rgb, axes=(0, 0))
    median = float(np.median(luma[inside]))
    if median < 150:
        return []
    dark = inside & (luma < median - 30)
    labels, count = ndimage.label(dark, structure=np.ones((3, 3)))
    edge_labels = np.unique(labels[inside & ~ndimage.binary_erosion(inside, structure=np.ones((3, 3)))])
    safe = polygon.buffer(-cell_m)
    centre_east, centre_north = tile.centre
    forms = []
    for label, region in enumerate(ndimage.find_objects(labels, count), 1):
        if region is None or label in edge_labels:
            continue
        rr, cc = region
        width, depth = (cc.stop - cc.start) * cell_m, (rr.stop - rr.start) * cell_m
        if not (3 <= width * depth <= 200 and max(width, depth) <= 20 and max(width, depth) <= 4 * min(width, depth)):
            continue
        component = labels[rr, cc] == label
        regions = [(rr, cc)]
        if np.count_nonzero(component) < component.size * 0.85:
            pieces = _roof_rectangles(component)
            regions = [
                (slice(rr.start + r.start, rr.start + r.stop), slice(cc.start + c.start, cc.start + c.stop))
                for r, c in pieces
            ]
        for rr, cc in regions:
            width, depth = (cc.stop - cc.start) * cell_m, (rr.stop - rr.start) * cell_m
            if not (
                3 <= width * depth <= 200 and max(width, depth) <= 20 and max(width, depth) <= 4 * min(width, depth)
            ):
                continue
            west, east = tile.west + (c0 + cc.start) * cell_m, tile.west + (c0 + cc.stop) * cell_m
            north, south = tile.north - (r0 + rr.start) * cell_m, tile.north - (r0 + rr.stop) * cell_m
            if not safe.covers(shapely.box(west, south, east, north)):
                continue
            forms.append(
                {
                    "east_m": (west + east) / 2 - centre_east,
                    "north_m": (south + north) / 2 - centre_north,
                    "width_m": width,
                    "depth_m": depth,
                    "height_m": 0.9,
                    "from": "inferred: contrasting photo region; bounds may include cast shadow and object type is unconfirmed",
                    "height_from": "prior: 0.9 m; height is not measured from the photo",
                }
            )
    return forms


def building_kind(tags: dict) -> str:
    for key in ("class", "building"):
        kind = str(tags.get(key) or "")
        if kind and kind not in {"yes", "building"}:
            return kind
    return ""


def claim_bleachers(features: list[dict], footprints: Sequence[dict], tile: Tile) -> tuple[list[dict], list[dict]]:
    """A tagged grandstand owns a generic seating kit when their plans overlap by at least a quarter."""
    east, north = tile.centre
    stands = [translate(f["polygon"], -east, -north) for f in footprints if building_kind(f["tags"]) == "grandstand"]
    retained, claimed = [], []
    for feature in features:
        share = 0.0
        if feature["type"] == "bleacher" and stands:
            a, b = np.asarray(feature["points"], dtype=float)
            direction = (b - a) / np.linalg.norm(b - a)
            across = np.array([-direction[1], direction[0]])
            front = -feature["step_m"] * 0.275
            back = feature["step_m"] * (feature["rows"] - 1 + 0.275)
            seating = Polygon([a + across * front, b + across * front, b + across * back, a + across * back])
            share = max(seating.intersection(stand).area / seating.area for stand in stands)
        if share >= GRANDSTAND_CLAIM_SHARE:
            claimed.append({"id": feature["id"], "overlap_share": float(share), "owner": "tagged building grandstand"})
        else:
            retained.append(feature)
    return retained, claimed


def describe(record: dict, tags: dict, opposite_stand: tuple[float, float] | None = None) -> dict:
    """A serializable style and optional ridged roof mesh in metres east/north, Z relative to the measured roof."""
    polygon = Polygon(record["rings"][0], record["rings"][1:])
    rectangle = polygon.minimum_rotated_rectangle
    corners = np.asarray(rectangle.exterior.coords)[:4]
    edges = np.roll(corners, -1, axis=0) - corners
    lengths = np.linalg.norm(edges, axis=1)
    longest = int(np.argmax(lengths))
    along = edges[longest] / lengths[longest]
    across = np.array([-along[1], along[0]])
    centre = np.asarray(rectangle.centroid.coords[0])
    if opposite_stand is not None and np.dot(across, centre - np.asarray(opposite_stand)) < 0:
        along, across = -along, -across
    width = float(np.min(lengths))
    kind = building_kind(tags)
    if kind == "grandstand":
        role = "grandstand"
    elif kind in {"house", "detached", "residential", "apartments", "dormitory", "static_caravan"}:
        role = "residential"
    elif kind in {"school", "university", "college", "hospital", "civic", "library", "religious", "church"}:
        role = "institution"
    elif kind in {"shed", "garage", "roof", "carport", "shelter", "pavilion", "industrial"}:
        role = "utility"
    elif kind:
        role = "commercial"
    elif record["area_m2"] <= HOUSE_MAX_M2 and width < 20 and record["height_m"] < 9:
        role = "residential"
    else:
        role = "institution" if record["area_m2"] >= INSTITUTION_MIN_M2 else "commercial"
    facade = "siding" if role == "residential" else "concrete" if role in {"utility", "grandstand"} else "brick"
    # Linear reflectance, not sRGB; no ortho sees these vertical surfaces.
    colour = {"brick": [0.27, 0.115, 0.065], "siding": [0.48, 0.43, 0.34], "concrete": [0.40, 0.39, 0.35]}[facade]
    rectangular = not polygon.interiors and polygon.area / rectangle.area >= RECTANGULAR_SHARE
    tagged_shape = str(tags.get("roof:shape") or "")
    pitched = (
        rectangular
        and width >= 3
        and (
            tagged_shape == "gabled"
            or (not tagged_shape and role == "residential" and np.mean(record["roof_albedo"]) < 0.3)
        )
    )
    rise = min(width * ROOF_PITCH / 2, MAX_ROOF_RISE_M) if pitched else 0.0
    stand_rows = max(3, min(40, round(width / 0.85))) if role == "grandstand" and rectangular and width >= 3 else 0
    if stand_rows and record.get("reference", {}).get("stand_rows"):
        stand_rows = record["reference"]["stand_rows"]
    result = {
        "role": role,
        "role_from": f"tag: {kind}" if kind else "prior: footprint area, width and measured height",
        "facade": facade,
        "facade_albedo": colour,
        "roof_shape": "stepped" if stand_rows else "gabled" if pitched else "flat",
        "roof_shape_from": f"tag: {tagged_shape}"
        if not stand_rows and (tagged_shape == "flat" or (tagged_shape == "gabled" and pitched))
        else "prior: building type and rectangularity",
        "centre_m": centre.tolist(),
        "along": along.tolist(),
        "length_m": float(np.max(lengths)),
        "width_m": width,
        "rise_m": rise,
        "stand_rows": stand_rows,
        "stand_step_m": record.get("stand_rise_m", record["height_m"] * 2) / stand_rows if stand_rows else 0,
        "parapet_m": 0.32 if not pitched and role in {"institution", "commercial"} else 0.0,
        "detail_from": "prior: modular facade and roof kit; see buildings.priors",
        "orientation_from": "inferred: rows rise away from the nearest opposing tagged stand"
        if opposite_stand is not None
        else "prior: footprint principal axes",
        "roof_vertices": [],
        "roof_triangles": [],
    }
    if stand_rows:
        step = result["stand_step_m"]
        for row in range(stand_rows):
            lo = -width / 2 + row * width / stand_rows
            hi = -width / 2 + (row + 1) * width / stand_rows
            strip = Polygon(
                [
                    centre + along * x + across * y
                    for x, y in [(-lengths.max(), lo), (lengths.max(), lo), (lengths.max(), hi), (-lengths.max(), hi)]
                ]
            )
            part = polygon.intersection(strip)
            if part.is_empty:
                continue
            for triangle in shapely.constrained_delaunay_triangles(part).geoms:
                start = len(result["roof_vertices"])
                for point in list(triangle.exterior.coords)[:3]:
                    result["roof_vertices"].append([*point, (row + 1 - stand_rows * 0.5) * step])
                result["roof_triangles"].append([start, start + 1, start + 2])
        for row in range(1, stand_rows):
            boundary = -width / 2 + row * width / stand_rows
            line = LineString(
                [centre + across * boundary - along * lengths.max(), centre + across * boundary + along * lengths.max()]
            )
            clipped = polygon.intersection(line)
            pending = [clipped]
            while pending:
                part = pending.pop()
                if part.geom_type == "LineString" and not part.is_empty:
                    points = list(part.coords)
                    for a, b in pairwise(points):
                        if a == b:
                            continue
                        low = (row - stand_rows * 0.5) * step
                        high = low + step
                        start = len(result["roof_vertices"])
                        result["roof_vertices"].extend([[*a, low], [*b, low], [*b, high], [*a, high]])
                        result["roof_triangles"].extend([[start, start + 1, start + 2], [start, start + 2, start + 3]])
                elif hasattr(part, "geoms"):
                    pending.extend(part.geoms)
    elif pitched:
        cutter = LineString([centre - along * lengths.max() * 2, centre + along * lengths.max() * 2])
        for part in split(polygon, cutter).geoms:
            for triangle in shapely.constrained_delaunay_triangles(part).geoms:
                indices = []
                for point in list(triangle.exterior.coords)[:3]:
                    offset = rise * (0.5 - abs(np.dot(np.asarray(point) - centre, across)) / (width / 2))
                    indices.append(len(result["roof_vertices"]))
                    result["roof_vertices"].append([*point, float(offset)])
                result["roof_triangles"].append(indices)
    return result
