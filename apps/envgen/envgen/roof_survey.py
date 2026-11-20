"""Roof planes from unclassified lidar, with spatially held-out returns and explicit rejection.

Roof and ground elevations come from the same point cloud. Their difference does not mix
the lidar's vertical datum with the site's independently supplied terrain model.
"""

from __future__ import annotations

from itertools import pairwise

import numpy as np
import shapely
from rasterio.features import shapes
from rasterio.transform import from_origin
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.affinity import translate
from shapely.geometry import Polygon, shape
from shapely.ops import split

VERSION = 7
TOLERANCE_M = 0.22
MIN_POINTS = 30
MAX_PLANES = 8
DOMAIN_SPACING_M = 1.0
CORE_CELLS = 3


def _predict(xy: np.ndarray, plane: np.ndarray) -> np.ndarray:
    return xy @ plane[:2] + plane[2]


def _kind(planes) -> str:
    sloped = [p for p in planes if np.linalg.norm(p[:2]) >= 0.10]
    levels = [p[2] for p in planes if np.linalg.norm(p[:2]) < 0.10]
    if len(levels) > 1 and np.ptp(levels) > 0.6:
        return "multi-level"
    if len(sloped) == 4:
        return "hip"
    if len(sloped) == 2 and np.dot(sloped[0][:2], sloped[1][:2]) < -0.01:
        return "gabled"
    if len(sloped) == 1:
        return "shed"
    return "flat" if not sloped else "multi-plane"


def _planes(points: np.ndarray) -> list[np.ndarray]:
    rng = np.random.default_rng(271855)
    remaining = points.copy()
    found = []
    for _ in range(MAX_PLANES):
        if len(remaining) < MIN_POINTS:
            break
        sample = remaining[rng.choice(len(remaining), min(len(remaining), 2500), replace=False)]
        design = np.column_stack([sample[:, :2], np.ones(len(sample))])
        best = np.zeros(len(sample), dtype=bool)
        for _ in range(180):
            triple = rng.choice(len(sample), 3, replace=False)
            if abs(np.linalg.det(design[triple])) < 0.5:
                continue
            plane = np.linalg.solve(design[triple], sample[triple, 2])
            if np.linalg.norm(plane[:2]) > 1.5:
                continue
            inside = abs(design @ plane - sample[:, 2]) < TOLERANCE_M
            if inside.sum() > best.sum():
                best = inside
        if best.sum() < max(MIN_POINTS, len(points) * 0.035):
            break
        plane = np.linalg.lstsq(design[best], sample[best, 2], rcond=None)[0]
        inliers = abs(_predict(remaining[:, :2], plane) - remaining[:, 2]) < TOLERANCE_M
        support = remaining[inliers]
        if len(support) < MIN_POINTS:
            break
        hull = shapely.MultiPoint(support[:, :2]).convex_hull
        if hull.area >= 6 and np.linalg.eigvalsh(np.cov(support[:, :2].T)).min() > 0.3:
            found.append(plane)
        remaining = remaining[~inliers]
    return found


def _roof_candidates(reference: np.ndarray, query_xy=None) -> np.ndarray:
    """Use training neighbourhoods only; query elevations never enter this selection."""
    query_xy = reference[:, :2] if query_xy is None else query_xy
    tree = cKDTree(reference[:, :2])
    selected = np.zeros(len(query_xy), dtype=bool)
    for index, neighbours in enumerate(tree.query_ball_point(query_xy, 3.0)):
        if len(neighbours) < 6:
            continue
        values, vectors = np.linalg.eigh(np.cov(reference[neighbours, :3].T))
        selected[index] = (
            abs(vectors[2, 0]) >= 1 / np.sqrt(1 + 1.5**2)
            and values[0] <= 0.08 * values.sum()
            and values[1] > 0.1 * values[2]
        )
    return selected


