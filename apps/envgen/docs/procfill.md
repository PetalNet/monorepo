# Procedural ground masks

`procfill.py` fits appearance priors to a drone orthophoto, then samples fine ground features where only coarse imagery exists. The stage runs when the site has an orthophoto and a grass layer. It uses the existing NumPy, SciPy, Rasterio, and scikit-image dependencies. Python keeps this geospatial work beside the existing raster pipeline.

The fit uses a bounded grid with a target spacing of 0.25 m. RGB greenness and local texture distinguish short grass, stubble, and rough growth. These are inferred appearance labels. They do not establish species, mowing height, or whether a pale patch is stone or soil. Native RGB values do not become material albedos.

The version 1 priors record the following observations:

- Grass appearance shares for three NAIP green/red colour classes. A class without training samples uses the global share.
- Windrow spacing, apparent width, and orientation from spectral peaks in independent 16 m windows. The search interval is a 1 to 5 m prior. A failed fit uses an explicitly tagged 2 m spacing and 0.35 m width prior.
- Widths of narrow pale components and their distances to coarse path candidates.
- Weed and bare-patch component radii, aspect ratios, counts, and cover shares. At most 64 empirical size samples are retained per feature.
- Crown radii from the survey DSM minus DTM, split with the existing crown watershed.

The fitted file is `procfill_priors.json` in each build. It includes its schema version, settings, thresholds, and source hashes. `examples/procfill-priors-v1.json` is a reference fit with no site coordinates. It is an audit artifact; builds refit their own survey rather than using that site's statistics.

## Constraints and rendering

Zone placement preserves each NAIP class's fitted shares. Slope, field edges, canopy, and path proximity choose where the zones lie. Mow lines follow field principal directions with the survey's angular variation, and their phase bends around canopy, roads, and field edges. Narrow corridors near path candidates supply possible wear lines. Those lines are hypotheses, not mapped paths or entrances.

Clump placement samples fitted sizes and cover shares. Crown silhouettes stay within height-supported canopy. `procfill_trees.json` adds a visual crown scale to a copy of the tree inventory. The scale is a presentation prior, `0.7 + 0.3 × mean crown-mask value within the measured envelope`. Original tree positions, heights, radii, species, and collision envelopes remain in the source inventory.

Generated exposure transfers weight from grass to soil, with weights summing to 255. Growth RGB uses the ground builder's encoding: short-tuft density, tall-tuft density, and height divided by two. Alpha holds an additive ground-detail term, encoded as `127 + 127 × log2(ratio)`. Unreal applies that term after source detail and survey detail, so painted changes also reach surveyed ground. The original detail file is retained. This branch's grass renderer consumes density R; the ground branch consumes the separate density and height channels.

The density and height response is a visual prior: short/stubble/rough density is 0.55/0.75/0.9, tall density is 0.05 except rough at 0.8, and height/2 is 0.25/0.35/0.8. Windrows add 0.12 stops, weeds subtract 0.08, and wear subtracts 0.10. Exposure suppresses density. No new grass varieties, draw distances, or instance budgets are added here.

## Provenance and confidence

Each mask has separate `_source.png` and `_confidence.png` images. Source IDs are 1 measured, 2 inferred, 3 generated, and 4 painted. Drone-derived appearance labels are inferred. `procfill_evidence_source.png` separately marks measured drone coverage and inferred coarse evidence. A canopy's hidden ground never becomes measured ground.

Confidence bytes encode subjective evidence strength, not calibrated probabilities. Survey appearance is 0.8, coarse class evidence is 0.6, generated detail is 0.35, and paint is 0.5. The combined debug image selects the lowest confidence among active masks. Ties retain the earlier mask in the manifest's mask order. Inactive zero-valued feature masks do not compete.

The palette is green for measured pixels, blue for inference, orange for generation, and magenta for paint. These colours identify evidence type. They do not describe vegetation. Set `procfill.debug_view` to `true` in a copy of `build.json` and rebuild the Unreal level to show `procfill_debug.png` without lighting or exposure. To inspect the measured input footprint instead, set `procfill.debug_file` to `procfill_evidence_debug.png`. Rebuild from the ordinary manifest to restore ground rendering.

## Validation

Five spatial folds with 32 m tiles hide one fold at a time. Each fold refits thresholds and priors, excludes a 4 m training buffer, and generates from coarse inputs alone. The report records zone shares and total variation, weed and bare coverage, component size and aspect distributions, windrow spacing and width, and held-out survey crown sizes against the training distribution.

Every skipped fold has a reason. Fewer than five evaluated folds produces `insufficient_coverage`. Validation reports discrepancies rather than declaring a realism pass. The labels come from the same automatic appearance classifier on held-out RGB, not independent manual ground truth. These folds are development diagnostics, not a blind final test.

Holdout generation runs on the pooled survey grid. Exported game masks use the existing detail grid, with spacing in `procfill.cell_m`. Shapes smaller than a game-mask cell cannot retain their outline after export and filtering. The validation numbers describe the sampler's appearance distributions, not rendered pixels.
