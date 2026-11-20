# Streetscape inventory

An optional `sources.streetscape` file adds measured paving, markings and props to the generated level.
Python builds the geometry beside the existing evidence stages. Unreal imports it, samples the Landscape
heightmap and saves static meshes and materials. Site coordinates and annotated imagery stay in private inputs.

Add a file source with `path`, `license` and `date` to the site's `sources.streetscape`. Its contents use this schema:

```json
{
  "schema_version": 1,
  "coordinate_frame": "tile_centred_east_north_m",
  "source": { "name": "Survey image", "license": "Owner permission", "date": "2030-06-01" },
  "features": [
    {
      "id": "parking-boundary",
      "type": "surface",
      "evidence": "image.tif, annotated polygon A",
      "confidence": 0.9,
      "material": "asphalt",
      "ring": [[10, 10], [25, 10], [25, 30], [10, 30]]
    },
    {
      "id": "parking-stripe",
      "type": "line",
      "evidence": "image.tif, visible bay line B",
      "confidence": 0.9,
      "material": "paint_white",
      "width_m": 0.1,
      "points": [[12, 12], [17, 12]]
    }
  ]
}
```

Every feature requires a unique `id`, specific `evidence`, and `confidence` from zero to one. Coordinates
are east and north metres relative to the tile centre. They do not include the projected CRS origin.
Headings rotate counterclockwise from east. Unreal swaps east/north and multiplies metres by 100.
Unknown types, misspelled fields, nonfinite numbers, nonpositive dimensions, invalid polygons and
props extending beyond the tile fail the build with the feature ID. Surface and line polygons clip at the tile edge.

| Type | Geometry and measurements | Defaults where no measurement exists |
| --- | --- | --- |
| `surface` | `ring`, `material`: asphalt, concrete, track, gravel or clay | No inferred boundary |
| `line` | `points`, `material`: paint_white, paint_yellow or concrete; `width_m` | Paint width 0.1 m; concrete requires width |
| `curb` | `points`, `width_m`, `height_m` | Width/height 0.15 m, buried 0.05 m |
| `fence` | `points`, `height_m`; optional `ground_anchor` per segment | Height 2.4 m, posts at most 3 m apart |
| `light_pole` | `point`, `height_m`; `heading_deg`, `arms`, `floodlight` | Heading zero, two arms, horizontal luminaires |
| `bench` | `point`, `heading_deg`, `length_m` | Length 1.8 m, seat height 0.48 m |
| `bleacher` | Two `points` along its front edge, `rows`, `step_m`, `rise_m` | Five rows, step 0.8 m, rise 0.35 m |
| `goalpost` | `point`, `heading_deg`, `height_m`, `width_m` | Height 5.6 m, width 5.64 m |
| `soccer_goal` | `point`, `heading_deg`, `width_m`, `height_m`, `depth_m` | 7.32 by 2.44 m, depth 2 m |

Bleachers rise to the left of the line from their first endpoint to their second. A goal's local width
follows east at heading zero; its depth follows north. Pole height must be supplied. A height estimated
from a shadow needs the shadow endpoints and solar elevation in its evidence, with the uncertainty stated.
Unresolved small image objects do not establish benches, parked cars or permanent equipment.

The stage writes `streetscape.json` and `streetscape_grass.png`, both hashed in `build.json`. The JSON
contains material batches, vertices, triangle indices, collision flags and optional terrain anchors.
Paving and painted ribbons follow terrain at each vertex on the Landscape grid, with triangle edges no longer than 2 m.
Props use a common terrain anchor so stands and goal frames remain rigid; their feet meet the local terrain.
The grass mask suppresses tufts on paving without changing measured Landscape heights or weights.

Paving and paint share batches within 126 m cells. Batches split at 20,000 triangles. Solid props use
Nanite, collision and shadows. Paving also uses Nanite; thin paint ribbons use ordinary opaque meshes
over the Landscape's collision. Fences use ordinary masked, two-sided chainlink panels with solid posts and rails. Daytime luminaires
do not add dynamic lights. The build receipt records feature counts, mesh counts and triangle counts;
the existing material, surface, tree and building gates still apply.

Custom depth uses the manifest's `road` class for paving and `ground` for track and infields. With a
streetscape inventory, the manifest adds `prop` ID 8 for solid props and `marking` ID 9 for paint.
Those classes do not appear when the source is absent. Fence panels block collision from both sides.

## Appearance priors

Positions, outlines and headings must come from evidence. Construction details below are appearance
priors. The manifest lists dimensions supplied by defaults and fixed prop construction choices; the
build receipt records the material priors below. The geometry artifact preserves each feature's evidence and confidence.

| Finish | Linear base colour | Roughness | Metallic |
| --- | --- | --- | --- |
| Asphalt | 0.065, 0.068, 0.072 | 0.88 | 0 |
| Concrete | 0.32, 0.31, 0.28 | 0.86 | 0 |
| Track | 0.20, 0.065, 0.055 | 0.93 | 0 |
| Gravel | 0.24, 0.22, 0.18 | 0.95 | 0 |
| Clay | 0.34, 0.23, 0.14 | 0.97 | 0 |
| White paint | 0.64, 0.63, 0.57 | 0.83 | 0 |
| Yellow paint | 0.72, 0.48, 0.045 | 0.8 | 0 |
| Steel and chainlink | 0.26, 0.28, 0.29 | 0.55 / 0.6 | 0.8 |
| Aluminum | 0.46, 0.48, 0.49 | 0.46 | 0.85 |
| Wood | 0.19, 0.115, 0.058 | 0.87 | 0 |
| Yellow goalpost | 0.72, 0.47, 0.035 | 0.65 | 0.1 |
| Luminaire | 0.025, 0.029, 0.033 | 0.4 | 0.2 |
| Goal net | 0.32, 0.34, 0.32 | 0.9 | 0 |

The material adds filtered 7 mm aggregate and broad weathering. Concrete has 3 m joints; asphalt has
sparse, warped 4 m cracks. These are generated detail, not digitized cracks. Ground offsets are 4 cm,
5 cm for track and 7 cm for paint. Concrete line ribbons sit 6 cm above terrain. The 2048-pixel grass
mask includes every touched paving cell. Paint leaves grass intact so subpixel lines do not carve wide bare strips.
Chainlink has a 10 cm pitch and 2 mm wires, filtered away below pixel resolution. Goal nets use coarse geometric wires spaced at most 30 cm.
Poles, rails and supports have six-sided cross sections. These choices can be replaced with measured
dimensions without changing the inventory's coordinate frame.

Regeneration is optional and cached by inventory hash, tile, settings and stage version. A site without the source
does not generate streetscape assets. Changes to geometry or appearance defaults require a streetscape
stage-key version update when the change is not represented in `SETTINGS`. No site-specific coordinates or imagery are included in this module.
