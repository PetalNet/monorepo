"""What lidar adds: ground colour without trees in it, smoothing where the ground was not measured, and the surround."""

import importlib

import numpy as np
import pytest
from PIL import Image

from envgen import frame, lidar, surface
from envgen.acquire import sha256_file
from envgen.build import CONTEXT_SINK_M, build, build_context
from envgen.cli import main
from envgen.site import load_site

from . import helpers as h

LIDAR = {"lidar": {"kind": "file", "path": "points.las", "license": "test", "date": "2030"}}
FILES = {
    "elevation": {"kind": "file", "path": "dem.tif", "license": "test", "date": "2030"},
    # The day fixes the sun's path: at this latitude it stands 45 degrees up at noon on the equinox.
    "imagery": {"kind": "file", "path": "imagery.tif", "license": "test", "date": "2030-09-22"},
}
# A 20 m square of tree canopy in the middle of the tile.
TREE_WEST, TREE_SOUTH, TREE_SIDE = h.WEST + 53, h.SOUTH + 53, 20


def detailed_heights(out, manifest):
    landscape = manifest["landscape"]
    mid_m = manifest["georeference"]["origin_height_m"] + landscape["location_cm"][2] / 100
    return frame.decode_heights(np.asarray(Image.open(out / landscape["heightmap"])), mid_m, landscape["scale"][2])


def write_imagery_with_dark_tree(path):
    """Uniform light ground with a dark square where the tree stands, and its noon shadow 9 m to the north."""
    west, north = h.WEST - 60, h.SOUTH + h.SIZE_M + 60
    count = int(h.SIZE_M + 120)
    eastings = west + np.arange(count) + 0.5
    northings = north - np.arange(count) - 0.5
    rgb = np.full((3, count, count), 180, dtype=np.uint8)
    dark_e = (eastings >= TREE_WEST) & (eastings < TREE_WEST + TREE_SIDE)
    dark_n = (northings >= TREE_SOUTH) & (northings < TREE_SOUTH + TREE_SIDE + 9)
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
    assert masked["cover"]["covered_fraction"] == pytest.approx(TREE_SIDE**2 / h.SIZE_M**2, rel=0.05)
    assert 1 - masked["cover"]["sunlit_fraction"] == pytest.approx(TREE_SIDE * (TREE_SIDE + 9) / h.SIZE_M**2, rel=0.1)
    assert "cover" not in plain


def test_low_vegetation_is_still_ground_colour(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    write_imagery_with_dark_tree(tmp_path / "imagery.tif")
    h.write_las(
        tmp_path / "points.las", np.vstack([h.ground_returns(), h.returns_above(TREE_WEST, TREE_SOUTH, TREE_SIDE, 1.0)])
    )
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=FILES | LIDAR), out)

    assert manifest["cover"]["covered_fraction"] == 0
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


def test_surround_passes_under_the_tile_and_follows_the_ground_outside_it(tmp_path, monkeypatch):
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
    assert context["geometry_colour"] in manifest["artifacts"]
    assert manifest["artifacts"][context["geometry_colour"]] == sha256_file(out / context["geometry_colour"])
    assert build(site, out)["stages_reused"] == [
        "elevation", "surface", "macro_colour", "detail", "growth", "context", "context_geometry"
    ]
    monkeypatch.setattr(importlib.import_module("envgen.build"), "CONTEXT_LOW_PASS_M", 6.0)
    changed = build(site, out)
    assert changed["stages_reused"] == ["elevation", "surface", "macro_colour", "detail", "growth", "context_geometry"]
    assert changed["artifacts"][context["geometry"]["file"]] == manifest["artifacts"][context["geometry"]["file"]]
    assert changed["artifacts"][context["colour"]] != manifest["artifacts"][context["colour"]]


