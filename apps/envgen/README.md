# envgen

Builds a game-ready Unreal environment from data: give it a site boundary and public elevation and
imagery, and it regenerates the level from scratch.

Evidence seeds the shape of the ground, the colour that varies over tens of metres, and what the photo shows
between neighbouring half-metre cells (the detail ratio below). The engine generates everything finer, the same way
everywhere, so quality does not change where one data source ends.

This slice covers the thinnest end-to-end path: site file → elevation → heightmap → Landscape with
one grass layer tinted by a low-pass colour map → collision, a walking pawn, sun and sky, and scripted
tours that measure frame times. It proves the pipeline, scale, collision and the measuring harness.
It does not attempt the final look.

## Site files are private

A site file holds a real boundary and its coordinates. Keep site files, build outputs and logs that
contain them out of this repository; they belong in a private one. The example and the tests use
arbitrary coordinates.

## Pipeline (Python)

```sh
pip install -e ".[test]"
envgen build site.json --out build/ --cache cache/
```

| Stage         | Reads                                              | Writes                                                                                                  |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Acquire       | `site.json` sources                                | each source clipped to the tile, once, into the cache                                                   |
| Structure     | lidar points, if the site has them                 | height above ground, and distance to the nearest ground return                                          |
| Elevation     | the elevation raster                               | `heightmap.png`, 16-bit, Landscape layout                                                               |
| Cover         | lidar heights, a canopy height raster, both        | `canopy_height.tif`, `sunlit.tif`, north-up at 1 m                                                      |
| Surface       | the imagery raster, and which ground is sunlit     | `surface_<class>.png`: one 8-bit weightmap per class                                                    |
| Macro colour  | the imagery, the sunlit ground and the classes     | `macro_colour.png`, low-passed at 12 m within each class; albedo when the site has a reflectance raster |
| Detail        | the imagery, the sunlit ground and the classes     | `detail_ratio.png`: the photo over its own 12 m low-pass, per class, at about 0.5 m, as a power of two  |
| Grain         | a survey orthophoto, the grass class               | `grain.png`: a tileable texture with the orthophoto's grass grain                                       |
| Survey detail | a survey orthophoto, the sunlit ground, classes    | `survey_detail.png`: weighted log detail in RGB, usable-detail weight in alpha                          |
| Surround      | coarse heights and 2048-pixel colour, if asked for | `context_heightmap.png`, `context_colour.png`                                                           |
| Trees         | the cover rasters, the classes, a survey, a mix    | `trees.json`: one row per tree                                                                          |
| Buildings     | footprints, lidar, the photo, the classes          | `buildings.json`: one record per building                                                               |
| Procfill      | survey, coarse imagery, terrain and cover          | `procfill_*.png`, priors, holdout report and a derived tree inventory                                   |
| Manifest      | everything above                                   | `build.json`: placement, georeference, stencil classes, hashes                                          |

- A source is either a local raster (`"kind": "file"`) or an ArcGIS ImageServer
  (`"kind": "arcgis_imageserver"`), which covers USGS 3DEP elevation and many state imagery services.
  Only the tile window plus a 16 m margin is requested, and it is fetched once: the cache key is the service, the window
  and the spacing.
- `sources.lidar` is optional: a `.las`/`.laz` file, or a public EPT point store
  (`"kind": "ept"`, in EPSG:3857). A store is read once; the points kept for the tile are cached,
  so later builds work offline. Where no ground return lies within 3 m, the elevation model was
  interpolated across the gap, typically as flat facets under roofs. The surface there is blended
  towards a 4 m smoothing. Measured ground is left exactly as it was.
- `sources.canopy_height` is optional: a raster of canopy height in metres, as a file or as a
  cloud-optimised GeoTIFF read by window (`"kind": "cog"`, with a `url` GDAL can open, such as
  `/vsicurl/https://...`). Only the window over the tile, and over the surround, is read, once.
- `sources.imagery.bands` is optional: which band holds what, as 1-based numbers, for a raster whose own tags do
  not say (`{"red": 1, "green": 2, "blue": 3, "nir": 4}`). Without it the first three bands are red, green and
  blue. Naming a near-infrared band changes how vegetation is found (see Surface classes).
- `sources.buildings` is optional: building footprints as one GeoJSON in WGS84 (`"kind": "file"`), each feature
  with optional `height_m`, `num_floors`, `id` and `dataset` properties. It needs `sources.lidar` or
  `sources.canopy_height`, because the cover stage is what hides the roofs from the ground. The site's tools make it from Overture Maps'
  buildings, which merge OpenStreetMap with Microsoft's machine-learned footprints (see Buildings).
- `sources.building_imagery` optionally supplies a separate roof-reference raster with pixels at most 0.35 m.
  It uses a local `path`, `license`, and `date`. RGB occupies the first three bands, followed by optional NIR.
  Its CRS is transformed to the site CRS. It does not replace the imagery used for the context surround.
- `sources.building_reference` optionally supplies reviewed observations in a local JSON file, with `license` and
  `date`. Its `buildings` object maps stable building IDs to observations with a required `source`. Supported fields
  include `outline_m` in metres east and north of the tile centre, `outline_uncertainty_m`, `stand_rows`, `stand_aisles`
  as fractions of stand length, `roof_material`, `roof_forms`, and facade `material` and linear `albedo`.
  Roof forms require finite `east_m`, `north_m`, `width_m`, `depth_m`, `height_m`, `from`, and `height_from`.
  Street photographs remain reference material; their pixels are not packaged as textures.
- `sources.reflectance` is optional: a raster file of measured surface reflectance, 0 to 1, near the target date
  (an atmospherically corrected satellite scene, for example), with `bands` naming red, green and blue. It sets each
  class's albedo (see Albedo and light).
- `sources.survey` is optional: a newer surface model of part of the tile (`path`) and its terrain model
  (`terrain`), both files in one vertical frame, any frame. It adds trees the older sources lack (see Trees). With
  `orthophoto` (RGB and an alpha band, in the site's CRS) it also gives the centimetre-scale look of the ground (see
  Grain and survey detail).
- `sources.tree_mix` is optional: a JSON file of the region's tree species from a forest inventory (see Trees).
- `"leaf_off": true` on `sources.lidar` says the survey was flown with the leaves down.
- `"context": {"size_m": 4032}` is optional: a coarse surround of that side, centred on the tile, as
  a second heightmap and colour map. It passes 1 m under the detailed surface, so the tile does not
  end in a cliff against the sky. With a canopy height raster its colour leaves canopy out; the
  lidar and the shadow cover only the tile.
- A stage reruns only when its inputs change. `build.json` lists which stages were reused.
- The site's CRS must be projected, in metres, and have an EPSG code (a UTM zone, for example).
- The tile is a square centred on the boundary, snapped to whole metres. Its side must be a whole
  number of Landscape components (126 quads), for example 1008 m at 0.5 m per quad.

