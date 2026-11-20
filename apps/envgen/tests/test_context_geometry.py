import importlib
import json
from types import SimpleNamespace

import numpy as np
import pytest
import shapely
from PIL import Image
from pyproj import Transformer
from shapely.geometry import Polygon

from envgen import context_geometry as cg, frame
from envgen.acquire import sha256_file
from envgen.site import Tile

from . import helpers as h


@pytest.fixture
def scene(tmp_path):
    site = SimpleNamespace(tile=Tile(h.WEST - 16, h.SOUTH - 16, 1, 32),
                           context_size_m=128.0, crs=h.CRS, imagery=SimpleNamespace(bands=None))
    e, n = np.meshgrid(np.arange(-64, 65, 8), np.arange(-64, 65, 8), indexing="ij")
    heights = (32768 + e * 2 + n + (e * n / 8)).astype(np.uint16)
    heights[13, 13] = 35000  # a peak inside the courtyard building, away from its walls
    Image.fromarray(heights).save(tmp_path / "context_heightmap.png")
    context = {"heightmap": "context_heightmap.png", "size_m": 128.0, "vertices": 17,
               "location_cm": [-6400, -6400, 300], "scale": [800, 800, 100]}
    return site, context, tmp_path


def footprints(scene, records):
    site, _, out = scene
    transform = Transformer.from_crs(h.CRS, "EPSG:4326", always_xy=True).transform
    features = []
    for polygon, tags in records:
        projected = shapely.affinity.translate(polygon, *site.tile.centre)
        geographic = shapely.transform(projected, lambda xy: np.column_stack(transform(xy[:, 0], xy[:, 1])))
        features.append({"type": "Feature", "geometry": shapely.geometry.mapping(geographic), "properties": tags})
    path = out / "footprints.json"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    return {"buildings": {"path": str(path), "sha256": sha256_file(path)}}


def canopy(scene, values):
    site, _, out = scene
    path = out / "canopy.tif"
    h.write_raster(path, values.astype(np.float32), site.tile.centre[0] - 64, site.tile.centre[1] + 64, 2, -9999)
    return {"context_canopy_height": {"path": str(path), "sha256": sha256_file(path)}}


def run(scene, sources=None, buildings=None, trees=None, cutoff=2, classes=None):
    site, context, out = scene
    result = cg.build(site, sources or {}, context, buildings, trees, classes or {}, out, cutoff_m=cutoff)
    return result, json.loads((out / result["file"]).read_text())


def triangles(payload, kind):
    for mesh in payload["meshes"]:
        if mesh["kind"] == kind:
            vertices = np.asarray(mesh["vertices"]) + mesh["origin_enu_m"]
            yield from vertices[np.asarray(mesh["triangles"])]


def test_outer_clipped_building_with_fractional_context_size_and_projected_centre(scene):
    site, context, out = scene
    centre = np.array([500000.1, 4200000.1])
    site.tile = Tile(centre[0] - 504, centre[1] - 504, 0.5, 2016)
    site.context_size_m = size = 4032.01
    half = size / 2
    context.update(size_m=size, vertices=505, location_cm=[-half * 100, -half * 100, 0],
                   scale=[size / 504 * 100, size / 504 * 100, 100])
    Image.fromarray(np.full((505, 505), 32768, dtype=np.uint16)).save(out / context["heightmap"])
    source = footprints(scene, [(shapely.box(half - 10, -10, half + 10, 10), {"height_m": 6})])
    _, payload = run(scene, source)
    assert payload["counts"]["buildings"] == 1
    assert payload["sources"]["buildings"]["outer_boundary_parts"] == 1
    assert all(-half - 1e-7 <= p[0] <= half + 1e-7 for t in triangles(payload, "building") for p in t)
    assert all(-half <= p[0] <= half and -half <= p[1] <= half for p in payload["ground_probes"])


