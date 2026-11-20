"""Elevation, cover, colour, surround and manifest. Each stage reads artifacts and writes artifacts."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.errors import WindowError
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform, transform_bounds
from rasterio.windows import Window, from_bounds
from scipy import ndimage

from . import buildings, cover, frame, grain, lidar, light, orthophoto, surface, trees, turf
from .acquire import acquire, sha256_file
from .site import (
    CONTEXT_QUADS,
    LANDSCAPE_SECTION_QUADS,
    LANDSCAPE_SECTIONS_PER_COMPONENT,
    SCHEMA_VERSION,
    Site,
    SiteError,
    Source,
    Tile,
    acquisition_day,
    load_site,
)

# Part of every stage key. Bump it by hand when a code change alters a stage's output for the same
# inputs (frame.py and the resampling included); nothing detects that automatically.
PIPELINE_VERSION = 20

MACRO_PIXELS = 1024
# The fine detail: pixels across the tile (about half a metre, the imagery's own resolution) and the largest
# ratio it carries, as a power of two either way. 8 bits at 127 steps per power of two.
DETAIL_PIXELS = 2048
DETAIL_LOG2_RANGE = 1.0
DETAIL_ZERO = 127
DETAIL_FADE_CELLS = 2.0
# The survey orthophoto's low-pass runs on its pixels pooled to about this many metres (the imagery's own resolution).
SURVEY_POOL_M = 0.5
# The macro map carries colour that varies over tens of metres. Finer detail comes from the engine.
MACRO_LOW_PASS_M = 12.0
# A cell of a seasonal class takes the reflectance raster's own colour when pure pixels of it carry at least this much
# of the low-pass's weight around the cell; with less it keeps the photo's colour through the class's curve.
MEASURED_REACH_MIN = 0.05

# Where no ground return lies within GAP_START_M the elevation model was interpolated, usually as flat
# facets under roofs. Blend towards a smoothed surface, fully by GAP_FULL_M.
GAP_START_M = 3.0
GAP_FULL_M = 8.0
GAP_SMOOTH_M = 4.0

# Shadow in the photo, read from the photo (see build_detail). Darkness is looked at down to this many stops; a dark
# peak counts when one bin of it (after a three-bin mean) holds this share of the class's cells, of which there must be
# this many.
SHADOW_DARKEST_LOG2 = -3.0
SHADOW_BIN_LOG2 = 0.05
SHADOW_MIN_SHARE = 0.002
SHADOW_MIN_CELLS = 10000
# Shadow is a broad, low peak (penumbra, thin crowns), so the gap beside it is shallow: at most this share of it.
SHADOW_VALLEY_MAX = 0.8
SHADOW_EDGE_CELLS = 2

# A cell needs this share of sunlit ground within the low-pass's reach to take its colour from it.
SUNLIT_REACH_MIN = 0.05
# The colour map's low-pass runs on blocks this many cells across. A numerical shortcut, not a measurement.
POOL = 4

CONTEXT_MACRO_PIXELS = 512
# The surround passes under the tile; it sits this far below the detailed surface there so it never shows through.
CONTEXT_SINK_M = 1.0

# Stencil values the engine side writes into custom depth, for segmentation cameras.
STENCIL_CLASSES = {"ground": 1, "grass": 2, "tree": 3, "building": 4, "road": 5, "water": 6, "pad": 7}


def _warp(
    path: Path,
    crs: str,
    west: float,
    north: float,
    spacing: float,
    size: int,
    resampling: Resampling,
    bands: list[int] | None = None,
) -> np.ndarray:
    """Resample bands of a raster onto a north-up square grid whose first pixel centre is (west, north).

    `bands` are 1-based band numbers. Without them: RGB when there are at least three bands; otherwise the first
    band alone (grey, or grey plus alpha).
    """
    with rasterio.open(path) as source:
        bands = bands or list(range(1, (3 if source.count >= 3 else 1) + 1))
        out = np.full((len(bands), size, size), np.nan, dtype=np.float32)
        for index, band in enumerate(bands):
            reproject(
                rasterio.band(source, band),
                out[index],
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


def _on_grid(path: Path, crs: str, tile: Tile, resampling: Resampling) -> np.ndarray:
    """A raster's bands on the cover grid: north-up cells of lidar.CELL_M over the tile."""
    half = lidar.CELL_M / 2
    cells = round(tile.size_m / lidar.CELL_M)
    return _warp(path, crs, tile.west + half, tile.north - half, lidar.CELL_M, cells, resampling)


def _write_grid(values: np.ndarray, path: Path, crs: str, tile: Tile) -> None:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=values.shape[1],
        height=values.shape[0],
        count=1,
        dtype=values.dtype,
        crs=crs,
        transform=from_origin(tile.west, tile.north, lidar.CELL_M, lidar.CELL_M),
        compress="deflate",
    ) as file:
        file.write(values, 1)


def build_cover(
    site: Site,
    dem: Path,
    imagery: Path,
    canopy: Path | None,
    out: Path,
    lidar_height: np.ndarray | None,
    latitude_deg: float,
    longitude_deg: float,
    grid_north_offset_deg: float,
    roofs: np.ndarray | None = None,
) -> dict:
    """What stands over the ground, and its shadow in the imagery, as rasters any later stage can read.

    `roofs` marks the cells a building footprint touches: the ground there is hidden, so nothing is read from a roof.
    """
    tile = site.tile
    second = None
    if canopy:
        second, _ = _fill_gaps(_on_grid(canopy, site.crs, tile, Resampling.bilinear)[0], "canopy height")
    height, report = cover.combine(lidar_height, second)
    ground, _ = _fill_gaps(_on_grid(dem, site.crs, tile, Resampling.bilinear)[0], "elevation")
    brightness = _on_grid(imagery, site.crs, tile, Resampling.average)
    brightness = np.mean([_fill_gaps(band, "imagery")[0] for band in brightness], axis=0)
    sunlit, sun = cover.fit_sun(
        acquisition_day(site.imagery, "imagery"),
        latitude_deg,
        longitude_deg,
        grid_north_offset_deg,
        ground,
        height,
        report["cutoff_m"],
        brightness,
        lidar.CELL_M,
    )
    # Roofs the lidar saw are already hidden as cover; these are the roof cells that were still read as ground.
    roofs_read_as_ground = int((sunlit & roofs).sum()) if roofs is not None else 0
    if roofs is not None:
        sunlit = sunlit & ~roofs
    _write_grid(height, out / "canopy_height.tif", site.crs, tile)
    _write_grid(sunlit.astype(np.uint8), out / "sunlit.tif", site.crs, tile)
    return report | {
        "files": ["canopy_height.tif", "sunlit.tif"],
        "height": "canopy_height.tif",
        "sunlit": "sunlit.tif",
        "cell_m": lidar.CELL_M,
        "sources": [name for name, used in (("lidar", lidar_height is not None), ("canopy_height", canopy)) if used],
        "sunlit_fraction": float(sunlit.mean()),
        "roof_cells": int(roofs.sum()) if roofs is not None else 0,
        "roof_cells_read_as_ground_before": roofs_read_as_ground,
        "sun": sun,
    }


