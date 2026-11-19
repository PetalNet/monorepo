"""Cover and its shadow: fitted from heights and the sun, merged from two sources, and kept as rasters."""

from datetime import UTC, datetime

import numpy as np
import pytest
import rasterio
from PIL import Image

from envgen import cover
from envgen.build import build
from envgen.cli import main

from . import helpers as h

GROUND, DARK = (180, 180, 180), (30, 30, 30)
# Equinox: at the test site's latitude the sun stands 45 degrees up, due south, at solar noon.
DAY = "2030-09-22"
TREE = (53, 53, 73, 73)  # west, south, east, north in metres from the tile's south-west corner; 9 m tall
NOON_SHADOW = (53, 73, 73, 82)


def sources(**extra):
    return {
        "elevation": {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"},
        "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": DAY},
    } | {name: {"license": "test", "date": "2030"} | source for name, source in extra.items()}


LIDAR = {"lidar": {"kind": "file", "path": "points.las"}}
CANOPY = {"canopy_height": {"kind": "file", "path": "canopy.tif"}}


def write_canopy(path, patches, extent=60):
    """A canopy height raster, zero except for (west, south, east, north, metres) rectangles."""
    west, north = h.WEST - extent, h.SOUTH + h.SIZE_M + extent
    count = int(h.SIZE_M + 2 * extent)
    eastings = west + np.arange(count) + 0.5 - h.WEST
    northings = north - np.arange(count) - 0.5 - h.SOUTH
    heights = np.zeros((count, count), dtype=np.uint8)
    for patch_west, patch_south, patch_east, patch_north, metres in patches:
        heights[
            np.ix_(
                (northings >= patch_south) & (northings < patch_north),
                (eastings >= patch_west) & (eastings < patch_east),
            )
        ] = metres
    h.write_raster(path, heights, west, north, 1.0)


def tree_returns():
    return np.vstack([h.ground_returns(), h.returns_above(h.WEST + TREE[0], h.SOUTH + TREE[1], 20, 9.0)])


def colour(out, manifest, east_m, north_m):
    macro = np.asarray(Image.open(out / manifest["macro_colour"]["file"])).astype(int)
    scale = manifest["macro_colour"]["pixels"] / manifest["tile"]["size_m"]
    return macro[int(east_m * scale), int(north_m * scale)]


def test_the_sun_stands_where_astronomy_says():
    # Solar noon on the equinox at 45 N, 15 E falls about 7 minutes before 11:00 UTC.
    azimuth, elevation = cover.sun_position(45.0, 15.0, datetime(2030, 9, 22, 10, 53, tzinfo=UTC))
    assert azimuth == pytest.approx(180, abs=1.5) and elevation == pytest.approx(45, abs=1)
    # At the June solstice it is 23.4 degrees higher, and three hours later it has moved round to the west.
    assert cover.sun_position(45.0, 15.0, datetime(2030, 6, 21, 11, 2, tzinfo=UTC))[1] == pytest.approx(68.4, abs=1)
    azimuth, elevation = cover.sun_position(45.0, 15.0, datetime(2030, 9, 22, 13, 53, tzinfo=UTC))
    assert 225 < azimuth < 245 and 25 < elevation < 35


def test_a_shadow_falls_away_from_the_sun_and_as_far_as_the_height_and_sun_angle_say():
    ground = np.zeros((60, 60))
    height = np.zeros((60, 60))
    height[30, 30] = 10.0

    south_sun = cover.cast_shadow(ground, height, 180, 45, 1.0)
    assert south_sun[21:30, 30].all() and not south_sun[18, 30] and not south_sun[31:, 30].any()
    east_sun = cover.cast_shadow(ground, height, 90, 45, 1.0)
    assert east_sun[30, 21:30].all() and not east_sun[30, 31:].any()
    low_sun = cover.cast_shadow(ground, height, 180, 26.565, 1.0)  # a slope of one in two
    assert low_sun[12:30, 30].all() and not low_sun[9, 30]


