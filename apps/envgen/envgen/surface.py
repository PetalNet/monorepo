"""Surface classes: what kind of ground each cell is, as Landscape layer weights.

The classes are told apart from the colour of the imagery alone. It is the simplest rule that
separates turf from roads and lots; it calls bare soil and water paved.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

# Layer names, in the order their weightmaps are written. The engine side knows how each one looks.
CLASSES = ("grass", "paved")

# Vegetation, green or dry, reflects more green than blue; pavement is close to neutral. Both differences
# are a share of the cell's brightness. Late-summer turf reaches only about 0.04 green over blue.
GREEN_OVER_BLUE_MIN = 0.025
# Brick, clay and red tracks also reflect little blue, but clearly more red than green.
RED_OVER_GREEN_MAX = 0.045
# Colour is averaged over this distance before it is judged, which drops cars, paint and noise.
CLEAN_M = 5.0
# A cell needs this share of its neighbourhood in view to be classified from it.
SEEN_MIN = 0.5
# A patch of one class smaller than this, alone inside the other, is taken to be a mistake.
PATCH_MIN_M2 = 400.0
# Classes blend into each other over about this distance.
EDGE_M = 1.0
PARAMETERS = (GREEN_OVER_BLUE_MIN, RED_OVER_GREEN_MAX, CLEAN_M, SEEN_MIN, PATCH_MIN_M2, EDGE_M)


def green(rgb: np.ndarray) -> np.ndarray:
    """Which cells have the colour of vegetation. `rgb` is (bands, rows, columns)."""
    red, green, blue = rgb
    brightness = np.maximum(red + green + blue, 1.0)
    return ((green - blue) / brightness > GREEN_OVER_BLUE_MIN) & ((red - green) / brightness < RED_OVER_GREEN_MAX)


def grass_fraction(rgb: np.ndarray, in_view: np.ndarray, spacing: float) -> np.ndarray:
    """How much of each cell is grass, 0 to 1; the rest is paved.

    `in_view` marks cells that show sunlit ground. Cover hides the ground and shade takes its colour
    away, so those cells take the class of the nearest ground in view.
    """
    if rgb.shape[0] < 3:
        # Grey imagery cannot tell the classes apart, so the whole tile keeps the one grass layer.
        return np.ones(rgb.shape[1:], dtype=np.float32)
    red, green, blue = rgb
    brightness = np.maximum(red + green + blue, 1.0)
    window = max(1, round(CLEAN_M / spacing)) | 1

    def nearby(values: np.ndarray) -> np.ndarray:
        return ndimage.uniform_filter((values * in_view).astype(np.float32), window, mode="nearest")

    seen = nearby(np.ones_like(brightness))
    grass = (nearby((green - blue) / brightness) > GREEN_OVER_BLUE_MIN * seen) & (
        nearby((red - green) / brightness) < RED_OVER_GREEN_MAX * seen
    )
    known = seen > SEEN_MIN
    if known.any() and not known.all():
        nearest = ndimage.distance_transform_edt(~known, return_distances=False, return_indices=True)
        grass = grass[tuple(nearest)]
    for is_grass in (False, True):
        patches, count = ndimage.label(grass == is_grass)
        cells = np.bincount(patches.ravel(), minlength=count + 1)
        small = (cells * spacing**2 < PATCH_MIN_M2)[patches] & (patches > 0)
        grass[small] = not is_grass
    return ndimage.gaussian_filter(grass.astype(np.float32), EDGE_M / spacing, mode="nearest")


def weights(grass: np.ndarray) -> dict[str, np.ndarray]:
    """8-bit weights per class, which sum to 255 in every cell."""
    grass_weight = np.rint(np.clip(grass, 0.0, 1.0) * 255).astype(np.uint8)
    return {"grass": grass_weight, "paved": 255 - grass_weight}
