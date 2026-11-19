"""De-lighting and light: albedo fitted to known surfaces, and the sun and exposure of the target day."""

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


def test_the_albedo_scale_puts_the_median_paving_at_the_reflectance_of_concrete_and_checks_the_rest(tmp_path):
    # Light of 2.5 times the albedo, as a photo in full sun records it. Paving is concrete, with a strip of
    # asphalt; the grass is reported against the green lawn spectrum rather than fitted to it.
    lit = 2.5
    grass = (srgb(0.18 * 0.8), srgb(0.18 * 1.1), srgb(0.18 * 0.6))
    _, manifest = grass_and_paved(
        tmp_path,
        grass,
        grey(0.2875 * lit),
        [(40, 0, 80, 126, grey(0.2875 * lit)), (80, 0, 90, 126, grey(0.0878 * lit))],
    )

    fit = manifest["surface"]["albedo"]
    assert fit["scale"] == pytest.approx(1 / lit, rel=0.1)
    assert [anchor["surface"] for anchor in fit["anchors"]] == ["light grey concrete road (GDS375)"]
    checks = {check["surface"]: check for check in fit["checks"]}
    assert checks["old asphalt road (GDS376)"]["fitted_reflectance"] == pytest.approx(0.0878, rel=0.2)
    assert checks["green lawn grass (GDS91)"]["fitted_reflectance"] == pytest.approx(0.18 / lit, rel=0.25)
    assert "prior" in fit["priors"][0] and "USGS" in fit["source"]


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
    high, low = (
        light.lighting("2030-06-21", "12:00", 45.0, 15.0, 0.0),
        light.lighting("2030-06-21", "17:00", 45.0, 15.0, 0.0),
    )

    assert 80_000 < high["sun_lux"] < 125_000 and low["sun_lux"] < high["sun_lux"]
    assert (
        14 < high["exposure_ev100"] - light.ENGINE_EXPOSURE_OFFSET_EV < 16
        and low["exposure_ev100"] < high["exposure_ev100"] - 1
    )


def test_a_target_day_on_which_the_sun_is_down_at_that_time_is_refused_with_a_reason():
    # 07:00 solar time at 45 N in late December is before sunrise.
    with pytest.raises(RuntimeError, match="sun is"):
        light.lighting("2030-12-21", "07:00", 45.0, 15.0, 0.0)


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


def test_each_class_carries_its_mean_colour_in_linear_light_for_the_blades_of_grass(tmp_path):
    _, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED)

    colours = {layer["name"]: layer["mean_linear_rgb"] for layer in manifest["surface"]["layers"]}
    expected = {
        name: [((c / 255 + 0.055) / 1.055) ** 2.4 for c in rgb]
        for name, rgb in (("grass", h.GRASS), ("paved", h.PAVED))
    }
    assert colours["grass"] == pytest.approx(expected["grass"], rel=0.08)
    assert colours["paved"] == pytest.approx(expected["paved"], rel=0.08)
