"""Static distant massing from wide footprints and observed canopy support.

All heights are baked against the exported context Landscape. Priors describe shape
and missing attributes; they never invent canopy support or primary ownership.
"""
from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
import shapely
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject
from scipy import ndimage
from shapely.geometry import Point, Polygon

from . import buildings, frame, surface
from .acquire import sha256_file
from .site import Tile

SETTINGS = {
    "version": 1,
    "canopy_cell_m": 32.0,
    "support_cell_m": 8.0,
    "colour_cell_m": 2.0,
    "batch_m": 252.0,
    "max_batch_triangles": 20000,
    "max_triangles": 1500000,
    "max_batches": 1024,
    "max_raster_side": 4096,
    "wall_step_m": 4.0,
    "wall_merge_epsilon_m": 1e-7,
    "bury_m": 0.5,
    "height_prior_m": 6.0,
    "floor_m": buildings.FLOOR_M,
    "footprint_settings": buildings.SETTINGS,
    "wall_albedo_prior": 0.25,
    "roof_albedo_prior": [0.25, 0.25, 0.25],
    "canopy_albedo_prior": [0.08, 0.16, 0.06],
    "canopy_shape": "inscribed 12-sided rounded mass, else support-shaped dome",
    "canopy_height": "median above-cutoff conservative support cells",
    "canopy_base": "rounded base below minimum boundary terrain; support dome edges follow terrain triangles",
    "ellipse_min_area_fraction": 0.65,
}


def _inventory(description, out):
    return json.loads((out / description["file"]).read_text()) if description else {}


def _primary_exclusions(site, primary_buildings, primary_trees, out):
    east, north = site.tile.centre
    polygons = [shapely.box(*site.tile.bounds())]
    for record in _inventory(primary_buildings, out).get("buildings", []):
        rings = [[(x + east, y + north) for x, y in ring] for ring in record["rings"]]
        polygons.append(shapely.make_valid(Polygon(rings[0], rings[1:])))
    primary = shapely.union_all(polygons)
    trees = _inventory(primary_trees, out)
    crowns = []
    for row in trees.get("trees", []):
        tree = dict(zip(trees["columns"], row, strict=True))
        crowns.append(Point(east + tree["east_m"], north + tree["north_m"]).buffer(tree["crown_radius_m"]))
    return primary, shapely.union_all([primary, *crowns])


def _grid(site, cell_m):
    size = math.ceil(site.context_size_m / cell_m)
    if size > SETTINGS["max_raster_side"]:
        raise ValueError("context geometry raster exceeds max_raster_side")
    east, north = site.tile.centre
    return size, from_origin(east - site.context_size_m / 2, north + site.context_size_m / 2, cell_m, cell_m)


def _photo(site, sources):
    source = sources.get("context_imagery")
    if not source:
        return None, None, {"status": "absent", "fallback": "labelled albedo priors"}
    size, transform = _grid(site, SETTINGS["colour_cell_m"])
    photo = np.full((3, size, size), np.nan, np.float32)
    with rasterio.open(source["path"]) as src:
        named_bands = dict(site.imagery.bands or ())
        bands = ([named_bands[name] for name in ("red", "green", "blue")] if named_bands
                 else ([1, 2, 3] if src.count >= 3 else [1]))
        if len(bands) == 1:
            bands *= 3
        if len(bands) != 3:
            raise ValueError("context geometry imagery needs RGB or greyscale bands")
        for band, target in zip(bands, photo, strict=True):
            reproject(rasterio.band(src, band), target, dst_transform=transform, dst_crs=site.crs,
                      dst_nodata=np.nan, resampling=Resampling.average)
    valid = np.isfinite(photo).all(axis=0)
    return photo, transform, {"status": "present" if valid.any() else "invalid",
                              "sha256": source["sha256"], "valid_fraction": float(valid.mean())}


