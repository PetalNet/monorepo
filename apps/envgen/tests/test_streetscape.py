"""Synthetic measured inventories: validation, coverage, terrain sampling and prop dimensions."""

import copy
import json
import math

import numpy as np
import pytest
from PIL import Image
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from envgen.site import SiteError, Tile
from envgen.streetscape import build_inventory

# Arbitrary projected origin: inventory coordinates must never be translated by it.
TILE = Tile(10000, 20000, 1, 1260)
SOURCE = {"name": "synthetic survey", "license": "CC0", "date": "2026-01-01"}


def feature(kind, **geometry):
    if kind in ("bench", "goalpost", "soccer_goal"):
        geometry.setdefault("heading_deg", 0)
    return {
        "id": "measured-1",
        "type": kind,
        "evidence": "test-image.png crop (10,20,80,90)",
        "confidence": 0.9,
        **geometry,
    }


def inventory(features):
    return {
        "schema_version": 1,
        "coordinate_frame": "tile_centred_east_north_m",
        "source": SOURCE,
        "features": features,
    }


def build(tmp_path, features=None, raw=None, tile=TILE):
    path = tmp_path / "inventory.json"
    path.write_text(json.dumps(raw if raw is not None else inventory(features)))
    stage = build_inventory(path, tile, tmp_path / "out")
    return stage, json.loads((tmp_path / "out" / "streetscape.json").read_text())


def triangles(payload):
    for mesh in payload["meshes"]:
        for triangle in mesh["triangles"]:
            yield [mesh["vertices"][i] for i in triangle]


def mesh_pieces(mesh):
    parent = list(range(len(mesh["vertices"])))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for triangle in mesh["triangles"]:
        for i in triangle[1:]:
            parent[root(i)] = root(triangle[0])
    pieces = {}
    for i, vertex in enumerate(mesh["vertices"]):
        pieces.setdefault(root(i), []).append(vertex)
    return list(pieces.values())


def bounds(meshes):
    vertices = [v for mesh in meshes for v in mesh["vertices"]]
    return [(min(v[i] for v in vertices), max(v[i] for v in vertices)) for i in range(3)]


@pytest.mark.parametrize(
    "change",
    [
        {"confidence": -1},
        {"confidence": 1.01},
        {"confidence": True},
        {"confidence": float("nan")},
        {"evidence": ""},
        {"evidence": None},
        {"type": "tree"},
        {"type": []},
        {"point": [631, 0]},
        {"point": [0, float("inf")]},
        {"point": [0]},
        {"point": [False, 0]},
        {"length_m": 0},
        {"length_m": -2},
        {"length_m": "2"},
        {"length_m": float("nan")},
        {"heading_deg": float("inf")},
        {"heading_deg": None},
        {"unsupported_width_m": 3},
    ],
)
def test_invalid_feature_reports_its_id(tmp_path, change):
    f = feature("bench", point=[0, 0])
    f.update(change)
    with pytest.raises(SiteError, match="measured-1"):
        build(tmp_path, [f])


@pytest.mark.parametrize(
    "f",
    [
        feature("surface", ring=[[0, 0], [1, 1], [0, 1], [1, 0]], material="asphalt"),
        feature("surface", ring=[[0, 0], [1, 0], [2, 0]], material="asphalt"),
        feature("surface", ring=[[0, 0], [1, 0]], material="asphalt"),
        feature("surface", ring=[[0, 0], [1, 0], [1, 1]], material="mud"),
        feature("line", points=[[0, 0], [0, 0]], material="paint_white"),
        feature("line", points=[[0, 0], [1, 0]], material="concrete"),
        feature("line", points=[[0, 0], [1, 0]], material="asphalt"),
        feature("curb", points=[[0, 0]], height_m=0.1),
        feature("fence", points=[[0, 0], [2, 0]], ground_anchor=[[0, float("inf")]]),
        feature("fence", points=[[0, 0], [2, 0]], ground_anchor=True),
        feature("light_pole", point=[0, 0]),
        feature("light_pole", point=[0, 0], height_m=8, arms=3),
        feature("light_pole", point=[0, 0], height_m=8, arms=2.0),
        feature("light_pole", point=[0, 0], height_m=8, floodlight="yes"),
        feature("bleacher", points=[[0, 0], [2, 0], [3, 0]]),
        feature("bleacher", points=[[0, 0], [2, 0]], rows=True),
        feature("bleacher", points=[[0, 0], [2, 0]], rows=0),
        feature("soccer_goal", point=[0, 0], depth_m=-1),
    ],
)
def test_invalid_geometry_reports_its_id(tmp_path, f):
    with pytest.raises(SiteError, match="measured-1"):
        build(tmp_path, [f])


