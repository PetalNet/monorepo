import numpy as np
import pytest

from envgen import procfill


def observations(size=128):
    y, x = np.indices((size, size))
    rgb = np.stack([120 + 10 * np.sin(x * 2), 125 + 10 * np.cos(y * 2), np.full((size, size), 110)])
    valid = np.ones((size, size), bool)
    observed, _ = procfill.observe(rgb, valid, 0.5)
    classes = np.where(x < size / 2, 0, 1).astype(np.uint8)
    return observed, classes


def test_seed_constraints_and_categorical_support():
    observed, classes = observations()
    priors = procfill.fit(observed, classes, observed["valid"], 0.5)
    grass = np.ones(classes.shape, bool)
    grass[:, :8] = False
    canopy = np.zeros(classes.shape)
    canopy[50:60, 50:60] = 8
    roads = ~grass
    paths = np.zeros_like(grass)
    paths[:, 9] = True
    args = (priors, classes, grass, np.zeros(classes.shape), canopy, paths, roads, 0.5)
    first = procfill.generate(*args, 42)
    again = procfill.generate(*args, 42)
    other = procfill.generate(*args, 43)
    for name in procfill.MASKS:
        np.testing.assert_array_equal(first[name], again[name])
    assert np.any(first["zones"] != other["zones"])
    assert (first["zones"][~grass] == 255).all()
    for name in ("windrow", "wear", "weeds", "bare"):
        assert not first[name][~grass].any()
    assert not first["windrow"][canopy > 2].any()
    assert not first["crown"][canopy == 0].any()


def test_fitted_shares_use_only_training_cells():
    observed, classes = observations()
    train = np.indices(classes.shape)[1] < 64
    before = procfill.fit(observed, classes, train, 0.5)
    observed["zones"][~train] = 2
    observed["weeds"][~train] = True
    observed["bare"][~train] = True
    after = procfill.fit(observed, classes, train, 0.5)
    assert before == after
    assert before["training_cells_by_class"][1] == 0
    assert sum(before["zone_share_by_naip_class"][1]) == pytest.approx(1)


def test_all_empty_constraints_are_finite_and_no_phantom_paths():
    observed, classes = observations()
    priors = procfill.fit(observed, classes, observed["valid"], 0.5)
    grass = np.ones(classes.shape, bool)
    zero = np.zeros(classes.shape)
    result = procfill.generate(priors, classes, grass, zero, zero, zero.astype(bool), zero.astype(bool), 0.5, 5)
    assert not result["wear"].any()
    assert not result["crown"].any()
    assert all(np.isfinite(mask).all() for mask in result.values())


def test_spatial_holdout_reports_all_folds():
    observed, classes = observations(256)
    zeros = np.zeros(classes.shape)
    report = procfill.validate(observed, classes, zeros, zeros, zeros.astype(bool), zeros.astype(bool), 0.5, 1)
    assert len(report["folds"]) == 5
    assert sum(fold["test_cells"] for fold in report["folds"]) == observed["valid"].sum()
    assert 0 <= report["mean_zone_total_variation"] <= 1


def test_mask_roundtrip_preserves_unreal_orientation(tmp_path):
    grid = np.arange(35, dtype=np.uint8).reshape(5, 7)
    path = tmp_path / "zones.png"
    procfill._save(grid, path)
    np.testing.assert_array_equal(procfill._load(path), grid)


