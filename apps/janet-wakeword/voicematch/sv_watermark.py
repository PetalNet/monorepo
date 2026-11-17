"""Does Chatterbox's built-in Perth watermark flag the clones, and does it survive an Opus voice-note re-encode?
Real owner speech is the false-positive check."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # shared common.py
import json, subprocess, tempfile, os, sys, glob
RT = os.environ["CHATTERBOX_RUNTIME"]
sys.path.insert(0, os.path.join(RT, "work", "runtime-source"))
import numpy as np, perth
from common import PRIV, load
wm = perth.PerthImplicitWatermarker()
def score(x, sr=16000): return float(wm.get_watermark(x, sample_rate=sr))
def opus(x):
    with tempfile.TemporaryDirectory() as d:
        import soundfile as sf; a, b, c = os.path.join(d, "a.wav"), os.path.join(d, "b.ogg"), os.path.join(d, "c.wav")
        sf.write(a, x, 16000); subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", a, "-c:a", "libopus", "-b:a", "24k", b], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", b, "-ar", "16000", c], check=True); return load(c)
rows = json.loads((PRIV / "sv_rows.json").read_text())
clones = [r["file"] for r in rows if r["spk"] == "clone_owner"][:60]
real = [r["file"] for r in rows if r["spk"] == os.environ["JANET_WW_OWNER"] and r["split"] == "test"][:60]
res = {}
for name, files, tx in (("clone_raw", clones, None), ("clone_opus24k", clones, opus), ("owner_real", real, None)):
    s = np.array([score(tx(load(f)) if tx else load(f)) for f in files]); res[name] = {"n": len(s), "mean": round(float(s.mean()), 3), "flagged_>0.5_%": round(float((s > 0.5).mean() * 100), 1)}
    print(name, res[name], flush=True)
(PRIV / "sv_watermark.json").write_text(json.dumps(res, indent=1)); print("WM-DONE")