def build_trees(
    site: Site,
    cache: Path,
    dem: Path,
    imagery: Path,
    canopy: Path | None,
    out: Path,
    covering: dict,
    classes: dict,
    lidar_height: np.ndarray | None,
    footprints: list[dict] | None = None,
) -> dict:
    """Find every tree in the canopy heights and write the inventory the engine places trees from."""
    tile = site.tile
    cutoff = covering["cutoff_m"]
    with rasterio.open(out / covering["height"]) as file:
        height = file.read(1).astype(np.float32)
    ground, _ = _fill_gaps(_on_grid(dem, site.crs, tile, Resampling.bilinear)[0], "elevation")
    # Where each source shows cover (NaN where it does not look), and which source each cell's height came from.
    covers, seen_by, report = {}, {}, {}
    if site.survey:
        surface_m = _on_grid(Path(site.survey.location), site.crs, tile, Resampling.max)[0]
        terrain_m = _on_grid(Path(site.survey.terrain), site.crs, tile, Resampling.average)[0]
        inside = np.isfinite(surface_m) & np.isfinite(terrain_m)
        above = np.where(inside, surface_m - terrain_m, 0.0).astype(np.float32)
        # The survey's own terrain gives its heights above ground. How well that terrain sits on the elevation
        # model, on ground both call open, says how far the two frames can be trusted against each other.
        bare = inside & (above < cutoff) & (height < cutoff)
        if bare.any():
            difference = (terrain_m - ground)[bare]
            offset = float(np.median(difference))
            report["survey"] = {
                "footprint_fraction": float(inside.mean()),
                "terrain_minus_elevation_m": offset,
                "residual_m": float(1.4826 * np.median(np.abs(difference - offset))),
                "heights_from": "the survey's surface model minus its own terrain model",
                "cover_before_fraction": float((height > cutoff)[inside].mean()),
                "cover_fraction": float((above > cutoff)[inside].mean()),
            }
        # A surface model made from photographs taken from above misses crowns: on the first real tile it showed
        # under half the cover the lidar did, and not a row of trees its own photographs show. So it adds crowns
        # the older sources lack and removes none; a crown it does not show only loses confidence.
        adds = inside & (above > cutoff) & (height <= cutoff)
        height = np.where(adds, above, height)
        covers["survey"] = np.where(inside, above > cutoff, np.nan)
        seen_by["survey"] = adds
    if lidar_height is not None:
        covers["lidar"] = (lidar_height > cutoff).astype(np.float32)
        seen_by["lidar"] = lidar_height > cutoff
    if canopy:
        second, _ = _fill_gaps(_on_grid(canopy, site.crs, tile, Resampling.bilinear)[0], "canopy height")
        covers["canopy_height"] = (second > cutoff).astype(np.float32)
    seen_by["canopy_height" if canopy else "lidar"] = np.ones(height.shape, dtype=bool)

    # Roofs stand over the ground too. What the imagery shows as vegetation is canopy; the rest is not a tree.
    vegetated = np.ones(height.shape, dtype=bool)
    if classes["splits"] and classes["splits"][0]["split"]:
        bands, has_nir = imagery_bands(site.imagery)
        half = lidar.CELL_M / 2
        cells = height.shape[0]
        colour = _warp(
            imagery, site.crs, tile.west + half, tile.north - half, lidar.CELL_M, cells, Resampling.average, bands
        )
        colour = np.stack([_fill_gaps(band, "imagery")[0] for band in colour])
        vegetated = surface.apply_splits(colour[:3], colour[3] if has_nir else None, classes["splits"]) == 0
        report["canopy_is"] = "cover the imagery shows as vegetation"
    else:
        report["canopy_is"] = "prior: all cover, roofs included; the imagery has no vegetation split"
    labels, found = trees.crowns(height, (height > cutoff) & vegetated, lidar.CELL_M)
    closures, threshold = None, None
    if site.lidar and site.lidar.leaf_off and found:
        points = lidar.load_points(site.lidar, tile, site.crs, cache)
        closures = trees.closure(labels, found, *lidar.canopy_returns(points, tile, ground, cutoff))
        areas = np.array([crown["crown_radius_m"] ** 2 for crown in found])
        threshold, report["kind_fit"] = trees.split_kinds(closures, areas)
    mix = json.loads(Path(site.tree_mix.location).read_text()) if site.tree_mix else None
    records = trees.inventory(
        labels,
        found,
        seen_by,
        covers,
        lidar.CELL_M,
        tile.size_m,
        closures,
        threshold,
        mix["species"] if mix else None,
        site.seed,
    )
    narrow, report["not_trees"] = trees.too_narrow(found)
    dropped = trees.masts(narrow, records, len(covers))
    report["not_trees"]["dropped"] = sum(dropped)
    # A roof is canopy to a height map, and a tree stands at its crown's top: a crown topping out in a footprint is no tree.
    roofs = buildings.crowns_in_footprints(found, footprints or [], tile, lidar.CELL_M)
    report["not_trees"]["in_footprints"] = sum(roofs)
    records = [tree for tree, drop, roof in zip(records, dropped, roofs, strict=True) if not drop and not roof]
    if site.survey and site.survey.observations:
        from .observations import read
        evidence = read(Path(site.survey.observations), sha256_file(Path(site.survey.orthophoto)), site.crs)
        report["orthophoto"] = trees.refine_crowns(records, evidence, tile.centre)
    (out / "trees.json").write_text(
        json.dumps({"columns": trees.COLUMNS, "trees": [[tree[name] for name in trees.COLUMNS] for tree in records]})
    )
    count = lambda field: {
        str(value): sum(tree[field] == value for tree in records) for value in sorted({tree[field] for tree in records})
    }
    priors = [] if mix else ["prior: no species; no inventory mix in the site file"]
    if mix:
        priors.append("prior: each species is drawn from a regional inventory's mix by kind and height, not observed")
    if threshold is None:
        priors.append("prior: no tree's kind is measured; kinds follow the inventory's mix, or broadleaf without one")
    if footprints:
        priors.append("prior: a tree stands at its crown's top, so a crown whose top is in a footprint is not a tree")
    if "survey" in report:
        unseen = sum(tree["source"] != "survey" and tree["confidence"] < 1 for tree in records)
        report["survey"]["crowns_added"] = sum(tree["source"] == "survey" for tree in records)
        report["survey"]["crowns_with_a_source_that_does_not_see_them"] = unseen
    return report | {
        "files": ["trees.json"],
        "file": "trees.json",
        "count": len(records),
        "by_source": count("source"),
        "by_kind": count("kind"),
        "by_kind_from": count("kind_from"),
        "by_species": count("species") if mix else {},
        "height_m": [float(v) for v in np.quantile([t["height_m"] for t in records], (0.1, 0.5, 0.9))]
        if records
        else [],
        "species_from": mix["source"] if mix else None,
        "priors": priors,
        "settings": trees.SETTINGS,
    }


def build_buildings(
    site: Site,
    footprints: list[dict],
    imagery: Path,
    out: Path,
    classes: dict,
    lidar_height: np.ndarray | None,
) -> dict:
    """Measure every footprint's height and roof colour and write the inventory the engine builds massing from."""
    tile = site.tile
    bands, _ = imagery_bands(site.imagery)
    half = lidar.CELL_M / 2
    cells = round(tile.size_m / lidar.CELL_M)
    photo = _warp(
        imagery, site.crs, tile.west + half, tile.north - half, lidar.CELL_M, cells, Resampling.average, bands
    )
    photo = np.stack([_fill_gaps(band, "imagery")[0] for band in photo[:3]])
    albedo = classes["albedo"]
    curve = albedo.get("curves", {}).get(surface.PAVED)
    records = buildings.measure(footprints, tile, lidar.CELL_M, lidar_height, photo, curve, albedo["scale"])
    (out / "buildings.json").write_text(json.dumps({"buildings": records}, separators=(",", ":")))
    priors = [
        "prior: roofs are flat and every wall has one albedo; no source gives roof shape or facade colour",
        "prior: a roof's photo colour becomes albedo by the paved class's curve"
        if curve
        else "prior: a roof's photo colour becomes albedo by the global scale",
    ]
    by_height = buildings.sources_of(records)
    if any(kind in by_height for kind in ("prior", "measured")):
        priors.append(
            f"prior: buildings with no lidar and no tag take {buildings.FLOOR_M:g} m a floor or the tile's median"
        )
    return {
        "files": ["buildings.json"],
        "file": "buildings.json",
        "count": len(records),
        "height_from": by_height,
        "by_dataset": {
            str(name): sum(record["dataset"] == name for record in records)
            for name in sorted({str(record["dataset"]) for record in records})
        },
        "height_m": [float(v) for v in np.quantile([r["height_m"] for r in records], (0.1, 0.5, 0.9))]
        if records
        else [],
        "wall_albedo": buildings.WALL_ALBEDO,
        "roof_roughness": buildings.ROOF_ROUGHNESS,
        "priors": priors,
        "settings": buildings.SETTINGS,
    }


def open_ground(out: Path, covering: dict | None, size: int) -> np.ndarray:
    """Which of `size` by `size` north-up cells over the tile show sunlit ground: 1 where they do, else 0."""
    if covering is None:
        return np.ones((size, size), dtype=np.float32)
    with rasterio.open(out / covering["sunlit"]) as file:
        hidden = file.read(1) == 0
    # The imagery and the heights are registered to about a cell of each other, so the edge cell is not trusted.
    hidden = ndimage.binary_dilation(hidden)
    return (~_sample_cells(hidden, size)).astype(np.float32)


def standing_cover(out: Path, covering: dict | None, size: int, roofs: np.ndarray | None = None) -> np.ndarray | None:
    """Cells under something that stands over the ground: crowns as wide as the cover stage found them grown, and roofs."""
    if not covering:
        return None
    with rasterio.open(out / covering["height"]) as file:
        standing = file.read(1) > covering["cutoff_m"]
    spread = round(covering["sun"]["crown_spread_m"] / covering["cell_m"])
    if spread:
        standing = ndimage.binary_dilation(standing, structure=cover.disc(spread))
    if roofs is not None:
        standing = standing | roofs
    # The imagery and the heights are registered to about a cell of each other, so the edge cell is not trusted.
    return _sample_cells(ndimage.binary_dilation(standing), size)


def shadow_gap(darkness: np.ndarray) -> float | None:
    """The log2 darkness that separates ground in the sun from ground in shadow, or None when there is one peak.

    `darkness` is the log2 of each cell over its surround. Sunlit ground peaks at about 0 and shadow well below; the
    emptiest darkness between the two is the gap, when it holds at most SHADOW_VALLEY_MAX of the darker peak.
    """
    if darkness.size < SHADOW_MIN_CELLS:
        return None
    edges = np.arange(SHADOW_DARKEST_LOG2, 0.0001, SHADOW_BIN_LOG2)
    # What is darker than the floor is left out, not piled into the first bin, where it would pass for a peak.
    counts = np.histogram(darkness, bins=edges)[0].astype(float)
    counts = np.convolve(counts, np.ones(3) / 3, mode="same")
    # Only what is darker than the main peak is looked at: the gap lies between the shadow's peak and the sunlit one.
    # It is the darkness that is emptiest against the fullest one darker than it. With two dark peaks that is the gap
    # beside the larger of them, which need not be the one beside the sunlit peak.
    main = int(np.argmax(counts))
    least = SHADOW_MIN_SHARE * darkness.size
    darker = np.maximum.accumulate(counts[:main]) if main else counts[:0]
    if main < 3 or darker[-1] < least:
        return None
    valley = int(np.argmin(counts[:main] / np.maximum(darker, 1e-9) + (darker < least)))
    if darker[valley] < least or counts[valley] > SHADOW_VALLEY_MAX * darker[valley]:
        return None
    return float(edges[valley] + SHADOW_BIN_LOG2 / 2)


