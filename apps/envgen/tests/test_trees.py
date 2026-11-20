"""The tree inventory: crowns found where they stand, at their height and width, with what is known of their kind."""

import json

import numpy as np
import pytest

from envgen import lidar, trees
from envgen.build import build
from envgen.site import Tile

from . import helpers as h
from .test_cover import sources
from .test_surface import write_noisy_scene

ROOF = (70, 60, 110, 90)  # west, south, east, north: a flat roof 8 m up, grey in the imagery
# east, north, crown radius, height: one tree alone, a small one, and two whose crowns touch.
ALONE, SMALL, TWINS = (30, 40, 5, 12), (45, 100, 3, 6), ((88, 25, 5, 11), (97, 25, 5, 10))
NODATA = -9999.0


def test_inspected_crowns_refine_only_matched_height_backed_trees():
    records = [{"east_m": 5., "north_m": 8., "height_m": 9., "crown_radius_m": 5., "source": "lidar"},
               {"east_m": 30., "north_m": 20., "height_m": 1., "crown_radius_m": 2., "source": "survey"}]
    observations = {"features": [
        {"id": "T1", "feature_type": "individual_tree_crown", "confidence": .9,
         "bounds_projected_m": [102, 204, 112, 212]},
        {"id": "T2", "feature_type": "individual_tree_crown", "confidence": .9,
         "bounds_projected_m": [128, 218, 132, 222]},
        {"id": "V1", "feature_type": "tree_row", "confidence": .99,
         "bounds_projected_m": [100, 200, 140, 240]},
    ]}
    report = trees.refine_crowns(records, observations, (100, 200))
    assert [entry["observation"] for entry in report["matched"]] == ["T1"]
    assert records[0]["east_m"] == 7 and records[0]["north_m"] == 8
    assert records[0]["crown_radius_m"] == pytest.approx(np.sqrt(80) / 2)
    assert records[0]["height_m"] == 9 and records[0]["source"] == "lidar+orthophoto"
    assert records[1]["east_m"] == 30 and records[1]["source"] == "survey"


def dome(east, north, radius, top):
    """Returns from a rounded crown: one per square metre, highest in the middle."""
    eastings, northings = np.meshgrid(np.arange(-radius, radius + 1.0), np.arange(-radius, radius + 1.0))
    inside = eastings**2 + northings**2 <= radius**2
    eastings, northings = eastings[inside], northings[inside]
    heights = top * np.sqrt(np.maximum(1 - 0.75 * (eastings**2 + northings**2) / radius**2, 0))
    x, y = h.WEST + east + eastings + 0.5, h.SOUTH + north + northings + 0.5
    return np.column_stack([x, y, h.plane(x, y) + heights, np.ones(len(x))])


def write_lidar(path, crowns):
    roof = h.returns_above(h.WEST + ROOF[0], h.SOUTH + ROOF[1], 1, 8.0)[:0]
    eastings, northings = np.meshgrid(np.arange(ROOF[0], ROOF[2]) + 0.5, np.arange(ROOF[1], ROOF[3]) + 0.5)
    x, y = h.WEST + eastings.ravel(), h.SOUTH + northings.ravel()
    roof = np.vstack([roof, np.column_stack([x, y, h.plane(x, y) + 8.0, np.ones(len(x))])])
    h.write_las(path, np.vstack([h.ground_returns(), roof, *[dome(*crown) for crown in crowns]]))


def scene(tmp_path, crowns=(ALONE, SMALL, *TWINS), **extra):
    h.write_dem(tmp_path / "dem.tif")
    # An open lot as well: paving has to show in sunlight for the imagery to tell it from vegetation.
    write_noisy_scene(tmp_path / "imagery.tif", h.GRASS, [(*ROOF, h.PAVED), (0, 55, 38, 92, h.PAVED)])
    write_lidar(tmp_path / "points.las", crowns)
    lidar_source = {"lidar": {"kind": "file", "path": "points.las"}}
    return h.write_site(tmp_path, sources=sources(**lidar_source, **extra))


def inventory(out, manifest):
    table = json.loads((out / manifest["trees"]["file"]).read_text())
    return [dict(zip(table["columns"], row, strict=True)) for row in table["trees"]]


def near(found, east, north):
    """The tree nearest a point given in metres from the tile's south-west corner, and how far off it is."""
    offset = h.SIZE_M / 2
    tree = min(found, key=lambda t: (t["east_m"] + offset - east) ** 2 + (t["north_m"] + offset - north) ** 2)
    return tree, float(np.hypot(tree["east_m"] + offset - east, tree["north_m"] + offset - north))


