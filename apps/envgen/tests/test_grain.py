"""The grain of grass, measured from an orthophoto, and the turf the manifest asks the engine to grow."""

from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image

from envgen import grain, turf
from envgen.build import build

from . import helpers as h
from .helpers import CRS, SOUTH, WEST, write_raster
from .test_surface import write_noisy_scene
from .test_trees import ALONE, scene, sources, survey, write_lidar

PIXEL_M = 0.05
SIZE_PX = 1024
SIDE_M = SIZE_PX * PIXEL_M
NORTH = SOUTH + 200


def _grey(linear: np.ndarray) -> np.ndarray:
    """Linear light to sRGB, 0 to 255."""
    encoded = np.where(linear <= 0.0031308, 12.92 * linear, 1.055 * np.clip(linear, 1e-6, 1) ** (1 / 2.4) - 0.055)
    return np.rint(np.clip(encoded, 0, 1) * 255).astype(np.uint8)


def _ortho(path, sigma_log2: float, seed: int = 3, alpha: int = 255):
    """Mid grey in linear light, each pixel multiplied by 2 to an independent normal power."""
    rng = np.random.default_rng(seed)
    grey = _grey(0.2 * 2 ** rng.normal(0, sigma_log2, (SIZE_PX, SIZE_PX)))
    write_raster(path, np.stack([grey, grey, grey, np.full_like(grey, alpha)]), WEST, NORTH, PIXEL_M)


def _grass(share: float = 1.0) -> np.ndarray:
    return np.full((64, 64), share, dtype=np.float32)


def _measure(path, grass=None, seed=1, crs=CRS):
    return grain.measure(path, crs, WEST, NORTH, SIDE_M, _grass() if grass is None else grass, seed)


def test_the_texture_has_the_orthophotos_grain_strength_and_no_net_brightening(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4)
    measured, reason = _measure(tmp_path / "o.tif")
    assert measured is not None, reason
    ratio = 2 ** grain.decode(measured.encoded)
    # Independent per-pixel noise of 0.4 octaves, less what its own low-pass takes out.
    assert measured.std_log2 == pytest.approx(0.4, rel=0.1)
    assert ratio.mean() == pytest.approx(1.0, abs=0.04)
    assert measured.pixel_m == pytest.approx(PIXEL_M)


def test_the_texture_tiles_without_a_seam(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4)
    measured, _ = _measure(tmp_path / "o.tif")
    field = grain.decode(measured.encoded)
    inside = np.abs(np.diff(field, axis=1)).mean()
    across = np.abs(field[:, 0] - field[:, -1]).mean()
    assert across == pytest.approx(inside, rel=0.15)


def test_the_same_seed_gives_the_same_texture_and_another_seed_another(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4)
    first, _ = _measure(tmp_path / "o.tif", seed=5)
    again, _ = _measure(tmp_path / "o.tif", seed=5)
    other, _ = _measure(tmp_path / "o.tif", seed=6)
    assert np.array_equal(first.encoded, again.encoded)
    assert not np.array_equal(first.encoded, other.encoded)


def test_without_grass_under_it_the_orthophoto_says_nothing(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4)
    measured, reason = _measure(tmp_path / "o.tif", grass=_grass(0.2))
    assert measured is None
    assert "pure grass" in reason


def test_pixels_the_orthophoto_does_not_have_do_not_count(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4, alpha=0)
    measured, reason = _measure(tmp_path / "o.tif")
    assert measured is None
    assert "pure grass" in reason


def test_an_orthophoto_in_another_projection_is_refused_with_the_reason(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4)
    measured, reason = _measure(tmp_path / "o.tif", crs="EPSG:32634")
    assert measured is None
    assert CRS in reason


