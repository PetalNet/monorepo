import json

import numpy as np
import pytest
import rasterio
import shapely
from rasterio.transform import from_origin
from shapely.geometry import box

from envgen import architecture, building_imagery, buildings, roof_survey
from envgen.site import Tile


def cloud(kind, datum=100.0):
    rng = np.random.default_rng(42)
    xy = rng.uniform([-9, -7], [9, 7], (2400, 2))
    if kind == "flat":
        z = np.full(len(xy), 7.0)
    elif kind == "gabled":
        z = 9 - 0.4 * abs(xy[:, 1])
    elif kind == "hip":
        z = np.minimum(9 - 0.4 * abs(xy[:, 1]), 10 - 0.4 * abs(xy[:, 0]))
    else:
        z = np.where(xy[:, 0] < 0, 6, 9)
    roof = np.column_stack([xy, datum + z + rng.normal(0, 0.025, len(z))])
    ground_xy = rng.uniform(-15, 15, (1500, 2))
    ground_xy = ground_xy[(abs(ground_xy[:, 0]) > 10) | (abs(ground_xy[:, 1]) > 8)]
    ground = np.column_stack([ground_xy, np.full(len(ground_xy), datum)])
    return box(-9, -7, 9, 7), roof, ground


@pytest.mark.parametrize("kind", ["flat", "gabled", "hip", "multi-level"])
def test_measured_surface_matches_withheld_roofs(kind):
    polygon, points, ground = cloud(kind)
    result = roof_survey.fit(polygon, points, ground, np.zeros(2))
    assert result["status"] == "measured", result
    assert result["roof_shape"] == kind
    assert result["validation_mae_m"] < 0.1
    assert result["validation_share_035m"] > 0.98
    vertices = np.asarray(result["roof_vertices"])
    surfaces = []
    for indices in result["roof_triangles"]:
        part = shapely.Polygon(vertices[indices, :2])
        if part.area > 0:
            surfaces.append(part)
    assert sum(part.area for part in surfaces) == pytest.approx(polygon.area, abs=1e-6)
    assert shapely.union_all(surfaces, grid_size=1e-6).symmetric_difference(polygon).area < 1e-6
    assert result["wall_segments"]


def test_vertical_datum_offset_cancels_from_relative_height():
    a = roof_survey.fit(*cloud("gabled"), np.zeros(2))
    b = roof_survey.fit(*cloud("gabled", 131.25), np.zeros(2))
    assert a["height_m"] == pytest.approx(b["height_m"], abs=1e-7)
    assert a["eave_height_m"] == pytest.approx(b["eave_height_m"], abs=1e-7)
    assert a["ridge_height_m"] == pytest.approx(b["ridge_height_m"], abs=1e-7)


def test_sparse_returns_do_not_turn_into_a_measured_roof():
    polygon, points, ground = cloud("flat")
    result = roof_survey.fit(polygon, points[:20], ground, np.zeros(2))
    assert result["status"] == "unresolved"
    assert "roof_vertices" not in result


def test_scattered_canopy_is_rejected():
    polygon, points, ground = cloud("flat")
    points[:, 2] += np.random.default_rng(2).uniform(-4, 8, len(points))
    result = roof_survey.fit(polygon, points, ground, np.zeros(2))
    assert result["status"] == "unresolved"


def test_small_patch_does_not_validate_an_unobserved_building():
    _, points, ground = cloud("flat")
    points[:, :2] *= 0.2
    result = roof_survey.fit(box(-50, -50, 50, 50), points, ground, np.zeros(2))
    assert result["status"] == "unresolved"
    assert result["area_share_within_2m"] < 0.02


