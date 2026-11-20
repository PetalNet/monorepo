"""Roof geometry must preserve measured footprints, holes, colours and lidar heights."""

import json

import numpy as np
import pytest
from shapely.geometry import Polygon

from envgen import architecture


def record(polygon, height=6, colour=(0.12, 0.11, 0.10)):
    return {
        "rings": [list(polygon.exterior.coords)[:-1], *[list(h.coords)[:-1] for h in polygon.interiors]],
        "area_m2": polygon.area,
        "height_m": height,
        "roof_albedo": list(colour),
    }


def roof_area(style):
    points = style["roof_vertices"]
    return sum(Polygon([points[i][:2] for i in t]).area for t in style["roof_triangles"])


def test_a_rotated_house_roof_covers_exactly_the_footprint_with_a_ridge_and_two_eaves():
    import shapely.affinity

    polygon = shapely.affinity.rotate(Polygon([(0, 0), (18, 0), (18, 10), (0, 10)]), 27)
    measured = record(polygon)
    style = architecture.describe(measured, {"class": "house"})
    assert style["roof_shape"] == "gabled"
    assert style["width_m"] == pytest.approx(10)
    assert roof_area(style) == pytest.approx(polygon.area)
    heights = np.array(style["roof_vertices"])[:, 2]
    assert heights.min() == pytest.approx(-0.95)
    assert heights.max() == pytest.approx(0.95)
    assert measured["height_m"] == 6 and measured["roof_albedo"] == [0.12, 0.11, 0.10]


@pytest.mark.parametrize(
    "polygon",
    [
        Polygon([(0, 0), (20, 0), (20, 8), (8, 8), (8, 20), (0, 20)]),
        Polygon([(0, 0), (20, 0), (20, 20), (0, 20)], [[(5, 5), (15, 5), (15, 15), (5, 15)]]),
    ],
)
def test_irregular_or_courtyard_houses_keep_their_measured_roof_triangulation(polygon):
    style = architecture.describe(record(polygon), {"class": "house"})
    assert style["roof_shape"] == "flat" and not style["roof_triangles"]


def test_a_tagged_flat_roof_stays_flat_and_institutional_facades_are_labeled_as_priors():
    polygon = Polygon([(0, 0), (18, 0), (18, 10), (0, 10)])
    style = architecture.describe(record(polygon), {"class": "house", "roof:shape": "flat"})
    assert style["roof_shape"] == "flat" and style["roof_shape_from"] == "tag: flat"
    school = architecture.describe(record(polygon), {"class": "school"})
    assert school["role"] == "institution" and school["role_from"] == "tag: school"
    assert school["parapet_m"] > 0 and school["detail_from"].startswith("prior:")


def test_a_chamfered_grandstand_has_clipped_treads_and_connected_risers():
    polygon = Polygon([(0, 0), (80, 0), (80, 7), (70, 15), (0, 15)])
    assert 0.96 < polygon.area / polygon.minimum_rotated_rectangle.area < 0.99
    style = architecture.describe(record(polygon, height=4), {"class": "grandstand"})
    assert style["roof_shape"] == "stepped" and style["stand_rows"] > 10
    assert roof_area(style) == pytest.approx(polygon.area)
    treads, risers = [], []
    for triangle in style["roof_triangles"]:
        points = [style["roof_vertices"][i] for i in triangle]
        (risers if Polygon([p[:2] for p in points]).area < 1e-9 else treads).append(points)
    assert treads and risers
    levels = {round(points[0][2], 8) for points in treads}
    for points in treads:
        assert len({p[2] for p in points}) == 1
    for points in risers:
        low, high = min(p[2] for p in points), max(p[2] for p in points)
        assert high - low == pytest.approx(style["stand_step_m"])
        assert round(low, 8) in levels and round(high, 8) in levels
        assert polygon.buffer(1e-8).covers(Polygon([p[:2] for p in points]).convex_hull)
    assert max(p[2] for p in style["roof_vertices"]) == pytest.approx(4)


def test_generic_building_tags_are_untyped():
    polygon = Polygon([(0, 0), (18, 0), (18, 10), (0, 10)])
    for tags in ({"building": "yes"}, {"class": "building"}, {"class": "yes", "building": "house"}):
        style = architecture.describe(record(polygon), tags)
        assert style["role"] == "residential"
    assert architecture.building_kind({"class": "yes", "building": "grandstand"}) == "grandstand"


def test_roof_shape_sources_match_actual_geometry():
    narrow = Polygon([(0, 0), (10, 0), (10, 2), (0, 2)])
    irregular = Polygon([(0, 0), (20, 0), (20, 8), (8, 8), (8, 20), (0, 20)])
    for polygon in (narrow, irregular):
        style = architecture.describe(record(polygon), {"class": "grandstand", "roof:shape": "gabled"})
        assert style["roof_shape"] == "flat" and style["roof_shape_from"].startswith("prior:")
        assert style["stand_rows"] == 0
    style = architecture.describe(record(irregular), {"roof:shape": "flat"})
    assert style["roof_shape_from"] == "tag: flat"