def _envelope_parts(polygon, planes, mode="min"):
    west, south, east, north = polygon.bounds
    parts = []
    for value, plane in enumerate(planes):
        region = polygon
        for other, other_plane in enumerate(planes):
            if other == value:
                continue
            difference = (plane - other_plane) * (1 if mode == "min" else -1)
            normal = difference[:2]
            if np.linalg.norm(normal) < 1e-7:
                if difference[2] > 0:
                    region = Polygon()
                continue
            on_line = -difference[2] * normal / np.dot(normal, normal)
            tangent = np.array([-normal[1], normal[0]]) / np.linalg.norm(normal)
            direction = normal / np.linalg.norm(normal)
            reach = max(east - west, north - south) * 100 + np.linalg.norm(on_line)
            half = Polygon(
                [
                    on_line - tangent * reach,
                    on_line + tangent * reach,
                    on_line + tangent * reach - direction * reach * 2,
                    on_line - tangent * reach - direction * reach * 2,
                ]
            )
            region = region.intersection(half)
        for part in getattr(region, "geoms", [region]):
            if part.geom_type == "Polygon" and part.area > 0.01:
                parts.append((part, plane))
    return parts


def _photo_domains(polygon, train, breaklines, global_planes):
    regions = [polygon]
    reach = np.linalg.norm(np.ptp(np.asarray(polygon.exterior.coords), axis=0)) * 4
    for boundary in breaklines:
        xy = np.asarray(boundary.coords)
        direction = xy[1] - xy[0]
        direction /= np.linalg.norm(direction)
        middle = xy.mean(axis=0)
        line = shapely.LineString([middle - direction * reach, middle + direction * reach])
        regions = [part for region in regions for part in split(region, line).geoms if part.area > 1e-6]
    parts, pending = [], []
    for region in regions:
        sample = train[shapely.contains_xy(region, train[:, 0], train[:, 1])]
        planes = np.asarray(_planes(sample)) if len(sample) >= MIN_POINTS else np.empty((0, 3))
        if not len(planes):
            if len(sample) < MIN_POINTS:
                pending.append(region)
                continue
            planes = global_planes
        values = sample[:, :2] @ planes[:, :2].T + planes[:, 2]
        chosen = None
        for count in range(1, len(planes) + 1):
            for mode in ("min", "max"):
                error = abs(getattr(values[:, :count], mode)(axis=1) - sample[:, 2])
                if np.mean(error <= 0.35) >= 0.85 and np.quantile(error, 0.9) <= 0.6:
                    chosen = (planes[:count], mode)
                    break
            if chosen is not None:
                break
        if chosen is None:
            index = np.median(abs(values - sample[:, 2, None]), axis=0).argmin()
            chosen = (planes[index : index + 1], "min")
        parts.extend(_envelope_parts(region, *chosen))
    inferred_area = sum(region.area for region in pending)
    # Small unobserved strips inherit an adjacent roof, never a new height or extrusion.
    if not parts or inferred_area > polygon.area * 0.02:
        return None, inferred_area
    while pending:
        shared, i, j = max(
            (a.boundary.intersection(b.boundary).length, i, j)
            for i, a in enumerate(pending)
            for j, (b, _) in enumerate(parts)
        )
        if shared < 1e-6:
            return None, inferred_area
        region, plane = parts[j]
        parts[j] = (shapely.union_all([region, pending.pop(i)], grid_size=1e-6), plane)
    return parts, inferred_area


def _smooth_labels(image: np.ndarray, count: int) -> np.ndarray:
    votes = np.array(
        [
            ndimage.convolve((image == value).astype(np.uint8), np.ones((3, 3), dtype=np.uint8), mode="nearest")
            for value in range(count)
        ]
    )
    maximum = votes.max(axis=0)
    unique = (votes == maximum).sum(axis=0) == 1
    return np.where(unique, votes.argmax(axis=0), image).astype(np.uint8)


def _coherent_labels(image: np.ndarray, inside: np.ndarray) -> np.ndarray | None:
    seeds = np.full(image.shape, -1, dtype=np.int16)
    for value in np.unique(image[inside]):
        core = ndimage.binary_opening((image == value) & inside, structure=np.ones((CORE_CELLS, CORE_CELLS)))
        seeds[core] = value
    if not np.any(seeds >= 0):
        return None
    nearest = ndimage.distance_transform_edt(seeds < 0, return_distances=False, return_indices=True)
    return seeds[tuple(nearest)].astype(np.uint8)


