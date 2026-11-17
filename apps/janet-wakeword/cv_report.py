"""Cross-validated booth recall where each fold is scored at the threshold its own training run chose on val.
Usage: cv_report.py <run>   (expects runs/<run>_cv0..3 and scores_<run>_cv0..3.npy)"""
import json, os, sys, numpy as np
R = os.environ.get("JANET_WW_ROOT", "janet-ww-data"); run = sys.argv[1]; IDX = json.load(open(f"{R}/test_index.json"))
thr = {}
for f in range(4):
    d = json.load(open(f"{R}/runs/{run}_cv{f}/train.json")); thr[f] = [l for l in d["log"] if l["step"] == d["best_step"]][0]["thr"]
S = {f: np.load(f"{R}/scores_{run}_cv{f}.npy") for f in range(4)}; B = np.load(f"{R}/scores_baseline.npy")
for pos in (True, False):
    sel = [e for e in IDX if e["kind"] == "booth" and e["positive"] == pos]
    own = sum(S[e["fold"]][e["start"]:e["start"] + e["n"]].max() >= thr[e["fold"]] for e in sel)
    base = sum(B[e["start"]:e["start"] + e["n"]].max() >= 0.5 for e in sel)
    clips_own = len({e["name"] for e in sel if S[e["fold"]][e["start"]:e["start"] + e["n"]].max() >= thr[e["fold"]]})
    print("positives" if pos else "near-misses", f"{run} CV at each fold's own val threshold {thr}: {own}/{len(sel)} clip-phases ({clips_own} clips hit at least once); baseline@0.5: {base}/{len(sel)}")
