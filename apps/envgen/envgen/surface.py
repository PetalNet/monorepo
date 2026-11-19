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

# A split is made only when the colours are two populations and the cells of each form patches.
# Two populations: a two-component Gaussian mixture is fitted to the colours, and its components must sit at least
# this many pooled standard deviations apart (Ashman's D; above 2 the mixture has two modes, below it one wide
# population). D of the two halves of one Gaussian cut at its mean is 2.7, so D is taken from the fitted
# components, not from the cut. Hand-set criterion, from the literature.
SEPARATION_MIN = 2.0
# Patches: noise in one population cut at a threshold gives salt and pepper; two kinds of ground give blocks.
# Coherence is how far the share of neighbouring cells that agree rises above what random placement of the same
# shares would give: 0 for random, 1 for blocks. Hand-set criterion.
COHERENCE_MIN = 0.5
# The mixture is fitted to at most this many cells, evenly spread through the sorted values, and for this many rounds.
MIXTURE_SAMPLE = 100_000
MIXTURE_ITERATIONS = 60
# A group must cover at least this much ground, or the fit is describing noise. Hand-set.
GROUP_MIN_M2 = 1000.0
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


def otsu(values: np.ndarray, weights: np.ndarray) -> float:
    """The threshold that best splits `values` in two, each value counting by its weight.

    Exact, over the sorted values: a histogram's bin width is set by the extremes, and a few outlying cells
    would blur the cut.
    """
    order = np.argsort(values)
    ordered, weight = values[order].astype(np.float64), weights[order].astype(np.float64)
    if len(ordered) < 2 or ordered[0] == ordered[-1]:
        return float(ordered[0])
    total_weight, total = np.cumsum(weight), np.cumsum(weight * ordered)
    below, above = total_weight[:-1], total_weight[-1] - total_weight[:-1]
    mean_below = total[:-1] / below
    mean_above = (total[-1] - total[:-1]) / above
    # Between-group variance for a cut after each value.
    between = below * above * (mean_above - mean_below) ** 2
    between[ordered[1:] == ordered[:-1]] = -1  # a cut must fall between different values
    cut = int(np.argmax(between))
    return float((ordered[cut] + ordered[cut + 1]) / 2)


def mixture_separation(values: np.ndarray, weights: np.ndarray, threshold: float) -> tuple[float, dict]:
    """Fit two Gaussians to the values, starting from the groups a threshold makes, and say how far apart they are.

    Returns Ashman's D for the fitted components, and the components. One population fits as two overlapping
    components and scores low; two populations score high however the cut halves them.
    """
    if len(values) > MIXTURE_SAMPLE:
        keep = np.linspace(0, len(values) - 1, MIXTURE_SAMPLE).astype(int)
        values, weights = values[keep], weights[keep]
    values, weights = values.astype(np.float64), weights.astype(np.float64)
    low = values < threshold
    means = np.array([np.average(values[low], weights=weights[low]), np.average(values[~low], weights=weights[~low])])
    variances = np.array(
        [
            np.average((values[group] - mean) ** 2, weights=weights[group])
            for group, mean in ((low, means[0]), (~low, means[1]))
        ]
    )
    shares = np.array([weights[low].sum(), weights[~low].sum()]) / weights.sum()
    floor = 1e-6 * values.var() + 1e-12
    for _ in range(MIXTURE_ITERATIONS):
        density = (
            shares
            * np.exp(-((values[:, None] - means) ** 2) / (2 * np.maximum(variances, floor)))
            / np.sqrt(np.maximum(variances, floor))
        )
        responsibility = density / np.maximum(density.sum(axis=1, keepdims=True), 1e-300) * weights[:, None]
        mass = responsibility.sum(axis=0)
        shares = mass / mass.sum()
        means = (responsibility * values[:, None]).sum(axis=0) / mass
        variances = np.maximum((responsibility * (values[:, None] - means) ** 2).sum(axis=0) / mass, floor)
    spread = np.sqrt(variances.sum())
    separation = float(np.sqrt(2) * abs(means[1] - means[0]) / spread)
    order = np.argsort(means)
    return separation, {
        "means": [float(means[i]) for i in order],
        "sigmas": [float(np.sqrt(variances[i])) for i in order],
        "shares": [float(shares[i]) for i in order],
    }


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
    threshold = otsu(values[mask], weights[mask])
    upper = (values >= threshold) & mask
    count = int(upper.sum())
    record |= {"threshold": threshold, "upper_fraction": count / int(mask.sum())}
    if min(count, int(mask.sum()) - count) < minimum:
        return None, record | {"split": False, "reason": "a group is too small"}
    record["coherence"] = coherence(upper, mask)
    record["separation"], record["mixture"] = mixture_separation(values[mask], weights[mask], threshold)
    if record["separation"] < SEPARATION_MIN:
        return None, record | {"split": False, "reason": "one population: the fitted components overlap"}
    if record["mixture"]["means"][1] <= 0:
        # Soil is redder than blue and turf greener than blue; a group merely less blue than a bluer one is neither.
        return None, record | {"split": False, "reason": "the upper group does not lean to the index's colour"}
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
    # Each cell counts in a fit by its brightness squared: an index is a ratio, and with the same noise in every
    # channel its variance goes as 1 over the squared brightness. Dark roofs and asphalt, which lean blue, then do
    # not decide where the cut falls.
    brightness = brightness**2
    what = "sunlit cells, each weighted by its squared brightness"
    splits = []
    greener, record = _split(green, brightness, shown, cell_m, what, GREEN_INDEX)
    splits.append(record | {"separates": "grass from other ground"})
    labels = np.zeros(shape, dtype=np.uint8)
    names = [PRIOR_SINGLE_CLASS]
    priors = []
    if greener is None:
        priors.append(f"prior: one class, {PRIOR_SINGLE_CLASS}; {record['reason']}")
    else:
        names = [GRASS, PAVED]
        labels[:] = np.where(green >= greener, 0, 1)
        other = shown & (labels == 1)
        redder, record = _split(
            red, brightness, other, cell_m, "the sunlit cells that are not grass, " + what.split(", ")[1], RED_INDEX
        )
        splits.append(record | {"separates": "soil from paved"})
        if redder is not None:
            names.append(SOIL)
            labels[(labels == 1) & (red >= redder)] = 2
    # Ground the imagery does not show takes the class of the nearest ground it does.
    nearest = ndimage.distance_transform_edt(~shown, return_distances=False, return_indices=True)
    labels = labels[tuple(nearest)]
    return labels, names, {"splits": splits, "priors": priors, "settings": SETTINGS}


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


