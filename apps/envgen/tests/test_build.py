import json
import math
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image

from envgen import acquire, frame
from envgen.build import CONTEXT_MACRO_PIXELS, MACRO_LOW_PASS_M, build, shadow_gap
from envgen.cli import main
from envgen.site import SiteError, load_site, tile_for_boundary

from . import helpers as h


def decoded_heights(out, manifest):
    landscape = manifest["landscape"]
    heights = np.asarray(Image.open(out / landscape["heightmap"]))
    mid_m = manifest["georeference"]["origin_height_m"] + landscape["location_cm"][2] / 100
    return frame.decode_heights(heights, mid_m, landscape["scale"][2])


def macro_colour(out, manifest):
    return np.asarray(Image.open(out / manifest["macro_colour"]["file"])).astype(int)


def forbid_network(monkeypatch):
    def refuse(url):
        raise AssertionError(f"unexpected request to {url}")

    monkeypatch.setattr(acquire, "_fetch", refuse)


@pytest.fixture
def site(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST + 63)
    return h.write_site(tmp_path)


def test_tile_is_centred_on_the_boundary_and_snapped_to_metres():
    tile = tile_for_boundary([(10.4, 20.2), (110.4, 120.2)], 126.0, 1.0)
    assert (tile.west, tile.south, tile.vertices) == (-3.0, 7.0, 127)


def test_tile_size_must_fit_landscape_components():
    with pytest.raises(SiteError, match="whole multiple of 126 quads"):
        tile_for_boundary([(0, 0), (10, 10), (0, 10)], 100.0, 1.0)


def test_boundary_larger_than_the_tile_is_rejected():
    with pytest.raises(SiteError, match="does not fit"):
        tile_for_boundary([(0, 0), (500, 10), (0, 10)], 126.0, 1.0)


@pytest.mark.parametrize("crs", ["EPSG:4326", "EPSG:2263", "not a crs"])
def test_only_a_projected_metre_crs_is_accepted(tmp_path, capsys, crs):
    # 4326 is geographic, 2263 is in feet: both would scale the tile wrongly without any error.
    assert main(["build", str(h.write_site(tmp_path, crs=crs)), "--out", str(tmp_path / "out")]) == 1
    assert "crs" in capsys.readouterr().err


def test_the_example_site_file_loads():
    example = load_site(Path(__file__).parent.parent / "examples" / "site.example.json")
    assert example.tile.size_m == 1008 and example.tile.vertices == 2017


def test_heightmap_rows_run_east_and_columns_run_north(site, tmp_path):
    manifest = build(site, tmp_path / "out")
    heights = decoded_heights(tmp_path / "out", manifest)
    tile = load_site(site).tile

    assert heights.shape == (127, 127)
    for east_index, north_index in [(0, 0), (126, 0), (0, 126), (40, 90)]:
        expected = h.plane(tile.west + east_index, tile.south + north_index)
        assert heights[east_index, north_index] == pytest.approx(expected, abs=0.01)


def test_vertices_sample_the_dem_at_their_own_position_not_half_a_cell_off(tmp_path):
    # A steep ramp on a DEM finer than the vertex grid: a half-cell misalignment in either grid shows as 0.25 m or more.
    def steep(easting, northing):
        return 50.0 + 0.5 * (easting - h.WEST) + 1.0 * (northing - h.SOUTH)

    h.write_dem(tmp_path / "dem.tif", function=steep, spacing=0.5)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    site = h.write_site(tmp_path)
    heights = decoded_heights(tmp_path / "out", build(site, tmp_path / "out"))
    tile = load_site(site).tile

    for east_index, north_index in [(0, 0), (126, 126), (17, 101), (88, 3)]:
        expected = steep(tile.west + east_index, tile.south + north_index)
        assert heights[east_index, north_index] == pytest.approx(expected, abs=0.03)


