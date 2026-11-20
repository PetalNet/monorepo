"""Source-bound observation envelopes and conservative exposed-ground candidates."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter

_CLASSIFIER_FIELDS = {"light6_gt", "red_minus_blue_fraction_lt", "exg6_lt"}
# Numeric priors, not fitted parameters: compact transition half-widths in index units.
_TRANSITION = {"light6_gt": 0.01, "red_minus_blue_fraction_lt": 0.002, "exg6_lt": 0.005}
_SMOOTH_M = 0.06
_DARK_LIGHT = 0.22  # Same encoded-RGB dark-pixel definition as the native experiment.


class ObservationError(ValueError):
    """Observation evidence is malformed or belongs to a different survey."""


def non_tree_features(evidence: dict) -> list[dict]:
    """Confidently identified objects which height alone could mistake for vegetation."""
    return [feature for feature in evidence["features"]
            if feature["feature_type"] == "temporary_canopy" and feature["confidence"] >= 0.95]


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read(path: str | Path, ortho_sha256: str, crs: str) -> dict:
    """Validate schema-1 observations against the orthophoto identity; retain unknown feature types."""
    try:
        evidence = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read observations: {error}") from error
    if not isinstance(evidence, dict) or type(evidence.get("schema_version")) is not int or evidence["schema_version"] != 1:
        raise ValueError("Observations require schema_version 1")
    source = evidence.get("source")
    if not isinstance(source, dict) or source.get("sha256") != ortho_sha256 or source.get("crs") != str(crs):
        raise ValueError("Observations source SHA-256 and CRS must match the orthophoto")
    if not isinstance(evidence.get("features"), list):
        raise ObservationError("Observations features must be a list")
    for feature in evidence["features"]:
        if not isinstance(feature, dict) or not isinstance(feature.get("feature_type"), str):
            raise ObservationError("Each observation requires a feature_type")
        confidence = feature.get("confidence")
        if not _number(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Observation confidence must be finite and in [0, 1]")
        bounds = feature.get("bounds_projected_m")
        if (not isinstance(bounds, list) or len(bounds) != 4 or not all(_number(v) for v in bounds)
                or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]):
            raise ValueError("Observation projected bounds must be finite ascending [west, south, east, north]")
    if "ground_classifier" in evidence:
        classifier = evidence["ground_classifier"]
        if not isinstance(classifier, dict) or set(classifier) != _CLASSIFIER_FIELDS:
            raise ValueError("ground_classifier requires exactly light6_gt, red_minus_blue_fraction_lt, exg6_lt")
        if not all(_number(v) and -1 <= v <= 1 for v in classifier.values()):
            raise ValueError("ground_classifier cuts must be finite numbers in [-1, 1]")
    return evidence


def _ramp(distance: np.ndarray, width: float) -> np.ndarray:
    t = np.clip((distance + width) / (2 * width), 0, 1)
    return t * t * (3 - 2 * t)


def exposed_fragments(rgb: np.ndarray, alpha: np.ndarray, height: np.ndarray, transform, evidence: dict) -> np.ndarray:
    """Return float32 candidate soil shares, conditional on full alpha, not calibrated probabilities.

    Inputs use encoded uint8 RGB [3,H,W], alpha [H,W] in [0,1], and height
    above ground in metres. Transform maps pixel edges to projected metre coordinates.
    Supply at least the Gaussian's four-sigma halo when processing block interiors.
    Partial-alpha samples are excluded, matching the conservative native experiment.
    """
    result = np.zeros(alpha.shape, dtype=np.float32)
    classifier = evidence.get("ground_classifier")
    if classifier is None:
        return result

    cols = np.arange(alpha.shape[1], dtype=np.float64)[None, :] + 0.5
    rows = np.arange(alpha.shape[0], dtype=np.float64)[:, None] + 0.5
    x = transform.a * cols + transform.b * rows + transform.c
    y = transform.d * cols + transform.e * rows + transform.f
    allowed = np.zeros(alpha.shape, dtype=bool)
    for feature in evidence["features"]:
        if feature["feature_type"].startswith("bare_soil_") and feature["confidence"] >= 0.8:
            west, south, east, north = feature["bounds_projected_m"]
            allowed |= (x >= west) & (x < east) & (y >= south) & (y < north)
    if not allowed.any():
        return result

    # Rotation is fine; shear would require a nonseparable projected Gaussian.
    col_m = math.hypot(transform.a, transform.d)
    row_m = math.hypot(transform.b, transform.e)
    if (not math.isfinite(col_m * row_m) or min(col_m, row_m) <= 0
            or not math.isclose(transform.a * transform.b + transform.d * transform.e, 0,
                                abs_tol=1e-8 * col_m * row_m)):
        raise ValueError("Fragment smoothing requires orthogonal, finite projected metre pixel axes")
    sigma = (_SMOOTH_M / row_m, _SMOOTH_M / col_m)
    valid = alpha == 1
    support = gaussian_filter(valid.astype(np.float32), sigma, mode="constant", truncate=4)
    encoded = rgb.astype(np.float32) / 255
    r, g, b = encoded
    light = encoded.mean(axis=0)
    total = np.maximum(r + g + b, 1e-5)
    indices = {"light6_gt": light, "red_minus_blue_fraction_lt": (r - b) / total,
               "exg6_lt": (2 * g - r - b) / total}
    share = np.ones(alpha.shape, dtype=np.float32)
    for name, index in indices.items():
        smooth = gaussian_filter(np.where(valid, index, 0), sigma, mode="constant", truncate=4)
        smooth /= np.maximum(support, 1e-6)
        distance = smooth - classifier[name] if name.endswith("_gt") else classifier[name] - smooth
        share *= _ramp(distance, _TRANSITION[name])
    visible = valid & np.isfinite(height) & (height <= 2) & (light >= _DARK_LIGHT)
    return np.where(allowed & visible, share, 0).astype(np.float32)
