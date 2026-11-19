"""The site description: what to build, where, and from which sources."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from rasterio.crs import CRS

SCHEMA_VERSION = 1

# A Landscape must be (components * sections * quads_per_section + 1) vertices on a side.
# 2017 = 16 components * 2 sections * 63 quads + 1.
LANDSCAPE_SECTION_QUADS = 63
LANDSCAPE_SECTIONS_PER_COMPONENT = 2


class SiteError(ValueError):
    """The site file is missing something or contradicts itself."""


@dataclass(frozen=True)
class Source:
    """One evidence source: a local file, or a service or remote raster to clip from."""

    kind: str  # "file" | "arcgis_imageserver" | "ept" | "cog"
    location: str  # path (file), service endpoint, or the URL of a cloud-optimised GeoTIFF
    license: str
    date: str
    request_spacing_m: float | None = None
    # Which band of a raster holds what, by name and 1-based number, when the file's own tags do not say.
    bands: tuple[tuple[str, int], ...] | None = None

    def band(self, name: str) -> int | None:
        return dict(self.bands or ()).get(name)

    @staticmethod
    def parse(raw: dict, base: Path, name: str) -> Source:
        kind = raw.get("kind")
        if kind == "file":
            location = str((base / raw["path"]).resolve())
        elif kind == "cog" and name == "canopy_height":
            location = raw["url"]
        elif kind == "arcgis_imageserver" and name in ("elevation", "imagery"):
            location = raw["endpoint"].rstrip("/")
            if "request_spacing_m" not in raw:
                raise SiteError(f"sources.{name}: an arcgis_imageserver source needs request_spacing_m")
        elif kind == "ept" and name == "lidar":
            location = raw["endpoint"].rstrip("/")
        else:
            allowed = {"lidar": "'file' or 'ept'", "canopy_height": "'file' or 'cog'", "reflectance": "'file'"}.get(
                name, "'file' or 'arcgis_imageserver'"
            )
            raise SiteError(f"sources.{name}: kind must be {allowed}, got {kind!r}")
        for field in ("license", "date"):
            if not raw.get(field):
                raise SiteError(f"sources.{name}: {field} is required, so the source registry can state it")
        bands = raw.get("bands")
        if bands is not None:
            if not all(isinstance(number, int) and number >= 1 for number in bands.values()) or not {
                "red",
                "green",
                "blue",
            } <= set(bands):
                raise SiteError(f"sources.{name}: bands must give red, green and blue as 1-based band numbers")
            bands = tuple(sorted(bands.items()))
        elif name == "reflectance":
            raise SiteError("sources.reflectance: bands is required, naming at least red, green and blue")
        return Source(kind, location, raw["license"], raw["date"], raw.get("request_spacing_m"), bands)


@dataclass(frozen=True)
class Tile:
    """A square, north-up tile in the site's projected CRS. Vertices sit on a regular grid."""

    west: float
    south: float
    quad_m: float
    quads: int

    @property
    def size_m(self) -> float:
        return self.quads * self.quad_m

    @property
    def east(self) -> float:
        return self.west + self.size_m

    @property
    def north(self) -> float:
        return self.south + self.size_m

    @property
    def vertices(self) -> int:
        return self.quads + 1

    @property
    def centre(self) -> tuple[float, float]:
        return (self.west + self.size_m / 2, self.south + self.size_m / 2)

    @property
    def components(self) -> int:
        return self.quads // (LANDSCAPE_SECTION_QUADS * LANDSCAPE_SECTIONS_PER_COMPONENT)

    def bounds(self, margin_m: float = 0.0) -> tuple[float, float, float, float]:
        return (self.west - margin_m, self.south - margin_m, self.east + margin_m, self.north + margin_m)


@dataclass(frozen=True)
class Site:
    site_id: str
    crs: str  # "EPSG:<code>", projected, in metres
    boundary: tuple[tuple[float, float], ...]
    tile: Tile
    target_date: str
    seed: int
    vertical_datum: str
    elevation: Source
    imagery: Source
    lidar: Source | None  # optional: masks trees and roofs out of the colour map, and finds interpolated ground
    canopy_height: Source | None  # optional: a raster of canopy height in metres, for cover the lidar missed
    context_size_m: float | None  # optional: side of a coarse surround, so the tile does not end in a cliff
    # optional: measured surface reflectance (0 to 1) near the target date, which sets each class's albedo
    reflectance: Source | None = None


