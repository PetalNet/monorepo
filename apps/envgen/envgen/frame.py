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


def sample_heightmap(heights: np.ndarray, surface: dict, points_enu_m: np.ndarray) -> np.ndarray:
    """Sample exported Landscape triangle planes, returning up metres above the common origin.

    Heights use Unreal layout [east, north]. Each quad's diagonal joins its low/low
    and high/high corners. Coordinates outside the surface are errors, never edge clamps.
    """
    points = np.asarray(points_enu_m, dtype=np.float64)
    location, scale = np.asarray(surface["location_cm"]), np.asarray(surface["scale"])
    size = surface["vertices"]
    if (
        heights.shape != (size, size) or size < 2 or heights.dtype != np.uint16
        or points.ndim != 2 or points.shape[1] != 2 or not np.isfinite(points).all()
        or location.shape != (3,) or scale.shape != (3,)
        or not np.isfinite(location).all() or not np.isfinite(scale).all() or np.any(scale <= 0)
    ):
        raise ValueError("invalid Landscape heightmap, transform or ENU samples")
    east = (points[:, 0] * 100 - location[1]) / scale[1]
    north = (points[:, 1] * 100 - location[0]) / scale[0]
    if np.any((east < 0) | (north < 0) | (east > size - 1) | (north > size - 1)):
        raise ValueError("terrain sample outside exported Landscape")
    e0 = np.minimum(np.floor(east).astype(int), size - 2)
    n0 = np.minimum(np.floor(north).astype(int), size - 2)
    e, n = east - e0, north - n0
    h00 = heights[e0, n0].astype(np.float64)
    h10 = heights[e0 + 1, n0].astype(np.float64)
    h01 = heights[e0, n0 + 1].astype(np.float64)
    h11 = heights[e0 + 1, n0 + 1].astype(np.float64)
    steps = np.where(n >= e, h00 + n * (h01 - h00) + e * (h11 - h01),
                     h00 + e * (h10 - h00) + n * (h11 - h10))
    return location[2] / 100 + (steps - HEIGHT_MID) * scale[2] / STEPS_PER_SCALE_UNIT / 100
