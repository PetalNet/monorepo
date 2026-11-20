"""Independent, high resolution roof observations; photo contrast does not measure object height."""

from __future__ import annotations

import numpy as np
import rasterio
import shapely
from rasterio.errors import WindowError
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window, from_bounds
from scipy import ndimage
from shapely.geometry import Polygon

from . import buildings

VERSION = 5


def _read(vrt, polygon):
    west, south, east, north = polygon.buffer(3).bounds
    window = from_bounds(west, south, east, north, vrt.transform).round_offsets().round_lengths()
    try:
        window = window.intersection(Window(0, 0, vrt.width, vrt.height))
    except WindowError:
        return None
    masked = vrt.read(window=window, masked=True)
    data = masked.filled(0)
    transform = vrt.window_transform(window)
    rows, cols = np.indices(data.shape[1:])
    xx = transform.c + (cols + 0.5) * transform.a
    yy = transform.f + (rows + 0.5) * transform.e
    valid = ~np.any(np.ma.getmaskarray(masked)[:3], axis=0) & np.any(data[:3] != 0, axis=0)
    if data.shape[0] >= 4:
        valid &= ~np.ma.getmaskarray(masked)[3]
        red, nir = data[0].astype(float), data[3].astype(float)
        valid &= (nir - red) / np.maximum(nir + red, 1) < 0.30
    return data, transform, xx, yy, valid


def refine(footprints: list[dict], path, crs: str, tile) -> list[dict]:
    """Move rectangular map edges only when a coherent, non-vegetation photo edge supports them."""
    result = []
    with rasterio.open(path) as source, WarpedVRT(source, crs=crs) as vrt:
        if max(abs(vrt.res[0]), abs(vrt.res[1])) > 0.35:
            raise ValueError("building_imagery requires pixels no larger than 0.35 m")
        for item in footprints:
            polygon = item["polygon"]
            observation = {"status": "unchanged", "from": "photo edges", "pixel_m": list(vrt.res)}
            rectangle = polygon.minimum_rotated_rectangle
            if polygon.interiors or polygon.area / rectangle.area < 0.96:
                result.append(
                    {**item, "outline_observation": {**observation, "reason": "nonrectangular footprint retained"}}
                )
                continue
            sample = _read(vrt, polygon)
            if sample is None:
                result.append({**item, "outline_observation": {**observation, "reason": "outside building imagery"}})
                continue
            data, transform, _xx, _yy, valid = sample
            valid = ndimage.binary_erosion(valid, structure=np.ones((3, 3)))
            grey = np.mean(data[:3].astype(float), axis=0)
            gradient = np.hypot(ndimage.sobel(grey, axis=0), ndimage.sobel(grey, axis=1)) / 8
            corners = np.array(rectangle.exterior.coords)[:4]
            centre = corners.mean(axis=0)
            axes = np.array([corners[1] - corners[0], corners[2] - corners[1]])
            axes /= np.linalg.norm(axes, axis=1)[:, None]
            relative = corners - centre
            bounds = []
            accepted = []
            for axis_index, normal in enumerate(axes):
                tangent = axes[1 - axis_index]
                half = np.max(abs(relative @ normal))
                extent = np.max(abs(relative @ tangent))
                for sign in [-1, 1]:
                    along = np.linspace(-extent + 1, extent - 1, max(8, int(extent * 4)))
                    offsets = np.arange(-1.5, 1.501, 0.15)
                    scores, shares = [], []
                    for shift in offsets:
                        xy = centre + along[:, None] * tangent + normal * (sign * half + shift)
                        coords = np.array(
                            [(xy[:, 1] - transform.f) / transform.e - 0.5, (xy[:, 0] - transform.c) / transform.a - 0.5]
                        )
                        g = ndimage.map_coordinates(gradient, coords, order=1, mode="constant")
                        ok = ndimage.map_coordinates(valid.astype(float), coords, order=0, mode="constant") > 0.5
                        scores.append(float(np.median(g[ok])) if ok.sum() >= len(ok) * 0.65 else 0)
                        shares.append(float(np.mean((g > 12) & ok)))
                    best = int(np.argmax(scores))
                    good = scores[best] >= 16 and shares[best] >= 0.65
                    accepted.append(good)
                    bounds.append(sign * half + (float(offsets[best]) if good else 0))
            if all(accepted):
                a0, a1, b0, b1 = bounds
                proposed = Polygon(
                    [centre + axes[0] * a + axes[1] * b for a, b in [(a0, b0), (a1, b0), (a1, b1), (a0, b1)]]
                )
                if (
                    proposed.is_valid
                    and 0.85 <= proposed.area / polygon.area <= 1.15
                    and shapely.box(*tile.bounds()).covers(proposed)
                ):
                    observation.update(
                        status="refined",
                        max_displacement_m=float(polygon.hausdorff_distance(proposed)),
                        prior_area_m2=polygon.area,
                        area_m2=proposed.area,
                    )
                    polygon = proposed
            else:
                observation["reason"] = "not all four edges have coherent photo support"
            result.append({**item, "polygon": polygon, "outline_observation": observation})
    return result