@pytest.mark.parametrize(
    "change",
    [
        {"schema_version": True},
        {"schema_version": 2},
        {"coordinate_frame": "north_east"},
        {"source": {}},
        {"source": None},
        {"source": {**SOURCE, "license": ""}},
        {"features": {}},
    ],
)
def test_inventory_contract(tmp_path, change):
    raw = inventory([])
    raw.update(change)
    with pytest.raises(SiteError):
        build(tmp_path, raw=raw)


def test_duplicate_ids_and_invalid_json(tmp_path):
    f = feature("bench", point=[0, 0])
    with pytest.raises(SiteError, match="measured-1.*duplicate"):
        build(tmp_path, [f, copy.deepcopy(f)])
    path = tmp_path / "invalid.json"
    path.write_text("{")
    with pytest.raises(SiteError, match="cannot read inventory"):
        build_inventory(path, TILE, tmp_path / "out")


@pytest.mark.parametrize(
    "ring",
    [
        [[3, 7], [17, 7], [17, 10], [8, 10], [8, 19], [3, 19]],
        [[-4, -4], [4, -4], [4, 4], [-4, 4], [-4, -4]],
        [[120, -2], [132, -2], [132, 5], [120, 5]],
    ],
)
def test_surface_triangles_cover_only_polygon_preserve_area_and_drape(tmp_path, ring):
    expected = Polygon(ring)
    stage, payload = build(tmp_path, [feature("surface", ring=ring, material="track")])
    polygons = []
    for tri in triangles(payload):
        poly = Polygon([v[:2] for v in tri])
        assert poly.area > 0
        assert expected.buffer(1e-9).covers(poly)
        assert max(math.dist(a[:2], b[:2]) for a in tri for b in tri) <= 2 + 1e-9
        assert all(v[2] == 0.05 for v in tri)
        polygons.append(poly)
    assert sum(p.area for p in polygons) == pytest.approx(expected.area)
    assert unary_union(polygons).symmetric_difference(expected).area < 1e-8
    assert all("anchor_m" not in m for m in payload["meshes"])
    assert stage["triangle_count"] == len(polygons)
    for m in payload["meshes"]:
        assert all(hi - lo <= 126 + 1e-9 for lo, hi in bounds([m])[:2])


@pytest.mark.parametrize("material,offset", [("paint_white", 0.07), ("paint_yellow", 0.07), ("concrete", 0.06)])
def test_line_has_measured_width_flat_caps_and_buffer_coverage(tmp_path, material, offset):
    points = [[7, 11], [27, 11], [27, 22]]
    stage, payload = build(tmp_path, [feature("line", points=points, width_m=0.8, material=material)])
    expected = LineString(points).buffer(0.4, cap_style="flat", join_style="mitre")
    polys = [Polygon([v[:2] for v in t]) for t in triangles(payload)]
    assert sum(p.area for p in polys) == pytest.approx(expected.area)
    assert unary_union(polys).symmetric_difference(expected).area < 1e-8
    assert bounds(payload["meshes"])[0][0] == 7  # flat end, no half-width cap extension
    assert bounds(payload["meshes"])[1][0] == pytest.approx(10.6)
    assert all(v[2] == offset for m in payload["meshes"] for v in m["vertices"])
    assert stage["counts"] == {"line": 1}


def test_default_paint_width_and_thin_long_line_are_compact(tmp_path):
    _, payload = build(tmp_path, [feature("line", points=[[-500, 9], [500, 9]], material="paint_white")])
    area = sum(Polygon([v[:2] for v in t]).area for t in triangles(payload))
    assert area == pytest.approx(100)
    assert bounds(payload["meshes"])[1] == pytest.approx((8.95, 9.05))
    # The strip straddles two quad rows; each half needs three triangles to retain the terrain diagonal.
    assert sum(len(m["triangles"]) for m in payload["meshes"]) <= 6000


