"""Surface classes: what kind of ground each cell is, fitted to the imagery, as Landscape layer weights.

Nothing here knows a colour. Each split is a threshold fitted to the colours of the sunlit ground in this
tile (Otsu's method), and it is only made when the two groups form patches rather than noise. Cover and shade
hide the ground's colour, so those cells take the class of the nearest ground that shows it.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

# Order matters: it is the order of the layers in the manifest. The engine side has a look for each name.
GRASS, PAVED, SOIL = "grass", "paved", "soil"

# Vegetation reflects more green than blue; pavement and soil do not. Soil and clay reflect more red than blue.
# Both are shares of the cell's brightness, so a shaded or dim cell of the same material gives the same value.
GREEN_INDEX = "(G - B) / (R + G + B)"
RED_INDEX = "(R - B) / (R + G + B)"

# A split is made only when the cells it separates form patches. Noise in one population cut at a threshold
# gives salt and pepper; two kinds of ground give blocks. Coherence is how far the share of neighbouring cells
# that agree rises above what random placement of the same shares would give: 0 for random, 1 for blocks.
# (Ashman's D, the distance between the two groups in pooled standard deviations, cannot tell the cases
# apart on a real tile: one Gaussian cut at its mean scores 2.7, and a real tile of turf and pavement 2.1.)
# Hand-set criterion.
COHERENCE_MIN = 0.5
# A group must cover at least this much ground, or the fit is describing noise. Hand-set.
GROUP_MIN_M2 = 1000.0
PERFECT_SEPARATION = 1e6
# Class edges blend over about this distance. A look, not a measurement.
EDGE_M = 1.0
# The class of a cell is the majority within this many cells around it (3 by 3).
MAJORITY_CELLS = 3

# What is assumed where the data cannot say, listed in the manifest as priors.
PRIOR_SINGLE_CLASS = GRASS


def indices(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Green index, red index and brightness. `rgb` is (bands, rows, columns)."""
    red, green, blue = rgb[0], rgb[1], rgb[2]
    total = np.maximum(red + green + blue, 1.0)
    return (green - blue) / total, (red - blue) / total, total / 3


def otsu(values: np.ndarray, weights: np.ndarray) -> tuple[float, float]:
    """The threshold that best splits `values` in two, and Ashman's D for the two groups it makes.

    Exact, over the sorted values: a histogram's bin width is set by the extremes, and a few outlying cells
    would blur the cut. Each value counts by its weight.
    """
    order = np.argsort(values)
    ordered, weight = values[order].astype(np.float64), weights[order].astype(np.float64)
    if len(ordered) < 2 or ordered[0] == ordered[-1]:
        return float(ordered[0]), 0.0
    total_weight, total = np.cumsum(weight), np.cumsum(weight * ordered)
    below, above = total_weight[:-1], total_weight[-1] - total_weight[:-1]
    mean_below = total[:-1] / below
    mean_above = (total[-1] - total[:-1]) / above
    # Between-group variance for a cut after each value.
    between = below * above * (mean_above - mean_below) ** 2
    between[ordered[1:] == ordered[:-1]] = -1  # a cut must fall between different values
    cut = int(np.argmax(between))
    threshold = float((ordered[cut] + ordered[cut + 1]) / 2)

    def spread(part: slice) -> tuple[float, float]:
        mean = np.average(ordered[part], weights=weight[part])
        return mean, np.average((ordered[part] - mean) ** 2, weights=weight[part])

    (low, low_var), (high, high_var) = spread(slice(None, cut + 1)), spread(slice(cut + 1, None))
    # Groups with no spread at all are as separate as they can be; a large finite number keeps the manifest valid JSON.
    return threshold, float(
        np.sqrt(2) * (high - low) / np.sqrt(low_var + high_var)
    ) if low_var + high_var else PERFECT_SEPARATION


def coherence(upper: np.ndarray, mask: np.ndarray) -> float:
    """How far neighbouring cells agree on which side of a split they are on, beyond what chance gives. 0 to 1."""
    both_east = mask[:, 1:] & mask[:, :-1]
    both_north = mask[1:] & mask[:-1]
    pairs = both_east.sum() + both_north.sum()
    if not pairs:
        return 0.0
    agree = ((upper[:, 1:] == upper[:, :-1]) & both_east).sum() + ((upper[1:] == upper[:-1]) & both_north).sum()
    share = upper[mask].mean()
    chance = share**2 + (1 - share) ** 2
    return float((agree / pairs - chance) / (1 - chance)) if chance < 1 else 0.0


def _split(
    values: np.ndarray, weights: np.ndarray, mask: np.ndarray, cell_m: float, what: str, index: str
) -> tuple[float | None, dict]:
    """Fit one threshold to the masked cells. Returns it, or None when they are not two kinds of ground, with why."""
    record = {"index": index, "fitted_to": what, "cells": int(mask.sum())}
    minimum = GROUP_MIN_M2 / cell_m**2
    if mask.sum() < 2 * minimum:
        return None, record | {"split": False, "reason": "too few cells"}
    threshold, separation = otsu(values[mask], weights[mask])
    upper = (values >= threshold) & mask
    count = int(upper.sum())
    record |= {"threshold": threshold, "separation": separation, "upper_fraction": count / int(mask.sum())}
    if min(count, int(mask.sum()) - count) < minimum:
        return None, record | {"split": False, "reason": "a group is too small"}
    record["coherence"] = coherence(upper, mask)
    if record["coherence"] < COHERENCE_MIN:
        return None, record | {"split": False, "reason": "the groups do not form patches"}
    return threshold, record | {"split": True}