See [`examples/site.example.json`](./examples/site.example.json) for the schema.

### Cover and shadow

What stands over the ground is measured, not read off the colour of the imagery. With lidar, a
canopy height raster, or both, the cover stage writes two rasters that later stages read:

- `canopy_height.tif`: height above ground. Lidar is first: the highest return in each cell minus
  the elevation model. Where the canopy raster shows cover and the lidar does not, its height fills
  in, which catches trees that grew after the lidar survey. `build.json` states how much of the tile
  each source covers and how far they agree.
- `sunlit.tif`: 1 where the imagery shows ground in sunlight, 0 under cover or in its shadow. The
  shadow is cast from the cover and the terrain. The sun's path comes from the tile's position and
  the imagery's date, which must start with `YYYY-MM-DD`. Three things are fitted, each to where
  the ground outside the measured cover is darker than the open ground around it: the time of day,
  how far crowns have spread since the heights were measured, and how much taller they stand.
  `build.json` gives all three, the sun's direction and the correlation before and after growth.

Cover starts at the height where the lidar's heights are sparsest between ground clutter and
canopy; with no such gap it is 2 m, and `build.json` says which. Ground that is not sunlit, and one
cell around it, is left out of the colour map's low-pass and takes its colour from the sunlit
ground around it.

Limits:

- Trees newer than both sources are still in the colour map.
- Growth is one spread and one gain for the whole tile, applied to roofs as well as trees.
- The canopy raster only adds cover. A tree felled after it was made is still counted.
- The surround has no shadow, so open ground between its trees keeps the shade it had.
- These values are set by hand, not measured: the 2 m fallback cutoff, a gap in the heights counting
  when it holds at most half the smaller peak beside it, a sun at least 25 degrees up, brightness
  compared over 30 m, a shadow ray clearing the ground by 0.5 m, and the searched ranges of growth.

### Surface classes

What kind of ground each cell is comes from the imagery, but the split is fitted to this tile, not set by
hand. Only sunlit ground is read: cover and shade hide the colour, so those cells take the class of the
nearest ground that shows it.

- Grass against the rest: Otsu's threshold on `(G - B) / (R + G + B)` over the sunlit cells. Vegetation
  reflects more green than blue; pavement and soil do not. The index is a share of brightness, so one
  material in sun and in dim light gives the same value. Each cell counts by its squared brightness: with the
  same noise in every channel an index's variance goes as one over that, so dark roofs and asphalt, which
  lean blue, do not decide where the cut falls.
- With a near-infrared band named in the site file the grass split is on `(NIR - R) / (NIR + R)` instead. Leaves
  reflect near-infrared and absorb red whether green or dry, so dry turf the colour of pale paving is still
  found. Each cell counts by the square of its red plus near-infrared. Every cell is then read itself, shade and
  cover included: shade dims both bands together, and a cell under cover shows what the cover is. A roof is
  therefore the unvegetated class. A patch of vegetation that cover or shade hides, up to 1000 m2 (a crown, not a wood), then takes the
  class most of the shown ground within 3 m of it has, so a tree over a car park does not paint grass in it. Both
  the rule and its two numbers are priors and listed as such. On the real tile it moved 63616 cells (15 900 m2) and the paved share went from 52.4 % to 54.0 % (a 30 m land cover product says 51 %),
  while the correlation with that product's impervious share by 30 m cell rose from 0.658 to 0.666. The share
  inside the 2026-09 survey's footprint did not change (2.8 %).
- Soil against paved: the same method on `(R - B) / (R + G + B)` over the sunlit cells that are not grass.
- A split is made only when all of these hold. Each group covers at least 1000 m2. The colours are two
  populations: a two-component Gaussian mixture, started from the cut and fitted by EM, has components at
  least 2 pooled standard deviations apart (Ashman's D). The two halves of one Gaussian cut at its mean
  already score 2.7, so D is taken from the fitted components, which overlap for one population. The cells of
  each group form patches, not scatter (the share of neighbouring cells that agree, beyond chance, is at least
  0.5). The upper group leans to its index's colour (its mean is above zero): a group merely less blue than a
  bluer one is not soil. Otherwise the tile stays one class, `grass`, which is a prior and is listed as one in
  `build.json` with the reason.
- Every cell is thresholded on its own; its class is then the majority in the 3 by 3 around it, so the class
  edge lands on the edge in the imagery. The edge is softened over about a metre, and the weights are
  8-bit and sum to 255 in every cell.
- The colour map is low-passed within each class, from that class's sunlit ground only, so a road does not
  grey the grass beside it.

`build.json` has `surface`: each layer's file and share of the tile; check points (vertices where each class
should be found, worked out from the weightmaps by position, which the level build compares with the merged
Landscape); for each split the index, what it was fitted to, the threshold, the fitted mixture, the separation,
the coherence and whether a split was made, with the reason when not; and `settings`, every value set by hand
(tagged `prior`).

On one real tile the colour index had put 60 % of the ground in `paved`. More than half of that was hidden ground
filled from its nearest sunlit neighbour, and dry turf read as paving. With the near-infrared band `paved` is 52 %,
against 51 % impervious in a 30 m land cover product (correlation by 30 m cell 0.76, from 0.66), and inside a
recent low-altitude survey of the open field it fell from 14 % to 3 %.

Limits:

- With near-infrared, synthetic turf is `paved`, and ground under a street tree is `grass`.
- A class is named by its colour: the greener side is called grass. A tile of bare ground and pavement with
  no vegetation would call its greener part grass.
- Soil is whatever unvegetated bright ground is redder than the rest, which may be clay, a track or red roofing.
- The criteria in the third bullet (group size, separation, coherence) and the 1 m edge and 3 cell majority are set by hand, and listed as priors in the manifest.
- A bare-soil class needs soil that sets itself apart from the other ground by this test. Where it is a small share of unvegetated ground spread through the colours of paving, it is not found and stays paved.
- Imagery from one date: dry turf can look like soil and green turf like a lawn; the split follows the day.

### Trees

With a cover stage the build writes `trees.json`: one row per tree with its position in metres east and north of
the tile centre, height, crown radius, kind, species, trunk diameter, crown ratio, confidence, source and a
seeded yaw.

- **Where and how big** are measured. Cover that the imagery shows as vegetation is canopy; a roof is not. The
  canopy heights are smoothed over 1 m and split into crowns: a top is a maximum that stands 1 m clear of any
  saddle to a taller one, and a crown is the ground that drains to it (a watershed). Height is the highest cell;
  the radius is that of the circle covering as much ground as the crown.
- **Not trees.** Crown width is fitted against height over the tile's own crowns; a crown two robust standard
  deviations narrower than the fit is dropped, unless every source that looks at it sees it (a cut at two
  deviations also catches the narrowest real trees). On the real tile 123 of 1502 were that narrow and 118 were
  dropped, light masts 28 m tall and 4 m wide among them.