def _surface(parts):
    boundaries = shapely.union_all([region.boundary for region, _ in parts], grid_size=1e-6)
    noded = []
    for region in shapely.polygonize(shapely.get_parts(boundaries)).geoms:
        point = region.representative_point()
        owner = next((plane for source, plane in parts if source.buffer(2e-6).covers(point)), None)
        if owner is not None:
            noded.append((region, owner))
    levels = {}
    for region, plane in noded:
        for ring in [region.exterior, *region.interiors]:
            for xy in np.asarray(ring.coords):
                levels.setdefault(tuple(xy), set()).add(float(_predict(xy, plane)))
    coordinates = np.asarray(list(levels))
    tree = cKDTree(coordinates)
    joined = []
    for values in levels.values():
        groups = []
        for z in sorted(values):
            if not groups or z - groups[-1][0] > 2 * TOLERANCE_M:
                groups.append([])
            groups[-1].append(z)
        joined.append([(z, float(np.mean(group))) for group in groups for z in group])

    def elevation(xy, plane):
        z = float(_predict(xy, plane))
        distance, index = tree.query(xy)
        if distance <= 3e-6:
            source, target = min(joined[index], key=lambda pair: abs(pair[0] - z))
            if abs(source - z) < 1e-4:
                return target
        return z

    return noded, elevation


def _mesh(
    parts: list[tuple[Polygon, np.ndarray]], centre: np.ndarray, roof_z: float, elevation=None
) -> tuple[list, list]:
    if elevation is None:
        parts, elevation = _surface(parts)
    vertices, triangles = [], []
    for region, plane in parts:
        for triangle in shapely.constrained_delaunay_triangles(region).geoms:
            start = len(vertices)
            coords = np.asarray(triangle.exterior.coords)[:3]
            a, b = coords[1] - coords[0], coords[2] - coords[0]
            signed_area = a[0] * b[1] - a[1] * b[0]
            if abs(signed_area) < 1e-10:
                continue
            if signed_area < 0:
                coords = coords[::-1]
            for xy in coords:
                vertices.append([*(xy + centre), elevation(xy, plane) - roof_z])
            triangles.append([start, start + 1, start + 2])
    # Vertical faces close measured steps between adjacent roof levels.
    for i, (region, plane) in enumerate(parts):
        for other, other_plane in parts[i + 1 :]:
            common = shapely.set_precision(region.boundary, 1e-6).intersection(
                shapely.set_precision(other.boundary, 1e-6)
            )
            for line in getattr(common, "geoms", [common]):
                if line.geom_type != "LineString":
                    continue
                coords = np.asarray(line.coords)
                for a, b in pairwise(coords):
                    za, zb = elevation(a, plane), elevation(b, plane)
                    oa, ob = elevation(a, other_plane), elevation(b, other_plane)
                    da, db = za - oa, zb - ob
                    cuts = [0.0, 1.0]
                    if da * db < 0:
                        cuts.insert(1, da / (da - db))
                    for lo, hi in pairwise(cuts):
                        p, q = a + (b - a) * lo, a + (b - a) * hi
                        zp, zq = za + (zb - za) * lo, za + (zb - za) * hi
                        op, oq = oa + (ob - oa) * lo, oa + (ob - oa) * hi
                        delta = q - p
                        if np.linalg.norm(delta) < 1e-3 or max(abs(zp - op), abs(zq - oq)) < 0.02:
                            continue
                        left = np.array([-delta[1], delta[0]]) / np.linalg.norm(delta)
                        middle = (p + q) / 2
                        toward_other = -left if region.covers(shapely.Point(middle + left * 1e-5)) else left
                        outward = toward_other if zp + zq > op + oq else -toward_other
                        quad = np.array([[*p, zp], [*q, zq], [*q, oq], [*p, op]])
                        start = len(vertices)
                        vertices.extend([[*(v[:2] + centre), float(v[2] - roof_z)] for v in quad])
                        for t in [(0, 1, 2), (0, 2, 3)]:
                            normal = np.cross(quad[t[1]] - quad[t[0]], quad[t[2]] - quad[t[0]])
                            if np.linalg.norm(normal) < 1e-10:
                                continue
                            reverse = np.dot(normal[:2], outward) < 0
                            triangles.append([start + i for i in (t[::-1] if reverse else t)])
    return vertices, triangles


