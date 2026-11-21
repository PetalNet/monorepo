"""Field decisions alter surface construction and markings together."""

import copy
import io
import json

import numpy as np
import pytest
from PIL import Image

from envgen.athletic import colour_atlas
from envgen.site import SiteError
from envgen.streetscape import build_inventory
from tests.test_streetscape import TILE, feature, inventory


def scene():
    surface = feature("surface", material="turf", ring=[[0, 0], [4, 0], [4, 8], [0, 8]])
    surface["id"] = "field"
    line = feature("line", material="paint_white", points=[[-1, 4], [5, 4]], width_m=0.12)
    line["id"] = "line"
    raw = inventory([surface, line])
    raw["fields"] = [
        {
            "surface_id": "field",
            "classification": "athletic_turf",
            "evidence": "uniform fibers in image A",
            "confidence": 0.9,
            "heading_deg": 88,
        }
    ]
    return raw


def build(tmp_path, raw):
    path = tmp_path / "input.json"
    path.write_text(json.dumps(raw))
    out = tmp_path / "out"
    stage = build_inventory(path, TILE, out)
    return stage, json.loads((out / "streetscape.json").read_text()), out


def test_inlays_are_opaque_colour_in_same_surface(tmp_path):
    stage, payload, out = build(tmp_path, scene())
    synthetic = [m for m in payload["meshes"] if m["material"] == "athletic_turf"]
    assert synthetic and all(m["heading_deg"] == 88 for m in synthetic)
    assert len({m["image"] for m in synthetic}) == 1
    for mesh in payload["meshes"]:
        if mesh["material"] == "paint_white":
            # Only the parts outside the synthetic field remain separate ribbons.
            assert all(v[0] <= 0 or v[0] >= 4 for v in mesh["vertices"])
    atlas = np.asarray(Image.open(out / synthetic[0]["image"]))
    assert np.all(atlas[:, :, 3] == 255)
    assert np.mean(atlas[len(atlas) // 2, :, :3]) > np.mean(atlas[0, :, :3])
    assert np.min(np.asarray(Image.open(out / "streetscape_grass.png"))) == 0
    assert stage["fields"][0]["effective_surface"] == "athletic_turf"


def test_override_changes_material_paint_and_grass_together(tmp_path):
    raw = scene()
    raw["fields"][0]["override"] = "natural_grass"
    _, payload, out = build(tmp_path, raw)
    assert {m["material"] for m in payload["meshes"]} == {"grass_paint_white", "paint_white"}
    assert np.min(np.asarray(Image.open(out / "streetscape_grass.png"))) == 255
    record = payload["fields"][0]
    assert record["classification"] == "athletic_turf" and record["effective_surface"] == "natural_grass"


@pytest.mark.parametrize(
    "change",
    [
        {"surface_id": "missing"},
        {"classification": "grass"},
        {"override": []},
        {"confidence": float("nan")},
        {"heading_deg": float("inf")},
        {"stripe_width_m": 0},
        {"evidence": ""},
        {"unknown": 1},
    ],
)
def test_invalid_decision_rejected(tmp_path, change):
    raw = scene()
    raw["fields"][0].update(change)
    with pytest.raises(SiteError):
        build(tmp_path, raw)


def test_duplicate_and_overlapping_fields_rejected(tmp_path):
    raw = scene()
    raw["fields"].append(copy.deepcopy(raw["fields"][0]))
    with pytest.raises(SiteError, match="unique"):
        build(tmp_path, raw)
    raw["fields"][1]["surface_id"] = "overlap"
    raw["features"].append({**raw["features"][0], "id": "overlap"})
    with pytest.raises(SiteError, match="overlap"):
        build(tmp_path, raw)


def test_direct_surface_class_and_artifact_colour_changes(tmp_path):
    raw = scene()
    raw.pop("fields")
    raw["features"][0]["material"] = "athletic_turf"
    _, first, _ = build(tmp_path, raw)
    raw["features"][1]["material"] = "paint_yellow"
    _, second, _ = build(tmp_path, raw)
    assert first["meshes"][0]["image"] != second["meshes"][0]["image"]


def test_closed_boundary_keeps_green_interior(tmp_path):
    raw = scene()
    raw["features"][1]["points"] = [[0.2, 0.2], [3.8, 0.2], [3.8, 7.8], [0.2, 7.8], [0.2, 0.2]]
    _, payload, out = build(tmp_path, raw)
    image = Image.open(out / payload["meshes"][0]["image"])
    centre = image.getpixel((image.width // 2, image.height // 2))
    assert centre[:3] == (48, 100, 56)
    assert max(image.getpixel((7, image.height // 2))[:3]) > 150


def test_large_registered_image_is_cropped_before_resizing(tmp_path):
    raw = scene()
    raw["features"] = raw["features"][:1]
    raw["features"].append(feature("decal", image="mark.png", bounds_m=[-500, -500, 500, 500]))
    Image.new("RGBA", (8, 8), (240, 200, 30, 255)).save(tmp_path / "mark.png")
    import io

    _, data, _ = colour_atlas(raw["features"][0], raw["features"], {"mark.png": (tmp_path / "mark.png").read_bytes()})
    atlas = Image.open(io.BytesIO(data))
    assert atlas.width < 512 and atlas.height < 512
    assert atlas.getpixel((atlas.width // 2, atlas.height // 2)) == (240, 200, 30, 255)


def test_direct_natural_surface_classifies_its_paint(tmp_path):
    raw = scene()
    raw.pop("fields")
    raw["features"][0]["material"] = "natural_grass"
    _, payload, _ = build(tmp_path, raw)
    assert payload["fields"][0]["effective_surface"] == "natural_grass"
    assert "grass_paint_white" in {m["material"] for m in payload["meshes"]}
    assert all(v[2] == 0.027 for m in payload["meshes"] if m["material"] == "grass_paint_white" for v in m["vertices"])


def test_unmarked_natural_field_has_landscape_only_artifact(tmp_path):
    raw = scene()
    raw["features"] = raw["features"][:1]
    raw["fields"][0]["classification"] = "natural_grass"
    stage, payload, _ = build(tmp_path, raw)
    assert payload["feature_count"] == 1 and payload["meshes"] == []
    assert payload["counts"] == {"surface": 1}
    assert len(payload["fields"]) == 1 and stage["fields"][0]["effective_surface"] == "natural_grass"


@pytest.mark.parametrize("surface", ["athletic_turf", "natural_grass"])
def test_clay_and_track_marks_stay_above_the_hard_surface(tmp_path, surface):
    raw = scene()
    raw["fields"][0]["classification"] = surface
    raw["features"].append(
        {**feature("surface", material="clay", ring=[[0, 2], [4, 2], [4, 6], [0, 6]]), "id": "infield"}
    )
    _, payload, _ = build(tmp_path, raw)
    assert "grass_paint_white" not in {m["material"] for m in payload["meshes"]}
    paint = [v for m in payload["meshes"] if m["material"] == "paint_white" for v in m["vertices"]]
    assert paint and all(v[2] == 0.07 for v in paint)
    for mesh in payload["meshes"]:
        if mesh["material"] != "athletic_turf":
            continue
        for tri in mesh["triangles"]:
            centre = [sum(mesh["vertices"][i][axis] for i in tri) / 3 for axis in (0, 1)]
            assert not (0 < centre[0] < 4 and 2 < centre[1] < 6)


def test_synthetic_line_between_atlas_pixel_centers():
    surface = feature("surface", material="athletic_turf", ring=[[0, 0], [3, 0], [3, 3], [0, 3]])
    line = feature("line", material="paint_white", points=[[0, 1.5], [3, 1.5]], width_m=0.004)
    _, data, _ = colour_atlas(surface, [line], {})
    pixels = np.asarray(Image.open(io.BytesIO(data)))
    center = len(pixels) // 2
    assert np.any(np.all(pixels[center - 1 : center + 1, :, :3] > 200, axis=2))
    assert np.all(pixels[0, :, 0] < 100)