def test_buildings_preserve_holes_height_priority_primary_ownership_and_deduplicate(scene):
    courtyard = Polygon([(24, 24), (60, 24), (60, 60), (24, 60)],
                        [[(28, 28), (32, 28), (32, 32), (28, 32)]])
    crossing = shapely.box(10, -8, 30, 8)
    sources = footprints(scene, [(courtyard, {"id": "court", "height_m": "9", "num_floors": 4}),
                                 (courtyard, {"id": "duplicate"}), (crossing, {"id": "crossing"}),
                                 (shapely.box(-60, 28, -40, 44), {"num_floors": 3}),
                                 (shapely.box(-60, -60, -40, -40), {})])
    result, payload = run(scene, sources)
    report = payload["sources"]["buildings"]
    assert result["counts"]["buildings"] == 3
    assert report["duplicates"] == 1 and report["primary_crossing"] == 1
    assert report["omitted_crossing_area_m2"] == pytest.approx(14 * 16, abs=0.001)
    assert sorted(record["height_m"] for record in report["records"]) == [6, 9, 9]
    roof_area = 0
    for tri in triangles(payload, "building"):
        normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        footprint = Polygon(tri[:, :2])
        if normal[2] > 1e-7:
            assert not footprint.intersects(shapely.box(-16, -16, 16, 16))
            assert footprint.intersection(shapely.box(28, 28, 32, 32)).area < 1e-6
            roof_area += normal[2] / 2
    assert roof_area == pytest.approx(courtyard.area + 20 * 16 + 20 * 20, abs=0.001)
    cg.validate(payload)


def test_roof_clears_interior_peak_and_wall_bases_follow_encoded_triangle_planes(scene):
    sources = footprints(scene, [(shapely.box(24, 24, 60, 60), {"height_m": 6})])
    _, payload = run(scene, sources)
    _, context, out = scene
    heights = np.asarray(Image.open(out / context["heightmap"]))
    peak = frame.sample_heightmap(heights, context, [[40, 40]])[0]
    roof_z = []
    for tri in triangles(payload, "building"):
        normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        if normal[2] > 1e-7:
            roof_z.extend(tri[:, 2])
        else:
            ground = frame.sample_heightmap(heights, context, tri[:, :2])
            at_base = tri[:, 2] < peak
            assert tri[at_base, 2] == pytest.approx(ground[at_base] - cg.SETTINGS["bury_m"])
    assert roof_z == pytest.approx([peak + 6] * len(roof_z))
    for east, north, up in payload["ground_probes"]:
        assert up == pytest.approx(frame.sample_heightmap(heights, context, [[east, north]])[0])


def test_canopy_extents_respect_road_hole_buildings_primary_crowns_and_nodata(scene):
    values = np.full((64, 64), 12, dtype=np.float32)
    values[:, 48:52] = 0  # north/south road
    values[8:12, 8:12] = -9999
    values[48:52, 8:12] = 0  # a clearing
    sources = canopy(scene, values)
    building = shapely.box(24, 24, 40, 40)
    sources |= footprints(scene, [(building, {"height_m": 5})])
    out = scene[2]
    (out / "trees.json").write_text(json.dumps({"columns": ["east_m", "north_m", "crown_radius_m"],
                                               "trees": [[20, -30, 10]]}))
    _, payload = run(scene, sources, trees={"file": "trees.json"})
    assert payload["counts"]["canopy_clusters"] > 0
    support = payload["sources"]["canopy"]
    assert 0 < support["valid_fraction"] < 1
    assert support["excluded_cells"] > 0
    assert support["represented_area_m2"] <= support["eligible_support_area_m2"]
    forbidden = shapely.union_all([shapely.box(-16, -16, 16, 16), building,
                                   shapely.box(32, -64, 40, 64), shapely.box(-48, 40, -40, 48),
                                   shapely.box(-48, -40, -40, -32), shapely.Point(20, -30).buffer(10)])
    shapes = set(cluster["shape"] for cluster in support["clusters"])
    assert shapes == {"rounded", "support-shaped"}
    for tri in triangles(payload, "canopy"):
        assert Polygon(tri[:, :2]).intersection(forbidden).area < 1e-7
    assert all(cluster["height_m"] == 12 for cluster in support["clusters"])
    assert payload["counts"]["canopy_clusters"] == len(support["clusters"])


@pytest.mark.parametrize("mode,status", [("absent", "absent"), ("clear", "empty"), ("nodata", "invalid")])
def test_optional_source_status_and_empty_geometry(scene, mode, status):
    sources = {} if mode == "absent" else canopy(scene, np.full((64, 64), 0 if mode == "clear" else -9999))
    result, payload = run(scene, sources)
    assert payload["sources"]["canopy"]["status"] == status
    assert payload["sources"]["buildings"]["status"] == "absent"
    assert result["counts"] == {"buildings": 0, "canopy_clusters": 0, "batches": 0, "triangles": 0}