def _colour(polygon, photo, transform, fallback, classes, roof=False):
    if photo is not None:
        west, south, east, north = polygon.bounds
        col0 = max(0, math.floor((west - transform.c) / transform.a))
        col1 = min(photo.shape[2], math.ceil((east - transform.c) / transform.a))
        row0 = max(0, math.floor((transform.f - north) / -transform.e))
        row1 = min(photo.shape[1], math.ceil((transform.f - south) / -transform.e))
        if row1 > row0 and col1 > col0:
            local = photo[:, row0:row1, col0:col1]
            mask = rasterize([(polygon, 1)], out_shape=local.shape[1:],
                             transform=transform * rasterio.Affine.translation(col0, row0)).astype(bool)
            mask &= np.isfinite(local).all(axis=0)
            if mask.any():
                encoded = np.median(local[:, mask], axis=1)
                albedo = classes.get("albedo", {})
                curve = albedo.get("curves", {}).get(surface.PAVED) if roof else None
                rgb = buildings.roof_albedo(encoded, curve, albedo.get("scale", 1.0))
                return np.clip(rgb, 0, 1).tolist(), "source: context imagery over support"
    return list(fallback), "prior: no usable context imagery over support"


class _Meshes:
    def __init__(self):
        self.meshes = []
        self.active = {}
        self.total = 0

    def add(self, kind, vertices, triangles, colour):
        vertices = np.asarray(vertices, dtype=float)
        for triangle in triangles:
            corners = vertices[triangle]
            key = (kind, *np.floor(corners[:, :2].mean(axis=0) / SETTINGS["batch_m"]).astype(int))
            mesh, indices = self.active.get(key, (None, None))
            if mesh is None or len(mesh["triangles"]) == SETTINGS["max_batch_triangles"]:
                if len(self.meshes) >= SETTINGS["max_batches"]:
                    raise ValueError("context geometry exceeds batch cap")
                origin = [float(key[1] * SETTINGS["batch_m"]), float(key[2] * SETTINGS["batch_m"]), 0.0]
                mesh = {"kind": kind, "origin_enu_m": origin, "vertices": [], "triangles": [], "colours": []}
                indices = {}
                self.meshes.append(mesh)
                self.active[key] = mesh, indices
            if self.total >= SETTINGS["max_triangles"]:
                raise ValueError("context geometry exceeds triangle cap")
            local = []
            for point in corners:
                coord = tuple(point - mesh["origin_enu_m"])
                if coord not in indices:
                    indices[coord] = len(mesh["vertices"])
                    mesh["vertices"].append(list(coord))
                local.append(indices[coord])
            mesh["triangles"].append(local)
            mesh["colours"].append(colour)
            self.total += 1


class _Ground:
    def __init__(self, context, out):
        self.context = context
        with Image.open(out / context["heightmap"]) as image:
            self.heights = np.asarray(image)
        frame.sample_heightmap(self.heights, context, np.empty((0, 2)))
        self.probes = {}

    def sample(self, points):
        points = np.asarray(points, dtype=float).reshape(-1, 2)
        heights = frame.sample_heightmap(self.heights, self.context, points)
        half = self.context["size_m"] / 2
        for point, height in zip(points, heights, strict=True):
            key = tuple(np.minimum(7, np.floor((point + half) / (2 * half) * 8)).astype(int))
            self.probes.setdefault(key, [*point.tolist(), float(height)])
        return heights


def _wall_ring(ring, context):
    """Split walls at every terrain triangle edge, as well as the wall length limit."""
    spacing = np.asarray(context["scale"][:2][::-1]) / 100
    low = np.asarray(context["location_cm"][:2][::-1]) / 100
    points = []
    for first, last in zip(ring, [*ring[1:], ring[0]], strict=True):
        first, last = np.asarray(first), np.asarray(last)
        a, b = (first - low) / spacing, (last - low) / spacing
        cuts = {0.0}
        steps = math.ceil(np.linalg.norm(last - first) / SETTINGS["wall_step_m"])
        cuts.update(i / steps for i in range(1, steps))
        for start, stop in zip([*a, a[1] - a[0]], [*b, b[1] - b[0]], strict=True):
            if start != stop:
                for line in range(math.floor(min(start, stop)) + 1, math.ceil(max(start, stop))):
                    t = (line - start) / (stop - start)
                    if 0 < t < 1:
                        cuts.add(t)
        for t in sorted(cuts):
            point = first + t * (last - first)
            if not points or np.linalg.norm(point - points[-1]) > SETTINGS["wall_merge_epsilon_m"]:
                points.append(point.tolist())
    if len(points) > 1 and np.linalg.norm(np.asarray(points[-1]) - points[0]) <= SETTINGS["wall_merge_epsilon_m"]:
        points.pop()
    return points


