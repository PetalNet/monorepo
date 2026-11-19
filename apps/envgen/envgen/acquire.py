"""Stage 1: clip each source to the tile once, and record what it was.

A source is fetched only when its cache file is absent. The cache key covers the source and the
requested window, so a changed boundary fetches a new window and an unchanged one never refetches.
"""

from __future__ import annotations

import hashlib
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

from .site import Site, Source, Tile

# ImageServers cap the size of one export; this is under the common limits.
MAX_REQUEST_PIXELS = 2048
# Extra ground around the tile, so resampling at the tile edge has real neighbours.
MARGIN_M = 16.0
USER_AGENT = "envgen/0.1"
# Part of the cache key. Bump it when the cached file's contents change for the same window (2: no-data tag kept).
CACHE_FORMAT = 2


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _export_url(
    endpoint: str, bounds: tuple[float, float, float, float], size: tuple[int, int], epsg: int, elevation: bool
) -> str:
    query = {
        "bbox": ",".join(f"{value:.6f}" for value in bounds),
        "bboxSR": epsg,
        "imageSR": epsg,
        "size": f"{size[0]},{size[1]}",
        "format": "tiff",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    if elevation:
        query["pixelType"] = "F32"
    return f"{endpoint}/exportImage?{urllib.parse.urlencode(query)}"


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read()
    if not body.startswith((b"II*\x00", b"MM\x00*")):
        raise RuntimeError(f"the image service did not return a TIFF: {body[:200]!r}")
    return body


def fetch_imageserver(source: Source, tile: Tile, epsg: int, elevation: bool, target: Path, fetch) -> int:
    """Export the tile window in parts of at most MAX_REQUEST_PIXELS and write one GeoTIFF. Returns bytes fetched."""
    spacing = source.request_spacing_m
    west, south, east, north = tile.bounds(MARGIN_M)
    width = math.ceil((east - west) / spacing)
    height = math.ceil((north - south) / spacing)
    mosaic = None
    nodata = None
    fetched = 0
    for row0 in range(0, height, MAX_REQUEST_PIXELS):
        for col0 in range(0, width, MAX_REQUEST_PIXELS):
            rows = min(MAX_REQUEST_PIXELS, height - row0)
            cols = min(MAX_REQUEST_PIXELS, width - col0)
            part_bounds = (
                west + col0 * spacing,
                north - (row0 + rows) * spacing,
                west + (col0 + cols) * spacing,
                north - row0 * spacing,
            )
            body = fetch(_export_url(source.location, part_bounds, (cols, rows), epsg, elevation))
            fetched += len(body)
            with MemoryFile(body) as memory, memory.open() as part:
                data = part.read()
                nodata = part.nodata if nodata is None else nodata
            if data.shape[1:] != (rows, cols):
                raise RuntimeError(
                    f"asked the image service for {cols}x{rows} pixels, got {data.shape[2]}x{data.shape[1]}"
                )
            if mosaic is None:
                mosaic = np.zeros((data.shape[0], height, width), dtype=data.dtype)
            mosaic[:, row0 : row0 + rows, col0 : col0 + cols] = data
    profile = {
        "driver": "GTiff",
        "width": width,
        "height": height,
        "count": mosaic.shape[0],
        "dtype": mosaic.dtype,
        "crs": f"EPSG:{epsg}",
        "transform": from_origin(west, north, spacing, spacing),
        # Services mark cells outside their coverage with a sentinel; keep it so later stages can fill them.
        "nodata": nodata,
        "compress": "deflate",
        "tiled": True,
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    with rasterio.open(partial, "w", **profile) as out:
        out.write(mosaic)
    partial.replace(target)
    return fetched


def acquire(site: Site, cache: Path, fetch=None) -> dict:
    """Make sure every source is on disk. Returns the source registry. `fetch` replaces the HTTP GET in tests."""
    fetch = fetch or _fetch
    epsg = int(site.crs.split(":")[1])
    registry = {}
    for name, source in (("elevation", site.elevation), ("imagery", site.imagery)):
        entry = {"kind": source.kind, "license": source.license, "date": source.date, "bytes_fetched": 0}
        if source.kind == "file":
            path = Path(source.location)
            if not path.is_file():
                raise FileNotFoundError(f"sources.{name}: {path} does not exist")
        else:
            window = json.dumps([CACHE_FORMAT, source.location, source.request_spacing_m, site.tile.bounds(MARGIN_M), epsg])
            key = hashlib.sha256(window.encode()).hexdigest()[:16]
            path = cache / f"{name}-{key}.tif"
            entry["endpoint"] = source.location
            entry["request_spacing_m"] = source.request_spacing_m
            if not path.is_file():
                entry["bytes_fetched"] = fetch_imageserver(source, site.tile, epsg, name == "elevation", path, fetch)
        entry["path"] = str(path)
        entry["sha256"] = sha256_file(path)
        registry[name] = entry
    return registry