def test_context_canopy_excludes_closed_primary_bounds_from_meshes_and_probes(scene):
    sources = canopy(scene, np.full((64, 64), 12, dtype=np.float32))
    _, payload = run(scene, sources)
    half = payload["primary_half_m"]
    primary = shapely.box(-half, -half, half, half)
    assert payload["counts"]["canopy_clusters"] > 0
    for triangle in triangles(payload, "canopy"):
        assert not Polygon(triangle[:, :2]).intersects(primary)
    assert payload["ground_probes"]
    assert all(abs(east) > half or abs(north) > half for east, north, _ in payload["ground_probes"])


def test_refined_primary_building_excludes_whole_wide_part_outside_tile(scene):
    sources = footprints(scene, [(shapely.box(20, 20, 40, 40), {"height_m": 6})])
    out = scene[2]
    # Refined inventory can own a part beyond the closed primary square.
    (out / "buildings.json").write_text(json.dumps({"buildings": [{"rings": [[[18, 18], [24, 18], [24, 24], [18, 24]]]}]}))
    _, payload = run(scene, sources, buildings={"file": "buildings.json"})
    assert payload["counts"]["buildings"] == 0
    assert payload["sources"]["buildings"]["primary_crossing"] == 1


def test_source_colours_use_declared_bands_and_single_albedo_scale(scene):
    site, _, out = scene
    photo = np.broadcast_to(np.array([10, 60, 120, 200], np.uint8)[:, None, None], (4, 64, 64)).copy()
    h.write_raster(out / "photo.tif", photo, h.WEST - 64, h.SOUTH + 64, 2)
    site.imagery.bands = (("blue", 2), ("green", 3), ("nir", 1), ("red", 4))
    sources = footprints(scene, [(shapely.box(24, 24, 40, 40), {"height_m": 6})])
    sources["context_imagery"] = {"path": str(out / "photo.tif"), "sha256": sha256_file(out / "photo.tif")}
    _, payload = run(scene, sources, classes={"albedo": {"scale": 0.5}})
    expected = cg.surface.to_linear(np.array([200, 120, 60])) * 0.5
    roof = [colour for mesh in payload["meshes"] for tri, colour in zip(mesh["triangles"], mesh["colours"], strict=True)
            if np.cross(np.asarray(mesh["vertices"])[tri[1]] - mesh["vertices"][tri[0]],
                        np.asarray(mesh["vertices"])[tri[2]] - mesh["vertices"][tri[0]])[2] > 1e-7]
    assert roof and np.asarray(roof) == pytest.approx(np.tile(expected, (len(roof), 1)))
    assert payload["sources"]["buildings"]["records"][0]["colour_from"].startswith("source:")


def test_determinism_and_caps_fail_instead_of_truncating(scene, monkeypatch):
    sources = canopy(scene, np.full((64, 64), 10))
    run(scene, sources)
    path = scene[2] / "context_geometry.json"
    before = path.read_bytes()
    run(scene, sources)
    assert path.read_bytes() == before
    monkeypatch.setitem(cg.SETTINGS, "max_triangles", 10)
    with pytest.raises(ValueError, match="triangle cap"):
        run(scene, sources)


def test_present_malformed_sources_and_missing_cutoff_fail(scene):
    sources = canopy(scene, np.full((64, 64), 10))
    with pytest.raises(ValueError, match="cutoff"):
        run(scene, sources, cutoff=None)
    path = scene[2] / "bad.json"
    path.write_text("not JSON")
    with pytest.raises(ValueError):
        run(scene, {"buildings": {"path": str(path), "sha256": sha256_file(path)}})


@pytest.mark.parametrize("damage", ["index", "nan", "colour", "degenerate", "bounds", "kind"])
def test_wire_validator_rejects_malformed_present_mesh(scene, damage):
    sources = footprints(scene, [(shapely.box(24, 24, 40, 40), {})])
    _, payload = run(scene, sources)
    mesh = payload["meshes"][0]
    if damage == "index":
        mesh["triangles"][0][0] = len(mesh["vertices"])
    elif damage == "nan":
        mesh["vertices"][0][2] = float("nan")
    elif damage == "colour":
        mesh["colours"][0][0] = 1.1
    elif damage == "degenerate":
        mesh["triangles"][0] = [0, 0, 0]
    elif damage == "bounds":
        mesh["vertices"][0][0] = 10000
    else:
        mesh["kind"] = "tree"
    with pytest.raises(ValueError):
        cg.validate(payload)