@pytest.mark.parametrize("slope", [-0.2, 0.2])
def test_surveyed_stand_rise_rebuilds_treads_without_a_photo_reference(slope):
    polygon = box(-20, -5, 20, 5)
    record = {
        "id": "stand",
        "rings": [list(polygon.exterior.coords)[:-1]],
        "height_m": 10,
        "area_m2": polygon.area,
        "roof_albedo": [0.3] * 3,
    }
    record["architecture"] = architecture.describe(record, {"building": "grandstand"})
    survey = {"status": "measured", "height_m": 3, "planes": [{"a": 0, "b": slope}]}
    buildings.apply_surveys([record], [survey], Tile(-63, -63, 1, 126))
    style = record["architecture"]
    assert style["stand_step_m"] * style["stand_rows"] == pytest.approx(2)
    z = np.asarray(style["roof_vertices"])[:, 2]
    assert np.ptp(z) == pytest.approx(2 - style["stand_step_m"])
    along = np.asarray(style["along"])
    assert np.dot([0, slope], [-along[1], along[0]]) > 0


def test_reference_only_outline_retains_its_provenance(tmp_path):
    tile = Tile(0, 0, 1, 126)
    outline = [[x - 63, y - 63] for x, y in [(20, 20), (40, 20), (40, 30), (20, 30)]]
    path = tmp_path / "reference.json"
    path.write_text(
        json.dumps({"buildings": {"test": {"source": "photo", "outline_m": outline, "outline_uncertainty_m": 0.3}}})
    )
    footprints = [{"polygon": box(20, 20, 39, 30), "tags": {"id": "test"}}]
    refined = buildings.reference_outlines(footprints, path, tile)
    record = buildings.measure(refined, tile, 1, None, np.full((3, 126, 126), 180), None, 0.5)[0]
    assert record["outline_observation"]["status"] == "photo-referenced"
    assert record["outline_observation"]["from"] == "photo"


def test_malformed_roof_forms_fail_before_engine_generation(tmp_path):
    path = tmp_path / "reference.json"
    path.write_text(json.dumps({"buildings": {"test": {"source": "photo", "roof_forms": [{}]}}}))
    with pytest.raises(ValueError, match="roof form requires"):
        buildings.apply_reference([{"id": "test"}], path)


def test_partial_raster_window_keeps_pixel_locations_and_source_dates(tmp_path):
    image = np.stack(
        [np.broadcast_to(np.arange(80) * 2, (80, 80)), np.full((80, 80), 100), np.full((80, 80), 80)]
    ).astype(np.uint8)
    path = tmp_path / "roof.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=80,
        height=80,
        count=3,
        dtype="uint8",
        crs="EPSG:32615",
        transform=from_origin(0, 20, 0.25, 0.25),
    ) as raster:
        raster.write(image)
    records = [{}]
    footprints = [{"polygon": box(1, 5, 5, 15), "outline_observation": {"status": "source footprint"}}]
    building_imagery.observe(records, footprints, path, "EPSG:32615", None, 0.5, "2024", "2022")
    observation = records[0]["imagery_observation"]
    assert observation["roof_srgb"] == pytest.approx([23, 100, 80])
    assert observation["lidar_date"] == "2024" and observation["image_date"] == "2022"
    assert "2017" not in observation["change_note"] and "newer" not in observation["change_note"]
    partial = [{"polygon": box(18, 5, 25, 15), "outline_observation": {"status": "source footprint"}}]
    partly_covered = [{}]
    building_imagery.observe(partly_covered, partial, path, "EPSG:32615", None, 0.5)
    assert partly_covered[0]["imagery_observation"]["source_coverage_share"] < 0.3
    assert partly_covered[0]["imagery_observation"]["status"] == "unresolved"
    assert "roof_albedo" not in partly_covered[0]


