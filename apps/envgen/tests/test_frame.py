import numpy as np
import pytest

from envgen import frame


def test_exported_nonplanar_quad_uses_triangle_planes_and_common_origin():
    heights = np.array([[32768, 32896], [33024, 33280]], dtype=np.uint16)
    surface = {"vertices": 2, "location_cm": [-200, -300, 700], "scale": [200, 300, 100]}
    points = [[-3, -2], [0, 0], [-2.25, -0.5], [-0.75, -1.5], [-1.5, -1]]
    # Fractions (east,north): (0,0), (1,1), (.25,.75), (.75,.25), (.5,.5).
    assert frame.sample_heightmap(heights, surface, points) == pytest.approx([7, 11, 8.5, 9, 9])
    # Bilinear interpolation would give 9.0625 at (.75,.25), rather than the triangle's 9.


@pytest.mark.parametrize("point", [[-0.001, 0], [1.001, 0], [0, -0.001], [0, 1.001], [float("nan"), 0]])
def test_sampler_rejects_outside_and_nonfinite_points(point):
    surface = {"vertices": 2, "location_cm": [0, 0, 0], "scale": [100, 100, 100]}
    with pytest.raises(ValueError):
        frame.sample_heightmap(np.full((2, 2), 32768, dtype=np.uint16), surface, [point])


def test_sampler_rejects_malformed_exported_heightmap():
    surface = {"vertices": 2, "location_cm": [0, 0, 0], "scale": [100, 100, 100]}
    with pytest.raises(ValueError):
        frame.sample_heightmap(np.zeros((2, 2), dtype=np.uint8), surface, [[0, 0]])


def test_projected_boundary_roundoff_is_snapped_but_exterior_points_still_fail():
    size, centre = 4032.01, 500000.1
    half = size / 2
    edge = (centre + half) - centre
    assert edge > half
    surface = {"vertices": 505, "location_cm": [-half * 100, -half * 100, 0],
               "scale": [size / 504 * 100, size / 504 * 100, 100]}
    heights = np.full((505, 505), 32768, dtype=np.uint16)
    points = [[edge, 0], [-edge, 0], [0, edge], [0, -edge]]
    assert frame.sample_heightmap(heights, surface, points) == pytest.approx([0, 0, 0, 0])
    with pytest.raises(ValueError, match="outside"):
        frame.sample_heightmap(heights, surface, [[half + 1e-5, 0]])
