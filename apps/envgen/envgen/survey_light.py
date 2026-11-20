"""Fit the survey's sun to its contemporary surface model and visible ground shadows."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from scipy import ndimage

from . import cover, light
from .site import Source

CELL_M = 1.0
MIN_CELLS = 100
MIN_CORRELATION = 0.15
HEIGHT_CUTOFF_M = 2.0
VERSION = 1


def fit_shadow_time(day, latitude, longitude, grid_offset, ground, height, brightness, valid, cell_m):
    """Find solar time on a known day; return None when shadows provide too little evidence.

    Grids are north-up. Heights and imagery are contemporary, so no crown growth is fitted.
    """
    standing = np.where(valid & (height > HEIGHT_CUTOFF_M), height, 0.0)
    listen = valid & (standing == 0)
    if listen.sum() < MIN_CELLS:
        return None
    weights = listen.astype(np.float32)
    reach = cover.LOCAL_GROUND_M / cell_m
    around = ndimage.gaussian_filter(np.where(listen, brightness, 0.0), reach) / np.maximum(
        ndimage.gaussian_filter(weights, reach), 1e-6
    )
    dark = (1 - brightness / np.maximum(around, 1e-6))[listen]
    if dark.std() < 1e-6 or not standing.any():
        return None
    midnight = datetime(day.year, day.month, day.day, tzinfo=UTC)

    def score(minute):
        azimuth, elevation = cover.sun_position(latitude, longitude, midnight + timedelta(minutes=minute))
        if elevation < light.SUN_MIN_ELEVATION_DEG:
            return -1.0
        hidden = cover.cast_shadow(ground, standing, azimuth + grid_offset, elevation, cell_m)[listen]
        if not hidden.any() or hidden.all():
            return 0.0
        return float(np.corrcoef(hidden, dark)[0, 1])

    start = round(-longitude * 4)
    coarse = max(range(start, start + 1440, 20), key=score)
    best = max(range(coarse - 15, coarse + 20, 5), key=score)
    correlation = score(best)
    if correlation < MIN_CORRELATION:
        return None
    solar_time = f"{(best - start) // 60 % 24:02d}:{(best - start) % 60:02d}"
    result = light.lighting(day.isoformat(), solar_time, latitude, longitude, grid_offset)
    result["fit"] = {
        "source": "survey orthophoto ground shadows and contemporary DSM minus DTM",
        "correlation": correlation,
        "open_cells": int(listen.sum()),
        "cell_m": cell_m,
        "solar_time_resolution_minutes": 5,
    }
    return result


def from_survey(survey: Source, latitude: float, longitude: float, grid_offset: float, crs: str) -> dict | None:
    """Read the survey's own grid; unknown dates or weak fits preserve the existing imagery fit."""
    if not survey.orthophoto or not survey.terrain:
        return None
    try:
        day = date.fromisoformat(survey.date[:10])
    except ValueError:
        return None
    with rasterio.open(survey.orthophoto) as photo:
        if photo.count < 4 or not photo.crs or photo.crs != rasterio.crs.CRS.from_string(crs):
            return None
        # The site schema requires projected metres; the survey must share that metre-based frame.
        if photo.crs.linear_units != "metre":
            return None
        transform = from_origin(photo.bounds.left, photo.bounds.top, CELL_M, CELL_M)
        width = int(np.ceil((photo.bounds.right - photo.bounds.left) / CELL_M))
        height = int(np.ceil((photo.bounds.top - photo.bounds.bottom) / CELL_M))
        grid = {"crs": photo.crs, "transform": transform, "width": width, "height": height}
        with WarpedVRT(photo, **grid, resampling=Resampling.average) as view:
            rgb = view.read([1, 2, 3]).astype(np.float32)
            valid = view.read(4) > 250
        brightness = np.tensordot(np.array([0.2126, 0.7152, 0.0722]), rgb, 1)
    elevations = []
    for path in (survey.terrain, survey.location):
        with (
            rasterio.open(path) as source,
            WarpedVRT(source, **grid, resampling=Resampling.bilinear, nodata=np.nan, dtype="float32") as view,
        ):
            elevations.append(view.read(1))
    ground, surface = elevations
    valid &= np.isfinite(ground) & np.isfinite(surface)
    if valid.sum() < MIN_CELLS:
        return None
    # Fill only for ray traversal; unobserved cells never participate in fitting.
    nearest = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    ground = ground[tuple(nearest)]
    height = np.where(valid, np.maximum(surface - ground, 0), 0)
    result = fit_shadow_time(day, latitude, longitude, grid_offset, ground, height, brightness, valid, CELL_M)
    if result is not None:
        result["fit"]["source_date"] = survey.date
        result["priors"] += [
            "prior: first ISO date in survey metadata; mosaicked flights may have different dates and times",
            f"prior: fit at {CELL_M:g} m, standing cover above {HEIGHT_CUTOFF_M:g} m, minimum correlation {MIN_CORRELATION:g}",
            "prior: the same survey sun is used across the full generated site",
        ]
    return result
