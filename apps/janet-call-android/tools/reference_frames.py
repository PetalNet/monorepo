"""Writes src/test/resources/planet-reference-frames.txt from the design reference's planet engine.

Runs the reference engine (the built `engine2.js`, which carries the frame data) under node with
a stub canvas, and records for each sampled moment of its scripted demo, in each mode: the frame
it chose, its scale, its opacity, and a hash of the alpha of every pixel it drew. PlanetEngineTest
holds the Kotlin port to these lines. The reference engine is not in this repository.

    python3 tools/reference_frames.py path/to/ref/engine2.js

The harness is kept here as text because JavaScript under apps/ is swept by the root linters.
"""

import pathlib
import subprocess
import sys

HARNESS = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const modes = ['live', 'speak', 'listen', 'think', 'idle'];
const canvas = (state) => ({ dataset: { planet: 'meter', state }, style: {}, getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }; } });
global.window = { matchMedia: () => ({ matches: false }) };
global.document = { readyState: 'complete', querySelectorAll: () => modes.map(canvas) };
global.location = { hash: '' };
global.getComputedStyle = () => ({ color: 'rgb(243, 243, 239)' });
global.requestAnimationFrame = () => {};
eval(src);
const planet = window.JanetPlanet;
const hash = (d) => { let h = 0x811c9dc5; for (let i = 3; i < d.length; i += 4) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
for (const t of [0.5, 2.0, 4.1, 6.2, 7.4, 9.45, 9.6, 11.0, 12.5, 14.0, 15.8, 23.3]) {
  planet.renderAt(t);
  planet.all.forEach((st) => console.log([st.mode, t, st.frame, st.scaleCss.toFixed(4), st.alpha.toFixed(3), hash(st.img.data)].join(' ')));
}
"""

lines = subprocess.run(["node", "-e", HARNESS, sys.argv[1]], check=True, capture_output=True, text=True).stdout
out = pathlib.Path(__file__).resolve().parent.parent / "src/test/resources/planet-reference-frames.txt"
out.write_text(lines)
print(f"wrote {out} ({len(lines.splitlines())} lines)")
