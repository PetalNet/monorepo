# Procedural ground masks

`procfill.py` fits appearance priors to a drone orthophoto, then samples fine ground features where only coarse imagery exists. The stage runs when the site has an orthophoto and a grass layer. It uses the existing NumPy, SciPy, Rasterio, and scikit-image dependencies. Python keeps this geospatial work beside the existing raster pipeline.

The fit uses a bounded grid with a target spacing of 0.25 m. RGB greenness and local texture distinguish short grass, stubble, and rough growth. These are inferred appearance labels. They do not establish species, mowing height, or whether a pale patch is stone or soil. Native RGB values do not become material albedos.

The version 2 priors record the following observations:

- Grass appearance shares for three NAIP green/red colour classes. A class without training samples uses the global share.
- Windrow spacing and orientation from spectral peaks in independent 16 m windows. Peaks within 95% of the strongest power prefer the longer period, so equally strong harmonics of thin rows do not win. A local quadratic fit to log power refines the frequency before phase folding, avoiding drift from the discrete FFT bins. Width is the half-height width of the residual folded along the fitted normal, restricted to stubble. Folding separates the repeated row signal from unrelated fine texture. Fewer than 16 occupied phase bins leaves width unresolved: that window uses a tagged 0.35 m prior. Crest occupancy against each phase bin's own half-height estimates row continuity. The search interval is a 1 to 5 m prior. A failed spectral fit uses an explicitly tagged 2 m spacing and 0.35 m width prior.
- Widths of narrow pale components and their distances to coarse path candidates.
- Weed and bare-patch component radii, aspect ratios, counts, and cover shares. At most 64 empirical size samples are retained per feature.
- Crown radii from the survey DSM minus DTM, split with the existing crown watershed.

The fitted file is `procfill_priors.json` in each build. It includes its schema version, settings, thresholds, and source hashes. `examples/procfill-priors-v2.json` is a reference fit with no site coordinates. It is an audit artifact; builds refit their own survey rather than using that site's statistics. Version 1 remains as a historical reference. Its widths use a different estimator and cannot be compared directly with version 2 widths.

## Constraints and rendering

Zone placement preserves each NAIP class's fitted shares separately on visible and occluded ground, using the coarse cover and shadow evidence. This prevents canopy and shadow from absorbing rough growth fitted to visible ground. Slope, field edges, canopy, and path proximity choose where the zones lie within each pool. Mow lines follow field principal directions with the survey's angular variation, and their phase bends around canopy, roads, and field edges. Widths sampled on a 16 m lattice vary within a connected field, capped at 95% of its row spacing. Median training crest occupancy controls breaks on a 3 m noise lattice, an explicit segment-scale prior. Narrow corridors near path candidates supply possible wear lines. Those lines are hypotheses, not mapped paths or entrances.

Clump placement samples fitted sizes and cover shares. The sampler counts cells above half strength after overlap and clipping, then fills the remaining cover deficit from unoccupied centres. The softened ellipse's half-strength contour has the fitted equivalent area. If the last clump exceeds the remaining cover budget, its outer cells are trimmed. A below-cell clump occupies one mask cell; its original outline cannot survive that raster. Requested cover is capped at 95%. Weed placement compensates for wear exclusions within rough ground. Crown silhouettes stay within height-supported canopy. `procfill_trees.json` adds a visual crown scale to a copy of the tree inventory. The scale is a presentation prior, `0.7 + 0.3 × mean crown-mask value within the measured envelope`. Original tree positions, heights, radii, species, and collision envelopes remain in the source inventory.

Generated exposure transfers weight from grass to soil, with weights summing to 255. Growth RGB uses the ground builder's encoding: short-tuft density, tall-tuft density, and height divided by two. Alpha holds an additive ground-detail term, encoded as `127 + 127 × log2(ratio)`. Unreal applies that term after source detail and survey detail, so painted changes also reach surveyed ground. The original detail file is retained. This branch's grass renderer consumes density R; the ground branch consumes the separate density and height channels.

The density and height response is a visual prior. Short grass keeps density 0.55 and height/2 of 0.25. Windrows lower stubble density from 0.75 to 0.60 and height/2 from 0.35 to 0.25. Within rough ground, weed strength raises density from 0.65 to 0.90, tall density from 0.25 to 0.80, and height/2 from 0.40 to 0.80. This gives clumps a response distinct from their surroundings, with every channel bounded by the previous maximum. The ground branch consumes the stature channels; this branch's renderer consumes density alone. Windrows add 0.12 stops, weeds subtract 0.08, and wear subtracts 0.10. Exposure suppresses density. No new grass varieties, draw distances, shader operations, or instance budgets are added here.

## Provenance and confidence

Each mask has separate `_source.png` and `_confidence.png` images. Source IDs are 1 measured, 2 inferred, 3 generated, and 4 painted. Drone-derived appearance labels are inferred. `procfill_evidence_source.png` separately marks measured drone coverage and inferred coarse evidence. A canopy's hidden ground never becomes measured ground.

Confidence bytes encode subjective evidence strength, not calibrated probabilities. Survey appearance is 0.8, coarse class evidence is 0.6, generated detail is 0.35, and paint is 0.5. The combined debug image selects the lowest confidence among active masks. Ties retain the earlier mask in the manifest's mask order. Inactive zero-valued feature masks do not compete.

The palette is green for measured pixels, blue for inference, orange for generation, and magenta for paint. These colours identify evidence type. They do not describe vegetation. Set `procfill.debug_view` to `true` in a copy of `build.json` and rebuild the Unreal level to show `procfill_debug.png` without lighting or exposure. To inspect the measured input footprint instead, set `procfill.debug_file` to `procfill_evidence_debug.png`. Rebuild from the ordinary manifest to restore ground rendering.

## Validation

Five spatial folds with 32 m tiles hide one fold at a time. Each fold refits thresholds and priors, excludes a 4 m training buffer, and generates from coarse inputs alone, including the same coarse visibility mask used for export. The report records zone shares and total variation, weed and bare coverage, component size and aspect distributions, windrow spacing and width, and held-out survey crown sizes against the training distribution.

Every skipped fold has a reason. Fewer than five evaluated folds produces `insufficient_coverage`. Width summaries include only resolved fits; separate counts record windows that required the width prior. Validation reports discrepancies rather than declaring a realism pass. The labels come from the same automatic appearance classifier on held-out RGB, not independent manual ground truth. These folds are development diagnostics, not a blind final test.

Holdout generation runs on the pooled survey grid. Exported game masks use the existing detail grid, with spacing in `procfill.cell_m`. Shapes smaller than a game-mask cell cannot retain their outline after export and filtering. The validation numbers describe the sampler's appearance distributions, not rendered pixels.

The phase-bin threshold checks whether the profile has enough samples. It does not prove that the physical row is resolved. A narrow row can still look broader on a coarse raster, even when tagged as fitted.
