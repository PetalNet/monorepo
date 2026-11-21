"""Export real-file mask comparisons and a context coverage receipt. No synthetic scene data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT

from envgen import imagery, surface
from envgen.acquire import sha256_file
from envgen.site import Source, Tile, load_site
from envgen.vector_sources import load

PALETTE = np.array([[67, 134, 58], [133, 139, 149], [190, 138, 84]], dtype=np.uint8)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("site", "before", "after", "out"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    site = load_site(args.site)
    before, after = (json.loads(path.read_text()) for path in (args.before, args.after))
    baseline = Source(
        "file",
        before["sources"]["imagery"]["path"],
        "NAIP public domain",
        "2024",
        bands=(("red", 1), ("green", 2), ("blue", 3), ("nir", 4)),
    )
    cases = [("sports-path", 607140, 4200770), ("infield", 607280, 4200730), ("pavement", 606650, 4201010)]
    receipt = {
        "before_manifest_sha256": sha256_file(args.before),
        "after_manifest_sha256": sha256_file(args.after),
        "crops": [],
    }
    for name, west, south in cases:
        tile = Tile(west, south, 0.6, 100)
        old, old_valid = imagery.read(baseline, site.crs, tile)
        old_labels = surface.apply_splits(old[:3], old[3], before["surface"]["splits"])
        fine = Tile(west, south, 0.15, 400)
        new, new_valid = imagery.read(site.mask_imagery, site.crs, fine)
        native = args.after.parent / after["surface"]["mask_sources"]["native"]["file"]
        with (
            rasterio.open(native) as dataset,
            WarpedVRT(
                dataset,
                crs=site.crs,
                transform=from_origin(west - 0.075, south + 60 + 0.075, 0.15, 0.15),
                width=401,
                height=401,
                resampling=Resampling.nearest,
            ) as warped,
        ):
            native_shares = warped.read([1, 2, 3, 4])
            new_labels = np.argmax(native_shares[:3], axis=0)
            native_valid = native_shares[3] > 0
        old_mask, new_mask = PALETTE[old_labels], PALETTE[new_labels]
        old_mask[~old_valid] = 255
        new_mask[~native_valid] = 255
        panels = [old[:3].transpose(1, 2, 0), old_mask, new[:3].transpose(1, 2, 0), new_mask]
        canvas = Image.new("RGB", (1600, 470), "white")
        draw = ImageDraw.Draw(canvas)
        titles = [
            "Before: NAIP 60 cm RGB",
            "Before: NAIP fitted mask",
            "After: MSDIS 15 cm RGB (evidence only)",
            "After: MSDIS NIR fitted mask",
        ]
        for index, panel in enumerate(panels):
            pic = Image.fromarray(np.clip(np.nan_to_num(panel), 0, 255).astype(np.uint8))
            canvas.paste(pic.resize((400, 400), Image.Resampling.NEAREST), (index * 400, 30))
            draw.text((index * 400 + 6, 8), titles[index], fill="black")
        draw.text(
            (6, 438),
            f"{name}: E {west}, N {south}, 60 m square, EPSG:32615. "
            "Green=vegetation, grey=paving, tan=soil, white=invalid. Inferred classes, not surveyed materials.",
            fill="black",
        )
        draw.text(
            (6, 454),
            "MSDIS / Sanborn / Missouri 911 Service Board, CC BY 4.0 publisher grant; "
            "delivery terms conflict. Internal comparison only. Winter RGB is not seasonal colour.",
            fill="black",
        )
        canvas.save(args.out / f"imagery-mask-{name}-before-after.jpg", quality=95, subsampling=0)
        receipt["crops"].append(
            {
                "name": name,
                "bounds": list(tile.bounds()),
                "before_valid_fraction": float(old_valid.mean()),
                "after_valid_fraction": float(new_valid.mean()),
                "native_mask_valid_fraction": float(native_valid.mean()),
                "drone_overlap": False,
            }
        )
    context_path = Path(after["sources"]["context_imagery"]["path"])
    size = site.context_size_m
    east, north = site.tile.centre
    with (
        rasterio.open(context_path) as dataset,
        WarpedVRT(
            dataset,
            crs=site.crs,
            transform=from_origin(east - size / 2, north + size / 2, size / 512, size / 512),
            width=512,
            height=512,
            resampling=Resampling.average,
        ) as warped,
    ):
        data = warped.read([1, 2, 3], masked=True)
        valid = ~np.ma.getmaskarray(data).any(axis=0) & np.isfinite(data.data).all(axis=0)
        # ImageServer black no-data can be returned without a GDAL mask.
        valid &= np.any(data.data != 0, axis=0)
        border = np.concatenate([valid[0], valid[-1], valid[:, 0], valid[:, -1]])
        receipt["context"] = {
            "size_m": size,
            "valid_fraction": float(valid.mean()),
            "outer_border_valid_fraction": float(border.mean()),
            "raster_bounds": list(dataset.bounds),
            "source": str(context_path),
        }
        assert valid.all(), "Context coverage has missing pixels"
        Image.fromarray(data.filled(0).transpose(1, 2, 0).astype(np.uint8)).save(
            args.out / "imagery-context-coverage.jpg", quality=95
        )
    ms = load(site.microsoft_buildings, "microsoft")
    osm = load(site.osm_features, "osm")
    receipt["vectors"] = {
        "microsoft_features": len(ms),
        "positive_estimated_heights": sum(f["properties"]["height_m"] is not None for f in ms),
        "osm_features": len(osm),
    }
    receipt["priority"] = after["surface"]["mask_sources"]["priority"]
    for name in ("mask_imagery", "microsoft_buildings", "osm_features"):
        assert after["sources"][name]["sha256"] == sha256_file(Path(after["sources"][name]["path"]))
    assert after["sources"]["mask_imagery"]["internal_only"]
    assert after["sources"]["mask_imagery"]["license_conflict"]
    (args.out / "imagery-verification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
