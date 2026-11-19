"""Surface classes: fitted to the imagery, written as weightmaps that sum to 255, and read back by the colour map."""

import numpy as np
import pytest
import rasterio
from PIL import Image
from scipy import ndimage

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
    assert fit["coherence"] > 0.9 and fit["separation"] > surface.SEPARATION_MIN and fit["split"]
    assert fit["fitted_to"].startswith("sunlit cells") and fit["index"] == surface.GREEN_INDEX
    assert fit["mixture"]["means"][0] < fit["threshold"] < fit["mixture"]["means"][1]


def test_dark_blue_cells_do_not_pull_the_cut_into_the_paving(tmp_path):
    # A dark roof leans blue, far from both turf and paving in the index. Counted equally with the rest it takes
    # the cut for itself, and the paving is then called grass; counted by brightness it barely matters.
    roof = (100, 0, 126, 126, (30, 28, 34))
    out, manifest = grass_and_paved(tmp_path, (100, 110, 98), h.PAVED, [(40, 0, 90, 126, h.PAVED), roof])

    by_name = layers(out, manifest)
    assert at(by_name["paved"], 65, 50) == 255 and at(by_name["grass"], 20, 50) == 255
    assert manifest["surface"]["splits"][0]["threshold"] > 0
    # The paving is less blue than the roof, which is no reason to call it soil.
    assert list(by_name) == ["grass", "paved"]


def test_narrow_features_survive_because_each_cell_is_judged_before_any_averaging(tmp_path):
    # A 2 m path through the grass, next to a large paved area that the fit needs. A colour averaged over a
    # neighbourhood before it is judged would wash the path into the grass.
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED, [(90, 0, 120, 126, h.PAVED), (20, 0, 22, 126, h.PAVED)])

    by_name = layers(out, manifest)
    assert at(by_name["paved"], 21, 60) == 255 and at(by_name["grass"], 50, 60) == 255


def test_weights_sum_to_255_whatever_the_rounding():
    rng = np.random.default_rng(2)
    labels = np.digitize(ndimage.gaussian_filter(rng.normal(size=(80, 80)), 3), [-0.01, 0.01])

    assert (sum(surface.weights(labels, 3, 1.0)).astype(int) == 255).all()


def test_one_smooth_population_is_not_split_however_patchy_it_looks():
    # Turf whose greenness drifts slowly across the tile: cut at its median the halves are big blocks, so patches
    # alone would split it. Its colours are one wide population, and the fitted mixture's components overlap.
    rng = np.random.default_rng(3)
    drift = ndimage.gaussian_filter(rng.normal(size=(160, 160)), 12)
    drift = drift / drift.std() * 8
    rgb = np.stack([np.full((160, 160), 100.0), 130 + drift, np.full((160, 160), 90.0)])
    labels, names, fit = surface.classify(rgb, np.ones((160, 160), dtype=bool), 1.0)

    assert names == ["grass"] and (labels == 0).all()
    assert fit["splits"][0]["coherence"] > surface.COHERENCE_MIN
    assert fit["splits"][0]["separation"] < surface.SEPARATION_MIN
    assert "prior" in fit["priors"][0] and "overlap" in fit["priors"][0]


def test_soil_is_found_even_when_it_is_most_of_the_ground_that_is_not_grass(tmp_path):
    out, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED, [(40, 0, 60, 126, h.PAVED), (60, 0, 120, 126, SOIL)])

    by_name = layers(out, manifest)
    assert list(by_name) == ["grass", "paved", "soil"]
    assert at(by_name["soil"], 90, 60) == 255 and at(by_name["paved"], 50, 60) == 255


def test_every_hand_set_value_is_listed_in_the_manifest_as_a_prior(tmp_path):
    _, manifest = grass_and_paved(tmp_path, h.GRASS, h.PAVED)

    settings = manifest["surface"]["settings"]
    assert settings["kind"] == "prior"
    assert settings["separation_min"] == surface.SEPARATION_MIN and settings["coherence_min"] == surface.COHERENCE_MIN
    assert settings["group_min_m2"] == surface.GROUP_MIN_M2 and settings["edge_m"] == surface.EDGE_M


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


TURF, LOT = (170, 160, 150), (200, 195, 185)  # dry turf and pale paving: nearly the same share of green
TURF_NIR, LOT_NIR = 200, 150  # leaves, dry or green, reflect near-infrared; paving does not