def test_local_stage_cache_rehashes_output_and_rebuilds_missing_or_tampered_files(tmp_path):
    builder = importlib.import_module("envgen.build")
    calls = []

    def compute():
        calls.append(True)
        (tmp_path / "context_geometry.json").write_text("original")
        return {"file": "context_geometry.json", "files": ["context_geometry.json"]}

    assert not builder._cached(tmp_path, "context_geometry", "key", compute)["cached"]
    assert builder._cached(tmp_path, "context_geometry", "key", compute)["cached"]
    (tmp_path / "context_geometry.json").write_text("tampered")
    assert not builder._cached(tmp_path, "context_geometry", "key", compute)["cached"]
    (tmp_path / "context_geometry.json").unlink()
    assert not builder._cached(tmp_path, "context_geometry", "key", compute)["cached"]
    assert not builder._cached(tmp_path, "context_geometry", "changed", compute)["cached"]
    assert len(calls) == 4


def test_pipeline_context_preserves_primary_inventory_and_tracks_geometry_dependencies(tmp_path, monkeypatch):
    from .test_buildings import geojson, square
    from .test_cover import write_canopy

    builder = importlib.import_module("envgen.build")
    h.write_dem(tmp_path / "dem.tif", margin=100)
    h.write_imagery(tmp_path / "imagery.tif", split_easting=h.WEST + 63)
    path = tmp_path / "buildings-source.json"
    geojson(path, [(square(30, 60, 50, 80), {"height_m": 6}),
                   (square(140, 60, 160, 80), {"height_m": 9})])
    site_path = h.write_site(tmp_path)
    raw = json.loads(site_path.read_text())
    raw["sources"]["imagery"]["date"] = "2030-06-21"
    raw["sources"]["buildings"] = {"kind": "file", "path": path.name, "license": "test", "date": "2030"}
    write_canopy(tmp_path / "canopy.tif", [(70, 20, 90, 40, 12), (140, 100, 180, 140, 10)], extent=100)
    raw["sources"]["canopy_height"] = {"kind": "file", "path": "canopy.tif", "license": "test", "date": "2030"}
    site_path.write_text(json.dumps(raw))
    out = tmp_path / "out"
    baseline = builder.build(site_path, out)
    assert "context" not in baseline
    primary_files = {name: digest for name, digest in baseline["artifacts"].items()}
    raw["context"] = {"size_m": 252}
    site_path.write_text(json.dumps(raw))
    first = builder.build(site_path, out)
    descriptor = first["context"]["geometry"]
    assert descriptor["schema_version"] == 1 and descriptor["file"] == "context_geometry.json"
    assert descriptor["counts"]["buildings"] == 1
    assert "context_geometry" not in first["stages_reused"]
    for name, digest in primary_files.items():
        assert first["artifacts"][name] == digest
    assert first["buildings"]["count"] == baseline["buildings"]["count"] == 1
    assert first["trees"]["count"] == baseline["trees"]["count"]
    original = (out / "context_geometry.json").read_bytes()
    assert first["artifacts"]["context_geometry.json"] == sha256_file(out / "context_geometry.json")
    again = builder.build(site_path, out)
    assert "context_geometry" in again["stages_reused"]
    (out / "context_geometry.json").write_text("tampered")
    repaired = builder.build(site_path, out)
    assert "context_geometry" not in repaired["stages_reused"]
    assert (out / "context_geometry.json").read_bytes() == original
    monkeypatch.setitem(cg.SETTINGS, "height_prior_m", 7.0)
    changed = builder.build(site_path, out)
    assert "context_geometry" not in changed["stages_reused"]
    assert "context" in changed["stages_reused"]
    # A changed wide source must invalidate geometry even when primary ownership stays the same.
    geojson(path, [(square(30, 60, 50, 80), {"height_m": 6}),
                   (square(140, 60, 160, 80), {"height_m": 12})])
    changed_source = builder.build(site_path, out)
    assert "context_geometry" not in changed_source["stages_reused"]
    payload = json.loads((out / "context_geometry.json").read_text())
    assert payload["sources"]["buildings"]["records"][0]["height_m"] == 12


