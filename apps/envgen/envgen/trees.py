"""A tree inventory from canopy heights: where each tree stands, how tall and how wide it is, and what kind.

Positions, heights and crown sizes are measured: each tree is a crown top in a height-above-ground raster and the
ground its crown covers. The kind (broadleaf or conifer) is measured where a leaf-off lidar survey shows how much
of the crown stops the laser. The species is drawn from an inventory's mix for the region, which cannot place a
tree: it is a regional prior, and each tree says so.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage
from skimage.morphology import reconstruction
from skimage.segmentation import watershed

from . import surface

BROADLEAF, CONIFER = "broadleaf", "conifer"

# Heights are smoothed over this before crown tops are looked for, so one crown's twigs are not many tops. Hand-set.
SMOOTH_M = 1.0
# A crown top must stand this far above the saddle that joins it to a taller crown. Hand-set: about the vertical
# noise of a canopy height raster.
PROMINENCE_M = 1.0
# A crown covers at least this much ground; smaller patches are clutter. Hand-set.
CROWN_MIN_M2 = 4.0
# A source counts as seeing a crown when it shows cover over this share of it. Hand-set.
SEEN_SHARE = 0.5

# A mast or a pole stands over the ground like a crown, far narrower than a tree that tall. Crown width is fitted
# against height over the tile's own crowns (a power law, in logarithms); a crown this many robust standard
# deviations narrower than the fit is not a tree, unless every source that looks at it sees it: a cut at two
# deviations also catches the narrowest real trees, and a second source does not see a mast. Hand-set criterion;
# the fit needs at least this many crowns.
NARROW_SIGMAS = 2.0
NARROW_MIN_CROWNS = 20

SETTINGS = {
    "kind": "prior",
    "smooth_m": SMOOTH_M,
    "prominence_m": PROMINENCE_M,
    "crown_min_m2": CROWN_MIN_M2,
    "seen_share": SEEN_SHARE,
    "narrow_sigmas": NARROW_SIGMAS,
    "narrow_min_crowns": NARROW_MIN_CROWNS,
}

COLUMNS = (
    "east_m",
    "north_m",
    "height_m",
    "crown_radius_m",
    "kind",
    "kind_from",
    "species",
    "trunk_diameter_m",
    "crown_ratio",
    "confidence",
    "source",
    "yaw_deg",
)


def crowns(height_m: np.ndarray, cover: np.ndarray, cell_m: float) -> tuple[np.ndarray, list[dict]]:
    """Split the cover into crowns. Returns a label per cell (0: no crown) and, per crown, its top and size.

    A crown is the ground that drains to one top when the canopy is turned upside down (a watershed), where a top
    is a maximum that stands PROMINENCE_M clear of any saddle to a taller one.
    """
    smooth = ndimage.gaussian_filter(np.where(cover, height_m, 0.0).astype(np.float64), SMOOTH_M / cell_m)
    smooth[~cover] = 0.0
    # A maximum survives lowering the surface by the prominence and rebuilding it from below only if it stands
    # that far clear: the standard h-maxima construction.
    rebuilt = reconstruction(np.maximum(smooth - PROMINENCE_M, 0.0), smooth, method="dilation")
    plateaus, count = ndimage.label((smooth - rebuilt >= PROMINENCE_M - 1e-9) & cover)
    if not count:
        return np.zeros(height_m.shape, dtype=np.int32), []
    # One seed per top: the highest cell of each plateau.
    tops = ndimage.maximum_position(smooth, plateaus, np.arange(1, count + 1))
    markers = np.zeros(height_m.shape, dtype=np.int32)
    for index, (row, column) in enumerate(tops, start=1):
        markers[row, column] = index
    labels = watershed(-smooth, markers, mask=cover)
    found = []
    index = np.arange(1, count + 1)
    areas = ndimage.sum_labels(np.ones(labels.shape), labels, index) * cell_m**2
    highest = ndimage.maximum(np.where(cover, height_m, 0.0), labels, index)
    for label, (row, column), area, top in zip(index, tops, areas, highest, strict=True):
        if area < CROWN_MIN_M2:
            labels[labels == label] = 0
            continue
        found.append(
            {
                "label": int(label),
                "row": int(row),
                "column": int(column),
                "height_m": float(top),
                # The radius of the circle that covers as much ground as the crown does.
                "crown_radius_m": float(math.sqrt(area / math.pi)),
            }
        )
    return labels, found


def too_narrow(found: list[dict]) -> tuple[np.ndarray, dict]:
    """Which crowns are too narrow for their height to be trees, by the tile's own crowns. Returns a flag each, and the fit."""
    flags = np.zeros(len(found), dtype=bool)
    if len(found) < NARROW_MIN_CROWNS:
        return flags, {"fitted": False, "reason": "too few crowns to fit crown width against height"}
    height = np.log([crown["height_m"] for crown in found])
    radius = np.log([crown["crown_radius_m"] for crown in found])
    power, offset = np.polyfit(height, radius, 1)
    residual = radius - (offset + power * height)
    sigma = 1.4826 * np.median(np.abs(residual - np.median(residual)))
    flags = residual < -NARROW_SIGMAS * sigma
    return flags, {
        "fitted": True,
        "crown_radius_m": f"{math.exp(offset):.3f} * height_m ** {power:.3f}",
        "sigma_log": float(sigma),
        "narrow": int(flags.sum()),
    }


def masts(narrow: np.ndarray, records: list[dict], sources: int) -> list[bool]:
    """Which records to drop: too narrow for their height and not seen by every source that looks at them.

    With one source there is no second look, and narrow alone decides.
    """
    return [bool(flag) and (sources < 2 or tree["confidence"] < 1) for flag, tree in zip(narrow, records, strict=True)]