def test_landscape_placement_puts_the_tile_centre_at_the_world_origin(site, tmp_path):
    manifest = build(site, tmp_path / "out")
    tile = load_site(site).tile
    landscape, geo = manifest["landscape"], manifest["georeference"]

    assert landscape["location_cm"][:2] == [-6300.0, -6300.0]
    assert landscape["scale"][:2] == [100.0, 100.0]
    assert (geo["origin_easting_m"], geo["origin_northing_m"]) == tile.centre
    assert geo["origin_height_m"] == pytest.approx(h.plane(*tile.centre), abs=0.01)
    # The surface at the origin vertex decodes to world Z = 0.
    heights = decoded_heights(tmp_path / "out", manifest)
    assert heights[63, 63] - geo["origin_height_m"] == pytest.approx(0, abs=0.01)


def test_georeference_gives_the_origin_on_earth_and_where_true_north_is(site, tmp_path):
    geo = build(site, tmp_path / "out")["georeference"]

    # UTM zone 33 is centred on 15 E. About 60 km east of that at 45 N is roughly 15.76 E.
    assert geo["origin_latitude_deg"] == pytest.approx(45.15, abs=0.02)
    assert geo["origin_longitude_deg"] == pytest.approx(15.76, abs=0.02)
    # East of the central meridian, true north lies west of grid north by about (lon - 15) * sin(lat).
    assert geo["true_north_from_grid_north_deg"] == pytest.approx(-0.54, abs=0.05)


def test_relief_beyond_the_default_range_raises_the_z_scale(tmp_path):
    h.write_dem(tmp_path / "dem.tif", function=lambda e, n: 100.0 + 6.0 * (e - h.WEST) + 0 * n)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    manifest = build(h.write_site(tmp_path), tmp_path / "out")

    assert manifest["landscape"]["scale"][2] > frame.DEFAULT_Z_SCALE
    heights = decoded_heights(tmp_path / "out", manifest)
    tile_west = manifest["tile"]["west_m"]
    assert heights[126, 0] == pytest.approx(100.0 + 6.0 * (tile_west + 126 - h.WEST), abs=0.05)


def test_macro_colour_uses_the_same_layout_as_the_heightmap(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST + 63, split_northing=h.SOUTH + 63)
    out = tmp_path / "out"
    macro = macro_colour(out, build(h.write_site(tmp_path), out))

    west_rows, east_rows = macro[:100], macro[-100:]
    assert west_rows[..., 0].mean() > 150 and west_rows[..., 1].mean() < 50
    assert east_rows[..., 1].mean() > 150 and east_rows[..., 0].mean() < 50
    south_columns, north_columns = macro[:, :100], macro[:, -100:]
    assert south_columns[..., 2].mean() < 50 and north_columns[..., 2].mean() > 150


def test_macro_colour_is_low_passed_at_the_documented_scale(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    # A step in brightness alone: the same class on both sides, so the low-pass is all that acts on it.
    west, north = h.WEST - 60, h.SOUTH + h.SIZE_M + 60
    eastings = west + np.arange(246) + 0.5
    rgb = np.full((3, 246, 246), 100, dtype=np.uint8)
    rgb[0][:, eastings < h.WEST + 63] = 200
    h.write_raster(tmp_path / "imagery.tif", rgb, west, north, 1.0)
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path), out)
    red = (macro_colour(out, manifest)[:, 512, 0] - 100) / 100.0

    # A step blurred by a Gaussian of standard deviation s falls from 90% to 10% over 2.563 s.
    metres_per_pixel = manifest["tile"]["size_m"] / manifest["macro_colour"]["pixels"]
    width_m = (np.argmax(red < 0.1) - np.argmax(red < 0.9)) * metres_per_pixel
    assert width_m == pytest.approx(2.563 * MACRO_LOW_PASS_M, rel=0.1)


