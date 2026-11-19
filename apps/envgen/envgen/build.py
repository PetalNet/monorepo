"""Elevation, surface classes, colour, surround and manifest. Each stage reads artifacts and writes artifacts."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform
from scipy import ndimage

from . import frame, lidar, surface
from .acquire import acquire, sha256_file
from .site import (
    CONTEXT_QUADS,
    LANDSCAPE_SECTION_QUADS,
    LANDSCAPE_SECTIONS_PER_COMPONENT,
    SCHEMA_VERSION,
    Site,
    Tile,
    load_site,
)

# Part of every stage key. Bump it by hand when a code change alters a stage's output for the same
# inputs (frame.py and the resampling included); nothing detects that automatically.
PIPELINE_VERSION = 3

MACRO_PIXELS = 1024
# The macro map carries colour that varies over tens of metres. Finer detail comes from the engine.
MACRO_LOW_PASS_M = 12.0
# Anything standing this far above the ground (trees, roofs) is not ground colour.
COVER_HEIGHT_M = 2.0
# Cover also darkens the ground beside it with shadow; keep that out of the ground colour too.
SHADOW_MARGIN_M = 4.0
# Shadows run much further than that margin, and trees grow after a lidar survey. Ground darker than this
# share of the open ground around it is taken to be in shade or under a tree, and is not ground colour
# either. Vegetation is compared with vegetation, so turf beside bright concrete is not mistaken for shade.
SHADE_RATIO = 0.85
SHADE_REFERENCE_M = 30.0
SHADE_PASSES = 3
# Ground needs this much sunlit ground within the low-pass's reach to take its colour from it.
OWN_CLASS_MIN = 0.02

# Where no ground return lies within GAP_START_M the elevation model was interpolated, usually as flat
# facets under roofs. Blend towards a smoothed surface, fully by GAP_FULL_M.
GAP_START_M = 3.0
GAP_FULL_M = 8.0
GAP_SMOOTH_M = 4.0

CONTEXT_MACRO_PIXELS = 512
# The surround passes under the tile; it sits this far below the detailed surface there so it never shows through.
CONTEXT_SINK_M = 1.0

# Stencil values the engine side writes into custom depth, for segmentation cameras.
STENCIL_CLASSES = {"ground": 1, "grass": 2, "tree": 3, "building": 4, "road": 5, "water": 6, "pad": 7}


def _warp(
    path: Path, crs: str, west: float, north: float, spacing: float, size: int, resampling: Resampling
) -> np.ndarray:
    """Resample every band of a raster onto a north-up square grid whose first pixel centre is (west, north)."""
    with rasterio.open(path) as source:
        # RGB when there are at least three bands; otherwise the first band alone (grey, or grey plus alpha).
        bands = 3 if source.count >= 3 else 1
        out = np.full((bands, size, size), np.nan, dtype=np.float32)
        for band in range(bands):
            reproject(
                rasterio.band(source, band + 1),
                out[band],
                dst_transform=from_origin(west - spacing / 2, north + spacing / 2, spacing, spacing),
                dst_crs=crs,
                dst_nodata=np.nan,
                resampling=resampling,
            )
    return out


def _fill_gaps(values: np.ndarray, what: str) -> tuple[np.ndarray, float]:
    """Fill missing cells from the nearest valid one. Returns the filled array and the fraction filled."""
    missing = ~np.isfinite(values)
    fraction = float(missing.mean())
    if fraction == 1.0:
        raise RuntimeError(f"the {what} source has no data inside the tile; check its extent and CRS")
    if fraction:
        nearest = ndimage.distance_transform_edt(missing, return_distances=False, return_indices=True)
        values = values[tuple(nearest)]
    return values, fraction


def _sample_cells(cells: np.ndarray, size: int) -> np.ndarray:
    """Nearest-cell resample of a square north-up raster to `size` samples a side over the same ground."""
    index = np.minimum(((np.arange(size) + 0.5) * cells.shape[0] / size).astype(int), cells.shape[0] - 1)
    return cells[np.ix_(index, index)]


def _write_rgb(north_up_bands: np.ndarray, path: Path) -> None:
    rgb = np.clip(np.rint(np.moveaxis(north_up_bands, 0, -1)), 0, 255).astype(np.uint8)
    if rgb.shape[2] == 1:
        rgb = np.repeat(rgb, 3, axis=2)
    Image.fromarray(frame.to_unreal_layout(rgb)).save(path)


def read_structure(site: Site, cache: Path, dem: Path) -> tuple[np.ndarray, np.ndarray]:
    """(height above ground, ground gap) on the lidar grid."""
    tile = site.tile
    points = lidar.load_points(site.lidar, tile, site.crs, cache)
    cells = round(tile.size_m / lidar.CELL_M)
    half = lidar.CELL_M / 2
    ground = _warp(dem, site.crs, tile.west + half, tile.north - half, lidar.CELL_M, cells, Resampling.bilinear)[0]
    ground, _ = _fill_gaps(ground, "elevation")
    return lidar.rasterise(points, tile, ground)


def build_elevation(tile: Tile, crs: str, dem: Path, out: Path, ground_gap: np.ndarray | None) -> dict:
    north_up = _warp(dem, crs, tile.west, tile.north, tile.quad_m, tile.vertices, Resampling.bilinear)[0]
    north_up, filled = _fill_gaps(north_up, "elevation")
    smoothed = 0.0
    if ground_gap is not None:
        gap = _sample_cells(ground_gap, tile.vertices)
        weight = np.clip((gap - GAP_START_M) / (GAP_FULL_M - GAP_START_M), 0.0, 1.0)
        weight = ndimage.gaussian_filter(weight, GAP_SMOOTH_M / tile.quad_m / 2, mode="nearest")
        blurred = ndimage.gaussian_filter(north_up, GAP_SMOOTH_M / tile.quad_m, mode="nearest")
        north_up = north_up * (1 - weight) + blurred * weight
        smoothed = float((weight > 0.5).mean())
    heights, mid_m, z_scale = frame.encode_heights(north_up)
    Image.fromarray(frame.to_unreal_layout(heights)).save(out / "heightmap.png")
    centre = tile.vertices // 2
    return {
        "file": "heightmap.png",
        "vertices": tile.vertices,
        "min_m": float(north_up.min()),
        "max_m": float(north_up.max()),
        "mid_m": mid_m,
        "z_scale": z_scale,
        "origin_height_m": float(north_up[centre, centre]),
        "filled_fraction": filled,
        "smoothed_fraction": smoothed,
    }


def _within(values: np.ndarray, listen: np.ndarray, reach: float) -> tuple[np.ndarray, np.ndarray]:
    """A low-pass that only listens to some cells. Returns it with how much there was to listen to."""
    listen = listen.astype(np.float32)
    support = ndimage.gaussian_filter(listen, reach, mode="nearest")
    return ndimage.gaussian_filter(values * listen, reach, mode="nearest") / np.maximum(support, 1e-6), support


def _ground_view(
    tile: Tile, crs: str, imagery: Path, height_above_ground: np.ndarray | None
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """The imagery on the macro grid, north-up; its cells not under cover; those also in the light; fraction filled."""
    spacing = tile.size_m / MACRO_PIXELS
    north_up = _warp(
        imagery, crs, tile.west + spacing / 2, tile.north - spacing / 2, spacing, MACRO_PIXELS, Resampling.average
    )
    filled = 0.0
    for band in range(north_up.shape[0]):
        north_up[band], fraction = _fill_gaps(north_up[band], "imagery")
        filled = max(filled, fraction)
    open_ground = np.ones((MACRO_PIXELS, MACRO_PIXELS), dtype=bool)
    if height_above_ground is not None:
        covered = _sample_cells(height_above_ground, MACRO_PIXELS) > COVER_HEIGHT_M
        open_ground = ~ndimage.binary_dilation(covered, iterations=max(1, round(SHADOW_MARGIN_M / spacing)))
    brightness = north_up.mean(axis=0)
    reach = SHADE_REFERENCE_M / spacing
    green = surface.green(north_up) if north_up.shape[0] >= 3 else np.zeros(brightness.shape, dtype=bool)
    lit = open_ground
    # The shade itself drags down what counts as usual, so judge again against what was left in the light.
    for _ in range(SHADE_PASSES):
        usual, _ = _within(brightness, lit, reach)
        among_green, support = _within(brightness, lit & green, reach)
        usual = np.where(green & (support > OWN_CLASS_MIN), among_green, usual)
        lit = open_ground & (brightness >= SHADE_RATIO * usual)
    return north_up, open_ground, lit, filled


def build_surface(tile: Tile, crs: str, imagery: Path, out: Path, height_above_ground: np.ndarray | None) -> dict:
    """One weightmap per surface class, on the Landscape's vertices."""
    spacing = tile.size_m / MACRO_PIXELS
    north_up, _, lit, _ = _ground_view(tile, crs, imagery, height_above_ground)
    grass = surface.grass_fraction(north_up, lit, spacing)
    # From pixel centres to vertices, which start on the tile's edge.
    at = np.arange(tile.vertices) * tile.quad_m / spacing - 0.5
    rows, columns = np.meshgrid(at, at, indexing="ij")
    on_vertices = ndimage.map_coordinates(grass, [rows, columns], order=1, mode="nearest")
    layers = []
    for name, weight in surface.weights(on_vertices).items():
        Image.fromarray(frame.to_unreal_layout(weight)).save(out / f"weight_{name}.png")
        layers.append({"name": name, "file": f"weight_{name}.png", "fraction": float(weight.mean() / 255)})
    return {"files": [layer["file"] for layer in layers], "layers": layers, "classifier": "colour_threshold"}


