"""Multi-speaker synthetic positives and adversarial near-misses (openWakeWord recipe), on GPU."""
import os, subprocess, sys, pathlib
from common import ROOT
OUT = ROOT / "synth_piper"
GEN = pathlib.Path(os.environ.get("PIPER_SAMPLE_GENERATOR", ROOT / "piper-sample-generator"))
POS = {"hey janet": 2000, "hey, janet": 1500, "hey janet!": 1500, "hey janet?": 1000}
NEAR = ["hey jane", "hey janice", "hey jenny", "janet", "janet hold on", "hey jacket", "hey can it", "the planet",
        "hey jeanette", "hey jenna", "hey channel", "hey jarvis", "hey dad", "hey wait", "okay and it", "hey jan",
        "say it again", "hey did you get it", "talking to janet", "hey janelle", "janitor", "hey garnet", "hey granite",
        "hey bennett", "hey kenneth", "hey get it", "hey daniel", "they ate it", "hey dinner", "ask janet",
        "thanks janet", "hey jeff", "hey chantal", "hey genet", "a jacket", "hey there", "hey siri", "hey google",
        "alexa", "hey jen it", "hey dinette", "hey cabinet", "planet", "hey jet"]
def run(text, n, d):
    d.mkdir(parents=True, exist_ok=True)
    if len(list(d.glob("*.wav"))) >= n: return
    subprocess.run([sys.executable, "-m", "piper_sample_generator", text, "--model", "models/en_US-libritts_r-medium.pt",
                    "--max-samples", str(n), "--batch-size", "64", "--length-scales", "0.75", "0.9", "1.0", "1.15", "1.3",
                    "--noise-scales", "0.667", "0.8", "1.0", "--output-dir", str(d)], cwd=GEN, check=True)
    print("done", text, n, flush=True)
for i, (t, n) in enumerate(POS.items()): run(t, n, OUT / "pos" / f"{i:02d}")
for i, t in enumerate(NEAR): run(t, 140, OUT / "neg" / f"{i:02d}")
print("PIPER-DONE")
