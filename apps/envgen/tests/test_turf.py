import numpy as np

from envgen import turf


def test_tuft_footprints_stay_inside_grass_at_a_diagonal_paved_edge():
    rows, columns = np.indices((64, 64))
    grass = (columns > rows).astype(np.float32)
    flat = np.zeros(grass.shape)
    packed, _ = turf.growth(grass, np.zeros((3, *grass.shape)), flat, flat, 0.5, 7)

    # The first two diagonals cannot contain a tuft plus its filtered placement footprint.
    assert packed[:2, (columns > rows) & (columns <= rows + 2)].max() == 0
    assert np.all(packed[0, columns > rows + 5] == 1)
    assert packed[:2, columns <= rows].max() == 0


def test_photo_wear_shortens_continuous_grass_without_growing_on_paving():
    grass = np.ones((96, 96), dtype=np.float32)
    grass[:, :12] = 0
    ratio = np.zeros((3, 96, 96), dtype=np.float32)
    ratio[1, :, 48:] = 0.15
    flat = np.zeros(grass.shape)
    packed, report = turf.growth(grass, ratio, flat, flat, 0.5, 7)

    assert packed[:2, :, :12].max() == 0
    assert packed[:2, :, 12].max() == 0
    assert np.all(packed[0, :, 13:] == 1)
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


def test_path_majority_cells_do_not_place_tufts_but_grass_keeps_full_density():
    grass = np.ones((32, 32), dtype=np.float32)
    grass[:, :8] = 0
    grass[:, 8:10] = 0.25
    grass[:, 10:12] = 0.49
    grass[:, 12:16] = 0.51
    flat = np.zeros(grass.shape)
    packed, _ = turf.growth(grass, np.zeros((3, 32, 32)), flat, flat, 0.5, 7)

    assert packed[:2, :, :13].max() == 0
    assert np.all(packed[0, :, 13:] == 1)


def test_paving_far_from_the_grass_edge_does_not_receive_the_fringe_height_boost():
    grass = np.ones((24, 24), dtype=np.float32)
    grass[:, 12:] = 0.2
    flat = np.zeros(grass.shape)
    packed, _ = turf.growth(grass, np.zeros((3, *grass.shape)), flat, flat, 1, 7)

    assert np.all(packed[0, :, :11] == 1)
    assert packed[:2, :, 11].max() == 0
    assert packed[:2, :, 12:].max() == 0
    assert packed[2, :, -3:].mean() < packed[2, :, 11:13].mean()


def test_appearance_distinguishes_wear_from_edges_without_changing_placement():
    grass = np.ones((96, 96), dtype=np.float32)
    grass[:, :12] = 0
    ratio = np.zeros((3, 96, 96), dtype=np.float32)
    ratio[1, :, 48:] = 0.15
    flat = np.zeros(grass.shape)
    before, _ = turf.growth(grass, ratio, flat, flat, 0.5, 7)
    appearance = turf.condition(grass, ratio, 0.5).physical

    assert appearance[:, :, :12].max() == 0
    assert appearance[0, 12:-12, 20:40].mean() > appearance[0, 12:-12, 60:80].mean()
    assert appearance[1, :, 12:14].mean() > 0.5
    assert appearance[1, :, 20:].max() == 0
    assert np.array_equal(before, turf.growth(grass, ratio, flat, flat, 0.5, 7)[0])


def test_uniform_or_empty_photo_does_not_invent_wear_or_an_edge():
    flat = np.zeros((24, 24))
    for grass in (flat, flat + 1):
        assert not turf.condition(grass, np.zeros((3, *grass.shape)), 0.5).physical.any()


def test_colour_extends_nearest_grass_without_changing_physical_controls():
    from scipy import ndimage

    grass = np.zeros((7, 9), dtype=np.float32)
    grass[1:3, 1:3] = 1
    grass[4:6, 6:8] = 1
    ratio = np.zeros((3, *grass.shape), dtype=np.float32)
    ratio[1] = np.arange(grass.size).reshape(grass.shape)
    controls = turf.condition(grass, ratio, 0.5)
    inside = grass > 0.5
    signal = ndimage.gaussian_filter(ratio[1] - ratio[0], turf.GROWTH_SETTINGS["patch_m"] / 0.5)
    low, high = np.percentile(signal[inside], [5, 95])
    wear = 1 - np.clip((signal - low) / (high - low), 0, 1)
    edge = np.clip(1 - ndimage.distance_transform_edt(inside) * 0.5 / turf.GROWTH_SETTINGS["fringe_m"], 0, 1)
    original = np.stack([wear * inside, edge * inside, np.zeros(grass.shape)]).astype(np.float32)
    nearest = ndimage.distance_transform_edt(~inside, return_distances=False, return_indices=True)
    assert np.array_equal(controls.physical, original)
    assert np.array_equal(controls.colour, original[:, nearest[0], nearest[1]])
    assert np.any(inside & (original[0] == 0))
    assert np.any((~inside) & (controls.colour[0] == 0))


def test_colour_empty_and_full_grass_match_physical():
    for value in (0, 1):
        grass = np.full((5, 7), value, dtype=np.float32)
        controls = turf.condition(grass, np.zeros((3, *grass.shape)), 0.5)
        assert np.array_equal(controls.colour, controls.physical)
        assert not controls.colour.any()
