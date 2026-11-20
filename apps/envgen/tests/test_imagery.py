"""Mask evidence keeps its CRS, NIR band, validity and source priority."""

import json
from dataclasses import replace

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.enums import ColorInterp
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

from envgen import imagery, surface
from envgen.acquire import _windows, acquire, raster_identity
from envgen.imagery_config import configure
from envgen.site import Source, Tile, load_site
from envgen.vector_sources import load

from .helpers import CRS, SOUTH, WEST, write_site


def raster(path, data, crs=CRS, bounds=None, alpha=False, mask=None, nodata=None):
    bounds = bounds or (WEST, SOUTH, WEST + 12, SOUTH + 12)
    west, south, east, north = bounds
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=len(data),
        dtype="uint8",
        nodata=nodata,
        crs=crs,
        width=data.shape[2],
        height=data.shape[1],
        transform=from_origin(west, north, (east - west) / data.shape[2], (north - south) / data.shape[1]),
    ) as out:
        out.write(data)
        out.colorinterp = (
            (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.undefined, ColorInterp.alpha)
            if len(data) == 5
            else (
                (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)
                if alpha
                else (ColorInterp.gray, ColorInterp.undefined, ColorInterp.undefined, ColorInterp.undefined)
            )
        )[: len(data)]
        if mask is not None:
            out.write_mask(mask)


def source(path):
    return Source("file", str(path), "test", "2024", bands=(("red", 1), ("green", 2), ("blue", 3), ("nir", 4)))


def test_nir_is_not_alpha_and_different_crs_is_transformed(tmp_path):
    path = tmp_path / "leaf-off.tif"
    raster(
        path,
        np.broadcast_to(np.array([40, 60, 30, 190], dtype=np.uint8)[:, None, None], (4, 48, 48)).copy(),
        "EPSG:4326",
        transform_bounds(CRS, "EPSG:4326", WEST, SOUTH, WEST + 12, SOUTH + 12),
    )
    values, valid = imagery.read(source(path), CRS, Tile(WEST + 2, SOUTH + 2, 1, 8))
    assert valid.all()
    np.testing.assert_allclose(values[3], 190)


def test_internal_mask_and_outside_coverage_are_not_evidence(tmp_path):
    path = tmp_path / "masked.tif"
    mask = np.full((12, 12), 255, dtype=np.uint8)
    mask[3:9, 3:9] = 0
    raster(path, np.full((4, 12, 12), 90, dtype=np.uint8), mask=mask)
    _, valid = imagery.read(source(path), CRS, Tile(WEST - 2, SOUTH - 2, 1, 16))
    assert not valid[0].any()
    assert not valid[8, 8]
    assert valid[4, 4]


def test_drone_wins_only_inside_valid_alpha(tmp_path):
    winter = tmp_path / "winter.tif"
    drone = tmp_path / "drone.tif"
    data = np.zeros((4, 12, 12), dtype=np.uint8)
    data[0:3] = 70
    data[3, :, :6] = 180
    data[3] = 180
    bounds = (WEST, SOUTH, WEST + 120, SOUTH + 120)
    raster(winter, data, bounds=bounds)
    photo = np.zeros_like(data)
    photo[:3, :, :6] = np.array([40, 160, 40])[:, None, None]
    photo[:3, :, 6:] = 70
    photo[3, :, 3:] = 255
    raster(drone, photo, alpha=True, bounds=bounds)
    site = replace(
        load_site(write_site(tmp_path)),
        tile=Tile(WEST, SOUTH, 10, 12),
        mask_imagery=source(winter),
        survey=Source("file", "unused", "test", "2026", orthophoto=str(drone)),
    )
    reference = np.ones((13, 13), dtype=np.uint8)
    reference[:, :3] = 0
    labels, names, fit = imagery.classify(site, reference, imagery.NAMES)
    assert names[labels[6, 2]] == surface.GRASS
    assert names[labels[6, 9]] == surface.PAVED
    assert fit["priority"][0] == "survey"
    assert 0 < fit["evidence"]["survey"]["valid_fraction"] < 1