def read_weight(out: Path, file: str, size: int) -> np.ndarray:
    """A class weight back from its weightmap, north-up, 0 to 1, at `size` samples a side."""
    weight = np.swapaxes(np.asarray(Image.open(out / file)), 0, 1)[::-1]
    return _sample_cells(weight, size).astype(np.float32) / 255


def build_macro_colour(
    tile: Tile, crs: str, imagery: Path, out: Path, height_above_ground: np.ndarray | None, layers: list[dict]
) -> dict:
    north_up, open_ground, lit, filled = _ground_view(tile, crs, imagery, height_above_ground)
    sigma = MACRO_LOW_PASS_M / (tile.size_m / MACRO_PIXELS)
    smooth = np.zeros_like(north_up)
    for band in range(north_up.shape[0]):
        # Sunlit ground of any class. Where none is within reach, deep under a wood or a large roof, the
        # nearest ground that has some stands in; cover and shade themselves never tint the map.
        sunlit, support = _within(north_up[band], lit, sigma)
        reached = support > OWN_CLASS_MIN
        if not reached.any():
            sunlit = ndimage.gaussian_filter(north_up[band], sigma, mode="nearest")
        elif not reached.all():
            nearest = ndimage.distance_transform_edt(~reached, return_distances=False, return_indices=True)
            sunlit = ndimage.gaussian_filter(sunlit[tuple(nearest)], sigma, mode="nearest")
        # Each class takes its colour from sunlit ground of its own class, so a road does not grey the
        # grass beside it. With none of its own within reach it takes the colour of any sunlit ground.
        for layer in layers:
            member = read_weight(out, layer["file"], MACRO_PIXELS)
            own, support = _within(north_up[band], member * lit, sigma)
            trust = np.clip(support / OWN_CLASS_MIN, 0.0, 1.0)
            smooth[band] += member * (own * trust + sunlit * (1 - trust))
    _write_rgb(smooth, out / "macro_colour.png")
    return {
        "file": "macro_colour.png",
        "pixels": MACRO_PIXELS,
        "low_pass_m": MACRO_LOW_PASS_M,
        "filled_fraction": filled,
        "covered_fraction": float(1 - open_ground.mean()),
        "shaded_fraction": float((open_ground & ~lit).mean()),
    }


