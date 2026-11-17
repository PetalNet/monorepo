"""Old-vs-new metrics from per-window scores. Usage: metrics.py name=scores.npy[@thr,...] ..."""
import collections, json, os, sys, numpy as np
IDX = json.load(open(os.path.join(os.environ.get("JANET_WW_ROOT", "janet-ww-data"), "test_index.json")))
def end_t(i): return (i * 8 + 76) * 0.01 + 0.015 + 15 * 0.08  # window i ends after its 16th frame
def events(s, thr):  # threshold crossings with 2 s refractory (October's definition)
    hits, cool = [], 0
    for i, v in enumerate(s):
        if cool > 0: cool -= 1; continue
        if v >= thr: hits.append(i); cool = 25
    return hits
def report(S, thr, booth_scope):
    r = {}
    for scope in booth_scope:
        sel = [e for e in IDX if e["kind"] == "booth" and (scope == "all" or e["october_test"])]
        for pos, label in ((True, "detect"), (False, "nearmiss_false_accepts")):
            b = [bool(S[e["start"]:e["start"] + e["n"]].max() >= thr) for e in sel if e["positive"] == pos]
            r[f"booth_{scope}_{label}"] = f"{sum(b)}/{len(b)} clip-phases ({len(b)//4} clips)"
    tp = fn = 0; fa = collections.Counter(); secs = collections.Counter(); bare = 0; nbare = 0
    for e in IDX:
        if e["kind"] != "note": continue
        s = S[e["start"]:e["start"] + e["n"]]; ends = np.array([end_t(i) for i in range(len(s))])
        hj = [(a, b_) for k, a, b_ in e["events"] if k == "hey_janet"]; fz = [(a, b_) for k, a, b_ in e["events"] if k == "fuzzy"]
        bj = [(a, b_) for k, a, b_ in e["events"] if k == "janet"]
        for a, b_ in hj:
            m = (ends >= b_ - 0.2) & (ends <= b_ + 1.2); hit = bool(m.any() and s[m].max() >= thr); tp += hit; fn += not hit
        secs[e["speaker"]] += e["seconds"]
        for i in events(s, thr):
            t = ends[i]
            if any(a - 0.5 <= t <= b_ + 1.5 for a, b_ in hj + fz): continue  # true detection or ambiguous name
            fa[e["speaker"]] += 1; bare += any(a - 0.5 <= t <= b_ + 1.5 for a, b_ in bj)
        nbare += len(bj)
    r["note_hey_janet_detect"] = f"{tp}/{tp + fn}"
    for k in secs:
        if secs[k]: r[f"FA_per_hour_{k}_notes"] = f"{fa[k] * 3600 / secs[k]:.2f} ({fa[k]} in {secs[k]/60:.1f} min)"
    r["bare_janet_false_wakes"] = f"{bare} (of {nbare} bare-Janet mentions x phases)"
    for e in IDX:
        if e["kind"] == "stream":
            st, n_, sec, nm = e["start"], e["n"], e["seconds"], e["name"]
            if nm == "oww_validation_set":  # first half is used for selection by train.py; report the second half only
                st, n_, sec, nm = st + n_ // 2 + 16, n_ - n_ // 2 - 16, sec / 2, nm + "_second_half"
            n = len(events(S[st:st + n_], thr)); r[f"FA_per_hour_{nm}"] = f"{n * 3600 / sec:.2f} ({n} in {sec/3600:.2f} h)"
    return r
if __name__ == "__main__":
    out = {}
    for arg in sys.argv[1:]:
        # name=main.npy[+cv:f0.npy,f1.npy,f2.npy,f3.npy]@thr,thr  (cv: booth spans of fold k come from fold-k's model)
        name, rest = arg.split("=", 1); spec, _, thrs = rest.partition("@"); main, _, cv = spec.partition("+cv:")
        S = np.load(main).copy(); scope = ["october", "all"] if not cv else ["october"]
        if cv:
            folds = [np.load(p) for p in cv.split(",")]
            for e in IDX:
                if e["kind"] == "booth": S[e["start"]:e["start"] + e["n"]] = folds[e["fold"]][e["start"]:e["start"] + e["n"]]
            scope = ["all"]
        for t in [float(x) for x in thrs.split(",")]:
            out[f"{name}@{t}"] = report(S, t, scope)
    print(json.dumps(out, indent=1))
