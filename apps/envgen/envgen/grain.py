"""Grain: what grass looks like at centimetre scale, measured from a survey orthophoto.

The tile's own photo is half a metre a pixel, so it shows no blade-scale texture: a field from a hundred metres is a
smear. A survey orthophoto at a couple of centimetres a pixel does show it. This module measures the grain in the
orthophoto's grass (how strong, how big, how it is distributed) and makes a small texture with the same statistics
that tiles without a seam, so the engine can lay it over every grass cell, inside the survey's footprint or not.

The grain is the log of each pixel's luminance over its own local low-pass. That ratio is a mean of one by
construction, so it adds texture without moving the colour the fitted albedo gave.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy import ndimage

# Pixels of the texture. Its side in metres is this times the orthophoto's pixel.
PIXELS = 1024
# The ratio is limited to a factor of two to this power either way; 8 bits, with 127 for no change.
LOG2_RANGE = 2.0
ZERO = 127
# Blocks of the orthophoto the grain is measured on, in pixels.
BLOCK_PX = 256
# Grain is what is finer than this. The tile's own photo carries what is coarser (its pixels are half a metre).
LOW_PASS_M = 0.3
# A prior: the survey's grass is a hay field and a lawn; the field being built is the lawn, so the grain is taken
# from the quietest quarter of the grass blocks (by their standard deviation), not from the tall, strong-textured rest.
QUIET_SHARE = 0.25
# A block is grass when every cell of the tile's grass weight under it is at least this.
GRASS_PURITY = 0.9
# Fewer blocks than this say nothing about the grain.
MIN_BLOCKS = 8
RADIAL_BINS = 64
QUANTILES = 1025
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# Priors: the lens a still is taken with, and how much of the grain is left on ground nearer than one texel a pixel. Up
# close the texture is magnified, so the grain turns to soft blotches; the tufts carry the texture there, and the grain
# fades in with distance from this share to all of it where a texel is a pixel across.
LENS_FOV_DEG = 90.0
FRAME_PX = 1920
NEAR_SHARE = 0.25


def sharp_distance_m(pixel_m: float) -> float:
    """How far from the camera one texel of the texture is one pixel of the frame across."""
    return pixel_m / (2 * math.tan(math.radians(LENS_FOV_DEG) / 2) / FRAME_PX)


PRIORS = [
    f"prior: stills have a {LENS_FOV_DEG:g} degree lens and {FRAME_PX} pixels across; closer than a texel a pixel the grain fades to {NEAR_SHARE:.0%}",
    f"prior: grain is what is finer than {LOW_PASS_M:g} m; the tile's own photo carries what is coarser",
    f"prior: the field's turf is like the quietest {QUIET_SHARE:.0%} of the survey's grass blocks, which are even and short",
    "prior: grain has no direction (its spectrum is averaged around the circle), so it can be laid at any turn",
]


@dataclass(frozen=True)
class Grain:
    """A tileable texture of the log2 luminance ratio, 8 bits, and what it was measured from."""

    encoded: np.ndarray
    pixel_m: float
    std_log2: float
    blocks_used: int
    blocks_seen: int
    block_std_range: tuple[float, float]


def to_linear(encoded: np.ndarray) -> np.ndarray:
    """sRGB tone curve to linear light, for 0 to 255 values."""
    v = encoded.astype(np.float32) / 255
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def _radial(power: np.ndarray, side: int, bins: int) -> np.ndarray:
    """The mean of the half spectrum of a `side` by `side` image in rings of equal width over 0 to 0.5 cycles per pixel."""
    ky = np.fft.fftfreq(side)[:, None]
    kx = np.fft.rfftfreq(side)[None, :]
    ring = np.minimum((np.hypot(ky, kx) / 0.5 * bins).astype(int), bins - 1)
    total = np.bincount(ring.ravel(), weights=power.ravel(), minlength=bins)
    count = np.bincount(ring.ravel(), minlength=bins)
    return total / np.maximum(count, 1)


def _block_grain(window: np.ndarray, pixel_m: float) -> np.ndarray:
    lum = np.tensordot(LUMA, to_linear(window[:3]), 1)
    low = ndimage.gaussian_filter(lum, LOW_PASS_M / pixel_m, mode="nearest")
    return np.log2(np.maximum(lum, 1e-4) / np.maximum(low, 1e-4))


def measure(
    orthophoto: Path,
    crs: str,
    west: float,
    north: float,
    size_m: float,
    grass: np.ndarray,
    seed: int,
) -> tuple[Grain | None, str]:
    """The grain of the orthophoto's grass, or None with the reason.

    `grass` is the tile's grass weight, north-up, square, with the tile's west and north edges at `west` and `north`.
    """
    cells = grass.shape[0]
    cell_m = size_m / cells
    with rasterio.open(orthophoto) as source:
        if str(source.crs) != crs:
            return None, f"the orthophoto is in {source.crs}, not the site's {crs}"
        if source.count < 4:
            return None, "the orthophoto has no alpha band to say where it has pixels"
        pixel_m = float(abs(source.transform.a))
        stds, spectra, samples, seen = [], [], [], 0
        window = np.hanning(BLOCK_PX)[:, None] * np.hanning(BLOCK_PX)[None, :]
        for row in range(0, source.height - BLOCK_PX + 1, BLOCK_PX):
            for column in range(0, source.width - BLOCK_PX + 1, BLOCK_PX):
                x0, y0 = source.transform @ (column + 0.5, row + 0.5)
                x1, y1 = source.transform @ (column + BLOCK_PX - 0.5, row + BLOCK_PX - 0.5)
                c0, c1 = int((min(x0, x1) - west) // cell_m), int((max(x0, x1) - west) // cell_m)
                r0, r1 = int((north - max(y0, y1)) // cell_m), int((north - min(y0, y1)) // cell_m)
                if c0 < 0 or r0 < 0 or c1 >= cells or r1 >= cells:
                    continue
                if grass[r0 : r1 + 1, c0 : c1 + 1].min() < GRASS_PURITY:
                    continue
                block = source.read([1, 2, 3, 4], window=Window(column, row, BLOCK_PX, BLOCK_PX))
                if block[3].min() < 255:
                    continue
                seen += 1
                g = _block_grain(block, pixel_m)
                stds.append(float(g.std()))
                spectra.append(_radial(np.abs(np.fft.rfft2((g - g.mean()) * window)) ** 2, BLOCK_PX, RADIAL_BINS))
                samples.append(g[::3, ::3].ravel())
    if seen < MIN_BLOCKS:
        return None, f"only {seen} blocks of the orthophoto are pure grass with pixels all over; {MIN_BLOCKS} needed"
    keep = np.argsort(stds)[: max(MIN_BLOCKS, int(seen * QUIET_SHARE))]
    spectrum = np.mean([spectra[i] for i in keep], axis=0)
    values = np.concatenate([samples[i] for i in keep])
    quantiles = np.quantile(values, np.linspace(0, 1, QUANTILES))
    # The spectrum sets how the grain is correlated; the measured distribution sets how strong and how skewed it is.
    field = _synthesise(spectrum, quantiles, seed)
    mean_gain = np.log2(np.mean(2**field))
    field = field - mean_gain
    encoded = np.clip(np.rint(ZERO + ZERO * field / LOG2_RANGE), 0, 255).astype(np.uint8)
    return (
        Grain(encoded, pixel_m, float(field.std()), len(keep), seen, (float(min(stds)), float(max(stds)))),
        "",
    )


def _synthesise(spectrum: np.ndarray, quantiles: np.ndarray, seed: int) -> np.ndarray:
    """A tileable field with the given radial power spectrum and, after a rank map, the given distribution."""
    rng = np.random.default_rng(seed)
    noise = np.fft.rfft2(rng.standard_normal((PIXELS, PIXELS)))
    ky = np.fft.fftfreq(PIXELS)[:, None]
    kx = np.fft.rfftfreq(PIXELS)[None, :]
    radius = np.hypot(ky, kx)
    centres = (np.arange(RADIAL_BINS) + 0.5) / RADIAL_BINS * 0.5
    amplitude = np.sqrt(np.interp(radius, centres, spectrum))
    amplitude[0, 0] = 0
    field = np.fft.irfft2(noise * amplitude, s=(PIXELS, PIXELS))
    # Rank map: each pixel takes the measured distribution's value at its own rank.
    ranks = np.argsort(np.argsort(field.ravel())) / (field.size - 1)
    return np.interp(ranks, np.linspace(0, 1, len(quantiles)), quantiles).reshape(field.shape)


def decode(encoded: np.ndarray) -> np.ndarray:
    """The log2 ratio an encoded texture holds."""
    return (encoded.astype(np.float32) - ZERO) * LOG2_RANGE / ZERO