def test_terrain_shades_the_ground_behind_it():
    ground = np.zeros((60, 60))
    ground[30:34, :] = 5.0  # a bank running east to west

    shadow = cover.cast_shadow(ground, np.zeros((60, 60)), 180, 45, 1.0)
    assert shadow[26:30, 10:50].all() and not shadow[34:, :].any() and not shadow[:24, :].any()


def test_cover_cutoff_is_the_gap_between_clutter_and_canopy_and_a_prior_when_there_is_no_gap():
    random = np.random.default_rng(1)
    heights = np.concatenate([np.zeros(5000), random.normal(1.0, 0.25, 800), random.normal(8.0, 1.5, 2000)])

    cutoff, how = cover.fit_cutoff(heights)
    assert 1.75 < cutoff < 5 and how == "histogram valley"
    assert cover.fit_cutoff(np.concatenate([np.zeros(5000), random.uniform(0.5, 9.5, 2000)])) == (2.0, "prior")
    assert cover.fit_cutoff(np.zeros(100)) == (2.0, "prior")


def test_the_time_of_day_is_fitted_to_the_shadow_in_the_imagery_and_the_shadow_stays_out_of_the_colour(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*TREE, DARK), (*NOON_SHADOW, DARK)])
    h.write_las(tmp_path / "points.las", tree_returns())
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR)), out)

    sun = manifest["cover"]["sun"]
    assert sun["azimuth_deg"] == pytest.approx(180, abs=12) and sun["elevation_deg"] == pytest.approx(45, abs=2)
    assert sun["date"] == DAY and sun["correlation"] > 0.8
    assert colour(out, manifest, 63, 78) == pytest.approx(GROUND, abs=3)


def test_an_afternoon_shadow_is_found_on_the_east_side(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    # Three hours after noon the sun is in the south-west, about 30 degrees up: a long shadow to the north-east.
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*TREE, DARK), (60, 73, 86, 82, DARK), (73, 60, 86, 82, DARK)])
    h.write_las(tmp_path / "points.las", tree_returns())
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR)), tmp_path / "out")

    assert 215 < manifest["cover"]["sun"]["azimuth_deg"] < 250


def test_canopy_the_lidar_missed_is_filled_from_the_canopy_height_raster(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    grown = (20, 20, 40, 40)  # a tree the lidar survey was too early for
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*TREE, DARK), (*grown, DARK)])
    h.write_las(tmp_path / "points.las", tree_returns())
    write_canopy(tmp_path / "canopy.tif", [(*TREE, 9), (*grown, 7)])
    lidar_only = build(h.write_site(tmp_path, sources=sources(**LIDAR)), tmp_path / "one")
    out = tmp_path / "both"
    both = build(h.write_site(tmp_path, sources=sources(**LIDAR, **CANOPY)), out)

    assert colour(tmp_path / "one", lidar_only, 30, 30).mean() < 150
    assert colour(out, both, 30, 30) == pytest.approx(GROUND, abs=3)
    report = both["cover"]
    assert report["sources"] == ["lidar", "canopy_height"]
    assert report["canopy_height_only_fraction"] == pytest.approx(400 / 126**2, rel=0.1)
    assert report["both_fraction"] == pytest.approx(400 / 126**2, rel=0.1)
    assert report["lidar_only_fraction"] < 0.002 and report["agreement"] == pytest.approx(0.5, abs=0.05)


def test_a_canopy_height_raster_alone_is_enough_for_cover(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*TREE, DARK)])
    write_canopy(tmp_path / "canopy.tif", [(*TREE, 9)])
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=sources(**CANOPY)), out)

    assert manifest["cover"]["sources"] == ["canopy_height"]
    assert colour(out, manifest, 63, 63) == pytest.approx(GROUND, abs=3)