def test_stage_exports_reproducible_masks_and_reimports_paint(tmp_path):
    from types import SimpleNamespace

    from envgen import frame
    from envgen.site import Source, Tile
    from tests.helpers import CRS, SOUTH, WEST, write_raster

    tile = Tile(WEST, SOUTH, 1, 126)
    y, x = np.indices((128, 128))
    rgb = np.stack([120 + 15 * np.sin(x * 2), 125 + 15 * np.cos(y * 2), np.full(x.shape, 110)]).astype(np.uint8)
    write_raster(tmp_path / "naip.tif", rgb, WEST, tile.north, 1)
    survey = np.concatenate([rgb[:, :64, :64], np.full((1, 64, 64), 255, np.uint8)])
    write_raster(tmp_path / "survey.tif", survey, WEST, tile.north, 1)
    write_raster(tmp_path / "dsm.tif", np.full((64, 64), 100, np.float32), WEST, tile.north, 1)
    write_raster(tmp_path / "dtm.tif", np.full((64, 64), 100, np.float32), WEST, tile.north, 1)
    heights, mid, scale = frame.encode_heights(np.full((127, 127), 100, np.float32))
    procfill._save(heights, tmp_path / "heightmap.png")
    procfill._save(np.full((127, 127), 255, np.uint8), tmp_path / "grass.png")
    procfill._save(np.full((64, 64, 3), 127, np.uint8), tmp_path / "detail.png")
    source = Source(
        "file",
        str(tmp_path / "dsm.tif"),
        "test",
        "2030",
        terrain=str(tmp_path / "dtm.tif"),
        orthophoto=str(tmp_path / "survey.tif"),
    )
    site = SimpleNamespace(tile=tile, crs=CRS, survey=source, imagery=source, seed=1)
    args = (
        site,
        tmp_path / "naip.tif",
        tmp_path,
        [{"name": "grass", "file": "grass.png"}],
        {"file": "heightmap.png", "mid_m": mid, "z_scale": scale},
        None,
        {"pixels": 64, "file": "detail.png", "zero": 127, "log2_range": 1},
    )
    import json

    original_tree = {"columns": ["east_m", "north_m", "crown_radius_m", "height_m"], "trees": [[-30.0, 30.0, 5.0, 8.0]]}
    (tmp_path / "trees.json").write_text(json.dumps(original_tree))
    result = procfill.build(*args)
    derived = json.loads((tmp_path / result["trees_file"]).read_text())
    assert derived["trees"][0][:-1] == original_tree["trees"][0]
    assert derived["trees"][0][-1] == pytest.approx(0.7)
    hashes = {name: procfill._hash(tmp_path / name) for name in result["files"]}
    procfill.build(*args)
    assert hashes == {name: procfill._hash(tmp_path / name) for name in result["files"]}
    weights = np.stack([procfill._load(tmp_path / layer["file"]) for layer in result["surface_layers"]])
    assert (weights.astype(int).sum(axis=0) == 255).all()
    measured = procfill._load(tmp_path / "procfill_evidence_source.png") == procfill.SOURCES["measured"]
    assert measured[:32, :32].any()
    assert not measured[33:, 33:].any()
    edits = tmp_path / "procfill_edits"
    edits.mkdir()
    procfill._save(np.full((64, 64), 2, np.uint8), edits / "zones.png")
    procfill._save(np.full((64, 64), 255, np.uint8), edits / "bare.png")
    procfill._save(np.full((64, 64), 255, np.uint8), edits / "windrow.png")
    procfill._save(np.full((64, 64), 255, np.uint8), edits / "crown.png")
    painted_result = procfill.build(*args)
    derived = json.loads((tmp_path / painted_result["trees_file"]).read_text())
    assert derived["trees"][0][-1] == pytest.approx(1)
    assert json.loads((tmp_path / "trees.json").read_text()) == original_tree
    weights = {layer["name"]: procfill._load(tmp_path / layer["file"]) for layer in painted_result["surface_layers"]}
    assert (weights["soil"][:32, :32] > 128).all()
    assert (procfill._load(tmp_path / "procfill_growth.png")[:32, :32, 3] > 127).all()
    assert (procfill._load(tmp_path / "procfill_zones.png") == 2).all()
    assert (procfill._load(tmp_path / "procfill_zones_source.png") == procfill.SOURCES["painted"]).all()
    assert (procfill._load(tmp_path / "procfill_growth.png")[..., 2] > 128).any()
    procfill._save(np.full((64, 64), 255, np.uint8), edits / "zones.png")
    result = procfill.build(*args)
    assert not procfill._load(tmp_path / "procfill_growth.png")[..., :2].any()
    grass_layer = next(layer for layer in result["surface_layers"] if layer["name"] == "grass")
    assert not procfill._load(tmp_path / grass_layer["file"]).any()
    mixed = np.full((127, 127), 255, np.uint8)
    mixed[90:110, 10:30] = 102
    paving = np.zeros_like(mixed)
    paving[90:110, 10:30] = 153
    procfill._save(mixed, tmp_path / "grass.png")
    procfill._save(paving, tmp_path / "paved.png")
    mixed_args = (
        *args[:3],
        [{"name": "grass", "file": "grass.png"}, {"name": "paved", "file": "paved.png"}],
        *args[4:],
    )
    result = procfill.build(*mixed_args)
    weights = {layer["name"]: procfill._load(tmp_path / layer["file"]) for layer in result["surface_layers"]}
    assert not weights["grass"].any()
    assert (weights["paved"][90:110, 10:30] == 153).all()
    assert (weights["soil"][90:110, 10:30] == 102).all()


