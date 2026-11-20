"""Configure the verified 2024 imagery bundle while retaining service coverage of the surround."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def configure(raw: dict, data: Path) -> dict:
    """Return a site with leaf-on colour, leaf-off mask evidence and separate vector inputs."""
    raw = json.loads(json.dumps(raw))
    sources = raw["sources"]
    sources["imagery"] = {
        "kind": "arcgis_imageserver",
        "endpoint": "https://imagery.msdis.missouri.edu/arcgis/rest/services/NAIP/NAIP2024/ImageServer",
        "request_spacing_m": 0.3,
        "bands": {"red": 1, "green": 2, "blue": 3, "nir": 4},
        "date": sources["imagery"]["date"],
        "license": "USDA NAIP, public domain",
        "attribution": "USDA Farm Production and Conservation Business Center, Geospatial Enterprise Operations",
        "license_url": "https://catalog.data.gov/dataset/national-agriculture-imagery-program-naip-imagery",
    }
    manifest = json.loads((data / "manifest.json").read_text())
    wanted = {
        "msdis-2024-015m-leafoff-rgbnir.tif": "mask_imagery",
        "microsoft-buildings.geojson": "microsoft_buildings",
        "osm-buildings-sports.geojson": "osm_features",
    }
    for dataset in manifest["datasets"]:
        if name := wanted.get(dataset["path"]):
            sources[name] = {
                "kind": "file",
                "path": str(data / dataset["path"]),
                "license": dataset["license"],
                "date": dataset["capture_date"],
                "license_url": dataset["license_url"],
                "attribution": dataset["source"],
            }
    sources["mask_imagery"].update(
        {
            "bands": {"red": 1, "green": 2, "blue": 3, "nir": 4},
            "leaf_off": True,
            "internal_only": True,
            "attribution": "Missouri Statewide Aerial Imagery Collection, 2024, distributed by MSDIS; collected by "
            "The Sanborn Map Company for the Missouri 911 Service Board. CC BY 4.0. Cropped, "
            "mosaicked and classified for envgen.",
            "license_conflict": "Publisher CC BY 4.0 conflicts with delivery XML requiring Missouri 911 Service "
            "Board written consent and restricting redistribution. Keep data and derivatives internal.",
        }
    )
    return raw


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    parser.add_argument("data", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    configured = configure(json.loads(args.site.read_text()), args.data.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(configured, indent=1) + "\n")


if __name__ == "__main__":
    main()
