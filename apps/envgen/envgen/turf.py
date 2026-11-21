"""The grass the engine grows on the grass class: what is sourced, what is a prior, and the rules that tie them.

Nothing here is drawn by this module. It writes the numbers into the manifest (`turf`) and the level build reads them,
so no blade size, count or distance lives in the engine code. Each variety says where its numbers come from.

Three varieties share one rule: a variety is so much leaf over each square metre of ground (its leaf area index), so
a wider blade is fewer blades. The nearest is the sward itself, blade by blade. The next carries the same texture out
to where a blade is far under a pixel, with blades as wide as a pixel is where the nearest ends. A third,
taller and sparse, stands in for what the mower left.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

GROWTH_SETTINGS = {
    "kind": "prior",
    "placement": "full grass-majority support with per-blade root clipping in the engine",
    "patch_m": 1.2,
    "fringe_m": 2.0,
    "density_range": [1.0, 1.0],
    "height_range": [0.85, 1.5],
    "relief_m": 6.0,
}

# November campus JPEG proxies, not absolute albedo or measurements of the September build site.
FIELD_CALIBRATION = {
    "source": "Parker's campus grass photographs, 2026-11-20; concrete-normalized linear sRGB proxies",
    "absolute_albedo_calibrated": False,
    "in_site_bbox": False,
    "fractions_basis": "resolved projected image area; never placement or blade-count probabilities",
    "soil_candidate_is_bare_soil": False,
    "surfaces": {
        "maintained": {"green": [0.07810345, 0.10891961, 0.02811268],
                       "dry": [0.15179425, 0.12629397, 0.05261628], "mix": [0.68874832, 0.29389755, 0.01735413]},
        "worn": {"green": [0.08249069, 0.10680960, 0.04226161],
                 "dry": [0.16687493, 0.13658607, 0.10252904], "mix": [0.25776350, 0.65135831, 0.09087819]},
        "edge": {"green": [0.09223241, 0.12025581, 0.03333555],
                 "dry": [0.16728298, 0.13328318, 0.05658665], "mix": [0.35807610, 0.60851618, 0.03340772]},
    },
    "soil": [0.27434814, 0.24857435, 0.21342961],
    "dry_tuft_diameter_m": [0.16190692, 0.39658934],
    "spatial_uncertainty_factor_at_least": 2,
    "fade_cm": [1500, 3000],
    "application_priors": [
        "relative photo green/red contrast interpolates maintained and worn appearance; not a measured condition map",
        "the existing 2 m surface fringe interpolates path-edge appearance",
        "projected-area mixtures retain condition colour around one maintained luminance reference; site luminance supplies nearby variation and non-soil candidates use dry colour times root shade as low thatch",
        "living and dead colours mix a tileable multiscale field with per-leaf variation; the conditional dry-tuft range sets its characteristic scale and mapped condition supplies larger wear patterns",
        "the short ground cover and blade bases use root shade beneath upright leaves; this is a canopy-lighting prior",
        "calibration fades from 15 to 30 m in steep views; grazing ground views retain short cover through the distant tuft handoff",
    ],
}


def condition(grass: np.ndarray, log_ratio: np.ndarray, cell_m: float) -> np.ndarray:
    """RGB appearance controls: relative wear, inside-edge proximity, reserved zero. No placement changes."""
    inside = grass > 0.5
    signal = ndimage.gaussian_filter(log_ratio[1] - log_ratio[0], GROWTH_SETTINGS["patch_m"] / cell_m)
    low, high = np.percentile(signal[inside], [5, 95]) if inside.any() else (0.0, 0.0)
    wear = 1 - np.clip((signal - low) / (high - low), 0, 1) if high - low > 1e-5 else np.zeros(grass.shape)
    edge = (np.clip(1 - ndimage.distance_transform_edt(inside) * cell_m / GROWTH_SETTINGS["fringe_m"], 0, 1)
            if inside.any() and (~inside).any() else np.zeros(grass.shape))
    return np.stack([wear * inside, edge * inside, np.zeros(grass.shape)]).astype(np.float32)


def growth(
    grass: np.ndarray,
    log_ratio: np.ndarray,
    canopy: np.ndarray,
    elevation: np.ndarray,
    cell_m: float,
    seed: int,
) -> tuple[np.ndarray, dict]:
    """RGB: short-tuft density, tall-tuft density, and height divided by two, all in [0, 1].

    The photo supplies the pattern, not a measured blade height. The response of turf to colour,
    unmown edges, canopy and local hollows is a tagged prior. No new paths or tree positions are drawn.
    """
    inside = grass > 0.5
    sigma = GROWTH_SETTINGS["patch_m"] / cell_m
    # A relative green/red ratio retains pale wear in the photo without treating its shade as bare ground.
    signal = ndimage.gaussian_filter(log_ratio[1] - log_ratio[0], sigma)
    low, high = np.percentile(signal[inside], [5, 95]) if inside.any() else (0.0, 0.0)
    vigour = np.clip((signal - low) / (high - low), 0, 1) if high - low > 1e-5 else np.full(grass.shape, 0.6)
    fringe = (
        np.clip(1 - np.where(inside, ndimage.distance_transform_edt(inside),
                             ndimage.distance_transform_edt(~inside)) * cell_m / GROWTH_SETTINGS["fringe_m"], 0, 1)
        if inside.any() and (~inside).any()
        else np.zeros(grass.shape)
    )
    sheltered = ndimage.gaussian_filter((canopy > 2).astype(float), sigma)
    hollow = ndimage.gaussian_filter(elevation, GROWTH_SETTINGS["relief_m"] / cell_m) - elevation
    spread = float(np.percentile(np.abs(hollow), 90))
    moisture = np.clip(hollow / spread, -1, 1) if spread > 1e-5 else np.zeros(grass.shape)
    rng = np.random.default_rng(seed)
    noise = ndimage.gaussian_filter(rng.standard_normal(grass.shape), sigma)
    noise = np.clip(noise / max(float(noise.std()), 1e-6), -2, 2) / 2
    density = np.ones(grass.shape)
    tall = np.clip(0.04 + 0.80 * np.maximum(fringe, sheltered) + 0.12 * np.maximum(noise, 0), 0, 1)
    height = np.clip(0.90 + 0.25 * vigour + 0.25 * np.maximum(fringe, sheltered) + 0.10 * noise + 0.05 * moisture,
                     *GROWTH_SETTINGS["height_range"])
    # Fractional engine placement alone still puts full-sized tufts on path-majority cells.
    # Keep every grass-majority cell at its original density; stop support on the path side.
    support = inside
    packed = np.stack([density * support, tall * support, height / 2])
    return packed.astype(np.float32), {
        "settings": GROWTH_SETTINGS,
        "photo_green_red_log2_p5_p95": [float(low), float(high)],
        "density_p5_p95": np.percentile(density[support], [5, 95]).tolist() if support.any() else [],
        "height_multiplier_p5_p95": np.percentile(height[inside], [5, 95]).tolist() if inside.any() else [],
        "source": "de-shadowed photo detail ratio, surface weights, canopy height and terrain elevation",
        "priors": [
            "prior: relative green/red photo contrast maps to turf height, not a measured mowing height",
            "prior: grass grows taller within 2 m of a surface edge and under canopy higher than 2 m",
            "prior: local hollows favour growth; relief is terrain minus its 6 m low-pass",
            "prior: continuous short sward at the original density; photo surface weights alone reduce coverage",
            "prior: 1.2 m correlated height noise; height 0.85 to 1.5 times the mowing range",
            "prior: individual engine root clipping preserves every grass-majority cell at full density",
        ],
    }

# Cool-season lawn turf is mown at 3 to 4 inches in summer: a land-grant university extension guide (publications MG10
# and G6705). The blades are that tall.
MOWING_HEIGHT_CM = (3 * 2.54, 4 * 2.54)
# A prior: turf is mown when it has grown a half again over its cutting height (the one-third rule of mowing), so the
# tall variety stands at 1.5 times the mowing range.
TALL_OVER_MOWED = 1.5
# Priors: the lens and frame a still is taken with. They set how wide a blade has to be to show at a distance.
LENS_FOV_DEG = 90.0
FRAME_PX = 1920
# Default root widths in centimetres retain the distant geometry; the near variety overrides them with finer leaves.
NEAR_BLADE_WIDTH_CM = (0.8, 1.4)
# Priors, looks with no source: the leaf area index each variety is drawn at, how many blades stand in one tuft and
# how wide the tuft is, how far out each is drawn, that none casts a shadow (a tuft's own shadow blackens it against
# a sward that has none), and how much a tuft's size varies. The index of real mown turf is several times the near one: what is
# drawn is the top of the sward, and the ground's own colour under it is the rest.
NEAR = {"leaf_area_index": 2.0, "blades": 66, "blade_width_cm": [0.29, 0.51], "radius_cm": 14.0,
        "start_cull_cm": 800, "end_cull_cm": 1500}
CLUMP = {"leaf_area_index": 0.2, "blades": 24, "radius_cm": 22.5, "start_cull_cm": 2500, "end_cull_cm": 6500,
         "appear_cm": [800, 1500]}
TALL = {"leaf_area_index": 0.02, "blades": 8, "radius_cm": 6.0, "start_cull_cm": 2500, "end_cull_cm": 5000}
CASTS_SHADOW = {"near": False, "clump": False, "tall": False}
SIZE_SPREAD = (0.85, 1.15)
# A blade's brightness from root to tip. A prior.
ROOT_SHADE, TIP_SHADE = 0.65, 1.12

CANOPY_RESPONSE = {
    "kind": "prior",
    "lawn_repeat_cm": 400.0,
    "lawn_pixels_per_m": 512,
    "lawn_leaves_per_m2": 16000,
    "dry_height_ratio": 0.25,
    "edge_mowing_height_ratio": 1 / TALL_OVER_MOWED,
    "grazing_view_sine_range": [0.15, 0.35],
}

PRIORS = [
    f"prior: leaf area index drawn: {NEAR['leaf_area_index']:g} (near), {CLUMP['leaf_area_index']:g} (clump), {TALL['leaf_area_index']:g} (tall)",
    "prior: blade count, tuft radius, size spread and draw distance of each variety",
    f"prior: a near blade is {NEAR['blade_width_cm'][0]:g} to {NEAR['blade_width_cm'][1]:g} cm wide at the root",
    f"prior: stills have a {LENS_FOV_DEG:g} degree lens and {FRAME_PX} pixels across; a far blade is a pixel wide at the clump's full-size distance of {CLUMP['appear_cm'][1] / 100:g} m",
    f"prior: tall tufts stand {TALL_OVER_MOWED:g} times the mowing range (the one-third rule of mowing)",
    f"prior: a blade is {ROOT_SHADE:g} of its colour at the root and {TIP_SHADE:g} at the tip",
    "prior: no variety casts a shadow",
    "prior: the clump variety retains its 8 to 15 m transition; near blades overlap that transition above a continuous lawn texture",
    "prior: a 4 m lawn tile retains 512 pixels and 16000 texture leaves per square metre to avoid a 1 m worn-patch repeat",
    "prior: dead blades reduce to one quarter height at maximum photo wear; surviving grass retains its height and all leaf counts stay full",
    "prior: tall edge blades return to mowing height nearby; near blades retain their height up to the shared grass-majority root boundary",
    "prior: worn and edge height responses restore the original geometry over the calibration's 15 to 30 m fade",
    "prior: at surface-view sines below 0.15, short cover fades over 30 m to the clump cull distance; above 0.35 the original 15 to 30 m material fade remains",

]


def pixel_cm(distance_cm: float) -> float:
    """How wide one pixel of a still is at a distance."""
    return distance_cm * 2 * math.tan(math.radians(LENS_FOV_DEG) / 2) / FRAME_PX


def _variety(name: str, spec: dict, height_cm: tuple[float, float], source: str) -> dict:
    # Preserve the approved distant blades while the denser near layer overlaps their entrance.
    wide = pixel_cm(spec["appear_cm"][1]) if name == "clump" else 0.0
    root_width = spec.get("blade_width_cm", NEAR_BLADE_WIDTH_CM)
    width = (
        max(root_width[0], wide),
        max(root_width[1], wide * root_width[1] / root_width[0]),
    )
    # A blade tapers from its root width to a point: half its width times its height, both at the middle of their range.
    blade_cm2 = sum(width) / 2 * sum(height_cm) / 2 / 2
    blades_per_m2 = spec["leaf_area_index"] * 10000 / blade_cm2
    return {
        "name": name,
        "blades": spec["blades"],
        "radius_cm": spec["radius_cm"],
        "height_cm": list(height_cm),
        "height_source": source,
        "blade_width_cm": [round(value, 2) for value in width],
        "leaf_area_index": spec["leaf_area_index"],
        "density_per_100m2": round(blades_per_m2 / spec["blades"] * 100, 1),
        "scale": list(SIZE_SPREAD),
        "start_cull_cm": spec["start_cull_cm"],
        "end_cull_cm": spec["end_cull_cm"],
        "appear_cm": spec.get("appear_cm", [0, 0]),
        "casts_shadow": CASTS_SHADOW[name],
    }


def describe() -> dict:
    """The grass for the manifest."""
    mowed = MOWING_HEIGHT_CM
    tall = (mowed[0] * TALL_OVER_MOWED, mowed[1] * TALL_OVER_MOWED)
    mowing_source = "a land-grant extension guide's summer mowing height for cool-season turf, 3 to 4 in (MG10, G6705)"
    return {
        "varieties": [
            _variety("near", NEAR, mowed, mowing_source),
            _variety("clump", CLUMP, mowed, mowing_source),
            _variety("tall", TALL, tall, "prior: mowing range times " + f"{TALL_OVER_MOWED:g}"),
            {
                "name": "broadleaf", "blades": 3, "radius_cm": 4.0, "height_cm": [2.0, 4.0],
                "height_source": "prior: clover-like broadleaf weeds, not a species identified in the imagery",
                "blade_width_cm": [2.0, 3.0], "leaf_area_index": 0.004,
                "density_per_100m2": 60.0, "scale": [0.7, 1.3], "start_cull_cm": 400,
                "end_cull_cm": 800, "appear_cm": [0, 0], "casts_shadow": False,
            },
        ],
        "root_shade": ROOT_SHADE,
        "tip_shade": TIP_SHADE,
        "field_calibration": FIELD_CALIBRATION,
        "canopy_response": CANOPY_RESPONSE,
        "priors": PRIORS,
    }