def _building(polygon, height, centre, ground, meshes, colour):
    rings, triangles = buildings.triangulate(polygon)
    relative = [[[x - centre[0], y - centre[1]] for x, y in ring] for ring in rings]
    walls = [_wall_ring(ring, ground.context) for ring in relative]
    wall_heights = [ground.sample(ring) for ring in walls]
    maximum = max(float(h.max()) for h in wall_heights)
    # A terrain peak can lie wholly inside the roof, away from every wall.
    spacing = ground.context["scale"][0] / 100
    half = ground.context["size_m"] / 2
    west, south, east, north = polygon.bounds
    es = np.arange(math.ceil((west - centre[0] + half) / spacing),
                   math.floor((east - centre[0] + half) / spacing) + 1) * spacing - half
    ns = np.arange(math.ceil((south - centre[1] + half) / spacing),
                   math.floor((north - centre[1] + half) / spacing) + 1) * spacing - half
    if es.size and ns.size:
        e, n = np.meshgrid(es, ns)
        points = np.column_stack((e.ravel(), n.ravel()))
        inside = shapely.intersects_xy(polygon, points[:, 0] + centre[0], points[:, 1] + centre[1])
        if inside.any():
            maximum = max(maximum, float(ground.sample(points[inside]).max()))
    top = maximum + height
    vertices = [[x, y, top] for ring in relative for x, y in ring]
    roof_triangles = []
    for a, b, c in triangles:
        if np.cross(np.asarray(vertices[b]) - vertices[a], np.asarray(vertices[c]) - vertices[a])[2] < 0:
            b, c = c, b
        roof_triangles.append([a, b, c])
    meshes.add("building", vertices, roof_triangles, colour)
    for ring, heights in zip(walls, wall_heights, strict=True):
        vertices, triangles = [], []
        for i, point in enumerate(ring):
            vertices.extend([[*point, float(heights[i]) - SETTINGS["bury_m"]], [*point, top]])
        for i in range(len(ring)):
            a, b = 2 * i, 2 * ((i + 1) % len(ring))
            triangles.extend([[a, b, b + 1], [a, b + 1, a + 1]])
        meshes.add("building", vertices, triangles, [SETTINGS["wall_albedo_prior"]] * 3)


def _canopy_support(site, sources, exclusion, cutoff):
    source = sources.get("context_canopy_height")
    if not source:
        return None, None, None, {"status": "absent"}
    if cutoff is None or not math.isfinite(cutoff) or cutoff < 0:
        raise ValueError("context canopy source requires a finite nonnegative cutoff_m")
    size, transform = _grid(site, SETTINGS["support_cell_m"])
    heights = np.full((size, size), np.nan, np.float32)
    coverage = np.zeros((size, size), np.float32)
    with rasterio.open(source["path"]) as src:
        data = src.read(1, masked=True).astype(np.float32).filled(np.nan)
        valid = np.isfinite(data) & (data >= 0)
        reproject(np.where(valid, data, np.nan), heights, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=np.nan, dst_transform=transform, dst_crs=site.crs,
                  dst_nodata=np.nan, resampling=Resampling.min)
        # Zero padding makes partly outside source cells ineligible too.
        reproject(np.pad(valid.astype(np.float32), 1), coverage,
                  src_transform=src.transform * rasterio.Affine.translation(-1, -1), src_crs=src.crs,
                  dst_transform=transform, dst_crs=site.crs, resampling=Resampling.min)
    observed = np.isfinite(heights) & (coverage >= 1)
    support = observed & (heights > cutoff)
    before = int(support.sum())
    excluded = rasterize([(exclusion, 1)], out_shape=support.shape, transform=transform, all_touched=True).astype(bool)
    support &= ~excluded
    # The last coarse cell may extend past a context size that is not a multiple of 8 m.
    if size * SETTINGS["support_cell_m"] > site.context_size_m:
        support[-1, :] = False
        support[:, -1] = False
    report = {"status": "present" if support.any() else ("empty" if observed.any() else "invalid"),
              "sha256": source["sha256"], "cutoff_m": cutoff,
              "valid_fraction": float(observed.mean()), "above_cutoff_cells": before,
              "excluded_cells": before - int(support.sum()),
              "eligible_support_area_m2": int(support.sum()) * SETTINGS["support_cell_m"] ** 2,
              "support_from": "minimum CHM in fully valid cells; no interpolation across gaps",
              "height_from": SETTINGS["canopy_height"], "clusters": []}
    return support, heights, transform, report


