"""Fragment candidates depend on pixels, source identity, and projected evidence bounds."""

import copy
import json

import numpy as np
import pytest
from rasterio.transform import Affine
from scipy.ndimage import gaussian_filter

from envgen import observations

TRANSFORM = Affine(0.02256961031675321, 0, 606668.2601857221,
                   0, -0.022568633615702844, 4200891.238986638)
# Frozen cuts from native-classifier.conservative.json, never defaults in implementation.
CUTS = {"light6_gt": 0.7193485772795976,
        "red_minus_blue_fraction_lt": 0.013114269642182989, "exg6_lt": 0}


def evidence(transform=TRANSFORM, bounds=(0, 0, 160, 160)):
    left, top, right, bottom = bounds
    corners = [transform * (col, row) for col in (left, right) for row in (top, bottom)]
    xs, ys = zip(*corners)
    return {"schema_version": 1, "source": {"sha256": "abc", "crs": "EPSG:32615"},
            "ground_classifier": CUTS.copy(),
            "features": [{"feature_type": "bare_soil_worn_strip", "confidence": 0.8,
                          "bounds_projected_m": [min(xs), min(ys), max(xs), max(ys)]}]}


def scene():
    rgb = np.empty((3, 160, 160), dtype=np.uint8)
    rgb[:] = np.array([110, 150, 85])[:, None, None]
    rgb[:, 40:120, 60:100] = np.array([210, 193, 215])[:, None, None]
    return rgb, np.ones((160, 160), np.float32), np.zeros((160, 160), np.float32)


def run(rgb, alpha, height, ev=None, transform=TRANSFORM):
    return observations.exposed_fragments(rgb, alpha, height, transform, ev or evidence())


def test_pixels_differentiate_inside_envelope_without_filling_a_box():
    rgb, alpha, height = scene()
    share = run(rgb, alpha, height)
    assert share.shape == alpha.shape and share.dtype == np.float32
    assert share[80, 80] > 0.99
    assert share[20, 20] == 0
    assert np.count_nonzero(share) < alpha.size / 4
    assert ((share > 0) & (share < 1)).any()
    assert share.min() >= 0 and share.max() <= 1


def test_classifier_absent_is_explicitly_inactive():
    rgb, alpha, height = scene()
    ev = evidence()
    del ev["ground_classifier"]
    assert not run(rgb, alpha, height, ev).any()


@pytest.mark.parametrize("colour", [[110, 150, 85], [190, 160, 130], [150, 140, 145]])
def test_grass_controls_inside_bare_envelope_receive_no_soil(colour):
    rgb, alpha, height = scene()
    rgb[:] = np.array(colour)[:, None, None]
    assert not run(rgb, alpha, height).any()


def test_alpha_invalid_and_partial_rgb_cannot_bleed_into_candidates():
    rgb, alpha, height = scene()
    alpha[:, :80] = 0
    alpha[50:70, 80:90] = 0.5
    before = run(rgb, alpha, height)
    changed = rgb.copy()
    changed[:, alpha < 1] = np.random.default_rng(42).integers(0, 256, (3, int((alpha < 1).sum())))
    after = run(changed, alpha, height)
    np.testing.assert_array_equal(before, after)
    assert not after[alpha < 1].any()
    assert after[80, 82] > 0.99
    assert not run(changed, np.zeros_like(alpha), height).any()


def test_height_nan_and_shadow_reject_even_at_bright_fragment_edges():
    rgb, alpha, height = scene()
    height[80, 80] = 2.01
    height[81, 80] = np.nan
    rgb[:, 82, 80] = [20, 15, 35]
    rgb[:, 85:100, 70:90] = np.array([65, 55, 95])[:, None, None]
    share = run(rgb, alpha, height)
    assert not share[80:83, 80].any()
    assert not share[90:95, 75:85].any()
    assert share[60, 80] > 0.99
    height[60, 80] = 2
    assert run(rgb, alpha, height)[60, 80] > 0.99


def test_only_high_confidence_bare_envelopes_admit_candidates():
    rgb, alpha, height = scene()
    ev = evidence(bounds=(70, 50, 90, 110))
    share = run(rgb, alpha, height, ev)
    assert share[80, 80] > 0.99
    assert not share[:, :70].any() and not share[:, 90:].any()
    assert not share[:50].any() and not share[110:].any()
    ev["features"][0]["confidence"] = 0.799
    assert not run(rgb, alpha, height, ev).any()
    ev["features"][0].update(feature_type="grass_dry", confidence=1)
    assert not run(rgb, alpha, height, ev).any()


