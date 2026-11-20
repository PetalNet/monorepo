import numpy as np

from envgen import turf


def test_photo_wear_shortens_continuous_grass_without_growing_on_paving():
    grass = np.ones((96, 96), dtype=np.float32)
    grass[:, :12] = 0
    ratio = np.zeros((3, 96, 96), dtype=np.float32)
    ratio[1, :, 48:] = 0.15
    flat = np.zeros(grass.shape)
    packed, report = turf.growth(grass, ratio, flat, flat, 0.5, 7)

    assert packed[:2, :, :12].max() == 0
    assert np.all(packed[0, :, 12:] == 1)
    assert packed[2, 12:-12, 20:40].mean() < packed[2, 12:-12, 60:80].mean()
    assert np.array_equal(packed, turf.growth(grass, ratio, flat, flat, 0.5, 7)[0])
    assert report["priors"] and np.isfinite(packed).all()


def test_edges_and_canopy_carry_taller_grass_but_flat_colour_still_has_clumps():
    grass = np.ones((96, 96), dtype=np.float32)
    grass[:, :12] = 0
    flat = np.zeros(grass.shape)
    canopy = flat.copy()
    canopy[40:60, 40:60] = 8
    packed, _ = turf.growth(grass, np.zeros((3, 96, 96)), canopy, flat, 0.5, 7)

    assert packed[1, :, 13:15].mean() > packed[1, 10:30, 30:50].mean() * 2
    assert packed[1, 44:56, 44:56].mean() > packed[1, 10:30, 30:50].mean() * 2
    assert packed[2, 44:56, 44:56].mean() > packed[2, 10:30, 30:50].mean()
    assert packed[2, 10:30, 30:50].std() > 0.005


def test_no_grass_or_no_paving_stays_finite_without_inventing_an_edge():
    flat = np.zeros((32, 32))
    for grass in (flat, flat + 1):
        packed, _ = turf.growth(grass, np.zeros((3, 32, 32)), flat, flat, 1, 0)
        assert np.isfinite(packed).all() and packed.min() >= 0 and packed.max() <= 1
    assert turf.growth(flat, np.zeros((3, 32, 32)), flat, flat, 1, 0)[0][:2].max() == 0


def test_mixed_path_edge_retains_grass_for_the_engines_fractional_placement_weight():
    grass = np.ones((32, 32), dtype=np.float32)
    grass[:, :8] = 0
    grass[:, 8:12] = 0.25
    flat = np.zeros(grass.shape)
    packed, _ = turf.growth(grass, np.zeros((3, 32, 32)), flat, flat, 0.5, 7)

    placed = packed[:2] * grass
    assert placed[:, :, :8].max() == 0
    assert placed[0, :, 8:12].min() > 0
    assert placed[0, :, 8:12].max() < placed[0, :, 16:].min()