@pytest.mark.parametrize("nodata", [None, 255])
def test_uncovered_or_nodata_reference_retains_prior_geometry_and_colour(tmp_path, nodata):
    path = tmp_path / "roof.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=80,
        height=80,
        count=3,
        nodata=nodata,
        dtype="uint8",
        crs="EPSG:32615",
        transform=from_origin(0, 20, 0.25, 0.25),
    ) as raster:
        raster.write(np.full((3, 80, 80), 255 if nodata else 180, dtype=np.uint8))
    polygon = box(3, 3, 8, 8) if nodata else box(30, 30, 40, 40)
    footprints = [{"polygon": polygon, "tags": {}}]
    refined = building_imagery.refine(footprints, path, "EPSG:32615", Tile(0, 0, 1, 126))
    assert refined[0]["polygon"].equals(polygon)
    records = [{"roof_albedo": [0.2, 0.2, 0.2]}]
    building_imagery.observe(records, refined, path, "EPSG:32615", None, 0.5)
    assert records[0]["imagery_observation"]["status"] == "unresolved"
    assert records[0]["roof_albedo"] == [0.2, 0.2, 0.2]


@pytest.mark.parametrize("angle", [0, 17, 33])
@pytest.mark.parametrize("clockwise", [False, True])
@pytest.mark.parametrize("kind", ["gabled", "multi-level"])
def test_measured_walls_cover_the_whole_projected_footprint(angle, clockwise, kind):
    polygon, points, ground = cloud(kind)
    radians = np.deg2rad(angle)
    rotation = np.array([[np.cos(radians), -np.sin(radians)], [np.sin(radians), np.cos(radians)]])
    origin = np.array([606000.125, 4200000.375])
    corners = np.asarray(polygon.exterior.coords)[:-1] @ rotation.T + origin
    polygon = shapely.Polygon(corners[::-1] if clockwise else corners)
    points[:, :2] = points[:, :2] @ rotation.T + origin
    ground[:, :2] = ground[:, :2] @ rotation.T + origin
    result = roof_survey.fit(polygon, points, ground, origin)
    assert result["status"] == "measured", result
    lines = [shapely.LineString([s[0][:2], s[1][:2]]) for s in result["wall_segments"]]
    assert polygon.boundary.difference(shapely.union_all(lines).buffer(1e-5)).length < 1e-5
    assert sum(line.length for line in lines) == pytest.approx(polygon.length, abs=1e-4)


@pytest.mark.parametrize("high_side", [-1, 1])
@pytest.mark.parametrize("crossing", [False, True])
def test_roof_step_faces_point_from_the_high_volume_to_the_low_volume(high_side, crossing):
    polygon, points, ground = cloud("multi-level")
    if crossing:
        points[:, 2] = 107 + np.where(points[:, 0] < 0, points[:, 1] * 0.2, -points[:, 1] * 0.2)
    if high_side < 0:
        points[:, 2] = 215 - points[:, 2]
    result = roof_survey.fit(polygon, points, ground, np.zeros(2))
    assert result["status"] == "measured", result
    vertices = np.asarray(result["roof_vertices"])
    vertical, tops = [], []
    for triangle in result["roof_triangles"]:
        a, b, c = vertices[triangle]
        normal = np.cross(b - a, c - a)
        if abs(normal[2]) < 1e-8 and np.linalg.norm(normal) > 1e-8:
            vertical.append((normal, (a + b + c) / 3))
        elif abs(normal[2]) >= 1e-8:
            assert normal[2] > 0
            tops.append((np.array([a, b, c]), shapely.Polygon([a[:2], b[:2], c[:2]])))

    def height_at(point):
        for coords, region in tops:
            if region.covers(shapely.Point(point)):
                plane = np.linalg.solve(np.column_stack([coords[:, :2], np.ones(3)]), coords[:, 2])
                return float(np.dot([*point, 1], plane))
        raise AssertionError(f"roof does not cover {point}")

    assert vertical
    for normal, middle in vertical:
        out = normal[:2] / np.linalg.norm(normal[:2])
        assert height_at(middle[:2] + out * 1e-4) < height_at(middle[:2] - out * 1e-4)


