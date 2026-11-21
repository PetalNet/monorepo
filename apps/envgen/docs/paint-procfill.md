# Paint procedural ground masks

1. Build the site with `envgen build site.json --out build/ --cache cache/`.
2. Copy a `procfill_<name>.png` image into `build/procfill_edits/<name>.png`. Supported names are `zones`, `windrow`, `wear`, `weeds`, `crown`, and `bare`.
3. Paint the copy as an 8-bit greyscale image at the original dimensions. Zones use 0 for short grass, 1 for stubble, 2 for rough grass, and 255 for no grass. Other masks use 0 to 255 for strength.
4. Run the same build command. The stage hashes the edits and regenerates its downstream files. Painted masks take precedence over automatic masks, including inside drone coverage. Source masks mark the whole replacement image as painted.
5. Rebuild the Unreal level from the new manifest. Grass density, soil weights, ground detail, and visual crown scale consume the edited masks.

The masks have the same extent and orientation as `detail_ratio.png`: image rows run east and columns run north. Keep their size and orientation. Paint cannot create grass on a coarse non-grass surface or trees without an existing height-supported inventory. To change those constraints, edit the underlying surface or canopy evidence.

To supply known path or field constraints, save binary greyscale images at the same dimensions in `build/procfill_context/`. `paths.png` and `roads.png` add to coarse path and road candidates. `entrances.png` supplies entrance candidates. `fields.png` limits mow lines to its white area. The images enter the stage cache key.

Delete an edit image and rebuild to return that mask to automatic generation. Keep `procfill_edits` and `procfill_context` in the private site repository with the source data.