def _canopy_mesh(polygon, cells, height, centre, ground, meshes, colour):
    candidates = [polygon.representative_point(), polygon.centroid, *(cell.centroid for cell in cells)]
    anchor = max((point for point in candidates if polygon.covers(point)),
                 key=lambda point: point.distance(polygon.boundary))
    radius = anchor.distance(polygon.boundary)
    ellipse = Point(anchor.x, anchor.y).buffer(radius, quad_segs=3)
    # A centred disk can be too large even in a full square; shrink until it fits.
    while radius > 0.1 and not polygon.covers(ellipse):
        radius *= 0.95
        ellipse = Point(anchor.x, anchor.y).buffer(radius, quad_segs=3)
    if ellipse.area >= polygon.area * SETTINGS["ellipse_min_area_fraction"]:
        ring = np.asarray(ellipse.exterior.coords[:-1]) - centre
        anchor_xy = np.array([anchor.x, anchor.y]) - centre
        vertices = []
        base = float(ground.sample(_wall_ring(ring.tolist(), ground.context)).min()) - SETTINGS["bury_m"]
        for scale, rise in ((1.0, -SETTINGS["bury_m"]), (0.92, height * 0.5), (0.55, height * 0.85)):
            xy = anchor_xy + (ring - anchor_xy) * scale
            z = np.full(len(xy), base) if scale == 1.0 else ground.sample(xy) + rise
            vertices.extend(np.column_stack((xy, z)).tolist())
        vertices.append([*anchor_xy, float(ground.sample([anchor_xy])[0]) + height])
        n = len(ring)
        triangles = []
        for layer in range(2):
            for i in range(n):
                a, b = layer * n + i, layer * n + (i + 1) % n
                triangles.extend([[a, b, b + n], [a, b + n, a + n]])
        triangles.extend([[2 * n + i, 2 * n + (i + 1) % n, 3 * n] for i in range(n)])
        # Shapely's buffer ring is clockwise; reverse to outward ENU winding.
        meshes.add("canopy", vertices, [t[::-1] for t in triangles], colour)
        return "rounded", ellipse.area
    # Every fan stays inside one observed cell. Distance to the patch boundary makes
    # an irregular dome with open holes, rather than a flat extruded forest slab.
    points, triangles = [], []
    for cell in cells:
        ring = list(cell.exterior.coords)[:-1]
        ring = list(shapely.geometry.polygon.orient(Polygon(ring), 1).exterior.coords)[:-1]
        ring = (np.asarray(_wall_ring((np.asarray(ring) - centre).tolist(), ground.context)) + centre).tolist()
        start = len(points)
        points.extend(ring)
        points.append((cell.centroid.x, cell.centroid.y))
        triangles.extend([[start + i, start + (i + 1) % len(ring), start + len(ring)] for i in range(len(ring))])
    xy = np.asarray(points)
    distance = shapely.distance(shapely.points(xy), polygon.boundary)
    reach = max(float(distance.max()), 0.01)
    fraction = np.clip(distance / reach, 0, 1)
    rise = height * np.sqrt(1 - (1 - fraction) ** 2) - SETTINGS["bury_m"] * (1 - fraction)
    relative = xy - centre
    vertices = np.column_stack((relative, ground.sample(relative) + rise))
    meshes.add("canopy", vertices, triangles, colour)
    return "support-shaped", polygon.area