def read_heights(out: Path, elevation: dict) -> np.ndarray:
    """The detailed surface back from its heightmap, north-up, in metres."""
    heights = np.asarray(Image.open(out / elevation["file"]))
    metres = frame.decode_heights(heights, elevation["mid_m"], elevation["z_scale"])
    return np.swapaxes(metres, 0, 1)[::-1]


def build_context(
    site: Site, dem: Path, imagery: Path, out: Path, detailed: np.ndarray, origin_height_m: float
) -> dict:
    """A coarse surround centred on the tile, so the detailed surface does not end in a cliff against the sky."""
    tile = site.tile
    spacing = site.context_size_m / CONTEXT_QUADS
    vertices = CONTEXT_QUADS + 1
    east, north = tile.centre
    west, top = east - site.context_size_m / 2, north + site.context_size_m / 2
    surround = _warp(dem, site.crs, west, top, spacing, vertices, Resampling.bilinear)[0]
    surround, filled = _fill_gaps(surround, "elevation")

    # Under the tile the surround must stay below the detailed surface. Take the lowest detailed height
    # within one coarse cell of each coarse vertex, and sink below that.
    reach = math.ceil(spacing / tile.quad_m)
    lowest = ndimage.minimum_filter(detailed, size=2 * reach + 1, mode="nearest")
    eastings = west + np.arange(vertices) * spacing
    northings = top - np.arange(vertices) * spacing
    columns = np.rint((eastings - tile.west) / tile.quad_m).astype(int)
    rows = np.rint((tile.north - northings) / tile.quad_m).astype(int)
    inside_c = (columns >= -reach) & (columns <= tile.quads + reach)
    inside_r = (rows >= -reach) & (rows <= tile.quads + reach)
    under = (
        lowest[np.ix_(np.clip(rows[inside_r], 0, tile.quads), np.clip(columns[inside_c], 0, tile.quads))]
        - CONTEXT_SINK_M
    )
    block = surround[np.ix_(inside_r, inside_c)]
    surround[np.ix_(inside_r, inside_c)] = np.minimum(block, under)

    heights, mid_m, z_scale = frame.encode_heights(surround)
    Image.fromarray(frame.to_unreal_layout(heights)).save(out / "context_heightmap.png")

    pixel = site.context_size_m / CONTEXT_MACRO_PIXELS
    colour = _warp(
        imagery, site.crs, west + pixel / 2, top - pixel / 2, pixel, CONTEXT_MACRO_PIXELS, Resampling.average
    )
    for band in range(colour.shape[0]):
        values, _ = _fill_gaps(colour[band], "imagery")
        colour[band] = ndimage.gaussian_filter(values, MACRO_LOW_PASS_M / pixel, mode="nearest")
    _write_rgb(colour, out / "context_colour.png")

    half_cm = site.context_size_m * 100 / 2
    return {
        "files": ["context_heightmap.png", "context_colour.png"],
        "heightmap": "context_heightmap.png",
        "colour": "context_colour.png",
        "vertices": vertices,
        "section_quads": LANDSCAPE_SECTION_QUADS,
        "sections_per_component": 1,
        "location_cm": [-half_cm, -half_cm, (mid_m - origin_height_m) * 100],
        "scale": [spacing * 100, spacing * 100, z_scale],
        "size_m": site.context_size_m,
        "sink_m": CONTEXT_SINK_M,
        "filled_fraction": filled,
    }


