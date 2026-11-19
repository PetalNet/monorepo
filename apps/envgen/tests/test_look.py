"""De-lighting and light: albedo fitted to known surfaces, and the sun and exposure of the target day."""

import math

import numpy as np
import pytest

from envgen import light, surface
from envgen.build import build

from . import helpers as h
from .test_cover import DAY, LIDAR, TREE, sources, tree_returns
from .test_surface import grass_and_paved


def srgb(linear):
    return round(255 * (12.92 * linear if linear <= 0.0031308 else 1.055 * linear ** (1 / 2.4) - 0.055))


def grey(linear):
    return (srgb(linear),) * 3


def test_the_albedo_scale_is_the_one_that_puts_grass_asphalt_and_concrete_at_their_known_reflectances(tmp_path):
    # Light of 2.5 times the albedo, as a photo in full sun records it: grass 0.15, asphalt 0.075, concrete 0.30.
    lit = 2.5
    grass = (srgb(0.15 * lit * 0.8), srgb(0.15 * lit * 1.1), srgb(0.15 * lit * 0.6))
    _, manifest = grass_and_paved(
        tmp_path,
        grass,
        grey(0.30 * lit),
        [(40, 0, 65, 126, grey(0.30 * lit)), (65, 0, 90, 126, grey(0.075 * lit))],
    )

    fit = manifest["surface"]["albedo"]
    assert fit["scale"] == pytest.approx(1 / lit, rel=0.1)
    assert {anchor["surface"] for anchor in fit["anchors"]} == {"healthy grass", "asphalt", "aged concrete"}
    assert all(anchor["within_quoted_range"] for anchor in fit["anchors"])
    assert "prior" in fit["priors"][0]


def test_a_brighter_photo_gets_a_smaller_scale():
    dim = surface.fit_albedo({"grass": {"p50": 0.1}, "paved": {"p10": 0.05, "p90": 0.2}})["scale"]
    bright = surface.fit_albedo({"grass": {"p50": 0.3}, "paved": {"p10": 0.15, "p90": 0.6}})["scale"]

    assert dim == pytest.approx(3 * bright)


def test_a_tile_with_no_known_surface_falls_back_to_a_tagged_prior():
    fit = surface.fit_albedo({"soil": {"p50": 0.3}})

    assert fit["scale"] == surface.ALBEDO_SCALE_PRIOR and fit["anchors"] == [] and "prior" in fit["priors"][0]


def test_the_sun_follows_the_site_and_the_day_and_the_manifest_says_what_was_assumed():
    # The equinox at 45 N, 15 E: due south and 45 degrees up at solar noon.
    noon = light.lighting("2030-09-22", "12:00", 45.0, 15.0, 0.0)
    morning = light.lighting("2030-09-22", "09:00", 45.0, 15.0, 0.0)
    summer = light.lighting("2030-06-21", "12:00", 45.0, 15.0, 0.0)

    assert noon["azimuth_deg"] == pytest.approx(180, abs=3) and noon["elevation_deg"] == pytest.approx(45, abs=1.5)
    assert 90 < morning["azimuth_deg"] < 150 and morning["elevation_deg"] < noon["elevation_deg"]
    assert summer["elevation_deg"] > noon["elevation_deg"] + 15
    assert noon["priors"] and not any("15th" in prior or "solar time" in prior for prior in noon["priors"])
    assumed = light.lighting("2030-09", None, 45.0, 15.0, 0.0)
    assert any("15th" in prior for prior in assumed["priors"]) and any("12:00" in prior for prior in assumed["priors"])


def test_grid_north_turns_the_sun_with_the_grid():
    plain = light.lighting("2030-09-22", "10:00", 45.0, 15.0, 0.0)
    turned = light.lighting("2030-09-22", "10:00", 45.0, 15.0, 2.0)

    assert turned["grid_azimuth_deg"] == pytest.approx(plain["grid_azimuth_deg"] + 2)


def test_sun_strength_and_exposure_fall_together_as_the_sun_sinks():
    high, low = light.lighting("2030-06-21", "12:00", 45.0, 15.0, 0.0), light.lighting("2030-06-21", "17:00", 45.0, 15.0, 0.0)

    assert 80_000 < high["sun_lux"] < 125_000 and low["sun_lux"] < high["sun_lux"]
    assert 14 < high["exposure_ev100"] < 16 and low["exposure_ev100"] < high["exposure_ev100"] - 1
    # The exposure that makes the engine's mid-grey land at mid-grey, rederived from its own equation.
    illuminance = high["sun_lux"] * math.sin(math.radians(high["elevation_deg"])) * 1.2
    assert 2 ** high["exposure_ev100"] == pytest.approx(illuminance / (1.2 * math.pi), rel=1e-6)


def test_the_build_lights_the_site_at_the_time_of_day_the_imagery_was_fitted_to(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", (180, 180, 180), [(*TREE, (30, 30, 30)), (53, 73, 73, 82, (30, 30, 30))])
    h.write_las(tmp_path / "points.las", tree_returns())
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR)), tmp_path / "out")

    lit, fitted = manifest["lighting"], manifest["cover"]["sun"]
    assert lit["solar_time"] == fitted["fitted_solar_time"]
    # The target month is June; the imagery's day was the autumn equinox, so the same solar time is higher now.
    assert lit["date"] == "2030-06-15" and lit["elevation_deg"] > fitted["elevation_deg"]
    assert DAY == fitted["date"]
    assert any("15th" in prior for prior in lit["priors"]) and not any("solar time" in prior for prior in lit["priors"])


def test_without_cover_the_sun_is_at_noon_as_a_stated_prior(tmp_path):
    _, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED)

    assert manifest["lighting"]["solar_time"] == "12:00"
    assert any("12:00" in prior for prior in manifest["lighting"]["priors"])
    assert np.isfinite(manifest["lighting"]["sun_lux"])