- **Sources.** Lidar heights first, the canopy raster where the lidar shows none, then the survey: its surface
  model minus its own terrain model. The survey only adds crowns. On the real tile a surface model made from
  photographs taken from above showed 6.6 % cover inside its footprint where the lidar showed 15.6 %, and not a
  row of some 25 trees its own photographs show; its terrain sat on the elevation model with a residual of 1.1 m.
  `build.json` reports both. Confidence is the share of the sources looking at a crown that see it.
- **Kind** (broadleaf or conifer) is measured only when a leaf-off lidar's returns separate the crowns into two
  populations by the share each stops, by the same test the surface classes use. On the real tile they did not
  (nor did winter greenness at 10 m, nor near-infrared brightness), so no kind there is measured.
- **Species** is a prior, and every tree says so: drawn from the mix by kind and height, each species weighted by
  its share and by a log-normal through its measured 10th, 50th and 90th percentile height. The mix also gives
  the trunk diameter (a line fitted to diameter against height) and the crown ratio (the share of the height
  the crown takes). A mix file is `{"source": ..., "species": [{"name", "kind", "share", "height_m": {"p10",
"p50", "p90"}, "trunk_diameter_m": [intercept, slope], "crown_ratio"}]}`.

Limits: the lidar's heights are as old as its survey; a tree felled since is still there, with lower confidence
only where a newer source looks, and the level build does not read confidence, so it stands at full size. An inventory of forests describes forest trees, not ones grown in the open.
Smoothing, prominence, the 4 m2 minimum, the half-crown rule for "seen" and the two deviations are set by hand
and listed in `build.json` under `trees.settings`.

### Albedo and light

The photo records ground lit by the sun and sky of the day. `build.json` `surface.albedo` is one scale that
turns the photo's linear colour into albedo, and `lighting` is the sun the level is lit with.

- The scale is fitted so that the median sunlit paving has the luminous reflectance of a measured light grey
  concrete road (0.288; a prior says the median paving is concrete). The spectrum is a USGS Spectral Library v7
  ASD measurement weighted by the CIE 1931 y-bar curve over 380 to 780 nm (Wyman, Sloan and Shirley's 2013 fit of
  the curve). Not fitted to, but reported in `build.json` beside the fit: the darkest paving against a measured
  old asphalt road (0.088), and the grass class against the library's green lawn grass (0.072), because the
  imagery's turf can be dry and brighter.
- With `sources.reflectance` the scale is 1 and the colour map itself is albedo. For each class and band a power
  law, `reflectance = gain * photo ** gamma`, is fitted by least squares in logarithms over the reflectance pixels
  that are at least 90 % that class and 80 % sunlit in the photo (at least 30 of them; else the class takes the fit
  over all ground, listed as a prior). A photo's tone curve is unknown and need not be linear: on the real tile
  map-tagged concrete was only 1.13 times as bright as asphalt in the photo, against 3.3 in the library, so no one
  scale could fit both. The measurement sets each class's level and its season; the photo places the pattern. A
  curve is trusted only between the 1st and 99th percentile of the reflectance it was fitted to. A band whose
  fitted power is negative (the ground changed between the two dates) keeps its measured level alone, listed as a
  prior. A raster that misses the tile or is not on a 0 to 1 scale is refused. The surround
  takes the tile's split and curves. The library spectra become checks, reported in `build.json`: the paved
  class's 10th and 90th percentile against asphalt and concrete, and the grass median against green lawn. On the
  real tile these read 0.082 against 0.088, 0.200 against 0.288, and 0.071 against 0.072.
- The sun is where astronomy puts it at the target date and at the imagery's mean solar time of day. A dated
  survey with an orthophoto, DSM and DTM fits that time from contemporary shadows; a weak or unavailable survey fit
  retains the cover stage's imagery fit. `lighting.survey_fit` records the acquisition-day fit and its uncertainty.
  The equation of time is not carried over, so on another date the sun can be up to about
  7 degrees of hour angle off the imagery's. A date and time at which the sun is below 5 degrees is refused. Its strength is a clear-sky direct beam (Meinel and Meinel,
  Kasten and Young's air mass, 105 lm/W). Exposure is fixed at the EV100 at which a surface renders at its own
  reflectance before tone mapping, plus an offset tuned on UE 5.8.4 (`ENGINE_EXPOSURE_OFFSET_EV`, a prior listed in
  the manifest) so that sunlit grass is about as bright as in the photo.
- Priors, each listed in the manifest: the 15th when the target is a month, noon solar time when there is no
  fitted time, a clear sky, skylight at 20 % of the sun's, 105 lm/W, and that the median paving is concrete.
- Checked in the engine: the base colour buffer of sunlit grass reads 0.10 in linear light.

The [outdoor atmosphere profile](./atmosphere.md) documents the volumetric clouds, sky-driven haze, outdoor Lumen
settings, contact shadows and camera response, including the weather and lens priors.

Limits:

- The reflectance fit joins two dates. Where the ground changed between the photo and the measurement the curve
  is flatter than the truth, and the pattern is still the photo's. Grass is the class that changes, so it does not
  rest on its curve: see below.
- Reflectance pixels are far coarser than the photo, so the fit sees little of the contrast inside a class and a
  curve is flatter than the photo's real tone curve. The trusted range is of coarse pixels too, so a bright roof
  or a dark patch a few metres across is held to it.
- **Seasonal classes take the measurement itself** (`surface.SEASONAL`, grass). On the real tile the grass curve's
  gamma is 0.33 and the photo's pattern explains little of the measurement (luminance correlation 0.26 over pure
  grass pixels), so every field came out the class's one colour: red over green ran 0.90 to 0.95 (10th to 90th
  percentile) where Sentinel-2 has 0.73 to 1.09, and no pixel was redder than green where 29 % are. The median was
  right (0.93 against 0.92). The colour map now multiplies the curve's colour by the measured colour over it,
  low-passed over the reflectance pixels that are purely the class in sunlight (`PURE_SHARE`, `PURE_SUNLIT`), so
  a pure pixel's colour is the measurement's; a cell with under 5 % of the low-pass's weight on pure pixels
  (`MEASURED_REACH_MIN`, hand-set) keeps the curve's colour. Real tile: 1416 pure pixels, 54 % of grass cells in
  reach. The ground seen from the fly and walk stations is greener than the class median, not pinker (red over
  green 0.80 and 0.76, 11 % and 12 % of pixels redder than green); the survey orthophoto's pink is its white
  balance (its blue over green is 0.96 where Sentinel-2 has 0.66 on the same pixels). Paving keeps the photo's
  pattern: it does not change with the season and its reflectance pixels mix in cars and roofs. A prior.
- With one anchor the fit's spread is always 0, and nothing acts when the asphalt and grass checks disagree: a tile
  whose median paving is asphalt gets a scale about 3 times too high. Without a cover stage every cell counts
  as sunlit, shade included.