def validate(payload):
    """Validate the exact wire geometry before publishing it to the native importer."""
    bounds = np.asarray(payload["bounds_enu_m"], dtype=float)
    if payload["schema_version"] != 1 or payload["frame"] != "east_north_up_m":
        raise ValueError("unsupported context geometry schema or frame")
    if bounds.shape != (4,) or not np.isfinite(bounds).all() or np.any(bounds[2:] <= bounds[:2]):
        raise ValueError("invalid context geometry bounds")
    if not math.isfinite(payload["primary_half_m"]) or payload["primary_half_m"] <= 0:
        raise ValueError("invalid primary bounds")
    digest = payload["context_heightmap_sha256"]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("invalid context heightmap hash")
    if len(payload["meshes"]) > SETTINGS["max_batches"]:
        raise ValueError("context geometry exceeds batch cap")
    total = 0
    for mesh in payload["meshes"]:
        origin = np.asarray(mesh["origin_enu_m"], dtype=float)
        vertices = np.asarray(mesh["vertices"], dtype=float)
        triangles = np.asarray(mesh["triangles"])
        colours = np.asarray(mesh["colours"], dtype=float)
        if (mesh["kind"] not in ("building", "canopy") or origin.shape != (3,)
            or vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices)
            or len(vertices) > SETTINGS["max_batch_triangles"] * 3
            or triangles.ndim != 2 or triangles.shape[1] != 3 or not len(triangles)
            or not np.issubdtype(triangles.dtype, np.integer)
            or colours.shape != (len(triangles), 3)
            or not all(np.isfinite(x).all() for x in (origin, vertices, colours))
            or np.any(colours < 0) or np.any(colours > 1)
            or np.any(triangles < 0) or np.any(triangles >= len(vertices))):
            raise ValueError("malformed context mesh")
        absolute = vertices + origin
        if np.any(absolute[:, :2] < bounds[:2] - 1e-7) or np.any(absolute[:, :2] > bounds[2:] + 1e-7):
            raise ValueError("context mesh outside bounds")
        corners = vertices[triangles]
        if np.any(np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1) <= 1e-10):
            raise ValueError("degenerate context triangle")
        total += len(triangles)
        if len(triangles) > SETTINGS["max_batch_triangles"] or total > SETTINGS["max_triangles"]:
            raise ValueError("context geometry exceeds triangle cap")
    if payload["counts"]["batches"] != len(payload["meshes"]) or payload["counts"]["triangles"] != total:
        raise ValueError("context geometry count mismatch")
    probes = np.asarray(payload["ground_probes"], dtype=float).reshape(-1, 3)
    if len(probes) > 64 or not np.isfinite(probes).all():
        raise ValueError("invalid context ground probes")
    if np.any(probes[:, :2] < bounds[:2]) or np.any(probes[:, :2] > bounds[2:]):
        raise ValueError("ground probe outside context")


