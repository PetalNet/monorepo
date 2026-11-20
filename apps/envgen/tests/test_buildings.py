"""Buildings as massing: footprints from a map, heights from lidar then tags, roof colour from the photo."""

import json

import numpy as np
import pytest
import shapely
from PIL import Image
from pyproj import Transformer
from shapely.geometry import Polygon

from envgen import architecture, buildings, cli, roof_survey, surface
from envgen.build import build
from envgen.site import SiteError, Tile, load_site

from . import helpers as h
from .test_cover import GROUND, LIDAR, sources

PINK = (200, 120, 130)
# west, south, east, north in metres from the tile's south-west corner
ROOF = (30, 60, 50, 80)  # off the east = north diagonal, so a swapped axis shows
TILE = Tile(h.WEST, h.SOUTH, 1.0, 126)


def geojson(path, features):
    """Footprints given in metres from the tile's south-west corner, written as WGS84 GeoJSON."""
    to_wgs = Transformer.from_crs(h.CRS, "EPSG:4326", always_xy=True).transform
    collection = []
    for ring, tags in features:
        points = [to_wgs(h.WEST + east, h.SOUTH + north) for east, north in ring]
        collection.append(
            {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [points]}, "properties": tags}
        )
    path.write_text(json.dumps({"type": "FeatureCollection", "features": collection}))


def square(west, south, east, north):
    return [(west, south), (east, south), (east, north), (west, north), (west, south)]


def moved(box):
    """A footprint given in metres from the tile's south-west corner, in the site's CRS."""
    return shapely.affinity.translate(Polygon(square(*box)), h.WEST, h.SOUTH)


def footprint(*coordinates):
    return {"polygon": shapely.geometry.Polygon(coordinates), "tags": {}}


def test_a_roof_is_triangulated_to_exactly_its_own_area_with_holes_and_corners_kept():
    el = Polygon([(0, 0), (10, 0), (10, 4), (4, 4), (4, 10), (0, 10)])
    courtyard = Polygon(square(0, 0, 20, 20), [square(5, 5, 15, 15)[::-1]])
    for polygon in (el, courtyard):
        rings, triangles = buildings.triangulate(polygon)
        points = [point for ring in rings for point in ring]
        area = sum(abs(shapely.Polygon([points[i] for i in triangle]).area) for triangle in triangles)
        assert area == pytest.approx(polygon.area)
    assert len(rings) == 2


def test_height_is_lidar_then_tag_then_floors_then_what_the_lidar_measured_elsewhere():
    cells = round(TILE.size_m)
    lidar = np.zeros((cells, cells), dtype=np.float32)
    lidar[(cells - 80) : (cells - 60), 30:50] = 6.0  # the lidar sees one roof, 6 m high, at ROOF
    photo = np.full((3, cells, cells), 100.0)
    named = [
        (ROOF, {"height_m": 12.0}),  # the lidar wins over its own tag
        ((10, 10, 20, 20), {"height_m": 9.0, "dataset": "tagged"}),
        ((70, 10, 80, 20), {"num_floors": 3}),
        ((10, 70, 20, 80), {}),
    ]
    items = [{"polygon": moved(box), "tags": tags} for box, tags in named]
    records = buildings.measure(items, TILE, 1.0, lidar, photo, None, 1.0)

    heights = [(record["height_m"], record["height_from"].split(":")[0]) for record in records]
    assert sorted(heights, key=lambda item: item[0]) == [
        (6.0, "lidar"),
        (6.0, "measured"),
        (9.0, "tag"),
        (9.0, "prior"),
    ]


def test_a_roof_the_lidar_does_not_see_takes_no_height_from_the_ground_it_stands_on():
    cells = round(TILE.size_m)
    flat = np.zeros((cells, cells), dtype=np.float32)
    item = {"polygon": moved(ROOF), "tags": {}}
    record = buildings.measure([item], TILE, 1.0, flat, np.full((3, cells, cells), 100.0), None, 1.0)[0]
    assert record["height_from"].startswith("prior") and record["height_m"] == 2 * buildings.FLOOR_M


def test_a_roof_has_the_colour_of_the_photo_over_it_as_albedo_by_the_curve():
    cells = round(TILE.size_m)
    photo = np.full((3, cells, cells), 50.0)
    photo[:, (cells - 80) : (cells - 60), 30:50] = np.array(PINK)[:, None, None]
    item = {"polygon": moved(ROOF), "tags": {"height_m": 5}}
    curve = {"gain": [1, 1, 1], "gamma": [1, 1, 1], "range": [[0, 1]] * 3}
    plain = buildings.measure([item], TILE, 1.0, None, photo, curve, 1.0)[0]["roof_albedo"]
    halved = buildings.measure([item], TILE, 1.0, None, photo, {**curve, "gain": [0.5] * 3}, 1.0)[0]["roof_albedo"]
    assert plain[0] > plain[2] and plain[0] == pytest.approx(
        float(surface.to_linear(np.array(PINK[0], dtype=float))), rel=1e-3
    )
    assert halved == pytest.approx([value / 2 for value in plain], rel=1e-3)