- The sun's strength is the beam at the ground. The atmosphere module converts it to the outer-space intensity
  Unreal expects, avoiding a second attenuation. The inherited exposure offset remains a tuned prior, with the
  engine exposure bias pinned at +1 EV; this is not a new camera calibration.
- Nothing waits for shaders before the level build's compile check, so that check may not see an error.

### Ground materials and grass

`unreal/materials.json` names one scanned CC0 material per class (Poly Haven, 1K: base colour, normal, roughness,
height), with a pinned URL and MD5 for every file and the ground one repeat covers. `unreal/fetch-materials.ps1`
downloads them once and checks the hashes; about 10 MB. Nothing is stored in git.

The Landscape material height-blends the classes. Evidence sets the colour that varies over tens of metres (the
macro colour map times the albedo scale), and the scan adds structure: its colour divided by its own mean, so it
never shifts the colour. Within 15 m, colour, normal and roughness use the same physical scan coordinates.
Between 15 and 30 m, grass gradually mixes two scales and turns; dirt and paving colour transition to three
overlapping, independently offset samples. This avoids mixing unrelated colour features against one normal
map up close while breaking distant repeats. Scan colour fades from full strength within 15 m
to 20% beyond 100 m, allowing the photo's broad pattern to dominate at distance.

The fine photographic ratio and recycled grain fade toward neutral near the camera, using a 20% share within
3 m and full share beyond 20 m. Native masks, growth and low-frequency colour remain in place; the registered
material scans supply the close surface structure. The distance and share are visual priors.

The ground colour also carries the detail ratio (`detail_ratio.png`): each 0.5 m pixel of the photo divided by the
12 m low-pass of its own class's sunlit ground, in linear light, stored as a power of two (8 bits, 127 steps per
power, range one stop either way). It brings back what the macro colour leaves out (mowing rows, tracks, lot
markings, patches of straw) without moving the albedo, which stays the fitted one. It is 1 where cover or shadow
hides the ground, because the engine draws those, so a roof, which the cover stage counts, stays flat until buildings are
modelled. A hidden cell is exactly 1, however thin what hides it; the fade is on the open side of the edge.

On a seasonal class the shadow is read from the photo, not from the cover stage's cast. The cast depends on a fitted
time of day, and on the real tile it lands off the shadows the photo shows (the light poles' shadows run about 45
degrees east of north; the cast runs at 72), so sunlit turf was flattened and the real shadow kept. The photo shows
its own shadows: the log ratio of a cell to its surround has a second, dark peak (`shadow_gap`). What is darker than
the emptiest darkness between the two peaks is shadow, whatever stands or does not stand beside it, and what the
cast only predicted is ground in the sun again; ground under standing cover or a roof stays hidden, with the same
cell of margin the cast had. With two dark peaks the gap is the one beside the larger, a limit. Real tile: the gap is at
-1.43 stops, 7.6 % of the grass not under cover or a roof is in shadow, and of that grass the open share goes from
85.8 % to 87.4 %. Thin shadows
(a pole's is under two pixels wide) are lighter than the gap after the photo's resampling and stay in the ratio:
the fly station still shows the light poles' shadows. Priors: the peak must hold 0.2 % of the class's cells in one bin of 0.05 stops, the gap
at most 0.8 of the dark peak, the shadow's edge is 2 cells wider, and paving is left to the cast (dark asphalt
beside concrete is as dark as a shadow). The albedo curves are not applied to it: their gamma (0.33 for grass) comes from a fit across 10 m
pixels, where noise flattens the slope, and would take most of the contrast out. Treating the imagery's tone
curve as sRGB is a prior, as are the limit of one stop either way (lot paint on asphalt clips there) and the fade over 2 cells at the edge of hidden ground; the manifest's `detail.priors` lists them. The source is the imagery's date (2024-08 on the real tile), not the target date's, so
a row mown since is not in it. The ratio is a 2048 pixel texture, uncompressed (block compression has steps of about 5 % in a channel, as large as the rows it carries): 16 MB, about 22 with mips.

The class weights blend around one half (`EdgeSharpness` 0.35, a look), moved
by 0.15 of the scan's relief, centred on 0.5 as if each scan's relief averaged one half (a look): a weightmap texel is 0.5 m and its ramp reads as a blur several metres wide from the
air.

### Grain and survey detail

The tile's photo is half a metre a pixel, so a field from the air has rows and patches and no blade-scale texture. A
survey orthophoto (`sources.survey.orthophoto`, about 2.3 cm stored sampling on the real tile) has it.
Stored sampling does not establish the image's independently resolved detail.

- **Orthophoto masks and colour** (`orthophoto.py`). Native mask channels are grass, paving, soil and canopy.
  The first three sum to the source alpha coverage; canopy is independent. Landscape weights and turf density
  use averaged masks, while the ground material reads native masks through a virtual texture. Outside the irregular
  alpha footprint, the original imagery remains in use. A separate colour texture is pooled to at least 25 cm and
  filtered within each class over 12 m for luminance, excluding cover and detected shadows. Visible pooled hue
  remains, retaining brown and green lane variation. Fine luminance comes from survey detail, so the colour layer
  does not apply it twice. Recolouring into the calibrated seasonal ground preserves luminance and compresses
  saturation into the material's valid range. Processed survey RGB is not treated as calibrated albedo.
  Unfitted shadows can retain a colour cast; hue alone cannot distinguish a shadow from coloured ground.
  Its alpha fades survey influence over 12 m inside the irregular coverage boundary for material weights,
  growth and detail replacement. Native evidence masks retain the source coverage unchanged.
  Native alpha gaps are reduced conservatively onto the colour grid before computing physical distances;
  this can move the blend boundary by at most one colour cell, without losing gaps narrower than that cell.
  Within 3 m of the camera, survey detail is filtered toward 10 cm sampling so photographic blade texture
  does not compete with the close material scan. Automatic temporal mip bias is disabled for this sample.
  Pixel UV gradients shorter than 10 cm in world space are enlarged near the camera, fading out by 15 m.
  Both gradient directions are retained for anisotropic filtering at grazing angles. This bounds individual
  gradient lengths, not the footprint's minor axis. Larger photo patterns remain.
  Native processing runs in overlapping windows, with bounded pooled grids and streamed PNG output.
  A rejected RGB split remains recorded in the manifest. It does not establish that the ground is all grass.
- **Optional observations** (`sources.survey.observations`). A schema-1 JSON file must identify the orthophoto's
  SHA-256 and CRS. Features contain `id`, `feature_type`, `confidence`, and projected `[west, south, east, north]`
  bounds. High-confidence `bare_soil_*` envelopes restrict a calibrated bright-fragment detector; pixels must also
  pass its colour, alpha, height and darkness tests. Envelopes are search areas, never filled material masks.
  Optional `ground_classifier` cuts are `light6_gt`, `red_minus_blue_fraction_lt`, and `exg6_lt`, fitted for that
  acquisition. Dark or mixed ground remains unresolved. No paving is inferred from these bare-fragment observations.
  Individually inspected crowns can refine matched height-backed tree positions and widths. Their centres approximate
  crown centres, not surveyed trunks, and their height retains its original source and date.
  Identified temporary fabric covers stay hidden from ground colour and are excluded from tree-canopy evidence.

