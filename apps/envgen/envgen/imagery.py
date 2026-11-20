"""Leaf-off mask evidence and leaf-on colour share a grid, never spectral bands."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from . import surface
from .site import Site, SiteError, Source, Tile

VERSION = 11
NAMES = [surface.GRASS, surface.PAVED, surface.SOIL]


def _pixels(dataset, bands: list[int], window) -> tuple[np.ndarray, np.ndarray]:
    """Validity is the intersection of spectral nodata, finite values, dataset masks and alpha."""
    values = dataset.read(bands, window=window).astype(np.float32)
    valid = (dataset.read_masks(bands, window=window) > 0).all(axis=0) & np.isfinite(values).all(axis=0)
    for index, band in enumerate(bands):
        if (nodata := dataset.nodatavals[band - 1]) is not None:
            valid &= values[index] != nodata
    if ColorInterp.alpha in dataset.colorinterp:
        valid &= dataset.read(dataset.colorinterp.index(ColorInterp.alpha) + 1, window=window) > 0
    return values, valid


def reference_split(index: np.ndarray, reference: np.ndarray, valid: np.ndarray) -> dict | None:
    """Fit an index threshold to leaf-on vegetation labels, balancing the two classes equally."""
    values, grass = index[valid], reference[valid] == 0
    if len(values) > surface.MIXTURE_SAMPLE:
        keep = np.linspace(0, len(values) - 1, surface.MIXTURE_SAMPLE).astype(int)
        values, grass = values[keep], grass[keep]
    if not grass.any() or grass.all():
        return None
    order = np.argsort(values)
    values, grass = values[order], grass[order]
    # Grass is the higher vegetation index. Equal class weights prevent the larger area winning by default.
    correct = (np.cumsum(~grass) / (~grass).sum() + 1 - np.cumsum(grass) / grass.sum()) / 2
    candidates = np.flatnonzero(values[:-1] < values[1:])
    if not len(candidates):
        return None
    cut = candidates[np.argmax(correct[candidates])]
    if correct[cut] <= 0.5:
        return None
    return {
        "threshold": float((values[cut] + values[cut + 1]) / 2),
        "split": True,
        "fitted_to": "leaf-on reference vegetation labels, equally weighted classes",
        "balanced_reference_agreement": float(correct[cut]),
        "reference_cells": len(values),
    }


def read(source: Source, crs: str, tile: Tile) -> tuple[np.ndarray, np.ndarray]:
    """RGB and optional NIR on vertices, plus validity from the dataset mask in its real CRS."""
    bands = [source.band(name) for name in ("red", "green", "blue")]
    if not all(bands):
        raise SiteError("mask imagery needs explicit red, green and blue bands")
    if nir := source.band("nir"):
        bands.append(nir)
    shape = (tile.vertices, tile.vertices)
    transform = from_origin(tile.west - tile.quad_m / 2, tile.north + tile.quad_m / 2, tile.quad_m, tile.quad_m)
    with rasterio.open(source.location) as dataset:
        # One native spectral band at a time; every band averages the same intersection of valid pixels.
        support = np.zeros((dataset.height, dataset.width), dtype=np.uint8)
        for _, window in dataset.block_windows(1):
            _, valid = _pixels(dataset, bands, window)
            support[window.toslices()] = valid
        values = np.full((len(bands), *shape), np.nan, dtype=np.float32)
        for index, band in enumerate(bands):
            native = dataset.read(band).astype(np.float32)
            native[support == 0] = np.nan
            reproject(
                native,
                values[index],
                src_transform=dataset.transform,
                src_crs=dataset.crs,
                src_nodata=np.nan,
                dst_crs=crs,
                dst_transform=transform,
                dst_nodata=np.nan,
                resampling=Resampling.average,
            )
            del native
    return values, np.isfinite(values).all(axis=0)


def survey_coverage(path: str, crs: str, tile: Tile) -> np.ndarray:
    """The existing survey-detail consumer uses band 4 == 255, matching CRS, and at least four bands."""
    shape = (tile.vertices, tile.vertices)
    sampled = np.full(shape, -1, dtype=np.float32)
    with rasterio.open(path) as dataset:
        if str(dataset.crs) != crs or dataset.count < 4:
            return np.zeros(shape, dtype=bool)
        coverage = (dataset.read(4) == 255).astype(np.uint8)
        reproject(
            coverage,
            sampled,
            src_crs=dataset.crs,
            src_transform=dataset.transform,
            dst_crs=crs,
            dst_transform=from_origin(
                tile.west - tile.quad_m / 2, tile.north + tile.quad_m / 2, tile.quad_m, tile.quad_m
            ),
            dst_nodata=-1,
            resampling=Resampling.average,
        )
    return sampled > 0


def classify(site: Site, labels: np.ndarray, names: list[str]) -> tuple[np.ndarray, list[str], dict]:
    """Refine fallback masks outside the drone footprint; keep the existing survey path in charge inside it."""
    result = np.array([NAMES.index(name) for name in names], dtype=np.uint8)[labels]
    records = {}
    reserved = np.zeros(labels.shape, dtype=bool)
    if site.survey and site.survey.orthophoto:
        reserved = survey_coverage(site.survey.orthophoto, site.crs, site.tile)
        records["survey"] = {
            "valid_fraction": float(reserved.mean()),
            "policy": "reserve fully opaque survey pixels, matching the existing survey detail stage",
        }
    for name, source in [("mask_imagery", site.mask_imagery)]:
        if source is None:
            continue
        values, valid = read(source, site.crs, site.tile)
        # Leaf-off imagery exposes ground beneath deciduous crowns. The summer cover mask must not erase it.
        fitting = valid & ~reserved
        if not fitting.any():
            records[name] = {"valid_fraction": float(valid.mean()), "applied_fraction": 0.0}
            continue
        values = np.nan_to_num(values)
        local, kinds, fit = surface.classify(
            values[:3], fitting, site.tile.quad_m, values[3] if len(values) == 4 else None
        )
        if not fit["splits"] or not fit["splits"][0]["split"]:
            # An overlapping winter population is not evidence that the whole site became grass.
            index = (
                (values[3] - values[0]) / np.maximum(values[3] + values[0], 1)
                if len(values) == 4
                else surface.indices(values[:3])[0]
            )
            calibrated = reference_split(index, result, fitting)
            if calibrated:
                original = fit["splits"][0]
                fit["splits"][0] = {
                    "index": original["index"],
                    "separates": original["separates"],
                    "unassisted_fit": original,
                    **calibrated,
                }
                local = surface.apply_splits(values[:3], values[3] if len(values) == 4 else None, fit["splits"])
                kinds = NAMES
                fit["priors"] = []
                _, red, brightness = surface.indices(values[:3])
                threshold, soil_fit = surface._split(
                    red,
                    brightness**2,
                    fitting & (local != 0),
                    site.tile.quad_m,
                    "leaf-off non-vegetated cells",
                    surface.RED_INDEX,
                )
                fit["splits"].append(soil_fit | {"separates": "soil from paved"})
                if threshold is not None:
                    nonvegetated = local != 0
                    local[nonvegetated] = np.where(red[nonvegetated] >= threshold, 2, 1)
                fit["hidden_ground"] = "leaf-off ground evidence beneath summer canopy; roofs excluded downstream"
            else:
                records[name] = {
                    "valid_fraction": float(valid.mean()),
                    "fit": fit,
                    "applied": False,
                    "reason": "no usable split; reference masks retained",
                }
                continue
        if len(fit["splits"]) < 2 or not fit["splits"][1]["split"]:
            local = np.where((local == 1) & (result == 2), 2, local)
            kinds = NAMES
            fit["priors"].append("prior: unresolved non-vegetated ground retains its reference paving/soil class")
        mapped = np.array([NAMES.index(kind) for kind in kinds], dtype=np.uint8)[local]
        result[fitting] = mapped[fitting]
        records[name] = {"valid_fraction": float(valid.mean()), "applied_fraction": float(fitting.mean()), "fit": fit}
    return (
        result,
        NAMES.copy(),
        {
            "priority": ["survey", "mask_imagery", "imagery"],
            "evidence": records,
            "colour_source": "imagery (leaf-on); leaf-off RGB never sets albedo",
        },
    )


def write_native_masks(
    source: Source, splits: list[dict], target: Path, reference: np.ndarray, tile: Tile, crs: str
) -> dict:
    """Classify bounded native blocks into grass/paving/soil shares and validity, preserving source CRS."""
    bands = [source.band(name) for name in ("red", "green", "blue", "nir")]
    if not splits or not splits[0]["split"]:
        raise ValueError("native masks require an accepted vegetation split")
    with rasterio.open(source.location) as dataset:
        profile = dataset.profile | {
            "driver": "GTiff",
            "count": 4,
            "dtype": "uint8",
            "nodata": None,
            "compress": "deflate",
            "photometric": "MINISBLACK",
        }
        with rasterio.open(target, "w", **profile) as out:
            for _, window in dataset.block_windows(1):
                values, valid = _pixels(dataset, bands, window)
                labels = surface.apply_splits(values[:3], values[3], splits)
                inherited = np.full(labels.shape, 255, dtype=np.uint8)
                reproject(
                    reference,
                    inherited,
                    src_transform=from_origin(
                        tile.west - tile.quad_m / 2, tile.north + tile.quad_m / 2, tile.quad_m, tile.quad_m
                    ),
                    src_crs=crs,
                    dst_transform=dataset.window_transform(window),
                    dst_crs=dataset.crs,
                    dst_nodata=255,
                    resampling=Resampling.nearest,
                )
                valid &= inherited != 255
                if len(splits) < 2 or not splits[1]["split"]:
                    labels[(labels == 1) & (inherited == 2)] = 2
                masks = np.stack(
                    [((labels == index) & valid).astype(np.uint8) * 255 for index in range(3)]
                    + [valid.astype(np.uint8) * 255]
                )
                out.write(masks, window=window)
            for index, name in enumerate([*NAMES, "validity"], 1):
                out.set_band_description(index, name)
    return {
        "file": target.name,
        "crs": str(dataset.crs),
        "pixel_m": list(dataset.res),
        "bands": [*NAMES, "validity"],
        "priority": "fallback beneath drone alpha",
        "internal_only": True,
    }