@pytest.mark.parametrize("reverse_parts", [False, True])
def test_exact_crossing_orients_each_nondegenerate_step_face(reverse_parts):
    parts = [(box(-2, 0, 0, 2), np.array([0, 1, 0])), (box(0, 0, 2, 2), np.array([0, 0, 1]))]
    vertices, triangles = roof_survey._mesh(parts[::-1] if reverse_parts else parts, np.zeros(2), 0)
    vertices = np.asarray(vertices)
    sides = set()
    for triangle in triangles:
        coords = vertices[triangle]
        normal = np.cross(coords[1] - coords[0], coords[2] - coords[0])
        assert np.linalg.norm(normal) > 1e-10
        if abs(normal[2]) < 1e-8:
            y = coords[:, 1].mean()
            assert normal[0] * (y - 1) > 0
            sides.add(np.sign(y - 1))
    assert sides == {-1, 1}


def test_subresolution_plane_boundaries_form_one_connected_roof():
    parts = [
        (shapely.box(0, 0, 2, 4), np.array([0.0, 0.0, 200.0])),
        (shapely.box(2, 0, 4, 2), np.array([0.0, 0.0, 200.12])),
        (shapely.box(2, 2, 4, 4), np.array([0.0, 0.0, 200.2])),
    ]
    vertices, triangles = roof_survey._mesh(parts, np.zeros(2), 200.0)
    vertices = np.asarray(vertices)
    faces = vertices[triangles]
    normals = np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0])
    assert np.all(normals[:, 2] > 0), "subresolution plane labels must not produce vertical roof shards"
    assert np.isclose(normals[:, 2].sum() / 2, 16.0)
    at_junction = vertices[np.linalg.norm(vertices[:, :2] - [2, 2], axis=1) < 1e-6, 2]
    assert len(at_junction) >= 3, "each adjacent roof must include the shared T-junction"
    assert np.ptp(at_junction) < 1e-8, "adjacent faces must meet at the same height"


def test_roof_domain_smoothing_does_not_depend_on_plane_numbers():
    labels = np.array([[0, 0, 2], [0, 1, 2], [1, 1, 2]], dtype=np.uint8)
    permutation = np.array([2, 0, 1], dtype=np.uint8)
    actual = roof_survey._smooth_labels(labels, 3)
    renamed = roof_survey._smooth_labels(permutation[labels], 3)
    assert np.array_equal(renamed, permutation[actual])


def test_narrow_domain_fragments_do_not_create_separate_roof_masses():
    labels = np.zeros((15, 15), dtype=np.uint8)
    labels[3:10, 7:14] = 1
    labels[1:3, 10] = 1
    labels[11:13, 1:3] = 2
    result = roof_survey._coherent_labels(labels, np.ones(labels.shape, dtype=bool))
    assert result[6, 10] == 1
    assert result[1, 10] == 0
    assert not np.any(result == 2), "a two-cell island is not a measured roof mass"


def test_domains_outside_the_footprint_cannot_support_a_narrow_roof():
    labels = np.ones((12, 12), dtype=np.uint8)
    inside = np.zeros(labels.shape, dtype=bool)
    inside[1:11, 5:7] = True
    assert roof_survey._coherent_labels(labels, inside) is None


def test_broad_observed_roof_domains_keep_their_assignment():
    labels = np.zeros((12, 12), dtype=np.uint8)
    labels[:, 6:] = 1
    result = roof_survey._coherent_labels(labels, np.ones(labels.shape, dtype=bool))
    assert np.array_equal(result, labels)


def test_photo_boundary_keeps_oblique_roof_step_straight():
    polygon, points, ground = cloud("flat")
    points[:, 2] = 100 + np.where(points[:, 0] + 0.3 * points[:, 1] < 0, 6, 9)
    tagged = np.column_stack([points, np.ones(len(points))])
    ground = np.column_stack([ground, np.full(len(ground), 2)])
    boundary = shapely.LineString([[-2.1, 7], [2.1, -7]])
    result = roof_survey.measure([{"polygon": polygon, "roof_breaklines": [boundary]}], np.vstack([tagged, ground]))[0]
    assert result["status"] == "measured", result
    vertices = np.asarray(result["roof_vertices"])
    steps = [vertices[t] for t in result["roof_triangles"] if shapely.Polygon(vertices[t, :2]).area < 1e-8]
    assert steps
    assert max(abs(v[0] + 0.3 * v[1]) for step in steps for v in step) < 2e-5
    assert result["domain_source"] == "photo-referenced breaklines"
    assert result["validation_mae_m"] < 0.1