def test_small_survey_reports_insufficient_heldout_coverage():
    observed, classes = observations(16)
    zero = np.zeros(classes.shape)
    report = procfill.validate(observed, classes, zero, zero, zero.astype(bool), zero.astype(bool), 0.5, 1)
    assert report["status"] == "insufficient_coverage"
    assert len(report["folds"]) + len(report["skipped_folds"]) == 5
    assert report["mean_zone_total_variation"] is None


@pytest.mark.parametrize("cell_m", [0.25, 0.4921875])
def test_clump_cover_survives_raster_edges_and_fragmented_support(cell_m):
    y, x = np.indices((256, 256))
    eligible = ((x // 8 + y // 8) % 2 == 0) & (x > 10)
    result = procfill._stamp(
        eligible.shape, eligible, [[0.141, 1], [0.3, 2], [0.8, 1.5]], 0.32, cell_m, np.random.default_rng(21)
    )
    assert (result[eligible] > 0.5).mean() == pytest.approx(0.32, abs=0.015)
    assert not result[~eligible].any()


@pytest.mark.parametrize("share", [0, 0.32, 0.8, 0.95])
def test_subpixel_clump_cover_reaches_sparse_and_dense_targets(share):
    eligible = np.ones((256, 256), bool)
    result = procfill._stamp(eligible.shape, eligible, [[0.141, 1]], share, 0.5, np.random.default_rng(21))
    assert np.count_nonzero(result > 0.5) == round(eligible.size * share)


def test_clump_larger_than_available_cover_is_trimmed_to_budget():
    eligible = np.ones((16, 16), bool)
    result = procfill._stamp(eligible.shape, eligible, [[2, 1]], 0.01, 0.25, np.random.default_rng(21))
    assert np.count_nonzero(result > 0.5) == round(eligible.size * 0.01)
    assert np.count_nonzero(result) == round(eligible.size * 0.01)
    assert result.sum() <= round(eligible.size * 0.01)


def test_windrow_width_rejects_unrelated_fine_texture():
    y, x = np.indices((256, 256))
    cell_m, spacing, width = 0.25, 3.2, 0.75
    across = (3 * x + 4 * y) * cell_m / 5
    distance = abs((across + spacing / 2) % spacing - spacing / 2)
    lines = np.clip((width / 2 + cell_m / 2 - distance) / cell_m, 0, 1)
    noisy = 120 + 30 * lines + 4 * np.random.default_rng(5).normal(size=x.shape)
    samples = procfill._windrows(noisy, np.ones(x.shape, bool), np.ones(x.shape, bool), cell_m)
    rows = samples["samples_spacing_width_normal_deg"]
    assert len(rows) >= 12
    assert np.median([row[0] for row in rows]) == pytest.approx(spacing, abs=cell_m)
    assert np.median([row[1] for row in rows]) == pytest.approx(width, abs=cell_m / 2)


@pytest.mark.parametrize("cell_m", [0.25, 0.5])
@pytest.mark.parametrize("broken", [False, True])
def test_row_continuity_distinguishes_real_gaps_from_subpixel_width(cell_m, broken):
    y, x = np.indices((256, 256))
    distance = abs((x * cell_m + 1) % 2 - 1)
    lines = np.clip((0.35 / 2 + cell_m / 2 - distance) / cell_m, 0, 1)
    if broken:
        lines *= (y * cell_m % 8) < 4
    support = np.ones(x.shape, bool)
    samples = procfill._windrows(120 + 30 * lines, support, support, cell_m)
    assert samples["continuity_samples"]
    assert np.median(samples["continuity_samples"]) == pytest.approx(0.5 if broken else 1.0, abs=0.1)


@pytest.mark.parametrize("phase", [0, 0.25])
def test_underresolved_row_width_uses_tagged_prior_across_raster_phases(phase):
    _, x = np.indices((256, 256))
    distance = abs((x * 0.5 + phase + 1) % 2 - 1)
    lines = np.clip((0.35 / 2 + 0.5 / 2 - distance) / 0.5, 0, 1)
    support = np.ones(x.shape, bool)
    fitted = procfill._windrows(120 + 30 * lines, support, support, 0.5)
    assert fitted["width_kinds"]
    assert set(fitted["width_kinds"]) == {"prior: insufficient phase samples"}
    assert {row[1] for row in fitted["samples_spacing_width_normal_deg"]} == {0.35}


@pytest.mark.parametrize("angle", [10, 20, 35])
@pytest.mark.parametrize("cell_m", [0.25, 0.5])
def test_windrow_width_does_not_broaden_between_fft_bins(angle, cell_m):
    y, x = np.indices((256, 256))
    theta = np.deg2rad(angle)
    distance = abs(((x * np.cos(theta) + y * np.sin(theta)) * cell_m + 1) % 2 - 1)
    lines = np.clip((0.35 / 2 + cell_m / 2 - distance) / cell_m, 0, 1)
    support = np.ones(x.shape, bool)
    fitted = procfill._windrows(120 + 30 * lines, support, support, cell_m)
    assert fitted["samples_spacing_width_normal_deg"]
    assert np.median([row[1] for row in fitted["samples_spacing_width_normal_deg"]]) == pytest.approx(0.35, abs=0.15)


def test_large_field_samples_multiple_windrow_widths():
    observed, classes = observations(256)
    priors = procfill.fit(observed, classes, observed["valid"], 0.25)
    priors["zone_share_by_naip_class"] = [[0, 1, 0]] * 4
    priors["windrows"].update(
        normal_circular_mean_deg=0,
        samples_spacing_width_normal_deg=[[2, 0.3, 0], [2, 0.9, 0]],
        continuity_samples=[1, 1],
    )
    grass = np.ones(classes.shape, bool)
    zero = np.zeros(classes.shape)
    made = procfill.generate(priors, classes, grass, zero, zero, ~grass, ~grass, 0.25, 42)
    widths = np.array(
        [(made["windrow"][y : y + 64, x : x + 64] > 0.5).mean() * 2 for y in (32, 96, 160) for x in (32, 96, 160)]
    )
    assert widths.std() > 0.05
    assert widths.mean() == pytest.approx(0.6, abs=0.2)


def test_visible_ground_keeps_fitted_zone_shares_beside_hidden_canopy():
    observed, classes = observations(256)
    priors = procfill.fit(observed, classes, observed["valid"], 0.5)
    grass = np.ones(classes.shape, bool)
    zero = np.zeros(classes.shape)
    visible = np.indices(classes.shape)[0] < 128
    canopy = np.where(visible, 0, 8)
    made = procfill.generate(priors, classes, grass, zero, canopy, ~grass, ~grass, 0.5, 1, visible=visible)
    for index in (0, 1):
        support = visible & (classes == index)
        shares = np.bincount(made["zones"][support], minlength=3) / support.sum()
        np.testing.assert_allclose(shares, priors["zone_share_by_naip_class"][index], atol=0.001)
