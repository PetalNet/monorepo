"""What lidar adds: ground colour without trees in it, smoothing where the ground was not measured, and the surround."""

import numpy as np
import pytest
from PIL import Image

from envgen import frame, lidar
from envgen.build import CONTEXT_SINK_M, build
from envgen.cli import main
from envgen.site import load_site

from . import helpers as h

LIDAR = {"lidar": {"kind": "file", "path": "points.las", "license": "test", "date": "2030"}}
FILES = {
    "elevation": {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"},
    "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"},
}
# A 20 m square of tree canopy in the middle of the tile.
TREE_WEST, TREE_SOUTH, TREE_SIDE = h.WEST + 53, h.SOUTH + 53, 20


def detailed_heights(out, manifest):
    landscape = manifest["landscape"]
    mid_m = manifest["georeference"]["origin_height_m"] + landscape["location_cm"][2] / 100
    return frame.decode_heights(np.asarray(Image.open(out / landscape["heightmap"])), mid_m, landscape["scale"][2])


def write_imagery_with_dark_tree(path):
    """Uniform light ground with a dark square where the tree stands, and its shadow 3 m to the north."""
    west, north = h.WEST - 60, h.SOUTH + h.SIZE_M + 60
    count = int(h.SIZE_M + 120)
    eastings = west + np.arange(count) + 0.5
    northings = north - np.arange(count) - 0.5
    rgb = np.full((3, count, count), 180, dtype=np.uint8)
    dark_e = (eastings >= TREE_WEST) & (eastings < TREE_WEST + TREE_SIDE)
    dark_n = (northings >= TREE_SOUTH) & (northings < TREE_SOUTH + TREE_SIDE + 3)
    rgb[:, np.ix_(dark_n, dark_e)[0], np.ix_(dark_n, dark_e)[1]] = 30
    h.write_raster(path, rgb, west, north, 1.0)


def colour_at_tree(out, manifest):
    macro = np.asarray(Image.open(out / manifest["macro_colour"]["file"])).astype(float)
    # Layout is [east, north]; the tree sits at the tile centre.
    return macro[480:544, 480:544].mean()


def test_tree_canopy_is_kept_out_of_the_ground_colour(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    write_imagery_with_dark_tree(tmp_path / "imagery.tif")
    h.write_las(
        tmp_path / "points.las", np.vstack([h.ground_returns(), h.returns_above(TREE_WEST, TREE_SOUTH, TREE_SIDE, 9.0)])
    )

    plain = build(h.write_site(tmp_path, sources=FILES), tmp_path / "plain")
    masked = build(h.write_site(tmp_path, sources=FILES | LIDAR), tmp_path / "masked")

    assert colour_at_tree(tmp_path / "plain", plain) < 150  # the canopy darkens the map when nothing masks it
    assert colour_at_tree(tmp_path / "masked", masked) == pytest.approx(180, abs=3)
    assert masked["macro_colour"]["covered_fraction"] == pytest.approx((TREE_SIDE + 8) ** 2 / h.SIZE_M**2, rel=0.25)
    assert plain["macro_colour"]["covered_fraction"] == 0


def test_low_vegetation_is_still_ground_colour(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    write_imagery_with_dark_tree(tmp_path / "imagery.tif")
    h.write_las(
        tmp_path / "points.las", np.vstack([h.ground_returns(), h.returns_above(TREE_WEST, TREE_SOUTH, TREE_SIDE, 1.0)])
    )
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=FILES | LIDAR), out)

    assert manifest["macro_colour"]["covered_fraction"] == 0
    assert colour_at_tree(out, manifest) < 150


def under_roof(easting, northing):
    return (easting >= h.WEST + 40) & (easting < h.WEST + 80) & (northing >= h.SOUTH + 40) & (northing < h.SOUTH + 80)


def faceted(easting, northing):
    """plane(), but with 1 m steps every 8 m under the roof: what interpolation across a gap can leave behind."""
    steps = np.floor((easting - h.WEST) / 8) % 2
    return h.plane(easting, northing) + np.where(under_roof(easting, northing), steps, 0.0)