def acquisition_day(source: Source, name: str) -> date:
    """The day a source was taken, which its date has to start with when the sun's position that day matters."""
    try:
        return date.fromisoformat(source.date[:10])
    except ValueError:
        raise SiteError(
            f"sources.{name}: date must start with the acquisition day as YYYY-MM-DD to cast shadows, got {source.date!r}"
        ) from None


def tile_for_boundary(boundary: list[tuple[float, float]], size_m: float, quad_m: float) -> Tile:
    """Centre a square tile on the boundary's bounding box, snapped to whole metres."""
    quads = round(size_m / quad_m)
    per_component = LANDSCAPE_SECTION_QUADS * LANDSCAPE_SECTIONS_PER_COMPONENT
    if quads <= 0 or abs(quads * quad_m - size_m) > 1e-9 or quads % per_component:
        raise SiteError(
            f"tile.size_m / tile.quad_m must be a whole multiple of {per_component} quads "
            f"(for example 1008 m at 0.5 m); got {size_m} m at {quad_m} m"
        )
    xs = [p[0] for p in boundary]
    ys = [p[1] for p in boundary]
    if max(xs) - min(xs) > size_m or max(ys) - min(ys) > size_m:
        raise SiteError(
            f"the boundary is {max(xs) - min(xs):.0f} x {max(ys) - min(ys):.0f} m and does not fit a {size_m:.0f} m tile"
        )
    west = round((min(xs) + max(xs)) / 2 - size_m / 2)
    south = round((min(ys) + max(ys)) / 2 - size_m / 2)
    return Tile(float(west), float(south), quad_m, quads)


def projected_metre_crs(text: str) -> str:
    """Accept only a projected CRS in metres with an EPSG code, and return it as "EPSG:<code>"."""
    try:
        crs = CRS.from_user_input(text)
    except Exception as error:
        raise SiteError(f"crs {text!r} is not a coordinate reference system: {error}") from error
    epsg = crs.to_epsg()
    if not crs.is_projected or epsg is None or abs(crs.linear_units_factor[1] - 1.0) > 1e-9:
        raise SiteError(f"crs {text!r} must be a projected CRS in metres with an EPSG code, such as a UTM zone")
    return f"EPSG:{epsg}"


# The surround is a second Landscape of this many quads a side: 8 components of 63.
CONTEXT_QUADS = 504


def context_size(raw: dict, tile: Tile) -> float | None:
    if "context" not in raw:
        return None
    size = float(raw["context"]["size_m"])
    if size <= tile.size_m:
        raise SiteError(f"context.size_m must be larger than the tile ({tile.size_m:.0f} m), got {size:.0f}")
    return size


def load_site(path: Path) -> Site:
    raw = json.loads(path.read_text())
    if raw.get("schema_version") != SCHEMA_VERSION:
        raise SiteError(f"schema_version must be {SCHEMA_VERSION}, got {raw.get('schema_version')!r}")
    for field in ("site_id", "crs", "boundary", "tile", "target_date", "seed", "vertical_datum", "sources"):
        if field not in raw:
            raise SiteError(f"{field} is required")
    boundary = [(float(p[0]), float(p[1])) for p in raw["boundary"]]
    if len(boundary) < 3:
        raise SiteError("boundary needs at least three points, in the site's projected CRS")
    tile = tile_for_boundary(boundary, float(raw["tile"]["size_m"]), float(raw["tile"]["quad_m"]))
    sources = raw["sources"]
    for name in ("elevation", "imagery"):
        if name not in sources:
            raise SiteError(f"sources.{name} is required")
    return Site(
        site_id=raw["site_id"],
        crs=projected_metre_crs(raw["crs"]),
        boundary=tuple(boundary),
        tile=tile,
        target_date=raw["target_date"],
        seed=int(raw["seed"]),
        vertical_datum=raw["vertical_datum"],
        elevation=Source.parse(sources["elevation"], path.parent, "elevation"),
        imagery=Source.parse(sources["imagery"], path.parent, "imagery"),
        lidar=Source.parse(sources["lidar"], path.parent, "lidar") if "lidar" in sources else None,
        canopy_height=(
            Source.parse(sources["canopy_height"], path.parent, "canopy_height") if "canopy_height" in sources else None
        ),
        context_size_m=context_size(raw, tile),
        reflectance=(
            Source.parse(sources["reflectance"], path.parent, "reflectance") if "reflectance" in sources else None
        ),
    )
