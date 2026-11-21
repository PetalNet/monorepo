"""Transfer survey appearance statistics to coarse-imagery ground, retaining per-mask provenance."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
from scipy import ndimage
from skimage.morphology import skeletonize

from . import frame, orthophoto, trees

VERSION = 2
CACHE_VERSION = 5
SETTINGS = {
    "survey_cell_m": 0.25,
    "survey_max_pixels": 2_000_000,
    "validation_tile_m": 32.0,
    "training_buffer_m": 4.0,
    "folds": 5,
    "zone_patch_m": 4.0,
    "edge_m": 4.0,
    "slope_rough_degrees": 12.0,
    "windrow_spacing_search_m": [1.0, 5.0],
    "windrow_peak_tolerance": 0.95,
    "windrow_min_phase_bins": 16,
    "windrow_width_prior_m": 0.35,
    "windrow_segment_m": 3.0,
    "canopy_min_m": 2.0,
}
ZONES = ["short", "stubble", "rough"]
MASKS = ["zones", "windrow", "wear", "weeds", "crown", "bare"]
SOURCES = {"measured": 1, "inferred": 2, "generated": 3, "painted": 4}
PALETTE = np.array([[0, 0, 0], [35, 180, 95], [40, 120, 235], [240, 155, 30], [210, 80, 210]], np.uint8)


def _hash(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _distance(mask: np.ndarray, cell_m: float) -> np.ndarray:
    if not mask.any():
        return np.full(mask.shape, np.inf, np.float32)
    return ndimage.distance_transform_edt(~mask).astype(np.float32) * cell_m


def _noise(shape, scale_m, cell_m, rng):
    # Filter a coarse lattice: memory and work stay bounded on kilometre tiles.
    spacing = max(1, round(scale_m / cell_m))
    coarse = rng.random((math.ceil(shape[0] / spacing) + 2, math.ceil(shape[1] / spacing) + 2))
    y, x = np.indices(shape, dtype=np.float32) / spacing
    values = ndimage.map_coordinates(coarse, [y, x], order=1, mode="nearest")
    return values.astype(np.float32)


def colour_classes(rgb: np.ndarray, grass: np.ndarray, cuts: list[float]) -> np.ndarray:
    """Three NAIP grass colours, plus a non-grass class; no canopy is inferred from colour."""
    green = (rgb[1] - rgb[0]) / np.maximum(rgb.sum(axis=0), 1)
    return np.where(grass, np.digitize(green, cuts), 3).astype(np.uint8)


def observe(rgb, valid, cell_m, thresholds=None):
    """Appearance segmentation, not a surveyed vegetation or species label."""
    rgb = rgb.astype(np.float32)
    luma = rgb.mean(axis=0)
    green = (rgb[1] - (rgb[0] + rgb[2]) / 2) / np.maximum(rgb.sum(axis=0), 1)
    smooth = ndimage.gaussian_filter(luma, 0.7 / cell_m)
    residual = luma - ndimage.gaussian_filter(luma, 0.15 / cell_m)
    texture = np.sqrt(ndimage.gaussian_filter(residual**2, 0.7 / cell_m)) / np.maximum(smooth, 1)
    if thresholds is None:
        if np.count_nonzero(valid) < 100:
            raise ValueError("procfill needs at least 100 visible survey ground pixels")
        thresholds = {
            "rough_green": float(np.percentile(green[valid], 75)),
            "short_texture": float(np.percentile(texture[valid], 35)),
            "weed_green": float(np.percentile(green[valid], 92)),
            "bare_green": float(np.percentile(green[valid], 12)),
            "bare_light": float(np.percentile(smooth[valid], 94)),
        }
    zones = np.where(
        green > thresholds["rough_green"], 2, np.where(texture < thresholds["short_texture"], 0, 1)
    ).astype(np.uint8)
    weeds = (green > thresholds["weed_green"]) & (zones == 2) & valid
    bare = (green < thresholds["bare_green"]) & (smooth > thresholds["bare_light"]) & valid
    # Thin, connected pale pieces are only candidate wear. Broad soil is retained as bare patches.
    distance = ndimage.distance_transform_edt(bare) * cell_m
    wear = bare & (distance < 1.0)
    return {
        "zones": zones,
        "weeds": weeds,
        "bare": bare,
        "wear": wear,
        "luma": luma,
        "valid": valid,
        "rgb": rgb,
    }, thresholds


def _components(mask, cell_m, minimum_m2=0.1, maximum_m2=100):
    labels, _ = ndimage.label(mask)
    samples = []
    for index, bounds in enumerate(ndimage.find_objects(labels), 1):
        if bounds is None:
            continue
        inside = labels[bounds] == index
        area = float(inside.sum() * cell_m**2)
        if not minimum_m2 <= area <= maximum_m2:
            continue
        rows, columns = np.where(inside)
        covariance = np.cov(np.stack([rows, columns])) if len(rows) > 2 else np.eye(2) / 12
        eigen = np.maximum(np.linalg.eigvalsh(covariance), 1 / 12)
        samples.append([round(math.sqrt(area / math.pi), 3), round(float(math.sqrt(eigen[-1] / eigen[0])), 3)])
    return samples


def _windrows(luma, stubble, train, cell_m):
    """Estimate periodic spacing and bearing from independent 16 m training windows."""
    size = max(16, round(16 / cell_m))
    freq = np.fft.fftfreq(size, d=cell_m)
    fy, fx = np.meshgrid(freq, freq, indexing="ij")
    radius = np.hypot(fx, fy)
    low, high = SETTINGS["windrow_spacing_search_m"]
    band = (radius >= 1 / high) & (radius <= 1 / low)
    window = np.outer(np.hanning(size), np.hanning(size))
    rows = []
    continuity = []
    width_kinds = []
    for y in range(0, luma.shape[0] - size + 1, size):
        for x in range(0, luma.shape[1] - size + 1, size):
            at = np.s_[y : y + size, x : x + size]
            if not train[at].all() or stubble[at].mean() < 0.4:
                continue
            patch = luma[at]
            signal = patch - ndimage.gaussian_filter(patch, 2 / cell_m)
            power = abs(np.fft.fft2(signal * window)) ** 2
            selected = np.where(band, power, 0)
            # Thin sampled rows can give a harmonic the same power as the fundamental.
            peaks = band & (selected >= selected.max() * SETTINGS["windrow_peak_tolerance"])
            frequency_row, frequency_column = np.unravel_index(
                np.argmin(np.where(peaks, radius, np.inf)), selected.shape
            )
            strength = float(selected[frequency_row, frequency_column] / max(float(power[band].sum()), 1e-9))
            if strength < 0.025:
                continue
            # Refine the spectral peak before folding; integer-bin phase drifts broaden narrow rows.
            neighbourhood = np.log(
                np.maximum(
                    np.roll(np.roll(power, 1 - frequency_row, axis=0), 1 - frequency_column, axis=1)[:3, :3], 1e-12
                )
            )
            centre = neighbourhood[1, 1]
            gradient = np.array(
                [(neighbourhood[2, 1] - neighbourhood[0, 1]) / 2, (neighbourhood[1, 2] - neighbourhood[1, 0]) / 2]
            )
            cross = (neighbourhood[2, 2] - neighbourhood[2, 0] - neighbourhood[0, 2] + neighbourhood[0, 0]) / 4
            hessian = np.array(
                [
                    [neighbourhood[2, 1] - 2 * centre + neighbourhood[0, 1], cross],
                    [cross, neighbourhood[1, 2] - 2 * centre + neighbourhood[1, 0]],
                ]
            )
            offset = (
                np.clip(-np.linalg.solve(hessian, gradient), -0.5, 0.5)
                if np.linalg.eigvalsh(hessian).max() < -1e-8
                else np.zeros(2)
            )
            normal_y = fy[frequency_row, frequency_column] + offset[0] / (size * cell_m)
            normal_x = fx[frequency_row, frequency_column] + offset[1] / (size * cell_m)
            spacing = 1 / math.hypot(normal_x, normal_y)
            angle = math.degrees(math.atan2(normal_y, normal_x)) % 180
            # Fold along the fitted normal so unrelated fine texture does not inflate row width.
            yy, xx = np.indices(patch.shape)
            bins = np.floor(((normal_y * yy + normal_x * xx) * cell_m % 1) * 64).astype(int) % 64
            support = stubble[at]
            counts = np.bincount(bins[support], minlength=64)
            profile = np.bincount(bins[support], weights=signal[support], minlength=64) / np.maximum(counts, 1)
            present = np.flatnonzero(counts)
            profile = np.interp(np.arange(64), present, profile[present], period=64)
            smooth_profile = ndimage.gaussian_filter1d(profile, 1, mode="wrap")
            half = (smooth_profile.min() + smooth_profile.max()) / 2
            width = spacing * float((smooth_profile > half).mean())
            resolved = present.size >= SETTINGS["windrow_min_phase_bins"]
            if not resolved:
                width = SETTINGS["windrow_width_prior_m"]
            width_kinds.append("fitted" if resolved else "prior: insufficient phase samples")
            rows.append([round(float(spacing), 3), round(float(width), 3), round(angle, 2)])
            floor, peak = np.percentile(profile, [10, 90])
            crest = (profile[bins] > (floor + peak) / 2) & support
            local_half = floor + (profile[bins] - floor) / 2
            continuity.append(float((signal[crest] > local_half[crest]).mean()) if crest.any() else 1.0)
    angles = np.radians([row[2] * 2 for row in rows])
    mean_normal = (
        float(np.degrees(np.arctan2(np.sin(angles).mean(), np.cos(angles).mean())) / 2 % 180) if len(rows) else 45.0
    )
    return {
        "normal_circular_mean_deg": mean_normal,
        "samples_spacing_width_normal_deg": rows,
        "continuity_samples": continuity,
        "width_kinds": width_kinds,
        "width_method": "half-height of phase-folded stubble residual, 64 bins smoothed by one bin",
        "kind": "fitted" if rows else "prior",
        "fallback_spacing_width_normal_deg": [2.0, SETTINGS["windrow_width_prior_m"], 45.0],
        "rule": "field principal direction inside; distance contours at edges and around canopy/roads",
    }


def fit(observed, classes, train, cell_m, canopy=None, paths=None):
    valid = observed["valid"] & train
    zones = observed["zones"]
    total = np.bincount(zones[valid], minlength=3).astype(float)
    if not total.sum():
        raise ValueError("procfill training fold has no visible ground")
    shares = []
    counts = []
    for index in range(4):
        mine = valid & (classes == index)
        count = np.bincount(zones[mine], minlength=3).astype(float)
        counts.append(int(count.sum()))
        shares.append((count / count.sum() if count.sum() else total / total.sum()).tolist())
    rough_area = max(float(np.count_nonzero(valid & (zones == 2)) * cell_m**2), cell_m**2)
    weeds = _components(observed["weeds"] & valid, cell_m, minimum_m2=cell_m**2, maximum_m2=10)
    bare = _components(observed["bare"] & valid, cell_m, minimum_m2=cell_m**2)
    wear = observed["wear"] & valid
    widths = ndimage.distance_transform_edt(wear) * 2 * cell_m
    wear_centres = skeletonize(wear)
    path_distances = _distance(paths, cell_m)[wear] if paths is not None and paths.any() else np.array([])

    def compact(samples):
        ordered = sorted(samples)
        return [ordered[index] for index in np.linspace(0, len(ordered) - 1, min(64, len(ordered))).astype(int)]

    crown_sizes = []
    canopy = observed.get("canopy", canopy)
    if canopy is not None:
        support = observed.get("canopy_valid", np.ones(canopy.shape, bool))
        _, found = trees.crowns(canopy, (canopy > SETTINGS["canopy_min_m"]) & train & support, cell_m)
        crown_sizes = [round(tree["crown_radius_m"], 3) for tree in found]
    return {
        "schema_version": VERSION,
        "settings": SETTINGS,
        "zone_names": ZONES,
        "zone_share_by_naip_class": shares,
        "training_cells_by_class": counts,
        "windrows": _windrows(observed["luma"], zones == 1, valid, cell_m),
        "wear": {
            "width_m": np.percentile(widths[wear_centres], [25, 50, 75]).tolist() if wear_centres.any() else [],
            "distance_to_path_m": np.percentile(path_distances, [25, 50, 75]).tolist() if path_distances.size else [],
            "kind": "inferred pale narrow components",
            "rule": "only connected paths/corridors near fields",
        },
        "weeds": {
            "radius_aspect_samples": compact(weeds),
            "clumps_per_m2_rough": len(weeds) / rough_area,
            "rough_cover_share": float((observed["weeds"] & valid).sum() * cell_m**2 / rough_area),
        },
        "bare": {
            "radius_aspect_samples": compact(bare),
            "ground_cover_share": float(observed["bare"][valid].mean()),
            "patches_per_m2": len(bare) / max(float(valid.sum() * cell_m**2), cell_m**2),
        },
        "crown_radius_m": crown_sizes,
        "limitations": [
            "Appearance labels are an unsupervised RGB/texture interpretation, not surveyed vegetation truth.",
            "NAIP and drone acquisition dates differ; colour classes need not imply the same mowing state.",
            "Weed and bare component detection is resolution dependent; pale stone/soil identity is unresolved.",
            "Crown sizes use height watershed; species and fullness are not identified.",
            "Path proximity, slope response, field-edge curves and confidence scores are explicit priors.",
        ],
    }


def _stamp(shape, eligible, samples, share, cell_m, rng):
    result = np.zeros(shape, np.float32)
    positions = np.argwhere(eligible)
    if not len(positions) or not samples:
        return result
    target = round(len(positions) * np.clip(share, 0, 0.95))
    covered = 0
    samples = np.array(samples)
    area = max(1, float(np.mean(math.pi * samples[:, 0] ** 2 / cell_m**2)))
    # Count actual raster coverage after clipping/overlap, rather than continuous ellipse area.
    while covered < target:
        positions = np.argwhere(eligible & (result <= 0.5))
        count = max(1, math.ceil(0.7 * (target - covered) / area))
        picked = positions[rng.choice(len(positions), size=count, replace=False)]
        sizes = samples[rng.integers(len(samples), size=count)]
        subpixel = sizes[:, 0] * np.sqrt(sizes[:, 1]) <= cell_m / 2
        result[picked[subpixel, 0], picked[subpixel, 1]] = 1
        current = int(np.count_nonzero(result > 0.5))
        for (row, column), (radius, aspect) in zip(picked[~subpixel], sizes[~subpixel], strict=True):
            if current >= target:
                break
            if result[row, column] > 0.5:
                continue
            # The >0.5 contour has the fitted equivalent area despite the softened edge.
            major = radius * math.sqrt(aspect / 0.75) / cell_m
            minor = radius / math.sqrt(aspect * 0.75) / cell_m
            extent = math.ceil(major) + 1
            y0, y1 = max(0, row - extent), min(shape[0], row + extent + 1)
            x0, x1 = max(0, column - extent), min(shape[1], column + extent + 1)
            y, x = np.mgrid[y0:y1, x0:x1] - np.array([row, column])[:, None, None]
            angle = rng.uniform(0, math.tau)
            u, v = x * math.cos(angle) + y * math.sin(angle), y * math.cos(angle) - x * math.sin(angle)
            ellipse = (u / max(major, 0.5)) ** 2 + (v / max(minor, 0.5)) ** 2
            patch = result[y0:y1, x0:x1]
            before = int(np.count_nonzero(patch > 0.5))
            proposed = np.maximum(patch, np.clip(2 * (1 - ellipse), 0, 1)) * eligible[y0:y1, x0:x1]
            added = (proposed > 0.5) & (patch <= 0.5)
            remaining = target - current
            if np.count_nonzero(added) > remaining:
                # A tiny eligible area may not fit even one measured clump. Trim its outer cells.
                flat = np.flatnonzero(added)
                nearest = np.argsort(ellipse.ravel()[flat], kind="stable")
                cutoff = ellipse.ravel()[flat[nearest[remaining - 1]]]
                proposed[ellipse > cutoff] = patch[ellipse > cutoff]
                excess = flat[nearest[remaining:]]
                proposed.flat[excess] = patch.flat[excess]
            patch[:] = proposed
            current += int(np.count_nonzero(patch > 0.5)) - before
        area = max((current - covered) / count, 1)
        covered = current
    return result


def generate(
    priors, classes, grass, elevation, canopy, paths, roads, cell_m, seed, entrances=None, fields=None, visible=None
):
    """Generate all fine features from coarse constraints alone; never reads hidden survey pixels."""
    rng = np.random.default_rng(seed)
    shape = grass.shape
    tree_distance = _distance(canopy > SETTINGS["canopy_min_m"], cell_m)
    path_distance, road_distance = _distance(paths, cell_m), _distance(roads, cell_m)
    inside_distance = ndimage.distance_transform_edt(np.pad(grass, 1))[1:-1, 1:-1] * cell_m
    dy, dx = np.gradient(elevation, cell_m)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))
    edge = np.clip(1 - inside_distance / SETTINGS["edge_m"], 0, 1)
    sheltered = np.clip(1 - tree_distance / SETTINGS["edge_m"], 0, 1)
    rough_bias = np.maximum.reduce([edge, sheltered, np.clip(slope / SETTINGS["slope_rough_degrees"], 0, 1)])
    probabilities = np.array(priors["zone_share_by_naip_class"], np.float32)[classes].copy()
    random = (
        _noise(shape, SETTINGS["zone_patch_m"], cell_m, rng)
        + 0.3 * rough_bias
        - 0.2 * np.clip(1 - path_distance / 3, 0, 1)
    )
    # Rank within each NAIP class: terrain moves patches without changing their learned area shares.
    uniform = np.zeros(shape, np.float32)
    visible = canopy < SETTINGS["canopy_min_m"] if visible is None else visible
    for index in range(4):
        for shown in (False, True):
            mine = (classes == index) & grass & (visible == shown)
            scores = random[mine]
            if not scores.size:
                continue
            order = np.argsort(scores, kind="stable")
            ranks = np.empty(scores.size, np.float32)
            ranks[order] = (np.arange(scores.size) + 0.5) / scores.size
            uniform[mine] = ranks
    zones = np.sum(uniform[..., None] > np.cumsum(probabilities, axis=-1)[..., :2], axis=-1).astype(np.uint8)
    zones[~grass] = 255
    open_field = grass & (tree_distance > 1) & (road_distance > 1)
    if fields is not None:
        open_field &= fields
    labels, _ = ndimage.label(open_field)
    windrow = np.zeros(shape, np.float32)
    spacing_samples = priors["windrows"]["samples_spacing_width_normal_deg"]
    continuity_samples = priors["windrows"].get("continuity_samples", [])
    for index, bounds in enumerate(ndimage.find_objects(labels), 1):
        if bounds is None:
            continue
        mask = labels[bounds] == index
        if mask.sum() * cell_m**2 < 100:
            continue
        ys, xs = np.where(mask)
        covariance = np.cov(np.stack([xs, ys]))
        _, vectors = np.linalg.eigh(covariance)
        normal = vectors[:, 0]
        sample = int(rng.integers(len(spacing_samples))) if spacing_samples else None
        spacing, width, angle = (
            spacing_samples[sample] if sample is not None else priors["windrows"]["fallback_spacing_width_normal_deg"]
        )
        deviation = math.radians((angle - priors["windrows"]["normal_circular_mean_deg"] + 90) % 180 - 90)
        normal = np.array(
            [
                normal[0] * math.cos(deviation) - normal[1] * math.sin(deviation),
                normal[0] * math.sin(deviation) + normal[1] * math.cos(deviation),
            ]
        )
        y, x = np.indices(mask.shape, dtype=np.float32)
        across = (normal[0] * x + normal[1] * y) * cell_m
        obstacle = np.minimum(tree_distance[bounds], road_distance[bounds])
        # Local phase displacement bends otherwise parallel rows around crowns and road boundaries.
        phase = across + np.maximum(0, 6 - obstacle) ** 2 / 12
        boundary = ndimage.distance_transform_edt(np.pad(mask, 1))[1:-1, 1:-1] * cell_m
        edge_mix = np.clip(1 - boundary / 6, 0, 1)
        phase = phase * (1 - edge_mix) + boundary * edge_mix
        phase += rng.uniform(0, spacing)
        distance = abs((phase + spacing / 2) % spacing - spacing / 2)
        if spacing_samples:
            # A whole connected field must not inherit one unusually narrow training window.
            step = max(1, round(16 / cell_m))
            lattice = rng.integers(
                len(spacing_samples), size=(math.ceil(mask.shape[0] / step) + 2, math.ceil(mask.shape[1] / step) + 2)
            )
            widths = np.array(spacing_samples)[:, 1][lattice]
            width = ndimage.map_coordinates(widths, [y / step, x / step], order=1, mode="nearest")
            width = np.minimum(width, spacing * 0.95)
        lines = np.clip((width / 2 + cell_m / 2 - distance) / cell_m, 0, 1)
        continuity = float(np.median(continuity_samples)) if continuity_samples else 1.0
        if continuity < 1:
            breaks = _noise(mask.shape, SETTINGS["windrow_segment_m"], cell_m, rng)
            lines *= breaks >= np.quantile(breaks[mask], 1 - continuity)
        windrow[bounds] = lines * mask * (zones[bounds] == 1)
    # Coarse evidence can identify corridors. Their centre is a candidate desire line, never a new road.
    corridor = grass & (inside_distance < 4) & (path_distance < 12)
    if entrances is not None:
        corridor |= grass & (_distance(entrances, cell_m) < 8) & (path_distance < 12)
    centre = skeletonize(corridor)
    width_samples = priors["wear"]["width_m"]
    wear_width = float(np.median(width_samples)) if width_samples else 0.5
    wear = np.clip(1 - _distance(centre, cell_m) / max(wear_width / 2, cell_m), 0, 1)
    wear *= grass & (slope < 25)

    rough = grass & (zones == 2)
    weed_support = rough & (wear == 0)
    weed_share = priors["weeds"]["rough_cover_share"] * rough.sum() / max(int(weed_support.sum()), 1)
    weeds = _stamp(
        shape,
        weed_support,
        priors["weeds"]["radius_aspect_samples"],
        weed_share,
        cell_m,
        rng,
    )
    bare = _stamp(
        shape,
        grass,
        priors["bare"]["radius_aspect_samples"],
        priors["bare"]["ground_cover_share"],
        cell_m,
        rng,
    )
    # Sample crown silhouettes only at height-supported tops; never invent trees from green pixels.
    crown = np.zeros(shape, np.float32)
    coarse_step = max(1, math.ceil(1 / cell_m))
    coarse = canopy[::coarse_step, ::coarse_step]
    _, tops = trees.crowns(coarse, coarse > SETTINGS["canopy_min_m"], cell_m * coarse_step)
    radii = priors["crown_radius_m"]
    for top in tops:
        row, column = top["row"] * coarse_step, top["column"] * coarse_step
        radius = min(top["crown_radius_m"], float(rng.choice(radii))) if radii else top["crown_radius_m"]
        extent = math.ceil(radius / cell_m)
        y0, y1, x0, x1 = (
            max(0, row - extent),
            min(shape[0], row + extent + 1),
            max(0, column - extent),
            min(shape[1], column + extent + 1),
        )
        y, x = np.mgrid[y0:y1, x0:x1]
        fill = np.clip(2 * (1 - ((y - row) ** 2 + (x - column) ** 2) * (cell_m / max(radius, cell_m)) ** 2), 0, 1)
        crown[y0:y1, x0:x1] = np.maximum(crown[y0:y1, x0:x1], fill)
    crown *= canopy > SETTINGS["canopy_min_m"]
    return {"zones": zones, "windrow": windrow, "wear": wear, "weeds": weeds, "crown": crown, "bare": bare}


def validate(observed, classes, elevation, canopy, paths, roads, cell_m, seed):
    """Spatial cross-validation. Each fold refits priors with the held-out tiles excluded."""
    y, x = np.indices(classes.shape)
    tile_cells = max(1, round(SETTINGS["validation_tile_m"] / cell_m))
    folds = (x // tile_cells + 2 * (y // tile_cells)) % SETTINGS["folds"]
    results = []
    skipped = []
    for fold in range(SETTINGS["folds"]):
        test = observed["valid"] & (folds == fold)
        train = ndimage.binary_erosion(folds != fold, iterations=max(1, round(SETTINGS["training_buffer_m"] / cell_m)))
        if test.sum() < 100 or (observed["valid"] & train).sum() < 100:
            skipped.append(
                {
                    "fold": fold,
                    "test_cells": int(test.sum()),
                    "training_cells": int((observed["valid"] & train).sum()),
                    "reason": "fewer than 100 visible training or test cells",
                }
            )
            continue
        training, thresholds = observe(observed["rgb"], observed["valid"] & train, cell_m)
        for name in ("canopy", "canopy_valid"):
            if name in observed:
                training[name] = observed[name]
        truth, _ = observe(observed["rgb"], observed["valid"], cell_m, thresholds)
        priors = fit(training, classes, train, cell_m, canopy, paths)
        made = generate(
            priors,
            classes,
            classes < 3,
            elevation,
            canopy,
            paths,
            roads,
            cell_m,
            seed + fold,
            visible=observed.get("coarse_visible"),
        )
        real = np.bincount(truth["zones"][test], minlength=3) / test.sum()
        synthetic = np.bincount(made["zones"][test], minlength=3) / test.sum()

        def summary(samples):
            return {
                "count": len(samples),
                "p10_p50_p90": np.percentile(samples, [10, 50, 90]).tolist() if len(samples) else [],
            }

        distributions = {}
        for name in ("weeds", "bare", "wear"):
            measured_parts = _components(truth[name] & test, cell_m, minimum_m2=cell_m**2)
            generated_parts = _components((made[name] > 0.5) & test, cell_m, minimum_m2=cell_m**2)
            distributions[name] = {
                "real_radius_m": summary([part[0] for part in measured_parts]),
                "generated_radius_m": summary([part[0] for part in generated_parts]),
                "real_aspect": summary([part[1] for part in measured_parts]),
                "generated_aspect": summary([part[1] for part in generated_parts]),
            }
        real_fit = _windrows(truth["luma"], truth["zones"] == 1, test, cell_m)
        made_fit = _windrows(made["windrow"] * 255, made["zones"] == 1, test, cell_m)
        real_rows = real_fit["samples_spacing_width_normal_deg"]
        made_rows = made_fit["samples_spacing_width_normal_deg"]

        def fitted_widths(result):
            return [
                row[1]
                for row, kind in zip(result["samples_spacing_width_normal_deg"], result["width_kinds"], strict=True)
                if kind == "fitted"
            ]

        distributions["windrows"] = {
            "real_spacing_m": summary([row[0] for row in real_rows]),
            "generated_spacing_m": summary([row[0] for row in made_rows]),
            "real_width_m": summary(fitted_widths(real_fit)),
            "generated_width_m": summary(fitted_widths(made_fit)),
            "real_width_prior_windows": len(real_rows) - len(fitted_widths(real_fit)),
            "generated_width_prior_windows": len(made_rows) - len(fitted_widths(made_fit)),
        }
        if "canopy" in observed:
            _, actual_crowns = trees.crowns(
                observed["canopy"],
                observed["canopy_valid"] & (folds == fold) & (observed["canopy"] > SETTINGS["canopy_min_m"]),
                cell_m,
            )
            distributions["crowns"] = {
                "real_radius_m": summary([top["crown_radius_m"] for top in actual_crowns]),
                "training_radius_m": summary(priors["crown_radius_m"]),
                "note": "silhouettes stay inside coarse height support; tree inventory is retained",
            }
        results.append(
            {
                "fold": fold,
                "distributions": distributions,
                "test_cells": int(test.sum()),
                "real_zone_share": real.tolist(),
                "generated_zone_share": synthetic.tolist(),
                "zone_total_variation": float(abs(real - synthetic).sum() / 2),
                "real_weed_share": float(truth["weeds"][test].mean()),
                "generated_weed_share": float((made["weeds"][test] > 0.5).mean()),
                "real_bare_share": float(truth["bare"][test].mean()),
                "generated_bare_share": float((made["bare"][test] > 0.5).mean()),
            }
        )
    return {
        "status": "complete" if len(results) == SETTINGS["folds"] else "insufficient_coverage",
        "skipped_folds": skipped,
        "method": "32 m spatial tiles, five folds; priors exclude each test fold with a 4 m buffer",
        "label_caveat": "same appearance classifier on held-out drone RGB; no independent manual truth",
        "folds": results,
        "mean_zone_total_variation": float(np.mean([r["zone_total_variation"] for r in results])) if results else None,
    }


def _onto(values, src_transform, dst_transform, shape, crs, resampling=Resampling.nearest):
    result = np.zeros(shape, np.float32)
    reproject(
        values.astype(np.float32),
        result,
        src_transform=src_transform,
        src_crs=crs,
        dst_transform=dst_transform,
        dst_crs=crs,
        resampling=resampling,
    )
    return result


def _save(values, path):
    Image.fromarray(frame.to_unreal_layout(values)).save(path)


def _load(path):
    return np.swapaxes(np.asarray(Image.open(path)), 0, 1)[::-1].copy()


def build(site, imagery, out, layers, elevation, covering, detail, *, fallback_weights=None, base_growth=None, ortho=None):
    """One pipeline stage; all site coordinates and measured rasters stay in private build outputs."""
    from .build import _sample_cells, _warp, imagery_bands, open_ground, read_heights, read_weights

    tile = site.tile
    pixels = detail["pixels"]
    cell_m = tile.size_m / pixels
    transform = from_origin(tile.west, tile.north, cell_m, cell_m)
    bands, _ = imagery_bands(site.imagery)
    rgb = _warp(
        imagery,
        site.crs,
        tile.west + cell_m / 2,
        tile.north - cell_m / 2,
        cell_m,
        pixels,
        Resampling.average,
        bands[:3] if bands else None,
    )
    grass = np.zeros((pixels, pixels), bool)
    for layer, weight in zip(layers, read_weights(out, layers), strict=True):
        if layer["name"] == "grass":
            grass = _sample_cells(weight, pixels) > 0.5
    heights = _sample_cells(read_heights(out, elevation), pixels)
    canopy = np.zeros(grass.shape, np.float32)
    if covering:
        with rasterio.open(out / covering["height"]) as source:
            canopy = source.read(1, out_shape=grass.shape, resampling=Resampling.bilinear)
    cuts = (
        np.percentile(((rgb[1] - rgb[0]) / np.maximum(rgb.sum(axis=0), 1))[grass], [33, 67]).tolist()
        if grass.any()
        else [0, 0]
    )
    classes = colour_classes(rgb, grass, cuts)
    roads, paths = np.zeros(grass.shape, bool), np.zeros(grass.shape, bool)
    for layer, weight in zip(layers, read_weights(out, layers), strict=True):
        if layer["name"] == "paved":
            roads |= _sample_cells(weight, pixels) > 0.5
        if layer["name"] == "soil":
            paths |= _sample_cells(weight, pixels) > 0.5
    # Thin hardscape components are paths; broad hardscape remains an exclusion.
    roads_inside = ndimage.distance_transform_edt(roads) * cell_m
    paths |= roads & (roads_inside < 2)
    context = out / "procfill_context"
    for name in ("paths", "roads", "entrances", "fields"):
        path = context / f"{name}.png"
        if path.exists() and _load(path).shape != grass.shape:
            raise ValueError(f"{path}: expected {pixels} by {pixels} greyscale pixels")
    if (context / "paths.png").exists():
        paths |= _load(context / "paths.png") > 0
    if (context / "roads.png").exists():
        roads |= _load(context / "roads.png") > 0
    entrances = _load(context / "entrances.png") > 0 if (context / "entrances.png").exists() else None
    fields = _load(context / "fields.png") > 0 if (context / "fields.png").exists() else None

    with rasterio.open(site.survey.orthophoto) as source:
        if source.count < 4 or source.crs.to_string() != site.crs:
            raise ValueError("procfill survey must have RGB+alpha in the site's projected CRS")
        scale = max(
            1,
            SETTINGS["survey_cell_m"] / abs(source.transform.a),
            math.sqrt(source.width * source.height / SETTINGS["survey_max_pixels"]),
        )
        shape = (max(1, round(source.height / scale)), max(1, round(source.width / scale)))
        survey = source.read([1, 2, 3, 4], out_shape=(4, *shape), resampling=Resampling.average)
        st = source.transform * source.transform.scale(source.width / shape[1], source.height / shape[0])
    survey_cell = abs(st.a)
    sc = _onto(classes, transform, st, shape, site.crs).astype(np.uint8)
    sh = _onto(heights, transform, st, shape, site.crs, Resampling.bilinear)
    ch = _onto(canopy, transform, st, shape, site.crs, Resampling.bilinear)
    shown = _onto(open_ground(out, covering, pixels), transform, st, shape, site.crs) > 0.5
    valid = (survey[3] == 255) & (sc < 3) & (ch < SETTINGS["canopy_min_m"]) & shown
    if valid.sum() < 100:
        return {"files": [], "skipped": "fewer than 100 visible survey ground pixels"}

    def survey_height(path):
        values = np.zeros(shape, np.float32)
        with rasterio.open(path) as source:
            reproject(
                rasterio.band(source, 1),
                values,
                dst_transform=st,
                dst_crs=site.crs,
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
        return values

    survey_canopy = np.maximum(
        np.nan_to_num(survey_height(site.survey.location) - survey_height(site.survey.terrain)), 0
    )
    observed, thresholds = observe(survey[:3], valid, survey_cell)
    observed["coarse_visible"] = shown
    observed["canopy"] = survey_canopy
    observed["canopy_valid"] = survey[3] == 255
    sp = _onto(paths, transform, st, shape, site.crs) > 0.5
    priors = fit(observed, sc, np.ones(shape, bool), survey_cell, ch, sp)
    priors["appearance_thresholds"] = thresholds
    priors["naip_green_cuts"] = cuts
    priors["source_sha256"] = {"drone": _hash(Path(site.survey.orthophoto)), "naip": _hash(imagery)}
    sp = _onto(paths, transform, st, shape, site.crs) > 0.5
    sr = _onto(roads, transform, st, shape, site.crs) > 0.5
    validation = validate(observed, sc, sh, ch, sp, sr, survey_cell, site.seed)
    masks = generate(
        priors,
        classes,
        grass,
        heights,
        canopy,
        paths,
        roads,
        cell_m,
        site.seed,
        entrances,
        fields,
        visible=open_ground(out, covering, pixels) > 0.5,
    )
    coverage = _onto(survey[3] > 0, st, transform, grass.shape, site.crs, Resampling.average) > 0
    files = []
    edits = out / "procfill_edits"
    provenance = np.full(grass.shape, SOURCES["generated"], np.uint8)
    provenance[~grass] = SOURCES["inferred"]
    provenance[coverage] = SOURCES["inferred"]
    painted_names = set()
    for name, values in masks.items():
        source_map = provenance.copy()
        confidence = np.where(coverage, 0.8, np.where(grass, 0.35, 0.6))
        if name in observed:
            measured = _onto(
                observed[name],
                st,
                transform,
                grass.shape,
                site.crs,
                Resampling.nearest if name == "zones" else Resampling.average,
            )
            values = np.where(coverage, measured, values)
        else:
            source_map[coverage] = SOURCES["generated"]
            confidence = np.where(coverage, 0.4, confidence)
        if name == "crown":
            source_map[:] = SOURCES["generated"]
            confidence[:] = 0.35
        encoded = values.astype(np.uint8) if name == "zones" else np.rint(np.clip(values, 0, 1) * 255).astype(np.uint8)
        edit = edits / f"{name}.png"
        if edit.exists():
            painted_names.add(name)
            painted = _load(edit)
            if painted.shape != encoded.shape or painted.dtype != np.uint8:
                raise ValueError(f"{edit}: expected 8-bit greyscale {pixels} by {pixels}")
            if name == "zones" and not np.isin(painted, [0, 1, 2, 255]).all():
                raise ValueError(f"{edit}: zones must be 0, 1, 2 or 255")
            encoded = painted
            source_map[:] = SOURCES["painted"]
            confidence[:] = 0.5
        for suffix, data in (
            ("", encoded),
            ("_source", source_map),
            ("_confidence", np.rint(confidence * 255).astype(np.uint8)),
        ):
            file = f"procfill_{name}{suffix}.png"
            _save(data, out / file)
            files.append(file)
        masks[name] = encoded if name == "zones" else encoded.astype(np.float32) / 255
    # The combined debug view uses the least certain active mask at each cell.
    combined = _load(out / "procfill_zones_source.png")
    weakest = _load(out / "procfill_zones_confidence.png")
    for name in MASKS[1:]:
        confidence = _load(out / f"procfill_{name}_confidence.png")
        # Ties retain the earlier mask in MASKS; zero-valued feature masks are inactive.
        choose = (masks[name] > 0.01) & (confidence < weakest)
        combined[choose] = _load(out / f"procfill_{name}_source.png")[choose]
        weakest[choose] = confidence[choose]
    evidence = np.where(coverage, SOURCES["measured"], SOURCES["inferred"]).astype(np.uint8)
    _save(evidence, out / "procfill_evidence_source.png")
    _save(PALETTE[evidence], out / "procfill_evidence_debug.png")
    files += ["procfill_evidence_source.png", "procfill_evidence_debug.png"]
    _save(PALETTE[combined], out / "procfill_debug.png")
    files.append("procfill_debug.png")
    # RGB matches the ground builder's density/height contract; alpha carries the detail overlay.
    zones = masks["zones"]
    no_grass = (zones == 255) & ("zones" in painted_names)
    bare_wear = np.maximum.reduce([masks["bare"], masks["wear"], no_grass])
    density = np.where(
        zones == 0, 0.55, np.where(zones == 1, 0.75 - 0.15 * masks["windrow"], 0.65 + 0.25 * masks["weeds"])
    )
    density *= (1 - bare_wear) * grass
    tall = np.where(zones == 2, 0.25 + 0.55 * masks["weeds"], 0.05) * (1 - bare_wear) * grass
    height = np.where(
        zones == 2, 0.4 + 0.4 * masks["weeds"], np.where(zones == 1, 0.35 - 0.10 * masks["windrow"], 0.25)
    )

    def effective(name):
        return masks[name] * grass * ((~coverage) | (name in painted_names))

    contrast = 0.12 * effective("windrow") - 0.08 * effective("weeds") - 0.10 * effective("wear")
    overlay = np.clip((127 + 127 * contrast) / 255, 0, 1)
    growth = np.stack([density, tall, height, overlay], axis=-1)
    surface_painted = bool(painted_names & {"zones", "bare", "wear"})
    if base_growth and ortho and "raster" in ortho and not surface_painted:
        native = orthophoto.sample(out / ortho["raster"], tile, site.crs, pixels, out / ortho["colour_raster"])
        influence = np.clip(native[:3].sum(axis=0), 0, 1)[..., None]
        original = _load(out / base_growth["file"])[..., :3].astype(np.float32) / 255
        growth[..., :3] = original * influence + growth[..., :3] * (1 - influence)
    _save(np.rint(growth * 255).astype(np.uint8), out / "procfill_growth.png")
    files.append("procfill_growth.png")
    ratio = _load(out / detail["file"]).astype(np.float32)
    ratio += contrast[..., None] * detail["zero"] / detail["log2_range"]
    _save(np.clip(np.rint(ratio), 0, 255).astype(np.uint8), out / "procfill_detail.png")
    files.append("procfill_detail.png")
    # Transfer grass weight into soil only on generated exposed ground. Original stage outputs remain reusable.
    from . import surface

    weights = read_weights(out, layers)
    ground_layers = [dict(layer) for layer in layers]
    names = [layer["name"] for layer in layers]
    if "soil" not in names:
        ground_layers.append({"name": "soil"})
        names.append("soil")
        weights = np.concatenate([weights, np.zeros_like(weights[:1])])
    exposed = _sample_cells(np.maximum.reduce([effective("bare"), effective("wear"), no_grass]), weights.shape[1])
    fallback_file = None
    if fallback_weights:
        fallback = _load(out / fallback_weights).astype(np.float32)
        transfer = np.rint(fallback[..., 0] * exposed)
        fallback[..., 0] -= transfer
        fallback[..., 2] += transfer
        fallback_file = "procfill_surface_fallback.png"
        _save(np.rint(fallback).astype(np.uint8), out / fallback_file)
        files.append(fallback_file)
    transfer = weights[names.index("grass")] * exposed
    weights[names.index("grass")] -= transfer
    weights[names.index("soil")] += transfer
    encoded_weights = np.rint(weights * 255).astype(np.int16)
    largest = np.argmax(encoded_weights, axis=0)
    correction = 255 - encoded_weights.sum(axis=0)
    for index in range(len(names)):
        encoded_weights[index] += np.where(largest == index, correction, 0).astype(np.int16)
    unreal_weights = []
    for layer, encoded in zip(ground_layers, encoded_weights, strict=True):
        file = f"procfill_surface_{layer['name']}.png"
        layer["file"] = file
        layer["mean_weight"] = float(encoded.mean() / 255)
        _save(encoded.astype(np.uint8), out / file)
        unreal_weights.append(frame.to_unreal_layout(encoded.astype(np.uint8)))
        files.append(file)
    ground_checks = surface.check_points(unreal_weights, names)
    tree_file = out / "trees.json"
    derived_trees = None
    if tree_file.exists():
        inventory = json.loads(tree_file.read_text())
        columns = inventory["columns"]
        for row in inventory["trees"]:
            east = row[columns.index("east_m")] + tile.size_m / 2
            north = row[columns.index("north_m")] + tile.size_m / 2
            y, x = int((tile.size_m - north) / cell_m), int(east / cell_m)
            radius = max(1, round(row[columns.index("crown_radius_m")] / cell_m))
            patch = masks["crown"][
                max(0, y - radius) : min(pixels, y + radius + 1), max(0, x - radius) : min(pixels, x + radius + 1)
            ]
            fill = float(patch.mean()) if patch.size else 1.0
            row.append(0.7 + 0.3 * fill)
        inventory["columns"] = columns + ["visual_crown_scale"]
        inventory["procfill"] = {
            "kind": "prior",
            "response": "0.7 + 0.3 * mean crown mask in the measured envelope",
            "preserved": "original positions, height, crown radius, species and collision envelope",
        }
        derived_trees = "procfill_trees.json"
        (out / derived_trees).write_text(json.dumps(inventory, separators=(",", ":")) + "\n")
        files.append(derived_trees)
    for name, data in (("priors", priors), ("validation", validation)):
        file = f"procfill_{name}.json"
        (out / file).write_text(json.dumps(data, indent=2) + "\n")
        files.append(file)
    return {
        "files": files,
        "schema_version": VERSION,
        "pixels": pixels,
        "cell_m": cell_m,
        "seed": site.seed,
        "trees_file": derived_trees,
        "evidence_debug_file": "procfill_evidence_debug.png",
        "evidence_note": "measured applies to drone pixels; appearance labels inferred from them retain inferred provenance",
        "growth_encoding": "RGBA: short density, tall density, height/2, (127+127*overlay_log2)/255",
        "surface_layers": ground_layers,
        "fallback_weights": fallback_file,
        "override_native_surface": surface_painted,
        "surface_check_points": ground_checks,
        "priors_file": "procfill_priors.json",
        "validation_file": "procfill_validation.json",
        "debug_file": "procfill_debug.png",
        "growth_file": "procfill_growth.png",
        "detail_file": "procfill_detail.png",
        "masks": {
            name: {
                "file": f"procfill_{name}.png",
                "source": f"procfill_{name}_source.png",
                "confidence": f"procfill_{name}_confidence.png",
            }
            for name in MASKS
        },
        "sources": SOURCES,
        "debug_colours_rgb": PALETTE.tolist(),
        "confidence_note": "subjective evidence strength, not calibrated probability; painted cells are separate",
        "mask_layout": "rows east, columns north, same extent as detail_ratio.png",
        "prior_render_response": {"windrow_log2": 0.12, "weeds_log2": -0.08, "wear_log2": -0.10},
        "measured_ground_share": float(coverage.mean()),
        "heldout": validation,
    }
