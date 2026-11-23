"""Build the TEST feature windows once (never seen in training or selection) plus an index of what each span is."""
import json, numpy as np
from common import ROOT, PRIV, DATA, SR, load, split_of, booth_split, booth_folds, janet_events, Featurizer, windows, frame_end_time, speakers
F = Featurizer(); W, IDX = [], []; n0 = 0
def put(kind, name, w, **meta):
    global n0
    W.append(w.astype(np.float16)); IDX.append({"kind": kind, "name": name, "start": n0, "n": len(w), **meta}); n0 += len(w)
# A. Every usable booth clip, 4 frame phases each, tagged with October-holdout membership and CV fold
octo = booth_split()
for name, fold in booth_folds().items():
    for ph in range(4):
        x = np.pad(load(PRIV / "booth" / name), (16000 + ph * 320, 16000))
        put("booth", name, windows(F.frames(x)), positive=name.startswith("pos"), phase=ph, fold=fold, october_test=octo.get(name) == "test")
# B. Test-split voice notes as continuous streams (2 phases)
for spk in speakers():
    for f in sorted((PRIV / "voicenotes" / spk).glob("*.ogg")):
        if split_of(f.name) != "test": continue
        t = json.loads((PRIV / "transcripts" / spk / (f.stem + ".json")).read_text()); ev = janet_events(t["words"])
        for ph in range(2):
            x = np.pad(load(f), (ph * 640, 0)); off = ph * 640 / SR
            put("note", f.stem, windows(F.frames(x)), speaker=spk, phase=ph, seconds=len(x) / SR,
                events=[[k, s + off, e + off] for k, s, e in ev])
# C. Janet's own voice, held-out sentences, one continuous stream
man = json.loads((PRIV / "synth" / "manifest.json").read_text())
js = [load(m["file"]) for m in man if m["kind"] == "janet_neg" and int(m["file"][-9:-4]) % 1000 >= 24]
gap = np.zeros(int(0.4 * SR), np.float32); x = np.concatenate([np.concatenate([a, gap]) for a in js])
put("stream", "janet_tts_heldout", windows(F.frames(x)), seconds=len(x) / SR)
js = [load(p) for p in sorted((PRIV / "synth_test" / "janet").glob("*.wav"))]  # gen_janet_test.py: unseen sentences
if js:
    x = np.concatenate([np.concatenate([a, gap]) for a in js])
    put("stream", "janet_tts_unseen_sentences", windows(F.frames(x)), seconds=len(x) / SR)
# D. openWakeWord's standard ~11 h validation stream (precomputed frames)
v = np.load(DATA / "validation_set_features.npy", mmap_mode="r")
put("stream", "oww_validation_set", windows(np.asarray(v, np.float32)), seconds=len(v) * 0.08)
np.save(ROOT / "test_windows.npy", np.concatenate(W)); (ROOT / "test_index.json").write_text(json.dumps(IDX))
print("EVAL-DUMP-DONE", n0, [(i["name"], round(i.get("seconds", 0) / 3600, 2)) for i in IDX if i["kind"] == "stream"])