def georeference(site: Site, origin_height_m: float) -> dict:
    east, north = site.tile.centre
    lon, lat = transform(site.crs, "EPSG:4326", [east], [north])
    # Where true north points on the grid, measured from a point a little further north.
    probe_e, probe_n = transform("EPSG:4326", site.crs, [lon[0]], [lat[0] + 0.001])
    convergence = math.degrees(math.atan2(probe_e[0] - east, probe_n[0] - north))
    return {
        "crs": site.crs,
        "origin_easting_m": east,
        "origin_northing_m": north,
        "origin_latitude_deg": lat[0],
        "origin_longitude_deg": lon[0],
        "origin_height_m": origin_height_m,
        "vertical_datum": site.vertical_datum,
        "frame": frame.FRAME,
        "true_north_from_grid_north_deg": convergence,
    }


def _stage_key(*parts) -> str:
    return hashlib.sha256(json.dumps([PIPELINE_VERSION, *parts], sort_keys=True, default=str).encode()).hexdigest()


def _cached(out: Path, stage: str, key: str, compute) -> dict:
    """Run a stage unless its inputs are unchanged and its output file is still there."""
    record_path = out / f".{stage}.json"
    if record_path.is_file():
        record = json.loads(record_path.read_text())
        produced = record["result"].get("files", [record["result"].get("file")])
        if record["key"] == key and all((out / name).is_file() for name in produced):
            return record["result"] | {"cached": True}
    # Drop the old record first: if this run dies part-way, nothing claims the half-written output is current.
    record_path.unlink(missing_ok=True)
    result = compute()
    record_path.write_text(json.dumps({"key": key, "result": result}, indent=1))
    return result | {"cached": False}


