"""Surface classes: fitted to the imagery, written as weightmaps that sum to 255, and read back by the colour map."""

import numpy as np
import pytest
import rasterio
from PIL import Image

from envgen import surface
from envgen.build import build

from . import helpers as h
from .test_cover import DARK, LIDAR, TREE, colour, sources, tree_returns

SOIL = (215, 165, 140)
NOISE = 3


def noisy(rgb, seed):
    """A flat colour with the grain a real photo has: without it every split would be perfect by construction."""
    return np.clip(rgb + np.random.default_rng(seed).normal(0, NOISE, rgb.shape), 0, 255)


def write_noisy_scene(path, base, patches=()):
    h.write_scene(path, base, patches)
    with rasterio.open(path) as file:
        values, profile = file.read().astype(float), file.profile
    with rasterio.open(path, "w", **profile) as out:
        out.write(noisy(values, 5).astype(np.uint8))


def layers(out, manifest):
    """Each class's weights by name, indexed [east, north] as the Landscape reads them."""
    return {
        layer["name"]: np.asarray(Image.open(out / layer["file"])).astype(int)
        for layer in manifest["surface"]["layers"]
    }


def at(weights, east_m, north_m):
    return weights[round(east_m), round(north_m)]


def grass_and_paved(tmp_path, grass, paved, patches=None):
    """A tile of `grass` with a paved block from 40 m to 90 m east, and the site's build."""
    h.write_dem(tmp_path / "dem.tif")
    write_noisy_scene(tmp_path / "imagery.tif", grass, patches or [(40, 0, 90, 126, paved)])
    out = tmp_path / "out"
    return out, build(h.write_site(tmp_path), out)


def test_grass_and_paved_land_in_their_own_layers_and_the_weights_sum_to_255(tmp_path):
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED)

    by_name = layers(out, manifest)
    assert list(by_name) == ["grass", "paved"]
    assert (sum(by_name.values()) == 255).all()
    assert at(by_name["grass"], 20, 60) == 255 and at(by_name["paved"], 20, 60) == 0
    assert at(by_name["paved"], 65, 60) == 255 and at(by_name["grass"], 110, 60) == 255
    # A Landscape needs one weight per vertex, and each layer is 8-bit.
    assert all(weights.shape == (127, 127) for weights in by_name.values())
    assert {layer["file"] for layer in manifest["surface"]["layers"]} <= set(manifest["artifacts"])


@pytest.mark.parametrize(
    "grass, paved",
    [(h.GRASS, h.PAVED), ((100, 110, 98), (100, 100, 100)), ((140, 138, 131), (120, 118, 120))],
    ids=["lush", "pale", "dry"],
)
def test_the_split_is_fitted_to_the_colours_in_the_tile_not_set_by_hand(tmp_path, grass, paved):
    out, manifest = grass_and_paved(tmp_path, grass, paved)

    by_name = layers(out, manifest)
    assert at(by_name["grass"], 20, 60) == 255 and at(by_name["paved"], 65, 60) == 255
    fit = manifest["surface"]["splits"][0]
    index = lambda rgb: (rgb[1] - rgb[2]) / sum(rgb)
    assert index(paved) < fit["threshold"] < index(grass)
    assert fit["coherence"] > 0.9 and fit["split"]
    assert fit["fitted_to"] == "sunlit cells" and fit["index"] == surface.GREEN_INDEX


def test_dark_blue_cells_do_not_pull_the_cut_into_the_paving(tmp_path):
    # A wide dark roof leans blue, far from both turf and paving in the index. Unweighted, it drags the cut down
    # until paving counts as grass; counted by brightness it barely matters.
    roof = (0, 100, 126, 126, (30, 30, 45))
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED, [(40, 0, 90, 100, h.PAVED), roof])

    by_name = layers(out, manifest)
    assert at(by_name["paved"], 65, 50) == 255 and at(by_name["grass"], 20, 50) == 255
    assert manifest["surface"]["splits"][0]["threshold"] > 0


def test_a_tile_of_one_population_stays_one_class_and_says_the_choice_was_a_prior(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    write_noisy_scene(tmp_path / "imagery.tif", h.GRASS)
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path), out)

    by_name = layers(out, manifest)
    assert list(by_name) == ["grass"] and (by_name["grass"] == 255).all()
    assert not manifest["surface"]["splits"][0]["split"]
    assert "prior" in manifest["surface"]["priors"][0]


def test_grey_imagery_cannot_be_classified_and_keeps_one_layer(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_raster(tmp_path / "imagery.tif", np.full((186, 186), 120, dtype=np.uint8), h.WEST - 30, h.SOUTH + 156, 1.0)
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path), out)

    assert list(layers(out, manifest)) == ["grass"] and "grey" in manifest["surface"]["priors"][0]