def test_four_kilometre_context_grounds_exterior_geometry_far_beyond_primary(tmp_path):
    site = SimpleNamespace(tile=Tile(h.WEST - 504, h.SOUTH - 504, 1, 1008),
                           context_size_m=4032.0, crs=h.CRS, imagery=SimpleNamespace(bands=None))
    e, n = np.meshgrid(np.arange(-2016, 2017, 8), np.arange(-2016, 2017, 8), indexing="ij")
    heights = (32768 + e + n * 2).astype(np.uint16)
    Image.fromarray(heights).save(tmp_path / "context_heightmap.png")
    context = {"heightmap": "context_heightmap.png", "size_m": 4032.0, "vertices": 505,
               "location_cm": [-201600, -201600, 100], "scale": [800, 800, 100]}
    scene = site, context, tmp_path
    sources = footprints(scene, [(shapely.box(1700, 1600, 1732, 1632), {"height_m": 12})])
    values = np.zeros((504, 504), np.float32)
    values[20:24, 480:484] = 15
    h.write_raster(tmp_path / "wide-canopy.tif", values, h.WEST - 2016, h.SOUTH + 2016, 8, -9999)
    sources["context_canopy_height"] = {"path": str(tmp_path / "wide-canopy.tif"),
                                         "sha256": sha256_file(tmp_path / "wide-canopy.tif")}
    result, payload = run(scene, sources)
    assert result["counts"]["buildings"] == result["counts"]["canopy_clusters"] == 1
    assert payload["bounds_enu_m"] == [-2016, -2016, 2016, 2016]
    assert max(p[0] for p in payload["ground_probes"]) >= 1700
    for east, north, up in payload["ground_probes"]:
        assert up == pytest.approx(1 + (east + 2 * north) / 128, abs=1e-7)
    assert payload["counts"]["triangles"] < 1000


def test_mesh_batches_split_at_cap_and_report_failure_at_global_batch_limit(scene, monkeypatch):
    sources = footprints(scene, [(shapely.box(24, 24, 60, 60), {})])
    monkeypatch.setitem(cg.SETTINGS, "max_batch_triangles", 10)
    _, payload = run(scene, sources)
    assert len(payload["meshes"]) > 1
    assert all(len(mesh["triangles"]) <= 10 for mesh in payload["meshes"])
    monkeypatch.setitem(cg.SETTINGS, "max_batches", 1)
    with pytest.raises(ValueError, match="batch cap"):
        run(scene, sources)


def test_source_extent_partial_cells_do_not_become_canopy_support(scene):
    site, _, out = scene
    # A 9 m-wide source, on an 8 m support grid: only the first cell is fully observed.
    h.write_raster(out / "narrow.tif", np.full((16, 9), 12, np.float32), h.WEST - 64, h.SOUTH + 64, 1)
    sources = {"context_canopy_height": {"path": str(out / "narrow.tif"),
                                         "sha256": sha256_file(out / "narrow.tif")}}
    _, payload = run(scene, sources)
    assert payload["sources"]["canopy"]["eligible_support_area_m2"] == 2 * 8 * 8
    assert all(tri[:, 0].max() <= -56 for tri in triangles(payload, "canopy"))


def test_canopy_open_boundaries_stay_below_nonplanar_exported_ground(scene):
    sources = canopy(scene, np.full((64, 64), 12))
    _, payload = run(scene, sources)
    heights = np.asarray(Image.open(scene[2] / scene[1]["heightmap"]))
    boundary_edges = 0
    for mesh in payload["meshes"]:
        if mesh["kind"] != "canopy":
            continue
        vertices = np.asarray(mesh["vertices"]) + mesh["origin_enu_m"]
        edges = {}
        for tri in mesh["triangles"]:
            for a, b in zip(tri, [*tri[1:], tri[0]], strict=True):
                key = tuple(sorted((a, b)))
                edges[key] = edges.get(key, 0) + 1
        for (a, b), count in edges.items():
            if count == 1:
                samples = vertices[a] + np.linspace(0, 1, 9)[:, None] * (vertices[b] - vertices[a])
                ground = frame.sample_heightmap(heights, scene[1], samples[:, :2])
                assert np.all(samples[:, 2] <= ground + 1e-6)
                boundary_edges += 1
    assert boundary_edges > 0
