"""Lidar points over the tile: what stands above the ground, and where the ground was actually measured.

Two rasters come out of the points, both on a 1 m north-up grid over the tile:

- height above ground: the highest return in each cell minus the elevation model. Trees and roofs.
- ground gap: distance to the nearest cell holding a ground-classified return. Where it is large the
  elevation model was interpolated across the gap rather than measured.
"""

from __future__ import annotations

import hashlib
import json
import urllib.request
from pathlib import Path

import numpy as np
from rasterio.warp import transform
from scipy import ndimage

from .site import Source, Tile

CELL_M = 1.0
GROUND_CLASS = 2
NOISE_CLASSES = (7, 18)
EPT_CRS = "EPSG:3857"
USER_AGENT = "envgen/0.1"


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def _read_las(path: Path) -> np.ndarray:
    """Columns: x, y, z, classification, in the file's own CRS."""
    import laspy  # needed only when a site has a lidar source

    las = laspy.read(path)
    return np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z), np.asarray(las.classification)])


def ept_nodes(
    hierarchy: dict[str, int], root: tuple[float, ...], window: tuple[float, float, float, float]
) -> tuple[list[str], list[str]]:
    """From one EPT hierarchy page, the node keys whose square overlaps the window: (with points, pages to follow)."""
    data, pages = [], []
    for key, count in hierarchy.items():
        depth, x, y, _ = (int(part) for part in key.split("-"))
        side = (root[3] - root[0]) / 2**depth
        west, south = root[0] + x * side, root[1] + y * side
        if west + side < window[0] or west > window[2] or south + side < window[1] or south > window[3]:
            continue
        if count == -1:
            pages.append(key)
        elif count > 0:
            data.append(key)
    return data, pages


def fetch_ept(
    endpoint: str, window: tuple[float, float, float, float], directory: Path, get=_get
) -> tuple[np.ndarray, int]:
    """Download the EPT nodes that overlap the window (given in EPT_CRS), once each. Returns (points, bytes fetched)."""
    directory.mkdir(parents=True, exist_ok=True)
    description = json.loads(get(f"{endpoint}/ept.json"))
    horizontal = str(description.get("srs", {}).get("horizontal", ""))
    if horizontal != EPT_CRS.split(":")[1]:
        raise RuntimeError(f"the point store is in EPSG:{horizontal or '?'}; only {EPT_CRS} stores are supported")
    root = tuple(description["bounds"])
    nodes, pending, seen = [], ["0-0-0-0"], set()
    while pending:
        page = pending.pop()
        seen.add(page)
        data, pages = ept_nodes(json.loads(get(f"{endpoint}/ept-hierarchy/{page}.json")), root, window)
        nodes += data
        pending += [key for key in pages if key not in seen]
    fetched, parts = 0, []
    for key in sorted(set(nodes)):
        path = directory / f"{key}.laz"
        if not path.is_file():
            body = get(f"{endpoint}/ept-data/{key}.laz")
            fetched += len(body)
            partial = path.with_suffix(".part")
            partial.write_bytes(body)
            partial.replace(path)
        points = _read_las(path)
        inside = (
            (points[:, 0] >= window[0])
            & (points[:, 0] <= window[2])
            & (points[:, 1] >= window[1])
            & (points[:, 1] <= window[3])
        )
        parts.append(points[inside])
    return (np.vstack(parts) if parts else np.empty((0, 4))), fetched


def _points_file(source: Source, tile: Tile, crs: str, cache: Path) -> Path:
    key = hashlib.sha256(json.dumps([source.location, tile.bounds(), crs]).encode()).hexdigest()[:16]
    return cache / f"lidar-{key}-points.npy"


def _prepare(source: Source, tile: Tile, crs: str, cache: Path, get) -> tuple[np.ndarray, int]:
    """Points inside the tile in the site CRS, noise removed. Returns (points, bytes fetched)."""
    west, south, east, north = tile.bounds(CELL_M)
    fetched = 0
    if source.kind == "file":
        path = Path(source.location)
        if not path.is_file():
            raise FileNotFoundError(f"sources.lidar: {path} does not exist")
        points = _read_las(path)
    else:
        xs, ys = transform(crs, EPT_CRS, [west, east, west, east], [south, south, north, north])
        window = (min(xs), min(ys), max(xs), max(ys))
        key = hashlib.sha256(source.location.encode()).hexdigest()[:16]
        points, fetched = fetch_ept(source.location, window, cache / f"lidar-{key}", get)
        eastings, northings = transform(EPT_CRS, crs, points[:, 0].tolist(), points[:, 1].tolist())
        points = np.column_stack([eastings, northings, points[:, 2], points[:, 3]])
    keep = ~np.isin(points[:, 3], NOISE_CLASSES)
    keep &= (
        (points[:, 0] >= tile.west)
        & (points[:, 0] < tile.east)
        & (points[:, 1] >= tile.south)
        & (points[:, 1] < tile.north)
    )
    return np.ascontiguousarray(points[keep]), fetched


def load_points(source: Source, tile: Tile, crs: str, cache: Path, get=_get) -> np.ndarray:
    """Points over the tile. A point store is read once; afterwards the kept points come from the cache, offline."""
    if source.kind == "file":
        return _prepare(source, tile, crs, cache, get)[0]
    kept = _points_file(source, tile, crs, cache)
    if not kept.is_file():
        identify(source, tile, crs, cache, get)
    return np.load(kept)


def identify(source: Source, tile: Tile, crs: str, cache: Path, get=_get) -> dict:
    """The registry entry for the lidar source, with a hash of the points the build will use."""
    entry = {"kind": source.kind, "license": source.license, "date": source.date, "bytes_fetched": 0}
    if source.kind == "file":
        points = _prepare(source, tile, crs, cache, get)[0]
        entry["path"] = source.location
    else:
        entry["endpoint"] = source.location
        kept = _points_file(source, tile, crs, cache)
        if kept.is_file():
            points = np.load(kept)
        else:
            points, entry["bytes_fetched"] = _prepare(source, tile, crs, cache, get)
            cache.mkdir(parents=True, exist_ok=True)
            partial = kept.with_suffix(".part.npy")
            np.save(partial, points)
            partial.replace(kept)
    entry["points"] = len(points)
    entry["sha256"] = hashlib.sha256(points.tobytes()).hexdigest()
    return entry


def rasterise(points: np.ndarray, tile: Tile, elevation_m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(height above ground, ground gap), north-up at CELL_M. `elevation_m` is the elevation model on that grid."""
    cells = round(tile.size_m / CELL_M)
    columns = np.floor((points[:, 0] - tile.west) / CELL_M).astype(int)
    rows = np.floor((tile.north - points[:, 1]) / CELL_M).astype(int)
    highest = np.full((cells, cells), -np.inf)
    np.maximum.at(highest, (rows, columns), points[:, 2])
    height = np.where(np.isfinite(highest), highest - elevation_m, 0.0)
    measured = np.zeros((cells, cells), dtype=bool)
    ground = points[:, 3] == GROUND_CLASS
    measured[rows[ground], columns[ground]] = True
    if not measured.any():
        raise RuntimeError("the lidar source has no ground-classified returns inside the tile")
    gap = ndimage.distance_transform_edt(~measured) * CELL_M
    return height.astype(np.float32), gap.astype(np.float32)
