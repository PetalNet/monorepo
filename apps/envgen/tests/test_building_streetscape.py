"""Tagged structural grandstands take precedence over overlapping generic seating kits."""

import json

import pytest
from shapely.affinity import translate
from shapely.geometry import Polygon

from envgen.site import SiteError, Tile
from envgen.streetscape import build_inventory, load_inventory

from .test_streetscape import decal_png, feature, inventory

TILE = Tile(10000, 20000, 1, 126)


def stand(kind="grandstand"):
    polygon = Polygon([(0, -20), (20, -20), (20, 40), (0, 40)])
    return [{"polygon": translate(polygon, *TILE.centre), "tags": {"building": kind}}]


def seating(ident, east, rows):
    return feature("bleacher", id=ident, points=[[east, -20], [east, 40]], rows=rows, step_m=0.8, rise_m=0.3)


def test_overlapping_seating_is_claimed_and_separate_seating_keeps_its_geometry(tmp_path):
    path = tmp_path / "input.json"
    path.write_text(
        json.dumps(inventory([seating("inside", 18, 12), seating("edge", 29, 22), seating("outside", 60, 3)]))
    )
    stage = build_inventory(path, TILE, tmp_path, stand())
    payload = json.loads((tmp_path / "streetscape.json").read_text())
    assert stage["counts"] == {"bleacher": 1} and stage["feature_count"] == 1
    assert {f["id"] for f in stage["claimed_bleachers"]} == {"inside", "edge"}
    assert {f["id"] for f in payload["evidence"]} == {"outside"}
    assert payload["meshes"] and all(m["anchor_m"][0] == 60 for m in payload["meshes"])


def test_an_ordinary_building_does_not_claim_generic_seating(tmp_path):
    path = tmp_path / "input.json"
    path.write_text(json.dumps(inventory([seating("inside", 18, 12)])))
    stage = build_inventory(path, TILE, tmp_path, stand("school"))
    assert stage["counts"] == {"bleacher": 1} and not stage["claimed_bleachers"]


def test_invalid_seating_is_rejected_even_when_a_grandstand_would_own_it(tmp_path):
    invalid = seating("invalid", 18, 12)
    invalid["points"] = [[18, 0], [18, 0]]
    path = tmp_path / "input.json"
    path.write_text(json.dumps(inventory([invalid])))
    with pytest.raises(SiteError):
        build_inventory(path, TILE, tmp_path, stand())


def test_prevalidated_paint_and_building_owned_seating_coexist(tmp_path):
    original = decal_png(tmp_path / "mark.png")
    path = tmp_path / "input.json"
    path.write_text(
        json.dumps(
            inventory(
                [
                    seating("inside", 18, 12),
                    feature("decal", id="paint", image="mark.png", bounds_m=[-5, -5, 5, 5]),
                ]
            )
        )
    )
    prepared = load_inventory(path, TILE)
    (tmp_path / "mark.png").write_bytes(b"changed after validation")
    out = tmp_path / "out"
    stage = build_inventory(path, TILE, out, stand(), inventory=prepared)
    assert stage["counts"] == {"decal": 1}
    assert [item["id"] for item in stage["claimed_bleachers"]] == ["inside"]
    image = next(name for name in stage["files"] if name.startswith("streetscape_decal_"))
    assert (out / image).read_bytes() == original
    assert [item["id"] for item in prepared.features] == ["inside", "paint"]
