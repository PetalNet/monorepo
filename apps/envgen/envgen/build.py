"""Stages 2 to 4: elevation, macro colour, manifest. Each stage reads artifacts and writes artifacts."""

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

from . import frame
from .acquire import acquire, sha256_file
from .site import LANDSCAPE_SECTION_QUADS, LANDSCAPE_SECTIONS_PER_COMPONENT, SCHEMA_VERSION, Site, Tile, load_site

# Part of every stage key. Bump it by hand when a code change alters a stage's output for the same
# inputs (frame.py and the resampling included); nothing detects that automatically.
PIPELINE_VERSION = 1

MACRO_PIXELS = 1024
# The macro map carries colour that varies over tens of metres. Finer detail comes from the engine.
MACRO_LOW_PASS_M = 12.0

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


def build_elevation(tile: Tile, crs: str, dem: Path, out: Path) -> dict:
    north_up = _warp(dem, crs, tile.west, tile.north, tile.quad_m, tile.vertices, Resampling.bilinear)[0]
    north_up, filled = _fill_gaps(north_up, "elevation")
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
    }


def build_macro_colour(tile: Tile, crs: str, imagery: Path, out: Path) -> dict:
    spacing = tile.size_m / MACRO_PIXELS
    north_up = _warp(
        imagery, crs, tile.west + spacing / 2, tile.north - spacing / 2, spacing, MACRO_PIXELS, Resampling.average
    )
    filled = 0.0
    smooth = np.empty_like(north_up)
    for band in range(north_up.shape[0]):
        values, fraction = _fill_gaps(north_up[band], "imagery")
        filled = max(filled, fraction)
        smooth[band] = ndimage.gaussian_filter(values, MACRO_LOW_PASS_M / spacing, mode="nearest")
    rgb = np.clip(np.rint(np.moveaxis(smooth, 0, -1)), 0, 255).astype(np.uint8)
    if rgb.shape[2] == 1:
        rgb = np.repeat(rgb, 3, axis=2)
    Image.fromarray(frame.to_unreal_layout(rgb)).save(out / "macro_colour.png")
    return {
        "file": "macro_colour.png",
        "pixels": MACRO_PIXELS,
        "low_pass_m": MACRO_LOW_PASS_M,
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
        if record["key"] == key and (out / record["result"]["file"]).is_file():
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
    sources = acquire(site, cache or out / "cache")
    grid = [tile.west, tile.south, tile.quad_m, tile.quads]

    elevation = _cached(
        out,
        "elevation",
        _stage_key(grid, site.crs, sources["elevation"]["sha256"]),
        lambda: build_elevation(tile, site.crs, Path(sources["elevation"]["path"]), out),
    )
    macro = _cached(
        out,
        "macro_colour",
        _stage_key(grid, site.crs, sources["imagery"]["sha256"], MACRO_PIXELS, MACRO_LOW_PASS_M),
        lambda: build_macro_colour(tile, site.crs, Path(sources["imagery"]["path"]), out),
    )

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
        },
        "macro_colour": {key: macro[key] for key in ("file", "pixels", "low_pass_m", "filled_fraction")},
        "stencil_classes": STENCIL_CLASSES,
        "sources": sources,
        "artifacts": {name: sha256_file(out / name) for name in (elevation["file"], macro["file"])},
        "stages_reused": [
            name for name, stage in (("elevation", elevation), ("macro_colour", macro)) if stage["cached"]
        ],
    }
    (out / "build.json").write_text(json.dumps(manifest, indent=1))
    return manifest