@pytest.mark.parametrize("calibrated", [False, True])
def test_surround_keeps_source_corridors_calibration_and_nodata_filling(tmp_path, calibrated):
    site = load_site(h.write_site(tmp_path, context={"size_m": 2016}))
    west, north = site.tile.centre[0] - 1008, site.tile.centre[1] + 1008
    dem, imagery = tmp_path / "dem.tif", tmp_path / "imagery.tif"
    h.write_raster(dem, np.full((1008, 1008), 100, dtype=np.float32), west, north, 2)
    rgb = np.full((3, 1008, 1008), 180, dtype=np.uint8)
    rgb[:, :504] = np.array(h.GRASS)[:, None, None]
    rgb[:, 504:, 247:257] = 80  # A 20 m corridor, with no geometry inferred from it.
    rgb[:, 700:710, 700:710] = 0
    rgb[:, 850:854, 850:854] = 80
    h.write_raster(imagery, rgb, west, north, 2, nodata=0)
    curves = {
        name: {"gain": [gain] * 3, "gamma": [1] * 3, "range": [[0, 1]] * 3}
        for name, gain in (("grass", 0.8), ("paved", 0.5))
    }
    classes = {
        "layers": [{"name": "grass"}, {"name": "paved"}],
        "splits": [{"split": True, "index": "green", "threshold": 0.1}],
        "albedo": {"curves": curves},
    }
    result = build_context(
        site, dem, imagery, None, None, tmp_path, np.full((127, 127), 100), 100,
        classes if calibrated else None,
    )
    north_up = np.swapaxes(np.asarray(Image.open(tmp_path / result["colour"])), 0, 1)[::-1]

    def at(source_row, source_column):
        row, column = (int((index + 0.5) / 1008 * north_up.shape[0]) for index in (source_row, source_column))
        return north_up[row, column].astype(float)

    def expected(colour, name):
        value = np.array(colour, dtype=np.float32)[:, None, None]
        if calibrated:
            value = surface.to_encoded(surface.apply_curve(value, curves[name]))
        return value[:, 0, 0]

    assert at(750, 252) == pytest.approx(expected((80, 80, 80), "paved"), abs=8)
    assert at(750, 350) == pytest.approx(expected((180, 180, 180), "paved"), abs=2)
    assert at(705, 705) == pytest.approx(expected((180, 180, 180), "paved"), abs=2)
    assert at(250, 350) == pytest.approx(expected(h.GRASS, "grass"), abs=2)
    geometry = np.swapaxes(np.asarray(Image.open(tmp_path / result["geometry_colour"])), 0, 1)[::-1]
    row = int(851.5 / 1008 * geometry.shape[0])
    column = int(851.5 / 1008 * geometry.shape[1])
    assert geometry[row, column] == pytest.approx(expected((80, 80, 80), "paved"), abs=2)
    assert np.linalg.norm(north_up[row, column].astype(float) - geometry[row, column]) > 5
    assert result["geometry_colour"] in result["files"]


def test_surround_must_be_larger_than_the_tile(tmp_path, capsys):
    site = h.write_site(tmp_path, sources=FILES, context={"size_m": 100})
    assert main(["build", str(site), "--out", str(tmp_path / "out")]) == 1
    assert "larger than the tile" in capsys.readouterr().err


def test_a_new_elevation_model_with_lidar_reruns_the_colour_map_too(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    write_imagery_with_dark_tree(tmp_path / "imagery.tif")
    h.write_las(
        tmp_path / "points.las", np.vstack([h.ground_returns(), h.returns_above(TREE_WEST, TREE_SOUTH, TREE_SIDE, 9.0)])
    )
    site = h.write_site(tmp_path, sources=FILES | LIDAR)
    out = tmp_path / "out"
    build(site, out)

    # Raise the ground by 8 m: the canopy is now only 1 m above it, so it stops counting as cover.
    h.write_dem(tmp_path / "dem.tif", function=lambda e, n: h.plane(e, n) + 8)
    manifest = build(site, out)

    assert manifest["stages_reused"] == []
    assert manifest["cover"]["covered_fraction"] == 0


def ridge(easting, northing):
    """plane() with a 6 m ridge running north through the tile, 10 m wide."""
    return h.plane(easting, northing) + 6.0 * np.exp(-(((easting - h.WEST - 63) / 5.0) ** 2))


def test_coarse_surround_stays_under_a_ridge_and_meets_the_ground_beyond_the_tile(tmp_path):
    h.write_dem(tmp_path / "dem.tif", function=ridge, spacing=1.0, margin=1000.0)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST + 63)
    out = tmp_path / "out"
    site = h.write_site(
        tmp_path, sources=FILES, context={"size_m": 2016}
    )  # 4 m between surround vertices, 1 m in the tile
    manifest = build(site, out)
    tile = load_site(site).tile
    context, geo = manifest["context"], manifest["georeference"]
    mid_m = geo["origin_height_m"] + context["location_cm"][2] / 100
    surround = frame.decode_heights(np.asarray(Image.open(out / context["heightmap"])), mid_m, context["scale"][2])
    west, south = tile.centre[0] - 1008, tile.centre[1] - 1008

    # The surround interpolated bilinearly between its vertices, at every detailed vertex of the tile. The engine
    # draws triangles, which stay within the same four corner heights.
    from scipy import ndimage

    east_index, north_index = np.meshgrid(
        (tile.west + np.arange(127) - west) / 4, (tile.south + np.arange(127) - south) / 4, indexing="ij"
    )
    drawn = ndimage.map_coordinates(surround, [east_index, north_index], order=1)
    assert (detailed_heights(out, manifest) - drawn).min() >= CONTEXT_SINK_M - 0.05

    # Two surround cells beyond the tile edge it is the real ground again, ridge included.
    beyond_east = round((tile.east + 8 - west) / 4)
    on_ridge_north_of_tile = (round((h.WEST + 63 - west) / 4), round((tile.north + 8 - south) / 4))
    assert surround[beyond_east, 252] == pytest.approx(ridge(west + beyond_east * 4, south + 252 * 4), abs=0.1)
    assert surround[on_ridge_north_of_tile] == pytest.approx(
        ridge(h.WEST + 63, south + on_ridge_north_of_tile[1] * 4), abs=0.6
    )
    assert surround[on_ridge_north_of_tile] > h.plane(h.WEST + 63, tile.north + 8) + 4