def _walls(polygon: Polygon, parts, centre: np.ndarray, roof_z: float, elevation=None) -> list:
    if elevation is None:
        parts, elevation = _surface(parts)
    segments = []
    buffered = [(region.buffer(1e-6), plane) for region, plane in parts]
    for ring in [polygon.exterior, *polygon.interiors]:
        for a, b in pairwise(np.asarray(ring.coords)):
            delta = b - a
            length = np.linalg.norm(delta)
            if length < 1e-7:
                continue
            direction = delta / length
            boundary = shapely.LineString([a, b])
            cuts = [0.0, float(length)]
            # Overlay endpoints can differ by a few ULPs along a projected footprint edge.
            for region, _ in buffered:
                clipped = boundary.intersection(region)
                for line in getattr(clipped, "geoms", [clipped]):
                    if line.geom_type == "LineString" and not line.is_empty:
                        cuts.extend(np.clip((np.asarray(line.coords)[[0, -1]] - a) @ direction, 0, length).tolist())
            ordered = [0.0]
            for cut in sorted(cuts):
                if cut - ordered[-1] > 1e-3 and length - cut > 1e-3:
                    ordered.append(cut)
            ordered.append(float(length))
            for lo, hi in pairwise(ordered):
                middle = shapely.Point(a + direction * ((lo + hi) / 2))
                _, plane = min(parts, key=lambda item: item[0].distance(middle))
                ends = [a + direction * lo, a + direction * hi]
                segments.append([[*(xy + centre), elevation(xy, plane) - roof_z] for xy in ends])
    return segments


def _sample_mesh(vertices, triangles, xy):
    vertices = np.asarray(vertices)
    result = np.full(len(xy), np.nan)
    for indices in triangles:
        a, b, c = vertices[indices]
        u, v = b[:2] - a[:2], c[:2] - a[:2]
        denominator = u[0] * v[1] - u[1] * v[0]
        if abs(denominator) < 1e-10:
            continue
        relative = xy - a[:2]
        first = (relative[:, 0] * v[1] - relative[:, 1] * v[0]) / denominator
        second = (u[0] * relative[:, 1] - u[1] * relative[:, 0]) / denominator
        inside = (first >= -1e-7) & (second >= -1e-7) & (first + second <= 1 + 1e-7)
        result[inside] = a[2] + first[inside] * (b[2] - a[2]) + second[inside] * (c[2] - a[2])
    return result


