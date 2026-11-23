"""Cut voice notes into 2-6 s single-speaker speech segments using the word timestamps. Split by note (same split as the wake word)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # shared common.py
import json, numpy as np, soundfile as sf
from common import PRIV, load, split_of
OUT = PRIV / "sv_segments"; rows = []
for spk_dir in sorted((PRIV / "voicenotes").iterdir()):
    spk = spk_dir.name
    for f in sorted(spk_dir.glob("*.ogg")):
        t = json.loads((PRIV / "transcripts" / spk / (f.stem + ".json")).read_text()); x = load(f)
        spans, cur = [], None
        for w in t["words"]:
            if cur and w["s"] - cur[1] < 0.5: cur[1] = w["e"]
            else:
                if cur: spans.append(cur)
                cur = [w["s"], w["e"]]
        if cur: spans.append(cur)
        k = 0
        for s, e in spans:
            while e - s >= 2.0:
                seg_e = min(e, s + 6.0); y = x[int(s * 16000):int(seg_e * 16000)]
                if len(y) >= 32000:
                    d = OUT / spk; d.mkdir(parents=True, exist_ok=True); p = d / f"{f.stem}_{k:03d}.wav"; sf.write(p, y, 16000)
                    ws = [w["w"].strip().lower() for w in t["words"] if s <= w["s"] < seg_e]
                    rows.append({"spk": spk, "note": f.stem, "split": split_of(f.name), "file": str(p), "sec": len(y) / 16000, "words": ws}); k += 1
                s = seg_e
(PRIV / "sv_segments.json").write_text(json.dumps(rows))
import collections
c = collections.defaultdict(lambda: [0, 0.0])
for r in rows: c[(r["spk"], r["split"])][0] += 1; c[(r["spk"], r["split"])][1] += r["sec"]
for k, v in sorted(c.items()): print(k, v[0], "segments", round(v[1] / 60, 1), "min")
print("SEG-DONE")