def _blur(values: np.ndarray, sigma: float) -> np.ndarray:
    """A Gaussian low-pass over the last two axes: one image, or a stack of bands."""
    return ndimage.gaussian_filter(values, (0,) * (values.ndim - 2) + (sigma, sigma), mode="nearest")


def _low_pass_pooled(values: np.ndarray, sunlit: np.ndarray, sigma: float) -> np.ndarray:
    """The low-pass itself.

    Deep inside a wood or under a large roof no sunlit ground is within
    the low-pass's reach; the nearest ground that has some stands in. What hides the ground never tints the result.
    """
    support = _blur(sunlit, sigma)
    smooth = _blur(values * sunlit, sigma) / np.maximum(support, 1e-6)
    reached = support > SUNLIT_REACH_MIN
    if not reached.any():
        return _blur(values, sigma)
    if reached.all():
        return smooth
    nearest = ndimage.distance_transform_edt(~reached, return_distances=False, return_indices=True)
    # Nearest-cell copies meet along straight seams; a wider low-pass takes them out of what is only a stand-in.
    stand_in = _blur(smooth[..., nearest[0], nearest[1]], 4 * sigma)
    trust = np.clip(support / SUNLIT_REACH_MIN, 0.0, 1.0)
    return smooth * trust + stand_in * (1 - trust)


def _low_pass_of_sunlit(values: np.ndarray, sunlit: np.ndarray, sigma: float) -> np.ndarray:
    """A low-pass that only listens to sunlit ground, so cover and shadow take their colour from the ground around them.

    `values` is one image or a stack of bands, and `sunlit` weights each cell, 0 to 1. A low-pass this wide only
    shows detail many cells across, so it is computed on blocks of POOL cells and brought back by interpolation.
    """
    size = sunlit.shape[0]
    pool = POOL if size % POOL == 0 and sunlit.shape[1] % POOL == 0 else 1
    if pool == 1:
        return _low_pass_pooled(values, sunlit, sigma)

    def blocks(array: np.ndarray) -> np.ndarray:
        rows, columns = array.shape[-2] // pool, array.shape[-1] // pool
        return array.reshape(*array.shape[:-2], rows, pool, columns, pool).mean(axis=(-3, -1))

    # Pooling the weighted values and the weights separately keeps the ratio a weighted mean.
    pooled = _low_pass_pooled(blocks(values * sunlit) / np.maximum(blocks(sunlit), 1e-6), blocks(sunlit), sigma / pool)
    return ndimage.zoom(pooled, (1,) * (pooled.ndim - 2) + (pool, pool), order=1, mode="nearest", grid_mode=True)


def imagery_bands(source: Source) -> tuple[list[int] | None, bool]:
    """Which bands to read for red, green, blue and, when the site names one, near-infrared. And whether it does."""
    if not source.bands:
        return None, False
    nir = source.band("nir")
    return [source.band("red"), source.band("green"), source.band("blue")] + ([nir] if nir else []), bool(nir)


def _onto_raster(values: np.ndarray, tile: Tile, crs: str, like: rasterio.DatasetReader, window) -> np.ndarray:
    """The mean of cells on the tile's vertices (north-up) over each pixel of a window of another raster."""
    out = np.full((round(window.height), round(window.width)), np.nan, dtype=np.float32)
    reproject(
        values.astype(np.float32),
        out,
        src_transform=from_origin(tile.west - tile.quad_m / 2, tile.north + tile.quad_m / 2, tile.quad_m, tile.quad_m),
        src_crs=crs,
        dst_transform=like.window_transform(window),
        dst_crs=like.crs,
        dst_nodata=np.nan,
        resampling=Resampling.average,
    )
    return out


def fit_to_reflectance(
    site: Site, reflectance: Path, rgb: np.ndarray, labels: np.ndarray, shown: np.ndarray, names: list[str]
) -> dict:
    """Bring the photo, the classes and the sunlit ground onto the reflectance raster's pixels and fit to them."""
    tile = site.tile
    with rasterio.open(reflectance) as file:
        west, south, east, north = transform_bounds(site.crs, file.crs, *tile.bounds())
        # Whole pixels only; a part pixel at the east or south edge is left out. The pixels must be coarser than
        # the tile's cells, or the means below are of nothing.
        window = from_bounds(west, south, east, north, file.transform).round_offsets().round_lengths()
        try:
            window = window.intersection(Window(0, 0, file.width, file.height))
        except WindowError:
            raise SiteError("sources.reflectance: the raster has no usable pixels over the tile") from None
        bands = [site.reflectance.band(name) for name in ("red", "green", "blue")]
        measured = file.read(bands, window=window, masked=True).astype(np.float32).filled(np.nan)
        sunlit = _onto_raster(shown, tile, site.crs, file, window)
        linear = surface.to_linear(rgb[:3])
        photo = np.stack([_onto_raster(band * shown, tile, site.crs, file, window) for band in linear])
        photo /= np.maximum(sunlit, 1e-6)
        shares = np.stack([_onto_raster(labels == index, tile, site.crs, file, window) for index in range(len(names))])
    flat = lambda array: array.reshape(*array.shape[:-2], -1)
    try:
        return surface.fit_reflectance(flat(photo), flat(measured), flat(shares), flat(sunlit), names)
    except ValueError as error:
        raise SiteError(f"sources.reflectance: {error}") from error


def build_surface(
    site: Site,
    imagery: Path,
    out: Path,
    covering: dict | None,
    reflectance: Path | None,
    roofs: np.ndarray | None = None,
    ortho: dict | None = None,
) -> dict:
    """Classify the ground and write one 8-bit weightmap per class, on the Landscape's vertices."""
    tile = site.tile
    for stale in out.glob("surface_*.png"):
        stale.unlink()
    bands, has_nir = imagery_bands(site.imagery)
    rgb = _warp(imagery, site.crs, tile.west, tile.north, tile.quad_m, tile.vertices, Resampling.average, bands)
    rgb = np.stack([_fill_gaps(band, "imagery")[0] for band in rgb])
    nir = rgb[3] if has_nir else None
    rgb = rgb[:3]
    shown = open_ground(out, covering, tile.vertices) > 0
    labels, names, fit = surface.classify(rgb, shown, tile.quad_m, nir)
    if roofs is not None:
        # The ground under a roof is the class of the ground around it: the roof's own colour is not ground.
        labels = buildings.label_under(labels, _sample_cells(roofs, tile.vertices))
        fit["priors"].append("prior: the ground under a building is the class of the nearest ground not under one")
    weights = surface.weights(labels, len(names), tile.quad_m)
    fallback_weights = None
    if ortho and "raster" in ortho:
        fallback_weights = "surface_fallback.png"
        fallback = np.stack([weights[names.index(name)] if name in names else np.zeros_like(labels)
                             for name in orthophoto.NAMES])
        _write_rgb(fallback, out / fallback_weights)
        weights, expanded = orthophoto.blend(
            np.asarray(weights, dtype=np.float32) / 255, names,
            orthophoto.sample(out / ortho["raster"], tile, site.crs, tile.vertices,
                              out / ortho["colour_raster"]),
        )
        labels = np.array([expanded.index(name) for name in names], dtype=np.uint8)[labels]
        names = expanded
        weights = np.rint(weights * 255).astype(np.uint8)
    layers, unreal = [], []
    for name, weight in zip(names, weights, strict=True):
        file = f"surface_{name}.png"
        unreal.append(frame.to_unreal_layout(weight))
        Image.fromarray(unreal[-1]).save(out / file)
        layers.append({"name": name, "file": file, "mean_weight": float(weight.mean()) / 255})
    luminance = surface.class_luminance(rgb, labels, shown, names)
    if reflectance:
        albedo = fit_to_reflectance(site, reflectance, rgb, labels, shown, names)
        albedo["reflectance_date"] = site.reflectance.date
    else:
        albedo = surface.fit_albedo(luminance)
    for layer in layers:
        if layer["name"] in albedo.get("curves", {}):
            # The colour the engine gives what grows on the class: the measured one when there is a measurement.
            layer["mean_linear_rgb"] = albedo["curves"][layer["name"]]["median_reflectance"]
        elif layer["name"] in luminance:
            layer["mean_linear_rgb"] = luminance[layer["name"]]["mean_linear_rgb"]
    return {
        "files": [layer["file"] for layer in layers] + ([fallback_weights] if fallback_weights else []),
        "fallback_weights": fallback_weights,
        "layers": layers,
        "check_points": surface.check_points(unreal, names),
        "vertices": tile.vertices,
        "albedo": albedo,
        **fit,
    }


