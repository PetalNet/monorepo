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

| Stage        | Reads                | Writes                                                         |
| ------------ | -------------------- | -------------------------------------------------------------- |
| Acquire      | `site.json` sources  | each source clipped to the tile, once, into the cache          |
| Elevation    | the elevation raster | `heightmap.png`, 16-bit, Landscape layout                      |
| Macro colour | the imagery raster   | `macro_colour.png`, low-passed at 12 m                         |
| Manifest     | everything above     | `build.json`: placement, georeference, stencil classes, hashes |

- A source is either a local raster (`"kind": "file"`) or an ArcGIS ImageServer
  (`"kind": "arcgis_imageserver"`), which covers USGS 3DEP elevation and many state imagery services.
  Only the tile window plus a 16 m margin is requested, and it is fetched once: the cache key is the service, the window
  and the spacing.
- A stage reruns only when its inputs change. `build.json` lists which stages were reused.
- The site's CRS must be projected, in metres, and have an EPSG code (a UTM zone, for example).
- The tile is a square centred on the boundary, snapped to whole metres. Its side must be a whole
  number of Landscape components (126 quads), for example 1008 m at 0.5 m per quad.

See [`examples/site.example.json`](./examples/site.example.json) for the schema.

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
position after encoding, that sources are fetched once, and that stages are reused.

## Unreal side

`unreal/Plugins/EnvGen` is one plugin with two modules.

- **EnvGenEditor** rebuilds the level when the editor starts with `-EnvGenManifest=<build.json>`. It
  deletes what an earlier run generated, then creates the Landscape with collision and one weight
  layer, the ground material, sun, sky and fog, clamped exposure, a player start, and a site-info
  actor carrying the georeference and stencil classes. When the manifest has a `context` block it
  also imports that coarse surround as a second Landscape, which passes under the tile so the
  detailed surface does not end in a cliff against the sky. Once the engine has merged the Landscape's
  edit layers it traces the collision surface at fixed points and compares it with the imported
  heights, reads the weight layer back, saves, and exits. The checks are in
  `Saved/EnvGen/build_receipt.json`. The editor exits with 1 if the manifest cannot be used, the merge
  does not finish, a trace misses the ground or lands more than 5 cm off, the weight layer is missing,
  or the save fails.
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

Surface classes and the layered material, grass, trees and buildings, time of day and weather, the
manual edit layer that regeneration leaves alone, and the simulator exports.
