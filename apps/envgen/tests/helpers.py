"""Synthetic sites for tests. The coordinates are arbitrary round numbers, chosen off the zone's central meridian."""

from __future__ import annotations

import json
import urllib.parse
from pathlib import Path

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

CRS = "EPSG:32633"
WEST, SOUTH = 560000.0, 5000000.0
SIZE_M = 126.0  # one Landscape component at 1 m quads
BOUNDARY = [[WEST + 20, SOUTH + 30], [WEST + 100, SOUTH + 30], [WEST + 106, SOUTH + 96], [WEST + 20, SOUTH + 90]]


def plane(easting, northing):
    """A tilted plane: 2 cm up per metre east, 1 cm up per metre north."""
    return 100.0 + 0.02 * (easting - WEST) + 0.01 * (northing - SOUTH)


def write_raster(path: Path, values: np.ndarray, west: float, north: float, spacing: float) -> None:
    bands = values if values.ndim == 3 else values[None]
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=bands.shape[2],
        height=bands.shape[1],
        count=bands.shape[0],
        dtype=bands.dtype,
        crs=CRS,
        transform=from_origin(west, north, spacing, spacing),
    ) as out:
        out.write(bands)


def write_dem(path: Path, function=plane, spacing: float = 1.0, margin: float = 20.0) -> None:
    west, north = WEST - 40 - margin, SOUTH + SIZE_M + 40 + margin
    count = int((SIZE_M + 80 + 2 * margin) / spacing)
    eastings = west + (np.arange(count) + 0.5) * spacing
    northings = north - (np.arange(count) + 0.5) * spacing
    write_raster(path, function(eastings[None, :], northings[:, None]).astype(np.float32), west, north, spacing)


def write_imagery(path: Path, split_easting: float, split_northing: float = SOUTH + 1e9) -> None:
    """Red west of split_easting and green east of it; blue as well north of split_northing."""
    west, north = WEST - 60, SOUTH + SIZE_M + 60
    count = int(SIZE_M + 120)
    eastings = west + np.arange(count) + 0.5
    northings = north - np.arange(count) - 0.5
    rgb = np.zeros((3, count, count), dtype=np.uint8)
    rgb[0][:, eastings < split_easting] = 200
    rgb[1][:, eastings >= split_easting] = 200
    rgb[2][northings >= split_northing, :] = 200
    write_raster(path, rgb, west, north, 1.0)


SERVICE_SOURCES = {
    "elevation": {
        "kind": "arcgis_imageserver",
        "endpoint": "https://elevation.invalid/ImageServer",
        "request_spacing_m": 1.0,
        "license": "test",
        "date": "2030",
    },
    "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"},
}


def write_site(directory: Path, **overrides) -> Path:
    site = {
        "schema_version": 1,
        "site_id": "synthetic",
        "crs": CRS,
        "boundary": BOUNDARY,
        "tile": {"size_m": SIZE_M, "quad_m": 1.0},
        "target_date": "2030-06",
        "seed": 7,
        "vertical_datum": "synthetic metres",
        "sources": {
            "elevation": {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"},
            "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"},
        },
    }
    site.update(overrides)
    path = directory / "site.json"
    path.write_text(json.dumps(site))
    return path


NODATA = -9999.0


class FakeImageServer:
    """Answers exportImage URLs with a TIFF of plane() over the requested window, and counts requests.

    East of `coverage_east` it returns the service's no-data value, as a real service does outside its coverage.
    """

    def __init__(self, coverage_east: float = float("inf")):
        self.requests = 0
        self.coverage_east = coverage_east

    def __call__(self, url: str) -> bytes:
        self.requests += 1
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        west, south, east, north = (float(value) for value in query["bbox"][0].split(","))
        cols, rows = (int(value) for value in query["size"][0].split(","))
        eastings = west + (np.arange(cols) + 0.5) * (east - west) / cols
        northings = north - (np.arange(rows) + 0.5) * (north - south) / rows
        values = plane(eastings[None, :], northings[:, None]).astype(np.float32)
        values[:, eastings > self.coverage_east] = NODATA
        with MemoryFile() as memory:
            with memory.open(driver="GTiff", width=cols, height=rows, count=1, dtype="float32", nodata=NODATA) as out:
                out.write(values, 1)
            return memory.read()


def write_las(path: Path, points: np.ndarray) -> None:
    """Write x, y, z, classification rows as a LAS file."""
    import laspy

    header = laspy.LasHeader(point_format=3, version="1.2")
    header.offsets = [WEST, SOUTH, 0.0]
    header.scales = [0.01, 0.01, 0.01]
    las = laspy.LasData(header)
    las.x, las.y, las.z = points[:, 0], points[:, 1], points[:, 2]
    las.classification = points[:, 3].astype(np.uint8)
    las.write(path)


def ground_returns(skip=lambda easting, northing: np.zeros(easting.shape, dtype=bool)) -> np.ndarray:
    """One ground return per square metre on plane(), over the tile and a little beyond, except where `skip` says."""
    eastings, northings = np.meshgrid(WEST - 20 + np.arange(170) + 0.5, SOUTH - 20 + np.arange(170) + 0.5)
    eastings, northings = eastings.ravel(), northings.ravel()
    keep = ~skip(eastings, northings)
    eastings, northings = eastings[keep], northings[keep]
    return np.column_stack([eastings, northings, plane(eastings, northings), np.full(len(eastings), 2)])


def returns_above(west: float, south: float, side: float, height: float) -> np.ndarray:
    """Unclassified returns `height` above plane() over a square: a canopy or a roof."""
    eastings, northings = np.meshgrid(west + np.arange(side) + 0.5, south + np.arange(side) + 0.5)
    eastings, northings = eastings.ravel(), northings.ravel()
    return np.column_stack([eastings, northings, plane(eastings, northings) + height, np.full(len(eastings), 1)])


GRASS, PAVED = (70, 130, 60), (190, 190, 190)


def write_scene(path: Path, base: tuple[int, int, int], patches=()) -> None:
    """Imagery of one colour with rectangles of others: (west, south, east, north, rgb), in metres from the tile's south-west corner."""
    west, north = WEST - 60, SOUTH + SIZE_M + 60
    count = int(SIZE_M + 120)
    eastings = west + np.arange(count) + 0.5 - WEST
    northings = north - np.arange(count) - 0.5 - SOUTH
    rgb = np.empty((3, count, count), dtype=np.uint8)
    rgb[:] = np.array(base, dtype=np.uint8)[:, None, None]
    for patch_west, patch_south, patch_east, patch_north, colour in patches:
        rows = (northings >= patch_south) & (northings < patch_north)
        columns = (eastings >= patch_west) & (eastings < patch_east)
        for band in range(3):
            rgb[band][np.ix_(rows, columns)] = colour[band]
    write_raster(path, rgb, west, north, 1.0)