def fit(
    polygon: Polygon, points: np.ndarray, ground: np.ndarray, anchor: np.ndarray, prior=None, breaklines=None
) -> dict:
    """Fit in local coordinates, returning measured geometry only when held-out support is sufficient."""
    centre = np.array(polygon.centroid.coords[0])
    local_polygon = translate(polygon, -centre[0], -centre[1])
    local = points[:, :3].copy()
    local[:, :2] -= centre
    base = {"status": "unresolved", "returns": len(points), "from": "lidar: roof and nearby ground from one survey"}
    if len(local) < 2 * MIN_POINTS or len(ground) < MIN_POINTS:
        return {**base, "reason": "insufficient roof or nearby ground returns"}
    ground_xy = ground[:, :2] - anchor
    design = np.column_stack([ground_xy, np.ones(len(ground))])
    ground_plane = np.linalg.lstsq(design, ground[:, 2], rcond=None)[0]
    residual = ground[:, 2] - design @ ground_plane
    keep = abs(residual - np.median(residual)) < 0.4
    if keep.sum() < MIN_POINTS:
        return {**base, "reason": "nearby ground is not sufficiently supported"}
    ground_plane = np.linalg.lstsq(design[keep], ground[keep, 2], rcond=None)[0]
    ground_z = float(ground_plane[2])
    local = local[local[:, 2] > _predict(local[:, :2] + centre - anchor, ground_plane) + 1.5]
    # A metre cell belongs to one split, so adjacent returns cannot leak across the split.
    cells = np.floor(local[:, :2]).astype(np.int64)
    held = (cells[:, 0] * 73856093 + cells[:, 1] * 19349663) % 5 == 0
    train, test = local[~held], local[held]
    raw_test = test
    selection = {}
    if breaklines:
        reference = train
        train_mask = _roof_candidates(reference)
        test_mask = _roof_candidates(reference, test[:, :2])
        selection = {
            "roof_selection": "upward planar training neighbourhoods; validation selection uses XY only",
            "roof_selection_radius_m": 3.0,
            "roof_selection_min_neighbours": 6,
            "roof_selection_max_slope": 1.5,
            "roof_selection_max_scatter_ratio": 0.08,
            "roof_selection_min_spread_ratio": 0.1,
            "raw_training_returns": len(train),
            "raw_validation_returns": len(test),
            "selected_training_returns": int(train_mask.sum()),
            "selected_validation_returns": int(test_mask.sum()),
        }
        base.update(selection)
        train, test = train[train_mask], test[test_mask]
    if len(train) < MIN_POINTS or len(test) < 15:
        return {**base, "reason": "insufficient spatial validation returns"}
    planes = _planes(train)
    if not planes:
        return {**base, "reason": "no spatially supported roof plane"}
    planes = np.asarray(planes)
    errors = abs(train[:, 2, None] - (train[:, :2] @ planes[:, :2].T + planes[:, 2]))
    labels = errors.argmin(axis=1)
    supported = errors.min(axis=1) < TOLERANCE_M
    support_xy, support_labels = train[supported, :2], labels[supported]
    coverage = float(supported.mean())
    if coverage < 0.70:
        return {**base, "reason": "plane coverage below 70 percent", "fit_share": coverage}
    west, south, east, north = local_polygon.bounds
    spacing = DOMAIN_SPACING_M
    xs = np.arange(west + spacing / 2, east + spacing / 2, spacing)
    ys = np.arange(north - spacing / 2, south - spacing / 2, -spacing)
    xx, yy = np.meshgrid(xs, ys)
    grid = np.column_stack([xx.ravel(), yy.ravel()])
    distance, nearest = cKDTree(support_xy).query(grid)
    grid_inside = shapely.contains_xy(local_polygon, grid[:, 0], grid[:, 1])
    area_share = float(np.mean(distance[grid_inside] <= 2.0)) if grid_inside.any() else 0.0
    if area_share < 0.80:
        return {**base, "reason": "supported footprint area below 80 percent", "area_share_within_2m": area_share}
    image = support_labels[nearest].reshape(xx.shape).astype(np.uint8)
    image = _smooth_labels(image, len(planes))
    transform = from_origin(west, north, spacing, spacing)
    envelope = train[:, :2] @ planes[:, :2].T + planes[:, 2]
    use_envelope = np.mean(abs(envelope.min(axis=1) - train[:, 2]) <= TOLERANCE_M) >= 0.85
    inferred_area = 0.0
    if breaklines:
        local_lines = [translate(line, -centre[0], -centre[1]) for line in breaklines]
        parts, inferred_area = _photo_domains(local_polygon, train, local_lines, planes)
        if parts is None:
            return {
                **base,
                "reason": "photo regions lack supported roof planes",
                "inferred_domain_area_m2": inferred_area,
            }
        planes = np.unique(np.asarray([plane for _, plane in parts]), axis=0)
    elif use_envelope:
        parts = _envelope_parts(local_polygon, planes)
    else:
        image = _coherent_labels(image, grid_inside.reshape(image.shape))
        if image is None:
            return {**base, "reason": "no coherent multi-level roof domain at the sampling resolution"}
        parts = []
        for value in range(len(planes)):
            regions = [shape(g) for g, v in shapes((image == value).astype(np.uint8), transform=transform) if v == 1]
            region = shapely.union_all(regions).intersection(local_polygon)
            for part in getattr(region, "geoms", [region]):
                if part.geom_type == "Polygon" and part.area > 0.01:
                    parts.append((part, planes[value]))

    # Sampling the actual fitted domains measures extrapolation, rather than choosing the best
    # plane separately for every validation return.
    def predict(xy):
        result = np.full(len(xy), np.nan)
        for region, plane in parts:
            inside = shapely.intersects_xy(region, xy[:, 0], xy[:, 1])
            result[inside] = _predict(xy[inside], plane)
        return result

    predicted = predict(test[:, :2])
    if np.isfinite(predicted).mean() < 0.95:
        return {**base, "reason": "held-out surface agreement below threshold", "validation_share_035m": 0.0}
    roof_z = float(np.nanmedian(predicted))
    parts, elevation = _surface(parts)
    vertices, triangles = _mesh(parts, centre, roof_z, elevation)
    predicted = _sample_mesh(vertices, triangles, test[:, :2] + centre) + roof_z
    finite = np.isfinite(predicted)
    error = abs(predicted[finite] - test[finite, 2])
    agreement = float(np.mean(error <= 0.35)) if len(error) else 0.0
    if finite.mean() < 0.95 or agreement < 0.85 or np.quantile(error, 0.9) > 0.6:
        return {**base, "reason": "held-out surface agreement below threshold", "validation_share_035m": agreement}
    if breaklines:
        raw_predicted = _sample_mesh(vertices, triangles, raw_test[:, :2] + centre) + roof_z
        raw_finite = np.isfinite(raw_predicted)
        raw_error = abs(raw_predicted[raw_finite] - raw_test[raw_finite, 2])
        base.update(
            {
                "raw_validation_mae_m": float(raw_error.mean()),
                "raw_validation_share_035m": float(np.mean(raw_error <= 0.35)),
                "raw_validation_surface_share": float(raw_finite.mean()),
            }
        )
    heights = np.asarray(vertices)[:, 2] + roof_z
    height = roof_z - ground_z
    if not 1.5 <= height <= 100:
        return {**base, "reason": "roof height outside supported range"}
    significant = [
        p
        for p in planes
        if sum(region.area for region, q in parts if np.array_equal(p, q)) > max(6, polygon.area * 0.08)
    ]
    kind = _kind(significant)
    check_planes = _planes(test)
    validation_kind = _kind(check_planes) if check_planes else "unresolved"
    baseline = {}
    if prior is not None:
        style = prior["architecture"]
        along = np.asarray(style["along"])
        across = np.array([-along[1], along[0]])
        side = (test[:, :2] + centre - np.asarray(style["centre_m"])) @ across
        offset = style["rise_m"] * (0.5 - abs(side) / (style["width_m"] * 0.5))
        old_error = abs(ground_z + prior["height_m"] + offset - test[:, 2])
        baseline = {
            "prior_validation_mae_m": float(old_error.mean()),
            "prior_validation_share_035m": float(np.mean(old_error <= 0.35)),
            "prior_roof_shape": style["roof_shape"],
            "prior_roof_type_agrees": style["roof_shape"] == validation_kind
            if validation_kind != "unresolved"
            else None,
        }
    edge_heights = _walls(local_polygon, parts, centre, roof_z, elevation)
    return {
        **base,
        "status": "measured",
        "roof_shape": kind,
        "height_m": height,
        "eave_height_m": float(heights.min() - ground_z),
        "ridge_height_m": float(heights.max() - ground_z),
        "ground_z_m": ground_z,
        "roof_z_m": roof_z,
        "ground_fit_rmse_m": float(np.sqrt(np.mean((design[keep] @ ground_plane - ground[keep, 2]) ** 2))),
        "planes": [{"a": float(p[0]), "b": float(p[1]), "z_at_centroid_m": float(p[2])} for p in planes],
        "fit_share": coverage,
        "area_share_within_2m": area_share,
        "domain_cell_m": None if breaklines else spacing,
        "domain_core_m": CORE_CELLS * spacing if not use_envelope and not breaklines else None,
        "domain_source": "photo-referenced breaklines" if breaklines else "lidar plane domains",
        "inferred_domain_area_m2": inferred_area,
        "validation_returns": int(finite.sum()),
        "validation_mae_m": float(error.mean()),
        "validation_p90_m": float(np.quantile(error, 0.9)),
        "validation_share_035m": agreement,
        "validation_roof_shape": validation_kind,
        "roof_type_agrees": kind == validation_kind if validation_kind != "unresolved" else None,
        "roof_type_note": "agreement with separately fitted held-out lidar planes, not independently labelled survey truth",
        **baseline,
        "roof_vertices": vertices,
        "roof_triangles": triangles,
        "wall_segments": edge_heights,
        "datum_note": "relative roof-to-ground heights use the same lidar datum; placement follows site terrain; absolute datum alignment is unverified",
    }


