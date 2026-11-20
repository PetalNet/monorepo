"""Additional footprints and sports features for downstream builders; no geometry merging."""

from __future__ import annotations

import json

from .site import Source


def load(source: Source, kind: str) -> list[dict]:
    """Read WGS84 GeoJSON, retaining original properties and naming height estimates explicitly."""
    from pathlib import Path

    collection = json.loads(Path(source.location).read_text())
    if collection.get("type") != "FeatureCollection":
        raise ValueError(f"{source.location}: expected a GeoJSON FeatureCollection")
    found = []
    for feature in collection["features"]:
        properties = dict(feature.get("properties") or {})
        if kind == "microsoft":
            height = properties.get("height")
            properties["height_m"] = height if isinstance(height, (int, float)) and height > 0 else None
            properties["height_evidence"] = "Microsoft model estimate, not surveyed"
        found.append(feature | {"properties": properties})
    return found
