"""Tagged structural grandstands take precedence over overlapping generic seating kits."""

import json

import pytest
from shapely.affinity import translate
from shapely.geometry import Polygon

from envgen.site import SiteError, Tile
from envgen.streetscape import build_inventory

from .test_streetscape import feature, inventory

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
