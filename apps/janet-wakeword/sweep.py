"""Diagnostic trade-off curve (never used for selection): recall and false accepts over thresholds.
Usage: sweep.py name=scores.npy ..."""
import sys, numpy as np
import metrics as M
for name, path in [a.split("=") for a in sys.argv[1:]]:
    S = np.load(path)
    for t in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
        r = M.report(S, t, ["october"])
        fa = " ".join(f"{k[12:]}={v.split(' (')[1].split()[0]}" for k, v in r.items() if k.startswith("FA_per_hour_"))
        print(name, t, "recall", r["booth_october_detect"].split()[0], "nearmiss", r["booth_october_nearmiss_false_accepts"].split()[0], "false-accept events:", fa)
