"""Native survey masks and ground colour, with alpha retaining the coarse imagery outside coverage."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
from rasterio.windows import Window
from scipy import ndimage

from . import surface

NAMES = [surface.GRASS, surface.PAVED, surface.SOIL]
SETTINGS = {
    "fit_cell_m": 0.5,
    "smooth_m": 0.06,
    "colour_cell_m": 0.25,
    "canopy_min_m": 2.0,
    "block_pixels": 512,
    "fit_max_pixels": 1_000_000,
    "colour_max_pixels": 4_000_000,
    "gdal_cache_mb": 64,
}


def masks(rgb: np.ndarray, alpha: np.ndarray, height: np.ndarray, ground: np.ndarray,
          splits: list[dict], cell_m: float, hidden: np.ndarray | None = None,
          transform=None, evidence: dict | None = None) -> np.ndarray:
    """Premultiplied grass, paving, soil and canopy shares; the first three sum to coverage."""
    labels = surface.apply_splits(rgb.astype(np.float32), None, splits)
    valid = alpha > 0
    canopy = (labels == 0) & (height > SETTINGS["canopy_min_m"]) & valid
    labels = np.where(canopy | (hidden if hidden is not None else False), ground, labels)
    sigma = max(SETTINGS["smooth_m"] / cell_m, 0.5)
    support = ndimage.gaussian_filter(alpha.astype(np.float32), sigma)
    shares = np.stack([
        ndimage.gaussian_filter((labels == index) * alpha, sigma) / np.maximum(support, 1e-6)
        for index in range(3)
    ] + [ndimage.gaussian_filter(canopy * alpha, sigma) / np.maximum(support, 1e-6)])
    if evidence:
        from .observations import exposed_fragments
        bare = exposed_fragments(rgb, alpha, height, transform, evidence)
        if hidden is not None:
            bare = np.where(hidden, 0, bare)
        shares[:3] *= 1 - bare
        shares[2] += bare
    return (shares * alpha[None]).astype(np.float32)


def sample(path: Path, tile, crs: str, size: int) -> np.ndarray:
    """Average premultiplied mask bands onto Landscape vertices, keeping zero beyond the footprint."""
    target = np.zeros((4, size, size), dtype=np.float32)
    spacing = tile.size_m / (size - 1)
    with rasterio.open(path) as source:
        for band in range(4):
            reproject(rasterio.band(source, band + 1), target[band],
                      dst_transform=from_origin(tile.west-spacing/2, tile.north+spacing/2, spacing, spacing),
                      dst_crs=crs, dst_nodata=0, resampling=Resampling.average)
    return target / 255


def blend(weights: np.ndarray, names: list[str], sampled: np.ndarray) -> tuple[np.ndarray, list[str]]:
    """Survey ground shares replace fallback weights by coverage, including fractional alpha edges."""
    coverage = np.clip(sampled[:3].sum(axis=0), 0, 1)
    combined = np.zeros_like(sampled[:3])
    for index, name in enumerate(NAMES):
        fallback = weights[names.index(name)] if name in names else 0
        combined[index] = sampled[index] + fallback * (1 - coverage)
    combined /= np.maximum(combined.sum(axis=0), 1e-6)
    return combined, NAMES.copy()


def _shape(width: int, height: int, pixel_m: float, cell_m: float, limit: int) -> tuple[int, int]:
    factor = max(1, cell_m / pixel_m, math.sqrt(width * height / limit), width / limit, height / limit)
    return max(1, math.floor(height / factor)), max(1, math.floor(width / factor))


def write_png(raster: Path, path: Path) -> None:
    """Stream a TIFF into [east, north] PNG rows without materialising the transposed native raster."""
    def chunk(file, kind, data):
        file.write(struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data)))

    with rasterio.Env(GDAL_CACHEMAX=SETTINGS["gdal_cache_mb"] * 1024**2), \
            rasterio.open(raster) as source, path.open("wb") as target:
        target.write(b"\x89PNG\r\n\x1a\n")
        colour_type = {1: 0, 4: 6}[source.count]
        chunk(target, b"IHDR", struct.pack("!IIBBBBB", source.height, source.width, 8, colour_type, 0, 0, 0))
        compressor = zlib.compressobj()
        # A batch is at most one million pixels; a scanline itself necessarily spans the image height.
        columns = max(1, min(64, 1_000_000 // source.height))
        for first in range(0, source.width, columns):
            data = source.read(window=Window(first, 0, min(columns, source.width-first), source.height))
            for column in range(data.shape[2]):
                row = data[:, ::-1, column].T.tobytes()
                encoded = compressor.compress(b"\0" + row)
                if encoded:
                    chunk(target, b"IDAT", encoded)
        chunk(target, b"IDAT", compressor.flush())
        chunk(target, b"IEND", b"")


def build(path: Path, out: Path, tile, crs: str, labels: np.ndarray, names: list[str],
          height: np.ndarray, shown: np.ndarray, clean_colour, evidence: dict | None = None) -> dict:
    """Fit on bounded pooled grids, classify native windows with halos, then clean pooled ground colour."""
    with rasterio.Env(GDAL_CACHEMAX=SETTINGS["gdal_cache_mb"] * 1024**2), rasterio.open(path) as source:
        if (source.crs != rasterio.crs.CRS.from_string(crs) or source.count < 4
                or source.transform.b or source.transform.d or source.transform.a <= 0
                or source.transform.e >= 0
                or any(dtype != "uint8" for dtype in source.dtypes[:4])):
            return {"files": [], "skipped": "survey masks require north-up uint8 RGBA imagery in the site CRS"}
        pixel_m = float(source.transform.a)
        ground = np.array([NAMES.index(name) for name in names], dtype=np.uint8)[labels]

        def onto(values, transform, shape, resampling=Resampling.nearest):
            result = np.zeros(shape, dtype=np.float32)
            spacing = tile.size_m / (values.shape[0] - 1)
            reproject(values.astype(np.float32), result,
                      src_transform=from_origin(tile.west-spacing/2, tile.north+spacing/2, spacing, spacing),
                      src_crs=crs, dst_transform=transform, dst_crs=source.crs, resampling=resampling)
            return result

        def pooled(cell_m, limit):
            shape = _shape(source.width, source.height, pixel_m, cell_m, limit)
            data = source.read([1, 2, 3, 4], out_shape=(4, *shape), resampling=Resampling.average)
            transform = source.transform * source.transform.scale(source.width/shape[1], source.height/shape[0])
            return data, transform

        data, transform = pooled(SETTINGS["fit_cell_m"], SETTINGS["fit_max_pixels"])
        shape = data.shape[1:]
        visible = ((data[3] >= 250) & (onto(height, transform, shape) < SETTINGS["canopy_min_m"])
                   & (onto(shown, transform, shape) > 0.5))
        _, _, fit = surface.classify(data[:3].astype(np.float32), visible, float(transform.a))
        profile = source.profile | {"driver": "GTiff", "count": 4, "dtype": "uint8", "nodata": None,
                                    "compress": "deflate", "tiled": True, "blockxsize": 256, "blockysize": 256}
        sigma = max(SETTINGS["smooth_m"] / pixel_m, 0.5)
        pad = math.ceil(4 * sigma)
        block = SETTINGS["block_pixels"]
        with rasterio.open(out / "ortho_masks.tif", "w", **profile) as target:
            # Canopy is data, not alpha: GDAL must not mask out open ground on reprojection.
            target.colorinterp = (ColorInterp.gray,) + (ColorInterp.undefined,) * 3
            for row in range(0, source.height, block):
                for column in range(0, source.width, block):
                    left, top = max(0, column-pad), max(0, row-pad)
                    right, bottom = min(source.width, column+block+pad), min(source.height, row+block+pad)
                    window = Window(left, top, right-left, bottom-top)
                    data = source.read([1, 2, 3, 4], window=window)
                    transform = source.window_transform(window)
                    shares = masks(data[:3], data[3].astype(np.float32)/255,
                                   onto(height, transform, data.shape[1:], Resampling.bilinear),
                                   onto(ground, transform, data.shape[1:]).astype(np.uint8),
                                   fit["splits"], pixel_m, onto(shown, transform, data.shape[1:]) < 0.5,
                                   transform, evidence)
                    rows, columns = min(block, source.height-row), min(block, source.width-column)
                    encoded = np.rint(shares[:, row-top:row-top+rows, column-left:column-left+columns]*255)
                    # Encode coverage exactly in the sum of RGB, even at blended class edges.
                    coverage = data[3, row-top:row-top+rows, column-left:column-left+columns].astype(np.int16)
                    ground_bytes = encoded[:3].astype(np.int16)
                    largest = np.argmax(ground_bytes, axis=0)
                    correction = coverage-ground_bytes.sum(axis=0)
                    for index in range(3):
                        ground_bytes[index] += np.where(largest == index, correction, 0).astype(np.int16)
                    encoded[:3] = ground_bytes
                    target.write(encoded.astype(np.uint8), window=Window(column, row, columns, rows))
        colour, transform = pooled(SETTINGS["colour_cell_m"], SETTINGS["colour_max_pixels"])
        shape = colour.shape[1:]
        visible = ((colour[3] >= 250) & (onto(height, transform, shape) < SETTINGS["canopy_min_m"])
                   & (onto(shown, transform, shape) > 0.5))
        own = surface.apply_splits(colour[:3].astype(np.float32), None, fit["splits"])
        own = np.where(visible, own, onto(ground, transform, shape).astype(np.uint8))
        cleaned, report = clean_colour(colour[:3], visible, own, float(transform.a))
        linear = surface.to_linear(cleaned.astype(np.float32))
        means = {name: np.maximum(np.mean(linear[:, visible & (own == index)], axis=1), 1e-4).tolist()
                 for index, name in enumerate(NAMES) if (visible & (own == index)).any()}
        colour[:3] = np.clip(np.rint(cleaned), 0, 255).astype(np.uint8)
        # No visible ground means no evidence for colour. Keep the coarse imagery in that case.
        if not visible.any():
            colour[3] = 0
        with rasterio.open(out / "ortho_colour.tif", "w", **(profile | {"width": shape[1], "height": shape[0],
                            "transform": transform})) as target:
            target.write(colour)
            target.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)
        bounds = source.bounds
        width, height_px = source.width, source.height
        pixel_size_m = [pixel_m, float(-source.transform.e)]
    write_png(out / "ortho_masks.tif", out / "ortho_masks.png")
    write_png(out / "ortho_colour.tif", out / "ortho_colour.png")
    return {"files": ["ortho_masks.tif", "ortho_masks.png", "ortho_colour.tif", "ortho_colour.png"],
            "file": "ortho_masks.png", "raster": "ortho_masks.tif", "colour": "ortho_colour.png",
            "colour_raster": "ortho_colour.tif", "colour_pixels": [shape[1], shape[0]],
            "colour_pixel_m": float(transform.a), "colour_processing": report, "mean_linear_rgb": means,
            "channels": NAMES + ["canopy"], "pixel_m": pixel_m, "pixels": [width, height_px],
            "pixel_size_m": pixel_size_m,
            "west_m": bounds.left-tile.west, "south_m": bounds.bottom-tile.south,
            "east_extent_m": bounds.right-bounds.left, "north_extent_m": bounds.top-bounds.bottom,
            "classification": fit, "settings": SETTINGS,
            "fragment_classifier": evidence.get("ground_classifier") if evidence else None,
            "mask_encoding": "linear UNorm; RGB sum is coverage; A is independent canopy coverage",
            "colour_encoding": "sRGB RGB; A is survey coverage; zero alpha keeps coarse imagery",
            "priors": ["RGB splits fitted to sunlit survey ground; dry grass and bare soil may be ambiguous",
                       "canopy requires vegetation and height above 2 m; hidden ground keeps its coarse class",
                       "masks keep native pixels with 6 cm smoothing; pooled colour has no invented detail",
                       "pooled grids are capped for memory; actual colour pixel size is reported"]}