def test_anchor_changes_terrain_sample_without_translating_coordinates(tmp_path):
    _, payload = build(tmp_path, [feature("bench", point=[13, -7], heading_deg=0, length_m=2)])
    assert all(m["anchor_m"] == [13, -7] for m in payload["meshes"])
    assert bounds(payload["meshes"])[0] == pytest.approx((12, 14))
    ground = lambda e, n: 0.1 * e + 0.2 * n
    for m in payload["meshes"]:
        for e, n, offset in m["vertices"]:
            world_z = ground(*m["anchor_m"]) + offset
            assert world_z - offset == pytest.approx(-0.1)
    _, draped = build(tmp_path, [feature("curb", points=[[10, -8], [18, -8]])])
    assert all("anchor_m" not in m for m in draped["meshes"])
    assert bounds(draped["meshes"])[2] == pytest.approx((-0.05, 0.15))
    heights = [ground(e, n) + z for m in draped["meshes"] for e, n, z in m["vertices"] if z > 0]
    assert max(heights) - min(heights) > 0.8


def test_heading_rotates_about_measured_anchor(tmp_path):
    _, payload = build(tmp_path, [feature("bench", point=[13, -7], heading_deg=90, length_m=2)])
    assert bounds(payload["meshes"])[1] == pytest.approx((-8, -6))
    assert all(m["anchor_m"] == [13, -7] for m in payload["meshes"])


def test_all_props_have_valid_nonempty_physical_geometry_and_record_priors(tmp_path):
    fs = [
        feature("light_pole", point=[0, 0], height_m=10, arms=4, floodlight=True),
        feature("bench", point=[20, 10]),
        feature("bleacher", points=[[30, 0], [40, 0]]),
        feature("goalpost", point=[0, 30]),
        feature("soccer_goal", point=[30, 30]),
        feature("fence", points=[[-20, -10], [-11, -10]]),
    ]
    for i, f in enumerate(fs):
        f["id"] = f"prop-{i}"
    stage, payload = build(tmp_path, fs)
    assert stage["feature_count"] == payload["feature_count"] == 6
    assert stage["counts"] == {f["type"]: 1 for f in fs}
    assert stage["source"] == SOURCE
    assert stage["files"] == [stage["file"], stage["grass_mask"]]
    assert all((tmp_path / "out" / name).is_file() for name in stage["files"])
    assert all(any(p.startswith(f"prop-{i}:") for p in stage["priors"]) for i in range(6))
    assert {m["material"] for m in payload["meshes"]} == {
        "steel",
        "lamp_dark",
        "wood",
        "aluminum",
        "steel_yellow",
        "paint_white",
        "net",
        "chainlink",
    }
    for m in payload["meshes"]:
        assert m["vertices"] and m["triangles"] and len(m["triangles"]) <= 20000
        assert type(m["collision"]) is bool
        assert all(len(v) == 3 and all(math.isfinite(x) for x in v) for v in m["vertices"])
        for tri in m["triangles"]:
            assert len(set(tri)) == 3 and all(0 <= i < len(m["vertices"]) for i in tri)
    for a, b, c in triangles(payload):
        u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
        cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        assert sum(x * x for x in cross) > 0
    assert all(m["collision"] is False for m in payload["meshes"] if m["material"] == "net")


def test_bench_has_three_seat_slats_two_back_slats_and_frame(tmp_path):
    _, p = build(tmp_path, [feature("bench", point=[0, 0])])
    wood = next(m for m in p["meshes"] if m["material"] == "wood")
    assert len(wood["triangles"]) == 5 * 12
    assert bounds([wood])[0] == pytest.approx((-0.9, 0.9))
    assert bounds(p["meshes"])[2][0] == -0.3


def test_bleacher_rows_rise_away_from_axis_and_have_legs(tmp_path):
    _, p = build(tmp_path, [feature("bleacher", points=[[-5, 0], [5, 0]], rows=5)])
    seats = next(m for m in p["meshes"] if m["material"] == "aluminum")
    assert len(seats["triangles"]) == 5 * 12
    centres = [sum(v[2] for v in seats["vertices"][i : i + 8]) / 8 for i in range(0, 40, 8)]
    assert centres == pytest.approx([0.35, 0.7, 1.05, 1.4, 1.75])
    assert bounds([seats])[0] == pytest.approx((-5, 5))
    assert bounds([seats])[1] == pytest.approx((-0.22, 3.42))
    assert all(m["anchor_m"] == [0, 0] for m in p["meshes"])
    assert bounds([m for m in p["meshes"] if m["material"] == "steel"])[2][0] <= 0