def test_cover_is_written_as_rasters_on_the_ground_that_other_stages_can_read(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*TREE, DARK), (*NOON_SHADOW, DARK)])
    h.write_las(tmp_path / "points.las", tree_returns())
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR)), out)

    assert {"canopy_height.tif", "sunlit.tif"} <= set(manifest["artifacts"])
    with rasterio.open(out / manifest["cover"]["height"]) as heights:
        # Asked by position, not by index: the tree, and open ground.
        tree, open_ground = heights.sample([(h.WEST + 63, h.SOUTH + 63), (h.WEST + 20, h.SOUTH + 20)])
        assert tree[0] == pytest.approx(9, abs=0.1) and open_ground[0] == pytest.approx(0, abs=0.1)
        assert heights.crs.to_epsg() == 32633
    with rasterio.open(out / manifest["cover"]["sunlit"]) as sunlit:
        places = [(h.WEST + 63, h.SOUTH + 77), (h.WEST + 63, h.SOUTH + 63), (h.WEST + 63, h.SOUTH + 45)]
        in_shadow, under_the_tree, in_sun = sunlit.sample(places)
        assert in_shadow[0] == 0 and under_the_tree[0] == 0 and in_sun[0] == 1


def test_a_remote_canopy_raster_is_read_by_window_once_and_then_the_build_works_without_it(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*TREE, DARK)])
    remote = tmp_path / "remote.tif"
    write_canopy(remote, [(*TREE, 9)], extent=600)
    canopy = {"canopy_height": {"kind": "cog", "url": str(remote)}}
    site = h.write_site(tmp_path, sources=sources(**canopy))
    out = tmp_path / "out"
    first = build(site, out)

    kept = first["sources"]["canopy_height"]
    with rasterio.open(kept["path"]) as clip:
        assert clip.width < 200 and clip.height < 200  # the tile and its margin, not the 1326 m raster
    assert kept["bytes_fetched"] > 0
    remote.unlink()
    again = build(site, out)
    assert again["sources"]["canopy_height"]["bytes_fetched"] == 0 and "cover" in again["stages_reused"]


def test_the_surround_colour_leaves_out_canopy_the_raster_shows(tmp_path):
    h.write_dem(tmp_path / "dem.tif", spacing=2.0, margin=260.0)
    wood = (-200, -200, -40, 326)  # a dark wood west of the tile, 160 m wide
    west, north = h.WEST - 300, h.SOUTH + h.SIZE_M + 300
    count = int(h.SIZE_M + 600)
    rgb = np.full((3, count, count), 180, dtype=np.uint8)
    rgb[:, :, 100:260] = 30
    h.write_raster(tmp_path / "imagery.tif", rgb, west, north, 1.0)
    write_canopy(tmp_path / "canopy.tif", [(*wood, 15)], extent=300)

    def wood_colour(name, extra):
        out = tmp_path / name
        manifest = build(h.write_site(tmp_path, sources=sources(**extra), context={"size_m": 504}), out)
        surround = np.asarray(Image.open(out / manifest["context"]["colour"])).astype(int)
        # Layout is [east, north]; the surround starts 189 m west of the tile, so the wood is its first 149 m.
        return surround[int(75 / 504 * 512), 256].mean()

    assert wood_colour("plain", {}) < 60
    assert wood_colour("masked", CANOPY) > 150


def test_shadows_need_the_day_the_imagery_was_taken(tmp_path, capsys):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND)
    h.write_las(tmp_path / "points.las", tree_returns())
    undated = sources(**LIDAR)
    undated["imagery"]["date"] = "summer 2030"

    assert main(["build", str(h.write_site(tmp_path, sources=undated)), "--out", str(tmp_path / "out")]) == 1
    assert "YYYY-MM-DD" in capsys.readouterr().err


def test_trees_that_grew_after_the_heights_were_measured_are_fitted_from_the_imagery(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    # The crown is now 3 m wider all round than the 20 m the lidar measured, and its noon shadow longer.
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(50, 50, 76, 76, DARK), (50, 76, 76, 91, DARK)])
    h.write_las(tmp_path / "points.las", tree_returns())
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR)), out)

    sun = manifest["cover"]["sun"]
    assert sun["crown_spread_m"] == pytest.approx(3, abs=1) and sun["height_gain"] > 1.2
    assert sun["correlation"] > sun["correlation_before_growth"]
    assert colour(out, manifest, 52, 63) == pytest.approx(GROUND, abs=3)
    # The painted shadow is a rectangle and the fitted one is cast by a round crown, so a little of it is left.
    assert colour(out, manifest, 63, 80) == pytest.approx(GROUND, abs=12)
