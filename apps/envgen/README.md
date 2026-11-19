# envgen

Builds a game-ready Unreal environment from data: give it a site boundary and public elevation and
imagery, and it regenerates the level from scratch.

Evidence seeds only low-frequency facts: the shape of the ground and colour that varies over tens of
metres. The engine generates everything finer, the same way everywhere, so quality does not change
where one data source ends.

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

| Stage        | Reads                                          | Writes                                                         |
| ------------ | ---------------------------------------------- | -------------------------------------------------------------- |
| Acquire      | `site.json` sources                            | each source clipped to the tile, once, into the cache          |
| Structure    | lidar points, if the site has them             | height above ground, and distance to the nearest ground return |
| Elevation    | the elevation raster                           | `heightmap.png`, 16-bit, Landscape layout                      |
| Cover        | lidar heights, a canopy height raster, both    | `canopy_height.tif`, `sunlit.tif`, north-up at 1 m             |
| Surface      | the imagery raster, and which ground is sunlit | `surface_<class>.png`: one 8-bit weightmap per class           |
| Macro colour | the imagery, the sunlit ground and the classes | `macro_colour.png`, low-passed at 12 m within each class       |
| Surround     | both rasters at coarse spacing, if asked for   | `context_heightmap.png`, `context_colour.png`                  |
| Manifest     | everything above                               | `build.json`: placement, georeference, stencil classes, hashes |

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

- Grass against the rest: Otsu's threshold on `(G - B) / (R + G + B)` over the sunlit cells, each counted by its brightness (an index is a ratio, so it is noisiest where a cell is dark, and dark blue-leaning roofs and asphalt would otherwise take the cut for themselves). Vegetation
  reflects more green than blue; pavement and soil do not. The index is a share of brightness, so one
  material in sun and in dim light gives the same value.
- Soil against paved: the same method on `(R - B) / (R + G + B)`, over the sunlit cells that are neither
  grass nor dark (dark roofs and asphalt would otherwise decide the spread).
- A split is made only when the two groups form patches, not scatter (the share of neighbouring cells that
  agree, beyond chance, is at least 0.5) and each covers at least 1000 m2. Otherwise the tile stays one
  class, `grass`, which is a prior and is listed as one in `build.json`. The distance between the groups in
  pooled standard deviations is recorded as `separation`, but it cannot be the test: one Gaussian cut at its
  mean scores 2.7, and a real tile of turf and pavement 2.1.
- Every cell is thresholded on its own; its class is then the majority in the 3 by 3 around it, so the class
  edge lands on the edge in the imagery. The edge is softened over about a metre, and the weights are
  8-bit and sum to 255 in every cell.
- The colour map is low-passed within each class, from that class's sunlit ground only, so a road does not
  grey the grass beside it.

`build.json` has `surface`: each layer's file and share of the tile, check points (vertices where each class should be found, worked out from the weightmaps by position, which the level build compares with the merged Landscape), and for each split the index, what it
was fitted to, the threshold, the separation and whether a split was made.

Limits:

- A class is named by its colour: the greener side is called grass. A tile of bare ground and pavement with
  no vegetation would call its greener part grass.
- Soil is whatever unvegetated bright ground is redder than the rest, which may be clay, a track or red roofing.
- The criteria in the third bullet (coherence, group size) and the 1 m edge and 3 cell majority are set by hand.
- Imagery from one date: dry turf can look like soil and green turf like a lawn; the split follows the day.

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

## Unreal side

`unreal/Plugins/EnvGen` is one plugin with two modules.

- **EnvGenEditor** rebuilds the level when the editor starts with `-EnvGenManifest=<build.json>`. It
  deletes what an earlier run generated, then creates the Landscape with collision and one weight
  layer per surface class, the ground material, sun and sky, a flat horizon plane, clamped exposure, a player start, and a site-info
  actor carrying the georeference and stencil classes. When the manifest has a `context` block it
  also imports that coarse surround as a second Landscape, which passes under the tile so the
  detailed surface does not end in a cliff against the sky. Once the engine has merged the Landscape's
  edit layers it traces the collision surface at fixed points and compares it with the imported
  heights, reads every weight layer back at fixed points and compares it with the weightmap, saves, and exits. The checks are in
  `Saved/EnvGen/build_receipt.json`. The editor exits with 1 if the manifest cannot be used, the merge
  does not finish, a trace misses the ground or lands more than 5 cm off, a weight layer is missing or reads back wrong,
  or the save fails.
- The **horizon** is a flat plane 50 km across with no collision, a metre under the lowest point of the
  outermost surface, in that surface's mean colour. Without it the sky's empty lower half shows as a blue
  band past the surround. There is no distance fog: on 5.8.4 with exponential height fog everything past
  about 2 km, the plane included, drew dark navy, and planes of 100 km or more did not draw at all.
- **EnvGen** has the walking pawn, the game mode and the tour actor.

`unreal/Host` is a minimal project that hosts the plugin.

```powershell
./unreal/build-level.ps1 -EngineRoot <engine install> -WorkDir <scratch dir> -Manifest <path to build.json>
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

| Tour       | Height above ground | Nominal speed | Loop radii, as a fraction of the tile side |
| ---------- | ------------------- | ------------- | ------------------------------------------ |
| `walk`     | 1.7 m               | 4 m/s         | 0.09 by 0.14                               |
| `fly`      | 30 m                | 15 m/s        | 0.22 by 0.30                               |
| `overview` | 700 m               | still         | looks straight down, north up              |

The loop wobbles in and out, so the true ground speed varies around the nominal one; the summary's
`distance_m` is the path actually covered in the measured period. `-EnvGenTour=overview` holds still
above the centre instead, for comparing the ground with a map.

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
| A packaged build runs                                                 | `package.ps1`, then `run-tour.ps1 -Exe`       |
| Meshes made in an older engine load and can be placed on the surface  | `gates/assets_on_surface.py`                  |

## Not in this slice

Real ground materials per class, removing the lighting from the imagery, grass, trees and
buildings, time of day and weather, the
manual edit layer that regeneration leaves alone, and the simulator exports.