def build(site, sources, context, primary_buildings, primary_trees, classes, out: Path, cutoff_m=None) -> dict:
    centre = np.asarray(site.tile.centre)
    half = site.context_size_m / 2
    tile = Tile(centre[0] - half, centre[1] - half, context["scale"][0] / 100, context["vertices"] - 1)
    primary, crown_exclusion = _primary_exclusions(site, primary_buildings, primary_trees, out)
    ground, meshes = _Ground(context, out), _Meshes()
    photo, photo_transform, photo_report = _photo(site, sources)
    source = sources.get("buildings")
    footprints = buildings.load_footprints(Path(source["path"]), site.crs, tile) if source else []
    report = {"status": "present" if footprints else ("empty" if source else "absent"),
              "sha256": source["sha256"] if source else None, "requested": len(footprints),
              "duplicates": 0, "primary_crossing": 0, "omitted_crossing_area_m2": 0.0,
              "outer_boundary_parts": 0, "records": []}
    height_from, colour_from, seen = Counter(), Counter(), set()
    outer = shapely.box(*tile.bounds()).boundary
    for item in footprints:
        polygon, tags = item["polygon"], item["tags"]
        key = shapely.normalize(polygon).wkb
        if key in seen:
            report["duplicates"] += 1
            continue
        seen.add(key)
        if polygon.intersects(primary):
            report["primary_crossing"] += 1
            report["omitted_crossing_area_m2"] += polygon.difference(primary).area
            continue
        report["outer_boundary_parts"] += int(polygon.intersects(outer))
        if buildings._positive(tags.get("height_m")):
            height, provenance = float(tags["height_m"]), "source: height_m tag"
        elif buildings._positive(tags.get("num_floors")):
            height, provenance = float(tags["num_floors"]) * SETTINGS["floor_m"], "prior: num_floors times floor_m"
        else:
            height = SETTINGS["height_prior_m"]
            provenance = f"prior: explicit {height:g} m height"
        if not math.isfinite(height):
            raise ValueError("nonfinite context building height")
        colour, colour_provenance = _colour(polygon, photo, photo_transform, SETTINGS["roof_albedo_prior"], classes, True)
        _building(polygon, height, centre, ground, meshes, colour)
        height_from[provenance] += 1
        colour_from[colour_provenance] += 1
        report["records"].append({"id": tags.get("id"), "area_m2": polygon.area, "height_m": height,
                                  "height_from": provenance, "colour_from": colour_provenance})
    report["eligible"] = report["placed"] = len(report["records"])
    report["height_from"], report["colour_from"] = dict(height_from), dict(colour_from)
    all_footprints = shapely.union_all([item["polygon"] for item in footprints])
    exclusion = shapely.union_all([crown_exclusion, all_footprints])
    support, heights, transform, canopy = _canopy_support(site, sources, exclusion, cutoff_m)
    if support is not None:
        block = round(SETTINGS["canopy_cell_m"] / SETTINGS["support_cell_m"])
        represented = 0.0
        for row in range(0, support.shape[0], block):
            for col in range(0, support.shape[1], block):
                window = support[row:row + block, col:col + block]
                labels, count = ndimage.label(window)
                for label in range(1, count + 1):
                    rs, cs = np.where(labels == label)
                    cells = []
                    for r, c in zip(rs + row, cs + col, strict=True):
                        west, north = transform * (c, r)
                        cells.append(shapely.box(west, north + transform.e, west + transform.a, north))
                    polygon = shapely.union_all(cells)
                    height = float(np.median(heights[rs + row, cs + col]))
                    colour, provenance = _colour(polygon, photo, photo_transform, SETTINGS["canopy_albedo_prior"], classes)
                    kind, area = _canopy_mesh(polygon, cells, height, centre, ground, meshes, colour)
                    represented += area
                    canopy["clusters"].append({"cell": [row // block, col // block], "shape": kind,
                                               "support_area_m2": polygon.area, "represented_area_m2": area,
                                               "height_m": height, "colour_from": provenance})
        canopy["represented_area_m2"] = represented
        canopy["omitted_support_area_m2"] = canopy["eligible_support_area_m2"] - represented
    counts = {"buildings": len(report["records"]), "canopy_clusters": len(canopy.get("clusters", [])),
              "batches": len(meshes.meshes), "triangles": meshes.total}
    payload = {"schema_version": 1, "frame": "east_north_up_m",
               "context_heightmap_sha256": sha256_file(out / context["heightmap"]),
               "bounds_enu_m": [-half, -half, half, half], "primary_half_m": site.tile.size_m / 2,
               "counts": counts, "sources": {"buildings": report, "canopy": canopy, "imagery": photo_report},
               "settings": SETTINGS, "ground_probes": [ground.probes[key] for key in sorted(ground.probes)],
               "meshes": meshes.meshes}
    validate(payload)
    (out / "context_geometry.json").write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    return {"files": ["context_geometry.json"], "file": "context_geometry.json", "schema_version": 1, "counts": counts}