def observe(records, footprints, path, crs, curve, scale, lidar_date=None, image_date=None):
    with rasterio.open(path) as source, WarpedVRT(source, crs=crs) as vrt:
        for record, item in zip(records, footprints, strict=True):
            polygon = item["polygon"]
            sample = _read(vrt, polygon)
            if sample is None:
                record["imagery_observation"] = {"status": "unresolved", "reason": "outside building imagery"}
                continue
            data, transform, xx, yy, valid = sample
            interior = polygon.buffer(-0.6)
            inside = shapely.contains_xy(interior, xx, yy)
            selected = inside & valid
            record["outline_observation"] = item["outline_observation"]
            area = abs(transform.a * transform.e)
            usable_share = float(min(1, selected.sum() * area / interior.area)) if interior.area else 0.0
            coverage_share = float(min(1, inside.sum() * area / interior.area)) if interior.area else 0.0
            if selected.sum() < 20 or usable_share < 0.60:
                record["imagery_observation"] = {
                    "status": "unresolved",
                    "reason": "fewer than 20 roof pixels or less than 60 percent usable roof coverage",
                    "usable_roof_share": usable_share,
                    "source_coverage_share": coverage_share,
                }
                continue
            rgb = data[:3].astype(float)
            colour = np.median(rgb[:, selected], axis=1)
            record["roof_albedo"] = buildings.roof_albedo(colour, curve, scale)
            luma = np.mean(rgb, axis=0)
            median = np.median(luma[selected])
            # Contrasting connected components are observations, not semantic HVAC/skylight labels.
            contrast = (luma < median - 40) if median > 150 else (luma > median + 60)
            contrast &= selected
            labels, count = ndimage.label(contrast)
            components = []
            for label, region in enumerate(ndimage.find_objects(labels, count), 1):
                if region is None:
                    continue
                rr, cc = region
                area = np.count_nonzero(labels[region] == label) * abs(transform.a * transform.e)
                width, depth = (cc.stop - cc.start) * transform.a, (rr.stop - rr.start) * -transform.e
                if not (0.4 <= area <= 180 and min(width, depth) >= 0.45 and max(width, depth) <= 25):
                    continue
                components.append(
                    {
                        "east_m": float(xx[rr, cc].mean()),
                        "north_m": float(yy[rr, cc].mean()),
                        "width_m": float(width),
                        "depth_m": float(depth),
                        "pixel_area_m2": float(area),
                        "kind": "unclassified roof contrast",
                        "height_from": "unresolved: no photo-derived height",
                    }
                )
            record["imagery_observation"] = {
                "status": "observed",
                "roof_srgb": colour.tolist(),
                "usable_roof_share": usable_share,
                "source_coverage_share": coverage_share,
                "pixel_m": list(vrt.res),
                "components": components,
                "material": "unresolved: RGB alone does not establish roofing material",
                "change_status": "not assessed: no lidar source"
                if lidar_date is None
                else "review candidate: lidar roof unresolved"
                if record.get("roof_survey", {}).get("status") != "measured"
                else "no automatic change conclusion",
                "lidar_date": lidar_date,
                "image_date": image_date,
                "change_note": "Source dates are retained without assuming chronological order; unresolved lidar can also mean occlusion or sparse sampling",
            }