def clean_ortho_colour(rgb: np.ndarray, shown: np.ndarray, own: np.ndarray, cell_m: float) -> tuple[np.ndarray, dict]:
    """Replace crowns and survey shadows with the class's surrounding sunlit ground colour."""
    photo = surface.to_linear(rgb.astype(np.float32))
    sigma = MACRO_LOW_PASS_M / cell_m

    def smooth(open_cells):
        fallback = _low_pass_of_sunlit(photo, open_cells.astype(np.float32), sigma)
        result = fallback.copy()
        for index in range(3):
            visible = open_cells & (own == index)
            if visible.any():
                passed = _low_pass_of_sunlit(photo, visible.astype(np.float32), sigma)
                result[:, own == index] = passed[:, own == index]
        return result

    passed = smooth(shown)
    darkness = np.log2(np.maximum(surface.luminous(photo), 1e-4) / np.maximum(surface.luminous(passed), 1e-4))
    shadows = {}
    visible = shown.copy()
    for index, name in enumerate(orthophoto.NAMES):
        if name not in surface.SEASONAL:
            continue
        mine = (own == index) & shown
        # A uniformly lit field can sit just above zero because its own shadow lowered the mean.
        # Centre the sunlit peak inside shadow_gap's negative-stop histogram before fitting it.
        centre = float(np.median(darkness[mine])) + SHADOW_BIN_LOG2 if mine.any() else 0.0
        gap = shadow_gap(darkness[mine] - centre)
        if gap is not None:
            gap += centre
            dark = mine & (darkness < gap)
            visible &= ~ndimage.binary_dilation(dark, iterations=SHADOW_EDGE_CELLS)
            shadows[name] = {"gap_log2": gap, "shadow_fraction": float(dark.sum() / max(1, mine.sum()))}
    if shadows:
        passed = smooth(visible)
    photo_luma = surface.luminous(photo)
    macro_luma = surface.luminous(passed)
    chroma = photo * (macro_luma / np.maximum(photo_luma, 1e-4))[None]
    saturation = np.minimum(1, (1 - macro_luma) / np.maximum(chroma.max(axis=0) - macro_luma, 1e-4))
    chroma = macro_luma[None] + (chroma - macro_luma[None]) * saturation[None]
    # Fine luminance comes from survey_detail; retain hue without applying that brightness signal twice.
    trusted = (visible & (photo_luma > 1e-4)
               & (photo_luma >= macro_luma * 2 ** orthophoto.SETTINGS["chroma_shadow_min_log2"]))
    colour = np.where(trusted[None], chroma, passed)
    return surface.to_encoded(colour), {
        "low_pass_m": MACRO_LOW_PASS_M, "open_fraction": float(visible.mean()), "shadows": shadows,
        "chroma_cell_m": cell_m, "chroma_fraction": float(trusted.mean()),
        "chroma_shadow_min_log2": orthophoto.SETTINGS["chroma_shadow_min_log2"],
        "source": "class-specific low-pass luminance and visible pooled survey chroma in linear light",
    }


def build_orthophoto(site: Site, imagery: Path, out: Path, covering: dict | None,
                     roofs: np.ndarray | None) -> dict:
    tile = site.tile
    bands, has_nir = imagery_bands(site.imagery)
    rgb = _warp(imagery, site.crs, tile.west, tile.north, tile.quad_m, tile.vertices, Resampling.average, bands)
    rgb = np.stack([_fill_gaps(band, "imagery")[0] for band in rgb])
    shown = open_ground(out, covering, tile.vertices) > 0
    labels, names, _ = surface.classify(rgb[:3], shown, tile.quad_m, rgb[3] if has_nir else None)
    height = np.zeros(labels.shape, dtype=np.float32)
    if covering:
        with rasterio.open(out / covering["height"]) as source:
            height = _sample_cells(source.read(1), tile.vertices)
    # The survey and the older imagery have different crowns and sun. Use the survey's own heights,
    # and let its photo supply shadows; the older sunlit raster would remove the wrong ground.
    survey_surface = _warp(Path(site.survey.location), site.crs, tile.west, tile.north,
                           tile.quad_m, tile.vertices, Resampling.max)[0]
    survey_ground = _warp(Path(site.survey.terrain), site.crs, tile.west, tile.north,
                          tile.quad_m, tile.vertices, Resampling.average)[0]
    inside = np.isfinite(survey_surface) & np.isfinite(survey_ground)
    height = np.where(inside, np.maximum(survey_surface - survey_ground, 0), height)
    evidence = None
    if site.survey.observations:
        from .observations import read
        evidence = read(Path(site.survey.observations), sha256_file(Path(site.survey.orthophoto)), site.crs)
        # A photo DSM can miss a crown explicitly seen in the ortho. Retain older height evidence there.
        if covering:
            with rasterio.open(out / covering["height"]) as source:
                older = _sample_cells(source.read(1), tile.vertices)
            east = tile.west + np.arange(tile.vertices) * tile.quad_m
            north = tile.north - np.arange(tile.vertices) * tile.quad_m
            for feature in evidence["features"]:
                if feature["feature_type"] != "individual_tree_crown" or feature["confidence"] < 0.8:
                    continue
                west, south, right, top = feature["bounds_projected_m"]
                region = ((east[None] >= west) & (east[None] <= right)
                          & (north[:, None] >= south) & (north[:, None] <= top))
                height = np.where(region, np.maximum(height, older), height)
    shown = height < orthophoto.SETTINGS["canopy_min_m"]
    if evidence:
        from .observations import non_tree_features

        east = tile.west + np.arange(tile.vertices) * tile.quad_m
        north = tile.north - np.arange(tile.vertices) * tile.quad_m
        for feature in non_tree_features(evidence):
            west, south, right, top = feature["bounds_projected_m"]
            region = ((east[None] >= west) & (east[None] <= right)
                      & (north[:, None] >= south) & (north[:, None] <= top))
            shown &= ~region
            height = np.where(region, 0, height)
    if roofs is not None:
        roof_cells = _sample_cells(roofs, tile.vertices)
        labels = buildings.label_under(labels, roof_cells)
        shown &= ~roof_cells
        height = np.where(roof_cells, 0, height)
    return orthophoto.build(Path(site.survey.orthophoto), out, tile, site.crs, labels, names,
                            height, shown, clean_ortho_colour, evidence)


def read_weights(out: Path, layers: list[dict]) -> np.ndarray:
    """The class weights back from their files, north-up, as shares that sum to 1: (classes, rows, columns)."""
    weights = [np.swapaxes(np.asarray(Image.open(out / layer["file"])), 0, 1)[::-1] for layer in layers]
    return np.stack(weights).astype(np.float32) / 255


def build_macro_colour(
    tile: Tile,
    crs: str,
    imagery: Path,
    out: Path,
    covering: dict | None,
    layers: list[dict],
    bands: list[int] | None = None,
    curves: dict | None = None,
    reflectance: Path | None = None,
    reflectance_bands: list[int] | None = None,
) -> dict:
    """The colour that varies over tens of metres. With `curves` it is written as albedo, class by class.

    A class's curve turns the photo's pattern into albedo at the measured level. The photo is of another year, and
    what grows has changed since: over grass the curve is nearly flat, so every field comes out the class's one
    colour. With `reflectance`, a seasonal class takes the measurement's own colour pixel by pixel instead, wherever
    pixels that are purely that class in sunlight are in reach, and the photo's pattern only between them.
    """
    spacing = tile.size_m / MACRO_PIXELS
    north_up = _warp(
        imagery,
        crs,
        tile.west + spacing / 2,
        tile.north - spacing / 2,
        spacing,
        MACRO_PIXELS,
        Resampling.average,
        bands[:3] if bands else None,
    )
    sigma = MACRO_LOW_PASS_M / spacing
    sunlit = open_ground(out, covering, MACRO_PIXELS)
    shares = np.stack([_sample_cells(share, MACRO_PIXELS) for share in read_weights(out, layers)])
    values = np.empty_like(north_up)
    filled = 0.0
    for band in range(north_up.shape[0]):
        values[band], fraction = _fill_gaps(north_up[band], "imagery")
        filled = max(filled, fraction)
    # Each class is low-passed from its own sunlit ground only, so a road never greys the grass beside it.
    # The class edge is soft for the engine, but the ground each low-pass listens to is the class's own cells only.
    own = np.argmax(shares, axis=0)
    passed = [_low_pass_of_sunlit(values, sunlit * (own == index), sigma) for index in range(len(shares))]
    measured = {}
    if curves:
        by_class = [
            surface.apply_curve(colour, curves[layer["name"]]) for colour, layer in zip(passed, layers, strict=True)
        ]
        for index, layer in enumerate(layers):
            if reflectance and layer["name"] in surface.SEASONAL:
                by_class[index], measured[layer["name"]] = _measured_colour(
                    by_class[index], shares[index], sunlit, tile, crs, reflectance, reflectance_bands, sigma * spacing
                )
        albedo = sum(share * colour for share, colour in zip(shares, by_class, strict=True))
        smooth = surface.to_encoded(albedo)
    else:
        smooth = sum(share * colour for share, colour in zip(shares, passed, strict=True))
    _write_rgb(smooth, out / "macro_colour.png")
    return {
        "file": "macro_colour.png",
        "pixels": MACRO_PIXELS,
        "low_pass_m": MACRO_LOW_PASS_M,
        "filled_fraction": filled,
        "hidden_fraction": float(1 - sunlit.mean()),
        "measured": measured,
        "priors": [
            f"prior: {', '.join(surface.SEASONAL)} changes with the season, so it takes the reflectance raster's colour pixel by pixel; other classes keep the photo's pattern",
            f"prior: a cell is in reach of the measurement with {MEASURED_REACH_MIN:.0%} of the low-pass's weight on pure pixels",
        ]
        if measured
        else [],
    }


