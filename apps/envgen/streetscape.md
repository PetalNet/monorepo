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
			"ring": [
				[10, 10],
				[25, 10],
				[25, 30],
				[10, 30]
			]
		},
		{
			"id": "parking-stripe",
			"type": "line",
			"evidence": "image.tif, visible bay line B",
			"confidence": 0.9,
			"material": "paint_white",
			"width_m": 0.1,
			"points": [
				[12, 12],
				[17, 12]
			]
		}
	]
}
```

Every feature requires a unique `id`, specific `evidence`, and `confidence` from zero to one. Coordinates
are east and north metres relative to the tile centre. They do not include the projected CRS origin.
Headings rotate counterclockwise from east. Unreal swaps east/north and multiplies metres by 100.
Unknown types, misspelled fields, nonfinite numbers, nonpositive dimensions, invalid polygons and
props extending beyond the tile fail the build with the feature ID. Surface and line polygons clip at the tile edge.

| Type          | Geometry and measurements                                                           | Defaults where no measurement exists          |
| ------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `surface`     | `ring`, `material`: asphalt, concrete, track, gravel, clay or turf                  | No inferred boundary                          |
| `line`        | `points`, `material`: paint_white, paint_yellow, paint_black or concrete; `width_m` | Paint width 0.1 m; concrete requires width    |
| `decal`       | `image`, `bounds_m`: registered north-up RGBA paint                                 | No inferred dimensions or artwork             |
| `curb`        | `points`, `width_m`, `height_m`                                                     | Width/height 0.15 m, buried 0.05 m            |
| `fence`       | `points`, `height_m`; optional `ground_anchor` per segment                          | Height 2.4 m, posts at most 3 m apart         |
| `light_pole`  | `point`, `height_m`; `heading_deg`, `arms`, `floodlight`                            | Heading zero, two arms, horizontal luminaires |
| `bench`       | `point`, `heading_deg`, `length_m`                                                  | Length 1.8 m, seat height 0.48 m              |
| `bleacher`    | Two `points` along its front edge, `rows`, `step_m`, `rise_m`                       | Five rows, step 0.8 m, rise 0.35 m            |
| `goalpost`    | `point`, `heading_deg`, `height_m`, `width_m`                                       | Height 5.6 m, width 5.64 m                    |
| `soccer_goal` | `point`, `heading_deg`, `width_m`, `height_m`, `depth_m`                            | 7.32 by 2.44 m, depth 2 m                     |

Bleachers rise to the left of the line from their first endpoint to their second. A goal's local width
follows east at heading zero; its depth follows north. Pole height must be supplied. A height estimated
from a shadow needs the shadow endpoints and solar elevation in its evidence, with the uncertainty stated.
Unresolved small image objects do not establish benches, parked cars or permanent equipment.

## Registered paint imagery

Schema 1 also accepts extracted paint as a `decal` feature. The example names below are synthetic.
Real imagery and extracted logo, number and letter pixels remain in private input and build directories.

```json
{
	"id": "survey-mark",
	"type": "decal",
	"evidence": "survey crop and measured registration",
	"confidence": 0.9,
	"image": "paint/mark.png",
	"bounds_m": [10, 20, 14, 26]
}
```

`image` is a path relative to the inventory JSON directory. It uses forward slashes, stays within that
directory after symlink resolution, and names an 8-bit RGBA PNG with at least one alpha pixel of 85 or above,
which reaches the material's 0.333 cutoff.
Absolute paths, parent traversal, RGB or palette images, empty alpha and undecodable files fail with the feature ID.
RGB is the mark's sRGB colour. Alpha is its coverage. Extraction and image orientation happen before this stage.
The pipeline does not generate fonts, glyphs or artwork.

`bounds_m` is `[west, south, east, north]` in tile-centred east/north metres. All four edges must be inside
the tile, with west less than east and south less than north. Bounds register the image's outer edges.
The PNG is north-up: its top-left corner is northwest, with columns increasing east and rows increasing south.
For any mesh vertex, `u = (east - west) / (east_bound - west)` and
`v = (north_bound - north) / (north_bound - south)`. Northwest is `(0,0)` and southeast is `(1,1)`.
Unreal swaps EN to world NE centimetres for geometry, while retaining this image registration.

Decals use the same Landscape triangle clipping as paving and sit 8 cm above terrain, 1 cm above vector paint
so extracted artwork covers intersecting yard lines without coplanar flicker.
They have no terrain anchor, collision or shadow, use the `marking` stencil class, and retain ordinary static
meshes with Nanite disabled. Their materials use texture RGB for base colour, alpha for a masked opacity
with a 0.333 cutoff, roughness 0.83 and clamped UV addressing. Texture mips preserve alpha coverage at that
cutoff to retain thin source strokes at distance. They leave the grass mask unchanged.
Spatial and triangle-count splits preserve the full registration bounds. Repeated uses of the same image
share its texture and material, including placements with different bounds.

The stage copies the original PNG bytes to `streetscape_decal_<sha256>.png` beside `streetscape.json`.
Each decal mesh has `material: "paint_decal"`, `image` naming that copy, and the original `bounds_m`.
Copied PNG files join the stage's `files` and the manifest's hashed `artifacts`. The `streetscape-4` cache key
includes every image's content hash. Changing PNG bytes at the same input path rebuilds the stage.
All inputs are validated before cache reuse, and a missing or modified staged PNG triggers a rebuild.
Unreal preflight decodes every referenced image and checks registration before replacing the saved level.

## Terrain geometry and artifacts

Paving and paint are clipped to the Landscape grid and its 00–11 triangle diagonal, including integer subdivisions of larger quads. The importer samples those same triangle planes. Landscape components beneath these surfaces retain LOD0, with a two-quad border, so terrain distance morphing cannot push through paving. Terrain-contact surfaces use ordinary static meshes to avoid independent Nanite simplification moving paving through the terrain or obscuring paint. Solid props use Nanite. Geometry and the grass mask are checked before replacing the previous saved level.

The stage writes `streetscape.json` and `streetscape_grass.png`, both hashed in `build.json`. The JSON
contains material batches, vertices, triangle indices, collision flags and optional terrain anchors.
Paving and painted ribbons follow terrain at each vertex on the Landscape grid, with triangle edges no longer than 2 m.
Props use a common terrain anchor so stands and goal frames remain rigid. Footings extend 0.3 m below
that anchor, or 0.6 m for bleachers, to cover small ground variations without distorting their frames.
The grass mask suppresses tufts on paving and clay without changing measured Landscape heights or weights. Legacy `turf` surfaces without field records keep the measured grass population and cover blurred photographic field markings beneath the vector inventory.

Paving and paint share batches within 126 m cells. Batches split at 20,000 triangles. Solid props use
Nanite, collision and shadows. Paving and vector paint use ordinary opaque meshes over the Landscape's collision. Registered paint uses masked meshes. Fences use ordinary masked, two-sided chainlink panels with solid posts and rails. Daytime luminaires
do not add dynamic lights. The build receipt records feature counts, mesh counts and triangle counts;
the existing material, surface, tree and building gates still apply.

Custom depth uses the manifest's `road` class for paving and `ground` for track and infields. With a
streetscape inventory, the manifest adds `prop` ID 8 for solid props and `marking` ID 9 for paint.
Those classes do not appear when the source is absent. Fence panels block collision from both sides.

## Appearance priors

Positions, outlines and headings must come from evidence. Construction details below are appearance
priors. The manifest lists dimensions supplied by defaults and fixed prop construction choices; the
build receipt records the material priors below. The geometry artifact preserves each feature's evidence and confidence.

| Finish              | Linear base colour  | Roughness  | Metallic |
| ------------------- | ------------------- | ---------- | -------- |
| Asphalt             | 0.065, 0.068, 0.072 | 0.88       | 0        |
| Concrete            | 0.32, 0.31, 0.28    | 0.86       | 0        |
| Track               | 0.20, 0.065, 0.055  | 0.93       | 0        |
| Gravel              | 0.24, 0.22, 0.18    | 0.95       | 0        |
| Clay                | 0.34, 0.23, 0.14    | 0.97       | 0        |
| Turf                | 0.065, 0.08, 0.0375 | 0.96       | 0        |
| White paint         | 0.723, 0.716, 0.791 | 0.83       | 0        |
| Yellow paint        | 0.72, 0.48, 0.045   | 0.8        | 0        |
| Steel and chainlink | 0.26, 0.28, 0.29    | 0.55 / 0.6 | 0.8      |
| Aluminum            | 0.46, 0.48, 0.49    | 0.46       | 0.85     |
| Wood                | 0.19, 0.115, 0.058  | 0.87       | 0        |
| Yellow goalpost     | 0.72, 0.47, 0.035   | 0.65       | 0.1      |
| Luminaire           | 0.025, 0.029, 0.033 | 0.4        | 0.2      |
| Goal net            | 0.32, 0.34, 0.32    | 0.9        | 0        |

White paint uses a bright-pixel sRGB reference of 221, 220, 230 converted to linear light. This is an
image-based appearance calibration, not a measured intrinsic reflectance. Paint has no procedural dark
wear modulation; extracted image marks retain their source colour. The material adds filtered 7 mm aggregate
and broad weathering to other finishes. Concrete has 3 m joints; asphalt has
sparse, warped 4 m cracks. These are generated detail, not digitized cracks. Ground offsets are 4 cm,
5 cm for track, 2.5 cm for turf and 7 cm for paint. Concrete line ribbons sit 6 cm above terrain. The 2048-pixel grass
mask includes every touched paving or clay cell; turf leaves grass enabled. Paint leaves grass intact so subpixel lines do not carve wide bare strips.
Chainlink has a 10 cm pitch and 2 mm wires. The engine's `DitherTemporalAA` function preserves subpixel
coverage instead of cutting the entire fence away. Goal nets use coarse geometric wires spaced at most 30 cm.
Tubes with a radius of at least 4 cm have 24 sides; smaller rods have eight sides. These choices can be replaced with measured
dimensions without changing the inventory's coordinate frame.

Regeneration is optional and cached by inventory hash, decal image content hashes, tile, settings and stage version. A site without the source
does not generate streetscape assets. Changes to geometry or appearance defaults require a streetscape
stage-key version update when the change is not represented in `SETTINGS`. No site-specific coordinates or imagery are included in this module.

## Appearance checks

Capture paint and fence details in game mode with the tour's `FScreenshotRequest` path. In this slice's
UE 5.8.4 comparison, editor `HighResScreenshot` captures fragmented continuous markings at 1920×1080.
Game captures at the same pose and output resolution restored continuous strokes. Extra editor warm-up frames
did not remove the artifact. Keep the camera pose, field of view, render fractions and output resolution
fixed when comparing captures.

## Athletic turf and natural fields

`athletic_turf` is a synthetic surface class. It excludes natural grass blades within its polygon.
Markings intersecting that field become color regions in one opaque registered atlas on the field mesh,
including local RGBA artwork. All colors share streamed 0.6–1.6 cm cut ribbons near the camera,
filtered tuft rows, irregular black infill, fiber normals, roughness
and grazing reflection. Alternating pile direction and narrow roll seams follow the configured heading.
The pile uses the existing Landscape grass streaming system. It uses discrete LOD transitions to avoid a missing-fiber band observed with UE 5.8 HISM dithering. Each root retains eight strands at both geometry levels. Nearby ribbons have five curve segments and thin cut-end caps; distant ribbons use two segments and omit the unresolved caps. Their height fades from 3 to 10 m before culling at 11 m. A separate grass variety adds 10,000 irregular charcoal grains per 20 cm patch, with notched tops and beveled sides between the fibers. Both geometry levels retain every grain and its color seed. The near level retains all top and side triangles, and the far level retains the same rectangular footprint with two top triangles per grain. Both levels omit the lower closure faces but preserve their contribution to the retained vertex normals. Shared grain vertices use area-weighted normals, with a face-normal fallback at sharp corners. A world-space pixel normal blends the visible facet with the vertex normal. Both meshes use two UV channels; infill keeps full precision. Original mesh positions supply collapse displacement and infill contact height. Lower ribbon segments and the nearby backing darken at their contact with the bed. The particles shrink into their roots from 2 to 4 m and cull at 4.5 m. A seamless packed grain texture supplies the underlying bed's normal relief, reflectance and intergranular occlusion. Per-blade variation breaks up
repeated patches while retaining manufactured rows.
Its conservative footprint mask clips fibers at field boundaries to within a mask texel.
Each strand samples its atlas color at its placed root, keeping dyed and inlaid colors fixed along the bent ribbon and its cut end. The field mask still clips the displaced geometry at the field boundary. Athletic mesh vertices must use the exporter’s 0.025 m terrain offset so pile roots meet
the surface. Natural grass inputs remain connected to their original varieties.
The authored density and streaming ranges are the same in per-platform and per-quality modes.
These are appearance priors. There are no raised marking ribbons, dry patches, soil or grass clumps.
Rows are 10 mm apart, with strand positions spread within and along each row. Sub-row scraps can show infill without a fiber root; markings use atlas colors
inside a full field, rather than separate narrow field polygons.
Registered surface meshes keep full-precision UVs so wide atlases do not quantize marking positions
at mesh boundaries.

Add `fields` beside `features` in the inventory to record and override classifications:

```json
{
	"fields": [
		{
			"surface_id": "playing-field",
			"classification": "athletic_turf",
			"evidence": "Survey crop A: uniform engineered rows and inlaid logo; OSM surface=artificial_turf",
			"confidence": 0.95,
			"heading_deg": 90,
			"stripe_width_m": 4.572
		}
	]
}
```

Each record names one existing `turf`, `athletic_turf` or `natural_grass` surface. Classification is
`athletic_turf` or `natural_grass`; optional `override` selects either while retaining the original decision
and evidence. Non-overlapping field polygons, finite headings, positive stripe widths up to 100 m and
confidence from zero to one are validated before generation. Heading is counterclockwise from east; bands repeat
along that direction. Defaults are heading zero and 4.572 m stripes. Explicit `athletic_turf` and `natural_grass` surfaces
also work without a record, using their feature evidence and those defaults. A track is supporting context,
not proof of synthetic turf. Record imagery cues, available OSM surface tags and facility-owner evidence;
record absent tags honestly. Both the original and effective decisions appear in the stage and output JSON.

Natural fields retain the Landscape's grass material and blade population, without a flat field overlay.
Lines split at field boundaries. Grass paint projects a faded color onto grass-like receivers while
excluding horizontal ground. Sparse areas retain gaps between existing blades. Its footprint follows
the marking triangles, preserving registered image alpha and color.
Generated trees, buildings, goalposts and fences reject projected decals in scenes with grass paint.
Paving and props added outside EnvGen keep their decal reception.
The original mesh remains in the semantic depth pass only. Portions on clay or paving retain the
existing paint finish. Natural-field image marks use the same projected paint. `turf` without a field record retains its legacy behavior.

Synthetic color atlases target 2 cm texels, bounded by 8192 pixels per side and 32 million pixels total.
They are opaque color textures with content-addressed filenames, included in the manifest artifact hashes.
Input images are validated and hashed before cache lookup; atlases bake from those immutable bytes.
Registration remains independent of mesh batching. Keep restricted artwork in local assets. Look for the
official mark before segmenting an aerial. An older official vector mark was available in the university's
visitor guide; its current identity uses a different design.

Material references: [FieldTurf systems](https://fieldturf.com/en/products/detail/turf-systems/) and
[FieldTurf infill](https://fieldturf.com/en/products/detail/infill-systems-2/).
Artwork reference: [official athletics logos](https://brand.mst.edu/logos/miner-athletics-logos/).
