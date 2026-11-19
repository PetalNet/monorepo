"""De-lighting and light: albedo fitted to known surfaces, and the sun and exposure of the target day."""

import numpy as np
import pytest
from PIL import Image

from envgen import light, surface
from envgen.build import build
from envgen.site import SiteError

from . import helpers as h
from .test_cover import DAY, LIDAR, TREE, sources, tree_returns
from .test_surface import grass_and_paved, write_noisy_scene


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
        # Of the paving, 36 % is asphalt, 48 % concrete and 16 % white: the median is concrete, the 90th percentile is not.
        [(40, 0, 58, 126, grey(0.0878 * lit)), (58, 0, 82, 126, grey(0.2875 * lit)), (82, 0, 90, 126, grey(0.4 * lit))],
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


def test_with_a_reflectance_raster_the_colour_map_is_each_class_at_its_measured_albedo_whatever_the_tone_of_the_photo(tmp_path):
    # A photo whose tone curve squeezes the highlights: it records albedo to the power 0.3. Grass, then paving
    # that is asphalt in the west and concrete in the east. The reflectance raster measures the albedo at 6 m.
    tone = lambda albedo: tuple(round(255 * value**0.3) for value in albedo)
    grass, asphalt, concrete = (0.06, 0.08, 0.04), (0.09, 0.09, 0.09), (0.28, 0.28, 0.28)
    h.write_dem(tmp_path / "dem.tif")
    patches = [(40, 0, 65, 126, tone(asphalt)), (65, 0, 90, 126, tone(concrete))]
    write_noisy_scene(tmp_path / "imagery.tif", tone(grass), patches)
    west, north, count = h.WEST - 12, h.SOUTH + h.SIZE_M + 12, 25
    eastings = west + (np.arange(count) + 0.5) * 6 - h.WEST
    measured = np.empty((3, count, count), dtype=np.float32)
    for band in range(3):
        row = np.where(eastings < 40, grass[band], np.where(eastings < 65, asphalt[band], concrete[band]))
        measured[band] = np.where(eastings >= 90, grass[band], row)[None, :]
    h.write_raster(tmp_path / "reflectance.tif", measured[::-1], west, north, 6.0)
    reflectance = {
        "kind": "file",
        "path": "reflectance.tif",
        "license": "test",
        "date": "2030-06",
        "bands": {"blue": 1, "green": 2, "red": 3},
    }
    files = {
        "elevation": {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"},
        "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"},
    }
    site = h.write_site(tmp_path, sources=files | {"reflectance": reflectance}, context={"size_m": 504})
    out = tmp_path / "out"

    manifest = build(site, out)

    fit = manifest["surface"]["albedo"]
    assert fit["scale"] == 1.0 and set(fit["curves"]) == {"grass", "paved"}
    # The curve undoes the photo's tone: reflectance goes as the photo's linear colour to a power well above 1.
    assert min(fit["curves"]["paved"]["gamma"]) > 1.5
    colour = np.asarray(Image.open(out / "macro_colour.png")).astype(float)
    pixels = colour.shape[0] / h.SIZE_M
    albedo = lambda east_m, north_m: surface.to_linear(colour[round(east_m * pixels), round(north_m * pixels)])
    assert albedo(20, 60) == pytest.approx(grass, rel=0.2)
    assert albedo(52, 60) == pytest.approx(asphalt, rel=0.2)
    assert albedo(78, 60) == pytest.approx(concrete, rel=0.2)
    by_name = {layer["name"]: layer for layer in manifest["surface"]["layers"]}
    assert by_name["grass"]["mean_linear_rgb"] == pytest.approx(grass, rel=0.05)
    checks = {(check["surface"], check["quantile"]): check for check in fit["checks"]}
    assert checks[("old asphalt road (GDS376)", "p10")]["measured_reflectance"] == pytest.approx(0.09, rel=0.05)
    assert checks[("light grey concrete road (GDS375)", "p90")]["measured_reflectance"] == pytest.approx(0.28, rel=0.05)
    assert manifest["sources"]["reflectance"]["date"] == "2030-06"
    # The surround is albedo by the same split and curves, without a near-infrared band too.
    surround = np.asarray(Image.open(out / manifest["context"]["colour"])).astype(float)
    pixels = surround.shape[0] / 504
    around = lambda east_m, north_m: surface.to_linear(
        surround[round((east_m + 189) * pixels), round((north_m + 189) * pixels)]
    )
    # Out here the low-pass is as wide as a strip of paving, so the two pavings blend; neither is the grass's level.
    assert around(20, 60) == pytest.approx(grass, rel=0.25)
    assert asphalt[0] < around(52, 60)[0] < around(78, 60)[0] < concrete[0] and around(78, 60)[0] > 0.15

    # A raster in other units, or one that does not cover the tile, is refused, not quietly dropped.
    h.write_raster(tmp_path / "reflectance.tif", measured[::-1] * 10000, west, north, 6.0)
    with pytest.raises(SiteError, match="0 to 1"):
        build(site, tmp_path / "scaled")
    h.write_raster(tmp_path / "reflectance.tif", measured[::-1], west + 5000, north, 6.0)
    with pytest.raises(SiteError, match="usable pixels"):
        build(site, tmp_path / "elsewhere")


def test_a_band_the_photo_runs_against_keeps_its_measured_level_and_says_so():
    # 100 pixels of one class. The photo is brighter where the measurement is darker: the ground changed.
    photo = np.tile(np.linspace(0.2, 0.6, 100), (3, 1))
    measured = np.tile(np.linspace(0.12, 0.06, 100), (3, 1))

    fit = surface.fit_reflectance(photo, measured, np.ones((1, 100)), np.ones(100), ["grass"])

    assert fit["curves"]["grass"]["gamma"] == [0.0, 0.0, 0.0]
    assert any("runs against" in prior for prior in fit["priors"])
    flat = surface.apply_curve(np.full((3, 2), 128.0) * [[0.5], [1.0], [1.5]], fit["curves"]["grass"])
    assert flat == pytest.approx(np.exp(np.log(measured).mean()), rel=0.01)
