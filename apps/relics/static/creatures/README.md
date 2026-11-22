# Creature assets

Copied unchanged on 2026-11-22 from `/home/agent/work/relics-3d/`, the approved Petal Relics 3D prototype. No models or still images were regenerated. See that project's `CURRENT.md`, `SOURCE-FILES.txt`, `evidence/input-sha256.tsv` and `evidence/model-roundtrip.json` for the source inventory, geometry conversion and roundtrip checks.

| File           | Prototype source   | SHA-256                                                          |
| -------------- | ------------------ | ---------------------------------------------------------------- |
| shroomling.glb | glb/shroomling.glb | 15a5cd46ed677d6da5cd0b93147876f8b742f6e4010d9f42db5aae7464360f43 |
| snail.glb      | glb/snail.glb      | 4d7657f1b3cef3b9d5489e553e904fe6f5514bc42d1e79a8823dba7751620a1b |

Shroomling combines the original `Mushroom/Tinkercad OBJ 1/tinker.obj` cap and spots with `Tinkercad OBJ 3/tinker.obj` smile body, eyes and mouth. Snail combines the original `snail_v3_mushroom_faces/glue/` smile body, faces and upright shell with the original assembled antennae STL. These are supplied project assets; this README does not grant a new license to the source models.

The prototype converted millimetres/Z-up to metres/Y-up, aligned the assembled pieces, regenerated normals, simplified and Draco-compressed the geometry. Named PBR materials retain the untinted body, face, eyes, spots and antennae. Runtime metadata selects only `cap` or `shell` for tinting. Supplied colors are display approximations under warm lighting, not calibrated filament matches.

`creature-viewer.ts` adapts the prototype's `src/main.js` clearing, props, lighting, camera and fitting. Runtime display fitting does not change the exported physical units.

## Local decoder

The three decoder files in `draco/` are unchanged copies from the prototype's `node_modules/three/examples/jsm/libs/draco/gltf/`, three.js 0.180.0. The adjacent upstream README is copied from its parent `draco/` folder. Requests stay on the app's host; DRACOLoader creates a local blob worker. A deployment CSP must permit that worker and WebAssembly for 3D; otherwise the photo remains available.

| File                  | SHA-256                                                          |
| --------------------- | ---------------------------------------------------------------- |
| draco_decoder.js      | 8625489da79a805f4f2a7d511c3e52d8b4085608a9d2a4d5f4f9de5db0aea04f |
| draco_decoder.wasm    | a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac |
| draco_wasm_wrapper.js | 8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6 |

Draco is Apache-2.0, preserved in `draco/LICENSE` from upstream `google/draco` tag 1.5.7. Three.js's MIT license is preserved in `THREE-LICENSE.txt` from the prototype package. Preserve these notices when redistributing the decoder assets.

## Still fallback

When a model is assigned and the real photo is absent or broken, the hero reuses an approved prototype render. It is visibly labeled as a 3D still preview whose color may differ. The real-photo toggle retains the actual photo or the existing “Photo coming soon” placeholder. Arbitrary maker-selected colors apply to the interactive model, not to these fixed renders.

| File                  | Prototype source                       | Bytes | SHA-256                                                          |
| --------------------- | -------------------------------------- | ----: | ---------------------------------------------------------------- |
| shroomling-still.webp | renders/shroomling-red-fallback.webp   | 13948 | 87d5a4ccba3a5123184a5a4f88f5c3362181a75b38cecbd2185b022e9ebc88d1 |
| snail-still.webp      | renders/snail-dark-green-fallback.webp | 12150 | f0964d63b2597a76a2f7bebdaf95c26f03b949265add9b11104bfbfe2c44476d |

The adjacent `.webp.json` provenance fields come from the same prototype renders and use this repository’s formatting. No image was regenerated or recolored.
