"""Survey masks retain their footprint, native geometry, and real raster sampling behavior."""

import json
from dataclasses import replace

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.enums import ColorInterp

from envgen import frame, orthophoto
from envgen.acquire import sha256_file
from envgen.build import build_orthophoto, clean_ortho_colour
from envgen.site import load_site, tile_for_boundary

from . import helpers as h


def tile():
    return tile_for_boundary(h.BOUNDARY, h.SIZE_M, 1.0)


def test_identified_fabric_cover_stays_hidden_but_is_not_tree_canopy(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    rgba = np.full((4, 504, 504), 255, dtype=np.uint8)
    rgba[:3] = np.array([65, 120, 40])[:, None, None]
    rgba[:3, 360:408, 96:144] = np.array([40, 110, 220])[:, None, None]
    h.write_raster(tmp_path / "ortho.tif", rgba, tile().west, tile().north, .25)
    ground = np.full((126, 126), 100, dtype=np.float32)
    dsm = ground.copy()
    dsm[90:102, 24:36] += 3  # Fabric cover over ground.
    dsm[50:62, 64:76] += 8  # An unannotated height-backed crown remains.
    for name, data in (("dtm", ground), ("dsm", dsm)):
        h.write_raster(tmp_path / f"{name}.tif", data, tile().west, tile().north, 1)
    evidence = {"schema_version": 1, "source": {"sha256": sha256_file(tmp_path / "ortho.tif"), "crs": h.CRS},
                "features": [{"id": "B1", "feature_type": "temporary_canopy", "confidence": .99,
                              "bounds_projected_m": [h.WEST+24, h.SOUTH+24, h.WEST+36, h.SOUTH+36]}]}
    (tmp_path / "observations.json").write_text(json.dumps(evidence))
    path = h.write_site(tmp_path)
    spec = json.loads(path.read_text())
    spec["sources"]["survey"] = {"kind": "file", "path": "dsm.tif", "terrain": "dtm.tif",
                                 "orthophoto": "ortho.tif", "observations": "observations.json",
                                 "license": "test", "date": "2030"}
    path.write_text(json.dumps(spec))
    site = load_site(path)
    for name, survey in (("known", site.survey), ("unknown", replace(site.survey, observations=None))):
        out = tmp_path / name
        out.mkdir()
        build_orthophoto(replace(site, survey=survey), tmp_path / "imagery.tif", out, None, None)
    with rasterio.open(tmp_path / "known" / "ortho_masks.tif") as src:
        known = src.read()
    with rasterio.open(tmp_path / "unknown" / "ortho_masks.tif") as src:
        unknown = src.read()
    assert unknown[3, 384, 120] == 255
    assert known[3, 384, 120] == 0 and known[0, 384, 120] == 255
    assert known[3, 224, 280] == 255
    with rasterio.open(tmp_path / "known" / "ortho_colour.tif") as src:
        assert src.read()[:3, 384, 120] == pytest.approx([65, 120, 40], abs=2)


def write_survey(tmp_path, pixel=0.25):
    # Each class has >1000 m² so the real fitted classifier has enough evidence for both splits.
    side = round(126 / pixel)
    data = np.full((4, side, side), 255, dtype=np.uint8)
    data[:3, :, :side//3] = np.array([65, 120, 40])[:, None, None]
    data[:3, :, side//3:2*side//3] = 110
    data[:3, :, 2*side//3:] = np.array([150, 90, 55])[:, None, None]
    data[3, -20:, -20:] = 0
    data[3, 20:40, 20:40] = 128
    path = tmp_path / "ortho.tif"
    h.write_raster(path, data, tile().west, tile().north, pixel)
    return path, data


def run_survey(tmp_path, path, height=None):
    grid = np.zeros((127, 127), dtype=np.uint8)
    heights = np.zeros_like(grid, dtype=np.float32) if height is None else height
    return orthophoto.build(path, tmp_path, tile(), h.CRS, grid, ["grass"], heights,
                            heights < 2, clean_ortho_colour)


def test_native_masks_fit_classes_preserve_alpha_and_png_layout(tmp_path):
    path, data = write_survey(tmp_path)
    report = run_survey(tmp_path, path)
    with rasterio.open(tmp_path / report["raster"]) as raster:
        encoded = raster.read()
        assert raster.transform == rasterio.open(path).transform
        assert raster.colorinterp[3] != ColorInterp.alpha
    assert report["channels"] == ["grass", "paved", "soil", "canopy"]
    assert report["pixels"] == [504, 504]
    assert np.array_equal(encoded[:3].astype(int).sum(axis=0), data[3])
    for index, column in enumerate([80, 250, 420]):
        assert encoded[index, 200, column] > 250
    assert encoded[3].max() == 0
    png = np.asarray(Image.open(tmp_path / report["file"]))
    assert np.array_equal(png, frame.to_unreal_layout(np.moveaxis(encoded, 0, -1)))
    assert report["classification"]["splits"][0]["split"]
    assert report["classification"]["splits"][1]["split"]


def test_survey_boundary_fades_influence_without_erasing_native_evidence(tmp_path):
    path, data = write_survey(tmp_path)
    report = run_survey(tmp_path, path)
    with rasterio.open(tmp_path / report["raster"]) as source:
        assert np.array_equal(source.read()[:3].astype(int).sum(axis=0), data[3])
    with rasterio.open(tmp_path / report["colour_raster"]) as source:
        alpha = source.read(4)
    assert alpha[200, 0] < 5
    assert alpha[200, 80] == 255
    assert np.all(alpha <= data[3])
    effective = orthophoto.sample(tmp_path / report["raster"], tile(), h.CRS, 127,
                                  tmp_path / report["colour_raster"])
    fallback = np.ones((1, 127, 127), dtype=np.float32)
    combined, _ = orthophoto.blend(fallback, ["soil"], effective)
    assert combined[0, 60, 1] < .05
    assert combined[0, 60, 20] > .99
    assert combined[2, 60, 1] > .95
    assert np.allclose(combined.sum(axis=0), 1)


def test_real_reprojection_blends_only_inside_alpha_coverage(tmp_path):
    path, _ = write_survey(tmp_path)
    report = run_survey(tmp_path, path)
    sampled = orthophoto.sample(tmp_path / report["raster"], tile(), h.CRS, 127)
    fallback = np.zeros((2, 127, 127), dtype=np.float32)
    fallback[1] = 1  # older imagery called the entire tile soil
    combined, names = orthophoto.blend(fallback, ["grass", "soil"], sampled)
    assert names == ["grass", "paved", "soil"]
    assert np.allclose(combined.sum(axis=0), 1)
    assert combined[0, 60, 15] > 0.99
    assert combined[1, 60, 63] > 0.99
    assert combined[2, -2, -2] == 1  # alpha hole
    assert combined[0, 7, 7] == pytest.approx(128/255, abs=0.01)
    assert combined[2, 7, 7] == pytest.approx(127/255, abs=0.01)
    # Extend the destination tile: GDAL must not extend the edge pixel into uncovered ground.
    from dataclasses import replace
    larger = replace(tile(), west=tile().west-10)
    shifted = orthophoto.sample(tmp_path / report["raster"], larger, h.CRS, 127)
    assert (shifted[:, :, :8] == 0).all()


def test_height_disambiguates_canopy_and_uses_hidden_ground(tmp_path):
    path, _ = write_survey(tmp_path)
    heights = np.zeros((127, 127), dtype=np.float32)
    heights[30:45, 10:25] = 8
    report = run_survey(tmp_path, path, heights)
    with rasterio.open(tmp_path / report["raster"]) as raster:
        encoded = raster.read()
    assert encoded[3, 145, 70] == 255
    assert encoded[0, 145, 70] == 255
    with rasterio.open(tmp_path / report["colour_raster"]) as raster:
        colour = raster.read()
    assert colour[3, -2, -2] == 0
    assert colour[:3, 145, 70] == pytest.approx([65, 120, 40], abs=3)


def test_colour_removes_crown_and_survey_shadow_without_old_sun(tmp_path):
    rows, columns = 400, 400
    rgb = np.broadcast_to(np.array([80, 130, 50], dtype=np.float32)[:, None, None], (3, rows, columns)).copy()
    rgb[:, 150:190, 50:350] *= 0.5  # seasonal shadow with >10,000 cells
    rgb[:, 200:240, 150:200] = np.array([15, 35, 8])[:, None, None]  # hidden crown
    shown = np.ones((rows, columns), dtype=bool)
    shown[200:240, 150:200] = False
    colour, report = clean_ortho_colour(rgb, shown, np.zeros(shown.shape, dtype=np.uint8), 0.25)
    assert "grass" in report["shadows"]
    assert colour[:, 170, 200] == pytest.approx([80, 130, 50], abs=3)
    assert colour[:, 220, 175] == pytest.approx([80, 130, 50], abs=3)


def test_capped_pooled_grids_and_chunk_halos_match_native_classification(tmp_path, monkeypatch):
    path, _ = write_survey(tmp_path)
    large = tmp_path / "large"
    small = tmp_path / "small"
    large.mkdir()
    small.mkdir()
    original = orthophoto.SETTINGS.copy()
    report = orthophoto.build(path, large, tile(), h.CRS, np.zeros((127, 127), dtype=np.uint8), ["grass"],
                              np.zeros((127, 127)), np.ones((127, 127), dtype=bool), clean_ortho_colour)
    monkeypatch.setitem(orthophoto.SETTINGS, "block_pixels", 64)
    monkeypatch.setitem(orthophoto.SETTINGS, "colour_max_pixels", 10_000)
    second = orthophoto.build(path, small, tile(), h.CRS, np.zeros((127, 127), dtype=np.uint8), ["grass"],
                              np.zeros((127, 127)), np.ones((127, 127), dtype=bool), clean_ortho_colour)
    with rasterio.open(large / report["raster"]) as first, rasterio.open(small / second["raster"]) as other:
        assert np.array_equal(first.read(), other.read())
    assert np.prod(second["colour_pixels"]) <= 10_000
    assert second["colour_pixel_m"] >= 1.26
    assert original["block_pixels"] == 512


def test_non_square_survey_geometry_and_streamed_png_keep_both_axes(tmp_path):
    from rasterio.transform import Affine

    values = np.zeros((4, 40, 65), dtype=np.uint8)
    values[0] = 70
    values[1] = np.arange(40, dtype=np.uint8)[:, None] + 80
    values[2] = np.arange(65, dtype=np.uint8)[None, :] + 20
    values[3] = 255
    path = tmp_path / "ortho.tif"
    h.write_raster(path, values, tile().west, tile().north, 1.0)
    with rasterio.open(path, "r+") as raster:
        raster.transform = Affine(1, 0, tile().west, 0, -1.00004, tile().north)
    report = run_survey(tmp_path, path)
    assert report["pixels"] == [65, 40]
    assert report["pixel_size_m"] == [1, 1.00004]
    assert report["north_extent_m"] == pytest.approx(40.0016)
    orthophoto.write_png(path, tmp_path / "direct.png")
    png = np.asarray(Image.open(tmp_path / "direct.png"))
    assert png.shape == (65, 40, 4)
    assert np.array_equal(png, frame.to_unreal_layout(np.moveaxis(values, 0, -1)))


def test_empty_alpha_never_replaces_fallback_ground_or_colour(tmp_path):
    path, data = write_survey(tmp_path)
    data[3] = 0
    h.write_raster(path, data, tile().west, tile().north, 0.25)
    report = run_survey(tmp_path, path)
    sampled = orthophoto.sample(tmp_path / report["raster"], tile(), h.CRS, 127)
    weights, _ = orthophoto.blend(np.ones((1, 127, 127)), ["soil"], sampled)
    assert (sampled == 0).all()
    assert (weights[2] == 1).all()
    assert (np.asarray(Image.open(tmp_path / report["colour"]))[..., 3] == 0).all()


def test_mask_sampling_reprojects_between_projected_coordinate_systems(tmp_path):
    from rasterio.warp import transform_bounds

    from envgen.site import Tile

    path, _ = write_survey(tmp_path)
    report = run_survey(tmp_path, path)
    west, south, east, north = transform_bounds(h.CRS, "EPSG:3857", *tile().bounds())
    size = max(east-west, north-south) + 40
    projected = Tile(west=west-20, south=south-20, quad_m=size/126, quads=126)
    warped = orthophoto.sample(tmp_path / report["raster"], projected, "EPSG:3857", 127)
    assert warped[1, 63, 63] > 0.95
    assert warped[:, :, :8].max() == 0
    assert warped[0].max() > 0.99 and warped[2].max() > 0.99


def test_survey_detail_streams_its_ratio_and_preserves_true_affine_extents(tmp_path, monkeypatch):
    import importlib
    import json

    from rasterio.transform import Affine

    from envgen.site import load_site

    pipeline = importlib.import_module("envgen.build")
    monkeypatch.setattr(pipeline, "DETAIL_PIXELS", 64)
    values = np.full((4, 40, 65), 120, dtype=np.uint8)
    values[3] = 255
    values[3, -4:, -4:] = 0
    path = tmp_path / "ortho.tif"
    h.write_raster(path, values, tile().west, tile().north, 1.0)
    with rasterio.open(path, "r+") as raster:
        raster.transform = Affine(1, 0, tile().west, 0, -1.00004, tile().north)
    spec_path = h.write_site(tmp_path)
    spec = json.loads(spec_path.read_text())
    spec["sources"]["survey"] = {"kind": "file", "path": "dsm.tif", "terrain": "dtm.tif",
                                 "orthophoto": "ortho.tif", "license": "test", "date": "2030"}
    spec_path.write_text(json.dumps(spec))
    Image.fromarray(np.full((127, 127), 255, dtype=np.uint8)).save(tmp_path / "grass.png")
    report = pipeline.build_survey_detail(load_site(spec_path), tmp_path, None,
                                          [{"name": "grass", "file": "grass.png"}])
    assert report["north_extent_m"] == pytest.approx(40.0016)
    assert report["south_m"] == pytest.approx(126-40.0016)
    png = np.asarray(Image.open(tmp_path / report["file"]))
    assert png.shape == (65, 40)
    assert (png[-4:, :4] == 0).all()
    assert np.median(png[png > 0]) == report["zero"]
    with rasterio.open(tmp_path / "survey_detail.tif") as raster:
        assert np.array_equal(png, frame.to_unreal_layout(raster.read(1)))