def closure(labels: np.ndarray, found: list[dict], canopy_returns: np.ndarray, all_returns: np.ndarray) -> np.ndarray:
    """For each crown, the share of the lidar's returns over it that came back from the canopy. NaN with no returns."""
    index = [crown["label"] for crown in found]
    above = ndimage.sum_labels(canopy_returns, labels, index)
    total = ndimage.sum_labels(all_returns, labels, index)
    return np.where(total > 0, above / np.maximum(total, 1), np.nan)


def split_kinds(closures: np.ndarray, areas: np.ndarray) -> tuple[float | None, dict]:
    """The closure that separates conifers from bare broadleaf crowns in a leaf-off survey, or None with why.

    A conifer keeps its needles and stops most of the laser; a bare broadleaf crown lets most of it through. The
    cut is fitted (Otsu, each crown counting by its area) and only used when the crowns are two populations, by
    the same test the surface classes use.
    """
    known = np.isfinite(closures)
    record = {"fitted_to": "the share of leaf-off lidar returns each crown stops", "crowns": int(known.sum())}
    if known.sum() < 20:
        return None, record | {"split": False, "reason": "too few crowns with lidar returns"}
    values, weights = closures[known], areas[known]
    threshold = surface.otsu(values, weights)
    separation, mixture = surface.mixture_separation(values, weights, threshold)
    record |= {"threshold": threshold, "separation": separation, "mixture": mixture}
    if separation < surface.SEPARATION_MIN:
        return None, record | {"split": False, "reason": "one population: the fitted components overlap"}
    return threshold, record | {"split": True}


def _height_likelihood(height_m: float, quantiles: dict) -> float:
    """How likely a species is to be this tall: a log-normal through its measured 10th, 50th and 90th percentile."""
    sigma = max((math.log(quantiles["p90"]) - math.log(quantiles["p10"])) / (2 * 1.2816), 0.05)
    z = (math.log(max(height_m, 0.5)) - math.log(quantiles["p50"])) / sigma
    return math.exp(-0.5 * z * z) / sigma


def draw_species(mix: list[dict], kind: str | None, height_m: float, rng: np.random.Generator) -> dict | None:
    """Draw a species for a tree of this height, from the mix's species of its kind, or of any kind when unknown.

    None when the mix has no species of a kind that was measured: the measurement stands, and the tree has no species.
    """
    candidates = [entry for entry in mix if kind is None or entry["kind"] == kind]
    if not candidates:
        return None
    weights = np.array([entry["share"] * _height_likelihood(height_m, entry["height_m"]) for entry in candidates])
    if weights.sum() <= 0:
        weights = np.array([entry["share"] for entry in candidates])
    return candidates[int(rng.choice(len(candidates), p=weights / weights.sum()))]


def inventory(
    labels: np.ndarray,
    found: list[dict],
    seen_by: dict[str, np.ndarray],
    covers: dict[str, np.ndarray],
    cell_m: float,
    size_m: float,
    closures: np.ndarray | None,
    kind_threshold: float | None,
    mix: list[dict] | None,
    seed: int,
) -> list[dict]:
    """One record per crown, in metres east and north of the tile centre.

    `seen_by` names, for every cell, the source its height came from (a boolean raster per source name), and
    `covers` says where each source that looks at the tile shows cover and where it looks at all (NaN where it
    does not). Confidence is the share of the sources looking at a crown that see it.
    """
    rng = np.random.default_rng(seed)
    index = [crown["label"] for crown in found]
    sizes = ndimage.sum_labels(np.ones(labels.shape), labels, index)
    seeing = {
        name: ndimage.sum_labels(np.nan_to_num(cover), labels, index) / np.maximum(sizes, 1)
        for name, cover in covers.items()
    }
    looking = {
        name: ndimage.sum_labels(np.isfinite(cover).astype(float), labels, index) / np.maximum(sizes, 1)
        for name, cover in covers.items()
    }
    trees = []
    for position, crown in enumerate(found):
        row, column = crown["row"], crown["column"]
        source = next(name for name, mask in seen_by.items() if mask[row, column])
        watchers = [name for name in covers if looking[name][position] >= SEEN_SHARE]
        agreeing = [name for name in watchers if seeing[name][position] >= SEEN_SHARE]
        kind, kind_from = None, "prior: the inventory's mix"
        if closures is not None and kind_threshold is not None and np.isfinite(closures[position]):
            kind = CONIFER if closures[position] >= kind_threshold else BROADLEAF
            kind_from = "leaf-off lidar closure"
        tree = {
            "east_m": (column + 0.5) * cell_m - size_m / 2,
            "north_m": size_m / 2 - (row + 0.5) * cell_m,
            "height_m": crown["height_m"],
            "crown_radius_m": crown["crown_radius_m"],
            "kind": kind or BROADLEAF,
            "kind_from": kind_from if mix or kind else "prior: broadleaf",
            "species": None,
            "trunk_diameter_m": None,
            "crown_ratio": None,
            "confidence": len(agreeing) / max(len(watchers), 1),
            "source": source,
            "yaw_deg": float(rng.uniform(0, 360)),
        }
        species = draw_species(mix, kind, crown["height_m"], rng) if mix else None
        if species:
            intercept, slope = species["trunk_diameter_m"]
            tree |= {
                "kind": species["kind"],
                "species": species["name"],
                "trunk_diameter_m": max(intercept + slope * crown["height_m"], 0.05),
                "crown_ratio": species["crown_ratio"],
            }
        trees.append(tree)
    return trees
