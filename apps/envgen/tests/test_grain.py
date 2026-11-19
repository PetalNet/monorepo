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
from .test_trees import scene, survey

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


def test_each_variety_covers_the_ground_it_says_and_the_tall_one_stands_over_the_mown_height():
    grass = turf.describe()
    varieties = {variety["name"]: variety for variety in grass["varieties"]}
    for name, spec in (("near", turf.NEAR), ("clump", turf.CLUMP), ("tall", turf.TALL)):
        variety = varieties[name]
        covered = variety["density_per_100m2"] / 100 * math.pi * (variety["radius_cm"] / 100) ** 2
        assert covered == pytest.approx(spec["cover"], rel=0.01)
        assert variety["height_source"]
    assert varieties["tall"]["height_cm"][0] > varieties["near"]["height_cm"][1]
    assert varieties["near"]["density_per_100m2"] > varieties["clump"]["density_per_100m2"]
    assert varieties["clump"]["start_cull_cm"] > varieties["near"]["start_cull_cm"]
    assert all(prior.startswith("prior:") for prior in grass["priors"])


def test_the_survey_ratio_shows_the_orthophotos_fine_pattern_on_open_ground_and_nothing_where_cover_hides_it(tmp_path):
    extra = survey(tmp_path, (100, 110, 4, 7))
    # The survey's footprint is the east half of the tile. The orthophoto over it is stripes a metre wide, bright and dark.
    west, north, pixel = h.WEST + 63, h.SOUTH + h.SIZE_M, 0.05
    eastings = west + (np.arange(int(63 / pixel)) + 0.5) * pixel
    stripes = np.where(eastings // 1.0 % 2 == 0, 0.25, 0.15)[None, :] * np.ones((int(h.SIZE_M / pixel), 1))
    grey = _grey(stripes)
    write_raster(tmp_path / "ortho.tif", np.stack([grey, grey, grey, np.full_like(grey, 255)]), west, north, pixel)
    extra["survey"]["orthophoto"] = "ortho.tif"
    out = tmp_path / "out"
    manifest = build(scene(tmp_path, **extra), out)

    detail = manifest["survey_detail"]
    assert "survey_detail.png" in manifest["artifacts"] and manifest["sources"]["survey"]["orthophoto_sha256"]
    assert detail["pixel_m"] == pytest.approx(pixel) and detail["east_extent_m"] == pytest.approx(63)
    ratio = (np.asarray(Image.open(out / "survey_detail.png")).astype(np.float32) - detail["zero"]) * (
        detail["log2_range"] / detail["zero"]
    )  # [east, north]

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