def test_ground_that_was_never_measured_is_smoothed_and_measured_ground_is_untouched(tmp_path):
    h.write_dem(tmp_path / "dem.tif", function=faceted, spacing=0.5)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    h.write_las(
        tmp_path / "points.las",
        np.vstack([h.ground_returns(skip=under_roof), h.returns_above(h.WEST + 40, h.SOUTH + 40, 40, 6.0)]),
    )

    raw = detailed_heights(tmp_path / "raw", build(h.write_site(tmp_path, sources=FILES), tmp_path / "raw"))
    site = h.write_site(tmp_path, sources=FILES | LIDAR)
    tile = load_site(site).tile
    manifest = build(site, tmp_path / "out")
    smoothed = detailed_heights(tmp_path / "out", manifest)

    # Across a step in the middle of the roof (east index, north index): the 1 m jump becomes a gentle ramp.
    east_index = round(h.WEST + 64 - tile.west)
    north_index = round(h.SOUTH + 60 - tile.south)

    def jump(surface):
        return abs(surface[east_index + 1, north_index] - surface[east_index - 1, north_index])

    assert jump(raw) > 0.9
    assert jump(smoothed) < 0.45
    # Well away from the gap nothing changed.
    assert np.array_equal(raw[:20, :20], smoothed[:20, :20])
    assert manifest["landscape"]["smoothed_fraction"] == pytest.approx(30 * 30 / h.SIZE_M**2, rel=0.5)


def test_lidar_without_ground_returns_is_an_error(tmp_path, capsys):
    h.write_dem(tmp_path / "dem.tif")
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    h.write_las(tmp_path / "points.las", h.returns_above(h.WEST + 40, h.SOUTH + 40, 40, 6.0))

    assert main(["build", str(h.write_site(tmp_path, sources=FILES | LIDAR)), "--out", str(tmp_path / "out")]) == 1
    assert "no ground-classified returns" in capsys.readouterr().err


def test_ept_pages_select_only_nodes_over_the_window():
    root = (0.0, 0.0, 0.0, 1600.0, 1600.0, 1600.0)
    hierarchy = {"0-0-0-0": 500, "1-0-0-0": 400, "1-1-0-0": 300, "1-0-1-0": 0, "2-0-0-0": -1, "2-3-3-0": -1}
    data, pages = lidar.ept_nodes(hierarchy, root, (100.0, 100.0, 300.0, 300.0))

    assert data == ["0-0-0-0", "1-0-0-0"]  # the root, and the south-west quarter; the east quarter is outside
    assert pages == ["2-0-0-0"]


def test_surround_passes_under_the_tile_and_follows_the_ground_outside_it(tmp_path):
    h.write_dem(tmp_path / "dem.tif", spacing=2.0, margin=260.0)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST + 63)
    out = tmp_path / "out"
    site = h.write_site(tmp_path, sources=FILES, context={"size_m": 504})
    manifest = build(site, out)
    tile = load_site(site).tile
    context, geo = manifest["context"], manifest["georeference"]

    assert context["vertices"] == 505 and context["scale"][:2] == [100.0, 100.0]
    assert context["location_cm"][:2] == [-25200.0, -25200.0]
    mid_m = geo["origin_height_m"] + context["location_cm"][2] / 100
    surround = frame.decode_heights(np.asarray(Image.open(out / context["heightmap"])), mid_m, context["scale"][2])
    west = tile.centre[0] - 252
    south = tile.centre[1] - 252

    # Far outside the tile it is the ground itself.
    assert surround[20, 30] == pytest.approx(h.plane(west + 20, south + 30), abs=0.05)
    # Under the tile it is below the detailed surface everywhere, by about the sink.
    detailed = detailed_heights(out, manifest)
    offset = round(tile.west - west)
    below = detailed[::1, ::1] - surround[offset : offset + 127, offset : offset + 127]
    assert below.min() >= CONTEXT_SINK_M - 0.05
    assert below.max() < CONTEXT_SINK_M + 0.2
    assert (out / context["colour"]).is_file()
    assert build(site, out)["stages_reused"] == ["elevation", "macro_colour", "context"]


def test_surround_must_be_larger_than_the_tile(tmp_path, capsys):
    site = h.write_site(tmp_path, sources=FILES, context={"size_m": 100})
    assert main(["build", str(site), "--out", str(tmp_path / "out")]) == 1
    assert "larger than the tile" in capsys.readouterr().err