def test_wrong_photo_boundary_cannot_override_withheld_lidar():
    polygon, points, ground = cloud("multi-level")
    result = roof_survey.measure(
        [{"polygon": polygon, "roof_breaklines": [shapely.LineString([[3.5, -7], [3.5, 7]])]}],
        np.vstack(
            [np.column_stack([points, np.ones(len(points))]), np.column_stack([ground, np.full(len(ground), 2)])]
        ),
    )[0]
    assert result["status"] == "unresolved", result


def test_roof_neighbourhood_mask_retains_roofs_and_rejects_wall_interiors():
    u, v = np.meshgrid(np.linspace(-8, 8, 33), np.linspace(-6, 6, 25))
    roof = np.column_stack([u.ravel(), v.ravel(), np.full(u.size, 10)])
    wall = np.column_stack([u.ravel(), np.full(u.size, 20), v.ravel() + 10])
    points = np.vstack([roof, wall])
    mask = roof_survey._roof_candidates(points, np.array([[0, 0], [0, 20]]))
    assert mask.tolist() == [True, False]


@pytest.mark.parametrize(
    "observation",
    [
        {"roof_breaklines_m": [[[0, 0], [10, 0]]]},
        {"source": "photo", "roof_breaklines_m": [[[0, 0], [float("nan"), 0]]]},
        {"source": "photo", "roof_breaklines_m": [[[1000, 0], [1010, 0]]]},
        {"source": "photo", "roof_breaklines_m": [[[0, 0], [10, 0]]] * 9},
    ],
)
def test_invalid_photo_breaklines_fail_at_reference_boundary(tmp_path, observation):
    path = tmp_path / "reference.json"
    path.write_text(json.dumps({"buildings": {"test": observation}}))
    with pytest.raises(ValueError, match="building_reference"):
        buildings.reference_outlines(
            [{"polygon": box(55, 55, 75, 75), "tags": {"id": "test"}}], path, Tile(0, 0, 1, 126)
        )


def test_boundary_only_reference_does_not_move_ground_mask(tmp_path):
    polygon = box(55, 55, 75, 75)
    path = tmp_path / "reference.json"
    path.write_text(
        json.dumps(
            {
                "buildings": {
                    "test": {
                        "source": "aerial",
                        "roof_breaklines_m": [[[-8, 0], [12, 0]]],
                        "roof_boundary_uncertainty_m": 0.45,
                    }
                }
            }
        )
    )
    result = buildings.reference_outlines([{"polygon": polygon, "tags": {"id": "test"}}], path, Tile(0, 0, 1, 126))[0]
    assert result["polygon"].equals_exact(polygon, 0)
    assert result["roof_boundary_observation"]["from"] == "aerial"
    assert result["roof_boundary_observation"]["uncertainty_m"] == 0.45
    assert list(result["roof_breaklines"][0].coords) == [(55, 63), (75, 63)]


@pytest.mark.parametrize("outline", [None, [[-8, -8], [12, -8], [12, -2], [-8, -2]]])
def test_photo_breakline_must_partition_final_outline(tmp_path, outline):
    observation = {
        "source": "photo",
        "roof_breaklines_m": [[[-8, 15 if outline is None else 0], [12, 15 if outline is None else 0]]],
    }
    if outline is not None:
        observation["outline_m"] = outline
    path = tmp_path / "reference.json"
    path.write_text(json.dumps({"buildings": {"test": observation}}))
    with pytest.raises(ValueError, match="partition the final footprint"):
        buildings.reference_outlines(
            [{"polygon": box(55, 55, 75, 75), "tags": {"id": "test"}}], path, Tile(0, 0, 1, 126)
        )
