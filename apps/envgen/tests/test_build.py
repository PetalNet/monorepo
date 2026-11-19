import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from envgen import acquire, frame
from envgen.build import MACRO_LOW_PASS_M, build
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


def test_macro_colour_is_low_passed_at_the_documented_scale(site, tmp_path):
    out = tmp_path / "out"
    manifest = build(site, out)
    red = macro_colour(out, manifest)[:, 512, 0] / 200.0

    # A step blurred by a Gaussian of standard deviation s falls from 90% to 10% over 2.563 s.
    metres_per_pixel = manifest["tile"]["size_m"] / manifest["macro_colour"]["pixels"]
    width_m = (np.argmax(red < 0.1) - np.argmax(red < 0.9)) * metres_per_pixel
    assert width_m == pytest.approx(2.563 * MACRO_LOW_PASS_M, rel=0.1)


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
    assert build(site, out)["stages_reused"] == ["elevation", "macro_colour"]
    assert (out / "heightmap.png").read_bytes() == first

    h.write_dem(tmp_path / "dem.tif", function=lambda e, n: h.plane(e, n) + 5)
    assert build(site, out)["stages_reused"] == ["macro_colour"]
    lowest = h.plane(*load_site(site).tile.bounds()[:2]) + 5
    assert json.loads((out / "build.json").read_text())["landscape"]["min_m"] == pytest.approx(lowest, abs=0.01)


def test_new_imagery_reruns_only_the_colour_stage(site, tmp_path):
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