def test_vectors_retain_tags_holes_and_null_heights(tmp_path):
    path = tmp_path / "vector.json"
    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [3, 0], [3, 3], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]],
            },
            "properties": {"height": height, "building:levels": "2"},
        }
        for height in (4.2, None, -1)
    ]
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    result = load(source(path), "microsoft")
    assert [f["properties"]["height_m"] for f in result] == [4.2, None, None]
    assert result[0]["geometry"] == features[0]["geometry"]
    assert load(source(path), "osm") == features


def test_partial_drone_alpha_is_valid(tmp_path):
    path = tmp_path / "partial.tif"
    data = np.full((4, 12, 12), 128, dtype=np.uint8)
    raster(path, data, alpha=True)
    _, valid = imagery.read(
        replace(source(path), bands=(("red", 1), ("green", 2), ("blue", 3))), CRS, Tile(WEST + 2, SOUTH + 2, 1, 8)
    )
    assert valid.all()


def test_uncertain_single_population_retains_reference_and_can_calibrate(tmp_path):
    path = tmp_path / "flat.tif"
    raster(path, np.full((4, 12, 12), 90, dtype=np.uint8))
    site = replace(load_site(write_site(tmp_path)), tile=Tile(WEST, SOUTH, 1, 12), mask_imagery=source(path))
    reference = np.ones((13, 13), dtype=np.uint8)
    reference[:, :6] = 0
    labels, _, record = imagery.classify(site, reference, imagery.NAMES)
    np.testing.assert_array_equal(labels, reference)
    assert not record["evidence"]["mask_imagery"]["applied"]
    values = np.tile(np.arange(13, dtype=np.float32), (13, 1))
    grass = np.where(values >= 6, 0, 1)
    fitted = imagery.reference_split(values, grass, np.ones_like(grass, dtype=bool))
    assert fitted["balanced_reference_agreement"] == 1
    np.testing.assert_array_equal(np.where(values >= fitted["threshold"], 0, 1), grass)


def test_configuration_keeps_service_surround_and_provenance(tmp_path):
    raw = json.loads(write_site(tmp_path).read_text())
    raw["context"] = {"size_m": 504}
    datasets = [
        {"path": name, "license": "CC BY test", "capture_date": "2024", "license_url": "https://test", "source": "test"}
        for name in (
            "msdis-2024-015m-leafoff-rgbnir.tif",
            "microsoft-buildings.geojson",
            "osm-buildings-sports.geojson",
        )
    ]
    (tmp_path / "manifest.json").write_text(json.dumps({"datasets": datasets}))
    configured = configure(raw, tmp_path)
    path = tmp_path / "configured.json"
    path.write_text(json.dumps(configured))
    site = load_site(path)
    windows = {name: (s, window, spacing) for name, s, window, spacing in _windows(site)}
    assert windows["imagery"][0].request_spacing_m == 0.3
    assert windows["context_imagery"][0] == site.imagery
    assert windows["context_imagery"][2] == 1
    assert windows["context_imagery"][1][2] - windows["context_imagery"][1][0] == 506
    for name, s, _, _ in _windows(site):
        if s.kind == "file":
            if name == "mask_imagery":
                raster(tmp_path / s.location, np.full((4, 12, 12), 90, dtype=np.uint8))
            else:
                (tmp_path / s.location).write_text("test")
    for s in (site.microsoft_buildings, site.osm_features):
        (tmp_path / s.location).write_text("test")
    # Inspect file records without fetching the deliberately unreachable test services.
    local = replace(site, imagery=site.mask_imagery, context_size_m=None)
    registry = acquire(local, tmp_path / "cache")
    assert registry["mask_imagery"]["internal_only"]
    assert "conflicts" in registry["mask_imagery"]["license_conflict"]
    assert registry["microsoft_buildings"]["sha256"]


def test_external_mask_changes_identity_and_survey_is_registered_without_cover(tmp_path):
    path = tmp_path / "evidence.tif"
    raster(path, np.full((4, 12, 12), 90, dtype=np.uint8))
    before = raster_identity(path)
    with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=False), rasterio.open(path, "r+") as dataset:
        dataset.write_mask(np.zeros((12, 12), dtype=np.uint8))
    after = raster_identity(path)
    assert before[str(path)] == after[str(path)]
    assert before != after
    assert str(path) + ".msk" in after
    site = replace(
        load_site(write_site(tmp_path)),
        elevation=source(path),
        imagery=source(path),
        mask_imagery=source(path),
        survey=Source("file", "unused", "private survey", "2026", orthophoto=str(path)),
    )
    registry = acquire(site, tmp_path / "cache")
    assert registry["survey_orthophoto"]["license"] == "private survey"
    assert registry["survey_orthophoto"]["raster_files"] == after