def measure(footprints: list[dict], points: np.ndarray, priors=None) -> list[dict]:
    ground = points[points[:, 3] == 2]
    objects = points[~np.isin(points[:, 3], [2, 7, 18])]
    tree = cKDTree(objects[:, :2]) if len(objects) else None
    ground_tree = cKDTree(ground[:, :2]) if len(ground) else None
    results = []
    for index, item in enumerate(footprints):
        polygon = item["polygon"]
        anchor = np.array(polygon.representative_point().coords[0])
        centre = np.array(polygon.centroid.coords[0])
        radius = np.linalg.norm(np.asarray(polygon.exterior.coords) - centre, axis=1).max() + 1
        candidates = objects[tree.query_ball_point(centre, radius)] if tree else objects
        inside = shapely.contains_xy(polygon.buffer(-0.35), candidates[:, 0], candidates[:, 1])
        near = ground[ground_tree.query_ball_point(anchor, min(radius + 12, 80))] if ground_tree else ground
        if len(near):
            near = near[~shapely.intersects_xy(polygon.buffer(1), near[:, 0], near[:, 1])]
        result = fit(
            polygon,
            candidates[inside],
            near,
            anchor,
            priors[index] if priors is not None else None,
            item.get("roof_breaklines"),
        )
        if "roof_boundary_observation" in item:
            result["boundary_observation"] = item["roof_boundary_observation"]
        if result["status"] == "measured" and len(result["planes"]) == 1 and result["roof_shape"] == "flat":
            p = result["planes"][0]
            edge = candidates[
                shapely.contains_xy(polygon, candidates[:, 0], candidates[:, 1])
                & ~shapely.contains_xy(polygon.buffer(-0.6), candidates[:, 0], candidates[:, 1])
            ]
            raised = []
            edge_count = 0
            for a, b in pairwise(np.asarray(polygon.exterior.coords)):
                delta = b - a
                length = np.linalg.norm(delta)
                if length < 3:
                    continue
                relative = edge[:, :2] - a
                side = edge[np.abs(delta[0] * relative[:, 1] - delta[1] * relative[:, 0]) / length < 0.6]
                if len(side) < 8:
                    continue
                xy = side[:, :2] - centre
                excess = side[:, 2] - (xy @ [p["a"], p["b"]] + p["z_at_centroid_m"])
                high = (excess >= 0.2) & (excess <= 0.9)
                along = (side[high, :2] - a) @ (delta / length)
                if high.mean() >= 0.5 and len(np.unique(np.clip((along / length * 6).astype(int), 0, 5))) >= 4:
                    edge_count += 1
                    raised.extend(excess[high])
            if edge_count >= 3 and len(raised) >= 20:
                result["parapet_m"] = float(np.median(raised))
                result["parapet_from"] = "lidar: raised returns span at least three roof edges; interpreted as parapet"
        results.append(result)
    return results