def test_each_variety_has_the_leaf_it_says_and_the_far_one_has_blades_a_pixel_wide_where_the_near_one_ends():
    grass = turf.describe()
    varieties = {variety["name"]: variety for variety in grass["varieties"]}
    for name, spec in (("near", turf.NEAR), ("clump", turf.CLUMP), ("tall", turf.TALL)):
        variety = varieties[name]
        # Blades on a square metre times the area of one, a triangle of the mean width and height.
        blade_cm2 = np.mean(variety["blade_width_cm"]) * np.mean(variety["height_cm"]) / 2
        leaf = variety["density_per_100m2"] / 100 * variety["blades"] * blade_cm2 / 10000
        assert leaf == pytest.approx(spec["leaf_area_index"], rel=0.01)
        assert variety["height_source"]
    assert varieties["tall"]["height_cm"][0] > varieties["near"]["height_cm"][1]
    assert varieties["near"]["density_per_100m2"] > varieties["clump"]["density_per_100m2"]
    assert varieties["clump"]["start_cull_cm"] > varieties["near"]["start_cull_cm"]
    # One pixel of a 1920 pixel, 90 degree frame at 15 m, where the near variety ends, is 1.56 cm.
    assert varieties["clump"]["blade_width_cm"][0] == pytest.approx(1.56, abs=0.01)
    # The clump's wide blades are not at a walker's feet: they grow in where the near variety shrinks away.
    assert varieties["clump"]["appear_cm"] == [varieties["near"]["start_cull_cm"], varieties["near"]["end_cull_cm"]]
    assert varieties["near"]["appear_cm"] == [0, 0]
    assert varieties["near"]["blade_width_cm"] == list(turf.NEAR_BLADE_WIDTH_CM)
    assert all(prior.startswith("prior:") for prior in grass["priors"])


def test_the_grain_carries_the_colour_that_goes_with_brightness_and_blades_take_it_in_equal_shares(tmp_path):
    # Straw among green: where a pixel is brighter it is redder. Red moves 1.5 times as far as green, blue half as far.
    rng = np.random.default_rng(3)
    power = rng.normal(0, 0.4, (SIZE_PX, SIZE_PX))
    bands = [_grey(0.2 * 2 ** (power * slope)) for slope in (1.5, 1.0, 0.5)]
    write_raster(tmp_path / "o.tif", np.stack([*bands, np.full_like(bands[0], 255)]), WEST, NORTH, PIXEL_M)

    measured, reason = _measure(tmp_path / "o.tif")

    assert measured is not None, reason
    red, green, blue = measured.tint
    assert red / green == pytest.approx(1.5, rel=0.05) and blue / green == pytest.approx(0.5, rel=0.05)
    assert min(measured.tint_explains) > 0.95
    colours = np.array(measured.blade_colours)
    assert len(colours) == grain.BLADE_COLOURS
    # From dark to bright, and the bright blades are the red ones.
    assert (np.diff(colours[:, 1]) > 0).all()
    assert colours[0, 0] < colours[0, 1] < colours[0, 2] and colours[-1, 0] > colours[-1, 1] > colours[-1, 2]
    # Equal shares of a symmetric distribution: as many blades darker than the ground as brighter.
    assert np.log2(colours[:, 1]).mean() == pytest.approx(0.0, abs=0.08)


def test_a_grey_orthophoto_gives_a_grey_grain(tmp_path):
    _ortho(tmp_path / "o.tif", sigma_log2=0.4)
    measured, _ = _measure(tmp_path / "o.tif")
    assert measured.tint == pytest.approx((1.0, 1.0, 1.0), abs=0.02)