- **Grain** (`grain.py`). The log of each pixel's luminance over its own 0.3 m low-pass, measured on 256-pixel blocks
  that are pure grass in the tile's class map and have pixels all over. The quietest quarter of those blocks gives a
  radial power spectrum and a distribution; a 1024 pixel texture (23 m) with that spectrum and distribution, tileable,
  is written as `grain.png` (a power of two, 127 steps per power, range two stops). The ground material lays it over
  every grass cell, read at two scales and turns and added in log space, so the strength stays what was measured and the
  repeat does not show. It fades to 25 % of its strength on ground nearer than a texel a pixel (22 m for a 90 degree lens
  at 1920 pixels): closer up the texture is magnified and the grain turns to soft blotches, and the tufts carry the
  texture there. Priors: 0.3 m, the quietest quarter (the survey's grass is partly a hay field and the field being built is
  lawn), no direction in the grain, the lens, the 25 %. Real tile: 379 of 1519 pure-grass blocks used, strength 0.60 stops
  (one standard deviation of the log2 ratio).
  The grain has a colour: each band's log ratio is fitted against the luminance's, a line through the origin
  (`grain.tint`), and the material raises 2 to the grain times each band's slope. A ratio of ratios, so the camera's
  white balance and exposure cancel. Real tile: slopes 1.06, 0.99 and 1.03 for red, green and blue, each explaining
  96 % or more of its band: bright pixels are a little redder, and the grain is close to grey. The same distribution
  cut in 8 equal shares is the colour of single blades (`grain.blade_colours`, 0.47 to 1.6 of the ground's colour).
- **Survey detail** (`build_survey_detail`). The luminance ratio from the orthophoto at its own pixel size;
  its low-pass runs on the orthophoto pooled to 0.5 m. RGB repeats the same encoded log2 ratio, multiplied by the
  detail weight stored in alpha (`survey_detail.weight_channel = "alpha"`). Missing and rejected samples have
  neutral RGB (127) and zero alpha. The material divides the sampled log ratio by its sampled weight, bounds it
  to the recorded range, then blends with the older imagery ratio and grass grain by that weight. Both channels
  share one texture sample, so filtering across a missing sample does not introduce a dark edge. Rejected survey
  detail therefore permits fallback texture rather than leaving a neutral patch with no grain.
  This is an uncompressed linear RGBA virtual texture (`r.VirtualTextures=True` in the host project), 14439 by
  13495 source pixels on the real tile, mapped by `survey_detail.west_m` and the recorded extents. It stores more
  bytes per texel than the previous G8 format; visible pages stream through Unreal's virtual-texture pools, and
  runtime allocation and frame cost require measurement. Older manifests without the alpha marker retain their
  single-channel decoder and zero sentinel.
  Existing cover masks and the survey's shadow test reject uncertain detail. A rejected shadow fit uses a
  -1.5-stop darkness prior on seasonal ground; this is not complete shadow removal. Replaced grain is procedural,
  not recovered detail from hidden ground. On the real tile the footprint is west of the fly and walk stations,
  so it shows in the walk tour's later frames (about frame 2600) and the overview.

### Procedural ground beyond the survey

The optional survey-driven `procfill` stage carries fitted ground appearance into coarse imagery coverage.
It exports seeded masks, per-mask provenance and confidence, spatial holdout results, and paintable PNG images.
See [procedural ground masks](docs/procfill.md) for the evidence limits and Unreal integration, and
[paint procedural ground masks](docs/paint-procfill.md) to replace generated features.

### Grass

The grass class grows Landscape Grass tufts. Placement sharpens the imported grass coverage with the same relief rule
as the visible surface. The two-metre taller-growth fringe follows both sides of the grass edge and stops beyond it. `turf.py` supplies three blade varieties and a sparse, close-range
broadleaf variety. A blade variety is so much leaf over a square metre of ground (its leaf area index), so wider blades are
fewer: **near** (index 1.0, blades 0.8 to 1.4 cm wide, 24 to a tuft, about 2000 blades a square metre, drawn to 15 m),
**clump** (index 0.2, drawn out to 65 m, with blades as wide as a pixel is at 15 m, where the near variety ends:
1.6 cm, so the sward keeps its texture where a real blade is far under a pixel) and **tall** (index 0.02, drawn to 50 m). Blade height is the
summer mowing height a land-grant university extension guide gives cool-season lawn turf, 3 to 4 inches (publications
MG10 and G6705); the tall variety stands 1.5 times the top of that, a prior (the one-third rule of mowing). Everything
else is a prior and the manifest's `turf.priors` lists it: the indices (real mown turf has several times the near
one; what is drawn is the top of the sward), blade counts, radii, widths, draw distances, size spread (0.85 to 1.15),
the lens, the blade's brightness from root (0.65) to tip (1.12), and that no variety casts a shadow (a tuft's own
shadow blackens it against a sward that has none).

`turf_growth.png` stores short-tuft density, tall-tuft density, and half the height multiplier. Relative photo
green/red contrast drives growth, with native survey colour inside its footprint. Correlated 1.2 m noise, terrain
hollows, 2 m edge fringes and canopy shelter introduce height variation and taller margins. These responses are priors,
not measured mowing heights. The short sward retains the original full density; surface weights alone reduce coverage.
The height envelope ranges from 0.85 to 1.5 times the mowing range.
Pure non-grass masks suppress growth. Mixed path edges retain vegetation in proportion to the engine's surface
weight, without an earlier majority-class cutoff. The broadleaf shape is clover-like and its species and abundance
are priors. One blade in thirteen receives a restrained straw tint within the seasonal palette.

