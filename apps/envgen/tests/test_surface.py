"""Surface classes: where grass and paved ground are, as layer weights, and what that does to the ground colour."""

import numpy as np
import pytest
from PIL import Image

from envgen.build import build

from . import helpers as h

LIDAR = {"lidar": {"kind": "file", "path": "points.las", "license": "test", "date": "2030"}}
FILES = {
    "elevation": {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"},
    "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"},
}
FAR = 400


def built(tmp_path, base, patches=(), lidar_points=None):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", base, patches)
    sources = FILES
    if lidar_points is not None:
        h.write_las(tmp_path / "points.las", lidar_points)
        sources = FILES | LIDAR
    out = tmp_path / "out"
    return out, build(h.write_site(tmp_path, sources=sources), out)


def weight(out, manifest, name):
    """A layer's weightmap, indexed [metres east, metres north] of the tile's south-west corner."""
    (layer,) = [layer for layer in manifest["surface"]["layers"] if layer["name"] == name]
    return np.asarray(Image.open(out / layer["file"])).astype(int)


def colour(out, manifest, east_m, north_m):
    macro = np.asarray(Image.open(out / manifest["macro_colour"]["file"])).astype(int)
    scale = manifest["macro_colour"]["pixels"] / manifest["tile"]["size_m"]
    return macro[int(east_m * scale), int(north_m * scale)]


def test_paved_ground_and_grass_get_their_own_weightmaps_in_the_heightmap_layout(tmp_path):
    # Paved east of 80 m, and also north of 100 m.
    out, manifest = built(tmp_path, h.GRASS, [(80, -FAR, FAR, FAR, h.PAVED), (-FAR, 100, FAR, FAR, h.PAVED)])
    grass, paved = weight(out, manifest, "grass"), weight(out, manifest, "paved")

    assert grass.shape == (127, 127)
    assert grass[:70, :90].min() == 255 and paved[:70, :90].max() == 0
    assert paved[90:, :].min() == 255 and paved[:, 110:].min() == 255
    assert [layer["name"] for layer in manifest["surface"]["layers"]] == ["grass", "paved"]
    assert manifest["surface"]["layers"][1]["fraction"] == pytest.approx(1 - 80 * 100 / 126**2, abs=0.02)
    assert {"weight_grass.png", "weight_paved.png"} <= set(manifest["artifacts"])


def test_layer_weights_sum_to_255_at_every_vertex_and_cross_over_on_the_boundary(tmp_path):
    out, manifest = built(tmp_path, h.GRASS, [(63, -FAR, FAR, FAR, h.PAVED)])
    grass, paved = weight(out, manifest, "grass"), weight(out, manifest, "paved")

    assert (grass + paved == 255).all()
    # The vertex 63 m east sits exactly on the edge between the two; one metre either side has taken a side.
    assert grass[63, 60] == pytest.approx(128, abs=30)
    assert grass[60, 60] > 250 and grass[66, 60] < 5


def test_a_road_keeps_its_own_colour_and_does_not_grey_the_grass_beside_it(tmp_path):
    # A paved strip 10 m wide, far narrower than the colour map's low-pass can resolve.
    out, manifest = built(tmp_path, h.GRASS, [(58, -FAR, 68, FAR, h.PAVED)])

    assert colour(out, manifest, 63, 63) == pytest.approx(h.PAVED, abs=4)
    assert colour(out, manifest, 54, 63) == pytest.approx(h.GRASS, abs=4)
    assert colour(out, manifest, 72, 63) == pytest.approx(h.GRASS, abs=4)


def test_a_shadow_the_lidar_knows_nothing_about_does_not_darken_the_ground_colour(tmp_path):
    shadow = tuple(value // 3 for value in h.GRASS)
    out, manifest = built(tmp_path, h.GRASS, [(50, 50, 76, 76, shadow)])

    assert colour(out, manifest, 63, 63) == pytest.approx(h.GRASS, abs=4)
    assert manifest["macro_colour"]["shaded_fraction"] == pytest.approx(26**2 / 126**2, rel=0.1)
    # Shade says nothing about the class under it either: the ground there is what surrounds it.
    assert weight(out, manifest, "grass").min() == 255


def test_ground_under_a_tree_takes_the_class_of_the_open_ground_around_it(tmp_path):
    tree = (40, 90, 35)  # leaf green, over a paved lot
    points = np.vstack([h.ground_returns(), h.returns_above(h.WEST + 80, h.SOUTH + 53, 20, 9.0)])
    out, manifest = built(tmp_path, h.GRASS, [(60, -FAR, FAR, FAR, h.PAVED), (80, 53, 100, 73, tree)], points)

    assert weight(out, manifest, "paved")[84:97, 57:70].min() == 255
    assert colour(out, manifest, 90, 63) == pytest.approx(h.PAVED, abs=4)


def test_a_patch_too_small_to_be_a_surface_is_absorbed_and_a_real_lot_is_kept(tmp_path):
    out, manifest = built(tmp_path, h.GRASS, [(20, 20, 30, 30, h.PAVED), (70, 70, 100, 100, h.PAVED)])
    paved = weight(out, manifest, "paved")

    assert paved[18:33, 18:33].max() == 0
    assert paved[74:97, 74:97].min() == 255


def test_red_ground_is_not_grass(tmp_path):
    out, manifest = built(tmp_path, h.GRASS, [(63, -FAR, FAR, FAR, (190, 110, 90))])

    assert weight(out, manifest, "paved")[70:, :].min() == 255


def test_grey_imagery_gives_one_grass_layer_over_the_whole_tile(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    grey = np.full((1, 250, 250), 120, dtype=np.uint8)
    grey[:, :, 125:] = 200
    h.write_raster(tmp_path / "imagery.tif", grey, h.WEST - 60, h.SOUTH + h.SIZE_M + 60, 1.0)
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path), out)

    assert weight(out, manifest, "grass").min() == 255 and weight(out, manifest, "paved").max() == 0