def build(site_path: Path, out: Path, cache: Path | None = None) -> dict:
    """Run every stage for one site. Returns the manifest that was written to build.json."""
    site = load_site(site_path)
    tile = site.tile
    out.mkdir(parents=True, exist_ok=True)
    cache = cache or out / "cache"
    sources = acquire(site, cache)
    dem, imagery = Path(sources["elevation"]["path"]), Path(sources["imagery"]["path"])
    grid = [tile.west, tile.south, tile.quad_m, tile.quads]

    # The lidar's identity is cheap to get; its rasters are only built when a stage has to run.
    lidar_key = None
    if site.lidar:
        sources["lidar"] = lidar.identify(site.lidar, tile, site.crs, cache)
        lidar_key = sources["lidar"]["sha256"]
    structure = {}

    def rasters() -> tuple[np.ndarray | None, np.ndarray | None]:
        if site.lidar and not structure:
            structure["height"], structure["gap"] = read_structure(site, cache, dem)
        return structure.get("height"), structure.get("gap")

    stages = {}
    stages["elevation"] = _cached(
        out,
        "elevation",
        _stage_key(grid, site.crs, sources["elevation"]["sha256"], lidar_key, GAP_START_M, GAP_FULL_M, GAP_SMOOTH_M),
        lambda: build_elevation(tile, site.crs, dem, out, rasters()[1]),
    )
    elevation = stages["elevation"]
    # With lidar, cover is measured against the elevation model, so a new one changes the mask.
    cover_key = [lidar_key, sources["elevation"]["sha256"]] if lidar_key else None
    view_key = [
        grid,
        site.crs,
        sources["imagery"]["sha256"],
        cover_key,
        MACRO_PIXELS,
        COVER_HEIGHT_M,
        SHADOW_MARGIN_M,
        SHADE_RATIO,
        SHADE_REFERENCE_M,
        SHADE_PASSES,
    ]
    stages["surface"] = _cached(
        out,
        "surface",
        _stage_key(view_key, surface.CLASSES, surface.PARAMETERS),
        lambda: build_surface(tile, site.crs, imagery, out, rasters()[0]),
    )
    layers = stages["surface"]["layers"]
    stages["macro_colour"] = _cached(
        out,
        "macro_colour",
        _stage_key(
            view_key,
            MACRO_LOW_PASS_M,
            OWN_CLASS_MIN,
            [sha256_file(out / layer["file"]) for layer in layers],
        ),
        lambda: build_macro_colour(tile, site.crs, imagery, out, rasters()[0], layers),
    )
    macro = stages["macro_colour"]

    half_cm = tile.size_m * 100 / 2
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "site_id": site.site_id,
        "target_date": site.target_date,
        "seed": site.seed,
        "georeference": georeference(site, elevation["origin_height_m"]),
        "tile": {"west_m": tile.west, "south_m": tile.south, "size_m": tile.size_m, "quad_m": tile.quad_m},
        "landscape": {
            "heightmap": elevation["file"],
            "vertices": tile.vertices,
            "section_quads": LANDSCAPE_SECTION_QUADS,
            "sections_per_component": LANDSCAPE_SECTIONS_PER_COMPONENT,
            "components": tile.components,
            "location_cm": [-half_cm, -half_cm, (elevation["mid_m"] - elevation["origin_height_m"]) * 100],
            "scale": [tile.quad_m * 100, tile.quad_m * 100, elevation["z_scale"]],
            "min_m": elevation["min_m"],
            "max_m": elevation["max_m"],
            "filled_fraction": elevation["filled_fraction"],
            "smoothed_fraction": elevation["smoothed_fraction"],
        },
        "macro_colour": {
            key: macro[key]
            for key in ("file", "pixels", "low_pass_m", "filled_fraction", "covered_fraction", "shaded_fraction")
        },
        "surface": {"classifier": stages["surface"]["classifier"], "layers": layers},
        "stencil_classes": STENCIL_CLASSES,
        "sources": sources,
    }
    artifacts = [elevation["file"], macro["file"], *stages["surface"]["files"]]

    if site.context_size_m:
        context_dem, context_imagery = (
            Path(sources["context_elevation"]["path"]),
            Path(sources["context_imagery"]["path"]),
        )
        stages["context"] = _cached(
            out,
            "context",
            _stage_key(
                grid,
                site.crs,
                site.context_size_m,
                sources["context_elevation"]["sha256"],
                sources["context_imagery"]["sha256"],
                sha256_file(out / elevation["file"]),
                CONTEXT_SINK_M,
                CONTEXT_QUADS,
                CONTEXT_MACRO_PIXELS,
                MACRO_LOW_PASS_M,
            ),
            lambda: build_context(
                site, context_dem, context_imagery, out, read_heights(out, elevation), elevation["origin_height_m"]
            ),
        )
        context = stages["context"]
        manifest["context"] = {key: value for key, value in context.items() if key not in ("files", "cached")}
        artifacts += [context["heightmap"], context["colour"]]

    manifest["artifacts"] = {name: sha256_file(out / name) for name in artifacts}
    manifest["stages_reused"] = [name for name, stage in stages.items() if stage["cached"]]
    (out / "build.json").write_text(json.dumps(manifest, indent=1))
    return manifest