class FakePointStore:
    """A one-node EPT store holding `points` (site CRS), served from memory. Counts requests."""

    def __init__(self, points):
        import io

        import laspy
        from rasterio.warp import transform

        xs, ys = transform(h.CRS, "EPSG:3857", points[:, 0].tolist(), points[:, 1].tolist())
        header = laspy.LasHeader(point_format=3, version="1.2")
        header.offsets = [min(xs), min(ys), 0.0]
        header.scales = [0.001, 0.001, 0.001]
        las = laspy.LasData(header)
        las.x, las.y, las.z = np.array(xs), np.array(ys), points[:, 2]
        las.classification = points[:, 3].astype(np.uint8)
        buffer = io.BytesIO()
        las.write(buffer, do_compress=True)
        self.node = buffer.getvalue()
        self.bounds = [min(xs) - 500, min(ys) - 500, -500, min(xs) + 1500, min(ys) + 1500, 1500]
        self.requests = 0

    def __call__(self, url):
        import json

        self.requests += 1
        if url.endswith("/ept.json"):
            return json.dumps({"bounds": self.bounds, "srs": {"horizontal": "3857"}}).encode()
        if url.endswith("/ept-hierarchy/0-0-0-0.json"):
            return json.dumps({"0-0-0-0": 1000}).encode()
        assert url.endswith("/ept-data/0-0-0-0.laz"), url
        return self.node


def test_a_point_store_is_read_once_and_then_the_build_works_offline(tmp_path):
    from envgen.site import Source

    points = np.vstack([h.ground_returns(), h.returns_above(TREE_WEST, TREE_SOUTH, TREE_SIDE, 9.0)])
    store = FakePointStore(points)
    source = Source("ept", "https://points.invalid/store", "test", "2030")
    tile = load_site(h.write_site(tmp_path, sources=FILES)).tile

    first = lidar.identify(source, tile, h.CRS, tmp_path / "cache", get=store)
    assert store.requests == 3 and first["bytes_fetched"] == len(store.node)
    inside = (
        (points[:, 0] >= tile.west)
        & (points[:, 0] < tile.east)
        & (points[:, 1] >= tile.south)
        & (points[:, 1] < tile.north)
    )
    assert first["points"] == inside.sum()

    def offline(url):
        raise AssertionError(f"unexpected request to {url}")

    again = lidar.identify(source, tile, h.CRS, tmp_path / "cache", get=offline)
    assert again["sha256"] == first["sha256"] and again["bytes_fetched"] == 0
    kept = lidar.load_points(source, tile, h.CRS, tmp_path / "cache", get=offline)
    # The round trip through the store's CRS moves a point by well under a centimetre.
    order = np.lexsort((kept[:, 1].round(1), kept[:, 0].round(1)))
    expected = points[inside][np.lexsort((points[inside][:, 1], points[inside][:, 0]))]
    assert np.abs(kept[order][:, :3] - expected[:, :3]).max() < 0.01


def test_a_point_store_in_another_crs_is_refused(tmp_path):
    import json

    from envgen.site import Source

    tile = load_site(h.write_site(tmp_path, sources=FILES)).tile
    get = lambda url: json.dumps({"bounds": [0, 0, 0, 1, 1, 1], "srs": {"horizontal": "26915"}}).encode()
    with pytest.raises(RuntimeError, match="only EPSG:3857"):
        lidar.identify(
            Source("ept", "https://points.invalid/store", "test", "2030"), tile, h.CRS, tmp_path / "cache", get=get
        )