def _measured_colour(
    fitted: np.ndarray,
    share: np.ndarray,
    sunlit: np.ndarray,
    tile: Tile,
    crs: str,
    reflectance: Path,
    bands: list[int] | None,
    low_pass_m: float,
) -> tuple[np.ndarray, dict]:
    """One class's albedo (3, n, n, north-up over the tile) moved onto the reflectance raster's own colour.

    On the raster's pixels: the measured colour over the fitted colour, where the pixel is purely this class in
    sunlight. That ratio is low-passed over the pure pixels only (a mixed pixel says nothing about the class) and
    read back on the map's cells; a cell with no pure pixel in reach keeps the fitted colour.
    """
    size = fitted.shape[-1]
    cell = tile.size_m / size
    grid = from_origin(tile.west, tile.north, cell, cell)
    with rasterio.open(reflectance) as file:
        west, south, east, north = transform_bounds(crs, file.crs, *tile.bounds())
        window = from_bounds(west, south, east, north, file.transform).round_offsets().round_lengths()
        window = window.intersection(Window(0, 0, file.width, file.height))
        value = file.read(bands or [1, 2, 3], window=window, masked=True).astype(np.float32).filled(np.nan)
        there, there_crs = file.window_transform(window), file.crs
        pixel_m = float(abs(file.transform.a))

    def onto(values: np.ndarray) -> np.ndarray:
        out = np.full(value.shape[1:], np.nan, dtype=np.float32)
        reproject(
            values.astype(np.float32),
            out,
            src_transform=grid,
            src_crs=crs,
            dst_transform=there,
            dst_crs=there_crs,
            dst_nodata=np.nan,
            resampling=Resampling.average,
        )
        return out

    own, lit = onto(share), onto(sunlit)
    model = np.stack([onto(band) for band in fitted])
    pure = (own >= surface.PURE_SHARE) & (lit >= surface.PURE_SUNLIT)
    pure &= np.isfinite(value).all(axis=0) & (value > 0).all(axis=0) & np.isfinite(model).all(axis=0)
    weight = pure.astype(np.float32)
    log_ratio = np.where(pure, np.log(np.maximum(value, 1e-6) / np.maximum(model, 1e-6)), 0.0)
    sigma = low_pass_m / pixel_m
    support = _blur(weight, sigma)
    smooth = _blur(log_ratio * weight, sigma) / np.maximum(support, 1e-6)
    trust = np.clip(support / MEASURED_REACH_MIN, 0.0, 1.0)
    # Zero is no correction and no trust: what the raster does not reach keeps the fitted colour.
    back = np.zeros((4, size, size), dtype=np.float32)
    for index, band in enumerate([*(smooth * trust), trust]):
        reproject(
            band.astype(np.float32),
            back[index],
            src_transform=there,
            src_crs=there_crs,
            dst_transform=grid,
            dst_crs=crs,
            resampling=Resampling.bilinear,
        )
    mine = share > 0.5
    return fitted * np.exp(back[:3]), {
        "pure_pixels": int(pure.sum()),
        "pixel_m": pixel_m,
        "share_of_class_in_reach": float((back[3][mine] >= 1).mean()) if mine.any() else 0.0,
        "reach_min": MEASURED_REACH_MIN,
    }


def build_detail(
    tile: Tile,
    crs: str,
    imagery: Path,
    out: Path,
    covering: dict | None,
    layers: list[dict],
    bands: list[int] | None = None,
    roofs: np.ndarray | None = None,
) -> dict:
    """What the photo shows finer than the macro colour: each pixel over the class's own smooth colour around it.

    The macro colour is a 12 m low-pass, so mowing rows, tyre tracks, lot markings and patches of straw are gone from
    it. The ratio of the photo, in linear light, to that same low-pass puts them back without moving the albedo: it is
    about 1 on average, and 1 wherever cover or shadow hides the ground, because the engine draws those. The albedo
    curves are not applied to it: their gamma (0.33 for grass) is fitted across 10 m pixels, where noise in the photo
    flattens the slope, and would take most of the contrast out of what the photo shows between neighbouring cells.
    """
    spacing = tile.size_m / DETAIL_PIXELS
    north_up = _warp(
        imagery,
        crs,
        tile.west + spacing / 2,
        tile.north - spacing / 2,
        spacing,
        DETAIL_PIXELS,
        Resampling.average,
        bands[:3] if bands else None,
    )
    photo = surface.to_linear(np.stack([_fill_gaps(band, "imagery")[0] for band in north_up]))
    open_cells = open_ground(out, covering, DETAIL_PIXELS)
    shares = np.stack([_sample_cells(share, DETAIL_PIXELS) for share in read_weights(out, layers)])
    own = np.argmax(shares, axis=0)
    sigma = MACRO_LOW_PASS_M / spacing

    def smoothed(open_to: np.ndarray) -> np.ndarray:
        smooth = np.empty_like(photo)
        for index in range(len(layers)):
            mine = own == index
            smooth[:, mine] = _low_pass_of_sunlit(photo, open_to * mine, sigma)[:, mine]
        return smooth

    smooth = smoothed(open_cells)
    # The cast shadow the cover stage predicts depends on a fitted time of day, and thin things (poles, wires) are
    # not in it at all. On a seasonal class the photo shows its own shadows: the ratio has a second, dark peak. What
    # is darker than the gap between the two peaks is shadow, and nothing standing has to explain it; what the
    # cover stage only predicted to be in shadow and is not that dark is ground in the sun.
    shadows = {}
    standing = standing_cover(out, covering, DETAIL_PIXELS, roofs)
    for index, layer in enumerate(layers):
        if layer["name"] not in surface.SEASONAL or standing is None:
            continue
        mine = (own == index) & ~standing
        darkness = np.log2(np.maximum(surface.luminous(photo), 1e-4) / np.maximum(surface.luminous(smooth), 1e-4))
        gap = shadow_gap(darkness[mine])
        if gap is None:
            continue
        dark = mine & (darkness < gap)
        before = float((open_cells[mine] > 0).mean())
        open_cells = np.where(
            mine, ~ndimage.binary_dilation(dark, iterations=SHADOW_EDGE_CELLS), open_cells > 0
        ).astype(open_cells.dtype)
        shadows[layer["name"]] = {
            "gap_log2": gap,
            "in_shadow": float(dark[mine].mean()),
            "open_before": before,
            "open_after": float(open_cells[mine].mean()),
        }
    if shadows:
        smooth = smoothed(open_cells)
    ratio = np.maximum(photo, 1e-4) / np.maximum(smooth, 1e-4)
    # Where the ground is hidden the ratio is 1, fading in over a few cells so no seam shows at a crown's edge.
    # A hidden cell is 1 exactly, however thin the thing that hides it: the fade is on the open side of the edge only.
    trust = np.minimum(_blur(open_cells, DETAIL_FADE_CELLS), open_cells)
    log_ratio = np.clip(np.log2(ratio) * trust, -DETAIL_LOG2_RANGE, DETAIL_LOG2_RANGE)
    _write_rgb(DETAIL_ZERO + DETAIL_ZERO * log_ratio / DETAIL_LOG2_RANGE, out / "detail_ratio.png")
    return {
        "file": "detail_ratio.png",
        "pixels": DETAIL_PIXELS,
        "log2_range": DETAIL_LOG2_RANGE,
        "zero": DETAIL_ZERO,
        "low_pass_m": MACRO_LOW_PASS_M,
        "open_fraction": float(open_cells.mean()),
        "priors": [
            "prior: the imagery's tone curve is sRGB, so its ratio is a ratio of linear light",
            "prior: living turf is nowhere as dark against the turf around it as its own shadow is; paving can be",
            f"prior: a shadow's edge is {SHADOW_EDGE_CELLS} cells wider than its dark core",
            f"prior: shadow is looked for down to {SHADOW_DARKEST_LOG2:g} stops in bins of {SHADOW_BIN_LOG2:g}, averaged over three; its peak holds {SHADOW_MIN_SHARE:.1%} of at least {SHADOW_MIN_CELLS} cells in one bin, and the gap at most {SHADOW_VALLEY_MAX:g} of the peak",
            f"prior: the ratio is limited to a factor of {2**DETAIL_LOG2_RANGE:g} either way",
            f"prior: the ratio fades to 1 over {DETAIL_FADE_CELLS:g} cells at the edge of hidden ground",
        ],
        "ratio_p5_p95": [float(2 ** np.percentile(log_ratio, 5)), float(2 ** np.percentile(log_ratio, 95))],
        "shadows": shadows,
    }