@pytest.mark.parametrize("arms", [2, 4])
def test_light_pole_has_tapered_mast_and_exact_head_count(tmp_path, arms):
    _, p = build(tmp_path, [feature("light_pole", point=[0, 0], height_m=12, arms=arms)])
    mast = next(m for m in p["meshes"] if m["material"] == "steel")
    heads = next(m for m in p["meshes"] if m["material"] == "lamp_dark")
    assert len(mesh_pieces(heads)) == arms
    assert max(v[2] for v in mast["vertices"]) == 12
    assert max(math.hypot(v[0], v[1]) for v in mast["vertices"] if v[2] == -0.3) == pytest.approx(0.11)
    assert max(math.hypot(v[0], v[1]) for v in mast["vertices"] if v[2] == 12) == pytest.approx(0.06)
    assert bounds([heads])[2] == pytest.approx((12 * 0.92 - 0.1, 12 * 0.92 + 0.1))


def test_goalpost_has_single_support_crossbar_and_two_uprights(tmp_path):
    _, p = build(tmp_path, [feature("goalpost", point=[0, 0])])
    assert len(p["meshes"]) == 1
    m = p["meshes"][0]
    assert m["material"] == "steel_yellow"
    assert len(mesh_pieces(m)) == 5
    assert bounds([m])[2] == pytest.approx((-0.3, 5.6))
    assert bounds([m])[0] == pytest.approx((-5.64 / 2 - 0.05, 5.64 / 2 + 0.05))


def test_soccer_goal_open_front_and_full_sparse_box_net(tmp_path):
    _, p = build(tmp_path, [feature("soccer_goal", point=[0, 0])])
    frame = next(m for m in p["meshes"] if m["material"] == "paint_white")
    net = next(m for m in p["meshes"] if m["material"] == "net")
    assert len(mesh_pieces(frame)) == 10
    assert 2.44 <= max(v[2] for v in frame["vertices"]) <= 2.48
    assert max(v[2] for v in frame["vertices"]) >= 2.47
    assert min(v[0] for v in frame["vertices"]) < -3.66
    assert max(v[1] for v in net["vertices"]) >= 2
    # No wire spans the open goal mouth: each runs at the back, roof, or a side.
    for wire in mesh_pieces(net):
        assert (
            all(abs(v[1] - 2) <= 0.003 + 1e-8 for v in wire)
            or all(abs(v[2] - 2.44) <= 0.003 + 1e-8 for v in wire)
            or all(abs(abs(v[0]) - 3.66) <= 0.003 + 1e-8 for v in wire)
        )


def test_fence_post_spacing_rails_lattice_and_long_fence_budget(tmp_path):
    stage, p = build(tmp_path, [feature("fence", points=[[0, 0], [9, 0]])])
    m = p["meshes"][0]
    assert "anchor_m" not in m
    posts = [piece for piece in mesh_pieces(m) if max(v[2] for v in piece) - min(v[2] for v in piece) > 2.4]
    post_x = sorted(sum(v[0] for v in piece) / len(piece) for piece in posts)
    assert post_x == pytest.approx([0, 3, 6, 9])
    assert bounds([m])[2][0] == pytest.approx(-0.05)
    assert 2.4 <= bounds([m])[2][1] <= 2.403
    assert any("masked chainlink" in s for s in stage["priors"])
    fabric = next(m for m in p["meshes"] if m["material"] == "chainlink")
    assert bounds([fabric])[0] == pytest.approx((0, 9))
    assert bounds([fabric])[2] == pytest.approx((0.08, 2.4))
    stage, p = build(tmp_path, [feature("fence", points=[[-500, 0], [500, 0]])])
    assert stage["triangle_count"] < 100000
    assert all(len(m["triangles"]) <= 20000 for m in p["meshes"])
    assert any(m["material"] == "chainlink" for m in p["meshes"])
    assert all(hi - lo <= 126 for m in p["meshes"] for lo, hi in bounds([m])[:2])


def test_fence_can_anchor_each_input_segment(tmp_path):
    _, p = build(tmp_path, [feature("fence", points=[[0, 0], [3, 0], [3, 4]], ground_anchor=[[1.5, 0], [3, 2]])])
    assert {tuple(m["anchor_m"]) for m in p["meshes"]} == {(1.5, 0), (3, 2)}