Blade materials use two-sided foliage transmission, root ambient occlusion (0.4 at the base), roughness 0.6 and specular 0.25.
Within 3 m, ground and blade roots share a shaded, straw-tinted macro colour modulated by the same normalized grass scan.
The ground returns to the photographic sward colour between 3 and 15 m; this is a close-contact blend, not exact sampling
of every distant ground layer. The substrate tint and shading are priors. Blade-specific colour returns over the lowest
quarter of each blade. Roots are distributed uniformly over each tuft disk, and tuft brightness varies only 5% so
individual blade colour and height carry the variation instead of whole repeated bundles.
Rounded blade normals vary with blade orientation, with an upward bias to keep both visible sides lit.
World-position gusts bend tips while retaining roots. Ground and blade roots share 0.65 cm procedural relief;
its derivatives also perturb ground normals. Wind amplitudes and relief are visual priors, not terrain measurements.
Grass displacement fades to zero between 22 and 25 m; the engine disables its evaluation beyond 25 m.
Curved blades include folded tips and varied resting angles. A stable seed per blade combines with the instance
seed to vary individual stature and resting bend within each tuft; the photo still sets its growth envelope.
The extra bend stays within 3 cm and leaves roots fixed. The scan's colour contrast
and close normal strength are increased to retain surface detail where the sward thins; these are visual priors.
The engine shrinks a tuft away between its start and end distance and has no nearest distance, so a variety is drawn
from the camera out. The clump's wide blades are kept from a walker's feet by its material: nearer than 8 m a clump
is drawn in to its own root, and it grows to full size by 15 m, the distances over which the near variety shrinks
away (`appear_cm` in the manifest). Each variety has its own blade material for that.
Each blade has its own colour: one of the 8 the grain stage measured, each as likely as the next, held in the tuft
mesh's third and fourth UV channels (the mesh build writes its own unwrap into the second).
That multiplies the ground's own macro colour at the blade's place, times the albedo scale, so tufts follow the straw and green the
data shows. Earlier host tests used a constant world-up normal after half the two-sided blades took no sun:
turning shadows off, then virtual shadow maps off, then changing the shading model made no difference;
the world-up normal moved blade pixels from 38 to 58 in sRGB against 85 for the ground. Rounded,
upward-biased normals now retain orientation-dependent lighting instead of that constant. The host
project makes grass maps while the game runs (`grass.GrassMap.UseRuntimeGeneration=1`): the level is
regenerated, never cooked. No source gives a sward's density.

At the fly station (30 m up) the nearest ground is about 43 m away, past the near and tall tufts' draw distance (a grass-on against
`grass.Enable=0` pair differs by a mean 0.45 of 255 and 0.0 % of pixels over 24), so what the fly view shows of grass is the ground's own colour, the detail ratio and the grain.
`r.MaxAnisotropy=16` and fully loaded textures change nothing there: the softness was the data's resolution, not the engine's filtering.

The tuft mesh is built in full, not with the fast build. On 5.8.4 the engine built a fast-built tuft's
instances and drew none of them in a level without trees; with the trees, which are Nanite foliage, in the
level it drew some. What the fast build leaves out is not known, so this avoids the fault without explaining
it. A tour counts the tufts the engine has built near the camera (below), which that fault does not change;
`gates/grass-drawn.ps1` checks they are drawn, by comparing a walk frame with the same frame under
`grass.Enable=0` over the near ground only (below the horizon), at a frame where the walker stands on full grass weight: the gate reads the build's grass weight at the camera and 4 m and 8 m ahead and refuses a frame that is not. The earlier gate compared the whole frame at the walk station, which stands on a class edge with paving and half sky in view, and passed by 1.12 % against its 1.0 % bar. The bar is the same 1 %; what changed is that the ground measured is grass only. `-Noise` also runs the grass-on tour twice and reports how much identical runs differ.
The same pair of frames is compared over a second band, the ground between where the near variety ends (15 m) and where the farthest ends (65 m), which only the clump and the tall tuft can change; its rows come from the manifest's draw distances, the tour's eye height and the frame's shape, for level ground. The two far varieties are not told apart. On the final real-tile build, 65.60 % of the far band's pixels and 64.27 % of the near ground cross the channel-step threshold; 0 % cross it between repeated grass-on runs. The far bar is 20 %, hand-set between the earlier build's 64.5 % signal and its 2.3 % zero-far-density mutation (near blades on rising ground). That mutation has not been repeated on the final build.

`r.Shadow.Virtual.MaxPhysicalPages` is 2048 in the host project (the default is 4096 pages, 512 MB): the card's
peak in the fly tour fell from 7630 to 7350 MiB. Hand-set, not fitted.

`r.Nanite.Streaming.StreamingPoolSize` is 128 MB in the host project. The engine commits its default of 512
MB on the card whatever the scene needs. 128 is hand-set, not fitted: stills at the fly and walk stations
and the overview are the same with 128 as with 512, and other views were not compared.

### Frame and units

- World X is grid north, Y is grid east, Z is up, in centimetres, with the origin at the tile
  centre. Negating Z gives NED.
- World Z = 0 is the ground height at the tile centre; `georeference.origin_height_m` states that
  height in the elevation source's vertical datum, which the site file must name.
- Grid north is not true north. `georeference.true_north_from_grid_north_deg` gives the difference.
- Heightmap and colour map are indexed `[row, column] = [east, north]`, which is how a Landscape
  reads them.

### Tests

```sh
python -m pytest
```

The tests build synthetic sites and check behaviour: that a known surface lands at the right world
position after encoding, that sources are fetched once, that stages are reused, and that the sun
and the shadows it casts are where astronomy puts them.

### Buildings

With a `sources.buildings` file the build writes `buildings.json`: one record per footprint polygon inside the tile (cut at
its edge; parts under 4 m2 are left out), with its rings in metres east and north of the tile centre (outer ring first, then courtyards), a triangulation of the roof,
a height, a roof albedo, and where each came from.

- **Footprints** start as the map's polygons, simplified to 0.3 m. Optional building imagery can move rectangular
  edges by at most 1.5 m when all four edges have coherent photo support. Other outlines retain their source geometry.
  Reviewed outline observations can replace a footprint within 15 m of its source. Every change retains its provenance.
- **Roof survey** fits planes to non-ground lidar returns inside each footprint. Ground and roof elevations come
  from the same point cloud, so their relative height does not assume that a separately supplied DEM has the same datum.
  One fifth of metre cells are held out. A fit requires at least 80% of sampled footprint area within 2 m of a supported
  return, at least 85% of validation returns within 0.35 m, and a validation 90th percentile error at most 0.6 m.
  Unsupported fits retain their prior geometry and a rejection reason. Accepted planes generate flat, pitched, or
  stepped roof surfaces, wall tops, and collision. Roof-type names are inferred from plane slopes and levels.
  Shared boundary vertices join fitted levels within 0.44 m (twice the plane-fit tolerance); larger steps remain.
  Multi-level domains need a 3 by 3 m interior patch. Narrow fragments take the nearest surviving domain;
  roofs without a coherent patch retain their priors. This regularization and its 1 m grid are recorded per fit.
  Validation samples the resulting triangles, including these joins, rather than the separate plane equations.
  Roof-to-ground eave and ridge heights, held-out errors, supported area, and split-to-split roof-type agreement are
  written per building to `building_accuracy.json`. Type agreement is a consistency check, not independent survey truth.
- **Fallback height**, in order of trust: the median lidar height above ground over the footprint pulled in by 1 m (when at
  least 3 cells say 1.5 m or more); the footprint's own `height_m` tag; its `num_floors` tag times 3 m; the median of
  the heights the lidar measured on the tile's other buildings. A building newer than the lidar survey is read as
  flat ground by it, so the tags speak. Every record says which it used (`height_from`), and `build.json` counts them.
- **Roof colour** is the median photo colour over the footprint, turned into albedo by the paved class's curve (the
  photo is calibrated per class against the reflectance raster; a roof reads like the unvegetated class, a prior).
  Building imagery replaces this sample when at least 60% of the roof interior has usable pixels. RGB alone does not establish roofing material.