def test_the_ground_under_a_roof_takes_the_class_of_the_ground_beside_it():
    labels = np.zeros((20, 20), dtype=np.uint8)
    labels[:, 10:] = 1
    covered = np.zeros((20, 20), dtype=bool)
    covered[8:12, 6:14] = True
    labels[covered] = 2  # the roof's own colour read as a third class
    result = buildings.label_under(labels, covered)
    assert set(np.unique(result[covered])) == {0, 1} and (result[~covered] == labels[~covered]).all()


def test_mask_marks_the_cells_a_footprint_touches():
    covered = buildings.mask([footprint(*square(40.5, 40.5, 60.5, 60.5)) for _ in range(1)], Tile(0, 0, 1.0, 126), 1.0)
    assert covered[126 - 61 : 126 - 40, 40:61].all() and covered.sum() == 21 * 21


def build_with_roof(tmp_path, roof_in_lidar, with_footprint=True, **tags):
    tmp_path.mkdir(parents=True, exist_ok=True)
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND, [(*ROOF, PINK)])
    points = h.ground_returns()
    if roof_in_lidar:
        points = np.vstack([points, h.returns_above(h.WEST + ROOF[0], h.SOUTH + ROOF[1], 20, 6.0)])
    h.write_las(tmp_path / "points.las", points)
    extra = {}
    if with_footprint:
        geojson(tmp_path / "buildings.geojson", [(square(*ROOF), tags)])
        extra = {"buildings": {"kind": "file", "path": "buildings.geojson"}}
    out = tmp_path / "out"
    manifest = build(h.write_site(tmp_path, sources=sources(**LIDAR, **extra)), out)
    return out, manifest


def macro_at(out, manifest, east_m, north_m):
    macro = np.asarray(Image.open(out / manifest["macro_colour"]["file"])).astype(int)
    scale = manifest["macro_colour"]["pixels"] / manifest["tile"]["size_m"]
    return macro[int(east_m * scale), int(north_m * scale)]


def test_a_roof_the_lidar_never_saw_is_still_taken_out_of_the_ground(tmp_path):
    out, manifest = build_with_roof(tmp_path / "with", roof_in_lidar=False, height_m=7.0, dataset="map")
    plain, unmasked = build_with_roof(tmp_path / "without", roof_in_lidar=False, with_footprint=False)

    assert abs(macro_at(plain, unmasked, 40, 70) - GROUND).max() > 20  # the control: the roof tints the ground
    assert macro_at(out, manifest, 40, 70) == pytest.approx(GROUND, abs=3)
    assert manifest["cover"]["roof_cells_read_as_ground_before"] > 300
    record = json.loads((out / "buildings.json").read_text())["buildings"][0]
    assert record["height_m"] == 7.0 and record["height_from"].startswith("tag")
    # metres from the tile's centre: ROOF's middle is 40 east and 70 north of the south-west corner, of 126 m
    assert (record["east_m"], record["north_m"]) == pytest.approx((40 - 63, 70 - 63), abs=0.5)
    assert max(point[0] for point in record["rings"][0]) == pytest.approx(50 - 63, abs=0.01)
    assert max(point[1] for point in record["rings"][0]) == pytest.approx(80 - 63, abs=0.01)
    assert record["roof_albedo"][0] > record["roof_albedo"][2]
    assert manifest["buildings"]["count"] == 1 and manifest["buildings"]["height_from"] == {"tag": 1}


def test_a_roof_the_lidar_saw_takes_its_height_from_it_and_a_rerun_reuses_the_stage_until_an_input_changes(tmp_path):
    out, _ = build_with_roof(tmp_path, roof_in_lidar=True, height_m=12.0)
    record = json.loads((out / "buildings.json").read_text())["buildings"][0]
    assert record["height_m"] == pytest.approx(6.0, abs=0.01) and record["height_from"].startswith("lidar")
    assert "buildings" in build(tmp_path / "site.json", out)["stages_reused"]
    # A new elevation model changes every height above ground, so the stage runs again.
    h.write_dem(tmp_path / "dem.tif", function=lambda e, n: h.plane(e, n) + 1.0)
    assert "buildings" not in build(tmp_path / "site.json", out)["stages_reused"]


def test_buildings_must_come_from_a_file(tmp_path):
    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", GROUND)
    bad = {"buildings": {"kind": "cog", "url": "x"}}
    with pytest.raises(SiteError, match="sources.buildings: kind must be 'file'"):
        load_site(h.write_site(tmp_path, sources=sources(**LIDAR, **bad)))


def test_an_architecture_change_rebuilds_only_buildings(tmp_path, monkeypatch):
    out, _ = build_with_roof(tmp_path, roof_in_lidar=True)
    reused = build(tmp_path / "site.json", out)["stages_reused"]
    monkeypatch.setattr(architecture, "VERSION", architecture.VERSION + 1)
    changed = build(tmp_path / "site.json", out)
    assert "buildings" not in changed["stages_reused"]
    assert set(changed["stages_reused"]) == set(reused) - {"buildings"}