def build_grain(site: Site, out: Path, layers: list[dict]) -> dict:
    """The centimetre-scale texture of grass, measured from the survey's orthophoto (see grain.py)."""
    names = [layer["name"] for layer in layers]
    if "grass" not in names:
        return {"files": [], "skipped": "the tile has no grass class"}
    tile = site.tile
    shares = read_weights(out, layers)
    measured, reason = grain.measure(
        Path(site.survey.orthophoto),
        site.crs,
        tile.west,
        tile.north,
        tile.size_m,
        shares[names.index("grass")],
        site.seed,
    )
    if measured is None:
        return {"files": [], "skipped": reason}
    Image.fromarray(measured.encoded, mode="L").save(out / "grain.png")
    return {
        "file": "grain.png",
        "pixels": grain.PIXELS,
        "pixel_m": measured.pixel_m,
        "repeat_m": measured.pixel_m * grain.PIXELS,
        "sharp_distance_m": grain.sharp_distance_m(measured.pixel_m),
        "near_share": grain.NEAR_SHARE,
        "log2_range": grain.LOG2_RANGE,
        "zero": grain.ZERO,
        "std_log2": measured.std_log2,
        "blocks_used": measured.blocks_used,
        "blocks_seen": measured.blocks_seen,
        "block_std_range": list(measured.block_std_range),
        "tint": list(measured.tint),
        "tint_explains": list(measured.tint_explains),
        "blade_colours": [list(colour) for colour in measured.blade_colours],
        "low_pass_m": grain.LOW_PASS_M,
        "priors": grain.PRIORS,
    }


def build_growth(site: Site, out: Path, layers: list[dict], detail: dict, elevation: dict, covering: dict | None,
                 ortho: dict | None = None, fallback_weights: str | None = None) -> dict:
    """A shared growth map for Landscape placement and blade height, in the tile's engine layout."""
    pixels = detail["pixels"]
    grass = _sample_cells(read_weights(out, layers)[[layer["name"] for layer in layers].index("grass")], pixels)
    if ortho and "raster" in ortho:
        fallback = np.asarray(Image.open(out / fallback_weights)).swapaxes(0, 1)[::-1, :, 0].astype(np.float32) / 255
        native = orthophoto.sample(out / ortho["raster"], site.tile, site.crs, pixels,
                                  out / ortho["colour_raster"])
        coverage = np.clip(native[:3].sum(axis=0), 0, 1)
        grass = native[0] + _sample_cells(fallback, pixels) * (1 - coverage)
    encoded = np.asarray(Image.open(out / detail["file"])).swapaxes(0, 1)[::-1]
    ratio = (np.moveaxis(encoded.astype(np.float32), -1, 0) - detail["zero"]) * detail["log2_range"] / detail["zero"]
    if ortho and "raster" in ortho:
        spacing = site.tile.size_m / pixels
        photo = _warp(Path(site.survey.orthophoto), site.crs, site.tile.west + spacing / 2,
                      site.tile.north - spacing / 2, spacing, pixels, Resampling.average, [1, 2, 3])
        colour = np.log2(np.maximum(np.nan_to_num(photo, nan=0), 1) / 255)
        # Relative G/R drives growth; the camera's absolute tint never becomes the blade's albedo.
        ratio = ratio * (1 - coverage[None]) + colour * coverage[None]
    height = np.asarray(Image.open(out / elevation["file"])).swapaxes(0, 1)[::-1].astype(np.float32)
    ground = _sample_cells(height, pixels) * elevation["z_scale"] / 12800
    canopy = np.zeros(grass.shape, dtype=np.float32)
    if covering:
        with rasterio.open(out / covering["height"]) as source:
            canopy = _sample_cells(source.read(1), pixels)
    packed, report = turf.growth(grass, ratio, canopy, ground, site.tile.size_m / pixels, site.seed)
    _write_rgb(packed * 255, out / "turf_growth.png")
    return {"file": "turf_growth.png", "files": ["turf_growth.png"], "pixels": pixels, **report}


def build_survey_detail(site: Site, out: Path, covering: dict | None, layers: list[dict],
                        ortho: dict | None = None) -> dict:
    """The detail ratio again, from the survey's orthophoto at its own pixel size, where its footprint is.

    The same ratio as build_detail's (luminance of each pixel over the class's own 12 m low-pass of sunlit ground, in
    linear light, a power of two, one stop either way, with zero weight where cover hides the ground), but a centimetre a pixel, and of
    luminance only: RGB stores the same log ratio, premultiplied by the detail weight in alpha. Missing or rejected
    samples have neutral RGB and zero weight, so filtering does not invent contrast. Inside the
    footprint it replaces the imagery's ratio, which is the same ground a year or two earlier at half a metre.
    """
    tile = site.tile
    shares = np.stack([_sample_cells(share, DETAIL_PIXELS) for share in read_weights(out, layers)])
    own = np.argmax(shares, axis=0)
    open_cells = open_ground(out, covering, DETAIL_PIXELS)
    cell_m = tile.size_m / DETAIL_PIXELS
    with rasterio.Env(GDAL_CACHEMAX=orthophoto.SETTINGS["gdal_cache_mb"] * 1024**2), \
            rasterio.open(site.survey.orthophoto) as source:
        if str(source.crs) != site.crs or source.count < 4:
            return {"files": [], "skipped": "the orthophoto is not in the site's CRS with an alpha band"}
        pixel_m = float(abs(source.transform.a))
        left, top = source.transform.c, source.transform.f
        width, height = source.width, source.height
        bounds = source.bounds
        rows, columns = orthophoto._shape(width, height, pixel_m, SURVEY_POOL_M,
                                           orthophoto.SETTINGS["fit_max_pixels"])
        pooled_rgba = source.read([1, 2, 3, 4], out_shape=(4, rows, columns), resampling=Resampling.average)
        pooled = np.tensordot(grain.LUMA, grain.to_linear(pooled_rgba[:3]), 1)
        pooled_transform = source.transform * source.transform.scale(width/columns, height/rows)
        x = left + (np.arange(columns) + 0.5) * pooled_transform.a
        y = top + (np.arange(rows) + 0.5) * pooled_transform.e
        column = np.floor((x - tile.west) / cell_m).astype(int)
        row = np.floor((tile.north - y) / cell_m).astype(int)
        inside = ((row >= 0) & (row < DETAIL_PIXELS))[:, None] & ((column >= 0) & (column < DETAIL_PIXELS))[None, :]
        at = np.ix_(np.clip(row, 0, DETAIL_PIXELS - 1), np.clip(column, 0, DETAIL_PIXELS - 1))
        mine = np.where(inside, own[at], -1)
        sunlit = np.where(inside, open_cells[at], 0) * (pooled_rgba[3] >= 250)
        if ortho and "raster" in ortho:
            with rasterio.open(out / ortho["raster"]) as masks:
                shares = masks.read(out_shape=(4, rows, columns), resampling=Resampling.average) / 255
            # A photo DSM can miss roofs and crowns; new cover may hide more, never reopen known cover.
            sunlit = np.minimum(sunlit, 1 - shares[3])
            sunlit *= pooled_rgba[3] >= 250
        sigma = MACRO_LOW_PASS_M / pooled_transform.a
        smooth = np.ones_like(pooled)
        for index in range(len(layers)):
            passed = _low_pass_of_sunlit(pooled[None], sunlit * (mine == index), sigma)[0]
            smooth = np.where(mine == index, passed, smooth)
        survey_shadows = {}
        if ortho:
            darkness = np.log2(np.maximum(pooled, 1e-4) / np.maximum(smooth, 1e-4))
            for index, layer in enumerate(layers):
                if layer["name"] not in surface.SEASONAL:
                    continue
                shown = (mine == index) & (sunlit > 0.5)
                gap = shadow_gap(darkness[shown])
                # A small footprint may not contain enough shadow samples for the mixture fit.
                threshold = gap if gap is not None else -1.5
                dark = shown & (darkness < threshold)
                sunlit = np.where(ndimage.binary_dilation(dark, iterations=SHADOW_EDGE_CELLS), 0, sunlit)
                survey_shadows[layer["name"]] = {"gap_log2": threshold, "kind": "fitted" if gap else "prior",
                                                   "shadow_fraction": float(dark.mean())}
            for index in range(len(layers)):
                passed = _low_pass_of_sunlit(pooled[None], sunlit * (mine == index), sigma)[0]
                smooth = np.where(mine == index, passed, smooth)
        trust = np.minimum(_blur(sunlit.astype(np.float32), DETAIL_FADE_CELLS), sunlit)
        profile = source.profile | {"driver": "GTiff", "count": 4, "dtype": "uint8", "nodata": None,
                                    "compress": "deflate", "tiled": True, "blockxsize": 256, "blockysize": 256}
        block = orthophoto.SETTINGS["block_pixels"]
        with rasterio.open(out / "survey_detail.tif", "w", **profile) as target:
            for first_row in range(0, height, block):
                for first_column in range(0, width, block):
                    window = Window(first_column, first_row, min(block, width-first_column), min(block, height-first_row))
                    data = source.read([1, 2, 3, 4], window=window)
                    valid = data[3] > 0
                    luminance = np.tensordot(grain.LUMA, grain.to_linear(data[:3]), 1)
                    ri = np.minimum(((first_row + np.arange(data.shape[1]) + 0.5)*rows/height).astype(int), rows-1)
                    ci = np.minimum(((first_column + np.arange(data.shape[2]) + 0.5)*columns/width).astype(int), columns-1)
                    at = np.ix_(ri, ci)
                    weight = np.where(valid, trust[at], 0)
                    ratio = np.log2(np.maximum(luminance, 1e-4) / np.maximum(smooth[at], 1e-4))
                    ratio = np.clip(ratio, -DETAIL_LOG2_RANGE, DETAIL_LOG2_RANGE) * weight
                    level = np.clip(np.rint(DETAIL_ZERO + DETAIL_ZERO * ratio / DETAIL_LOG2_RANGE), 1, 2 * DETAIL_ZERO)
                    target.write(np.stack([level, level, level, np.rint(weight * 255)]).astype(np.uint8), window=window)
    orthophoto.write_png(out / "survey_detail.tif", out / "survey_detail.png")
    return {
        "file": "survey_detail.png",
        "files": ["survey_detail.png", "survey_detail.tif"],
        "weight_channel": "alpha",
        "ratio_encoding": "RGB is a log2 ratio premultiplied by the alpha detail weight; zero weight selects fallback texture",
        "survey_shadows": survey_shadows,
        "pixel_m": pixel_m,
        "pixels": [width, height],
        "log2_range": DETAIL_LOG2_RANGE,
        "zero": DETAIL_ZERO,
        "low_pass_m": MACRO_LOW_PASS_M,
        # Where the file lies in the tile, in metres from its south-west corner: east and north extents.
        "west_m": left - tile.west,
        "south_m": bounds.bottom - tile.south,
        "east_extent_m": bounds.right - bounds.left,
        "north_extent_m": bounds.top - bounds.bottom,
        "priors": [
            f"prior: the low-pass runs on the orthophoto pooled to {pooled_transform.a:.2f} m",
            "prior: the orthophoto's shadows are taken as they are: its sun is not the imagery's, so the cover stage's shadow does not mask them",
        ],
    }


