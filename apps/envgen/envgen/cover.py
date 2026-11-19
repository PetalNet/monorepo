"""What stands over the ground, and where its shadow fell when the imagery was taken.

Cover is measured, never guessed from the colour of the imagery: lidar height above ground first,
and a canopy height raster, if the site has one, for what the lidar missed. The shadow is cast from
that cover and the terrain by the sun at the imagery's date; the time of day is the one thing fitted.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta

import numpy as np

# Used only when the heights show no gap between what hugs the ground and what stands over it.
CUTOFF_PRIOR_M = 2.0
# The lowest sun an aerial survey flies under.
SUN_MIN_ELEVATION_DEG = 25.0
# A gap in the heights counts when it holds at most this share of the smaller peak beside it.
VALLEY_MAX = 0.5


def fit_cutoff(height_m: np.ndarray) -> tuple[float, str]:
    """The height that separates ground clutter from cover: the emptiest height between the two.

    Returns (cutoff, "histogram valley" or "prior"). Cars, shrubs and noise sit under it; canopy and roofs over it.
    """
    edges = np.arange(0.5, 10.25, 0.25)
    counts = np.histogram(height_m, bins=edges)[0].astype(float)
    counts = np.convolve(counts, np.ones(3) / 3, mode="same")
    below = np.maximum.accumulate(counts)
    above = np.maximum.accumulate(counts[::-1])[::-1]
    # Only a height with a real peak on both sides is a gap: clutter below it, and canopy or roofs above.
    between = np.minimum(below, above) >= max(0.1 * counts.max(), 1.0)
    if not between.any():
        return CUTOFF_PRIOR_M, "prior"
    depth = np.where(between, counts / np.maximum(np.minimum(below, above), 1.0), np.inf)
    valley = int(np.argmin(depth))
    if depth[valley] > VALLEY_MAX:
        return CUTOFF_PRIOR_M, "prior"
    return float(edges[valley] + 0.125), "histogram valley"


def combine(lidar_m: np.ndarray | None, second_m: np.ndarray | None) -> tuple[np.ndarray, dict]:
    """Height above ground from both sources, with what each contributed. The lidar wins where it sees cover."""
    primary = lidar_m if lidar_m is not None else second_m
    cutoff, how = fit_cutoff(primary)
    report = {"cutoff_m": cutoff, "cutoff_from": how}
    if lidar_m is None or second_m is None:
        report["covered_fraction"] = float((primary > cutoff).mean())
        return primary.astype(np.float32), report
    in_lidar, in_second = lidar_m > cutoff, second_m > cutoff
    height = np.where(in_second & ~in_lidar, second_m, lidar_m).astype(np.float32)
    either = in_lidar | in_second
    report |= {
        "covered_fraction": float(either.mean()),
        "both_fraction": float((in_lidar & in_second).mean()),
        "lidar_only_fraction": float((in_lidar & ~in_second).mean()),
        "canopy_height_only_fraction": float((in_second & ~in_lidar).mean()),
        "agreement": float((in_lidar & in_second).sum() / max(either.sum(), 1)),
    }
    return height, report


def sun_position(latitude_deg: float, longitude_deg: float, when: datetime) -> tuple[float, float]:
    """(azimuth clockwise from true north, elevation), in degrees, from NOAA's low-accuracy formulas. `when` is UTC."""
    hours = when.hour + when.minute / 60 + when.second / 3600
    year_angle = 2 * math.pi / 365 * (when.timetuple().tm_yday - 1 + (hours - 12) / 24)
    equation_of_time_min = 229.18 * (
        0.000075
        + 0.001868 * math.cos(year_angle)
        - 0.032077 * math.sin(year_angle)
        - 0.014615 * math.cos(2 * year_angle)
        - 0.040849 * math.sin(2 * year_angle)
    )
    declination = (
        0.006918
        - 0.399912 * math.cos(year_angle)
        + 0.070257 * math.sin(year_angle)
        - 0.006758 * math.cos(2 * year_angle)
        + 0.000907 * math.sin(2 * year_angle)
        - 0.002697 * math.cos(3 * year_angle)
        + 0.00148 * math.sin(3 * year_angle)
    )
    hour_angle = math.radians((hours * 60 + equation_of_time_min + 4 * longitude_deg) / 4 - 180)
    latitude = math.radians(latitude_deg)
    sine = math.sin(latitude) * math.sin(declination) + math.cos(latitude) * math.cos(declination) * math.cos(
        hour_angle
    )
    azimuth = math.atan2(
        math.sin(hour_angle), math.cos(hour_angle) * math.sin(latitude) - math.tan(declination) * math.cos(latitude)
    )
    return (math.degrees(azimuth) + 180) % 360, math.degrees(math.asin(max(-1.0, min(1.0, sine))))


