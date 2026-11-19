"""The grass the engine grows on the grass class: what is sourced, what is a prior, and the rules that tie them.

Nothing here is drawn by this module. It writes the numbers into the manifest (`turf`) and the level build reads them,
so no tuft size, count or distance lives in the engine code. Each variety says where its numbers come from.

Three varieties share one rule: tufts cover a share of the ground, so a bigger tuft is fewer. The nearest is a small
dense tuft, the next a broad clump that carries the same blade cover out to where a small tuft would be under a pixel,
and a third, taller and sparse, stands in for what the mower left (one tuft in a few dozen).
"""

from __future__ import annotations

import math

# Cool-season lawn turf is mown at 3 to 4 inches in summer: a land-grant university extension guide (publications MG10
# and G6705). The tufts' blades are that tall.
MOWING_HEIGHT_CM = (3 * 2.54, 4 * 2.54)
# A prior: turf is mown when it has grown a half again over its cutting height (the one-third rule of mowing), so the
# tall variety stands at 1.5 times the top of the mowing range.
TALL_OVER_MOWED = 1.5
# Priors, looks with no source: how big a tuft is, how many blades it has, how much ground each variety covers, how far
# out each is drawn, whether it casts a shadow (a small tuft's own shadow only darkens its root), and how much a tuft's
# size varies.
NEAR = {"blades": 18, "radius_cm": 9.0, "cover": 0.9, "start_cull_cm": 800, "end_cull_cm": 1500, "casts_shadow": False}
CLUMP = {
    "blades": 36,
    "radius_cm": 22.5,
    "cover": 0.4,
    "start_cull_cm": 2500,
    "end_cull_cm": 6500,
    "casts_shadow": False,
}
TALL = {"blades": 8, "radius_cm": 6.0, "cover": 0.04, "start_cull_cm": 2500, "end_cull_cm": 5000, "casts_shadow": True}
SIZE_SPREAD = (0.85, 1.15)
# The tufts' density follows a slow noise so they stand in patches, not at an even spacing: the density multiplier
# runs from MIN to 1 across patches PATCH_CM wide. A prior.
PATCH_CM = 400.0
PATCH_MIN = 0.35
# A blade's brightness from root to tip. A prior.
ROOT_SHADE, TIP_SHADE = 0.85, 1.15

PRIORS = [
    f"prior: a tuft covers {NEAR['cover']:.0%} (near), {CLUMP['cover']:.0%} (clump) and {TALL['cover']:.0%} (tall) of the ground",
    "prior: blade count, tuft radius, size spread and draw distance of each variety",
    f"prior: tall tufts stand {TALL_OVER_MOWED:g} times the top of the mowing range (the one-third rule of mowing)",
    f"prior: tufts stand in patches {PATCH_CM:g} cm wide, thinning to {PATCH_MIN:g} of the density between them",
    f"prior: a blade is {ROOT_SHADE:g} of its colour at the root and {TIP_SHADE:g} at the tip",
]


def _variety(name: str, spec: dict, height_cm: tuple[float, float], source: str) -> dict:
    per_m2 = spec["cover"] / (math.pi * (spec["radius_cm"] / 100) ** 2)
    return {
        "name": name,
        "blades": spec["blades"],
        "radius_cm": spec["radius_cm"],
        "height_cm": list(height_cm),
        "height_source": source,
        "density_per_100m2": round(per_m2 * 100, 1),
        "scale": list(SIZE_SPREAD),
        "start_cull_cm": spec["start_cull_cm"],
        "end_cull_cm": spec["end_cull_cm"],
        "casts_shadow": spec["casts_shadow"],
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
        ],
        "patch_cm": PATCH_CM,
        "patch_min": PATCH_MIN,
        "root_shade": ROOT_SHADE,
        "tip_shade": TIP_SHADE,
        "priors": PRIORS,
    }
