"""Writes the planet's frames for the call screen: src/main/res/raw/planet_lit.bin.

The source is the orb engine's `orb.bin`: 48 frames of a 96 x 96 grid, one byte per cell
(0 empty, 1 the body's dark side, 2 lit). The call screen draws only lit cells, so the output
is one bit per cell, least significant bit first, 55296 bytes. It is the same data the design
reference's planet engine carries as its LIT string.

    python3 tools/export_planet.py path/to/orb.bin
"""

import pathlib
import sys

FRAMES, SIDE = 48, 96

cells = pathlib.Path(sys.argv[1]).read_bytes()
if len(cells) != FRAMES * SIDE * SIDE:
    sys.exit(f"expected {FRAMES * SIDE * SIDE} bytes, got {len(cells)}")
lit = bytearray(len(cells) // 8)
for i, cell in enumerate(cells):
    if cell == 2:
        lit[i >> 3] |= 1 << (i & 7)
out = pathlib.Path(__file__).resolve().parent.parent / "src/main/res/raw/planet_lit.bin"
out.write_bytes(lit)
print(f"wrote {out} ({len(lit)} bytes, {sum(bin(b).count('1') for b in lit)} lit cells)")