def test_each_tree_is_found_where_it_stands_at_its_height_and_width_and_a_roof_is_not_a_tree(tmp_path):
    out = tmp_path / "out"
    manifest = build(scene(tmp_path), out)

    found = inventory(out, manifest)
    assert manifest["trees"]["count"] == len(found) == 4
    for east, north, radius, top in (ALONE, SMALL, *TWINS):
        tree, off = near(found, east, north)
        assert off <= 1.5
        assert tree["height_m"] == pytest.approx(top, abs=0.5)
        # Two crowns that touch share the ground between them, so each is a little narrower than alone.
        assert tree["crown_radius_m"] == pytest.approx(radius, abs=1.2)
        assert tree["source"] == "lidar" and tree["confidence"] == 1.0
    assert manifest["trees"]["canopy_is"] == "cover the imagery shows as vegetation"
    assert "trees.json" in manifest["artifacts"] and manifest["trees"]["settings"]["kind"] == "prior"
    # No species without an inventory mix, and the manifest says so.
    assert found[0]["species"] is None and any("no species" in prior for prior in manifest["trees"]["priors"])


def survey(tmp_path, crown):
    """A surface and terrain model of the tile's east half, 300 m off the elevation model, showing one crown only."""
    west, north, count = h.WEST + 63, h.SOUTH + h.SIZE_M, 63
    eastings = west + np.arange(count * 2) / 2 + 0.25
    northings = north - np.arange(int(h.SIZE_M) * 2) / 2 - 0.25
    terrain = (h.plane(eastings[None, :], northings[:, None]) - 300.0).astype(np.float32)
    east, north_m, radius, top = crown
    distance = np.hypot(eastings[None, :] - h.WEST - east, northings[:, None] - h.SOUTH - north_m)
    surface = terrain + np.where(
        distance <= radius, top * np.sqrt(np.maximum(1 - 0.75 * (distance / radius) ** 2, 0)), 0
    )
    # A strip the survey did not reach: it must not count as open ground.
    surface[:10], terrain[:10] = NODATA, NODATA
    h.write_raster(tmp_path / "dsm.tif", surface.astype(np.float32), west, north, 0.5, NODATA)
    h.write_raster(tmp_path / "dtm.tif", terrain, west, north, 0.5, NODATA)
    return {"survey": {"kind": "file", "path": "dsm.tif", "terrain": "dtm.tif"}}


def test_a_survey_adds_the_crowns_it_shows_and_removes_none_it_does_not(tmp_path):
    new = (100, 110, 4, 7)
    out = tmp_path / "out"
    manifest = build(scene(tmp_path, **survey(tmp_path, new)), out)

    found = inventory(out, manifest)
    assert len(found) == 5
    tree, off = near(found, *new[:2])
    assert off <= 1.5 and tree["source"] == "survey" and tree["height_m"] == pytest.approx(7, abs=0.5)
    # The twins stand inside the survey, which does not show them: they stay, at half the confidence.
    for twin in TWINS:
        tree, off = near(found, *twin[:2])
        assert off <= 1.5 and tree["source"] == "lidar" and tree["confidence"] == 0.5
    assert near(found, *ALONE[:2])[0]["confidence"] == 1.0
    report = manifest["trees"]["survey"]
    assert report["terrain_minus_elevation_m"] == pytest.approx(-300, abs=0.05) and report["residual_m"] < 0.05
    assert report["crowns_added"] == 1 and manifest["sources"]["survey"]["terrain_sha256"]


def test_the_share_of_leaf_off_returns_a_crown_stops_tells_conifers_from_bare_broadleaves():
    tile = Tile(0.0, 0.0, 1.0, 126)
    flat = np.zeros((126, 126))
    # A crown that stops every return, and one that lets three in four through to the ground.
    eastings, northings = np.meshgrid(np.arange(10, 20) + 0.5, np.arange(10, 20) + 0.5)
    dense = np.column_stack([eastings.ravel(), northings.ravel(), np.full(100, 9.0), np.ones(100)])
    thin = dense[::4] + [40, 0, 0, 0]
    through = np.column_stack([eastings.ravel() + 40, northings.ravel(), np.zeros(100), np.full(100, 2)])
    canopy, total = lidar.canopy_returns(np.vstack([dense, thin, through[:75]]), tile, flat, 2.0)
    labels = np.zeros((126, 126), dtype=np.int32)
    labels[106:116, 10:20], labels[106:116, 50:60] = 1, 2

    closures = trees.closure(labels, [{"label": 1}, {"label": 2}], canopy, total)

    assert closures == pytest.approx([1.0, 0.25])
    # Thirty crowns of each sort are two populations; the cut falls between them. Many of one sort are one.
    rng = np.random.default_rng(3)
    both = np.concatenate([rng.normal(0.9, 0.04, 30), rng.normal(0.3, 0.06, 30)])
    threshold, fit = trees.split_kinds(both, np.ones(60))
    assert fit["split"] and 0.45 < threshold < 0.8
    threshold, fit = trees.split_kinds(rng.normal(0.5, 0.1, 600), np.ones(600))
    assert threshold is None and "one population" in fit["reason"]