def test_a_roof_survey_change_rebuilds_only_buildings(tmp_path, monkeypatch):
    out, _ = build_with_roof(tmp_path, roof_in_lidar=True)
    reused = build(tmp_path / "site.json", out)["stages_reused"]
    monkeypatch.setattr(roof_survey, "VERSION", roof_survey.VERSION + 1)
    changed = build(tmp_path / "site.json", out)
    assert "buildings" not in changed["stages_reused"]
    assert set(changed["stages_reused"]) == set(reused) - {"buildings"}


def test_cli_build_with_roof_imagery_and_reference_records_local_fetches(tmp_path):
    out, _ = build_with_roof(tmp_path, roof_in_lidar=True)
    h.write_raster(
        tmp_path / "roof-reference.tif", np.full((3, 544, 544), 180, dtype=np.uint8), h.WEST - 5, h.SOUTH + 131, 0.25
    )
    (tmp_path / "roof-observations.json").write_text(json.dumps({"buildings": {}}))
    path = tmp_path / "site.json"
    site = json.loads(path.read_text())
    for name, filename in [
        ("building_imagery", "roof-reference.tif"),
        ("building_reference", "roof-observations.json"),
    ]:
        site["sources"][name] = {"kind": "file", "path": filename, "date": "2024", "license": "test fixture"}
    path.write_text(json.dumps(site))
    assert cli.main(["build", str(path), "--out", str(out)]) == 0
    result = json.loads((out / "build.json").read_text())
    assert result["sources"]["building_imagery"]["bytes_fetched"] == 0
    assert result["sources"]["building_reference"]["bytes_fetched"] == 0
    assert len(json.loads((out / "building_accuracy.json").read_text())["buildings"]) == 1
    reused = build(path, out)["stages_reused"]
    site["sources"]["building_imagery"]["date"] = "2025"
    path.write_text(json.dumps(site))
    corrected = build(path, out)
    records = json.loads((out / "buildings.json").read_text())["buildings"]
    assert records[0]["imagery_observation"]["image_date"] == "2025"
    assert set(corrected["stages_reused"]) == set(reused) - {"buildings"}


def test_buildings_without_lidar_or_canopy_are_refused_because_nothing_would_hide_their_roofs(tmp_path):
    good = {"buildings": {"kind": "file", "path": "b.geojson"}}
    with pytest.raises(SiteError, match="needs sources.lidar or sources.canopy_height"):
        load_site(h.write_site(tmp_path, sources=sources(**good)))


def test_footprints_off_the_tile_are_left_out(tmp_path):
    geojson(tmp_path / "b.geojson", [(square(10, 10, 20, 20), {}), (square(500, 500, 520, 520), {})])
    found = buildings.load_footprints(tmp_path / "b.geojson", h.CRS, TILE)
    assert len(found) == 1 and found[0]["polygon"].area == pytest.approx(100, rel=1e-3)


def test_a_footprint_over_the_tiles_edge_is_cut_there(tmp_path):
    geojson(tmp_path / "b.geojson", [(square(-10, 10, 10, 30), {})])
    (found,) = buildings.load_footprints(tmp_path / "b.geojson", h.CRS, TILE)
    assert found["polygon"].area == pytest.approx(200, rel=1e-3)
    assert found["polygon"].bounds[0] == pytest.approx(h.WEST, abs=1e-3)


def test_a_crown_with_its_top_in_a_footprint_is_no_tree_and_one_beside_it_stays():
    footprints = [{"polygon": moved(ROOF), "tags": {}}]
    cells = round(TILE.size_m)
    row = cells - 70
    inside = {"row": row, "column": 40}
    over_a_tag_only_roof = {"row": row, "column": 33}
    on_the_edge = {"row": row, "column": 30}  # the footprint's outermost cell
    beside = {"row": row, "column": 10}
    flags = buildings.crowns_in_footprints([inside, over_a_tag_only_roof, on_the_edge, beside], footprints, TILE, 1.0)
    assert flags == [True, True, True, False]


def test_measure_pairs_stands_tagged_as_buildings_and_keeps_generic_buildings_untyped():
    items = [
        {"polygon": moved((10, 10, 20, 90)), "tags": {"building": "grandstand"}},
        {"polygon": moved((100, 10, 110, 90)), "tags": {"class": "yes", "building": "grandstand"}},
        {"polygon": moved((40, 100, 50, 110)), "tags": {"building": "yes"}},
    ]
    photo = np.full((3, 126, 126), 100.0)
    west, east, generic = buildings.measure(items, TILE, 1.0, None, photo, None, 1.0)
    for stand, other in ((west, east), (east, west)):
        style = stand["architecture"]
        assert style["role"] == "grandstand" and style["roof_shape"] == "stepped"
        assert style["orientation_from"].startswith("inferred:")
        along = np.array(style["along"])
        outward = np.array([-along[1], along[0]])
        assert np.dot(outward, np.array(style["centre_m"]) - [other["east_m"], other["north_m"]]) > 0
    assert generic["architecture"]["role"] == "residential"
    assert generic["architecture"]["role_from"].startswith("prior:")