# Every value set by hand in this module, for the manifest: none is a measurement.
SETTINGS = {
    "kind": "prior",
    "separation_min": SEPARATION_MIN,
    "coherence_min": COHERENCE_MIN,
    "group_min_m2": GROUP_MIN_M2,
    "edge_m": EDGE_M,
    "majority_cells": MAJORITY_CELLS,
}

# Luminous reflectance of surfaces measured with a spectrometer, used to turn the photo's brightness into albedo.
# USGS Spectral Library v7 (splib07b, ASD, 0.35 to 2.5 um), each spectrum weighted by the CIE 1931 y-bar curve
# (Wyman, Sloan and Shirley's 2013 fit) over 380 to 780 nm, so it is the reflectance the eye, and an sRGB
# luminance, sees. Each anchor is: class, which quantile of its sunlit linear luminance, reflectance, what it is.
# The assumption (a prior) is that the median sunlit paving is concrete. The brightest paving is not used: aerial
# photos clip it, and roofs are among it.
ALBEDO_ANCHORS = ((PAVED, "p50", 0.2875, "light grey concrete road (GDS375)"),)
# Not fitted to, but checked against: the library's old asphalt road (GDS376) and green lawn grass (GDS91). The
# darkest paving also holds shade and dark roofs, and dry grass, which late-season imagery shows, is brighter than
# green lawn, so a fitted value a little off each is expected.
CHECKS = (
    (PAVED, "p10", 0.0878, "old asphalt road (GDS376)"),
    (GRASS, "p50", 0.0722, "green lawn grass (GDS91)"),
)
# Used only when the tile has none of the anchoring surfaces.
ALBEDO_SCALE_PRIOR = 0.5


def class_luminance(rgb: np.ndarray, labels: np.ndarray, shown: np.ndarray, names: list[str]) -> dict[str, dict]:
    """Each class's sunlit linear luminance (10th, 50th, 90th percentile) and mean colour in linear light."""
    if rgb.shape[0] < 3:
        return {}
    encoded = rgb[:3] / 255
    linear = np.where(encoded <= 0.04045, encoded / 12.92, ((encoded + 0.055) / 1.055) ** 2.4)
    luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    out = {}
    for index, name in enumerate(names):
        cells = (labels == index) & shown
        if cells.any():
            quantiles = np.quantile(luminance[cells], (0.1, 0.5, 0.9))
            out[name] = dict(zip(("p10", "p50", "p90"), (float(value) for value in quantiles), strict=True)) | {
                "mean_linear_rgb": [float(band[cells].mean()) for band in linear]
            }
    return out


def fit_albedo(luminance: dict[str, dict]) -> dict:
    """The one scale that turns the photo's linear colour into albedo, fitted to a surface of measured reflectance.

    Sunlit ground in a photo is lit by the sun and sky of the day, so its colour is albedo times that light. The
    scale is the geometric mean, over the anchors this tile has, of reflectance over measured luminance.
    """
    anchors = []
    for name, quantile, reflectance, what in ALBEDO_ANCHORS:
        measured = luminance.get(name, {}).get(quantile)
        if measured:
            anchors.append(
                {
                    "surface": what,
                    "class": name,
                    "quantile": quantile,
                    "measured_luminance": measured,
                    "reflectance": reflectance,
                }
            )
    if not anchors:
        return {
            "scale": ALBEDO_SCALE_PRIOR,
            "anchors": [],
            "priors": [f"prior: albedo scale {ALBEDO_SCALE_PRIOR}; no anchoring surface in the tile"],
        }
    ratios = np.log([anchor["reflectance"] / anchor["measured_luminance"] for anchor in anchors])
    scale = float(np.exp(ratios.mean()))
    for anchor in anchors:
        anchor["fitted_reflectance"] = scale * anchor["measured_luminance"]
    checks = [
        {
            "surface": what,
            "class": name,
            "quantile": quantile,
            "spectrum_reflectance": reflectance,
            "fitted_reflectance": scale * luminance[name][quantile],
        }
        for name, quantile, reflectance, what in CHECKS
        if luminance.get(name, {}).get(quantile)
    ]
    return {
        "scale": scale,
        "anchors": anchors,
        "checks": checks,
        "log_spread": float(ratios.std()),
        "source": "USGS Spectral Library v7, ASD spectra weighted by the CIE 1931 y-bar curve over 380 to 780 nm",
        "priors": ["prior: the median sunlit paving is concrete"],
    }