def test_bare_soil_is_a_third_class_only_when_the_imagery_has_it(tmp_path):
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED, [(40, 0, 90, 126, h.PAVED), (95, 20, 120, 100, SOIL)])

    by_name = layers(out, manifest)
    assert list(by_name) == ["grass", "paved", "soil"]
    assert at(by_name["soil"], 105, 60) == 255 and at(by_name["paved"], 65, 60) == 255
    assert (sum(by_name.values()) == 255).all()
    assert manifest["surface"]["splits"][1]["separates"] == "soil from paved"


def test_the_engine_is_told_where_to_find_each_class(tmp_path):
    # The level build reads the merged weights back at these vertices. They are worked out from the data by
    # position, so they say where the grass is whatever the weightmap files are called.
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED)

    points = manifest["surface"]["check_points"]
    for point in points:
        # East 20 to 35 is grass and 45 to 85 is paved, at every north; the edge is in between, so any other
        # point is an edge point and must weigh both.
        east, weights = point["east"], point["weights"]
        assert sum(weights.values()) == 255
        if east < 36:
            assert weights == {"grass": 255, "paved": 0}
        elif 44 < east < 86:
            assert weights == {"grass": 0, "paved": 255}
    assert any(point["weights"]["grass"] == 255 for point in points)
    assert any(point["weights"]["paved"] == 255 for point in points)
    assert any(0 < point["weights"]["grass"] < 255 for point in points)
    # And they agree with the files, which the engine is imported from.
    by_name = layers(out, manifest)
    assert all(by_name[name][p["east"], p["north"]] == w for p in points for name, w in p["weights"].items())


def test_the_class_edge_lands_on_the_edge_in_the_imagery(tmp_path):
    # The paved block starts at exactly 40 m. Weights step across about a metre; their midpoint is the edge.
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED)

    near = layers(out, manifest)["grass"][36:45, 60].astype(float)
    crossing = np.interp(127.5, near[::-1], np.arange(36, 45)[::-1])
    assert crossing == pytest.approx(40, abs=0.5)


def test_ground_hidden_under_cover_takes_the_class_of_the_nearest_ground_in_view(tmp_path):
    # A tree stands over the border between grass and paved. Its cells are dark in the imagery and say nothing
    # about the ground, so each half takes the class of the open ground beside it.
    h.write_dem(tmp_path / "dem.tif")
    write_noisy_scene(tmp_path / "imagery.tif", h.GRASS, [(0, 0, 63, 126, h.PAVED), (*TREE, DARK)])
    h.write_las(tmp_path / "points.las", tree_returns())
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR)), out)

    by_name = layers(out, manifest)
    assert at(by_name["paved"], 57, 63) == 255 and at(by_name["grass"], 69, 63) == 255


def test_the_colour_map_is_low_passed_within_each_class(tmp_path):
    # A road through grass. Grass beside it keeps the grass colour and the road its own; one low-pass across
    # both would grey the grass and tint the road.
    h.write_dem(tmp_path / "dem.tif")
    write_noisy_scene(tmp_path / "imagery.tif", h.GRASS, [(0, 57, 126, 69, h.PAVED)])
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path), out)

    assert colour(out, manifest, 63, 75) == pytest.approx(h.GRASS, abs=4)
    # The 1 m imagery is smeared a little across the road's edge in the finer colour map, so allow for that.
    assert colour(out, manifest, 63, 63) == pytest.approx(h.PAVED, abs=12)


def test_unchanged_imagery_reuses_the_surface_stage(tmp_path):
    out, first = grass_and_paved(tmp_path, h.GRASS, h.PAVED)
    again = build(tmp_path / "site.json", out)

    assert {"surface", "macro_colour"} <= set(again["stages_reused"])
    assert again["artifacts"] == first["artifacts"]


def test_a_split_needs_patches_not_scatter():
    rng = np.random.default_rng(1)
    values = np.where(np.arange(200)[:, None] < 100, 0.0, 0.04) + rng.normal(0, 0.005, (200, 200))
    everywhere = np.ones_like(values, dtype=bool)
    blocks = surface._split(values, np.ones_like(values), everywhere, 1.0, "test", "test")
    scattered = surface._split(
        rng.permutation(values.ravel()).reshape(200, 200), np.ones_like(values), everywhere, 1.0, "test", "test"
    )

    assert blocks[0] == pytest.approx(0.02, abs=0.005) and blocks[1]["split"]
    assert scattered[0] is None and scattered[1]["reason"] == "the groups do not form patches"
