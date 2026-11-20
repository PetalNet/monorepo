"""Field classification and registered colour inlays for synthetic sports surfaces."""

from __future__ import annotations

import hashlib
import io
import math

from PIL import Image, ImageFilter
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.geometry import LineString, Polygon, box

from .site import SiteError

SURFACE_CLASSES = {"athletic_turf", "natural_grass"}
ATLAS_SPACING_M = 0.03
MAX_ATLAS_SIDE = 8192
MAX_ATLAS_PIXELS = 32_000_000
# Appearance priors in sRGB; the renderer applies the same fiber finish to every colour.
TURF_GREEN = (48, 100, 56, 255)
MARK_COLOURS = {"paint_white": (232, 231, 239, 255), "paint_yellow": (220, 181, 60, 255)}


def classify_fields(raw, features):
    """Resolve evidence-backed field decisions and optional per-field config overrides."""
    if not isinstance(raw, list):
        raise SiteError("streetscape.fields: expected an array")
    surfaces = {f["id"]: f for f in features if f["type"] == "surface"}
    records, seen = [], set()
    for field in raw:
        if not isinstance(field, dict) or set(field) - {
            "surface_id",
            "classification",
            "override",
            "evidence",
            "confidence",
            "heading_deg",
            "stripe_width_m",
        }:
            raise SiteError("streetscape.fields: invalid field record")
        ident = field.get("surface_id")
        if not isinstance(ident, str) or ident not in surfaces or ident in seen:
            raise SiteError("streetscape.fields: surface_id must name a unique surface")
        seen.add(ident)
        if surfaces[ident]["material"] not in {"turf", *SURFACE_CLASSES}:
            raise SiteError(f"field {ident}: surface must be turf or natural_grass")
        classification = field.get("classification")
        effective = field.get("override", classification)
        if (
            not isinstance(classification, str)
            or classification not in SURFACE_CLASSES
            or not isinstance(effective, str)
            or effective not in SURFACE_CLASSES
        ):
            raise SiteError(f"field {ident}: expected athletic_turf or natural_grass")
        evidence, confidence = field.get("evidence"), field.get("confidence")
        if not isinstance(evidence, str) or not evidence.strip():
            raise SiteError(f"field {ident}: evidence is required")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise SiteError(f"field {ident}: confidence must be in [0,1]")
        heading, stripe = field.get("heading_deg", 0), field.get("stripe_width_m", 4.572)
        for name, value in (("heading_deg", heading), ("stripe_width_m", stripe)):
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                raise SiteError(f"field {ident}: {name} must be finite")
        if not 0 < stripe <= 100:
            raise SiteError(f"field {ident}: stripe_width_m must be in (0,100]")
        records.append({**field, "effective_surface": effective, "heading_deg": heading, "stripe_width_m": stripe})
    for f in surfaces.values():
        if f["material"] in SURFACE_CLASSES and f["id"] not in seen:
            records.append(
                {
                    "surface_id": f["id"],
                    "classification": f["material"],
                    "effective_surface": f["material"],
                    "evidence": f["evidence"],
                    "confidence": f["confidence"],
                    "heading_deg": 0,
                    "stripe_width_m": 4.572,
                }
            )
    for i, first in enumerate(records):
        a = Polygon(surfaces[first["surface_id"]]["ring"])
        for second in records[i + 1 :]:
            if a.intersection(Polygon(surfaces[second["surface_id"]]["ring"])).area > 1e-6:
                raise SiteError("streetscape.fields: field surfaces must not overlap")
    return records


def marking_polygon(feature):
    if feature["type"] == "line" and feature["material"] in MARK_COLOURS:
        return LineString(feature["points"]).buffer(feature["width_m"] / 2, cap_style="flat", join_style="mitre")
    if feature["type"] == "decal":
        return box(*feature["bounds_m"])
    return None


def colour_atlas(surface, features, images):
    """Bake colour regions onto one opaque surface, so markings share its fibers and height."""
    bounds = Polygon(surface["ring"]).bounds
    west, south, east, north = bounds
    spacing = max(
        ATLAS_SPACING_M,
        (east - west) / MAX_ATLAS_SIDE,
        (north - south) / MAX_ATLAS_SIDE,
        math.sqrt((east - west) * (north - south) / MAX_ATLAS_PIXELS),
    )
    width, height = math.ceil((east - west) / spacing), math.ceil((north - south) / spacing)
    if width * height > MAX_ATLAS_PIXELS:
        scale = math.sqrt(MAX_ATLAS_PIXELS / (width * height))
        width, height = max(1, math.floor(width * scale)), max(1, math.floor(height * scale))
    canvas = Image.new("RGBA", (width, height), TURF_GREEN)

    def pixel(point):
        return ((point[0] - west) * width / (east - west), (north - point[1]) * height / (north - south))

    for material, colour in MARK_COLOURS.items():
        shapes = [marking_polygon(f) for f in features if f["type"] == "line" and f["material"] == material]
        shapes = [(polygon, 255) for polygon in shapes if polygon.intersects(box(*bounds))]
        if shapes:
            mask = rasterize(
                shapes, out_shape=(height, width), transform=from_bounds(*bounds, width, height), dtype="uint8"
            )
            canvas.paste(colour, mask=Image.fromarray(mask))
    for f in features:
        if f["type"] != "decal" or not box(*f["bounds_m"]).intersects(box(*bounds)):
            continue
        x0, y0 = pixel((f["bounds_m"][0], f["bounds_m"][3]))
        x1, y1 = pixel((f["bounds_m"][2], f["bounds_m"][1]))
        rect = (round(x0), round(y0), round(x1), round(y1))
        full_width, full_height = max(1, rect[2] - rect[0]), max(1, rect[3] - rect[1])
        clipped = (
            max(0, rect[0]),
            max(0, rect[1]),
            min(width, rect[0] + full_width),
            min(height, rect[1] + full_height),
        )
        if clipped[0] >= clipped[2] or clipped[1] >= clipped[3]:
            continue
        with Image.open(io.BytesIO(images[f["image"]])) as mark:
            source_box = (
                (clipped[0] - rect[0]) * mark.width / full_width,
                (clipped[1] - rect[1]) * mark.height / full_height,
                (clipped[2] - rect[0]) * mark.width / full_width,
                (clipped[3] - rect[1]) * mark.height / full_height,
            )
            resized = mark.resize(
                (clipped[2] - clipped[0], clipped[3] - clipped[1]), Image.Resampling.LANCZOS, box=source_box
            )
            canvas.alpha_composite(resized, dest=clipped[:2])
    # Sub-pixel edge coverage becomes dyed fiber colour, never opacity above the field.
    canvas = canvas.filter(ImageFilter.GaussianBlur(0.35))
    data = io.BytesIO()
    canvas.save(data, format="PNG")
    content = data.getvalue()
    return f"athletic_turf_{hashlib.sha256(content).hexdigest()}.png", content, list(bounds)