@pytest.mark.parametrize("rotation", [0, 23])
def test_halo_blocks_and_overlapping_reads_agree_in_projected_coords(rotation):
    rgb, alpha, height = scene()
    rng = np.random.default_rng(9)
    rgb = np.clip(rgb.astype(int) + rng.integers(-12, 13, rgb.shape), 0, 255).astype(np.uint8)
    alpha[40:50, 75:85] = 0
    height[90:95, 80:85] = 4
    transform = (Affine.translation(TRANSFORM.c, TRANSFORM.f) * Affine.rotation(rotation)
                 * Affine.scale(TRANSFORM.a, TRANSFORM.e))
    ev = evidence(transform, (65, 35, 95, 125))
    full = run(rgb, alpha, height, ev, transform)
    # 16 pixels exceed four sigma (about 11 pixels at native resolution).
    for left, right in [(20, 90), (70, 145)]:
        top, bottom = 20, 140
        ys, xs = slice(top-16, bottom+16), slice(left-16, min(right+16, 160))
        block_transform = transform * Affine.translation(left-16, top-16)
        block = run(rgb[:, ys, xs], alpha[ys, xs], height[ys, xs], ev, block_transform)
        np.testing.assert_array_equal(block[16:16+bottom-top, 16:16+right-left], full[top:bottom, left:right])
    assert full.any()


def test_indices_match_native_experiment_at_supplied_cut():
    rgb, alpha, height = scene()
    r, g, b = rgb.astype(np.float32) / 255
    valid = alpha == 1
    sigma = (0.06 / abs(TRANSFORM.e), 0.06 / TRANSFORM.a)
    support = gaussian_filter(valid.astype(np.float32), sigma, mode="constant")
    light = gaussian_filter((r+g+b)/3, sigma, mode="constant") / support
    ev = evidence()
    ev["ground_classifier"]["light6_gt"] = float(light[80, 80])
    share = run(rgb, alpha, height, ev)
    assert share[80, 80] == pytest.approx(0.5, abs=1e-5)


def test_read_retains_unknown_feature_types(tmp_path):
    ev = evidence()
    ev["features"].append(dict(ev["features"][0], feature_type="future_observation", note="retained"))
    path = tmp_path / "observations.json"
    path.write_text(json.dumps(ev))
    assert observations.read(path, "abc", "EPSG:32615") == ev
    del ev["ground_classifier"]
    path.write_text(json.dumps(ev))
    assert observations.read(path, "abc", "EPSG:32615") == ev


@pytest.mark.parametrize("change", [
    {"schema_version": 2}, {"schema_version": True}, {"source": {}}, {"features": {}},
    {"features": [None]}, {"features": [{"feature_type": "x", "confidence": 1, "bounds_projected_m": [0, 0, 0, 1]}]},
    {"ground_classifier": None}, {"ground_classifier": {}},
    {"ground_classifier": dict(CUTS, unsupported=0)},
    {"ground_classifier": dict(CUTS, light6_gt=float("nan"))},
    {"ground_classifier": dict(CUTS, light6_gt=float("inf"))},
    {"ground_classifier": dict(CUTS, light6_gt=1.01)},
    {"ground_classifier": dict(CUTS, light6_gt=True)},
    {"ground_classifier": dict(CUTS, light6_gt="0.7")},
])
def test_read_rejects_invalid_external_input(tmp_path, change):
    ev = evidence()
    ev.update(change)
    path = tmp_path / "observations.json"
    path.write_text(json.dumps(ev))
    with pytest.raises(ValueError):
        observations.read(path, "abc", "EPSG:32615")


@pytest.mark.parametrize("field,value", [("confidence", float("nan")), ("confidence", -0.1),
                                         ("bounds_projected_m", [0, 0, float("inf"), 1]),
                                         ("bounds_projected_m", [0, 2, 1, 1])])
def test_read_rejects_invalid_feature_numbers(tmp_path, field, value):
    ev = copy.deepcopy(evidence())
    ev["features"][0][field] = value
    path = tmp_path / "observations.json"
    path.write_text(json.dumps(ev))
    with pytest.raises(ValueError):
        observations.read(path, "abc", "EPSG:32615")


@pytest.mark.parametrize("sha,crs", [("wrong", "EPSG:32615"), ("abc", "EPSG:4326")])
def test_read_rejects_source_mismatch(tmp_path, sha, crs):
    path = tmp_path / "observations.json"
    path.write_text(json.dumps(evidence()))
    with pytest.raises(ValueError):
        observations.read(path, sha, crs)


def test_read_wraps_missing_and_malformed_files(tmp_path):
    path = tmp_path / "missing.json"
    with pytest.raises(ValueError):
        observations.read(path, "abc", "EPSG:32615")
    path.write_text("{")
    with pytest.raises(ValueError):
        observations.read(path, "abc", "EPSG:32615")