def test_small_clipped_footprints_do_not_get_ridged_roofs():
    style = architecture.describe(record(Polygon([(0, 0), (2, 0), (0, 2)])), {})
    assert style["roof_shape"] == "flat" and style["rise_m"] == 0


def test_opposing_stands_rise_away_from_the_field_between_them():
    import shapely.affinity

    west = Polygon([(0, 0), (15, 0), (15, 80), (0, 80)])
    east = shapely.affinity.translate(west, 120, 0)
    for polygon, other in [(west, (127.5, 40)), (east, (7.5, 40))]:
        style = architecture.describe(record(polygon), {"class": "grandstand"}, other)
        along = np.array(style["along"])
        outward = np.array([-along[1], along[0]])
        assert np.dot(outward, np.array(style["centre_m"]) - other) > 0


def test_roof_forms_follow_photo_pixels_and_exclude_edges_and_seams():
    from envgen import buildings
    from envgen.site import Tile

    tile = Tile(100, 200, 1, 80)
    polygon = Polygon([(110, 210), (170, 210), (170, 270), (110, 270)])
    cells = buildings._inside(polygon, tile, 1)
    photo = np.full((3, 80, 80), 220, dtype=np.uint8)
    photo[:, 20:24, 30:36] = 80
    photo[:, 40:43, 48:52] = 90
    photo[:, 10:20, 15:19] = 60
    photo[:, 50:51, 25:40] = 60
    forms = architecture.measure_roof_forms(polygon, cells, photo, tile, 1)
    assert [(f["east_m"], f["north_m"], f["width_m"], f["depth_m"]) for f in forms] == [
        (-7, 18, 6, 4),
        (10, -1.5, 4, 3),
    ]
    assert all(f["height_m"] == 0.9 and f["height_from"].startswith("prior:") for f in forms)
    assert all("shadow" in f["from"] and "unconfirmed" in f["from"] for f in forms)
    measured = buildings.measure([{"polygon": polygon, "tags": {"height_m": 8}}], tile, 1, None, photo, None, 1)[0]
    assert measured["roof_forms"] == forms
    assert measured["height_m"] == 8
    assert measured["roof_albedo"] == pytest.approx(buildings.roof_albedo(np.array([220, 220, 220]), None, 1))


def test_roof_forms_reject_dark_and_small_roofs():
    from envgen import buildings
    from envgen.site import Tile

    tile = Tile(0, 0, 1, 80)
    polygon = Polygon([(10, 10), (70, 10), (70, 70), (10, 70)])
    cells = buildings._inside(polygon, tile, 1)
    photo = np.full((3, 80, 80), 120, dtype=np.uint8)
    photo[:, 25:30, 25:30] = 40
    assert architecture.measure_roof_forms(polygon, cells, photo, tile, 1) == []
    small = Polygon([(10, 10), (30, 10), (30, 30), (10, 30)])
    assert architecture.measure_roof_forms(small, buildings._inside(small, tile, 1), photo + 80, tile, 1) == []


def test_thin_shadow_connections_do_not_fill_the_space_between_rooftop_units():
    from envgen import buildings
    from envgen.site import Tile

    tile = Tile(0, 0, 1, 80)
    polygon = Polygon([(10, 10), (70, 10), (70, 70), (10, 70)])
    photo = np.full((3, 80, 80), 220, dtype=np.uint8)
    photo[:, 25:29, 25:29] = 80
    photo[:, 25:29, 32:36] = 80
    photo[:, 26:27, 29:32] = 80
    forms = architecture.measure_roof_forms(polygon, buildings._inside(polygon, tile, 1), photo, tile, 1)
    assert [(f["width_m"], f["depth_m"]) for f in forms] == [(4, 4), (4, 4)]
    assert forms[1]["east_m"] - forms[0]["east_m"] == 7
    json.dumps(forms)
    assert all(f["height_m"] == 0.9 for f in forms)


@pytest.mark.parametrize("diagonal", [False, True])
def test_sparse_roof_seams_without_a_solid_unit_do_not_become_large_boxes(diagonal):
    from envgen import buildings
    from envgen.site import Tile

    tile = Tile(0, 0, 1, 80)
    polygon = Polygon([(10, 10), (70, 10), (70, 70), (10, 70)])
    photo = np.full((3, 80, 80), 220, dtype=np.uint8)
    if diagonal:
        photo[:, np.arange(25, 35), np.arange(25, 35)] = 80
    else:
        photo[:, 25, 25:35] = 80
        photo[:, 25:35, 25] = 80
    assert architecture.measure_roof_forms(polygon, buildings._inside(polygon, tile, 1), photo, tile, 1) == []