- **Roof forms** on large light roofs come from compact contrasting regions in the photo. Their locations and
  plan dimensions are image inferences; bounds can include cast shadows and the object type is unconfirmed.
  Edge-connected shadows and long thin seams are excluded. Sparse clusters are covered by solid photo rectangles at least two cells across; one-cell connections do not fill the space between units. Service-box height is a 0.9 m prior. Fixture bodies are inset up to 1.25 m per side from those uncertain bounds, capped at 40% of each dimension while retaining a 0.4 m minimum body width; their curbs stay inside the bounds to leave visible gaps between neighbouring volumes. Building components retain normal mesh shadows and omit the screen-space contact pass, which self-occludes thin seating rows. These forms do
  not change the measured building height or median roof albedo. Measured roofs omit this generic equipment kit.
  Explicit photo observations can place unit bodies and skylight candidates with separate plan and height provenance.
  Their bodies retain the observed plan dimensions, and follow the local measured roof level. A photo does not measure
  their height. Coherent raised lidar returns on at least three flat-roof edges can supply an inferred parapet height.
- **Architectural detail:** each record's `architecture` describes its facade and roof kit. Source tags choose
  residential, institutional, commercial, utility or grandstand use. Untagged footprints use area, width and
  measured height as a prior. Suitable rectangular residential roofs get a ridge; irregular footprints and
  courtyards keep their triangulated flat roof. Gabled priors extend equally above and below the lidar median.
  An accepted roof survey replaces those profiles. Facades remain priors unless a reviewed facade observation exists.
  Openings must fit below the lowest wall top across their full width; short walls use smaller prior windows.
  Horizontal trim, parapets and coping require a supported level wall span.
- **Priors, with no source:** facade colour, brick or siding, window bays, doors, trim, parapets and HVAC are
  plausible modular details, not surveyed elevations. Roof pitch is 0.38 rise/run, capped at 2.4 m rise. Roof
  roughness is 0.85. Grandstand rows use the tagged footprint and measured height; paired stands face each other.
  Bench fittings (including 6 cm support posts) and the larger stand's press box are priors. Reviewed seating outlines,
  row counts and aisle locations can replace the stand plan. A fitted seating slope replaces its rise, and observed
  stands omit the generic press box. Each record carries provenance, and
  `buildings.priors` lists these limitations. A tagged grandstand owns a generic streetscape bleacher when at
  least 25% of the seating plan overlaps its footprint; `claimed_bleachers` records the omitted kit and overlap.
  Separate bleachers remain in the streetscape inventory. The 3 m floor, 0.3 m simplification, 4 m2 minimum area, 1.5 m lidar
  threshold, the 3-cell minimum and the 1 m edge are set by hand. All are in `build.json` under `buildings.settings` and `buildings.priors`.
