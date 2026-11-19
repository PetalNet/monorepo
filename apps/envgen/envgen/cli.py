"""Command line: envgen build site.json --out DIR."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .build import build
from .site import SiteError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="envgen", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="run every stage for a site and write build.json")
    build_parser.add_argument("site", type=Path, help="path to site.json")
    build_parser.add_argument("--out", type=Path, required=True, help="directory for build artifacts")
    build_parser.add_argument("--cache", type=Path, help="directory for fetched sources (default: OUT/cache)")
    args = parser.parse_args(argv)

    try:
        manifest = build(args.site, args.out, args.cache)
    except (SiteError, FileNotFoundError, RuntimeError) as error:
        print(f"envgen: {error}", file=sys.stderr)
        return 1
    landscape = manifest["landscape"]
    fetched = sum(source["bytes_fetched"] for source in manifest["sources"].values())
    print(f"wrote {args.out / 'build.json'}")
    print(
        f"landscape {landscape['vertices']}x{landscape['vertices']} vertices, relief {landscape['max_m'] - landscape['min_m']:.1f} m"
    )
    print(f"fetched {fetched / 1e6:.1f} MB; stages reused: {', '.join(manifest['stages_reused']) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