def test_generated_prop_outside_tile_reports_feature(tmp_path):
    with pytest.raises(SiteError, match="measured-1.*outside tile"):
        build(tmp_path, [feature("bench", point=[629.9, 0])])


def test_empty_inventory_and_deterministic_file(tmp_path):
    stage, payload = build(tmp_path, [])
    assert stage["feature_count"] == stage["triangle_count"] == 0
    assert payload["meshes"] == [] and payload["counts"] == {}
    fs = [
        feature("bench", point=[3, 7]),
        {**feature("surface", ring=[[0, 0], [6, 0], [4, 5]], material="clay"), "id": "ground"},
    ]
    a, _ = build(tmp_path, fs)
    first = (tmp_path / "out" / "streetscape.json").read_bytes()
    b, _ = build(tmp_path, fs)
    assert a == b
    assert (tmp_path / "out" / "streetscape.json").read_bytes() == first


@pytest.mark.parametrize("kind", ["bench", "goalpost", "soccer_goal"])
def test_props_require_measured_heading(tmp_path, kind):
    f = feature(kind, point=[0, 0])
    del f["heading_deg"]
    with pytest.raises(SiteError, match="measured-1.*heading_deg"):
        build(tmp_path, [f])


@pytest.mark.parametrize(
    "material,offset",
    [
        ("asphalt", 0.04),
        ("concrete", 0.04),
        ("track", 0.05),
        ("gravel", 0.04),
        ("clay", 0.04),
    ],
)
def test_surface_material_offsets(tmp_path, material, offset):
    _, p = build(tmp_path, [feature("surface", ring=[[0, 0], [3, 0], [0, 4]], material=material)])
    assert all(m["material"] == material for m in p["meshes"])
    assert all(v[2] == offset for m in p["meshes"] for v in m["vertices"])


def test_long_curb_is_spatially_bounded_and_keeps_measured_dimensions(tmp_path):
    _, p = build(tmp_path, [feature("curb", points=[[-500, 1], [500, 1]], width_m=0.2, height_m=0.3)])
    assert bounds(p["meshes"])[1] == pytest.approx((0.9, 1.1))
    assert bounds(p["meshes"])[2] == pytest.approx((-0.05, 0.3))
    assert all(hi - lo <= 126 for m in p["meshes"] for lo, hi in bounds([m])[:2])