- **Roofs are not trees.** A canopy map counts a roof as canopy, and a tree is placed at its crown's top, so a crown
  whose top lies in a footprint (edge cells included) would stand in a building. It is dropped (142 on the real tile,
  most of them roofs; the few that were real crowns over a roof's edge go with them). The rule is a prior.
- **Roofs out of the ground.** A footprint's cells count as hidden in the cover stage, so no class, colour or detail
  of the ground is read from a roof (the lidar already hid the roofs it saw as cover; on the real tile the footprints
  hid 2108 more cells that were still read as ground), and the ground class under a footprint is that of the nearest
  ground not under one. Nothing double-draws ground and roof.

Limits: dated lidar and newer imagery can describe different buildings. Missing roof support is recorded as a change
review candidate, because sparse sampling and occlusion can produce the same result. Those flags are not confirmed
construction dates. Absolute alignment between the lidar and the site's terrain datum remains unverified. Unreal's
build receipt records any additional terrain-clearance lift for every building. Facades without resolved street-photo
observations, unresolved roofs, fittings, chimneys, and interiors remain priors or unmodelled details.

## Unreal side

Measured paving, field markings and props can be supplied through the optional
[`sources.streetscape` inventory](./streetscape.md). It generates terrain-following geometry and excludes
grass from paving without storing site annotations in this repository.

`unreal/Plugins/EnvGen` is one plugin with two modules.

- **EnvGenEditor** rebuilds the level when the editor starts with `-EnvGenManifest=<build.json> -EnvGenMaterials=<directory fetch-materials.ps1 filled>`. It
  deletes what an earlier run generated, then creates the Landscape with collision and one weight
  layer per surface class, the ground material, grass, the sun for the target day and a matching exposure, sky, a flat horizon plane, clamped exposure, a player start, and a site-info
  actor carrying the georeference and stencil classes. With a tree inventory it stands every tree on the surface
  at its measured height and crown width (see Trees in the level). When the manifest has a `context` block it
  also imports that coarse surround as a second Landscape, which passes under the tile so the
  detailed surface does not end in a cliff against the sky. Once the engine has merged the Landscape's
  edit layers it traces the collision surface at fixed points and compares it with the imported
  heights, reads every weight layer back at the manifest's check points and compares it with what the manifest says is there, saves, and exits. The checks are in
  `Saved/EnvGen/build_receipt.json`. The editor exits with 1 if the manifest cannot be used, the merge
  does not finish, a trace misses the ground or lands more than 5 cm off, a weight layer is missing or reads back wrong, a generated material does not compile,
  or the save fails.
- The **horizon** is a flat plane 50 km across with no collision, a metre under the lowest point of the
  outermost surface, in that surface's mean colour. Without it the sky's empty lower half shows as a blue
  band past the surround. The atmosphere's analytic height fog and aerial perspective soften its transition
  from the source-textured surround; [atmosphere settings](atmosphere.md) records their presentation priors.
- **Context geometry** uses the existing wider building footprints and canopy-height raster when present.
  `context_geometry.json` contains coarse static mesh batches grounded against the exported context heightmap.
  Primary building and tree inventories remain separate. Footprints crossing the primary tile are omitted from
  context massing, with the omitted area recorded. Tagged building heights take precedence over floor-count
  and six-metre priors; distant facades remain unresolved. Canopy records describe supported clusters, not
  individual measured trees or species. These meshes have no collision, animation, or cast shadows.
  The receipt reports context counts and terrain probes separately, and saved-level checks must preserve their
  component policies. They provide visual surroundings rather than physical sensor ground truth.
- Ground and registered paving blend their final albedo toward the same world-registered surround texture over
  the outer 64 m of the primary tile. This changes colour without changing terrain displacement or grass placement.
  Modeled paving uses the measured paving-class mean and the normalized pavement scan for close detail, fading
  that detail between 15 and 30 m. Its markings remain geometry. Aerial colour is omitted within those surfaces
  because even low-pass colour retains blurred vehicles and tree shadows. Imagery alignment, visible joins and distant silhouettes still require
  native camera review; mesh counts and material compilation alone do not establish their quality.
- **Trees in the level.** `materials.json` names, for each kind, tree meshes that ship with the engine's
  Procedural Vegetation Editor plugin (a broadleaf tree, a shrub and a conifer on 5.8); nothing is downloaded or
  stored. Each tree takes the mesh of its kind that needs the least stretching, scaled to its height and crown
  radius from the mesh's own bounds, instanced, casting shadows, with the tree stencil. Their leaves are Nanite
  assemblies, so the host project sets `r.Nanite.Foliage`. Collision is separate and unseen: a cylinder for the
  trunk up to the crown's base and one bounding the crown, from the species' trunk diameter and crown ratio, so a
  tree without a species has none. The receipt counts the trees placed and traces down onto 25 of them: the build
  fails if one is missing or its top is more than 5 cm under its measured height. The tree actor carries the tag
  `EnvGenStanding`; the tours look past anything with it when they ask where the ground is, so a camera's height
  is above the ground and not above a crown.
- **Buildings in the level.** Walls extend from 30 cm under the ground to the roof profile. The architecture
  module adds framed glazing, entrances, roof trim, parapets, rooftop equipment and stepped grandstand seating.
  Roof colours retain the photo's measured albedo. One opaque material uses metric UVs for brick courses, siding,
  shingles and membrane seams, with separate roughness for glass and metal. Geometry is joined per 126 m square,
  built as Nanite. Hidden collision meshes contain walls and roof profiles, including stadium treads and risers;
  cosmetic frames, trim and equipment do not enlarge the collision mesh or obstruct roof checks. Metric UVs use
  full precision, and colour channels are separate from the generated lightmap channel. Detail contrast fades
  with pixel size to preserve distant roof albedo. The receipt counts valid Nanite meshes and traces every
  building; a missing building, invalid Nanite data or roof error over 5 cm fails the build.
  Older inventories without `architecture` retain their plain walls and flat roofs. Actors carry
  `EnvGenStanding` and the building stencil, so ground checks look past them.
- **EnvGen** has the walking pawn, the game mode and the tour actor.

`unreal/Host` is a minimal project that hosts the plugin.

```powershell
./unreal/build-level.ps1 -EngineRoot <engine install> -WorkDir <scratch dir> -Manifest <path to build.json> -Materials <directory>
```

The script runs the full editor off-screen and unattended, because the engine merges Landscape edit
layers on the GPU over several frames. It fails if the editor exits non-zero, writes no receipt, or
runs past `-TimeoutSeconds`.

### Walking and tours

Run the project with `-game`. WASD or the left stick moves, the mouse or right stick looks, Shift
runs, Space jumps. F swaps to a flying pawn from another plugin when the project names one: pass
`-ExtraPlugin <plugin dir> -DroneClass /Script/<Module>.<Class>` to `build-level.ps1`.

`-EnvGenTour=walk` or `-EnvGenTour=fly` runs a scripted loop around the tile centre instead, sized as
a fraction of the tile. After an 8 s warm-up it records 60 s of frames (`-EnvGenTourSeconds=` changes
that), writes `Saved/EnvGen/tour_<name>.json` and `.csv`, and exits; `-EnvGenTourStay` keeps the game
open. `-EnvGenTourCsv` also records the engine's CSV profile for the measured period.
For a locked-camera motion check, `-EnvGenTourHoldAtSeconds=20` stops the camera after 20 measured seconds
while world time continues. `-EnvGenTourFrameStart=630` skips approach captures at 30 fps.

| Tour       | Height above ground | Nominal speed | Loop radii, as a fraction of the tile side |
| ---------- | ------------------- | ------------- | ------------------------------------------ |
| `walk`     | 1.7 m               | 4 m/s         | 0.09 by 0.14                               |
| `fly`      | 30 m                | 15 m/s        | 0.22 by 0.30                               |
| `overview` | 700 m               | still         | looks straight down, north up              |
| `stand`    | 1.7 m               | still         | the walk's first point                     |

The loop wobbles in and out, so the true ground speed varies around the nominal one; the summary's
`distance_m` is the path actually covered in the measured period. `-EnvGenTour=overview` holds still
above the centre instead, for comparing the ground with a map.

A tour also counts grass: each measured frame it adds up the tufts the engine has built in the grass
components within 25 m of the camera, and in the components the camera stands over. The summary has
`grass_tufts_within_25m`, `fewest_grass_tufts_within_25m` and `frames_with_no_grass_under_the_camera`, and
the CSV has both counts and the camera's position per frame, so the counts can be set against the grass
class under the path. A built tuft is not always a drawn one (see Ground materials and grass), and a component counts whole
once any of it is within 25 m, so the count is an upper bound for that radius.
`-EnvGenTourEndCmds="a,b"` runs console commands as the measured period ends, for the engine's own counters
at that moment, such as `rhi.DumpResourceMemory 40`. A command cannot hold a comma.

For a video, add `-EnvGenTourFrames=<dir> -UseFixedTimeStep -FPS=30`: every measured frame is written as
a PNG, evenly spaced in game time (`-EnvGenTourFrameEvery=N` keeps every Nth, for stills at fixed points
on the path). Frame times from that run mean nothing; measure in a separate run.

### Checking an engine version

Before moving to a new engine version, these show whether it can host the work:

| Check                                                                 | How                                           |
| --------------------------------------------------------------------- | --------------------------------------------- |
| The plugin, and any plugin passed with `-ExtraPlugin`, compiles       | `build-level.ps1`                             |
| A Landscape with collision and a weight layer imports unattended      | `build-level.ps1 -Manifest`, then the receipt |
| The game starts from a desktop session and a tour records frame times | `run-tour.ps1`                                |
| Grass tufts are drawn, not only built                                 | `gates/grass-drawn.ps1`                       |
| A packaged build runs                                                 | `package.ps1`, then `run-tour.ps1 -Exe`       |
| Meshes made in an older engine load and can be placed on the surface  | `gates/assets_on_surface.py`                  |

## Not in this slice

A mesh for each species, tree wind, weather and a moving sun, the manual edit layer that regeneration leaves alone, and
the simulator exports.

Reviewed `building_reference` observations may include up to eight `roof_breaklines_m`
segments, each containing two `[east_m, north_m]` endpoints relative to the tile centre.
The source is required; `roof_boundary_uncertainty_m` records digitization uncertainty.
Segments extend across the footprint to partition roof masses without changing the
footprint or ground mask. Heights still come from LiDAR planes. For these partitions,
3 m training neighbourhoods identify upward planar patches; the validation mask uses
training returns and withheld XY positions only, never withheld elevations. Reports
retain raw and selected return counts and both raw and selected validation errors.
At most 2% of the footprint may inherit an adjacent plane where a narrow partition
has insufficient returns; this inferred area is reported. Existing area coverage and
withheld mesh agreement thresholds still apply. Photograph boundaries and LiDAR
heights can have different acquisition dates and registration errors.