MIX = [
    {
        "name": "tall oak",
        "kind": "broadleaf",
        "share": 0.4,
        "height_m": {"p10": 15, "p50": 20, "p90": 26},
        "trunk_diameter_m": [-0.04, 0.02],
        "crown_ratio": 0.4,
    },
    {
        "name": "short plum",
        "kind": "broadleaf",
        "share": 0.4,
        "height_m": {"p10": 3, "p50": 5, "p90": 8},
        "trunk_diameter_m": [0.0, 0.015],
        "crown_ratio": 0.6,
    },
    {
        "name": "cedar",
        "kind": "conifer",
        "share": 0.2,
        "height_m": {"p10": 7, "p50": 11, "p90": 14},
        "trunk_diameter_m": [0.0, 0.019],
        "crown_ratio": 0.5,
    },
]


def test_a_species_is_drawn_from_the_mix_by_the_trees_kind_and_height():
    rng = np.random.default_rng(1)
    tall = [trees.draw_species(MIX, "broadleaf", 21.0, rng)["name"] for _ in range(200)]
    short = [trees.draw_species(MIX, "broadleaf", 4.5, rng)["name"] for _ in range(200)]
    unknown = [trees.draw_species(MIX, None, 11.0, rng)["name"] for _ in range(200)]

    assert tall.count("tall oak") > 190 and short.count("short plum") > 190
    assert "cedar" not in tall + short and unknown.count("cedar") > 100
    # A measured kind the mix has no species of stays measured, without a species.
    assert trees.draw_species(MIX[:2], "conifer", 11.0, rng) is None


def test_extreme_heights_still_favour_the_species_whose_distribution_fits():
    rng = np.random.default_rng(4)
    # Both ordinary likelihoods underflow here; the regional shares alone favour neither broadleaf species.
    draws = [trees.draw_species(MIX[:2], "broadleaf", 1e20, rng)["name"] for _ in range(100)]
    assert draws.count("short plum") == 100  # Its fitted distribution has the wider tail.
    assert trees.draw_species([MIX[0] | {"share": 0}], "broadleaf", 20, rng) is None


def test_with_a_mix_every_tree_has_a_species_a_trunk_and_a_crown_from_it_and_says_it_is_a_prior(tmp_path):
    (tmp_path / "mix.json").write_text(json.dumps({"source": "a test inventory", "species": MIX}))
    site = scene(tmp_path, tree_mix={"kind": "file", "path": "mix.json"})

    manifest = build(site, tmp_path / "a")
    found = inventory(tmp_path / "a", manifest)
    again = inventory(tmp_path / "b", build(site, tmp_path / "b"))

    assert found == again  # the same seed draws the same trees
    tree, _ = near(found, *ALONE[:2])
    by_name = {entry["name"]: entry for entry in MIX}
    species = by_name[tree["species"]]
    assert tree["kind"] == species["kind"] and tree["crown_ratio"] == species["crown_ratio"]
    intercept, slope = species["trunk_diameter_m"]
    assert tree["trunk_diameter_m"] == pytest.approx(intercept + slope * tree["height_m"])
    assert tree["kind_from"] == "prior: the inventory's mix"
    assert near(found, *SMALL[:2])[0]["species"] in ("short plum", "cedar")
    assert manifest["trees"]["species_from"] == "a test inventory"
    assert any("drawn from a regional inventory" in prior for prior in manifest["trees"]["priors"])


def test_a_mast_far_narrower_than_the_tiles_trees_of_its_height_is_not_a_tree():
    rng = np.random.default_rng(2)
    heights = rng.uniform(4, 25, 60)
    found = [{"height_m": h_, "crown_radius_m": 0.5 * h_**0.8 * np.exp(rng.normal(0, 0.2))} for h_ in heights]
    found += [{"height_m": 28.0, "crown_radius_m": 1.7}, {"height_m": 12.0, "crown_radius_m": 0.6}]

    flags, fit = trees.too_narrow(found)

    # Both masts go. So does the narrowest tree in every forty or so: the price of a cut at two deviations.
    assert flags[60] and flags[61] and flags[:60].sum() <= 3 and fit["narrow"] == flags.sum()
    # A narrow crown every source sees is a tree; one a second source misses is not; with one source, narrow decides.
    seen, missed = {"confidence": 1.0}, {"confidence": 0.5}
    assert trees.masts(np.array([True, True, False]), [seen, missed, missed], 2) == [False, True, False]
    assert trees.masts(np.array([True, False]), [seen, seen], 1) == [True, False]
    # A few crowns are not enough to say what is narrow.
    assert not trees.too_narrow(found[-5:])[0].any()