def test_ground_faces_up_and_paint_batches_share_draws(tmp_path):
    fs = [
        {**feature("line", points=[[10, y], [20, y]], material="paint_white", width_m=0.1), "id": str(y)}
        for y in range(10, 30, 3)
    ]
    _, payload = build(tmp_path, fs)
    assert len(payload["meshes"]) == 1
    assert not payload["meshes"][0]["collision"]
    for a, b, c in triangles(payload):
        assert (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0


def test_grass_mask_uses_landscape_east_north_axes(tmp_path):
    stage, _ = build(
        tmp_path, [feature("surface", material="asphalt", ring=[[40, 90], [60, 90], [60, 110], [40, 110]])]
    )
    mask = np.asarray(Image.open(tmp_path / "out" / stage["grass_mask"]))

    def at(east, north):
        return mask[int((east / TILE.size_m + 0.5) * 2048), int((north / TILE.size_m + 0.5) * 2048)]

    assert at(50, 100) == 0
    assert at(100, 50) == 255
    assert at(0, 0) == 255


@pytest.mark.parametrize(
    "kind,dimensions",
    [
        ("bleacher", {"points": [[0, 0], [3, 0]], "rise_m": 0.03}),
        ("bleacher", {"points": [[0, 0], [3, 0]], "rise_m": 0.02}),
        ("fence", {"points": [[0, 0], [3, 0]], "height_m": 0.08}),
        ("fence", {"points": [[0, 0], [3, 0]], "height_m": 0.05}),
    ],
)
def test_construction_clearance_rejects_degenerate_geometry(tmp_path, kind, dimensions):
    with pytest.raises(SiteError, match="measured-1"):
        build(tmp_path, [feature(kind, **dimensions)])


def test_paint_does_not_carve_wide_bare_strips_in_turf(tmp_path):
    stage, payload = build(tmp_path, [feature("line", material="paint_white", points=[[10, 10], [50, 10]])])
    assert payload["meshes"]
    assert np.all(np.asarray(Image.open(tmp_path / "out" / stage["grass_mask"])) == 255)
    assert payload["evidence"][0]["evidence"] == feature("line")["evidence"]


def test_paving_follows_the_landscape_quad_grid(tmp_path):
    fine_tile = Tile(0, 0, 0.5, 2520)
    _, payload = build(
        tmp_path,
        [feature("surface", ring=[[10, 10], [20, 10], [20, 14], [10, 14]], material="asphalt")],
        tile=fine_tile,
    )
    for tri in triangles(payload):
        assert max(math.dist(a[:2], b[:2]) for a in tri for b in tri) <= math.sqrt(2) * fine_tile.quad_m + 1e-9


def test_pipeline_tracks_source_reuses_stage_and_rebuilds_missing_mask(tmp_path):
    from envgen.build import build as build_site

    from . import helpers

    helpers.write_dem(tmp_path / "dem.tif")
    helpers.write_imagery(tmp_path / "imagery.tif", split_easting=helpers.WEST + 63)
    site = helpers.write_site(tmp_path)
    raw = json.loads(site.read_text())
    measured = tmp_path / "measured.json"
    measured.write_text(json.dumps(inventory([feature("bench", point=[0, 0])])))
    raw["sources"]["streetscape"] = {"kind": "file", "path": measured.name, "license": "CC0", "date": "2030-01-01"}
    site.write_text(json.dumps(raw))
    out = tmp_path / "built"
    first = build_site(site, out)
    assert first["streetscape"]["counts"] == {"bench": 1}
    assert first["sources"]["streetscape"]["path"] == str(measured)
    assert first["streetscape"]["grass_mask"] in first["artifacts"]
    assert "streetscape" in build_site(site, out)["stages_reused"]
    (out / first["streetscape"]["grass_mask"]).unlink()
    assert "streetscape" not in build_site(site, out)["stages_reused"]
    raw["sources"].pop("streetscape")
    site.write_text(json.dumps(raw))
    absent = build_site(site, out)
    assert "streetscape" not in absent
    assert "streetscape" not in absent["sources"]
    assert "streetscape.json" not in absent["artifacts"]


@pytest.mark.parametrize("quad_m", [0.5, 1.0, 2.0])
def test_paving_clearance_across_a_nonplanar_landscape_quad(tmp_path, quad_m):
    tile = Tile(10000, 20000, quad_m, 3)
    origin = -tile.size_m / 2
    ring = [[origin + x * quad_m, origin + y * quad_m] for x, y in [(0.1, 0.4), (0.9, 0.4), (0.5, 0.8)]]
    _, payload = build(tmp_path, [feature("surface", ring=ring, material="asphalt")], tile=tile)

    def terrain(east, north):
        x, y = (east - origin) / quad_m, (north - origin) / quad_m
        # Landscape's 00--11 diagonal joins two high corners of this saddle.
        return 0.2 * (1 - abs(x - y))

    for triangle in triangles(payload):
        lifted = [(e, n, terrain(e, n) + z) for e, n, z in triangle]
        for weights in [(1 / 3,) * 3, (0.2, 0.3, 0.5), (0.6, 0.1, 0.3)]:
            east, north, height = [sum(w * v[axis] for w, v in zip(weights, lifted)) for axis in range(3)]
            assert height - terrain(east, north) == pytest.approx(0.04, abs=1e-9)


def test_playing_turf_preserves_grass_and_clay_still_excludes_it(tmp_path):
    _, payload = build(
        tmp_path,
        [
            feature("surface", material="turf", ring=[[10, 10], [20, 10], [20, 20], [10, 20]]),
            {**feature("surface", material="clay", ring=[[13, 13], [17, 13], [17, 17], [13, 17]]), "id": "clay"},
        ],
    )
    mask = np.asarray(Image.open(tmp_path / "out" / "streetscape_grass.png"))

    def at(east, north):
        return mask[
            int((east + TILE.size_m / 2) / TILE.size_m * mask.shape[0]),
            int((north + TILE.size_m / 2) / TILE.size_m * mask.shape[1]),
        ]

    assert at(11, 11) == 255
    assert at(15, 15) == 0
    assert {v[2] for mesh in payload["meshes"] if mesh["material"] == "turf" for v in mesh["vertices"]} == {0.025}
