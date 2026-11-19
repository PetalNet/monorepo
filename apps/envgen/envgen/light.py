"""The light of the target day: where the sun is, how strong it is, and the exposure that matches."""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta

from .cover import sun_position

# Priors, used where the site says nothing. Each is listed in the manifest's `priors`.
DAY_OF_MONTH_PRIOR = 15
SOLAR_TIME_PRIOR = "12:00"
# Meinel and Meinel's clear-sky direct beam: 1353 W/m2 outside the atmosphere, 0.7 of it through one air mass.
SOLAR_CONSTANT_W_M2 = 1353.0
CLEAR_SKY_TRANSMITTANCE = 0.7
# Luminous efficacy of direct sunlight.
SUN_LUMENS_PER_WATT = 105.0
# Skylight on a horizontal surface as a share of the sun's.
SKY_SHARE_OF_SUN = 0.2
# The camera's lens attenuation constant in the exposure equation, as the engine uses it.
LENS_ATTENUATION = 1.2
# Added to the textbook exposure. The lit frame showed sunlit grass about 3.5 times brighter than the BaseColor buffer
# (albedo 0.10) times illuminance over pi, which is 1.8 EV over; this offset is 0.95 EV, tuned on UE 5.8.4 so that
# sunlit grass in the render is about as bright as it is in the photo. It is a tuned prior, not a measurement,
# and is listed as one in the manifest. The sun may also be attenuated twice (see the README).
ENGINE_EXPOSURE_OFFSET_EV = 0.95
# Below this the sun is too low for the clear-sky model, and for the shadows the imagery shows.
SUN_MIN_ELEVATION_DEG = 5.0


def target_day(target_date: str) -> tuple[date, bool]:
    """The day, and whether it had to be assumed: a month alone is taken to mean its middle."""
    parts = [int(part) for part in target_date.split("-")]
    if len(parts) == 3:
        return date(*parts), False
    return date(parts[0], parts[1], DAY_OF_MONTH_PRIOR), True


def air_mass(elevation_deg: float) -> float:
    """Kasten and Young's relative optical air mass."""
    return 1 / (math.sin(math.radians(elevation_deg)) + 0.50572 * (6.07995 + elevation_deg) ** -1.6364)


def sun_illuminance_lux(elevation_deg: float) -> float:
    """Light from the sun's direction, on a surface facing it, under a clear sky."""
    watts = SOLAR_CONSTANT_W_M2 * CLEAR_SKY_TRANSMITTANCE ** (air_mass(elevation_deg) ** 0.678)
    return watts * SUN_LUMENS_PER_WATT


def exposure_ev100(elevation_deg: float) -> float:
    """The EV100 at which a surface in sun and sky renders at its own reflectance, before tone mapping.

    A surface of reflectance g under illuminance E has luminance g * E / pi, and the engine scales luminance by
    1 / (1.2 * 2**EV100), so every reflectance lands at itself when 2**EV100 = E / (1.2 * pi). The tuned offset is added.
    """
    sun_on_ground = sun_illuminance_lux(elevation_deg) * math.sin(math.radians(elevation_deg))
    return math.log2(sun_on_ground * (1 + SKY_SHARE_OF_SUN) / (LENS_ATTENUATION * math.pi)) + ENGINE_EXPOSURE_OFFSET_EV


def lighting(
    target_date: str,
    solar_time: str | None,
    latitude_deg: float,
    longitude_deg: float,
    grid_north_offset_deg: float,
) -> dict:
    """The sun on the target day at the imagery's time of day, and the light and exposure that go with it.

    `solar_time` is local mean solar time, "HH:MM": the time of day the imagery was fitted to, so shadows
    and lit colour agree. Where there is none the day's noon stands in, as a prior.
    """
    day, day_assumed = target_day(target_date)
    time_assumed = solar_time is None
    hours, minutes = (int(part) for part in (solar_time or SOLAR_TIME_PRIOR).split(":"))
    # Mean solar midnight falls at -4 minutes per degree of longitude, in UTC.
    when = datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(
        minutes=round(-longitude_deg * 4) + hours * 60 + minutes
    )
    azimuth, elevation = sun_position(latitude_deg, longitude_deg, when)
    if elevation < SUN_MIN_ELEVATION_DEG:
        raise RuntimeError(
            f"the sun is {elevation:.1f} degrees up at {hours:02d}:{minutes:02d} solar time on {day}; "
            "choose a target date nearer the imagery's season"
        )
    priors = []
    if day_assumed:
        priors.append(f"prior: the {DAY_OF_MONTH_PRIOR}th of the target month")
    if time_assumed:
        priors.append(f"prior: {SOLAR_TIME_PRIOR} solar time; the imagery's time of day is not known")
    priors += [
        f"prior: clear sky ({CLEAR_SKY_TRANSMITTANCE} ** air mass ** 0.678 of the beam arrives), skylight {SKY_SHARE_OF_SUN:.0%} of the sun's",
        f"prior: the engine's exposure offset, {ENGINE_EXPOSURE_OFFSET_EV} EV, tuned on UE 5.8.4",
        f"prior: {SUN_LUMENS_PER_WATT:.0f} lm/W for direct sunlight",
    ]
    return {
        "date": day.isoformat(),
        "solar_time": f"{hours:02d}:{minutes:02d}",
        "time_utc": when.isoformat(),
        "azimuth_deg": azimuth,
        # The engine's X axis is grid north, which is not quite true north.
        "grid_azimuth_deg": (azimuth + grid_north_offset_deg) % 360,
        "elevation_deg": elevation,
        "sun_lux": sun_illuminance_lux(elevation),
        "exposure_ev100": exposure_ev100(elevation),
        "priors": priors,
    }