def test_native_evidence_rejects_missing_split_and_preserves_unresolved_soil(tmp_path):
    path = tmp_path / "evidence.tif"
    raster(path, np.full((4, 12, 12), 90, dtype=np.uint8))
    tile = Tile(WEST, SOUTH, 1, 12)
    reference = np.ones((13, 13), dtype=np.uint8)
    reference[:, :6] = 2
    target = tmp_path / "masks.tif"
    with pytest.raises(ValueError, match="accepted vegetation split"):
        imagery.write_native_masks(source(path), [{"split": False}], target, reference, tile, CRS)
    assert not target.exists()
    splits = [{"index": surface.NIR_INDEX, "threshold": 0.2, "split": True}]
    imagery.write_native_masks(source(path), splits, target, reference, tile, CRS)
    with rasterio.open(target) as masks:
        data = masks.read()
        assert (data[2, :, 2] == 255).all()
        assert (data[1, :, 9] == 255).all()
        np.testing.assert_array_equal(data[:3].sum(axis=0), data[3])
    splits.append({"index": surface.RED_INDEX, "threshold": 0.1, "split": True})
    imagery.write_native_masks(source(path), splits, target, reference, tile, CRS)
    with rasterio.open(target) as masks:
        assert (masks.read(2) == 255).all()
        assert not masks.read(3).any()


def test_unassisted_vegetation_split_retains_reference_soil_when_soil_is_unresolved(tmp_path):
    path = tmp_path / "winter.tif"
    values = np.full((4, 100, 100), 80, dtype=np.uint8)
    values[3, :, :50] = 200
    values[3, :, 50:] = 30
    raster(path, values, bounds=(WEST, SOUTH, WEST + 100, SOUTH + 100))
    site = replace(load_site(write_site(tmp_path)), tile=Tile(WEST, SOUTH, 1, 100), mask_imagery=source(path))
    reference = np.full((101, 101), 2, dtype=np.uint8)
    labels, _, record = imagery.classify(site, reference, imagery.NAMES)
    splits = record["evidence"]["mask_imagery"]["fit"]["splits"]
    assert splits[0]["split"]
    assert not splits[1]["split"]
    assert labels[50, 25] == 0
    assert labels[50, 75] == 2


def test_native_nonvegetated_pixel_inherits_original_soil_under_coarse_vegetation(tmp_path):
    path = tmp_path / "winter.tif"
    values = np.full((4, 200, 200), 80, dtype=np.uint8)
    values[3, :, :100] = 200
    values[3, :, 100:] = 30
    values[3, 100, 40] = 30
    raster(path, values, bounds=(WEST, SOUTH, WEST + 100, SOUTH + 100))
    site = replace(load_site(write_site(tmp_path)), tile=Tile(WEST, SOUTH, 10, 10), mask_imagery=source(path))
    original = np.full((11, 11), 2, dtype=np.uint8)
    coarse, _, record = imagery.classify(site, original, imagery.NAMES)
    assert coarse[5, 2] == 0
    splits = record["evidence"]["mask_imagery"]["fit"]["splits"]
    assert splits[0]["split"] and not splits[1]["split"]
    target = tmp_path / "native.tif"
    imagery.write_native_masks(site.mask_imagery, splits, target, original, site.tile, site.crs)
    with rasterio.open(target) as masks:
        np.testing.assert_array_equal(masks.read()[:, 100, 40], [0, 0, 255, 255])