def test_the_survey_ratio_shows_the_orthophotos_fine_pattern_on_open_ground_and_nothing_where_cover_hides_it(tmp_path):
    extra = survey(tmp_path, (100, 110, 4, 7))
    # The survey's footprint is the east half of the tile. The orthophoto over it is stripes a metre wide, bright and dark.
    west, north, pixel = h.WEST + 63, h.SOUTH + h.SIZE_M, 0.05
    eastings = west + (np.arange(int(63 / pixel)) + 0.5) * pixel
    stripes = np.where(eastings // 1.0 % 2 == 0, 0.25, 0.15)[None, :] * np.ones((int(h.SIZE_M / pixel), 1))
    # Brighter over the northern 26 m, which tells north from south; and no pixels in one corner.
    northings = north - (np.arange(int(h.SIZE_M / pixel)) + 0.5) * pixel
    stripes = stripes * np.where(northings > h.SOUTH + 100, 1.5, 1.0)[:, None]
    grey = _grey(stripes)
    alpha = np.full_like(grey, 255)
    alpha[-100:, -100:] = 0  # the south-east corner, 5 m square
    write_raster(tmp_path / "ortho.tif", np.stack([grey, grey, grey, alpha]), west, north, pixel)
    extra["survey"]["orthophoto"] = "ortho.tif"
    out = tmp_path / "out"
    manifest = build(scene(tmp_path, **extra), out)

    detail = manifest["survey_detail"]
    assert "survey_detail.png" in manifest["artifacts"] and manifest["sources"]["survey"]["orthophoto_sha256"]
    assert detail["pixel_m"] == pytest.approx(pixel) and detail["east_extent_m"] == pytest.approx(63)
    raw = np.asarray(Image.open(out / "survey_detail.png"))  # [east, north]
    ratio = (raw.astype(np.float32) - detail["zero"]) * (detail["log2_range"] / detail["zero"])  # [east, north]

    def at(east_m, north_m):
        return ratio[
            int((east_m - detail["west_m"]) / pixel) - 20 : int((east_m - detail["west_m"]) / pixel) + 20,
            int((north_m - detail["south_m"]) / pixel),
        ]

    open_grass = at(110, 20)  # a strip of the grass along the south edge, no tree, no roof
    assert open_grass.max() > 0.25 and open_grass.min() < -0.3
    # Bright stripes of 0.25 over dark of 0.15 are 0.74 octaves apart.
    assert open_grass.max() - open_grass.min() == pytest.approx(np.log2(0.25 / 0.15), abs=0.25)
    assert np.abs(at(90, 75)).max() < 0.05  # on the roof
    assert at(120, 115).mean() > at(120, 20).mean() + 0.02  # north is brighter: the file's north axis is the tile's
    assert (raw[-100:, :100] == 0).all()  # no pixel there is 0, not a neutral ratio
    assert (raw[: -100 - 20, :] > 0).all()  # and nowhere else is


def test_a_shadow_nothing_standing_explains_is_read_from_the_photo_and_left_out_of_the_detail(tmp_path):
    # A shadow across open grass, 6 m wide, with about a third of the light. Nothing in the lidar stands beside it.
    h.write_dem(tmp_path / "dem.tif")
    dark = tuple(round(value * 0.6) for value in h.GRASS)
    write_noisy_scene(tmp_path / "imagery.tif", h.GRASS, [(0, 55, 38, 92, h.PAVED), (60, 5, 66, 105, dark)])
    write_lidar(tmp_path / "points.las", (ALONE,))
    out = tmp_path / "out"

    manifest = build(h.write_site(tmp_path, sources=sources(lidar={"kind": "file", "path": "points.las"})), out)

    shadow = manifest["detail"]["shadows"]["grass"]
    assert -1.7 < shadow["gap_log2"] < -0.5
    assert shadow["in_shadow"] == pytest.approx(6 * 100 / (126 * 126 - 38 * 37), rel=0.3)
    ratio = np.asarray(Image.open(out / "detail_ratio.png")).astype(int)  # [east, north]
    pixels = ratio.shape[0] / h.SIZE_M
    at = lambda east_m, north_m: ratio[round(east_m * pixels), round(north_m * pixels)]
    assert (at(63, 30) == manifest["detail"]["zero"]).all()  # in the shadow: no darker than the turf around it
    assert np.abs(at(75, 30) - manifest["detail"]["zero"]).max() < 40  # beside it: the photo's own noise, kept