def read_heights(out: Path, elevation: dict) -> np.ndarray:
    """The detailed surface back from its heightmap, north-up, in metres."""
    heights = np.asarray(Image.open(out / elevation["file"]))
    metres = frame.decode_heights(heights, elevation["mid_m"], elevation["z_scale"])
    return np.swapaxes(metres, 0, 1)[::-1]


def build_context(
    site: Site,
    dem: Path,
    imagery: Path,
    canopy: Path | None,
    cutoff_m: float | None,
    out: Path,
    detailed: np.ndarray,
    origin_height_m: float,
    classes: dict | None = None,
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
    bands, has_nir = imagery_bands(site.imagery)
    colour = _warp(
        imagery, site.crs, west + pixel / 2, top - pixel / 2, pixel, CONTEXT_MACRO_PIXELS, Resampling.average, bands
    )
    colour = np.stack([_fill_gaps(band, "imagery")[0] for band in colour])
    curves = (classes or {}).get("albedo", {}).get("curves")
    nir, colour = (colour[3] if has_nir else None), colour[:3]
    clear = np.ones(colour.shape[1:], dtype=np.float32)
    if canopy:
        # The share of each coarse pixel that no canopy stands over. The surround has no lidar and no shadow.
        with rasterio.open(canopy) as file:
            # Cells the raster has no value for count as clear, not as a canopy of the no-data value's height.
            standing = (file.read(1, masked=True).filled(0) > cutoff_m).astype(np.float32)
            reproject(
                standing,
                clear,
                src_transform=file.transform,
                src_crs=file.crs,
                dst_transform=from_origin(west, top, pixel, pixel),
                dst_crs=site.crs,
                resampling=Resampling.average,
            )
        clear = 1 - clear
    sigma = MACRO_LOW_PASS_M / pixel
    if not curves:
        colour = _low_pass_of_sunlit(colour, clear, sigma)
    else:
        # The surround takes the tile's fitted splits and each class's fitted curve, so it is albedo as well.
        labels = surface.apply_splits(colour, nir, classes["splits"])
        albedo = np.zeros_like(colour)
        for index, layer in enumerate(classes["layers"]):
            own = (labels == index).astype(np.float32)
            if own.any():
                passed = _low_pass_of_sunlit(colour, clear * own, sigma)
                albedo += _blur(own, sigma) * surface.apply_curve(passed, curves[layer["name"]])
        colour = surface.to_encoded(albedo)
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
    reflectance = Path(sources["reflectance"]["path"]) if site.reflectance else None
    bands = [site.imagery.bands, site.reflectance.bands if site.reflectance else None]
    grid = [tile.west, tile.south, tile.quad_m, tile.quads]

    # The lidar's identity is cheap to get; its rasters are only built when a stage has to run.
    lidar_key = None
    if site.lidar:
        sources["lidar"] = lidar.identify(site.lidar, tile, site.crs, cache)
        lidar_key = sources["lidar"]["sha256"]
    structure = {}
    footprints, roofs = [], None
    if site.buildings:
        path = Path(site.buildings.location)
        if not path.is_file():
            raise FileNotFoundError(f"sources.buildings: {path} does not exist")
        footprints = buildings.load_footprints(path, site.crs, tile)
        roofs = buildings.mask(footprints, tile, lidar.CELL_M)
        sources["buildings"] = {
            "kind": site.buildings.kind,
            "license": site.buildings.license,
            "date": site.buildings.date,
            "bytes_fetched": 0,
            "path": site.buildings.location,
            "sha256": sha256_file(path),
        }
    buildings_key = [sources["buildings"]["sha256"], buildings.SETTINGS] if site.buildings else None

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
    geo = georeference(site, elevation["origin_height_m"])
    covering = None
    if site.lidar or site.canopy_height:
        canopy = Path(sources["canopy_height"]["path"]) if site.canopy_height else None
        # Cover is measured against the elevation model and its shadow fitted to the imagery, so either changes it.
        cover_key = [
            grid,
            site.crs,
            lidar_key,
            sources["elevation"]["sha256"],
            sources["imagery"]["sha256"],
            sources["canopy_height"]["sha256"] if canopy else None,
            site.imagery.date,
            buildings_key,
        ]
        stages["cover"] = _cached(
            out,
            "cover",
            _stage_key(cover_key),
            lambda: build_cover(
                site,
                dem,
                imagery,
                canopy,
                out,
                rasters()[0],
                geo["origin_latitude_deg"],
                geo["origin_longitude_deg"],
                geo["true_north_from_grid_north_deg"],
                roofs,
            ),
        )
        covering = stages["cover"]
    cover_hashes = [sha256_file(out / name) for name in covering["files"]] if covering else None
    ortho = None
    ortho_hashes = None
    ortho_sha256 = None
    if site.survey and site.survey.orthophoto:
        ortho_inputs = [sha256_file(Path(path)) for path in
                        (site.survey.orthophoto, site.survey.location, site.survey.terrain)]
        ortho_sha256 = ortho_inputs[0]
        if site.survey.observations:
            ortho_inputs.append(sha256_file(Path(site.survey.observations)))
        stages["orthophoto"] = _cached(
            out, "orthophoto",
            _stage_key(grid, site.crs, ortho_inputs, sources["imagery"]["sha256"], bands,
                       cover_hashes, buildings_key, orthophoto.SETTINGS, surface.SETTINGS,
                       MACRO_LOW_PASS_M, SHADOW_DARKEST_LOG2, SHADOW_BIN_LOG2,
                       SHADOW_MIN_SHARE, SHADOW_MIN_CELLS, SHADOW_VALLEY_MAX, SHADOW_EDGE_CELLS),
            lambda: build_orthophoto(site, imagery, out, covering, roofs),
        )
        ortho = stages["orthophoto"]
        ortho_hashes = [sha256_file(out / name) for name in ortho["files"]]
    stages["surface"] = _cached(
        out,
        "surface",
        _stage_key(
            grid,
            site.crs,
            sources["imagery"]["sha256"],
            cover_hashes,
            bands,
            [sources["reflectance"]["sha256"], site.reflectance.date] if reflectance else None,
            surface.PURE_SHARE,
            surface.PURE_SUNLIT,
            surface.PURE_MIN_PIXELS,
            surface.REFLECTANCE_CHECKS,
            surface.SEPARATION_MIN,
            surface.COHERENCE_MIN,
            surface.MIXTURE_SAMPLE,
            surface.MIXTURE_ITERATIONS,
            surface.CHECK_POINTS_PER_KIND,
            surface.ALBEDO_ANCHORS,
            surface.CHECKS,
            surface.ALBEDO_SCALE_PRIOR,
            surface.GROUP_MIN_M2,
            surface.EDGE_M,
            surface.MAJORITY_CELLS,
            surface.CROWN_MAX_M2,
            surface.CROWN_RING_M,
            buildings_key,
            ortho_hashes,
        ),
        lambda: build_surface(site, imagery, out, covering, reflectance, roofs, ortho),
    )
    classes = stages["surface"]
    stages["macro_colour"] = _cached(
        out,
        "macro_colour",
        _stage_key(
            grid,
            site.crs,
            sources["imagery"]["sha256"],
            cover_hashes,
            [sha256_file(out / name) for name in classes["files"]],
            MACRO_PIXELS,
            MACRO_LOW_PASS_M,
            bands,
            classes["albedo"].get("curves"),
            [
                sources["reflectance"]["sha256"],
                surface.SEASONAL,
                MEASURED_REACH_MIN,
                surface.PURE_SHARE,
                surface.PURE_SUNLIT,
            ]
            if reflectance
            else None,
        ),
        lambda: build_macro_colour(
            tile,
            site.crs,
            imagery,
            out,
            covering,
            classes["layers"],
            imagery_bands(site.imagery)[0],
            classes["albedo"].get("curves"),
            reflectance,
            [site.reflectance.band(name) for name in ("red", "green", "blue")] if reflectance else None,
        ),
    )
    macro = stages["macro_colour"]
    stages["detail"] = _cached(
        out,
        "detail",
        _stage_key(
            grid,
            site.crs,
            sources["imagery"]["sha256"],
            cover_hashes,
            [sha256_file(out / name) for name in classes["files"]],
            DETAIL_PIXELS,
            DETAIL_LOG2_RANGE,
            DETAIL_ZERO,
            DETAIL_FADE_CELLS,
            MACRO_LOW_PASS_M,
            bands,
            [
                SHADOW_DARKEST_LOG2,
                SHADOW_BIN_LOG2,
                SHADOW_MIN_SHARE,
                SHADOW_MIN_CELLS,
                SHADOW_VALLEY_MAX,
                SHADOW_EDGE_CELLS,
                surface.SEASONAL,
            ],
            [covering["cutoff_m"], covering["sun"]["crown_spread_m"]] if covering else None,
            buildings_key,
        ),
        lambda: build_detail(
            tile,
            site.crs,
            imagery,
            out,
            covering,
            classes["layers"],
            imagery_bands(site.imagery)[0],
            roofs,
        ),
    )
    detail = stages["detail"]
    if any(layer["name"] == "grass" for layer in classes["layers"]):
        stages["growth"] = _cached(
            out,
            "growth",
            _stage_key(
                grid,
                sha256_file(out / detail["file"]),
                sha256_file(out / stages["elevation"]["file"]),
                [sha256_file(out / name) for name in classes["files"]],
                cover_hashes,
                site.seed,
                turf.GROWTH_SETTINGS,
                ortho_hashes,
                ortho_sha256,
            ),
            lambda: build_growth(site, out, classes["layers"], detail, stages["elevation"], covering, ortho,
                                  classes["fallback_weights"]),
        )
    if site.survey and site.survey.orthophoto:
        stages["grain"] = _cached(
            out,
            "grain",
            _stage_key(
                grid,
                site.crs,
                sha256_file(Path(site.survey.orthophoto)),
                [sha256_file(out / name) for name in classes["files"]],
                site.seed,
                grain.PIXELS,
                grain.LOG2_RANGE,
                grain.ZERO,
                grain.BLOCK_PX,
                grain.LOW_PASS_M,
                grain.QUIET_SHARE,
                grain.GRASS_PURITY,
                grain.MIN_BLOCKS,
                grain.BLADE_COLOURS,
                grain.LENS_FOV_DEG,
                grain.FRAME_PX,
                grain.NEAR_SHARE,
                grain.RADIAL_BINS,
                grain.QUANTILES,
                grain.LUMA.tolist(),
            ),
            lambda: build_grain(site, out, classes["layers"]),
        )
    if site.survey and site.survey.orthophoto:
        stages["survey_detail"] = _cached(
            out,
            "survey_detail",
            _stage_key(
                "survey-detail-packed-weight-v1",
                grid,
                site.crs,
                sha256_file(Path(site.survey.orthophoto)),
                cover_hashes,
                [sha256_file(out / name) for name in classes["files"]],
                DETAIL_PIXELS,
                DETAIL_LOG2_RANGE,
                DETAIL_ZERO,
                DETAIL_FADE_CELLS,
                MACRO_LOW_PASS_M,
                SURVEY_POOL_M,
                ortho_hashes,
                orthophoto.SETTINGS["fit_max_pixels"],
            ),
            lambda: build_survey_detail(site, out, covering, classes["layers"], ortho),
        )
    inventory = None
    if covering:
        for name, source in (("survey", site.survey), ("tree_mix", site.tree_mix)):
            if source:
                sources[name] = {
                    "kind": source.kind,
                    "license": source.license,
                    "date": source.date,
                    "bytes_fetched": 0,
                    "path": source.location,
                    "sha256": sha256_file(Path(source.location)),
                }
        if site.survey:
            sources["survey"] |= {
                "terrain": site.survey.terrain,
                "terrain_sha256": sha256_file(Path(site.survey.terrain)),
            }
            if site.survey.orthophoto:
                sources["survey"] |= {
                    "orthophoto": site.survey.orthophoto,
                    "orthophoto_sha256": sha256_file(Path(site.survey.orthophoto)),
                }
            if site.survey.observations:
                sources["survey"]["observations_sha256"] = sha256_file(Path(site.survey.observations))
        stages["trees"] = _cached(
            out,
            "trees",
            _stage_key(
                grid,
                site.crs,
                cover_hashes,
                lidar_key,
                site.lidar.leaf_off if site.lidar else None,
                sources["elevation"]["sha256"],
                sources["canopy_height"]["sha256"] if site.canopy_height else None,
                sources["imagery"]["sha256"],
                bands,
                classes["splits"],
                [sources[name] for name in ("survey", "tree_mix") if name in sources],
                buildings_key,
                site.seed,
                trees.SETTINGS,
                trees.COLUMNS,
            ),
            lambda: build_trees(
                site,
                cache,
                dem,
                imagery,
                Path(sources["canopy_height"]["path"]) if site.canopy_height else None,
                out,
                covering,
                classes,
                rasters()[0],
                footprints,
            ),
        )
        inventory = stages["trees"]
    housing = None
    if site.buildings:
        stages["buildings"] = _cached(
            out,
            "buildings",
            _stage_key(
                grid,
                site.crs,
                buildings_key,
                lidar_key,
                sources["imagery"]["sha256"],
                bands,
                sources["elevation"]["sha256"],
                classes["albedo"].get("curves", {}).get(surface.PAVED),
                classes["albedo"]["scale"],
            ),
            lambda: build_buildings(site, footprints, imagery, out, classes, rasters()[0]),
        )
        housing = stages["buildings"]

    half_cm = tile.size_m * 100 / 2
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "site_id": site.site_id,
        "target_date": site.target_date,
        "seed": site.seed,
        "georeference": geo,
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
            for key in ("file", "pixels", "low_pass_m", "filled_fraction", "hidden_fraction", "measured", "priors")
        },
        "detail": {key: value for key, value in detail.items() if key not in ("cached",)},
        "surface": {key: value for key, value in classes.items() if key not in ("files", "cached")},
        "lighting": light.lighting(
            site.target_date,
            covering["sun"]["fitted_solar_time"] if covering else None,
            geo["origin_latitude_deg"],
            geo["origin_longitude_deg"],
            geo["true_north_from_grid_north_deg"],
        ),
        "stencil_classes": STENCIL_CLASSES,
        "sources": sources,
    }
    artifacts = [elevation["file"], macro["file"], detail["file"], *classes["files"]]
    if ortho:
        manifest["orthophoto"] = {key: value for key, value in ortho.items() if key not in ("files", "cached")}
        artifacts += ortho["files"]
    if any(layer["name"] == "grass" for layer in classes["layers"]):
        manifest["turf"] = turf.describe()
        manifest["turf"]["growth"] = {key: value for key, value in stages["growth"].items() if key not in ("files", "cached")}
        artifacts += stages["growth"]["files"]
    if "survey_detail" in stages:
        manifest["survey_detail"] = {
            key: value for key, value in stages["survey_detail"].items() if key not in ("files", "cached")
        }
        artifacts += stages["survey_detail"]["files"]
    if "grain" in stages:
        manifest["grain"] = {key: value for key, value in stages["grain"].items() if key not in ("files", "cached")}
        artifacts += [stages["grain"]["file"]] if "file" in stages["grain"] else []
    if housing:
        manifest["buildings"] = {key: value for key, value in housing.items() if key not in ("files", "cached")}
        artifacts += housing["files"]
    if covering:
        manifest["cover"] = {key: value for key, value in covering.items() if key not in ("files", "cached")}
        artifacts += covering["files"]
        manifest["trees"] = {key: value for key, value in inventory.items() if key not in ("files", "cached")}
        artifacts += inventory["files"]

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
                [sources["context_canopy_height"]["sha256"], covering["cutoff_m"]] if site.canopy_height else None,
                sha256_file(out / elevation["file"]),
                CONTEXT_SINK_M,
                CONTEXT_QUADS,
                CONTEXT_MACRO_PIXELS,
                MACRO_LOW_PASS_M,
                bands,
                classes["albedo"].get("curves"),
                classes["splits"],
            ),
            lambda: build_context(
                site,
                context_dem,
                context_imagery,
                Path(sources["context_canopy_height"]["path"]) if site.canopy_height else None,
                covering["cutoff_m"] if covering else None,
                out,
                read_heights(out, elevation),
                elevation["origin_height_m"],
                classes,
            ),
        )
        context = stages["context"]
        manifest["context"] = {key: value for key, value in context.items() if key not in ("files", "cached")}
        artifacts += [context["heightmap"], context["colour"]]

    manifest["artifacts"] = {name: sha256_file(out / name) for name in artifacts}
    manifest["stages_reused"] = [name for name, stage in stages.items() if stage["cached"]]
    (out / "build.json").write_text(json.dumps(manifest, indent=1))
    return manifest