def test_detail_keeps_what_the_macro_colour_low_passes_away(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    # Stripes 2 m wide, brightness 100 and 140 in one class: far finer than the 12 m low-pass.
    west, north = h.WEST - 60, h.SOUTH + h.SIZE_M + 60
    eastings = west + np.arange(246) + 0.5
    rgb = np.full((3, 246, 246), 100, dtype=np.uint8)
    rgb[:, :, (eastings // 2).astype(int) % 2 == 0] = 140
    h.write_raster(tmp_path / "imagery.tif", rgb, west, north, 1.0)
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path), out)
    detail = manifest["detail"]
    encoded = np.asarray(Image.open(out / detail["file"])).astype(float)
    ratio = 2 ** ((encoded[..., 0] - detail["zero"]) / detail["zero"] * detail["log2_range"])
    macro = macro_colour(out, manifest)[..., 0].astype(float)

    row = ratio[:, 1024]
    assert detail["pixels"] == ratio.shape[0] == ratio.shape[1]
    assert row.max() / row.min() > 1.25
    assert row.mean() == pytest.approx(1.0, abs=0.05)
    assert macro[:, 512].max() - macro[:, 512].min() < 15


def test_grey_imagery_with_an_alpha_band_builds(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    grey = np.full((2, 250, 250), 120, dtype=np.uint8)
    h.write_raster(tmp_path / "imagery.tif", grey, h.WEST - 60, h.SOUTH + h.SIZE_M + 60, 1.0)
    out = tmp_path / "out"
    macro = macro_colour(out, build(h.write_site(tmp_path), out))

    assert macro.shape == (1024, 1024, 3) and abs(macro.mean() - 120) < 2


def test_dem_gaps_are_filled_and_reported(tmp_path):
    def holed(easting, northing):
        return np.where((easting > h.WEST + 50) & (easting < h.WEST + 60), np.nan, h.plane(easting, northing))

    h.write_dem(tmp_path / "dem.tif", function=holed)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    manifest = build(h.write_site(tmp_path), tmp_path / "out")

    assert manifest["landscape"]["filled_fraction"] == pytest.approx(10 / 127, abs=0.02)
    assert np.isfinite(decoded_heights(tmp_path / "out", manifest)).all()


def test_unchanged_inputs_reuse_stages_and_a_new_dem_reruns_only_elevation(site, tmp_path):
    out = tmp_path / "out"
    assert build(site, out)["stages_reused"] == []
    first = (out / "heightmap.png").read_bytes()
    assert build(site, out)["stages_reused"] == ["elevation", "surface", "macro_colour", "detail", "growth"]
    assert (out / "heightmap.png").read_bytes() == first

    h.write_dem(tmp_path / "dem.tif", function=lambda e, n: h.plane(e, n) + 5)
    assert build(site, out)["stages_reused"] == ["surface", "macro_colour", "detail", "growth"]
    lowest = h.plane(*load_site(site).tile.bounds()[:2]) + 5
    assert json.loads((out / "build.json").read_text())["landscape"]["min_m"] == pytest.approx(lowest, abs=0.01)


def test_new_imagery_reruns_the_classes_and_the_colour_stage(site, tmp_path):
    out = tmp_path / "out"
    build(site, out)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST + 20)

    assert build(site, out)["stages_reused"] == ["elevation"]


def test_image_service_window_is_fetched_once_and_assembled_in_place(tmp_path, monkeypatch):
    monkeypatch.setattr(acquire, "MAX_REQUEST_PIXELS", 100)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    site = h.write_site(tmp_path, sources=h.SERVICE_SOURCES)
    server = h.FakeImageServer()
    loaded = load_site(site)

    registry = acquire.acquire(loaded, tmp_path / "cache", fetch=server)
    assert server.requests == 4  # a 158 px window in parts of at most 100 px
    assert registry["elevation"]["bytes_fetched"] > 0

    again = acquire.acquire(loaded, tmp_path / "cache", fetch=server)
    assert server.requests == 4
    assert again["elevation"]["bytes_fetched"] == 0
    assert again["elevation"]["sha256"] == registry["elevation"]["sha256"]

    forbid_network(monkeypatch)
    manifest = build(site, tmp_path / "out", tmp_path / "cache")
    heights = decoded_heights(tmp_path / "out", manifest)
    tile = loaded.tile
    assert heights[100, 20] == pytest.approx(h.plane(tile.west + 100, tile.south + 20), abs=0.01)


def test_a_moved_boundary_fetches_its_new_window(tmp_path):
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    server = h.FakeImageServer()
    acquire.acquire(load_site(h.write_site(tmp_path, sources=h.SERVICE_SOURCES)), tmp_path / "cache", fetch=server)
    assert server.requests == 1

    moved = [[easting + 30, northing] for easting, northing in h.BOUNDARY]
    acquire.acquire(
        load_site(h.write_site(tmp_path, sources=h.SERVICE_SOURCES, boundary=moved)), tmp_path / "cache", fetch=server
    )
    assert server.requests == 2


def test_context_service_imagery_uses_colour_resolution_and_invalidates_its_cache(tmp_path, monkeypatch):
    sources = h.SERVICE_SOURCES | {
        "imagery": h.SERVICE_SOURCES["elevation"] | {"endpoint": "https://imagery.invalid/ImageServer"}
    }
    site = load_site(h.write_site(tmp_path, sources=sources, context={"size_m": 4032}))
    cache = tmp_path / "cache"
    server = h.FakeImageServer()
    first = acquire.acquire(site, cache, fetch=server)
    mesh_spacing = 8.0
    half_window = 4032 / 2 + mesh_spacing
    east, north = site.tile.centre

    assert first["context_elevation"]["request_spacing_m"] == mesh_spacing
    assert first["context_imagery"]["request_spacing_m"] == 4032 / CONTEXT_MACRO_PIXELS
    for name, spacing in (
        ("context_elevation", mesh_spacing),
        ("context_imagery", 4032 / CONTEXT_MACRO_PIXELS),
    ):
        with rasterio.open(first[name]["path"]) as raster:
            assert raster.res == (spacing, spacing)
            assert (raster.transform.c, raster.transform.f) == (east - half_window, north + half_window)
            assert raster.shape == (math.ceil(2 * half_window / spacing),) * 2

    requests = server.requests
    again = acquire.acquire(site, cache, fetch=server)
    assert server.requests == requests
    assert all(entry["bytes_fetched"] == 0 for entry in again.values())

    monkeypatch.setattr(acquire, "CONTEXT_MACRO_PIXELS", CONTEXT_MACRO_PIXELS // 2)
    changed = acquire.acquire(site, cache, fetch=server)
    assert changed["context_imagery"]["request_spacing_m"] == 4032 / (CONTEXT_MACRO_PIXELS // 2)
    assert changed["context_imagery"]["path"] != first["context_imagery"]["path"]
    assert changed["context_imagery"]["bytes_fetched"] > 0
    for name in ("elevation", "imagery", "context_elevation"):
        assert changed[name]["path"] == first[name]["path"]
        assert changed[name]["bytes_fetched"] == 0


def test_cells_outside_the_service_coverage_are_filled_not_used_as_heights(tmp_path, monkeypatch):
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    site = h.write_site(tmp_path, sources=h.SERVICE_SOURCES)
    tile = load_site(site).tile
    monkeypatch.setattr(acquire, "_fetch", h.FakeImageServer(coverage_east=tile.west + 100))
    manifest = build(site, tmp_path / "out")

    heights = decoded_heights(tmp_path / "out", manifest)
    assert manifest["landscape"]["filled_fraction"] == pytest.approx(26 / 127, abs=0.02)
    assert heights.min() > h.plane(tile.west, tile.south) - 0.5
    assert heights.max() < h.plane(tile.east, tile.north) + 0.5


def test_a_service_error_page_is_reported_not_cached(tmp_path, capsys, monkeypatch):
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    monkeypatch.setattr(
        acquire.urllib.request, "urlopen", lambda request, timeout: FakeResponse(b'{"error": {"code": 400}}')
    )
    out = tmp_path / "out"

    assert main(["build", str(h.write_site(tmp_path, sources=h.SERVICE_SOURCES)), "--out", str(out)]) == 1
    assert "did not return a TIFF" in capsys.readouterr().err
    assert not list((out / "cache").glob("*.tif"))


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.body


def test_cli_reports_a_missing_source_file_and_exits_nonzero(tmp_path, capsys):
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    assert main(["build", str(h.write_site(tmp_path)), "--out", str(tmp_path / "out")]) == 1
    assert "dem.tif does not exist" in capsys.readouterr().err


def test_cli_rejects_a_source_without_a_license(tmp_path, capsys):
    sources = {
        "elevation": {"kind": "file", "path": "dem.tif", "date": "2030"},
        "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030"},
    }
    assert main(["build", str(h.write_site(tmp_path, sources=sources)), "--out", str(tmp_path / "out")]) == 1
    assert "license is required" in capsys.readouterr().err


def test_the_gap_between_sunlit_and_shadowed_ground_is_found_and_one_peak_has_none():
    rng = np.random.default_rng(1)
    sunlit = rng.normal(-0.05, 0.2, 90000)
    shadow = rng.normal(-2.2, 0.35, 10000)
    gap = shadow_gap(np.concatenate([sunlit, shadow]))
    assert gap is not None and -1.7 < gap < -0.9
    assert shadow_gap(sunlit) is None
    assert shadow_gap(sunlit[:100]) is None
    # Black cells far under the floor are no peak of their own: the gap stays between the shadow and the sun.
    black = np.full(5000, -6.0)
    assert shadow_gap(np.concatenate([sunlit, shadow, black])) == pytest.approx(gap, abs=0.1)


def test_survey_masks_drive_surface_and_growth_with_alpha_fallback_and_cached_artifacts(tmp_path, monkeypatch):
    import importlib

    from .test_orthophoto import write_survey

    pipeline = importlib.import_module("envgen.build")
    # The real build runs on smaller output colour/growth grids; all raster fitting and warping still execute.
    monkeypatch.setattr(pipeline, "MACRO_PIXELS", 128)
    monkeypatch.setattr(pipeline, "DETAIL_PIXELS", 256)
    h.write_dem(tmp_path / "dem.tif")
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    site_path = h.write_site(tmp_path)
    tile = load_site(site_path).tile
    path, rgba = write_survey(tmp_path)
    rgba[3, 120:140, 200:220] = 102  # Interior: 40% survey paving, 60% old grass must retain turf.
    h.write_raster(path, rgba, tile.west, tile.north, 0.25)
    dtm = np.full((126, 126), 100, dtype=np.float32)
    for name in ("dtm", "dsm"):
        h.write_raster(tmp_path / f"{name}.tif", dtm, tile.west, tile.north, 1.0)
    spec = json.loads(site_path.read_text())
    spec["sources"]["survey"] = {"kind": "file", "path": "dsm.tif", "terrain": "dtm.tif",
                                 "orthophoto": "ortho.tif", "license": "test", "date": "2030"}
    site_path.write_text(json.dumps(spec))
    out = tmp_path / "out"
    manifest = build(site_path, out)
    report = manifest["orthophoto"]
    assert report["file"] == "ortho_masks.png" and report["colour"] == "ortho_colour.png"
    for name in ("ortho_masks.png", "ortho_masks.tif", "ortho_colour.png", "ortho_colour.tif",
                 "survey_detail.png", "survey_detail.tif"):
        assert name in manifest["artifacts"] and (out / name).is_file()
    weights = {layer["name"]: np.asarray(Image.open(out / layer["file"]))
               for layer in manifest["surface"]["layers"]}
    assert weights["grass"][15, 60] > 250
    assert weights["paved"][63, 60] > 250
    assert weights["soil"][100, 60] > 250
    assert weights["grass"][-2, 2] > 250  # alpha hole keeps the old grass, not survey soil
    fallback = np.asarray(Image.open(out / manifest["surface"]["fallback_weights"]))
    assert fallback[63, 60].tolist() == [255, 0, 0]
    assert int(weights["grass"][52, 94]) == pytest.approx(153, abs=2)
    assert int(weights["paved"][52, 94]) == pytest.approx(102, abs=2)
    density = np.asarray(Image.open(out / manifest["turf"]["growth"]["file"]))[..., 0]
    assert density[128, 128] == 0 and density[252, 3] > 0
    assert density[106, 190] > 0
    again = build(site_path, out)
    assert {"orthophoto", "surface", "growth", "survey_detail"} <= set(again["stages_reused"])
    (out / "ortho_colour.png").unlink()
    repaired = build(site_path, out)
    assert "orthophoto" not in repaired["stages_reused"] and "surface" in repaired["stages_reused"]
    # Newly covered pixels replace the old fallback: this changes mask bytes and all consumers of them.
    rgba[3, -20:, -20:] = 255
    h.write_raster(path, rgba, tile.west, tile.north, 0.25)
    changed = build(site_path, out)
    assert "orthophoto" not in changed["stages_reused"]
    assert "surface" not in changed["stages_reused"] and "growth" not in changed["stages_reused"]
    grass = np.asarray(Image.open(out / "surface_grass.png"))
    assert 0 < grass[-2, 2] < 255  # New evidence fades into the old grass at the footprint edge.


def test_raw_survey_colour_invalidates_growth_even_when_derived_maps_are_identical(tmp_path, monkeypatch):
    import importlib

    pipeline = importlib.import_module("envgen.build")
    monkeypatch.setattr(pipeline, "MACRO_PIXELS", 128)
    monkeypatch.setattr(pipeline, "DETAIL_PIXELS", 256)
    # Isolate raw-photo cache invalidation from changes in the derived colour transform.
    monkeypatch.setattr(pipeline, "clean_ortho_colour", lambda rgb, *_: (
        np.broadcast_to(np.array([80, 120, 40])[:, None, None], rgb.shape).copy(), {}
    ))
    h.write_dem(tmp_path / "dem.tif")
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST)
    site_path = h.write_site(tmp_path)
    tile = load_site(site_path).tile
    rgba = np.full((4, 504, 504), 255, dtype=np.uint8)
    rgba[:3] = np.array([80, 120, 40])[:, None, None]
    h.write_raster(tmp_path / "ortho.tif", rgba, tile.west, tile.north, .25)
    for name in ("dtm", "dsm"):
        h.write_raster(tmp_path / f"{name}.tif", np.full((126, 126), 100, dtype=np.float32),
                       tile.west, tile.north, 1)
    spec = json.loads(site_path.read_text())
    spec["sources"]["survey"] = {"kind": "file", "path": "dsm.tif", "terrain": "dtm.tif",
                                 "orthophoto": "ortho.tif", "license": "test", "date": "2030"}
    site_path.write_text(json.dumps(spec))
    out = tmp_path / "out"
    before = build(site_path, out)
    old_growth = np.asarray(Image.open(out / before["turf"]["growth"]["file"])).copy()
    rgba[1] = 120 + np.random.default_rng(123).choice([-1, 1], (504, 504))
    h.write_raster(tmp_path / "ortho.tif", rgba, tile.west, tile.north, .25)
    after = build(site_path, out)
    for name in ("ortho_masks.png", "ortho_masks.tif", "ortho_colour.png", "ortho_colour.tif"):
        assert before["artifacts"][name] == after["artifacts"][name]
    assert "growth" not in after["stages_reused"]
    assert not np.array_equal(old_growth, np.asarray(Image.open(out / after["turf"]["growth"]["file"])))