def classify(rgb: np.ndarray, sunlit: np.ndarray, cell_m: float) -> tuple[np.ndarray, list[str], dict]:
    """A class for every cell. Returns the class index map, the class names and what was fitted.

    `sunlit` marks cells whose imagery shows ground in sunlight; only those are fitted to and read.
    """
    shape = rgb.shape[1:]
    shown = sunlit.astype(bool)
    if rgb.shape[0] < 3 or not shown.any():
        reason = "grey imagery" if rgb.shape[0] < 3 else "no sunlit ground"
        return (
            np.zeros(shape, dtype=np.uint8),
            [PRIOR_SINGLE_CLASS],
            {"splits": [], "priors": [f"prior: one class, {PRIOR_SINGLE_CLASS}; {reason}"]},
        )
    green, red, brightness = indices(rgb)
    # Each cell counts in a fit by its brightness: an index is a ratio, so it is noisiest where the cell is dark,
    # and dark roofs and asphalt, which lean blue, must not decide where the cut falls.
    what = "sunlit cells"
    splits = []
    greener, record = _split(green, brightness, shown, cell_m, what, GREEN_INDEX)
    splits.append(record | {"separates": "grass from other ground"})
    labels = np.zeros(shape, dtype=np.uint8)
    names = [PRIOR_SINGLE_CLASS]
    priors = []
    if greener is None:
        priors.append(
            f"prior: one class, {PRIOR_SINGLE_CLASS}; the sunlit ground does not split into patches of two colours"
        )
    else:
        names = [GRASS, PAVED]
        labels[:] = np.where(green >= greener, 0, 1)
        other = shown & (labels == 1)
        # Dark roofs and asphalt, which lean blue, would decide the spread of redness. Soil is looked for among the
        # redder half of the rest, where it is either set apart from neutral paving or not there.
        bright = other & (red >= np.median(red[other])) if other.any() else other
        if bright.any():
            redder, record = _split(
                red, brightness, bright, cell_m, "the redder half of the sunlit cells that are not grass", RED_INDEX
            )
        else:
            redder, record = None, {"index": RED_INDEX, "split": False, "reason": "no bright ground", "cells": 0}
        splits.append(record | {"separates": "soil from paved"})
        if redder is not None:
            names.append(SOIL)
            labels[(labels == 1) & (red >= redder)] = 2
    # Ground the imagery does not show takes the class of the nearest ground it does.
    nearest = ndimage.distance_transform_edt(~shown, return_distances=False, return_indices=True)
    labels = labels[tuple(nearest)]
    return labels, names, {"splits": splits, "priors": priors}


def weights(labels: np.ndarray, count: int, cell_m: float) -> list[np.ndarray]:
    """8-bit weights per class, which sum to 255 in every cell.

    A cell's class is the majority around it, so the class edge lands on the edge in the imagery rather than
    where an average of the two sides would cross a threshold. The edge is then softened a little.
    """
    one_hot = np.stack([(labels == index).astype(np.float32) for index in range(count)])
    majority = np.argmax([ndimage.uniform_filter(layer, MAJORITY_CELLS, mode="nearest") for layer in one_hot], axis=0)
    one_hot = np.stack([(majority == index).astype(np.float32) for index in range(count)])
    soft = np.stack([ndimage.gaussian_filter(layer, EDGE_M / cell_m / 2, mode="nearest") for layer in one_hot])
    soft /= soft.sum(axis=0)
    scaled = np.rint(soft * 255).astype(np.int16)
    # Rounding can leave the sum a unit or two off; the largest weight absorbs it.
    largest = np.argmax(scaled, axis=0)[None]
    np.put_along_axis(scaled, largest, np.take_along_axis(scaled, largest, 0) + 255 - scaled.sum(axis=0), 0)
    return [layer.astype(np.uint8) for layer in scaled]


CHECK_POINTS_PER_KIND = 3


def check_points(layers: list[np.ndarray], names: list[str]) -> list[dict]:
    """Where the engine should find each class, worked out here from the weightmaps by position.

    The level build reads the merged weights back at these Landscape vertices and compares them with what
    this says, so a swapped, dropped or transposed layer fails it, which comparing a layer with its own
    file cannot. `layers` are indexed [east, north], as a Landscape reads them. For each class there are points
    well inside it, and there are points on class edges, where a shifted import would show.
    """
    stack = np.stack(layers)
    edge = stack.max(axis=0) < 255
    # Well inside: the class has full weight on the cell and on every cell around it.
    inside = np.stack([ndimage.minimum_filter(layer, size=3, mode="nearest") == 255 for layer in layers])
    chosen: list[tuple[int, int]] = []
    for kind in [*inside, edge]:
        cells = np.flatnonzero(kind)
        if len(cells):
            quantiles = np.linspace(0.1, 0.9, CHECK_POINTS_PER_KIND)
            chosen += [tuple(np.unravel_index(cells[int(q * (len(cells) - 1))], kind.shape)) for q in quantiles]
    return [
        {
            "east": int(east),
            "north": int(north),
            "weights": {name: int(layer[east, north]) for name, layer in zip(names, layers, strict=True)},
        }
        for east, north in dict.fromkeys(chosen)
    ]
