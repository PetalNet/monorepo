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