def test_required_band_nodata_and_pixels_outside_reference_have_no_native_evidence(tmp_path):
    path = tmp_path / "nodata.tif"
    values = np.full((4, 12, 12), 80, dtype=np.uint8)
    values[3, 6, 6] = 0
    raster(path, values, nodata=0)
    tile = Tile(WEST + 3, SOUTH + 3, 1, 6)
    reference = np.full((7, 7), 2, dtype=np.uint8)
    target = tmp_path / "native.tif"
    splits = [{"index": surface.NIR_INDEX, "threshold": 0.2, "split": True}]
    imagery.write_native_masks(source(path), splits, target, reference, tile, CRS)
    with rasterio.open(target) as masks:
        data = masks.read()
        assert not data[:, 6, 6].any()
        assert not data[:, 0, 0].any()
        np.testing.assert_array_equal(data[:, 5, 5], [0, 0, 255, 255])
    _, valid = imagery.read(source(path), CRS, Tile(WEST + 0.5, SOUTH + 0.5, 1, 11))
    assert not valid[6, 6]


@pytest.mark.parametrize("mask_mode", ["nodata", "internal", "external", "alpha"])
@pytest.mark.parametrize("missing_band", [0, 1, 2, 3])
def test_spectral_nodata_stays_invalid_when_other_masks_declare_valid(tmp_path, mask_mode, missing_band):
    path = tmp_path / "masked-nodata.tif"
    values = np.full((5 if mask_mode == "alpha" else 4, 12, 12), 80, dtype=np.uint8)
    values[missing_band, 6, 6] = 0
    if mask_mode == "alpha":
        values[4] = 255
    raster(path, values, nodata=0)
    if mask_mode in ("internal", "external"):
        with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=mask_mode == "internal"), rasterio.open(path, "r+") as dataset:
            dataset.write_mask(np.full((12, 12), 255, dtype=np.uint8))
    tile = Tile(WEST + 0.5, SOUTH + 0.5, 1, 11)
    target = tmp_path / "native.tif"
    imagery.write_native_masks(
        source(path),
        [{"index": surface.NIR_INDEX, "threshold": 0.2, "split": True}],
        target,
        np.full((12, 12), 2, dtype=np.uint8),
        tile,
        CRS,
    )
    with rasterio.open(target) as masks:
        assert not masks.read()[:, 6, 6].any()
    _, valid = imagery.read(source(path), CRS, tile)
    assert not valid[6, 6]


@pytest.mark.parametrize("nodata", [None, 0])
@pytest.mark.parametrize("invalidity", ["alpha", "dataset"])
def test_alpha_and_dataset_masks_can_only_remove_evidence(tmp_path, nodata, invalidity):
    path = tmp_path / "validity.tif"
    values = np.full((5, 12, 12), 80, dtype=np.uint8)
    values[4] = 255
    if invalidity == "alpha":
        values[4, 6, 6] = 0
    raster(path, values, nodata=nodata)
    if invalidity == "dataset":
        mask = np.full((12, 12), 255, dtype=np.uint8)
        mask[6, 6] = 0
        with rasterio.open(path, "r+") as dataset:
            dataset.write_mask(mask)
    tile = Tile(WEST + 0.5, SOUTH + 0.5, 1, 11)
    target = tmp_path / "native.tif"
    imagery.write_native_masks(
        source(path),
        [{"index": surface.NIR_INDEX, "threshold": 0.2, "split": True}],
        target,
        np.full((12, 12), 2, dtype=np.uint8),
        tile,
        CRS,
    )
    with rasterio.open(target) as masks:
        assert not masks.read()[:, 6, 6].any()
    _, valid = imagery.read(source(path), CRS, tile)
    assert not valid[6, 6]


def test_invalid_pixels_do_not_contaminate_a_partially_covered_coarse_average(tmp_path):
    path = tmp_path / "partial-support.tif"
    values = np.full((4, 12, 12), 80, dtype=np.uint8)
    values[:, 5, 5] = [250, 250, 250, 10]
    mask = np.full((12, 12), 255, dtype=np.uint8)
    mask[5, 5] = 0
    raster(path, values, nodata=0, mask=mask)
    averaged, valid = imagery.read(source(path), CRS, Tile(WEST + 1, SOUTH + 1, 2, 5))
    assert valid.all()
    np.testing.assert_allclose(averaged, 80)