def four_band(shape, lot):
    """Red, green, blue and near-infrared of dry turf with paving where `lot` is true, with a photo's grain."""
    bands = np.empty((4, *shape))
    for band, (turf, paving) in enumerate(zip((*TURF, TURF_NIR), (*LOT, LOT_NIR), strict=True)):
        bands[band] = np.where(lot, paving, turf)
    return noisy(bands, 11)


def write_four_band_scene(path, lot_west, lot_east):
    west, north, count = h.WEST - 60, h.SOUTH + h.SIZE_M + 60, int(h.SIZE_M + 120)
    eastings = west + np.arange(count) + 0.5 - h.WEST
    lot = np.broadcast_to((eastings >= lot_west) & (eastings < lot_east), (count, count))
    h.write_raster(path, four_band((count, count), lot).astype(np.uint8), west, north, 1.0)


def test_dry_turf_the_colour_of_paving_is_grass_when_the_site_names_a_near_infrared_band(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    write_four_band_scene(tmp_path / "imagery.tif", 40, 90)
    imagery = {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"}
    elevation = {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"}
    bands = {"red": 1, "green": 2, "blue": 3, "nir": 4}

    by_colour = build(h.write_site(tmp_path, sources={"elevation": elevation, "imagery": imagery}), tmp_path / "a")
    named = h.write_site(tmp_path, sources={"elevation": elevation, "imagery": imagery | {"bands": bands}})
    manifest = build(named, tmp_path / "b")

    # Colour alone cannot tell them apart, so the tile stays one class; the near-infrared band can.
    assert [layer["name"] for layer in by_colour["surface"]["layers"]] == ["grass"]
    by_name = layers(tmp_path / "b", manifest)
    assert at(by_name["grass"], 20, 60) == 255 and at(by_name["paved"], 65, 60) == 255
    assert at(by_name["grass"], 110, 60) == 255
    fit = manifest["surface"]["splits"][0]
    assert fit["index"] == surface.NIR_INDEX and fit["split"]
    ndvi = lambda red, nir: (nir - red) / (nir + red)
    assert ndvi(LOT[0], LOT_NIR) < fit["threshold"] < ndvi(TURF[0], TURF_NIR)


def test_with_near_infrared_ground_in_shade_is_read_itself_not_given_the_class_of_the_sunlit_ground_beside_it():
    shape = (80, 80)
    lot = np.zeros(shape, dtype=bool)
    lot[:, 30:60] = True
    bands = four_band(shape, lot)
    # A shadow lies over the east of the paving and the turf beyond it: dimmer in every band, and not sunlit.
    shade = np.zeros(shape, dtype=bool)
    shade[:, 45:70] = True
    bands[:, shade] *= 0.4
    sunlit = ~shade

    labels, names, fit = surface.classify(bands[:3], sunlit, 1.0, nir=bands[3])
    filled, _, _ = surface.classify(bands[:3] + [[[0]], [[40]], [[0]]], sunlit, 1.0)

    assert names == ["grass", "paved"]
    # Shaded paving at column 57 is nearer to sunlit turf (column 70) than to sunlit paving (column 44).
    assert (labels[:, 50:59] == 1).mean() > 0.98 and (labels[:, 61:70] == 0).mean() > 0.98
    assert fit["hidden_ground"].startswith("read like any other cell") and any(
        "crown" in prior for prior in fit["priors"]
    )
    # Without the band, hidden ground can only take its nearest sunlit neighbour's class.
    assert (filled[:, 55:59] == 0).all()


def test_a_crown_over_paving_takes_the_paving_but_a_wood_and_a_roof_do_not():
    labels = np.zeros((80, 160), dtype=np.uint8)
    labels[:, :80] = 1  # paved on the west half, grass on the east
    shown = np.ones_like(labels, dtype=bool)
    shown[10:16, 20:26] = False  # a crown over the paving, read as vegetation
    labels[10:16, 20:26] = 0
    shown[10:16, 100:106] = False  # a crown over grass
    labels[10:16, 100:106] = 0
    shown[30:70, 5:75] = False  # a wood-sized vegetated patch inside the paving
    labels[30:70, 5:75] = 0
    shown[60:70, 90:100] = False  # a roof: hidden, but unvegetated
    labels[60:70, 90:100] = 1

    out, moved = surface.crown_ground(labels, shown, cell_m=1.0)

    assert (out[10:16, 20:26] == 1).all()
    assert (out[10:16, 100:106] == 0).all()
    assert (out[30:70, 5:75] == 0).all()
    assert (out[60:70, 90:100] == 1).all()
    assert moved == 36
