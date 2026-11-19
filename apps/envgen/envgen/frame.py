"""The Unreal frame and height encoding. Everything about axes and units lives here.

World frame: X = grid north, Y = grid east, Z = up, centimetres, origin at the tile centre.
That is a left-handed frame, which is what Unreal uses, and it maps to NED by negating Z.

A Landscape heightmap is indexed [row, column] = [Y, X], so a north-up raster
(row 0 = north edge, column 0 = west edge) becomes [east index, north index].
"""

from __future__ import annotations

import math

import numpy as np

HEIGHT_MID = 32768
# A Landscape at Z scale 100 spans 512 m in 65536 steps: one step is 1/128 of the Z scale, in cm.
STEPS_PER_SCALE_UNIT = 128
DEFAULT_Z_SCALE = 100.0

FRAME = "X=grid north, Y=grid east, Z=up; centimetres; origin at the tile centre"


def to_unreal_layout(north_up: np.ndarray) -> np.ndarray:
    """Reorder a north-up raster so that rows run east and columns run north."""
    return np.ascontiguousarray(np.swapaxes(north_up[::-1], 0, 1))


def z_scale_for(relief_m: float) -> float:
    """The smallest Z scale, at least the default, whose range holds the relief."""
    span_m = 65535 / STEPS_PER_SCALE_UNIT / 100.0 * DEFAULT_Z_SCALE
    if relief_m <= span_m:
        return DEFAULT_Z_SCALE
    return float(math.ceil(DEFAULT_Z_SCALE * relief_m / span_m))


def encode_heights(elevation_m: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Encode metres as Landscape uint16. Returns (heights, mid elevation in metres, Z scale)."""
    low, high = float(elevation_m.min()), float(elevation_m.max())
    mid = (low + high) / 2
    z_scale = z_scale_for(high - low)
    steps = (elevation_m - mid) * 100.0 * STEPS_PER_SCALE_UNIT / z_scale
    return np.clip(np.rint(steps) + HEIGHT_MID, 0, 65535).astype(np.uint16), mid, z_scale


def decode_heights(heights: np.ndarray, mid_m: float, z_scale: float) -> np.ndarray:
    return (heights.astype(np.float64) - HEIGHT_MID) * z_scale / STEPS_PER_SCALE_UNIT / 100.0 + mid_m