@pytest.mark.parametrize("mixed_coverage", [False, True])
@pytest.mark.parametrize("tag_alpha", [False, True])
@pytest.mark.parametrize("ortho_skipped", [False, True])
def test_survey_reservation_matches_actual_survey_detail_coverage(tmp_path, monkeypatch, mixed_coverage, tag_alpha, ortho_skipped):
    from envgen import build as pipeline

    winter, drone = tmp_path / "winter.tif", tmp_path / "survey.tif"
    spectral = np.full((4, 12, 12), 80, dtype=np.uint8)
    spectral[3, :, :6] = 200
    spectral[3, :, 6:] = 30
    bounds = (WEST, SOUTH, WEST + 120, SOUTH + 120)
    raster(winter, spectral, bounds=bounds)
    survey = np.full((4, 12, 12), 80, dtype=np.uint8)
    survey[3] = 128
    if mixed_coverage:
        survey[3, :, 8:] = 255
    raster(drone, survey, bounds=bounds, alpha=tag_alpha)
    site = replace(
        load_site(write_site(tmp_path)),
        tile=Tile(WEST, SOUTH, 10, 12),
        mask_imagery=source(winter),
        survey=Source("file", "unused", "test", "2026", orthophoto=str(drone)),
    )
    labels, _, record = imagery.classify(site, np.ones((13, 13), dtype=np.uint8), imagery.NAMES)
    assert labels[6, 2] == 0
    fallback, _, _ = imagery.classify(site, np.ones((13, 13), dtype=np.uint8), imagery.NAMES, reserve_survey=False)
    without_survey, _, _ = imagery.classify(replace(site, survey=None), np.ones((13, 13), dtype=np.uint8), imagery.NAMES)
    np.testing.assert_array_equal(fallback, without_survey)
    if mixed_coverage:
        assert 0 < record["evidence"]["survey"]["valid_fraction"] < 1
        eligible = imagery.survey_coverage(str(drone), CRS, site.tile)
        assert not eligible[6, 7]
        assert eligible[6, 8]
    else:
        assert record["evidence"]["survey"]["valid_fraction"] == 0
    out = tmp_path / "out"
    out.mkdir()
    Image.fromarray(np.full((13, 13), 255, dtype=np.uint8)).save(out / "grass.png")
    monkeypatch.setattr(pipeline, "DETAIL_PIXELS", 24)
    ortho = {"files": [], "skipped": "unsupported layout"} if ortho_skipped else None
    detail = pipeline.build_survey_detail(site, out, None, [{"name": "grass", "file": "grass.png"}], ortho)
    encoded = np.array(Image.open(out / detail["file"]))
    assert np.count_nonzero(encoded) == (48 if mixed_coverage else 0)


@pytest.mark.parametrize("incompatible", ["crs", "bands"])
def test_skipped_survey_detail_does_not_reserve_fallback(tmp_path, monkeypatch, incompatible):
    from envgen import build as pipeline

    winter, drone = tmp_path / "winter.tif", tmp_path / "survey.tif"
    spectral = np.full((4, 12, 12), 80, dtype=np.uint8)
    spectral[3, :, :6], spectral[3, :, 6:] = 200, 30
    bounds = (WEST, SOUTH, WEST + 120, SOUTH + 120)
    raster(winter, spectral, bounds=bounds)
    survey = np.full((3 if incompatible == "bands" else 4, 12, 12), 255, dtype=np.uint8)
    raster(drone, survey, bounds=bounds, crs="EPSG:32632" if incompatible == "crs" else CRS)
    site = replace(
        load_site(write_site(tmp_path)),
        tile=Tile(WEST, SOUTH, 10, 12),
        mask_imagery=source(winter),
        survey=Source("file", "unused", "test", "2026", orthophoto=str(drone)),
    )
    labels, _, record = imagery.classify(site, np.ones((13, 13), dtype=np.uint8), imagery.NAMES)
    assert labels[6, 2] == 0
    assert record["evidence"]["survey"]["valid_fraction"] == 0
    out = tmp_path / "out"
    out.mkdir()
    Image.fromarray(np.full((13, 13), 255, dtype=np.uint8)).save(out / "grass.png")
    monkeypatch.setattr(pipeline, "DETAIL_PIXELS", 24)
    detail = pipeline.build_survey_detail(site, out, None, [{"name": "grass", "file": "grass.png"}])
    assert "skipped" in detail
    assert not (out / "survey_detail.png").exists()