def cast_shadow(
    ground_m: np.ndarray, height_m: np.ndarray, azimuth_deg: float, elevation_deg: float, cell_m: float
) -> np.ndarray:
    """Cells whose ground the sun does not reach, on a north-up grid. `azimuth_deg` is clockwise from grid north."""
    surface = ground_m + height_m
    rise = cell_m * math.tan(math.radians(elevation_deg))
    step_row, step_column = -math.cos(math.radians(azimuth_deg)), math.sin(math.radians(azimuth_deg))
    rows, columns = surface.shape
    shadow = np.zeros(surface.shape, dtype=bool)
    reach = math.ceil(float(surface.max() - ground_m.min()) / rise)
    for step in range(1, min(reach, max(rows, columns)) + 1):
        # What stands `step` cells towards the sun, lowered by how far a ray climbs on the way there.
        down, right = round(step * step_row), round(step * step_column)
        here = (slice(max(0, -down), rows - max(0, down)), slice(max(0, -right), columns - max(0, right)))
        there = (slice(max(0, down), rows - max(0, -down)), slice(max(0, right), columns - max(0, -right)))
        shadow[here] |= surface[there] - step * rise > ground_m[here] + 0.5
    return shadow


def fit_sun(
    day: date,
    latitude_deg: float,
    longitude_deg: float,
    grid_north_offset_deg: float,
    ground_m: np.ndarray,
    height_m: np.ndarray,
    cutoff_m: float,
    brightness: np.ndarray,
    cell_m: float,
) -> tuple[np.ndarray, dict]:
    """The shadow at the time of day that best explains where the open ground is dark in the imagery.

    The date fixes the sun's path; only the time along it is searched, first every 20 minutes and
    then every 5 around the best. Returns the shadow and what was fitted.
    """
    standing = np.where(height_m > cutoff_m, height_m, 0.0)
    open_ground = standing == 0
    dark = -(brightness[open_ground] - brightness[open_ground].mean())
    midnight = datetime(day.year, day.month, day.day, tzinfo=UTC)

    def score(minute: int) -> tuple[float, np.ndarray | None, float, float]:
        azimuth, elevation = sun_position(latitude_deg, longitude_deg, midnight + timedelta(minutes=minute))
        if elevation < SUN_MIN_ELEVATION_DEG:
            return -1.0, None, azimuth, elevation
        shadow = cast_shadow(ground_m, standing, azimuth + grid_north_offset_deg, elevation, cell_m)
        inside = shadow[open_ground]
        if not inside.any() or inside.all() or dark.std() < 1e-6:
            # Nothing to compare: no shadow falls on open ground, or the imagery is one flat brightness.
            return 0.0, shadow, azimuth, elevation
        # How much darker the predicted shadow is than the rest, as a correlation.
        return float(np.corrcoef(inside, dark)[0, 1]), shadow, azimuth, elevation

    # The local day runs from solar midnight, which the longitude places in UTC.
    start = round(-longitude_deg * 4)
    coarse = max(range(start, start + 24 * 60, 20), key=lambda minute: score(minute)[0])
    best = max(range(coarse - 15, coarse + 20, 5), key=lambda minute: score(minute)[0])
    correlation, shadow, azimuth, elevation = score(best)
    if shadow is None:
        raise RuntimeError(
            f"the sun never rises above {SUN_MIN_ELEVATION_DEG:.0f} degrees on {day}; check the imagery date"
        )
    when = midnight + timedelta(minutes=best)
    return shadow & open_ground, {
        "date": day.isoformat(),
        "fitted_time_utc": when.strftime("%H:%M"),
        "fitted_to": "where the open ground is dark in the imagery",
        "correlation": correlation,
        "azimuth_deg": azimuth,
        "elevation_deg": elevation,
    }
